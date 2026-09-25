import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { documentSources, documents, projects } from '../../src/db/schema.js';
import { createProjectVectorIndex, PROJECT_VECTOR_INDEX_PREFIX, projectVectorIndexName } from '../../src/db/vector-indexes.js';
import { DENSE_CANDIDATES, MAX_SEARCH_LIMIT } from '../../src/config.js';
import { DEFAULT_HNSW_SCAN, type HnswScan, searchChunks } from '../../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  requirePgvectorAtLeast,
  TEST_EMBEDDING_DIMENSIONS,
  type TestDatabase,
} from './support/postgres.js';

/**
 * The scale case [ADR-0040](../../../.ssot/ADR.md#adr-0040) exists for, and the only way to observe it:
 * six projects on one instance, and the ones that do not dominate it asked about themselves.
 *
 * **What this file asserts changed with ROADMAP Item 16.** It was written against one global HNSW
 * index, and everything below this paragraph up to the corpus describes that index's defect as it was
 * measured. Every project now has its own partial index (`src/db/vector-indexes.ts`), so the cases that
 * used to prove the crowded project *starves* now prove it does not: the same corpus, the same forced
 * plans, the same directions, and a full page from the project's own graph where the shared one had
 * nothing. The corpus is unchanged on purpose — it is still the shape that broke the shared index, and
 * `scripts/hnsw-tenancy.ts` measures that shape at ten times this size, the old index included.
 *
 * pgvector post-filters. The index yields roughly `hnsw.ef_search` candidates ordered by distance and
 * `WHERE project_id = … AND index_generation = …` then removes the ones that do not match — so a
 * project whose rows begin two and a half thousand places down the global ordering is answered with
 * **nothing**, while its own best chunks sit unreturned. That is not a failure a result set reveals:
 * what comes back looks like an honest top-k that happened to find little.
 *
 * **The corpus is the test, and one number in it was measured rather than chosen.** The obvious shape —
 * a 50-chunk project drowning in 20 000 — does not reproduce the defect at all, because PostgreSQL
 * never picks the HNSW index for it: 50 rows are cheaper to fetch by `chunks_project_idx` and sort
 * exactly than to approach through a vector index, and the planner says so. The post-filter only bites
 * once the project is large enough *in absolute terms* for the vector index to look cheap, which on
 * this instance is somewhere between 500 and 1 000 chunks. Both projects are therefore seeded and both
 * are asserted: the 50-chunk one because a reader will assume it starves and it does not, and the
 * 1 000-chunk one because it is where the bug actually lives.
 *
 * 21 050 chunks of 384 floats take around 30 seconds to insert, which makes this the slowest file in
 * the suite. Shrinking the corpus until that is comfortable would shrink the effect until it is no
 * longer there — the ratio is the point.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

/** Every project here is freshly created, so its live generation is the column's default (ADR-0039). */
const LIVE = 0;

/** What a caller asks for. Every assertion below is about whether it gets that many, and which. */
const K = 10;

/** The two releases every project below is split into; part `a` is the first, part `b` the second. */
const V1 = 'v1';
const V2 = 'v2';

/** Where `small` is cut in two, and therefore the lowest chunk index that belongs to `V2`. */
const SMALL_HALF = 500;

/**
 * Retrieval, not selection. Every assertion in this file is about which rows come back and in what
 * order, over a fixture that is one document per project — so ADR-0042's per-document cap, which is
 * on by default, would hold every page here to two rows and the file would be measuring the cap.
 * Stated explicitly rather than left to the default, which is the same reason the scan settings are.
 */
const WHOLE_PAGE = { maxPerDocument: MAX_SEARCH_LIMIT, neighborContext: 0 };

/** Rows per `INSERT`. Large enough that round trips are not the cost, small enough to stay in memory. */
const INSERT_BATCH = 1_000;

/**
 * Deterministic PRNG (mulberry32). Every vector in this file comes from it, so a failure is
 * reproducible and the corpus is a description rather than a sample.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, so the random directions below are isotropic rather than cube-shaped. */
