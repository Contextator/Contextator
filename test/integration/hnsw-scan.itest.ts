import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { documentSources, documents, projects } from '../../src/db/schema.js';
import { DENSE_CANDIDATES } from '../../src/config.js';
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
 * one global HNSW index, six projects in it, and the ones that do not dominate it asked about
 * themselves.
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
 * Five directions rather than one, for the two starvation cases below.
 *
 * pgvector picks each element's HNSW level pseudo-randomly, and `setseed` on the writing session does
 * not make that reproducible — the graph differs between runs, and whether one particular query's
 * hundred global candidates happen to contain ten of this project's thousand rows differs with it.
 * Asked of one direction, "iterative scan off starves this project" failed about one run in three, on
 * this branch and on the one that introduced it. Asked of five, the claim is that *approximate search
 * without the iterative scan does not reliably answer this project* — which is what ADR-0040 actually
 * says, is what an operator experiences, and does not depend on the graph coming out a particular way.
 *
 * Only for the negative claim. The corpus is arranged around `QUERY` — the bands in `CORPUS` are
 * similarities to it — so "the iterative scan makes the answer exact" is asserted for `QUERY` alone,
 * below. Four arbitrary directions into a seeded 21 050-vector space are not a shape this file has any
 * reason to promise anything about.
 */
const PROBE_QUERIES: number[][] = [QUERY, ...Array.from({ length: 4 }, (_, i) => normalize(gaussianVector(rng(900 + i))))];

const sameOrder = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

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
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  const [document] = await database.db
    .insert(documents)
    .values({
      projectId: project.id,
      sourceId: source.id,
      relativePath: `handbook/${spec.name}.md`,
      title: `${spec.name} handbook`,
      contentHash: `hash-${spec.name}`,
      sizeBytes: 4096,
      chunkCount: spec.chunks,
      indexGeneration: LIVE,
      indexedAt: new Date(),
    })
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
    // two starvation cases below still varied run to run with it in place, which is why they ask five
    // directions instead of one. Anything in this file that has to be exact is asserted against
    // `bruteForce`, which uses no index at all.
    await client.query('SELECT setseed($1)', [0.42]);
    for (let start = 0; start < spec.chunks; start += INSERT_BATCH) {
      const indexes: number[] = [];
      const vectors: string[] = [];
      for (let i = start; i < Math.min(start + INSERT_BATCH, spec.chunks); i++) {
        indexes.push(i);
        vectors.push(vectorLiteral(chunkVector(centroid, low + (high - low) * next(), next)));
      }
      await client.query(
        `INSERT INTO chunks (project_id, document_id, index_generation, chunk_index, heading_path, content, token_count, embedding)
         SELECT $1::uuid, $2::uuid, ${LIVE}, t.i, 'Handbook > Section ' || t.i, '${spec.name} chunk ' || t.i, 12, t.v::vector
         FROM unnest($3::int[], $4::text[]) AS t(i, v)`,
        [project.id, document.id, indexes, vectors],
      );
    }
  } finally {
    client.release();
  }

  await database.db.execute(sql`UPDATE projects SET chunk_count = ${spec.chunks}, document_count = 1 WHERE id = ${project.id}`);
}

/** The answer the index has to agree with: the same rows, reached without any index at all. */
async function bruteForce(projectId: string, limit: number, query: number[] = QUERY): Promise<Array<{ chunkIndex: number; score: number }>> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    // Both, and locally: with only `enable_indexscan` off the planner reaches the same HNSW index
    // through a bitmap scan and this stops being an independent answer.
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const result = await client.query<{ chunk_index: number; score: number }>(
      `SELECT chunk_index, (1 - (embedding <=> $2::vector))::float8 AS score
       FROM chunks WHERE project_id = $1::uuid AND index_generation = ${LIVE}
       ORDER BY embedding <=> $2::vector LIMIT $3`,
      [projectId, vectorLiteral(query), limit],
    );
    await client.query('COMMIT');
    return result.rows.map((r) => ({ chunkIndex: r.chunk_index, score: r.score }));
  } finally {
    client.release();
  }
}

/**
 * The dense candidate query of `searchChunks`, run on its own under the given scan settings
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). Two cases below need the *candidate* count to be a
 * variable, because the starvation this file was written about depends on it: at the ten the product
 * used to ask for, PostgreSQL reaches `small` through the vector index and the post-filter bites; at
 * the fifty the fused search now asks for, it reads the project's own rows and sorts them exactly.
 * Going through `searchChunks` would fix that count at fifty and the evidence would disappear.
 */
async function denseCandidates(projectId: string, limit: number, settings: HnswScan, query: number[] = QUERY): Promise<number[]> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.ef_search', String(settings.efSearch)]);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.iterative_scan', settings.iterativeScan]);
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.max_scan_tuples', String(settings.maxScanTuples)]);
    const result = await client.query<{ chunk_index: number }>(
      `SELECT c.chunk_index FROM chunks c WHERE c.project_id = $1::uuid AND c.index_generation = ${LIVE}
       ORDER BY c.embedding <=> $2::vector LIMIT ${limit}`,
      [projectId, vectorLiteral(query)],
    );
    await client.query('COMMIT');
    return result.rows.map((row) => row.chunk_index);
  } finally {
    client.release();
  }
}

