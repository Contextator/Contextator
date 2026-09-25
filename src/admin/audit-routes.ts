import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { type AuditActorKind, auditEvents, projects } from '../db/schema.js';
import { ValidationError } from '../services/projects.js';

/**
 * `GET /api/audit` — the read side of the audit log ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
 *
 * **Read-only, and the only route in this file.** `src/services/audit.ts` writes; nothing here does.
 * There is no endpoint that edits or deletes a row, because a record an operator can edit is not one:
 * the single thing that removes an event is the retention sweep, on `AUDIT_LOG_RETENTION_DAYS`.
 *
 * **Instance-wide, so `root`/`admin` only**, stated where every other rule of this API is — one line
 * in `requiredRole()`, exercised by `test/permissions.test.ts`. It is deliberately not a project route:
 * a row may name a project that has since been deleted, and a panel whose rows are filtered by a
 * membership could not show those at all.
 *
 * **Every filter and the paging are SQL.** Nothing is narrowed in the browser: a table that keeps a
 * year of every state-changing request is not something to ship to a dashboard and filter there, and
 * an operator looking for one action would be paging through the whole of it. The ordering and the
 * cursor are `(created_at DESC, id DESC)`, which is what `audit_events_created_idx` is for.
 *
 * **What each access uses, and the one thing no index can help.** Five of the six land on an index: the
 * unfiltered page and the day range on `audit_events_created_idx`, the project filter on
 * `audit_events_project_created_idx`, and the actor and action filters on the two `0011` added —
 * `(actor_label, created_at desc)` and `(action, created_at desc)`. The actor one is keyed on the
 * *label* rather than on `actor_user_id`, because the label is the column that survives the account
 * being deleted, which is half of what this panel is for. Measured at 200,004 rows, a selective actor
 * filter is 0.07 ms against 9.70 ms of sequential scan without it.
 *
 * The sixth is `facets()`. `SELECT DISTINCT` over a whole column is a full read whatever btree sits
 * beside it — PostgreSQL has no loose index scan — so the three cost about 24 ms of wall time at that
 * size, run concurrently. They are paid **once per filter run and never per page turn**, which is what
 * keeps them off the path somebody is using: a first page is 19–52 ms and a page turn 3 ms. The answer
 * if that is ever felt is a cache with a stated staleness, not an index that cannot help.
 */

/** One screenful. Large enough that scrolling is the normal way to read, small enough to be one page. */
export const DEFAULT_PAGE_ROWS = 50;
export const MAX_PAGE_ROWS = 200;
/**
 * How many distinct values the filter pickers may carry. A cap and not a page: the pickers are for
 * choosing, and an instance with more than this many distinct actors has outgrown a dropdown — the
 * response says so rather than silently offering a prefix.
 */
export const MAX_FACET_ROWS = 200;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined));

/**
 * A day, not an instant, because that is the grain an operator asks in — and **UTC**, because
 * `created_at` is `timestamptz` and the browser's zone is not the server's. The panel says so beside
 * the two inputs rather than leaving the reader to discover it from a row that fell off the edge.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const AuditQuery = z.object({
  /** `actor_label` exactly — the name as it was at the time, which outlives the account. */
  actor: optionalText(200),
  /** A project id, or `none` for the events that belong to no project (accounts, sessions, imports). */
  project: optionalText(64),
  /** `<METHOD> <route template>` exactly, as `audit_events.action` stores it. */
  action: optionalText(200),
  from: optionalText(10),
  to: optionalText(10),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_ROWS).default(DEFAULT_PAGE_ROWS),
  cursor: optionalText(120),
});

/**
 * The half-open instant range a pair of UTC days means.
 *
 * `to` is **inclusive of the day named**: an operator who types the same day in both boxes means that
 * day, and a range that ended at its first instant would answer with nothing — the classic way a date
 * filter lies. So the upper bound is the first instant of the following day, and the comparison is `<`.
 */