function gaussianVector(next: () => number): number[] {
  const v = new Array<number>(DIMS);
  for (let i = 0; i < DIMS; i += 2) {
    const u1 = Math.max(next(), Number.EPSILON);
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    v[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < DIMS) v[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return v;
}

function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** The component of `v` orthogonal to the unit vector `axis`, normalised. */
function orthogonalTo(axis: number[], v: number[]): number[] {
  const along = dot(axis, v);
  return normalize(v.map((x, i) => x - along * axis[i]));
}

/** The query direction, and the axis every chunk's similarity is measured against. */
const QUERY = normalize(gaussianVector(rng(1)));

/**
 * The lexical half of the question ([ADR-0041](../../.ssot/ADR.md#adr-0041)), and it deliberately
 * matches nothing. The 21 050 chunks below are seeded with `INSERT … SELECT unnest(…)` rather than
 * through `replaceDocument`, so `content_tsv` is NULL for every one of them — `NULL @@ query` is not
 * true, the lexical candidate list is empty, and every assertion in this file goes on measuring the
 * dense path it was written for. That is the property this file needs and also, separately, the thing
 * a project mid-upgrade experiences.
 */
const QUERY_TEXT = 'a phrase that appears in none of the seeded chunks';

/**
 * Five directions rather than one, for the two cases below that used to be starvation cases.
 *
 * pgvector picks each element's HNSW level pseudo-randomly, and `setseed` on the writing session does
 * not make that reproducible — the graph differs between runs, and so does which rows a given query's
 * hundred candidates contain. Asked of one direction, "iterative scan off starves this project" is a
 * claim about one draw from that graph. Asked of five, it is the claim ADR-0040 actually makes:
 * *approximate search without the iterative scan does not answer this project*, whichever way the
 * graph came out. Under the shared index every one of the five was required to starve; from the
 * project's own index every one of the five is required to come back full, and at the same rows
 * whatever the scan settings — see `forceVectorIndex`, which is what makes either affordable to assert.
 *
 * Only for the page and the settings. The corpus is arranged around `QUERY` — the bands in `CORPUS` are
 * similarities to it — so "the iterative scan makes the answer exact" is asserted for `QUERY` alone,
 * below. Four arbitrary directions into a seeded 21 050-vector space are not a shape this file has any
 * reason to promise anything about.
 */
const PROBE_QUERIES: number[][] = [QUERY, ...Array.from({ length: 4 }, (_, i) => normalize(gaussianVector(rng(900 + i))))];

/**
 * Five directions for the starvation case under the version filter, chosen so that the thing it
 * claims is a property of the corpus rather than of the graph.
 *
 * `PROBE_QUERIES`' four random directions are nearly orthogonal to `QUERY`, and in that space every
 * chunk is roughly as far from the query as every other: the bands in `CORPUS` say nothing about the
 * order there, and a greedy walk through the graph is at its least reliable. Under a filter that
 * rejects half of `small`, that is where the case used to fail — one build in several, one direction
 * came back with a full page, not because the post-filter had stopped biting but because the walk had
 * wandered into `small`'s own cluster and its hundred candidates happened to be that project's rows.
 *
 * These are the same four directions tilted towards `QUERY` (cosine 0.9 with it), so each is a
 * different walk through the graph but every one of them still sees the corpus as it was built: the
 * large projects' upper bands ahead, `small` two thousand rows down. **How far down is measured, not
 * assumed** — the case asserts it for each direction with an index-free count, which is the same on
 * every build because the vectors are, before it asks the index anything.
 */
const CROWDED_TILT = 0.9;
const CROWDED_PROBES: number[][] = [
  QUERY,
  ...Array.from({ length: 4 }, (_, i) => {
    const across = orthogonalTo(QUERY, gaussianVector(rng(900 + i)));
    return normalize(QUERY.map((q, j) => CROWDED_TILT * q + Math.sqrt(1 - CROWDED_TILT ** 2) * across[j]));
  }),
];

/**
 * How far a project's chunks sit from its own centroid. Small on purpose: each project is a cluster,
 * the way a project's documentation is about its own subject. A cloud with no cluster structure is not
 * a harder test of this change, it is a different one — it measures how well HNSW navigates noise.
 */
const CLUSTER_JITTER = 0.2;

/**
 * The corpus, and the whole argument of the file.
 *
 * A chunk is `s·q + √(1−s²)·u` with `u ⟂ q`, so its cosine similarity to the query is **exactly** `s`
 * and the global ordering is a property of these bands rather than of how a random cloud fell. `u` is
 * drawn around a per-project direction, so the projects are genuinely different centroids.
 *
 * The four large projects spread over `[0.30, 0.99]`. The two small ones sit in `[0.85, 0.90]`, which
 * puts roughly 2 600 large-project chunks ahead of their best row — 26 times `ef_search`. Nothing here
 * is marginal: the small projects are not *nearly* missed, they are missed by an order of magnitude.
 */
interface Spec {
  name: string;
  chunks: number;
  band: [number, number];
}

const CORPUS: Spec[] = [
  /** Too small for the planner to reach for the vector index. Answered exactly, and asserted to be. */
  { name: 'tiny', chunks: 50, band: [0.85, 0.9] },
  /** Where the defect lives: large enough that the HNSW scan is chosen, small enough to be crowded out. */
  { name: 'small', chunks: 1_000, band: [0.85, 0.9] },
  { name: 'beta', chunks: 5_000, band: [0.3, 0.99] },
  { name: 'gamma', chunks: 5_000, band: [0.3, 0.99] },
  { name: 'delta', chunks: 5_000, band: [0.3, 0.99] },
  { name: 'epsilon', chunks: 5_000, band: [0.3, 0.99] },
];

const TOTAL_CHUNKS = CORPUS.reduce((n, s) => n + s.chunks, 0);

function chunkVector(centroid: number[], similarity: number, next: () => number): number[] {
  const noise = gaussianVector(next);
  const direction = orthogonalTo(
    QUERY,
    centroid.map((x, i) => x + CLUSTER_JITTER * noise[i]),
  );
  const across = Math.sqrt(1 - similarity * similarity);
  return QUERY.map((q, i) => similarity * q + across * direction[i]);
}

/** pgvector's text input format, at six decimals — 21 050 of these are a real quantity of bytes. */
function vectorLiteral(values: number[]): string {
  return `[${values.map((x) => x.toFixed(6)).join(',')}]`;
}

let database: TestDatabase;
let installedPgvector: string;
const ids: Record<string, string> = {};
let seedMs = 0;

/**
 * One project, one document, `spec.chunks` chunks — written with a batched `INSERT … SELECT FROM
 * unnest(…)` rather than through `replaceDocument`, because this is 21 050 rows and the product's
 * upsert path is what `vector-store.itest.ts` is for. The rows are the same rows, and they go into the
 * same HNSW index by the same incremental path a real index run uses.
 */
async function seedProject(spec: Spec, index: number): Promise<void> {
  const [project] = await database.db.insert(projects).values({ name: spec.name }).returning({ id: projects.id });
  // The project's own vector index, created where `createProject` creates it — before any chunk — so
  // the rows below go into it by the same incremental path a real index run uses.
  await createProjectVectorIndex(database.db, project.id);
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  // **Two documents and not one**, split down the middle of the chunk indexes
  // ([ADR-0042](../../../.ssot/ADR.md#adr-0042)). Nothing above this line changes — the same rows, the
  // same vectors, in the same order, so every ADR-0040 assertion in this file is about the corpus it
  // was written against. What it buys is a *third* predicate that genuinely rejects something: a
  // `path_prefix` naming the second half of the crowded project excludes five hundred of its own rows
  // and 97.6 % of the instance, which is the case ADR-0040 said this file would have to answer for
  // when the filters landed.
  const half = Math.ceil(spec.chunks / 2);
  const [first, second] = await database.db
    .insert(documents)
    .values(
      ['a', 'b'].map((part) => ({
        projectId: project.id,
        sourceId: source.id,
        relativePath: `handbook/${spec.name}-${part}.md`,
        title: `${spec.name} handbook, part ${part}`,
        contentHash: `hash-${spec.name}-${part}`,
        sizeBytes: 4096,
        chunkCount: part === 'a' ? half : spec.chunks - half,
        indexGeneration: LIVE,
        indexedAt: new Date(),
        // The two halves are two releases ([ADR-0058](../../../.ssot/ADR.md#adr-0058)), which costs
        // this fixture nothing and buys the fourth predicate a corpus: a `version` filter here
        // rejects exactly the rows `path_prefix` rejects, so the two are measured against the same
        // 50 % of a project that is itself 4.75 % of the instance.
        version: part === 'a' ? V1 : V2,
      })),
    )
    .returning({ id: documents.id });
  ids[spec.name] = project.id;

  const next = rng(100 + index);
  const centroid = orthogonalTo(QUERY, gaussianVector(rng(200 + index)));
  const [low, high] = spec.band;
  const client = await database.pool.connect();
  try {
    // The index is built by these inserts, and pgvector picks each element's HNSW level
    // pseudo-randomly, so the graph differs between runs. Seeding the session's PRNG is kept because
    // it costs nothing and removes one source of that — but it is **not** sufficient, measured: the
    // two starvation cases below (as they were, under the shared index) still varied run to run with it in place, which is why they ask five
    // directions rather than one and why they force the plan they are about (`forceVectorIndex`).
    // Anything in this file that has to be exact is asserted against `bruteForce`, which uses no index
    // at all.
    await client.query('SELECT setseed($1)', [0.42]);
    for (let start = 0; start < spec.chunks; start += INSERT_BATCH) {
      const indexes: number[] = [];
      const vectors: string[] = [];
      for (let i = start; i < Math.min(start + INSERT_BATCH, spec.chunks); i++) {
        indexes.push(i);
        vectors.push(vectorLiteral(chunkVector(centroid, low + (high - low) * next(), next)));
      }
      // `chunk_index` stays unique across the project rather than restarting at the second document,
      // because every assertion in this file identifies a row by it — and it is what
      // `chunks_document_chunk_index_uq` is about.
      await client.query(
        `INSERT INTO chunks (project_id, document_id, index_generation, chunk_index, heading_path, content, token_count, embedding)
         SELECT $1::uuid, CASE WHEN t.i < $5::int THEN $2::uuid ELSE $6::uuid END, ${LIVE}, t.i,
                'Handbook > Section ' || t.i, '${spec.name} chunk ' || t.i, 12, t.v::vector
         FROM unnest($3::int[], $4::text[]) AS t(i, v)`,
        [project.id, first.id, indexes, vectors, half, second.id],
      );
    }
  } finally {
    client.release();
  }

  await database.db.execute(sql`UPDATE projects SET chunk_count = ${spec.chunks}, document_count = 2 WHERE id = ${project.id}`);
}

/** The answer the index has to agree with: the same rows, reached without any index at all. */
async function bruteForce(
  projectId: string,
  limit: number,
  query: number[] = QUERY,
  pathPrefix: string | null = null,
  version: string | null = null,
): Promise<Array<{ chunkIndex: number; score: number }>> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    // Both, and locally: with only `enable_indexscan` off the planner reaches the same HNSW index
    // through a bitmap scan and this stops being an independent answer.
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const result = await client.query<{ chunk_index: number; score: number }>(
      `SELECT c.chunk_index, (1 - (c.embedding <=> $2::vector))::float8 AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.project_id = $1::uuid AND c.index_generation = ${LIVE}
         AND ($4::text IS NULL OR d.relative_path LIKE $4 || '%')
         AND ($5::text IS NULL OR d.version = $5)
       ORDER BY c.embedding <=> $2::vector LIMIT $3`,
      [projectId, vectorLiteral(query), limit, pathPrefix, version],
    );
    await client.query('COMMIT');
    return result.rows.map((r) => ({ chunkIndex: r.chunk_index, score: r.score }));
  } finally {
    client.release();
  }
}

