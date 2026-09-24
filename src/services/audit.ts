import { sql } from 'drizzle-orm';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { type AuditEventInsert, auditEvents } from '../db/schema.js';
import type { AuditSubject } from '../auth/policy.js';
import type { Principal } from '../auth/types.js';

/**
 * Who changed this instance, and what they changed ([ADR-0055](../../.ssot/ADR.md#adr-0055)) — the
 * write side.
 *
 * Three properties, and each of them is the opposite of the query log's on purpose.
 *
 * **It is not buffered and not lossy.** `services/query-log.ts` drops rows rather than slow a search
 * down, because searches are the hot path and a lost line of analytics costs analysis. An admin action
 * is a handful a day and the row is the whole point, so every event becomes a statement of its own.
 * What keeps it off the response path is *when* it runs rather than a queue: the policy layer calls it
 * from Fastify's `onResponse`, after the reply has gone.
 *
 * **It cannot record an anonymous event.** The actor is not a parameter a caller may leave out — it is
 * derived here from the `Principal` the policy layer already resolved, and `audit_events.actor_label`
 * is NOT NULL and constrained non-empty in the database besides.
 *
 * **It carries no user content.** Nothing in this file reads a request body: `AuditSubject` arrives
 * already filtered by `src/auth/policy.ts`, whose allowlist can only pass values from a closed set.
 * That is the line that keeps this table out of the query log's privacy regime — this one says what
 * was done, that one says what was asked — and it is the reason the two were not merged.
 */

/** Long enough for any route template this product has, and a bound the column would not otherwise have. */
const MAX_ACTION_CHARS = 200;
/** A username is bounded by the account rules; this is the backstop for a label from anywhere else. */
const MAX_LABEL_CHARS = 200;
/** An address, v4 or v6, possibly with a zone. Anything longer is not one. */
const MAX_IP_CHARS = 64;

/** What the policy layer knows about the request, on top of the subject it already derived. */
export interface AuditContext {
  principal: Principal;
  /** `req.ip`. A hint stored beside the actor, never an identity — see the column's own comment. */
  ip: string | null;
  statusCode: number;
}

/**
 * Pure: the subject, the actor and the outcome become the row.
 *
 * `ADMIN_TOKEN` is `actorKind: 'token'` with no account id and the label `ADMIN_TOKEN`, which is what
 * `Principal.username` already holds for it — machine access is recorded as machine access rather than
 * as a person nobody can name. An [ADR-0076](../../.ssot/ADR.md#adr-0076) API token is `actorKind:
 * 'api_token'`, with its owner's real `userId` and the `"<token name> · <owner>"` label
 * `Principal.username` already carries for it — unlike `ADMIN_TOKEN`, it does name somebody — and
 * the token's own id in `detail.tokenId`, since a label cannot tell two same-named tokens apart.
 */
export function buildAuditRow(subject: AuditSubject, context: AuditContext): AuditEventInsert {
  const { principal } = context;
  return {
    action: subject.action.slice(0, MAX_ACTION_CHARS),
    actorKind: principal.kind === 'token' ? 'token' : principal.kind === 'apiToken' ? 'api_token' : 'user',
    actorUserId: principal.kind === 'token' ? null : principal.userId,
    actorLabel: principal.username.slice(0, MAX_LABEL_CHARS),
    actorIp: context.ip ? context.ip.slice(0, MAX_IP_CHARS) : null,
    projectId: subject.projectId,
    targetType: subject.targetType,
    targetId: subject.targetId,
    // The label names the token, but not uniquely: two tokens of one owner can share a name, and a
    // revoked one's name can be reused. The id is what tells them apart — the one to revoke — and it
    // is the principal's own, never a value from the request, so `detail` stays a closed set.
    detail: principal.kind === 'apiToken' ? { ...subject.detail, tokenId: principal.tokenId } : subject.detail,
    statusCode: context.statusCode,
  };
}

/** Writes one event. Used directly by a caller that wants the promise; the writer below is what the hook uses. */
export async function recordAuditEvent(db: Db, subject: AuditSubject, context: AuditContext): Promise<void> {
  await db.insert(auditEvents).values(buildAuditRow(subject, context));
}

/**
 * The writer the policy layer holds. One per process, built in `server.ts`.
 *
 * `record()` starts the insert and returns — the hook that calls it runs after the reply has gone, so
 * there is nothing to wait for and nothing to be slowed down. What the class adds over a bare
 * `void recordAuditEvent(…)` is that **the process knows what it still owes**: `settled()` waits for
 * every write already started, and `src/server.ts` awaits it on shutdown before closing the pool, the
 * way it already awaits `QueryLog.close()`. Without that, a `SIGTERM` arriving in the gap between the
 * response and the insert would lose exactly the record of the action somebody took last.
 *
 * It also makes the write observable to a test without a sleep or a poll, which is the difference
 * between asserting that a row appears and asserting that it appeared.
 */
export class AuditWriter {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    /** Counted for `/metrics`; the failure count is the number that cannot be read back off the table. */
    private readonly onOutcome?: (outcome: 'written' | 'failed') => void,
  ) {}

  /**
   * Never throws and never rejects. A failed write is logged loudly and changes nothing else, because
   * it cannot: the action it describes has already happened and has already been answered. An
   * accountability record is not a two-phase commit — and a database that refuses this insert has
   * almost certainly refused the action's own write first, so the request was not a success anyway.
   */
  record(subject: AuditSubject, context: AuditContext): void {
    const write = recordAuditEvent(this.db, subject, context)
      .then(() => {
        this.onOutcome?.('written');
      })
      .catch((err: unknown) => {
        this.onOutcome?.('failed');
        this.log.error(
          { err, action: subject.action, actor: context.principal.username },
          'could not record an audit event; the action itself succeeded',
        );
      })
      .finally(() => {
        this.inFlight.delete(write);
      });
    this.inFlight.add(write);
  }

  /** Waits for every write started before this call. For shutdown and for tests — never for a request. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }
}

/**
 * Deletes every event older than `retentionDays`.
 *
 * `now()` is the database's, not the process's, for the reason `sweepQueryLog` reads it there and
 * `user_sessions` compares its two deadlines in SQL: a clock skew between the application and the
 * database must not be able to lengthen or shorten a window an operator wrote down.
 */
export async function sweepAuditLog(db: Db, retentionDays: number): Promise<number> {
  const deleted = await db
    .delete(auditEvents)
    .where(sql`${auditEvents.createdAt} < now() - make_interval(days => ${retentionDays})`)
    .returning({ id: auditEvents.id });
  return deleted.length;
}