export function dayBounds(from: string | undefined, to: string | undefined): { from: Date | null; to: Date | null } {
  return { from: from === undefined ? null : startOfDay(from, 0), to: to === undefined ? null : startOfDay(to, 1) };
}

function startOfDay(day: string, plusDays: number): Date {
  if (!DAY.test(day)) throw new ValidationError(`"${day}" is not a date; use YYYY-MM-DD.`);
  const at = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new ValidationError(`"${day}" is not a date that exists.`);
  return new Date(at.getTime() + plusDays * 86_400_000);
}

/** Version 4 UUID, which is the only shape a row id or a project id can have. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The position of the last row handed out — **its id, and nothing else.**
 *
 * The obvious cursor carries the instant as well, and it is wrong here. `audit_events.created_at` is
 * `timestamptz`, which PostgreSQL keeps to the **microsecond**; node-postgres truncates that to the
 * millisecond on the way into a JavaScript `Date`. A cursor built from the truncated value therefore
 * names an instant *earlier* than the row it was taken from, and a `<` comparison against it skips
 * every row in the same millisecond — including rows it has not shown yet. Two events at `.123456`
 * and `.123100` with the page boundary between them: the cursor says `.123000`, the next page asks
 * for rows before `.123000`, and `.123100` appears on no page at all. **A row that silently vanishes
 * is worse than the record not existing**, which is the one thing an audit log may not do.
 *
 * So the instant never leaves the database. The id is opaque, cannot be truncated, and — unlike an
 * encoded timestamp — is something the endpoint can actually verify it produced, which is what makes
 * the `400` below an honest answer rather than a shape check.
 */
export const encodeCursor = (row: { id: string }): string => row.id;

/** A cursor is a row id. Anything else is refused here rather than reaching a `uuid` column. */
export function decodeCursor(raw: string): string {
  if (!UUID.test(raw)) throw new ValidationError('That page cursor is not one this endpoint produced.');
  return raw;
}

// ---------------------------------------------------------------------------------------------
// What a row says, in words
// ---------------------------------------------------------------------------------------------

/**
 * A phrase per action, in `audit_events.action`'s own key space — `<METHOD> <route template>`.
 *
 * `src/auth/policy.ts` argues, correctly, that the *stored* identity of an action must not be a name
 * somebody has to assign, because the next route would not have one. That argument is about the
 * column. This table is the other end: **it is presentation, and it fails soft.** An action with no
 * phrase is rendered as `ran DELETE /api/projects/:id/whatever`, which still names the actor, the
 * project and the target — so a route added tomorrow shows up in this panel tomorrow, worded plainly
 * instead of not at all. `test/audit-view.test.ts` asserts that fallback, and asserts that every key
 * below is an action `auditSubject()` actually produces, so a typo or a phrase written for an exempt
 * route is a failing test rather than a line nobody ever sees.
 *
 * `prep` is the word that joins the phrase to the project name; `''` when the phrase already ends in
 * the place the name goes. `target` renames the route template's own parameter for the reader — the
 * column keeps `userId`, the sentence says `account`.
 *
 * **`verb` may be a function of `detail`, and for two routes it has to be.** `PATCH .../query-log`
 * with `{"enabled":false}` is somebody turning recording *off*; a fixed phrase and a trailing
 * `(enabled: false)` renders that as "switched query logging on handbook (enabled: false)", which an
 * operator scanning a page reads as the opposite of what happened. The same is true of
 * `/oauth/authorize`, where `deny` is the substance of the event. `consumes` then names the detail
 * keys the verb has already said, so the sentence does not repeat them in its parenthetical.
 */
type Phrase = {
  verb: string | ((detail: Record<string, string | boolean>) => string);
  prep?: string;
  target?: string;
  consumes?: readonly string[];
};

