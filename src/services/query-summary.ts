import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, searchQueries } from '../db/schema.js';
import { RRF_K } from './rrf.js';

/**
 * The read side of the query log ([ADR-0050](../../.ssot/ADR.md#adr-0050)) — four figures over the two
 * tables [ADR-0047](../../.ssot/ADR.md#adr-0047) filled, and the export that turns them into a
 * question set an operator can run against their own corpus.
 *
 * **The one thing this file must not do is classify.** [ADR-0042](../../.ssot/ADR.md#adr-0042)
 * measured that a question shaped exactly like the product whose answer is absent scores *inside* the
 * band of questions that are answered, and [ADR-0045](../../.ssot/ADR.md#adr-0045) re-measured that
 * against an independently written set and took away even the off-domain separation. So no threshold
 * on `top_score` can say "the documentation does not cover this", and `below_floor` — the column that
 * looks like it means exactly that — reports the questions that were not about this documentation
 * while missing every question the documentation failed.
 *
 * What is left is **repetition at a passing score**, and repetition is an ordering rather than a
 * verdict. `repeatedQuestions` therefore ranks and never filters: it fuses "asked many times" with
 * "the best match never rose far" the way this product already fuses two rankings — reciprocal rank
 * fusion, `services/rrf.ts`, the same `k` — and hands the operator the count and the score instead of
 * a label. There is no minimum count, no score cut-off and no `HAVING`; see ADR-0050 for why the
 * `HAVING count(*) >= 3` of [OPERATIONS.md](../../.ssot/OPERATIONS.md) §6.1 was not carried over.
 *
 * **Every figure is scoped to one `embedding_model` and one `live_generation`**, which is what those
 * two columns are on every row for. A week that spans a model change averaged into one number is the
 * confusion this whole item was written about, so the scope is a parameter and never a default that
 * quietly spans two retrieval configurations.
 */

/** How many days back the panel will look. A window beyond retention returns what retention left. */
export const MAX_SUMMARY_DAYS = 90;
export const DEFAULT_SUMMARY_DAYS = 7;

/** Rows per figure. A page size, deliberately not a cut-off: it changes no ordering. */
export const MAX_SUMMARY_ROWS = 100;
export const DEFAULT_SUMMARY_ROWS = 20;

/** Questions in one export. The same page size, applied to the same ordering. */
export const MAX_EXPORT_ROWS = 500;
export const DEFAULT_EXPORT_ROWS = 100;

/** How many of the documents a question actually returned are named beside it. */
const PATHS_PER_QUESTION = 3;

/**
 * Whose searches. `mcp` is the default everywhere, because `dashboard` rows are the operator's own
 * typing and an analysis that averaged the two is an operator reading themselves back
 * ([OPERATIONS.md](../../.ssot/OPERATIONS.md) §6.1 says the same thing to somebody holding `psql`).
 */
export type SummaryActor = 'mcp' | 'dashboard' | 'all';

/** One retrieval configuration the window contains, and how much of the window it is. */
export interface QueryConfiguration {
  embeddingModel: string;
  liveGeneration: number;
  queries: number;
  firstAt: string;
  lastAt: string;
}

export interface SummaryScope {
  projectId: string;
  from: Date;
  to: Date;
  actor: SummaryActor;
  embeddingModel: string;
  liveGeneration: number;
}

/** One document a question returned, and how often it returned it. */
export interface QuestionPath {
  relativePath: string;
  headingPath: string;
  bestScore: number;
  returned: number;
}

export interface RepeatedQuestion {
  queryNorm: string;
  /** The most recent raw spelling of the question — a real thing somebody typed, not the fold. */
  sample: string;
  asked: number;
  /** Distinct MCP tokens behind those askings. `0` on an `open` project, which verifies none. */
  askers: number;
  /** Askings with no token at all: an `open` project, or a dashboard search. */
  unattributed: number;
  /** Distinct UTC days it was asked on — one agent in a loop is one day, forty agents are not. */
  days: number;
  /** The best the corpus ever did on it. `null` when no asking returned anything at all. */
  bestScore: number | null;
  everRefused: boolean;
  firstAskedAt: string;
  lastAskedAt: string;
  /** 1 = asked more often than anything else in the window. */
  askedRank: number;
  /** 1 = the best match rose least far. A question that returned nothing ranks 1. */
  scoreRank: number;
  /** The two ranks fused. Ordering only — it is not a quantity of anything. */
  gapScore: number;
  paths: QuestionPath[];
}

