import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { type QueryActor, searchQueries, type SearchQueryHitInsert, type SearchQueryInsert, searchQueryHits } from '../db/schema.js';

/**
 * What agents asked, and what they got ([ADR-0047](../../.ssot/ADR.md#adr-0047)) — the write side.
 *
 * [ADR-0042](../../.ssot/ADR.md#adr-0042) measured that the relevance floor provably cannot tell a
 * question the corpus *cannot* answer from one it can: absent-feature questions score inside the band
 * of questions that are answered, and [ADR-0045](../../.ssot/ADR.md#adr-0045) reproduced that from the
 * repository and weakened it further. So "your documentation does not cover this" is not a statement
 * any single search can make. **Repetition over real traffic can make it**, and this table is the only
 * instrument that sees repetition.
 *
 * Three properties of this file are the whole design, and each of them is easy to undo by accident.
 *
 * **A search never waits for the log and never fails because of it.** `record()` is synchronous, takes
 * no promise back and cannot throw: it puts a row in a bounded in-memory buffer and returns. The
 * database write happens afterwards, on a drain the caller is not attached to.
 *
 * **A full buffer drops, and counts what it dropped.** Not back-pressure, not an unbounded array, not
 * a blocked search. A product whose searches get slower because the log is busy is worse than one that
 * loses log rows — and a drop that nobody counts is an analysis that silently under-reports, so the
 * counter is part of the contract rather than a diagnostic afterthought.
 *
 * **It is off unless a caller passes it.** `SearchDeps.queryLog` is optional and unset means off, which
 * is the convention `services/search.ts` already documents for `scan`, `selection` and `scoreFloor`.
 * That is why `npm run eval` records nothing without anybody having to remember: the harness passes no
 * sink, so there is nothing to remember.
 */

/** Rows held in memory at once before `record()` starts dropping. See the class doc for why it drops. */
export const QUERY_LOG_BUFFER_CAPACITY = 500;

/** How many rows one project keeps, pruned after a drain, whatever the retention window says. */
export const QUERY_LOG_PROJECT_ROW_CAP = 20_000;

/** Rows written per statement. One insert of a hundred rows rather than a hundred inserts. */
const DRAIN_BATCH = 100;

/** `search_docs` bounds the query at 2 000 characters; this is the same bound, restated at the writer. */
const MAX_QUERY_CHARS = 2_000;

/** One excerpt of a logged answer, in the order the caller received it. */
export interface QueryLogHit {
  relativePath: string;
  headingPath: string;
  chunkIndex: number;
  score: number;
}

/**
 * One search that actually ran, as the search path knows it.
 *
 * It carries no actor and no token id: `searchProject` cannot know who is asking, and a field it had
 * to be handed would be a field every caller could get wrong. `QueryLog.for()` below binds those once,
 * where they are known.
 */
export interface QueryLogEntry {
  projectId: string;
  query: string;
  limit: number;
  source?: string;
  pathPrefix?: string;
  /** The `version` filter, resolved as the search resolved it ([ADR-0058](../../.ssot/ADR.md#adr-0058)). */
  version?: string;
  hits: QueryLogHit[];
  belowFloor: boolean;
  durationMs: number;
  /** The provider-qualified id of the encoder that answered, and the generation it answered from. */
  embeddingModel: string;
  liveGeneration: number;
}

/**
 * What `services/search.ts` holds. Deliberately one method returning nothing: a sink that could be
 * awaited is a sink somebody will await, and then a search waits for the log.
 */
export interface QueryLogSink {
  record(entry: QueryLogEntry): void;
}

/** What `stats()` reports, and what an operator would want on a dashboard panel one day. */
export interface QueryLogStats {
  /** Rows accepted into the buffer since start. */
  accepted: number;
  /** Rows written to the database since start. */
  written: number;
  /** Rows refused because the buffer was full. **The number that must never be inferred.** */
  dropped: number;
  /** Rows lost to a failed write. Separate from `dropped`: one is capacity, the other is the database. */
  failed: number;
  /** Rows waiting in memory right now. */
  pending: number;
}

/**
 * Folds two spellings of one question together, so that "asked 41 times this week" counts the asking
 * and not the typing: NFKC, lowercased, whitespace collapsed, trimmed.
 *
 * It is deliberately shallow. Stemming, stop-word removal and punctuation stripping would each make
 * the grouping tighter and each make it a second retrieval opinion living outside
 * [ADR-0041](../../.ssot/ADR.md#adr-0041)'s text search configuration — and the raw text is stored
 * beside it, so anything cleverer can be computed later from data that is still there.
 */