const PHRASES: Readonly<Record<string, Phrase>> = {
  // Projects
  'POST /api/projects': { verb: 'created a project', target: 'project' },
  'POST /api/projects/import': { verb: 'imported a project', target: 'project' },
  'DELETE /api/projects/:id': { verb: 'deleted the project', prep: '' },
  'POST /api/projects/:id/reindex': { verb: 'queued a re-index', prep: 'of' },
  // Sources
  'POST /api/projects/:id/sources': { verb: 'added a source', prep: 'to', target: 'source' },
  'PATCH /api/projects/:id/sources/:sid': { verb: 'changed a source', prep: 'of', target: 'source' },
  'DELETE /api/projects/:id/sources/:sid': { verb: 'deleted a source', prep: 'from', target: 'source' },
  'POST /api/projects/:id/sources/:sid/sync': { verb: 'queued a sync of a source', prep: 'of', target: 'source' },
  'DELETE /api/projects/:id/sources/:sid/files': { verb: 'deleted the uploaded files of a source', prep: 'of', target: 'source' },
  // For a git source this rotates the secret; for Confluence the first one also turns the webhook on.
  'POST /api/projects/:id/sources/:sid/webhook-secret': { verb: 'generated a new webhook secret for a source', prep: 'of', target: 'source' },
  'DELETE /api/projects/:id/sources/:sid/webhook-secret': { verb: 'turned off the webhook of a source', prep: 'of', target: 'source' },
  'POST /api/projects/:id/sources/:sid/webhook-verification': { verb: 'opened a Notion verification window', prep: 'on', target: 'source' },
  // Uploads
  'POST /api/projects/:id/sources/:sid/uploads': { verb: 'started an upload', prep: 'to', target: 'upload' },
  'POST /api/projects/:id/sources/:sid/uploads/:session/commit': { verb: 'committed uploaded files', prep: 'to', target: 'upload' },
  'DELETE /api/projects/:id/sources/:sid/uploads/:session': { verb: 'discarded a staged upload', prep: 'on', target: 'upload' },
  // Who may reach a project
  'PATCH /api/projects/:id/mcp-auth': { verb: 'changed who may reach the MCP endpoint', prep: 'of' },
  'POST /api/projects/:id/mcp-tokens': { verb: 'issued an MCP credential', prep: 'for', target: 'credential' },
  'DELETE /api/projects/:id/mcp-tokens/:tokenId': { verb: 'revoked an MCP credential', prep: 'of', target: 'credential' },
  'PUT /api/projects/:id/members/:userId': { verb: 'granted access', prep: 'to', target: 'account' },
  'DELETE /api/projects/:id/members/:userId': { verb: 'revoked access', prep: 'to', target: 'account' },
  // A self-service API token ([ADR-0076](../../.ssot/ADR.md#adr-0076)) — never project-scoped as an
  // *action*, even when the token itself is scoped to one: minting and revoking are things an
  // account does to its own credentials, not to a project.
  'POST /api/tokens': { verb: 'created an API token', target: 'token' },
  'DELETE /api/tokens/:tokenId': { verb: 'revoked an API token', target: 'token' },
  // The query log. The switch says which way it was thrown, or the panel reads as its own opposite.
  'PATCH /api/projects/:id/query-log': {
    verb: (detail) =>
      detail.enabled === undefined
        ? 'switched query logging'
        : detail.enabled === true || detail.enabled === 'true'
          ? 'turned query logging on'
          : 'turned query logging off',
    prep: 'for',
    consumes: ['enabled'],
  },
  'DELETE /api/projects/:id/query-log': { verb: 'purged the query log', prep: 'of' },
  // Accounts
  'POST /api/users': { verb: 'created an account', target: 'account' },
  'PATCH /api/users/:id': { verb: 'changed an account', target: 'account' },
  'DELETE /api/users/:id': { verb: 'deleted an account', target: 'account' },
  'POST /api/users/:id/password': { verb: 'reset the password of an account', target: 'account' },
  'DELETE /api/users/:id/sessions': { verb: 'signed an account out everywhere', target: 'account' },
  // The actor's own session. `POST /api/auth/login` and `POST /api/setup` are recorded since
  // [ADR-0055](../../.ssot/ADR.md#adr-0055)'s second pass: they create the actor they then name.
  'POST /api/auth/login': { verb: 'signed in' },
  'POST /api/setup': { verb: 'set this instance up and became its first account', target: 'account' },
  'POST /api/auth/logout': { verb: 'signed out' },
  'POST /api/auth/password': { verb: 'changed their own password' },
  'DELETE /api/auth/sessions': { verb: 'signed their other sessions out' },
  // Self-service SSO unlink ([MAJOR-1], tur 2 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)) — the
  // matching link happens inside `GET /api/auth/oidc/callback`, which records its own event manually
  // since `auditSubject` never covers a GET.
  'DELETE /api/auth/oidc/link': { verb: 'unlinked their SSO identity' },
  // A person granting a connector lasting read access to a project — the one refusal this log keeps,
  // because a `deny` is somebody deciding rather than the permission matrix declining.
  'POST /oauth/authorize': {
    verb: (detail) =>
      detail.decision === 'deny' ? 'refused a connector' : detail.decision === 'approve' ? 'approved a connector' : 'answered a connector request',
    consumes: ['decision'],
  },
};