export interface NeverReturnedDocument {
  relativePath: string;
  title: string;
  indexedAt: string;
  /**
   * Searches that ran **while this document was in the index** and did not return it.
   *
   * The whole of the new-document trap is here: a document added yesterday has not been returned
   * because it did not exist, so the figure is never "not returned in seven days" but "not returned by
   * any of these N searches", with N counted from the moment this document entered the live
   * generation. A document indexed an hour ago reads `0 of 3` and is visibly not a failure.
   */
  searchesSince: number;
}

export interface NeverReturned {
  /** Documents in the configuration's generation. `0` means the generation has been superseded. */
  documentsInGeneration: number;
  rows: NeverReturnedDocument[];
}

export interface ReturnedChunk {
  relativePath: string;
  headingPath: string;
  chunkIndex: number;
  returned: number;
  bestRank: number;
  avgScore: number;
}

export interface VolumeBucket {
  /** `YYYY-MM-DD`, UTC. Present even for a day with no searches, so a gap reads as a gap. */
  day: string;
  searches: number;
  empty: number;
  refused: number;
  avgTopScore: number | null;
}

// ---------- the ordering, as a specification ----------

/**
 * The ordering `repeatedQuestions` is held to, with no database in it.
 *
 * Two rankings — most asked, and worst best-match — fused by reciprocal rank fusion at the same `k`
 * the search path uses ([ADR-0041](../../.ssot/ADR.md#adr-0041)). RRF is the right instrument for
 * exactly the reason a threshold is the wrong one: it never asks what a score *means*, only where a
 * group sits relative to the others, so it converts nothing and cuts nothing off. "Asked 41 times,
 * best match 0.84" outranks both "asked once, best 0.31" and "asked 41 times, best 0.91" without
 * anybody choosing a number that ADR-0045 would refute.
 *
 * `bestScore: null` — no asking returned anything — is the extreme of "the best match never rose far"
 * and ranks first on that list, not last.
 *
 * `test/query-summary.test.ts` asserts this arithmetic without a container;
 * `test/integration/query-summary.itest.ts` asserts that PostgreSQL produces the same ordering for
 * the same groups. This function is the specification and not a second implementation: nothing in the
 * request path calls it.
 */
export function rankQuestionsByGap<T extends { queryNorm: string; asked: number; bestScore: number | null }>(
  groups: readonly T[],
): (T & { askedRank: number; scoreRank: number; gapScore: number })[] {
  const askedRank = denseCompetitionRank(groups, (a, b) => b.asked - a.asked);
  // NULLs first: "nothing came back" is the worst best-match there is, and reading it as 0 would put
  // it in the middle of a cosine band that can legitimately contain 0.
  const scoreRank = denseCompetitionRank(groups, (a, b) => scoreKey(a.bestScore) - scoreKey(b.bestScore));
  return groups
    .map((row) => {
      const ar = askedRank.get(row.queryNorm) ?? 1;
      const sr = scoreRank.get(row.queryNorm) ?? 1;
      return { ...row, askedRank: ar, scoreRank: sr, gapScore: 1 / (RRF_K + ar) + 1 / (RRF_K + sr) };
    })
    .sort((a, b) => b.gapScore - a.gapScore || b.asked - a.asked || a.queryNorm.localeCompare(b.queryNorm));
}

const scoreKey = (score: number | null): number => (score === null ? Number.NEGATIVE_INFINITY : score);

/** PostgreSQL's `rank()`: ties share the lower rank and the next value skips, so 1, 1, 3. */
function denseCompetitionRank<T extends { queryNorm: string }>(rows: readonly T[], compare: (a: T, b: T) => number): Map<string, number> {
  const sorted = [...rows].sort(compare);
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const [i, row] of sorted.entries()) {
    if (i === 0 || compare(sorted[i - 1], row) !== 0) rank = i + 1;
    ranks.set(row.queryNorm, rank);
  }
  return ranks;
}

// ---------- the figures ----------

/** `actor = 'mcp'`, or nothing at all for `all`. Spelled once; every figure below takes it. */
const actorFilter = (actor: SummaryActor) => (actor === 'all' ? sql`` : sql` and q.actor = ${actor}`);

/** The window and the one retrieval configuration, on `search_queries q`. Every figure carries it. */
const scopeFilter = (scope: SummaryScope) =>
  sql`q.project_id = ${scope.projectId}
      and q.created_at >= ${scope.from.toISOString()}::timestamptz
      and q.created_at < ${scope.to.toISOString()}::timestamptz
      and q.embedding_model = ${scope.embeddingModel}
      and q.live_generation = ${scope.liveGeneration}${actorFilter(scope.actor)}`;