export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Pure: one entry and its actor become the row and the hit rows that are written together. */
export function buildQueryLogRows(
  entry: QueryLogEntry,
  actor: QueryActor,
  mcpTokenId: string | null,
): { query: SearchQueryInsert; hits: Omit<SearchQueryHitInsert, 'queryId'>[] } {
  const query = entry.query.slice(0, MAX_QUERY_CHARS);
  return {
    query: {
      projectId: entry.projectId,
      actor,
      mcpTokenId,
      query,
      queryNorm: normalizeQuery(query),
      resultLimit: entry.limit,
      filterSource: entry.source ?? null,
      filterPathPrefix: entry.pathPrefix ?? null,
      filterVersion: entry.version ?? null,
      hitCount: entry.hits.length,
      // NULL and not 0 when nothing came back: 0 is a similarity a hit could genuinely have, and an
      // average over a column where "no answer" reads as 0 is an average of two different things.
      topScore: entry.hits.length > 0 ? entry.hits[0].score : null,
      belowFloor: entry.belowFloor,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      embeddingModel: entry.embeddingModel,
      liveGeneration: entry.liveGeneration,
    },
    hits: entry.hits.map((hit, i) => ({
      rank: i + 1,
      relativePath: hit.relativePath,
      headingPath: hit.headingPath,
      chunkIndex: hit.chunkIndex,
      score: hit.score,
    })),
  };
}

interface BufferedRow {
  query: SearchQueryInsert;
  hits: Omit<SearchQueryHitInsert, 'queryId'>[];
}

export interface QueryLogOptions {
  capacity?: number;
  projectRowCap?: number;
}

/**
 * The buffered writer. One per process, built in `server.ts` when `SEARCH_QUERY_LOG` allows it and
 * never built at all when it does not — which is how the instance-wide kill switch works: there is no
 * sink to pass, so `SearchDeps.queryLog` is unset, so nothing is recorded.
 */
export class QueryLog {
  private readonly buffer: BufferedRow[] = [];
  private readonly capacity: number;
  private readonly projectRowCap: number;
  private draining = false;
  private closed = false;
  private drain: Promise<void> = Promise.resolve();
  private accepted = 0;
  private written = 0;
  private dropped = 0;
  private failed = 0;
  /** Logged once rather than per drop: a saturated buffer produces drops by the thousand. */
  private warnedAboutDrops = false;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    options: QueryLogOptions = {},
  ) {
    this.capacity = options.capacity ?? QUERY_LOG_BUFFER_CAPACITY;
    this.projectRowCap = options.projectRowCap ?? QUERY_LOG_PROJECT_ROW_CAP;
  }

  /**
   * A sink bound to one actor and, for an MCP session, to the token it presented. The buffer is
   * shared; only the two fields `searchProject` cannot know are closed over here.
   */
  for(actor: QueryActor, mcpTokenId: string | null = null): QueryLogSink {
    return {
      record: (entry: QueryLogEntry) => {
        this.push(buildQueryLogRows(entry, actor, mcpTokenId));
      },
    };
  }

  stats(): QueryLogStats {
    return { accepted: this.accepted, written: this.written, dropped: this.dropped, failed: this.failed, pending: this.buffer.length };
  }

  /** Waits for what is buffered to reach the database. For tests and for shutdown — never for a search. */
  async flush(): Promise<void> {
    this.schedule();
    await this.drain;
    // A drain that started while the previous one was finishing leaves rows behind it; one more pass
    // is enough, because `record()` is not being called from inside `flush()`.
    if (this.buffer.length > 0) {
      this.schedule();
      await this.drain;
    }
  }

  /** Stops accepting rows and writes what is already buffered. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private push(row: BufferedRow): void {
    if (this.closed) return;
    if (this.buffer.length >= this.capacity) {
      this.dropped++;
      if (!this.warnedAboutDrops) {
        this.warnedAboutDrops = true;
        this.log.warn({ capacity: this.capacity }, 'query log buffer is full; queries are being recorded incompletely — searches are unaffected');
      }
      return;
    }
    this.buffer.push(row);
    this.accepted++;
    this.schedule();
  }

  /**
   * Starts a drain if one is not already running. **Nothing awaits this**, and that is the point: the
   * returned promise is held on `this.drain` so `flush()` can wait for it, and the caller of
   * `record()` never sees it.
   *
   * On a microtask rather than inline, which is not a detail: an async function runs its body up to
   * the first `await` synchronously, so a drain started here would take its first batch out of the
   * buffer *inside* `record()` and the capacity would quietly become "capacity, plus a batch". Deferred
   * by one turn, `record()` is exactly "push or drop" and the capacity is a bound a test can state as a
   * number.
   */
  private schedule(): void {
    if (this.draining || this.buffer.length === 0) return;
    this.draining = true;
    this.drain = Promise.resolve()
      .then(() => this.runDrain())
      .finally(() => {
        this.draining = false;
      });
  }

  private async runDrain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, DRAIN_BATCH);
      try {
        await this.writeBatch(batch);
        this.written += batch.length;
      } catch (err) {
        this.failed += batch.length;
        // Dropped on the floor rather than re-queued: a database that refuses this write will refuse
        // the retry too, and a retry loop is how a log outage becomes an outage.
        this.log.warn({ err, rows: batch.length }, 'query log write failed; those rows are lost');
      }
    }
  }

  private async writeBatch(batch: BufferedRow[]): Promise<void> {
    // One transaction for the batch: a query row without its hits would be a row that says "five
    // results" beside nothing, which reads as a retrieval failure that never happened.
    const projectIds = await this.db.transaction(async (tx) => {
      const ids = await tx
        .insert(searchQueries)
        .values(batch.map((row) => row.query))
        .returning({ id: searchQueries.id });
      const hits: SearchQueryHitInsert[] = [];
      for (const [i, row] of batch.entries()) {
        for (const hit of row.hits) hits.push({ ...hit, queryId: ids[i].id });
      }
      if (hits.length > 0) await tx.insert(searchQueryHits).values(hits);
      return new Set(batch.map((row) => row.query.projectId));
    });

    for (const projectId of projectIds) {
      await pruneProjectQueryLog(this.db, projectId, this.projectRowCap).catch((err: unknown) =>
        this.log.warn({ err, projectId }, 'query log row cap prune failed'),
      );
    }
  }
}

