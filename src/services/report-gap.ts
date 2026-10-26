import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { reportedGaps } from '../db/schema.js';
import type { GapReportObserver, GapReportOutcome } from './metrics.js';
import { getProjectById } from './projects.js';
import { normalizeQuery } from './query-log.js';

/**
 * What an agent says the documentation did not answer ([ADR-0125](../../.ssot/ADR.md#adr-0125)) — the
 * write side of `report_gap`, the first tool that writes.
 *
 * **It writes to its own table, never to `search_queries`**, whose every reader assumes a row is a search
 * that ran. It borrows the query log's policies instead: the project's switch is read **at the write**,
 * not when the session began (a legacy session lives as long as its client does, and a modern server's
 * `tools/list` may be cached), the retention sweep is `SEARCH_QUERY_LOG_RETENTION_DAYS`, and a per-project
 * row cap keeps the newest rows.
 *
 * **Its limit is counted from the table itself**: one row per accepted report, so the number of rows a
 * bucket has in the last hour is the counter, and replicas agree without a second table. `McpRateLimiter`
 * could not carry an hourly window: its sweep drops a counter ten minutes after its window opened.
 */

/** `search_docs` bounds its query at 2 000 characters and so does this; the tool's input schema enforces it. */
export const REPORT_GAP_QUERY_MAX_CHARS = 2_000;
export const REPORT_GAP_NOTE_MAX_CHARS = 1_000;

/** Rows one project keeps, oldest pruned first. A constant, not a setting: the limit below is the knob. */
export const REPORT_GAP_PROJECT_ROW_CAP = 2_000;

/**
 * The shared bucket of every anonymous caller of an `open` project. Not per address: an address is
 * changed by whoever wants more, and depends on `TRUST_PROXY`; one bucket is a hard bound on how fast an
 * unauthenticated caller can write. The price is that a noisy anonymous client can crowd out other
 * anonymous reports, which are a signal and are answered as a success either way.
 */
export const ANONYMOUS_RATE_KEY = 'anon';

/** `tok:<id>` for a call that presented a token, `anon` for one that did not (only an `open` project serves it). */
export const rateKeyFor = (tokenId: string | null): string => (tokenId === null ? ANONYMOUS_RATE_KEY : `tok:${tokenId}`);

export interface ReportGapInput {
  projectId: string;
  /** The MCP token the call presented; `null` for an `open` project's anonymous caller. */
  tokenId: string | null;
  query: string;
  note?: string;
}

export interface ReportGapDeps {
  db: Db;
  log: Logger;
  /** `MCP_REPORT_GAP_PER_HOUR`; `0` is off. */
  limitPerHour: number;
  metrics?: Partial<GapReportObserver>;
  /** Tests lower it to see the prune without writing two thousand rows. */
  projectRowCap?: number;
}

/**
 * Records one report, or decides not to, and says which. Never throws: a database that refuses the write
 * is `failed`, which the tool answers honestly rather than as "received".
 *
 * The order is the ADR's: the project row is re-read first, so a switch turned off since the session began
 * is honoured here and not only at `tools/list`; then the limit; then the row. The count and the insert
 * are two statements, so concurrent calls of one bucket can pass the limit together by a few rows, which
 * the ADR accepts.
 */
export async function reportGap(deps: ReportGapDeps, input: ReportGapInput): Promise<GapReportOutcome> {
  const { log, metrics } = deps;
  const outcome = await decide(deps, input).catch((err: unknown) => {
    log.warn({ err, projectId: input.projectId }, 'a gap report could not be stored');
    return 'failed' as const;
  });
  metrics?.countGapReport?.(outcome);
  return outcome;
}

async function decide(deps: ReportGapDeps, input: ReportGapInput): Promise<GapReportOutcome> {
  const { db, log } = deps;
  // Re-read on every call: the row the server was built with may be hours old (ADR-0125, decision 3).
  const project = await getProjectById(db, input.projectId);
  // A project deleted mid-session has nothing to report against. It is not a switch, so it is a failure.
  if (!project) return 'failed';
  if (!project.queryLogEnabled) return 'disabled';

  const rateKey = rateKeyFor(input.tokenId);
  if (deps.limitPerHour > 0) {
    // `now()` is the database's, for the reason the retention sweep's is: replicas whose clocks disagree
    // must not give one bucket two different hours.
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(reportedGaps)
      .where(
        and(
          eq(reportedGaps.projectId, input.projectId),
          eq(reportedGaps.rateKey, rateKey),
          gt(reportedGaps.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    if ((row?.n ?? 0) >= deps.limitPerHour) return 'limited';
  }

  const query = input.query.slice(0, REPORT_GAP_QUERY_MAX_CHARS);
  const note = input.note?.slice(0, REPORT_GAP_NOTE_MAX_CHARS).trim();
  await db.insert(reportedGaps).values({
    projectId: input.projectId,
    mcpTokenId: input.tokenId,
    rateKey,
    query,
    queryNorm: normalizeQuery(query),
    note: note ? note : null,
    liveGeneration: project.liveGeneration,
  });
  // A prune that fails does not unwrite a report that was stored.
  await pruneProjectReportedGaps(db, input.projectId, deps.projectRowCap).catch((err: unknown) =>
    log.warn({ err, projectId: input.projectId }, 'reported gaps row cap prune failed'),
  );
  return 'accepted';
}

/**
 * Keeps one project's reports to its newest `cap`, by `pruneProjectQueryLog`'s construction: the cut-off is
 * the `created_at` of the `cap`-th newest row and everything strictly older goes, so a tie is kept rather
 * than cut at random.
 */
export async function pruneProjectReportedGaps(db: Db, projectId: string, cap: number = REPORT_GAP_PROJECT_ROW_CAP): Promise<number> {
  const [cutoff] = await db
    .select({ createdAt: reportedGaps.createdAt })
    .from(reportedGaps)
    .where(eq(reportedGaps.projectId, projectId))
    .orderBy(desc(reportedGaps.createdAt))
    .offset(Math.max(0, cap - 1))
    .limit(1);
  if (!cutoff) return 0;
  const deleted = await db
    .delete(reportedGaps)
    .where(and(eq(reportedGaps.projectId, projectId), lt(reportedGaps.createdAt, cutoff.createdAt)))
    .returning({ id: reportedGaps.id });
  return deleted.length;
}

/**
 * Deletes every report older than `retentionDays`, across every project. `SEARCH_QUERY_LOG_RETENTION_DAYS`
 * is the window, as it is for the queries: the same promise on the privacy page covers both. `now()` is the
 * database's, as in `sweepQueryLog`.
 *
 * The reaper runs this **before** its `SEARCH_QUERY_LOG` early return: switching the log off must not stop
 * the forgetting of what it collected (ADR-0125, decision 3).
 */
export async function sweepReportedGaps(db: Db, retentionDays: number): Promise<number> {
  const deleted = await db
    .delete(reportedGaps)
    .where(sql`${reportedGaps.createdAt} < now() - make_interval(days => ${retentionDays})`)
    .returning({ id: reportedGaps.id });
  return deleted.length;
}

/** Throws away one project's reports now, as `purgeProjectQueryLog` does its queries. */
export async function purgeProjectReportedGaps(db: Db, projectId: string): Promise<number> {
  const deleted = await db.delete(reportedGaps).where(eq(reportedGaps.projectId, projectId)).returning({ id: reportedGaps.id });
  return deleted.length;
}