interface ConfigurationRow extends Record<string, unknown> {
  embedding_model: string;
  live_generation: number;
  queries: number;
  first_at: Date;
  last_at: Date;
}

/**
 * Every retrieval configuration the window holds, biggest first.
 *
 * This is [OPERATIONS.md](../../.ssot/OPERATIONS.md) §6.1's second query, and it is what makes the
 * other three honest: the panel names the configuration its figures describe and says how many
 * searches in the window are outside it, rather than implying the numbers are timeless.
 */
export async function listQueryConfigurations(db: Db, projectId: string, from: Date, to: Date, actor: SummaryActor): Promise<QueryConfiguration[]> {
  const result = await db.execute<ConfigurationRow>(sql`
    select q.embedding_model, q.live_generation, count(*)::int as queries,
           min(q.created_at) as first_at, max(q.created_at) as last_at
    from search_queries q
    where q.project_id = ${projectId}
      and q.created_at >= ${from.toISOString()}::timestamptz
      and q.created_at < ${to.toISOString()}::timestamptz${actorFilter(actor)}
    group by 1, 2
    order by queries desc, last_at desc`);
  return result.rows.map((row) => ({
    embeddingModel: row.embedding_model,
    liveGeneration: row.live_generation,
    queries: row.queries,
    firstAt: new Date(row.first_at).toISOString(),
    lastAt: new Date(row.last_at).toISOString(),
  }));
}

interface QuestionRow extends Record<string, unknown> {
  query_norm: string;
  sample: string;
  asked: number;
  askers: number;
  unattributed: number;
  days: number;
  best_score: number | null;
  ever_refused: boolean;
  first_asked_at: Date;
  last_asked_at: Date;
  asked_rank: number;
  score_rank: number;
  gap_score: number;
}

/**
 * The questions worth a documentation team's attention, ranked and not classified.
 *
 * **Grouped on `query_norm` and on nothing cleverer.** Clustering near-duplicates needs a similarity
 * threshold nobody here has the data to choose, and a panel that silently merges two questions the
 * operator considers different is worse than one that lists them twice: two identical-looking lines
 * are visibly one question, where one line that is secretly two is invisible.
 */
export async function repeatedQuestions(db: Db, scope: SummaryScope, limit: number): Promise<RepeatedQuestion[]> {
  const result = await db.execute<QuestionRow>(sql`
    with grouped as (
      select
        q.query_norm,
        count(*)::int as asked,
        count(distinct q.mcp_token_id)::int as askers,
        count(*) filter (where q.mcp_token_id is null)::int as unattributed,
        count(distinct (q.created_at at time zone 'UTC')::date)::int as days,
        -- The best this corpus ever did on the question, over every asking. NULL only when no asking
        -- returned anything at all, which is worse than any score and is ordered as such below.
        max(q.top_score) as best_score,
        bool_or(q.below_floor) as ever_refused,
        min(q.created_at) as first_asked_at,
        max(q.created_at) as last_asked_at,
        -- A real spelling of it, the most recent, rather than the normalised fold.
        (array_agg(q.query order by q.created_at desc))[1] as sample
      from search_queries q
      where ${scopeFilter(scope)}
      group by q.query_norm
    ),
    ranked as (
      select grouped.*,
        rank() over (order by asked desc) as asked_rank,
        -- NULLS FIRST: "nothing came back" is the extreme of "the best match never rose far", and
        -- reading it as 0 would drop it into the middle of a band that can legitimately contain 0.
        rank() over (order by best_score asc nulls first) as score_rank
      from grouped
    )
    select ranked.*,
      -- Reciprocal rank fusion at the search path's own k (ADR-0041): two orderings become one
      -- without either being converted into the other's units, which is what a threshold would be.
      (1.0 / (${RRF_K} + asked_rank) + 1.0 / (${RRF_K} + score_rank))::float8 as gap_score
    from ranked
    order by gap_score desc, asked desc, query_norm asc
    limit ${limit}`);

  const rows = result.rows;
  if (rows.length === 0) return [];
  const paths = await questionPaths(
    db,
    scope,
    rows.map((row) => row.query_norm),
  );
  return rows.map((row) => ({
    queryNorm: row.query_norm,
    sample: row.sample,
    asked: row.asked,
    askers: row.askers,
    unattributed: row.unattributed,
    days: row.days,
    bestScore: row.best_score === null ? null : Number(row.best_score),
    everRefused: row.ever_refused,
    firstAskedAt: new Date(row.first_asked_at).toISOString(),
    lastAskedAt: new Date(row.last_asked_at).toISOString(),
    askedRank: Number(row.asked_rank),
    scoreRank: Number(row.score_rank),
    gapScore: Number(row.gap_score),
    paths: paths.get(row.query_norm) ?? [],
  }));
}