/**
 * Keeps one project's log to its most recent `cap` rows, exactly as `recordIndexRun` keeps
 * `index_runs` to twenty — **with one difference that matters at this scale.** That function selects
 * the twenty ids to keep and deletes everything not in the list; twenty ids fit in a statement and
 * twenty thousand do not. So the cut-off is a timestamp: the `created_at` of the oldest row worth
 * keeping — the `cap`-th most recent, which is `OFFSET cap - 1` — found by the
 * `(project_id, created_at DESC)` index, and everything strictly older than it goes.
 *
 * Rows sharing that exact timestamp all survive, so the cap is a bound that can be exceeded by a tie.
 * That is the right way round: cutting a tie would delete one row of a batch and keep another for no
 * reason anybody could state, and `created_at` is a transaction timestamp, so a tie means "written
 * together".
 */
export async function pruneProjectQueryLog(db: Db, projectId: string, cap: number = QUERY_LOG_PROJECT_ROW_CAP): Promise<number> {
  const [cutoff] = await db
    .select({ createdAt: searchQueries.createdAt })
    .from(searchQueries)
    .where(eq(searchQueries.projectId, projectId))
    .orderBy(desc(searchQueries.createdAt))
    .offset(Math.max(0, cap - 1))
    .limit(1);
  if (!cutoff) return 0;
  const deleted = await db
    .delete(searchQueries)
    .where(and(eq(searchQueries.projectId, projectId), lt(searchQueries.createdAt, cutoff.createdAt)))
    .returning({ id: searchQueries.id });
  return deleted.length;
}

/**
 * Deletes every logged query older than `retentionDays`, across every project. The hits go with them
 * through `search_query_hits_query_id_fkey`'s cascade rather than through a second statement here.
 *
 * `now()` is the database's, not the process's, for the reason `user_sessions`' two deadlines are
 * compared in SQL: a clock skew between the application and the database must not be able to lengthen
 * or shorten a retention window somebody put in a privacy policy.
 */
export async function sweepQueryLog(db: Db, retentionDays: number): Promise<number> {
  const deleted = await db
    .delete(searchQueries)
    .where(sql`${searchQueries.createdAt} < now() - make_interval(days => ${retentionDays})`)
    .returning({ id: searchQueries.id });
  return deleted.length;
}