/** Enough of a uuid to recognise and to search for, and short enough to sit inside a sentence. */
const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

export interface AuditSummaryInput {
  action: string;
  actorLabel: string;
  projectId: string | null;
  /** `null` when the project has been deleted — there is no foreign key, so its rows outlive it. */
  projectName: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, string | boolean>;
}

/**
 * One row as a sentence: who did what, to which project, to which thing.
 *
 * A dump of the columns is not what an operator reading an audit log is doing — they are looking for
 * an action they half remember, and `DELETE /api/projects/:id/sources/:sid` with four uuids beside it
 * makes them reconstruct it every time. The parts a sentence cannot carry without becoming noise —
 * the full uuids, the address, the status — stay in the row's own fields, beside it.
 */
export function summarizeAuditEvent(event: AuditSummaryInput): string {
  const phrase = PHRASES[event.action];
  const words = [event.actorLabel, verbOf(phrase, event.detail) ?? `ran ${event.action}`];

  if (event.projectId !== null) {
    // The name is joined from `projects`, and a deleted project has none to join to. Saying the id
    // and saying it is gone is the whole truth available; inventing "(unknown)" would not be.
    const where = event.projectName ?? `${shortId(event.projectId)} (no longer exists)`;
    const prep = phrase?.prep ?? 'on';
    words.push(prep === '' ? where : `${prep} ${where}`);
  }

  const aside: string[] = [];
  if (event.targetType !== null && event.targetId !== null) aside.push(`${phrase?.target ?? event.targetType} ${shortId(event.targetId)}`);
  // `detail` is already a closed set of fields and values (src/auth/policy.ts), so this cannot widen
  // into free text however a request body was shaped. A field the verb has already said is left out
  // rather than repeated — "turned query logging off … (enabled: false)" says it twice.
  for (const [key, value] of Object.entries(event.detail)) {
    if (phrase?.consumes?.includes(key)) continue;
    // The acting token's id (`src/services/audit.ts`): a uuid, so shortened like every other one here.
    if (key === 'tokenId' && typeof value === 'string') {
      aside.push(`via token ${shortId(value)}`);
      continue;
    }
    aside.push(`${key}: ${String(value)}`);
  }
  if (aside.length > 0) words.push(`(${aside.join(', ')})`);

  return words.join(' ');
}

const verbOf = (phrase: Phrase | undefined, detail: Record<string, string | boolean>): string | null =>
  phrase === undefined ? null : typeof phrase.verb === 'string' ? phrase.verb : phrase.verb(detail);

// ---------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------

export interface AuditEventView {
  id: string;
  createdAt: string;
  action: string;
  summary: string;
  actor: {
    kind: AuditActorKind;
    label: string;
    userId: string | null;
    /** A `user` event whose account has been deleted; `actor_user_id` is `ON DELETE SET NULL`. */
    accountGone: boolean;
    ip: string | null;
  };
  /** `null` for an event that belongs to no project; `name: null` when the project is gone. */
  project: { id: string; name: string | null } | null;
  target: { type: string; id: string } | null;
  detail: Record<string, string | boolean>;
  statusCode: number;
}