/**
 * How many live chunks, across **every** project in the index, are nearer to `query` than the best row
 * of `projectId` that the filter keeps. No `ORDER BY`, so no plan can reach the HNSW index: this is a
 * count over the vectors themselves and does not change between builds of the graph.
 *
 * It is the number a post-filter is up against. Without the iterative scan the index hands over about
 * `ef_search` candidates, all of them — as far as the graph can tell — from the front of the global
 * ordering; a project whose first surviving row stands behind ten times that many has nothing among
 * them to survive.
 */
async function rowsAhead(projectId: string, query: number[], version: string): Promise<number> {
  const result = await database.pool.query<{ ahead: string }>(
    `SELECT count(*) AS ahead FROM chunks
     WHERE index_generation = ${LIVE}
       AND (embedding <=> $1::vector) < (
         SELECT min(c.embedding <=> $1::vector) FROM chunks c
         WHERE c.project_id = $2::uuid AND c.index_generation = ${LIVE}
           AND c.document_id IN (SELECT id FROM documents WHERE project_id = $2::uuid AND index_generation = ${LIVE} AND version = $3))`,
    [vectorLiteral(query), projectId, version],
  );
  return Number(result.rows[0].ahead);
}

/**
 * **Why the two starvation cases force a plan instead of asserting one, which is the other thing this
 * file is now evidence about.**
 *
 * `small` sits on PostgreSQL's own crossover, and that is not an accident of the corpus — ADR-0040
 * measured the crossover ("somewhere between 500 and 1 000 chunks") and 1 000 was chosen because it is
 * where the starvation lives. Moving the corpus off the crossover would make this file green by
 * removing the condition it exists to demonstrate, so the corpus does not move. What moves is the
 * *question*: from "did the planner choose the HNSW scan this time" to "here is what the HNSW scan
 * does when it is the plan".
 *
 * **The crossover is a coin toss, and which way it lands has nothing to do with the HNSW graph.**
 * Measured over repeated builds of this same corpus: at the shipped `ef_search = 100` the HNSW scan of
 * `small` is costed at 1 184.52..1 598.51 every single time — pgvector's estimate is a function of the
 * settings and the row count, not of a graph it has not walked. Its competitor is what moves. `ANALYZE`
 * samples the physical correlation of `chunks_project_idx`, and across builds the same thousand rows
 * came back at 1 297.43, 2 126.39 and 2 542.86. When the sample lands low, reading the project's own
 * rows and sorting them exactly wins, the post-filter never runs at all, and a case asking whether this
 * project starves is answered **no** — correctly, and about a plan this file is not about. That is the
 * whole flake, roughly one build in five: the question had two right answers and the corpus picked
 * between them. Nothing was wrong with the code under test on the builds where it failed.
 *
 * So the probes take the planner's discretion away and then check, in the same transaction, that
 * taking it away left the plan the case is about. `bruteForce` above already does exactly this from
 * the other side. Neither is a plan the product issues; both are how two plans are compared over one
 * corpus.
 */
