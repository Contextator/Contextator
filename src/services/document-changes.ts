import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { documentChanges, documents, settings } from '../db/schema.js';

/**
 * What changed in a project's index, per path ([ADR-0123](../../.ssot/ADR.md#adr-0123)).
 *
 * One row per project and path holds the **latest** change; the indexer writes it where it writes the
 * index itself, in the same transaction, and `whats_new` reads it back. Nothing in this module reads
 * the filesystem or a source: a change is a difference between two rows of `documents`.
 *
 * This module must not import `vector-store.ts`: `replaceDocument` calls into it, and the dependency
 * runs one way.
 */

/** How long a change is remembered. A constant on purpose: ADR-0123 decision 5 keeps it off the configuration surface. */
export const DOCUMENT_CHANGES_RETENTION_DAYS = 90;

/** `settings` key holding the instant the record started being kept, as an ISO 8601 string. */
export const TRACKING_SINCE_KEY = 'document_changes_tracking_since';

/** The default and the ceiling of `whats_new`'s `limit` (ADR-0123 decision 4). */
export const WHATS_NEW_DEFAULT_LIMIT = 50;
export const WHATS_NEW_MAX_LIMIT = 200;

export type DocumentChangeKind = 'added' | 'modified' | 'removed';

/** A `Db` or the transaction handle `db.transaction` gives its callback; both run the same statements. */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** What the change decision needs to know of one side of a comparison. */
export interface StoredText {
  contentHash: string;
  /** `documents.content`: the flavor-transformed text, NULL for a row written before the column existed. */
  content: string | null;
  contentTruncated: boolean;
}

/**
 * Whether the stored texts prove that two documents say the same thing.
 *
 * Both must be present and untruncated: a missing text proves nothing, and a truncated one only proves
 * that its first part is equal. In either case the caller falls back to the hash, which errs towards
 * reporting a change (ADR-0123 decision 2).
 */
export function textProvesEqual(a: Pick<StoredText, 'content' | 'contentTruncated'>, b: Pick<StoredText, 'content' | 'contentTruncated'>): boolean {
  return a.content !== null && b.content !== null && !a.contentTruncated && !b.contentTruncated && a.content === b.content;
}

/**
 * Whether a document the index already had has changed: its `content_hash` differs **and** its text
 * cannot prove otherwise. The hash is the file's raw bytes, so it moves when only the file's other
 * documents did (ADR-0057) or when a source's language was edited (`invalidateSourceDocuments`); the
 * text is what tells those apart from a change.
 *
 * The SQL twin of this is in `recordRebuildChanges`; `test/integration/whats-new.itest.ts` holds the two to the same answers.
 */
export function isModified(before: StoredText, after: StoredText): boolean {
  return before.contentHash !== after.contentHash && !textProvesEqual(before, after);
}

const SINCE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i;

/**
 * Reads `whats_new`'s `since`: an ISO 8601 date, or date-time with an optional `Z` or `±hh:mm` offset.
 * A date alone is midnight UTC and a date-time with no offset is UTC, so the same string means the same
 * instant on every host. `Date.parse` is not used for the reading: it takes "October 5 2026" and it lets
 * `2026-02-31` roll over into March, and an agent that mistyped a date deserves a refusal, not a guess.
 * Returns `null` for anything else.
 */
export function parseSince(raw: string): Date | null {
  const match = SINCE_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0', zone = 'Z'] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (h > 23 || mi > 59 || s > 59) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s, Number(fraction.padEnd(3, '0').slice(0, 3))));
  // `Date.UTC` rolls an impossible day over; a round trip through the calendar says whether it did.
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d) return null;
  return new Date(wall.getTime() - offsetMinutes * 60_000);
}

/**
 * What a stored row is reported as for a `since`, or `null` when it is not reported at all
 * (ADR-0123 decision 4).
 *
 * A path added after `since` is `added` however often it changed since, unless it is now gone, in which
 * case it came and went inside the window and the agent never knew it. A NULL `addedAt` is never
 * `added`: when it was added is not known (the row predates the table, or it aged out).
 */