export const auditRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db } = ctx;

  app.get('/api/audit', async (req) => {
    const query = AuditQuery.parse(req.query);
    const window = dayBounds(query.from, query.to);
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (cursor !== null) await assertCursorExists(cursor);

    const where = [
      query.actor === undefined ? null : eq(auditEvents.actorLabel, query.actor),
      query.action === undefined ? null : eq(auditEvents.action, query.action),
      query.project === undefined
        ? null
        : query.project === 'none'
          ? isNull(auditEvents.projectId)
          : eq(auditEvents.projectId, projectId(query.project)),
      window.from === null ? null : gte(auditEvents.createdAt, window.from),
      window.to === null ? null : lt(auditEvents.createdAt, window.to),
      // Keyset paging, in the order the index already holds: strictly after the last row handed out.
      // An offset would re-count the rows of every page before this one, and would skip or repeat a
      // row when an action is recorded while somebody is paging.
      cursor === null ? null : cursorPredicate(cursor),
    ].filter((clause) => clause !== undefined && clause !== null);

    // One row more than asked for: whether there is another page is a fact about the query, and
    // answering it with a second `count(*)` over the same predicate would double the work.
    const rows = await db
      .select({
        id: auditEvents.id,
        createdAt: auditEvents.createdAt,
        action: auditEvents.action,
        actorKind: auditEvents.actorKind,
        actorUserId: auditEvents.actorUserId,
        actorLabel: auditEvents.actorLabel,
        actorIp: auditEvents.actorIp,
        projectId: auditEvents.projectId,
        projectName: projects.name,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        detail: auditEvents.detail,
        statusCode: auditEvents.statusCode,
      })
      .from(auditEvents)
      .leftJoin(projects, eq(projects.id, auditEvents.projectId))
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      events: page.map(toView),
      /** `null` when this is the last page; the panel's "Older" is disabled by exactly this. */
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      // Only on the first page of a filter run: the pickers do not change as somebody pages, and three
      // `DISTINCT` scans per page turn would be the load ADR-0050 declined to put on the query log.
      filters: cursor === null ? await facets() : null,
      retentionDays: config.AUDIT_LOG_RETENTION_DAYS,
    };
  });

  /**
   * That the cursor names a row this log still holds.
   *
   * One primary-key lookup, and it is what makes the `400` true rather than a shape check: a cursor
   * that is a well-formed uuid but names nothing would otherwise compare against `NULL` in the
   * predicate below and hand back a silently empty page, which reads as "no more events". It also
   * catches the real race — the anchor row swept by `AUDIT_LOG_RETENTION_DAYS` between two page turns.
   */
  async function assertCursorExists(id: string): Promise<void> {
    const [row] = await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.id, id)).limit(1);
    if (!row) throw new ValidationError('That page cursor does not name an event this log still holds; start again from the newest page.');
  }

  /**
   * The distinct values the pickers offer — **over the whole table, not over the current filter.**
   * Narrowing them by the filter in force would remove from the dropdown every actor but the one
   * already chosen, which is the one thing a filter picker must not do.
   */
  async function facets() {
    // One row past the cap, so "there are more than this" is a fact rather than a guess: at exactly
    // `MAX_FACET_ROWS` rows a query capped *at* the cap cannot tell a full list from a cut one.
    const probe = MAX_FACET_ROWS + 1;
    const [actors, actions, withProject] = await Promise.all([
      db
        .selectDistinct({ label: auditEvents.actorLabel, kind: auditEvents.actorKind })
        .from(auditEvents)
        .orderBy(auditEvents.actorLabel)
        .limit(probe),
      db.selectDistinct({ action: auditEvents.action }).from(auditEvents).orderBy(auditEvents.action).limit(probe),
      db
        .selectDistinct({ id: auditEvents.projectId, name: projects.name })
        .from(auditEvents)
        .leftJoin(projects, eq(projects.id, auditEvents.projectId))
        .where(isNotNull(auditEvents.projectId))
        // Ordered by name in SQL and not in JavaScript, because the cap is applied by the database:
        // sorting afterwards would decide *which* projects are offered by `project_id` order, which is
        // random. PostgreSQL sorts NULL last on an ASC ordering, so a deleted project falls to the end
        // of the picker — which is where it belongs and not where it disappears.
        .orderBy(projects.name)
        .limit(probe),
    ]);

    return {
      actors: actors.slice(0, MAX_FACET_ROWS),
      actions: actions.slice(0, MAX_FACET_ROWS).map((a) => ({ action: a.action, summary: summarizeAction(a.action) })),
      // A project whose rows are still here and whose name is not is named by its id in the panel, so
      // the picker can still reach the events of something that has been deleted.
      projects: withProject.slice(0, MAX_FACET_ROWS).filter((p): p is { id: string; name: string | null } => p.id !== null),
      truncated: actors.length > MAX_FACET_ROWS || actions.length > MAX_FACET_ROWS || withProject.length > MAX_FACET_ROWS,
    };
  }
};