async function forceVectorIndex(client: pg.PoolClient): Promise<void> {
  await client.query('SET LOCAL enable_seqscan = off');
  await client.query('SET LOCAL enable_bitmapscan = off');
  // The third is the one that is easy to leave out and would quietly not work: with only the other two
  // off, an index scan on `chunks_project_idx` feeding a `Sort` is still available, and at a thousand
  // rows it is precisely what the planner takes. Disabling the sort leaves producing the `ORDER BY`
  // from the vector index as the only way. Asserted rather than trusted — every probe below reads back
  // the plan it actually ran under.
  await client.query('SET LOCAL enable_sort = off');
}

const VECTOR_INDEX = PROJECT_VECTOR_INDEX_PREFIX;

/**
 * The dense candidate query of `searchChunks`, run on its own under the given scan settings
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)) and through the vector index. Two cases below need the
 * *candidate* count to be a variable, because the starvation this file was written about depended on
 * it: under the shared index, at the ten the product used to ask for, the post-filter bit; at the fifty
 * the fused search now asks for, PostgreSQL read the project's own rows and sorted them exactly. Going
 * through `searchChunks` would fix that count at fifty and the comparison would disappear.
 *
 * It returns the plan it ran under alongside the rows, and both callers assert it. That is where the
 * non-vacuity guarantee lives now: the statement whose rows are being judged is the statement whose
 * plan was read — same settings, same connection, same transaction — so "these rows came through the
 * project's own vector index" is observed on every run rather than inferred from a similar query run
 * nearby at different settings.
 */
interface CandidateScope {
  version?: string;
  pathPrefix?: string;
  /**
   * A predicate on the **chunk itself**, which resolves to no document ids and joins nothing. It is
   * the third way of selecting the same rows, and it is here so that "the cost belongs to narrowing"
   * can be told apart from "the cost belongs to the semi-join `searchChunks` writes".
   */
  chunkIndexAtLeast?: number;
}

async function denseCandidates(
  projectId: string,
  limit: number,
  settings: HnswScan,
  query: number[] = QUERY,
  scope: CandidateScope = {},
): Promise<{ rows: number[]; throughVectorIndex: boolean }> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await forceVectorIndex(client);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.ef_search', String(settings.efSearch)]);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.iterative_scan', settings.iterativeScan]);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.max_scan_tuples', String(settings.maxScanTuples)]);
    // The filters as `searchChunks` writes them — one semi-join against the document ids they resolve
    // to, not a join to `documents` in the ordered query ([ADR-0042](../../../.ssot/ADR.md#adr-0042),
    // [ADR-0058](../../../.ssot/ADR.md#adr-0058)). Written here rather than reached through
    // `searchChunks` for this helper's existing reason: the candidate count has to be a variable, and
    // going through the product would fix it at fifty.
    const parameters: unknown[] = [projectId, vectorLiteral(query)];
    const predicates: string[] = [];
    if (scope.version !== undefined) {
      parameters.push(scope.version);
      predicates.push(`version = $${parameters.length}`);
    }
    if (scope.pathPrefix !== undefined) {
      parameters.push(scope.pathPrefix);
      predicates.push(`relative_path LIKE $${parameters.length} || '%'`);
    }
    const within =
      predicates.length === 0
        ? ''
        : `AND c.document_id IN (SELECT id FROM documents
             WHERE project_id = $1::uuid AND index_generation = ${LIVE} AND ${predicates.join(' AND ')})`;
    // Deliberately **not** a semi-join and not a mention of `documents` anywhere: this is the control
    // that separates the shape of the filter from the fact that it narrows.
    const bare = scope.chunkIndexAtLeast === undefined ? '' : `AND c.chunk_index >= ${scope.chunkIndexAtLeast}`;
    const text = `SELECT c.chunk_index FROM chunks c WHERE c.project_id = $1::uuid AND c.index_generation = ${LIVE} ${within} ${bare}
       ORDER BY c.embedding <=> $2::vector LIMIT ${limit}`;
    const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, parameters);
    const result = await client.query<{ chunk_index: number }>(text, parameters);
    await client.query('COMMIT');
    return {
      rows: result.rows.map((row) => row.chunk_index),
      throughVectorIndex: plan.rows.some((r) => r['QUERY PLAN'].includes(VECTOR_INDEX)),
    };
  } finally {
    client.release();
  }
}

/**
 * Whether a search of `projectId` reaches the vector index, which is the planner's decision — asked
 * under the settings that search would carry, and optionally with the alternatives taken away.
 *
 * **The settings are not decoration.** pgvector's cost estimate depends on `hnsw.ef_search`: measured
 * on this corpus, the same scan of `small` starts at 591.64 at pgvector's default of 40 and at
 * 1 184.52 at the 100 this product ships. An `EXPLAIN` that leaves them unset describes a query nobody
 * issues, and describes it *more* favourably to the index — the direction that hides a disagreement
 * between what was asserted and what ran, rather than surfacing it. It hid this one: on the builds
 * where the starvation cases failed, this helper went on reporting the HNSW scan they had not got.
 */