interface PathRow extends Record<string, unknown> {
  query_norm: string;
  relative_path: string;
  heading_path: string;
  best_score: number;
  returned: number;
}

/**
 * What each of those questions actually *did* return, best first.
 *
 * It is what makes the panel readable — "asked 41 times, never above 0.84, and what it kept handing
 * back was the OIDC page" is a sentence an operator can act on — and it is also the whole content of
 * the export's `note`, which is how an exported question carries the choices a human picks from.
 */
async function questionPaths(db: Db, scope: SummaryScope, norms: readonly string[]): Promise<Map<string, QuestionPath[]>> {
  const result = await db.execute<PathRow>(sql`
    select query_norm, relative_path, heading_path, best_score, returned
    from (
      select q.query_norm, h.relative_path,
             (array_agg(h.heading_path order by h.score desc))[1] as heading_path,
             max(h.score)::float8 as best_score,
             count(*)::int as returned,
             row_number() over (partition by q.query_norm order by count(*) desc, max(h.score) desc, h.relative_path asc) as per_question
      from search_query_hits h
      join search_queries q on q.id = h.query_id
      where ${scopeFilter(scope)}
        and q.query_norm in ${norms}
      group by q.query_norm, h.relative_path
    ) ranked
    where per_question <= ${PATHS_PER_QUESTION}
    order by query_norm, per_question`);

  const byNorm = new Map<string, QuestionPath[]>();
  for (const row of result.rows) {
    const list = byNorm.get(row.query_norm) ?? [];
    list.push({
      relativePath: row.relative_path,
      headingPath: row.heading_path,
      bestScore: Number(row.best_score),
      returned: row.returned,
    });
    byNorm.set(row.query_norm, list);
  }
  return byNorm;
}

interface NeverReturnedRow extends Record<string, unknown> {
  relative_path: string;
  title: string;
  indexed_at: Date;
  searches_since: number;
}

/**
 * Documents nothing ever returned — and the count that keeps a new document from reading as a failure.
 *
 * Two things make this figure honest rather than alarming. Its subject is the configuration's own
 * generation, so a document is compared against the searches that ran over *it*; and the window each
 * document is judged over starts at the later of the panel's window and the document's own
 * `indexed_at`, so a page added an hour ago is reported as "not returned by any of the 3 searches
 * since it was indexed" rather than as a page nobody wants.
 *
 * `documentsInGeneration` is `0` when the chosen configuration's generation has been swept
 * ([ADR-0039](../../.ssot/ADR.md#adr-0039)) — its documents are gone, so "never returned" is not a
 * question that can be asked of it, and an empty list must not be read as "everything was returned".
 */
export async function neverReturnedDocuments(db: Db, scope: SummaryScope, limit: number): Promise<NeverReturned> {
  const counted = await db.execute<{ documents: number }>(sql`
    select count(*)::int as documents from documents
    where project_id = ${scope.projectId} and index_generation = ${scope.liveGeneration}`);
  // `?? 0` rather than a destructure: an aggregate always returns its one row, and a figure that threw
  // when it did not would take the whole panel down over the emptiest possible project.
  const documentsInGeneration = counted.rows[0]?.documents ?? 0;
  if (documentsInGeneration === 0) return { documentsInGeneration: 0, rows: [] };

  const result = await db.execute<NeverReturnedRow>(sql`
    select d.relative_path, d.title, d.indexed_at,
      (select count(*)::int from search_queries q
        where ${scopeFilter(scope)} and q.created_at >= d.indexed_at) as searches_since
    from documents d
    where d.project_id = ${scope.projectId} and d.index_generation = ${scope.liveGeneration}
      and not exists (
        select 1 from search_query_hits h
        join search_queries q on q.id = h.query_id
        where ${scopeFilter(scope)}
          and q.created_at >= d.indexed_at
          and h.relative_path = d.relative_path)
    -- The most missed opportunities first: a document nothing returned across 400 searches is a
    -- different fact from one nothing returned across 3, and only the ordering says which is which.
    order by searches_since desc, d.relative_path asc
    limit ${limit}`);

  return {
    documentsInGeneration,
    rows: result.rows.map((row) => ({
      relativePath: row.relative_path,
      title: row.title,
      indexedAt: new Date(row.indexed_at).toISOString(),
      searchesSince: row.searches_since,
    })),
  };
}