export function classifyChange(row: { change: DocumentChangeKind; addedAt: Date | null; changedAt: Date }, since: Date): DocumentChangeKind | null {
  if (row.changedAt.getTime() <= since.getTime()) return null;
  const addedInWindow = row.addedAt !== null && row.addedAt.getTime() > since.getTime();
  if (addedInWindow) return row.change === 'removed' ? null : 'added';
  return row.change;
}

/**
 * The oldest instant the record can speak for: the latest of the retention horizon, the moment the
 * instance began recording, and the moment the project came to exist here. With no record at all (the
 * setting is missing) it speaks for nothing, so `now`.
 *
 * The project's own creation is in it because the record is kept where the indexer writes, and a project
 * that was imported, or created and not indexed until later, has documents the record never saw: asked
 * about a time before the project existed here, the honest answer is "incomplete", not an empty list
 * that calls itself complete (ADR-0123 decision 4, `complete`).
 */
export function historyStartsAt(
  now: Date,
  trackingSince: Date | null,
  projectCreatedAt: Date | null = null,
  retentionDays = DOCUMENT_CHANGES_RETENTION_DAYS,
): Date {
  if (trackingSince === null) return now;
  const horizon = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return [trackingSince, projectCreatedAt, horizon].reduce<Date>(
    (latest, at) => (at !== null && at.getTime() > latest.getTime() ? at : latest),
    horizon,
  );
}

/** Statements that take a path list stay far below PostgreSQL's 65 535 bind parameters. */
const PATH_BATCH = 2_000;

/** `excluded.<column>` for the upserts below, which name the incoming row of a multi-row insert. */
const incoming = (column: string) => sql.raw(`excluded.${column}`);

/**
 * Records the change a document write is, inside the transaction that writes it.
 *
 * Called by `replaceDocument` **before** its upsert, so the row it reads is the one being replaced. Only
 * for the live generation: a rebuild's writes go to a generation nobody can see yet, and its changes are
 * recorded once, at the swap (`recordRebuildChanges`).
 *
 * - no stored row → `added`;
 * - a stored row whose text changed (`isModified`) → `modified`, keeping `added_at`;
 * - otherwise nothing: the file's bytes moved and the document did not.
 */
export async function recordWriteChange(
  tx: Executor,
  next: {
    projectId: string;
    generation: number;
    relativePath: string;
    title: string;
    version: string;
    contentHash: string;
    content: string | null;
    contentTruncated: boolean;
    runId: string | null;
  },
): Promise<DocumentChangeKind | null> {
  const [before] = await tx
    .select({ contentHash: documents.contentHash, content: documents.content, contentTruncated: documents.contentTruncated })
    .from(documents)
    .where(
      and(eq(documents.projectId, next.projectId), eq(documents.indexGeneration, next.generation), eq(documents.relativePath, next.relativePath)),
    );

  const kind: DocumentChangeKind | null = before === undefined ? 'added' : isModified(before, next) ? 'modified' : null;
  if (kind === null) return null;

  const row = {
    projectId: next.projectId,
    relativePath: next.relativePath,
    change: kind,
    title: next.title,
    version: next.version,
    // The database's clock, as the sweep's is, and one value for the whole statement.
    addedAt: kind === 'added' ? sql`now()` : null,
    changedAt: sql`now()`,
    runId: next.runId,
  };
  await tx
    .insert(documentChanges)
    .values(row)
    .onConflictDoUpdate({
      target: [documentChanges.projectId, documentChanges.relativePath],
      set: {
        change: kind,
        title: next.title,
        version: next.version,
        changedAt: sql`now()`,
        runId: next.runId,
        // A path that comes back after a removal is new again; a modification keeps the date it was added.
        ...(kind === 'added' ? { addedAt: sql`now()` } : {}),
      },
    });
  return kind;
}