async function vectorIndexOf(projectId: string, probe: { limit?: number; settings?: HnswScan; force?: boolean } = {}): Promise<string | null> {
  const { limit = K, settings = DEFAULT_HNSW_SCAN, force = false } = probe;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    if (force) await forceVectorIndex(client);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.ef_search', String(settings.efSearch)]);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.iterative_scan', settings.iterativeScan]);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.max_scan_tuples', String(settings.maxScanTuples)]);
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT chunk_index FROM chunks WHERE project_id = $1::uuid AND index_generation = ${LIVE}
       ORDER BY embedding <=> $2::vector LIMIT ${limit}`,
      [projectId, vectorLiteral(QUERY)],
    );
    await client.query('COMMIT');
    const named = plan.rows.map((r) => r['QUERY PLAN'].match(new RegExp(`${VECTOR_INDEX}[0-9a-f]{32}`))?.[0]).find(Boolean);
    return named ?? null;
  } finally {
    client.release();
  }
}

async function usesVectorIndex(projectId: string, probe: { limit?: number; settings?: HnswScan; force?: boolean } = {}): Promise<boolean> {
  return (await vectorIndexOf(projectId, probe)) !== null;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'hnsw_scan');
  await applySchema(database, DIMS);
  // Stated rather than assumed: `hnsw.iterative_scan` arrived in pgvector 0.8, the image tag floats,
  // and without this a downgrade would surface as the assertions below failing obscurely.
  installedPgvector = await requirePgvectorAtLeast(database.db, '0.8');

  const started = Date.now();
  for (const [index, spec] of CORPUS.entries()) await seedProject(spec, index);
  seedMs = Date.now() - started;
  // 21 050 rows arrived without autoanalyze having had a chance to run, and every plan below is a
  // cost comparison. Without this the planner is choosing against statistics from an empty table.
  await database.db.execute(sql`ANALYZE chunks`);
  console.log(`hnsw-scan: seeded ${TOTAL_CHUNKS} chunks in ${(seedMs / 1000).toFixed(1)}s against pgvector ${installedPgvector}`);
}, 600_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

const scan = (overrides: Partial<HnswScan> = {}): HnswScan => ({ ...DEFAULT_HNSW_SCAN, ...overrides });

describe('a project the shared index crowded out, answered from its own', () => {
  it("reaches every project through that project's own index, and through no other", async () => {
    // The precondition everything below needs, and the one fact the whole change rests on: a search of
    // a project is planned against the partial index whose predicate names that project. The planner
    // proves that by matching `project_id = $1` with the uuid bound, so a search that stopped binding
    // the id — or an index built with a different predicate — would fail here rather than quietly fall
    // back to reading rows. Forced, for `forceVectorIndex`'s reason: this is about which index, not
    // whether.
    for (const spec of CORPUS) expect(await vectorIndexOf(ids[spec.name], { force: true })).toBe(projectVectorIndexName(ids[spec.name]));

    // Left to itself, the 50-chunk project is still read by `chunks_project_idx` and sorted exactly at
    // the fifty candidates the product asks for — ≈80..180 against ≈257 for its own index, measured
    // over three builds. At ten the two are close enough to be a coin toss, so ten is not asserted.
    expect(await usesVectorIndex(ids.tiny, { limit: DENSE_CANDIDATES })).toBe(false);
  });

  it('is reached through its own index at the candidate count the product asks for', async () => {
    // The opposite of what ADR-0041 found for the shared index. There, fifty candidates made reading a
    // project's rows and sorting them cheaper than an HNSW descent through twenty thousand, so the
    // planner stepped around the post-filter. `beta`'s own index is a five-thousand-row graph, costed at
    // 1 020.98..1 197.53 against 5 757.35 for reading and sorting its rows, on each of four builds.
    //
    // **Not asserted for `small`**, whose thousand rows sit on the crossover described above
    // `forceVectorIndex`: its own graph is costed at 823.67..1 016.61, and the exact path at whatever
    // `ANALYZE` sampled for `chunks_project_idx`'s correlation — 2 008.07..2 576.08 over four builds of
    // this file alone, and under the index cost in one full-suite run in four. Either plan answers `small` correctly, and which one the planner picks is not
    // this file's question; that its own index is the one a vector scan of it uses is asserted, forced,
    // in the case above.
    expect(await usesVectorIndex(ids.beta, { limit: DENSE_CANDIDATES })).toBe(true);
  });

  it('returns a full page, and every row on it belongs to that project', async () => {
    const hits = await searchChunks(database.db, {
      projectId: ids.small,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      scan: scan(),
      selection: WHOLE_PAGE,
    });

    expect(hits).toHaveLength(K);
    // Not asserted through the score: every chunk is named after the project that owns it, so a leak
    // is visible as a string rather than inferred from a number.
    for (const hit of hits) {
      expect(hit.file).toMatch(/^handbook\/small-[ab]\.md$/);
      expect(hit.content).toMatch(/^small chunk \d+$/);
    }
  });

  it('is answered in full with the iterative scan off as well — which is the defect, gone', async () => {
    // Under the shared index this was the demonstration: the project's best rows sat roughly 2 600
    // places down the global distance ordering, a hundred candidates did not contain them, and every
    // one of these five directions came back short. Its own index holds nothing but its own rows, so a
    // hundred candidates are a hundred of them and the post-filter — now only `index_generation` — has
    // nothing to remove.
    //
    // **The claim is the page and the settings' irrelevance, not the exact ten.** The four directions
    // after `QUERY` are nearly orthogonal to it, where a greedy walk is at its least reliable: measured
    // over three builds they find five to nine of the exact ten, and they find the *same* rows at every
    // scan setting. That is the graph's own recall, the ceiling "alone in its database" has too, and
    // no setting reaches past it — which is exactly what makes the settings irrelevant here.
    const recalled: string[] = [];
    for (const [i, query] of PROBE_QUERIES.entries()) {
      const off = await denseCandidates(ids.small, K, scan({ iterativeScan: 'off' }), query);
      const shipped = await denseCandidates(ids.small, K, scan(), query);
      const exact = (await bruteForce(ids.small, K, query)).map((row) => row.chunkIndex);
      expect(off.throughVectorIndex).toBe(true);
      expect(off.rows).toHaveLength(K);
      expect([...off.rows].sort((a, b) => a - b)).toEqual([...shipped.rows].sort((a, b) => a - b));
      recalled.push(`#${i} ${off.rows.filter((row) => exact.includes(row)).length}/${K}`);
    }

    // And where the corpus *is* arranged — along `QUERY` — the shipped settings return the rows an
    // index-free scan returns, as a set: `relaxed_order` may return them out of order, and the product
    // re-sorts them in JS, which this probe deliberately bypasses and the case below asserts.
    const on = await denseCandidates(ids.small, K, scan());
    const exact = (await bruteForce(ids.small, K)).map((row) => row.chunkIndex);
    expect(on.throughVectorIndex).toBe(true);
    expect([...on.rows].sort((a, b) => a - b)).toEqual([...exact].sort((a, b) => a - b));

    console.log(`hnsw-scan: iterative_scan=off answered every direction in full from the project's own index — recall ${recalled.join(', ')}`);
  });

  it('returns exactly what it would return if it were the only project in the database', async () => {
    // ROADMAP Item 11b's "done when", written as an equality rather than a hope. The comparison is a
    // scan of the same rows in the same database with every index disabled — so the only thing that
    // differs between the two answers is the index.
    const hits = await searchChunks(database.db, {
      projectId: ids.small,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      scan: scan(),
      selection: WHOLE_PAGE,
    });
    const exact = await bruteForce(ids.small, K);

    expect(exact).toHaveLength(K);
    expect(hits.map((h) => h.chunkIndex)).toEqual(exact.map((e) => e.chunkIndex));
    for (const [rank, hit] of hits.entries()) expect(hit.score).toBeCloseTo(exact[rank].score, 6);
  });

  it('hands back a list that is genuinely in descending score order', async () => {
    // `relaxed_order` is *allowed* to return the right set in the wrong order — that is the trade that
    // makes it cheaper than `strict_order` — so `searchChunks` sorts in JS rather than trusting the
    // `ORDER BY`. This asserts the contract, not the observation: at this corpus pgvector happens to
    // return them ordered anyway, which is exactly why the sort must not depend on being needed.
    const hits = await searchChunks(database.db, {
      projectId: ids.small,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      scan: scan(),
      selection: WHOLE_PAGE,
    });
    for (const [rank, hit] of hits.entries()) if (rank > 0) expect(hit.score).toBeLessThanOrEqual(hits[rank - 1].score);
  });

  it('no longer stops where max_scan_tuples says, because its own graph is smaller than the budget', async () => {
    // Under the shared index this was the knob that mattered: the budget counts tuples of the index,
    // which were the *instance's*, and 2 000 of them — below the ~2 600 this project needed — cut
    // every direction short. It still counts the index's tuples; the index is now a thousand rows, so
    // 2 000 is more than the whole graph and the cut never falls. The same rows come back as at the
    // shipped 20 000, direction for direction. `HNSW_MAX_SCAN_TUPLES` stays — it bounds what a project
    // larger than its budget can cost — but it no longer decides whether a small one is answered.
    for (const query of PROBE_QUERIES) {
      const cut = await denseCandidates(ids.small, K, scan({ maxScanTuples: 2_000 }), query);
      const shipped = await denseCandidates(ids.small, K, scan(), query);
      expect(cut.throughVectorIndex).toBe(true);
      expect(cut.rows).toHaveLength(K);
      expect([...cut.rows].sort((a, b) => a - b)).toEqual([...shipped.rows].sort((a, b) => a - b));
    }
  });

  it('answers a project that dominates the index the same way, so this is not a small-project patch', async () => {
    const hits = await searchChunks(database.db, {
      projectId: ids.beta,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      scan: scan(),
      selection: WHOLE_PAGE,
    });
    expect(hits.map((h) => h.chunkIndex)).toEqual((await bruteForce(ids.beta, K)).map((e) => e.chunkIndex));
  });
});