interface ChunkRow extends Record<string, unknown> {
  relative_path: string;
  heading_path: string;
  chunk_index: number;
  returned: number;
  best_rank: number;
  avg_score: number;
}

/** The excerpts agents are actually being handed, most-returned first. */
export async function mostReturnedChunks(db: Db, scope: SummaryScope, limit: number): Promise<ReturnedChunk[]> {
  const result = await db.execute<ChunkRow>(sql`
    select h.relative_path, h.heading_path, h.chunk_index,
           count(*)::int as returned, min(h.rank)::int as best_rank, avg(h.score)::float8 as avg_score
    from search_query_hits h
    join search_queries q on q.id = h.query_id
    where ${scopeFilter(scope)}
    group by h.relative_path, h.heading_path, h.chunk_index
    order by returned desc, avg_score desc, h.relative_path asc, h.chunk_index asc
    limit ${limit}`);
  return result.rows.map((row) => ({
    relativePath: row.relative_path,
    headingPath: row.heading_path,
    chunkIndex: row.chunk_index,
    returned: row.returned,
    bestRank: row.best_rank,
    avgScore: Number(row.avg_score),
  }));
}

interface VolumeRow extends Record<string, unknown> {
  day: string;
  searches: number;
  empty: number;
  refused: number;
  avg_top_score: number | null;
}

/**
 * Searches per UTC day across the window, including the days nothing was asked.
 *
 * `generate_series` rather than the rows' own days, because a week with two silent days is a different
 * week from a five-day one and a chart drawn from present rows only cannot tell them apart.
 */
export async function volumeOverTime(db: Db, scope: SummaryScope): Promise<VolumeBucket[]> {
  const result = await db.execute<VolumeRow>(sql`
    with days as (
      select generate_series(
        (${scope.from.toISOString()}::timestamptz at time zone 'UTC')::date,
        (${scope.to.toISOString()}::timestamptz at time zone 'UTC')::date,
        interval '1 day')::date as day
    )
    select to_char(days.day, 'YYYY-MM-DD') as day,
      -- count(q.id) and not count(*): a day with no searches still has its generate_series row, and
      -- count(*) would report every empty day as one search.
      count(q.id)::int as searches,
      count(q.id) filter (where q.hit_count = 0)::int as empty,
      count(q.id) filter (where q.below_floor)::int as refused,
      avg(q.top_score)::float8 as avg_top_score
    from days
    left join search_queries q
      on (q.created_at at time zone 'UTC')::date = days.day and ${scopeFilter(scope)}
    group by days.day
    order by days.day`);
  return result.rows.map((row) => ({
    day: row.day,
    searches: row.searches,
    empty: row.empty,
    refused: row.refused,
    avgTopScore: row.avg_top_score === null ? null : Number(row.avg_top_score),
  }));
}

// ---------- the switch, and the purge ----------

export async function setQueryLogEnabled(db: Db, projectId: string, enabled: boolean): Promise<boolean> {
  const [row] = await db
    .update(projects)
    .set({ queryLogEnabled: enabled })
    .where(eq(projects.id, projectId))
    .returning({ enabled: projects.queryLogEnabled });
  return row?.enabled ?? enabled;
}

/**
 * Throws away one project's log now, rather than waiting for retention.
 *
 * The hits go with the rows through `search_query_hits_query_id_fkey`'s cascade. It reaches nothing
 * that is already in a `pg_dump` ([OPERATIONS.md](../../.ssot/OPERATIONS.md) §4.8), which is why the
 * route that calls this says so and the runbook says it twice.
 */
export async function purgeProjectQueryLog(db: Db, projectId: string): Promise<number> {
  const deleted = await db.delete(searchQueries).where(eq(searchQueries.projectId, projectId)).returning({ id: searchQueries.id });
  return deleted.length;
}

/** How far back the log actually reaches for this project, whatever window somebody asked for. */
export async function oldestLoggedQuery(db: Db, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdAt: sql<Date | null>`min(${searchQueries.createdAt})` })
    .from(searchQueries)
    .where(and(eq(searchQueries.projectId, projectId)));
  return row?.createdAt ? new Date(row.createdAt).toISOString() : null;
}