/**
 * Records `removed` for documents of one generation and deletes them, in one transaction. The title and
 * the version come off the row being deleted: afterwards this is the only place that remembers them.
 */
export async function deleteDocumentsRecordingChanges(
  db: Db,
  projectId: string,
  generation: number,
  relativePaths: string[],
  runId: string | null,
): Promise<void> {
  if (relativePaths.length === 0) return;
  await db.transaction(async (tx) => {
    for (let i = 0; i < relativePaths.length; i += PATH_BATCH) {
      const batch = relativePaths.slice(i, i + PATH_BATCH);
      const where = and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), inArray(documents.relativePath, batch));
      const doomed = await tx
        .select({ relativePath: documents.relativePath, title: documents.title, version: documents.version })
        .from(documents)
        .where(where);
      if (doomed.length > 0) {
        await tx
          .insert(documentChanges)
          .values(
            doomed.map((d) => ({
              projectId,
              relativePath: d.relativePath,
              change: 'removed' as const,
              title: d.title,
              version: d.version,
              addedAt: null,
              changedAt: sql`now()`,
              runId,
            })),
          )
          // `added_at` is left alone: an `added` row removed inside the window is what lets `whats_new` omit it.
          .onConflictDoUpdate({
            target: [documentChanges.projectId, documentChanges.relativePath],
            set: {
              change: 'removed',
              title: incoming('title'),
              version: incoming('version'),
              changedAt: incoming('changed_at'),
              runId: incoming('run_id'),
            },
          });
      }
      await tx.delete(documents).where(where);
    }
  });
}

/**
 * Records `removed` for every document a source has in the live generation. `deleteSource` calls it in
 * the transaction that deletes the source, whose documents then go by foreign-key cascade, outside the
 * indexer; without this a deleted source would never show as removed.
 */
export async function recordSourceRemoval(tx: Executor, projectId: string, sourceId: string, liveGeneration: number): Promise<void> {
  await tx.execute(sql`
    INSERT INTO document_changes (project_id, relative_path, change, title, version, added_at, changed_at, run_id)
    SELECT d.project_id, d.relative_path, 'removed', d.title, d.version, NULL, now(), NULL
    FROM documents d
    WHERE d.project_id = ${projectId} AND d.source_id = ${sourceId} AND d.index_generation = ${liveGeneration}
    ON CONFLICT (project_id, relative_path) DO UPDATE SET
      change = 'removed', title = EXCLUDED.title, version = EXCLUDED.version, changed_at = EXCLUDED.changed_at, run_id = EXCLUDED.run_id`);
}

/**
 * The difference between the live generation and the one about to replace it, recorded as changes.
 *
 * **Runs in the swap's own transaction** ([ADR-0123](../../.ssot/ADR.md#adr-0123) decision 3, which
 * amends [ADR-0039](../../.ssot/ADR.md#adr-0039) decision 5): the changes become visible with the new
 * generation or not at all. A rebuild writes nothing per document, because those writes go to a
 * generation no reader can see.
 *
 * One statement, a full outer join on the path:
 * - only in the new generation → `added`;
 * - only in the old one → `removed`;
 * - in both, and `isModified`'s predicate holds → `modified`.
 *
 * A path in both whose text and hash agree writes nothing, so a rebuild of unchanged content records
 * nothing at all. Returns how many rows it wrote.
 */