describe('a third predicate, which is what ADR-0040 said this file would have to answer for', () => {
  // ADR-0040 accepted that `index_generation` had made post-filtering strictly worse and named the
  // filters of Item 7 as the next two predicates. This is the measurement rather than the assumption:
  // the same crowded project, the same shipped scan settings, and a `path_prefix` that rejects half of
  // the project's own rows on top of the 95 % of the instance that belongs to somebody else.
  const HALF_OF_SMALL = 'handbook/small-b';

  it('answers the crowded project exactly, at the shipped ef_search and max_scan_tuples', async () => {
    const hits = await searchChunks(database.db, {
      projectId: ids.small,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      pathPrefix: HALF_OF_SMALL,
      scan: scan(),
      selection: WHOLE_PAGE,
    });
    const exact = await bruteForce(ids.small, K, QUERY, HALF_OF_SMALL);

    // A full page, every row inside the filter, and the same rows an exact scan of that half returns.
    // Short of this the settings would need raising, and the number to raise is `max_scan_tuples`.
    expect(hits).toHaveLength(K);
    expect(hits.map((h) => h.chunkIndex)).toEqual(exact.map((e) => e.chunkIndex));
    expect(hits.every((h) => h.file === `${HALF_OF_SMALL}.md`)).toBe(true);
  });

  it('answers the project that dominates the index exactly too, which is the one that goes through it', async () => {
    // Written when `small` was read by `chunks_project_idx` at fifty candidates and `beta` was the
    // project a third predicate post-filtered. Both now go through their own index; `beta` is kept
    // because it is the larger graph, and the one where a narrowing filter costs the most candidates.
    const prefix = 'handbook/beta-b';
    const hits = await searchChunks(database.db, {
      projectId: ids.beta,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      pathPrefix: prefix,
      scan: scan(),
      selection: WHOLE_PAGE,
    });
    const exact = await bruteForce(ids.beta, K, QUERY, prefix);

    // Not vacuous: the planner reaches this project through its own vector index, so the filter here
    // really is a post-filter over index candidates rather than a predicate on rows PostgreSQL was
    // going to read anyway.
    expect(await usesVectorIndex(ids.beta, { limit: DENSE_CANDIDATES })).toBe(true);
    expect(hits).toHaveLength(K);
    expect(hits.map((h) => h.chunkIndex)).toEqual(exact.map((e) => e.chunkIndex));
  });
});