/**
 * The `action` picker's label: the phrase with no actor, no project and no target in front of it.
 *
 * A picker chooses a *route*, not one event, so a verb that depends on `detail` is asked with none —
 * which is why each of those has a neutral wording for the empty case ("switched query logging"
 * rather than either direction of it).
 */
export const summarizeAction = (action: string): string => verbOf(PHRASES[action], {}) ?? `ran ${action}`;

/**
 * Every action a phrase has been written for — exported so `test/audit-view.test.ts` can check the
 * table against `auditSubject()` itself rather than against a copy of it. A phrase keyed on something
 * that is not an audit event is one nobody will ever see: a typo, or a phrase written for a route the
 * policy layer exempts.
 */
export const PHRASED_ACTIONS: readonly string[] = Object.keys(PHRASES);

/**
 * Everything strictly after the cursor row, in `(created_at DESC, id DESC)` — **resolved in SQL.**
 *
 * The anchor's instant is read by the database, compared by the database, and never crosses into
 * JavaScript, so the microsecond `timestamptz` keeps is the microsecond the comparison uses. See
 * `encodeCursor` for what carrying it through a `Date` costs. The row-wise `<` is the two-column
 * comparison `audit_events_created_idx` supports, spelled the way PostgreSQL can use it.
 */
function cursorPredicate(id: string) {
  return sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (select anchor.created_at, anchor.id from audit_events as anchor where anchor.id = ${id}::uuid)`;
}

/** A project filter is a row id too, and is refused here rather than reaching a `uuid` column. */
function projectId(value: string): string {
  if (!UUID.test(value))
    throw new ValidationError(`"${value}" is not a project id. Use a project's id, or "none" for the events that belong to none.`);
  return value;
}

type AuditRow = {
  id: string;
  createdAt: Date;
  action: string;
  actorKind: AuditActorKind;
  actorUserId: string | null;
  actorLabel: string;
  actorIp: string | null;
  projectId: string | null;
  projectName: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  statusCode: number;
};

function toView(row: AuditRow): AuditEventView {
  const detail = (typeof row.detail === 'object' && row.detail !== null ? row.detail : {}) as Record<string, string | boolean>;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    summary: summarizeAuditEvent({
      action: row.action,
      actorLabel: row.actorLabel,
      projectId: row.projectId,
      projectName: row.projectName,
      targetType: row.targetType,
      targetId: row.targetId,
      detail,
    }),
    actor: {
      kind: row.actorKind,
      label: row.actorLabel,
      userId: row.actorUserId,
      accountGone: row.actorKind === 'user' && row.actorUserId === null,
      ip: row.actorIp,
    },
    project: row.projectId === null ? null : { id: row.projectId, name: row.projectName },
    target: row.targetType !== null && row.targetId !== null ? { type: row.targetType, id: row.targetId } : null,
    detail,
    statusCode: row.statusCode,
  };
}