export async function recordRebuildChanges(
  tx: Executor,
  projectId: string,
  liveGeneration: number,
  newGeneration: number,
  runId: string | null,
): Promise<number> {
  const result = await tx.execute(sql`
    INSERT INTO document_changes (project_id, relative_path, change, title, version, added_at, changed_at, run_id)
    SELECT ${projectId}::uuid, diff.relative_path, diff.change, diff.title, diff.version,
           CASE WHEN diff.change = 'added' THEN now() ELSE NULL END, now(), ${runId}::uuid
    FROM (
      SELECT COALESCE(n.relative_path, o.relative_path) AS relative_path,
             CASE WHEN o.relative_path IS NULL THEN 'added' WHEN n.relative_path IS NULL THEN 'removed' ELSE 'modified' END AS change,
             COALESCE(n.title, o.title) AS title,
             COALESCE(n.version, o.version) AS version
      FROM (
        SELECT relative_path, title, version, content_hash, content, content_truncated
        FROM documents WHERE project_id = ${projectId} AND index_generation = ${newGeneration}
      ) n
      FULL OUTER JOIN (
        SELECT relative_path, title, version, content_hash, content, content_truncated
        FROM documents WHERE project_id = ${projectId} AND index_generation = ${liveGeneration}
      ) o ON o.relative_path = n.relative_path
      WHERE o.relative_path IS NULL
         OR n.relative_path IS NULL
         OR (
           o.content_hash IS DISTINCT FROM n.content_hash
           AND NOT (o.content IS NOT NULL AND n.content IS NOT NULL AND NOT o.content_truncated AND NOT n.content_truncated AND o.content = n.content)
         )
    ) diff
    ON CONFLICT (project_id, relative_path) DO UPDATE SET
      change = EXCLUDED.change, title = EXCLUDED.title, version = EXCLUDED.version,
      changed_at = EXCLUDED.changed_at, run_id = EXCLUDED.run_id,
      added_at = CASE WHEN EXCLUDED.change = 'added' THEN EXCLUDED.added_at ELSE document_changes.added_at END`);
  return result.rowCount ?? 0;
}

/**
 * Deletes every change older than the retention, across every project. `now()` is the database's, for
 * `sweepQueryLog`'s reason: a skew between the application and the database must not stretch a window.
 *
 * A path whose row is swept and which changes again is born again with a NULL `added_at`, which is
 * deliberate: its addition is beyond the horizon and its date is not known.
 */
export async function sweepDocumentChanges(db: Db, retentionDays = DOCUMENT_CHANGES_RETENTION_DAYS): Promise<number> {
  const deleted = await db
    .delete(documentChanges)
    .where(lt(documentChanges.changedAt, sql`now() - make_interval(days => ${retentionDays})`))
    .returning({ path: documentChanges.relativePath });
  return deleted.length;
}

/**
 * The database's clock as the string `readTrackingSince` reads back: every other instant in this table is
 * `now()`, and a skew between the application and the database must not move the start of the record.
 */