describe('a fourth predicate, which narrows the pool the same way and has to be measured too', () => {
  // ADR-0058 adds a filter, and every filter this product grows is a post-filter over HNSW candidates
  // — the thing ADR-0040 measured and the thing the `path_prefix` cases above exist for. It is asked
  // of the same crowded corpus, at the shipped settings, and against the same brute-force scan, so
  // "the version filter still returns a full page" is a measurement rather than an expectation.
  //
  // **On `beta`**, which was chosen when it was the only project the planner reached through the shared
  // index at fifty candidates. Every project past the 50-chunk one now reaches its own; `beta` stays
  // the largest graph a filter narrows. Asserted rather than assumed, in the same transaction shape the
  // `path_prefix` case uses.

  it('answers the project that goes through the index exactly, under a filter that rejects half of it', async () => {
    expect(await usesVectorIndex(ids.beta, { limit: DENSE_CANDIDATES })).toBe(true);

    const hits = await searchChunks(database.db, {
      projectId: ids.beta,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      version: V2,
      scan: scan(),
      selection: WHOLE_PAGE,
    });
    const exact = await bruteForce(ids.beta, K, QUERY, null, V2);

    // A full page — not a short one, which is what a post-filter that has run out of candidates
    // returns and what nothing but this assertion would tell them apart — every row inside the
    // filter, and the same rows an index-free scan of that release returns.
    expect(exact).toHaveLength(K);
    expect(hits).toHaveLength(K);
    expect(hits.map((h) => h.chunkIndex)).toEqual(exact.map((e) => e.chunkIndex));
    expect(hits.every((h) => h.file === 'handbook/beta-b.md')).toBe(true);
  });

  it('is the same pool as the path prefix that selects the same rows, so the two filters cost the same', async () => {
    // The two predicates select identical sets here by construction, so a difference between these
    // two pages would mean one of them is reaching the index differently — which is the failure a
    // new filter can introduce and the one a per-filter assertion would never see.
    const of = (request: { pathPrefix?: string; version?: string }) =>
      searchChunks(database.db, {
        projectId: ids.beta,
        generation: LIVE,
        queryEmbedding: QUERY,
        queryText: QUERY_TEXT,
        limit: K,
        scan: scan(),
        selection: WHOLE_PAGE,
        ...request,
      });

    const byVersion = await of({ version: V2 });
    const byPath = await of({ pathPrefix: 'handbook/beta-b' });
    expect(byVersion.map((h) => h.chunkIndex)).toEqual(byPath.map((h) => h.chunkIndex));
  });

  it('returns a full page under the predicate through a plan that is forced to be the HNSW scan', async () => {
    // **Forced, and read back, rather than hoped for.** The two cases above go through
    // `searchChunks`, which is fifty candidates and a planner decision; this is the same predicate at
    // ten, with the alternatives taken away and the plan asserted — so "k hits came back under the
    // filter" is a statement about the post-filter and not about a sequential scan that happened to
    // be cheaper.
    //
    // **The claim is the count and the membership, not the exact ten.** Under the shared index one of
    // the ten was not among the ten nearest: `relaxed_order` is allowed that, and a `LIMIT` that stops
    // as soon as ten rows have survived a narrowing predicate is where it shows. From the project's
    // own index the ten have come back exact on every build measured since, which is not promised
    // here; **whose cost the inexactness is, is the case below**, and exactness is claimed where the
    // product actually asks, which is fifty candidates.
    const filtered = await denseCandidates(ids.small, K, scan(), QUERY, { version: V2 });

    expect(filtered.throughVectorIndex).toBe(true);
    // Not short. Short is the ADR-0040 defect, and it is what this same query did under the shared
    // index the moment the iterative scan was switched off — the case below.
    expect(filtered.rows).toHaveLength(K);
    // Every row is the second release: `seedProject` splits each project down the middle of its chunk
    // indexes, so part `b` — and therefore `v2` — is exactly the upper half.
    expect(filtered.rows.every((chunkIndex) => chunkIndex >= SMALL_HALF)).toBe(true);
  });

  it('costs that exactness to narrowing rather than to this column, and gets it back at the candidate count the product asks for', async () => {
    // **The question the case above raises and this one answers with a measurement**: is the
    // inexactness at ten candidates something `version` introduced, or what every predicate that
    // narrows the pool has always done under `relaxed_order` ([ADR-0040](../../../.ssot/ADR.md#adr-0040))?
    //
    // **Three** queries over one corpus, same forced HNSW plan, same shipped settings, and the same
    // five hundred rows eligible — selected three different ways. `seedProject` splits each project
    // down the middle of its chunk indexes, so `version = v2`, `path_prefix = handbook/small-b` and
    // `chunk_index >= SMALL_HALF` are three spellings of one set. The third is the one that decides
    // the question, because it resolves no document ids and never mentions `documents`: if the cost
    // were the semi-join's, or this column's, it would be the odd one out.
    const byVersion = await denseCandidates(ids.small, K, scan(), QUERY, { version: V2 });
    const byPath = await denseCandidates(ids.small, K, scan(), QUERY, { pathPrefix: 'handbook/small-b' });
    const byChunkIndex = await denseCandidates(ids.small, K, scan(), QUERY, { chunkIndexAtLeast: SMALL_HALF });
    const unfiltered = await denseCandidates(ids.small, K, scan());
    const exactUnfiltered = (await bruteForce(ids.small, K)).map((row) => row.chunkIndex);

    // All three went through the vector index, so none of them is agreeing with the others by having
    // quietly been given a different plan.
    for (const answer of [byVersion, byPath, byChunkIndex]) expect(answer.throughVectorIndex).toBe(true);
    // They do not differ. The version semi-join, the path-prefix semi-join and the bare chunk
    // predicate return the identical ten rows, so what the scan pays for is the narrowing and not the
    // predicate that expresses it — `path_prefix` has had this property since ADR-0042 and nothing
    // observed it, because every case written for it runs at fifty candidates through `searchChunks`.
    expect(byVersion.rows).toEqual(byPath.rows);
    expect(byVersion.rows).toEqual(byChunkIndex.rows);
    // And the same scan is exact when nothing narrows it, which is what makes the line above a
    // statement about the filter's *pool* rather than about this fixture or these settings.
    expect(unfiltered.throughVectorIndex).toBe(true);
    expect([...unfiltered.rows].sort((a, b) => a - b)).toEqual([...exactUnfiltered].sort((a, b) => a - b));
    expect(byVersion.rows).not.toEqual(unfiltered.rows);

    // **At fifty — the number `DENSE_CANDIDATES` fixes and the only one the product ever issues — the
    // filtered scan is exact again.** So the effect is real, it is a property of ADR-0040's scan
    // parameters at a small candidate count, and it does not reach the shipped configuration.
    const fifty = await denseCandidates(ids.small, DENSE_CANDIDATES, scan(), QUERY, { version: V2 });
    const exactFifty = (await bruteForce(ids.small, DENSE_CANDIDATES, QUERY, null, V2)).map((row) => row.chunkIndex);
    expect(fifty.throughVectorIndex).toBe(true);
    expect([...fifty.rows].sort((a, b) => a - b)).toEqual([...exactFifty].sort((a, b) => a - b));
  });

  it('answers in full under that same predicate with the iterative scan off, however many rows of the instance stand ahead', async () => {
    // Under the shared index this was the sharpest form of the defect, and it held on every direction
    // of every build: a hundred candidates did not contain this project's rows, and the predicate
    // rejected half of the ones they did. It is kept as the contrast, over the same five directions.
    //
    // **Two statements per direction, and the first is unchanged.** It is about the corpus, counted
    // without any index, and holds on every build or on none: the filtered project's best row stands
    // behind at least ten times `ef_search` rows of the whole instance. That is what used to decide
    // the second. The second is now the opposite — a full page, every row inside the filter — because
    // the rows ahead belong to other projects' indexes and this scan never meets them.
    const { efSearch } = scan();
    const recalled: string[] = [];
    for (const [i, query] of CROWDED_PROBES.entries()) {
      const ahead = await rowsAhead(ids.small, query, V2);
      expect(ahead, `direction #${i}: ${ahead} rows ahead of the filtered project's best`).toBeGreaterThanOrEqual(10 * efSearch);

      const off = await denseCandidates(ids.small, K, scan({ iterativeScan: 'off' }), query, { version: V2 });
      const exact = (await bruteForce(ids.small, K, query, null, V2)).map((row) => row.chunkIndex);
      expect(off.throughVectorIndex).toBe(true);
      expect(off.rows, `direction #${i} with ${ahead} rows ahead`).toHaveLength(K);
      expect(off.rows.every((chunkIndex) => chunkIndex >= SMALL_HALF)).toBe(true);
      recalled.push(`#${i} ${off.rows.filter((row) => exact.includes(row)).length}/${K} with ${ahead} ahead`);
    }
    console.log(`hnsw-scan: iterative_scan=off answered in full under the version filter — ${recalled.join(', ')}`);
  });
});