/** Whether a search of `projectId` reaches the vector index at all, which is the planner's decision. */
async function usesVectorIndex(projectId: string, limit: number = K): Promise<boolean> {
  const client = await database.pool.connect();
  try {
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT chunk_index FROM chunks WHERE project_id = $1::uuid AND index_generation = ${LIVE}
       ORDER BY embedding <=> $2::vector LIMIT ${limit}`,
      [projectId, vectorLiteral(QUERY)],
    );
    return plan.rows.some((r) => r['QUERY PLAN'].includes('chunks_embedding_hnsw_idx'));
  } finally {
    client.release();
  }
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

describe('a project crowded out of the global top-k of a shared index', () => {
  it('is the planner that decides whether any of this matters, so that is checked first', async () => {
    // The finding that shaped this file. A 50-chunk project is fetched by `chunks_project_idx` and
    // sorted exactly — it can never be post-filtered, because it is never approached through the
    // vector index. A 1 000-chunk one is, on this instance. Everything below depends on that split
    // and would quietly stop testing anything if it moved.
    expect(await usesVectorIndex(ids.tiny)).toBe(false);
    expect(await usesVectorIndex(ids.small)).toBe(true);
  });

  it('changed its mind about this project when the candidate count went from ten to fifty', async () => {
    // Not a regression and not an accident — a measured side effect of ADR-0041 worth having written
    // down. Asking for fifty candidates instead of ten moves the planner's own crossover: fetching
    // `small`'s thousand rows by `chunks_project_idx` and sorting them exactly becomes cheaper than an
    // HNSW descent, so the post-filter cannot starve this project any more, because it is no longer
    // post-filtering it. The project that *does* still go through the index is the one that dominates.
    expect(await usesVectorIndex(ids.small, DENSE_CANDIDATES)).toBe(false);
    expect(await usesVectorIndex(ids.beta, DENSE_CANDIDATES)).toBe(true);
    // The exactness this buys is asserted below, against a brute-force scan, rather than assumed here.
  });

  it('returns a full page, and every row on it belongs to that project', async () => {
    const hits = await searchChunks(database.db, {
      projectId: ids.small,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      scan: scan(),
    });

    expect(hits).toHaveLength(K);
    // Not asserted through the score: every chunk is named after the project that owns it, so a leak
    // is visible as a string rather than inferred from a number.
    for (const hit of hits) {
      expect(hit.file).toBe('handbook/small.md');
      expect(hit.content).toMatch(/^small chunk \d+$/);
    }
  });

  it('is not reliably answered at all by the same query with iterative scan off — which is the defect', async () => {
    // Without this the assertion above passes on any implementation that looks correct, the previous
    // one included. The project's best rows sit roughly 2 600 places down the global distance
    // ordering, so a hundred candidates rarely contain them and the post-filter has little left.
    //
    // Asked at ten candidates rather than through `searchChunks`, and that is the point of the case
    // above: at the fifty the fused search asks for, this project is no longer reached through the
    // index and the defect cannot be shown on it at all. The settings are not thereby decoration —
    // they are what `beta` and every project past the crossover still depends on — so the evidence for
    // them is kept in the shape that produces it.
    //
    // Over five directions rather than one, and asserted as "not every one of them is right" rather
    // than as a row count. See PROBE_QUERIES.
    const wrong: string[] = [];
    for (const [i, query] of PROBE_QUERIES.entries()) {
      const off = await denseCandidates(ids.small, K, scan({ iterativeScan: 'off' }), query);
      const exact = (await bruteForce(ids.small, K, query)).map((row) => row.chunkIndex);
      if (!sameOrder(off, exact)) wrong.push(`#${i} returned ${off.length} of ${K}`);
    }

    expect(wrong.length).toBeGreaterThan(0);
    console.log(`hnsw-scan: iterative_scan=off missed the exact answer for ${wrong.length} of ${PROBE_QUERIES.length} queries — ${wrong.join(', ')}`);
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
    });
    for (const [rank, hit] of hits.entries()) if (rank > 0) expect(hit.score).toBeLessThanOrEqual(hits[rank - 1].score);
  });

  it('stops where max_scan_tuples says, which is the knob that matters at this shape', async () => {
    // The number that actually ends an iterative scan is not `ef_search`, it is this — and it counts
    // the *instance's* tuples, not the project's. 2 000 is below the ~2 600 this project needs, and
    // the default 20 000 is above it; both facts are the reason the variable is nameable at all.
    // At ten candidates, and over the same five directions, for the two reasons the
    // `iterative_scan = off` case above gives.
    let starved = 0;
    for (const query of PROBE_QUERIES) {
      const cut = await denseCandidates(ids.small, K, scan({ maxScanTuples: 2_000 }), query);
      const exact = (await bruteForce(ids.small, K, query)).map((row) => row.chunkIndex);
      if (!sameOrder(cut, exact)) starved++;
    }
    expect(starved).toBeGreaterThan(0);
  });

  it('answers a project that dominates the index the same way, so this is not a small-project patch', async () => {
    const hits = await searchChunks(database.db, {
      projectId: ids.beta,
      generation: LIVE,
      queryEmbedding: QUERY,
      queryText: QUERY_TEXT,
      limit: K,
      scan: scan(),
    });
    expect(hits.map((h) => h.chunkIndex)).toEqual((await bruteForce(ids.beta, K)).map((e) => e.chunkIndex));
  });
});

describe('a project too small for the planner to use the vector index at all', () => {
  it('was already exact, and still is, in every scan mode', async () => {
    // Worth an assertion because it is the opposite of what the roadmap assumed, and because it bounds
    // the problem: below roughly a thousand chunks PostgreSQL rescues the project on its own, and
    // turning iterative scan off changes nothing. The starvation has a floor as well as a ceiling.
    const exact = await bruteForce(ids.tiny, K);
    for (const mode of ['off', 'relaxed_order', 'strict_order'] as const) {
      const hits = await searchChunks(database.db, {
        projectId: ids.tiny,
        generation: LIVE,
        queryEmbedding: QUERY,
        queryText: QUERY_TEXT,
        limit: K,
        scan: scan({ iterativeScan: mode }),
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