const DATABASE_NOW_ISO = sql`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Writes the instant the record began, once. Run by the bootstrap on every start; the first one wins.
 * It lives in `settings` and not in the migration because migrations are generated, not written
 * (`HARITA.md`, "Dikkat"), and a loop-free `INSERT` is exactly what the bootstrap's phase 4 holds.
 */
export async function ensureTrackingSince(db: Executor): Promise<void> {
  await db.insert(settings).values({ key: TRACKING_SINCE_KEY, value: DATABASE_NOW_ISO }).onConflictDoNothing({ target: settings.key });
}

/**
 * Forgets the whole record and starts it again from now. For `RESET_VECTORS=1`, which deletes every
 * document without a run to say so: the next run would find an empty index and record the entire corpus
 * as `added` (with new dates), and the deletion itself would be recorded nowhere. Starting over moves
 * `history_starts_at` forward instead, so the answer says that it cannot speak for before the reset.
 * Called in the transaction that deletes the documents.
 */
export async function restartRecording(tx: Executor): Promise<void> {
  await tx.delete(documentChanges);
  await tx
    .insert(settings)
    .values({ key: TRACKING_SINCE_KEY, value: DATABASE_NOW_ISO })
    .onConflictDoUpdate({ target: settings.key, set: { value: DATABASE_NOW_ISO, updatedAt: sql`now()` } });
}

/** The instant the record began, or `null` when the setting is missing or is not a date. */
export async function readTrackingSince(db: Executor): Promise<Date | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, TRACKING_SINCE_KEY));
  if (!row) return null;
  const at = new Date(row.value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** One row `whats_new` reports, with what the live document says of its origin. */
export interface ListedChange {
  path: string;
  title: string;
  version: string;
  change: DocumentChangeKind;
  changedAt: Date;
  /** Present for a document that still exists; `null` for a removed one and for a source with no address. */
  sourceUrl: string | null;
  sourceModifiedAt: Date | null;
}

export interface ListChangesQuery {
  projectId: string;
  liveGeneration: number;
  since: Date;
  /** A source name: the first path segment ([ADR-0011](../../.ssot/ADR.md#adr-0011)). It is a prefix, so a deleted source still filters. */
  source?: string;
  /** An exact release label ([ADR-0058](../../.ssot/ADR.md#adr-0058)). */
  version?: string;
  limit: number;
}

/**
 * The changes after `since`, newest first, one more than `limit` asked for so that the caller can say
 * whether it cut the list without a second query.
 *
 * A path added and removed again inside the window is left out **in SQL**, not after the limit: the
 * list must not be shortened by rows the agent was never going to see. The predicate is
 * `classifyChange`'s, written NULL-safe (`added_at` is NULL for a path older than the record).
 */
export async function listDocumentChanges(db: Db, query: ListChangesQuery): Promise<{ changes: ListedChange[]; truncated: boolean }> {
  const { projectId, liveGeneration, since, source, version, limit } = query;
  const rows = await db
    .select({
      path: documentChanges.relativePath,
      title: documentChanges.title,
      version: documentChanges.version,
      change: documentChanges.change,
      addedAt: documentChanges.addedAt,
      changedAt: documentChanges.changedAt,
      sourceUrl: documents.sourceUrl,
      sourceModifiedAt: documents.sourceModifiedAt,
    })
    .from(documentChanges)
    // The live generation only, and only to read an origin: the change row stands on its own.
    .leftJoin(
      documents,
      and(
        eq(documents.projectId, documentChanges.projectId),
        eq(documents.indexGeneration, liveGeneration),
        eq(documents.relativePath, documentChanges.relativePath),
      ),
    )
    .where(
      and(
        eq(documentChanges.projectId, projectId),
        gt(documentChanges.changedAt, since),
        sql`(${documentChanges.change} <> 'removed' OR ${documentChanges.addedAt} IS NULL OR ${documentChanges.addedAt} <= ${since})`,
        version === undefined ? undefined : eq(documentChanges.version, version),
        // `starts_with` rather than `LIKE`: a source name is `[a-z0-9_-]`, but a prefix is not a pattern and this needs no escaping.
        source === undefined ? undefined : sql`starts_with(${documentChanges.relativePath}, ${`${source}/`})`,
      ),
    )
    .orderBy(desc(documentChanges.changedAt), asc(documentChanges.relativePath))
    .limit(limit + 1);

  const changes: ListedChange[] = [];
  for (const row of rows.slice(0, limit)) {
    const change = classifyChange({ change: row.change as DocumentChangeKind, addedAt: row.addedAt, changedAt: row.changedAt }, since);
    // The SQL already dropped what classifyChange drops; this is the same rule as a guard, not a second filter.
    if (change === null) continue;
    changes.push({
      path: row.path,
      title: row.title,
      version: row.version,
      change,
      changedAt: row.changedAt,
      // A removed document has no row to read an address from; if the join found one the path has come back and the change row is stale.
      sourceUrl: change === 'removed' ? null : row.sourceUrl,
      sourceModifiedAt: change === 'removed' ? null : row.sourceModifiedAt,
    });
  }
  return { changes, truncated: rows.length > limit };
}

/**
 * How many paths a run recorded a change for. One of the three things that say an incremental run changed
 * the index, and so that the golden set should be asked again ([ADR-0124](../../.ssot/ADR.md#adr-0124)
 * rule 2); the other two are chunks written and files removed, which the run counts itself.
 */
export async function countChangesOfRun(db: Db, projectId: string, runId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(documentChanges)
    .where(and(eq(documentChanges.projectId, projectId), eq(documentChanges.runId, runId)));
  return row?.total ?? 0;
}