describe('a project small enough for the planner to skip its index', () => {
  it('is exact in every scan mode, whichever plan it gets', async () => {
    // Under the shared index this bounded the defect from below: at fifty chunks PostgreSQL read the
    // project's own rows and sorted them, and the post-filter never ran. With its own index the planner
    // may now take either path at ten candidates (see the first case), and both are exact — a fifty-row
    // graph searched with `ef_search` = 100 visits every row it has.
    const exact = await bruteForce(ids.tiny, K);
    for (const mode of ['off', 'relaxed_order', 'strict_order'] as const) {
      const hits = await searchChunks(database.db, {
        projectId: ids.tiny,
        generation: LIVE,
        queryEmbedding: QUERY,
        queryText: QUERY_TEXT,
        limit: K,
        scan: scan({ iterativeScan: mode }),
        selection: WHOLE_PAGE,
      });
      expect(hits.map((h) => h.chunkIndex)).toEqual(exact.map((e) => e.chunkIndex));
    }
  });
});

describe('the settings themselves', () => {
  it('applies them for the duration of one transaction and no longer', async () => {
    // The objection to a session-level `SET`, demonstrated on the connection it would have leaked
    // through: the pool hands this same backend to unrelated work a moment later.
    const client = await database.pool.connect();
    try {
      await client.query('SELECT count(*) FROM chunks'); // pgvector's module is loaded by now
      await client.query('BEGIN');
      await client.query("SELECT set_config('hnsw.ef_search', '777', true), set_config('hnsw.iterative_scan', 'strict_order', true)");
      const inside = await client.query<{ ef: string; mode: string }>(
        "SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS mode",
      );
      expect(inside.rows[0]).toEqual({ ef: '777', mode: 'strict_order' });
      await client.query('COMMIT');

      const after = await client.query<{ ef: string; mode: string }>(
        "SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS mode",
      );
      // pgvector's own defaults, back on a connection that is about to serve somebody else.
      expect(after.rows[0]).toEqual({ ef: '40', mode: 'off' });
    } finally {
      client.release();
    }
  });

  it('takes effect when set as the very first statement on a connection that has never seen a vector', async () => {
    // `hnsw.*` is a prefixed custom GUC. pgvector registers it when its module is loaded into the
    // backend, which happens on first vector use — so `searchChunks` setting it before the `SELECT`
    // relies on PostgreSQL's placeholder mechanism reclaiming the value when the module arrives. It
    // does. This case exists so a future PostgreSQL or pgvector cannot stop it doing so quietly: the
    // failure mode is not an error, it is `ef_search` silently reverting to 40.
    const pool = new pg.Pool({ connectionString: database.url, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hnsw.ef_search', '321', true), set_config('hnsw.iterative_scan', 'relaxed_order', true)");
        // The first vector operation on this backend, and therefore the moment the module loads.
        await client.query('SELECT chunk_index FROM chunks WHERE project_id = $1::uuid ORDER BY embedding <=> $2::vector LIMIT 1', [
          ids.small,
          vectorLiteral(QUERY),
        ]);
        const settings = await client.query<{ ef: string; mode: string }>(
          "SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS mode",
        );
        expect(settings.rows[0]).toEqual({ ef: '321', mode: 'relaxed_order' });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('leaves the connection `searchChunks` borrowed exactly as it found it', async () => {
    // The two halves of "transaction-scoped", on one backend, in order.
    //
    // A pool of one means the connection `searchChunks` checks out is the connection this test then
    // probes — the sharing a busy server does, minus the timing. That the settings *took effect* is
    // the full page: at pgvector's defaults this same query returns nothing (the assertion above).
    // That they did **not** leak is the row after it. Neither half alone would catch a session `SET`.
    const pool = new pg.Pool({ connectionString: database.url, max: 1 });
    try {
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const schema = await import('../../src/db/schema.js');
      const scoped = drizzle({ client: pool, schema });

      const hits = await searchChunks(scoped, {
        projectId: ids.small,
        generation: LIVE,
        queryEmbedding: QUERY,
        queryText: QUERY_TEXT,
        limit: K,
        scan: scan({ efSearch: 137 }),
        selection: WHOLE_PAGE,
      });
      expect(hits).toHaveLength(K);

      const client = await pool.connect();
      try {
        const after = await client.query<{ ef: string; mode: string; tuples: string }>(
          `SELECT current_setting('hnsw.ef_search') AS ef,
                  current_setting('hnsw.iterative_scan') AS mode,
                  current_setting('hnsw.max_scan_tuples') AS tuples`,
        );
        // pgvector's own defaults, on the connection the next unrelated query will borrow. A
        // session-level `SET`, or a `pool.on('connect')` hook, would read 137 here.
        expect(after.rows[0]).toEqual({ ef: '40', mode: 'off', tuples: '20000' });
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
