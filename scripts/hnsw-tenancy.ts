import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type pg from 'pg';

import { DENSE_CANDIDATES, MAX_SEARCH_LIMIT } from '../src/config.js';
import { documentSources, documents, projects } from '../src/db/schema.js';
import { DEFAULT_HNSW_SCAN, type HnswScan, searchChunks } from '../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  pgvectorVersion,
  startPostgres,
  type RunningPostgres,
  type TestDatabase,
} from '../test/integration/support/postgres.js';
import { chunkVectors, crowdedProbes, DIMS, TARGET, type TenantSpec, tenancyCorpus, vectorLiteral } from './hnsw-tenancy-corpus.js';

/**
 * `npx tsx scripts/hnsw-tenancy.ts` — what one shared HNSW index does to a crowded project, and what the
 * two ways out of it cost (ROADMAP.md Item 11b's fallback, ADR-0040's "When to reach for the fallback").
 *
 * `npm run eval` cannot see this: its corpus is one project in an otherwise empty database, and a
 * post-filter with nothing to filter is exact. This harness is the multi-tenant counterpart. It seeds
 * the corpus of `scripts/hnsw-tenancy-corpus.ts` at each requested scale and asks the same questions of
 * the same project four ways:
 *
 * - **`today`** — the one global `chunks_embedding_hnsw_idx` this product ships, at its shipped scan
 *   settings, at two raised `hnsw.max_scan_tuples` to show what the knob buys and costs, and once more
 *   with `hnsw.scan_mem_multiplier` lifted too, because that cap ends the scan first.
 * - **`partial`** — one partial HNSW index per project, `WHERE project_id = '<uuid>'`, and no global one.
 * - **`partitioned`** — a copy of `chunks` list-partitioned by `project_id`, with the HNSW index on the
 *   parent and therefore one per partition.
 * - **`single`** — the same project, the same vectors, alone in its own database: the answer the
 *   multi-tenant instance is supposed to give and the comparison the phase brief asks for.
 *
 * Every recall is against an index-free scan of the same rows (`enable_indexscan` and
 * `enable_bitmapscan` off), so the only thing that differs between an answer and its reference is the
 * index. The dense candidate query is the one `searchChunks` writes — same predicate, same single
 * `ORDER BY` key, `DENSE_CANDIDATES` rows, the scan settings set per transaction — and the arms on the
 * real `chunks` table are cross-checked through `searchChunks` itself.
 *
 * For each candidate it also prices what the brief asks about: index count and size, build time, the
 * DB-side cost of a rebuild into the next generation and of sweeping it (ADR-0039), the cost and the
 * lock of creating a project, and what the instance looks like at a hundred tenants.
 *
 * `HNSW_TENANCY_DATABASE_URL` (or `EVAL_DATABASE_URL`) points at a PostgreSQL to carve throwaway
 * databases out of; without either a `pgvector/pgvector:pg16` container is started and stopped.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every seeded project is fresh, so its live generation is the column default (ADR-0039). */
const LIVE = 0;
/** The generation a rebuild writes beside it. */
const NEXT = 1;
/** What a caller asks for, and what recall is measured at. */
const K = 10;
const INSERT_BATCH = 1_000;
/** How many projects the "a hundred tenants" rows describe. */
const HUNDRED = 100;
/** Latency samples are every probe this many times. */
const LATENCY_REPEATS = 3;
/** How many projects each creation-cost figure is taken over. */
const CREATE_SAMPLES = 5;

/** Retrieval, not selection: the per-document cap would hold every page of a one-document-a-half fixture to two rows. */
const WHOLE_PAGE = { maxPerDocument: MAX_SEARCH_LIMIT, neighborContext: 0 };
/** Nothing in the seeded chunks matches it and `content_tsv` is NULL, so the lexical half is empty and the dense half is what is measured. */
const QUERY_TEXT = 'a phrase that appears in none of the seeded chunks';

const GLOBAL_INDEX = 'chunks_embedding_hnsw_idx';
const HNSW_WITH = 'USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)';

interface Options {
  scales: number[];
  probes: number;
  json: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { scales: [1, 10], probes: 10, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--scale')
      options.scales = value()
        .split(',')
        .map((s) => Number.parseInt(s, 10));
    else if (arg === '--probes') options.probes = Number.parseInt(value(), 10);
    else if (arg === '--json') options.json = path.resolve(value());
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: npx tsx scripts/hnsw-tenancy.ts [--scale 1,10] [--probes 10] [--json out.json]\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.scales.some((s) => !Number.isInteger(s) || s < 1)) throw new Error('--scale takes positive integers');
  if (!Number.isInteger(options.probes) || options.probes < 1) throw new Error('--probes takes a positive integer');
  return options;
}

const step = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const since = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e6;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = process.hrtime.bigint();
  const value = await fn();
  return [value, since(started)];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

// ---------------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------------

interface Tenant {
  id: string;
  spec: TenantSpec;
  /** Position in the corpus list, which is what its vectors' seeds are derived from. */
  seedIndex: number;
}

/**
 * One project, one source, two documents, `spec.chunks` chunks — the scale test's `seedProject`, less
 * the version split this harness has no use for. `INSERT … SELECT unnest(…)`, so `content_tsv` stays NULL
 * and the lexical half has nothing to say.
 */
async function seedTenant(database: TestDatabase, spec: TenantSpec, seedIndex: number, name = spec.name): Promise<Tenant> {
  const [project] = await database.db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  const half = Math.ceil(spec.chunks / 2);
  const [first, second] = await database.db
    .insert(documents)
    .values(
      ['a', 'b'].map((part) => ({
        projectId: project.id,
        sourceId: source.id,
        relativePath: `handbook/${name}-${part}.md`,
        title: `${name} handbook, part ${part}`,
        contentHash: `hash-${name}-${part}`,
        sizeBytes: 4096,
        chunkCount: part === 'a' ? half : spec.chunks - half,
        indexGeneration: LIVE,
        indexedAt: new Date(),
      })),
    )
    .returning({ id: documents.id });
  let start = 0;
  for (const batch of chunkVectors(spec, seedIndex, INSERT_BATCH)) {
    const indexes = batch.map((_, i) => start + i);
    await database.pool.query(
      `INSERT INTO chunks (project_id, document_id, index_generation, chunk_index, heading_path, content, token_count, embedding)
       SELECT $1::uuid, CASE WHEN t.i < $5::int THEN $2::uuid ELSE $6::uuid END, ${LIVE}, t.i,
              'Handbook > Section ' || t.i, $7 || ' chunk ' || t.i, 12, t.v::vector
       FROM unnest($3::int[], $4::text[]) AS t(i, v)`,
      [project.id, first.id, indexes, batch.map(vectorLiteral), half, second.id, name],
    );
    start += batch.length;
  }
  await database.db.execute(sql`UPDATE projects SET chunk_count = ${spec.chunks}, document_count = 2 WHERE id = ${project.id}`);
  return { id: project.id, spec, seedIndex };
}

/** A project with no chunks — what `createProject` makes. */
async function emptyProject(database: TestDatabase, name: string): Promise<string> {
  const [project] = await database.db.insert(projects).values({ name }).returning({ id: projects.id });
  return project.id;
}

// ---------------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------------

/**
 * The shipped scan settings, plus the one pgvector knob the product does not set. `hnsw.scan_mem_multiplier`
 * caps an iterative scan's memory at that multiple of `work_mem`, and whichever of it and
 * `max_scan_tuples` is reached first ends the scan — so raising the tuple budget alone can be inert.
 */
type Scan = HnswScan & { scanMemMultiplier?: number };

async function setScan(client: pg.PoolClient, scan: Scan): Promise<void> {
  await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)', [
    'hnsw.ef_search',
    String(scan.efSearch),
    'hnsw.iterative_scan',
    scan.iterativeScan,
    'hnsw.max_scan_tuples',
    String(scan.maxScanTuples),
  ]);
  if (scan.scanMemMultiplier !== undefined) {
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.scan_mem_multiplier', String(scan.scanMemMultiplier)]);
  }
}

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Which of `names` are HNSW indexes, by access method rather than by name: a partitioned table's index
 * is cloned onto each partition as `<partition>_embedding_idx`, which says nothing about HNSW.
 */
async function hnswAmong(client: pg.PoolClient, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const result = await client.query<{ name: string }>(
    `SELECT i.relname AS name FROM pg_class i JOIN pg_am am ON am.oid = i.relam
     WHERE am.amname = 'hnsw' AND i.relkind = 'i' AND i.relname = ANY($1)`,
    [names],
  );
  return new Set(result.rows.map((r) => r.name));
}

/** The dense candidate statement of `searchChunks`, over `table`. Parameters, not literals — as drizzle sends them. */
const denseText = (table: string): string =>
  `SELECT c.chunk_index, (c.embedding <=> $3::vector)::float8 AS distance FROM ${table} c
   WHERE c.project_id = $1::uuid AND c.index_generation = $2::int
   ORDER BY c.embedding <=> $3::vector LIMIT ${DENSE_CANDIDATES}`;

/** The top `K` an index-free scan of the same rows returns. */
async function bruteForce(pool: pg.Pool, table: string, projectId: string, generation: number, query: number[]): Promise<number[]> {
  return inTransaction(pool, async (client) => {
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const result = await client.query<{ chunk_index: number }>(
      `SELECT c.chunk_index FROM ${table} c WHERE c.project_id = $1::uuid AND c.index_generation = $2::int
       ORDER BY c.embedding <=> $3::vector LIMIT ${K}`,
      [projectId, generation, vectorLiteral(query)],
    );
    return result.rows.map((r) => r.chunk_index);
  });
}

interface DenseRun {
  top: number[];
  /** The HNSW index the plan reached, or `null` when it read the project's rows and sorted them. */
  index: string | null;
  ms: number;
}

/** One dense candidate query, its plan read in the same transaction, the top `K` taken in JS as `searchChunks` does. */
async function dense(pool: pg.Pool, table: string, projectId: string, generation: number, query: number[], scan: Scan): Promise<DenseRun> {
  return inTransaction(pool, async (client) => {
    await setScan(client, scan);
    const params = [projectId, generation, vectorLiteral(query)];
    const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${denseText(table)}`, params);
    const [result, ms] = await timed(() => client.query<{ chunk_index: number; distance: number }>(denseText(table), params));
    const scanned = plan.rows.flatMap((r) => /Index Scan using (\S+)/.exec(r['QUERY PLAN'])?.[1] ?? []);
    const hnsw = await hnswAmong(client, scanned);
    const index = scanned.find((name) => hnsw.has(name)) ?? null;
    const top = [...result.rows]
      .sort((a, b) => a.distance - b.distance || a.chunk_index - b.chunk_index)
      .slice(0, K)
      .map((r) => r.chunk_index);
    return { top, index, ms };
  });
}

interface Analyzed {
  rowsRemovedByFilter: number;
  rowsReturned: number;
  planningMs: number;
  executionMs: number;
}

/** `EXPLAIN (ANALYZE)` of the dense statement: the ADR-0040 trigger-2 number, and planning time. */
async function analyze(pool: pg.Pool, table: string, projectId: string, generation: number, query: number[], scan: Scan): Promise<Analyzed> {
  return inTransaction(pool, async (client) => {
    await setScan(client, scan);
    const result = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${denseText(table)}`, [
      projectId,
      generation,
      vectorLiteral(query),
    ]);
    const raw = result.rows[0]['QUERY PLAN'];
    const [doc] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }>;
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode): void => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(doc.Plan);
    const hnsw = await hnswAmong(
      client,
      nodes.flatMap((node) => node['Index Name'] ?? []),
    );
    let removed = 0;
    let returned = 0;
    for (const node of nodes) {
      if (node['Index Name'] === undefined || !hnsw.has(node['Index Name'])) continue;
      removed += node['Rows Removed by Filter'] ?? 0;
      returned += node['Actual Rows'] ?? 0;
    }
    return { rowsRemovedByFilter: removed, rowsReturned: returned, planningMs: doc['Planning Time'], executionMs: doc['Execution Time'] };
  });
}

interface PlanNode {
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}

/** How many live chunks of the whole instance are nearer to `query` than the project's best row. */
async function rowsAhead(pool: pg.Pool, projectId: string, query: number[]): Promise<number> {
  const result = await pool.query<{ ahead: string }>(
    `SELECT count(*) AS ahead FROM chunks
     WHERE index_generation = ${LIVE}
       AND (embedding <=> $1::vector) < (SELECT min(c.embedding <=> $1::vector) FROM chunks c WHERE c.project_id = $2::uuid AND c.index_generation = ${LIVE})`,
    [vectorLiteral(query), projectId],
  );
  return Number(result.rows[0].ahead);
}

const recallAt = (got: number[], exact: number[]): number => {
  const want = new Set(exact);
  return exact.length === 0 ? 1 : got.filter((x) => want.has(x)).length / exact.length;
};

interface ProbeSummary {
  /** Mean recall@K over the probes. */
  recall: number;
  /** Probes whose page equalled the reference as a set. */
  exact: number;
  /** Probes that came back with nothing at all. */
  empty: number;
  probes: number;
  /** Which vector index the plans used, with how many probes used it; `exact sort` when none. */
  plans: Record<string, number>;
  p50Ms: number;
  p95Ms: number;
  /** The same recall through `searchChunks` itself, for the arms on the real table. */
  productRecall: number | null;
}

async function measureProbes(
  database: TestDatabase,
  table: string,
  projectId: string,
  generation: number,
  probes: number[][],
  references: number[][],
  scan: Scan,
  throughProduct: boolean,
): Promise<ProbeSummary> {
  const recalls: number[] = [];
  const latencies: number[] = [];
  const plans: Record<string, number> = {};
  const productRecalls: number[] = [];
  let exact = 0;
  let empty = 0;
  for (const [i, query] of probes.entries()) {
    const first = await dense(database.pool, table, projectId, generation, query, scan);
    const recall = recallAt(first.top, references[i]);
    recalls.push(recall);
    if (recall === 1) exact++;
    if (first.top.length === 0) empty++;
    const plan = first.index ?? 'exact sort';
    plans[plan] = (plans[plan] ?? 0) + 1;
    latencies.push(first.ms);
    for (let r = 1; r < LATENCY_REPEATS; r++) latencies.push((await dense(database.pool, table, projectId, generation, query, scan)).ms);
    if (throughProduct) {
      const hits = await searchChunks(database.db, {
        projectId,
        generation,
        queryEmbedding: query,
        queryText: QUERY_TEXT,
        limit: K,
        scan,
        selection: WHOLE_PAGE,
      });
      productRecalls.push(
        recallAt(
          hits.map((h) => h.chunkIndex),
          references[i],
        ),
      );
    }
  }
  return {
    recall: mean(recalls),
    exact,
    empty,
    probes: probes.length,
    plans,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    productRecall: throughProduct ? mean(productRecalls) : null,
  };
}

async function relationBytes(pool: pg.Pool, names: string[]): Promise<number> {
  if (names.length === 0) return 0;
  const result = await pool.query<{ bytes: string }>(
    'SELECT coalesce(sum(pg_relation_size(c.oid)), 0) AS bytes FROM pg_class c WHERE c.relname = ANY($1)',
    [names],
  );
  return Number(result.rows[0].bytes);
}

/** Every HNSW index on `table` or, for a partitioned table, on any of its partitions. */
async function hnswIndexes(pool: pg.Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT i.relname AS name
     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam
     WHERE am.amname = 'hnsw' AND i.relkind = 'i'
       AND (x.indrelid = $1::regclass OR x.indrelid IN (SELECT relid FROM pg_partition_tree($1::regclass)))`,
    [table],
  );
  return result.rows.map((r) => r.name);
}

/** The lock a statement leaves on `relation` for the rest of its transaction — what concurrent writers and readers wait on. */
async function lockTaken(pool: pg.Pool, relation: string, statement: string): Promise<[string, number]> {
  return inTransaction(pool, async (client) => {
    const [, ms] = await timed(() => client.query(statement));
    const result = await client.query<{ mode: string }>(
      "SELECT string_agg(mode, ', ' ORDER BY mode) AS mode FROM pg_locks WHERE pid = pg_backend_pid() AND relation = $1::regclass",
      [relation],
    );
    return [result.rows[0].mode, ms];
  });
}

const partialName = (projectId: string): string => `chunks_embedding_hnsw_p_${projectId.replaceAll('-', '')}`;
const partitionName = (projectId: string): string => `chunks_part_p_${projectId.replaceAll('-', '')}`;

/** A 1 000-chunk newcomer, written into an already-indexed table: the per-row cost every index run pays. */
const NEWCOMER: TenantSpec = { name: 'newcomer', chunks: 1_000, band: [0.3, 0.99] };
/**
 * Seeds for the two newcomers each arm writes, different on purpose: pgvector's HNSW insert folds a
 * vector identical to one already in the graph into that element, so writing the same vectors twice
 * would time the shortcut rather than the insert.
 */
const NEWCOMER_SEEDS = { atSix: 6, atHundred: 7 } as const;

/** The newcomers' vectors as pgvector literals, generated once per seed: the timings below are the database's, not the generator's. */
const newcomerLiterals = new Map<number, string[][]>();

async function insertNewcomerRows(pool: pg.Pool, table: string, projectId: string, documentId: string, seed: number): Promise<number> {
  let batches = newcomerLiterals.get(seed);
  if (!batches) {
    batches = [...chunkVectors(NEWCOMER, seed, INSERT_BATCH)].map((batch) => batch.map(vectorLiteral));
    newcomerLiterals.set(seed, batches);
  }
  const literalBatches = batches;
  const [, ms] = await timed(async () => {
    let start = 0;
    for (const literals of literalBatches) {
      await pool.query(
        `INSERT INTO ${table} (project_id, document_id, index_generation, chunk_index, heading_path, content, token_count, embedding)
         SELECT $1::uuid, $2::uuid, ${LIVE}, t.i, '', 'newcomer chunk ' || t.i, 12, t.v::vector
         FROM unnest($3::int[], $4::text[]) AS t(i, v)`,
        [projectId, documentId, literals.map((_, i) => start + i), literals],
      );
      start += literals.length;
    }
  });
  return ms;
}

async function newcomerDocument(database: TestDatabase, projectId: string): Promise<string> {
  const [doc] = await database.db
    .insert(documents)
    .values({ projectId, relativePath: 'newcomer.md', title: 'newcomer', contentHash: 'newcomer', indexGeneration: LIVE })
    .returning({ id: documents.id });
  return doc.id;
}

interface Rebuild {
  /** Writing the target's rows again as the next generation, into the index the arm has. */
  writeMs: number;
  rows: number;
  /** Recall of the live generation while the next one sits beside it, and of the next one before the swap. */
  liveRecallDuring: number;
  nextRecallDuring: number;
  /** Deleting one generation's rows — what `sweepGenerations` does after the swap. */
  sweepMs: number;
}

/**
 * The DB side of an ADR-0039 rebuild of the target: its chunks written again at `NEXT` beside the live
 * ones (the doubled-storage window), both generations asked while they coexist, and one of them swept.
 * The rows swept are the `NEXT` ones, so the arm is left as it was found; the cost is the same number
 * of rows either way.
 */
async function rebuild(
  database: TestDatabase,
  table: string,
  target: Tenant,
  probes: number[][],
  references: number[][],
  scan: Scan,
): Promise<Rebuild> {
  const pool = database.pool;
  // The next generation's documents, as `replaceDocument` would write them — a chunk's
  // (document_id, chunk_index) is unique, so the copy needs documents of its own.
  await pool.query(
    `INSERT INTO documents (project_id, source_id, relative_path, title, content_hash, size_bytes, chunk_count, index_generation, indexed_at)
     SELECT project_id, source_id, relative_path, title, content_hash, size_bytes, chunk_count, ${NEXT}, now()
     FROM documents WHERE project_id = $1::uuid AND index_generation = ${LIVE}
     ON CONFLICT DO NOTHING`,
    [target.id],
  );
  const [written, writeMs] = await timed(() =>
    pool.query(
      `INSERT INTO ${table} (project_id, document_id, index_generation, chunk_index, heading_path, content, token_count, embedding)
       SELECT c.project_id, n.id, ${NEXT}, c.chunk_index, c.heading_path, c.content, c.token_count, c.embedding
       FROM ${table} c
       JOIN documents o ON o.id = c.document_id
       JOIN documents n ON n.project_id = o.project_id AND n.relative_path = o.relative_path AND n.index_generation = ${NEXT}
       WHERE c.project_id = $1::uuid AND c.index_generation = ${LIVE}`,
      [target.id],
    ),
  );
  const live = await measureProbes(database, table, target.id, LIVE, probes, references, scan, false);
  const next = await measureProbes(database, table, target.id, NEXT, probes, references, scan, false);
  const [, sweepMs] = await timed(() => pool.query(`DELETE FROM ${table} WHERE project_id = $1::uuid AND index_generation = ${NEXT}`, [target.id]));
  await pool.query(`DELETE FROM documents WHERE project_id = $1::uuid AND index_generation = ${NEXT}`, [target.id]);
  await pool.query(`VACUUM ${table}`);
  return { writeMs, rows: written.rowCount ?? 0, liveRecallDuring: live.recall, nextRecallDuring: next.recall, sweepMs };
}

interface Creation {
  /**
   * Creating one project the way the arm would ship it, DDL included — `CREATE INDEX CONCURRENTLY` for
   * `partial`, as `createProjectVectorIndex` runs it; the plain DDL elsewhere. Median and slowest of
   * `CREATE_SAMPLES`.
   */
  createMs: number;
  createMaxMs: number;
  /** The same with the plain, writer-blocking DDL, for comparison: median of `CREATE_SAMPLES`; `null` where that is what ships. */
  plainMs: number | null;
  /** The lock the plain DDL holds on the chunks table for its duration. */
  lock: string;
  /** Creating the projects that take the instance to a hundred, the way the arm would ship it: mean and slowest. */
  toHundredMeanMs: number;
  toHundredMaxMs: number;
  /** With a hundred tenants: the target's dense statement, planning time and p50 execution. */
  hundredPlanningMs: number;
  hundredP50Ms: number;
  /** Writing a 1 000-chunk project into the table as it stands with a hundred tenants. */
  hundredInsert1000Ms: number;
  indexesAtHundred: number;
}

interface ArmResult {
  arm: string;
  indexes: number;
  indexBytes: number;
  buildMs: number;
  /** Only for `partitioned`: copying the table into its partitioned shape — what the migration would cost. */
  copyMs: number | null;
  probes: ProbeSummary;
  analyzed: Analyzed;
  rebuild: Rebuild | null;
  creation: Creation | null;
  /** 1 000 rows written into a newcomer project at six tenants. */
  insert1000Ms: number | null;
}

interface ScaleResult {
  scale: number;
  totalChunks: number;
  targetChunks: number;
  seedMs: number;
  rowsAhead: { min: number; median: number; max: number };
  today: ArmResult;
  raisedMaxScanTuples: Array<{ maxScanTuples: number; scanMemMultiplier?: number; probes: ProbeSummary }>;
  partial: ArmResult;
  partitioned: ArmResult;
  single: ProbeSummary;
}

// ---------------------------------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------------------------------

async function measureScale(baseUrl: string, scale: number, probeCount: number): Promise<ScaleResult> {
  const specs = tenancyCorpus(scale);
  const targetSpec = specs.find((s) => s.name === TARGET);
  if (!targetSpec) throw new Error(`the corpus has no ${TARGET}`);
  const probes = crowdedProbes(probeCount);
  const scan = DEFAULT_HNSW_SCAN;
  const database = await createTestDatabase(baseUrl, `hnsw_tenancy_${scale}x_${Date.now().toString(36)}`);
  try {
    await applySchema(database, DIMS);
    // Seeded with no vector index at all and indexed afterwards, for every arm alike: the build time of
    // each strategy is then a measured quantity rather than something smeared across 210 000 inserts.
    await database.pool.query(`DROP INDEX IF EXISTS ${GLOBAL_INDEX}`);
    step(`hnsw-tenancy ${scale}x: seeding ${specs.reduce((n, s) => n + s.chunks, 0)} chunks`);
    const [tenants, seedMs] = await timed(async () => {
      const out: Tenant[] = [];
      for (const [i, spec] of specs.entries()) out.push(await seedTenant(database, spec, i));
      return out;
    });
    await database.pool.query('ANALYZE');
    const target = tenants.find((t) => t.spec.name === TARGET) as Tenant;
    const references = [];
    for (const q of probes) references.push(await bruteForce(database.pool, 'chunks', target.id, LIVE, q));
    const ahead = [];
    for (const q of probes) ahead.push(await rowsAhead(database.pool, target.id, q));

    // --- today: one global index --------------------------------------------------------------------
    step(`hnsw-tenancy ${scale}x: today — building ${GLOBAL_INDEX}`);
    const [, globalBuildMs] = await timed(() => database.pool.query(`CREATE INDEX ${GLOBAL_INDEX} ON chunks ${HNSW_WITH}`));
    await database.pool.query('ANALYZE chunks');
    const todayProbes = await measureProbes(database, 'chunks', target.id, LIVE, probes, references, scan, true);
    const todayAnalyzed = await analyze(database.pool, 'chunks', target.id, LIVE, probes[0], scan);
    const raised = [];
    // The last one also lifts the memory cap, which is what shows whether the tuple budget was the limit at all.
    const raisings: Array<{ maxScanTuples: number; scanMemMultiplier?: number }> = [
      { maxScanTuples: 40_000 },
      { maxScanTuples: 80_000 },
      { maxScanTuples: 80_000, scanMemMultiplier: 8 },
    ];
    for (const raising of raisings) {
      raised.push({
        ...raising,
        probes: await measureProbes(database, 'chunks', target.id, LIVE, probes, references, { ...scan, ...raising }, false),
      });
    }
    step(`hnsw-tenancy ${scale}x: today — rebuild`);
    const todayRebuild = await rebuild(database, 'chunks', target, probes, references, scan);
    step(`hnsw-tenancy ${scale}x: today — project creation`);
    const todayCreation = await creationCost(database, tenants, target, probes[0], scan, NO_DDL);
    const today: ArmResult = {
      arm: 'today',
      indexes: 1,
      indexBytes: await relationBytes(database.pool, [GLOBAL_INDEX]),
      buildMs: globalBuildMs,
      copyMs: null,
      probes: todayProbes,
      analyzed: todayAnalyzed,
      rebuild: todayRebuild,
      creation: todayCreation,
      insert1000Ms: todayCreation.insert1000AtSixMs,
    };

    // --- partial: one index per project, no global one ------------------------------------------------
    step(`hnsw-tenancy ${scale}x: partial — building ${tenants.length} partial indexes`);
    await database.pool.query(`DROP INDEX IF EXISTS ${GLOBAL_INDEX}`);
    await database.pool.query('VACUUM ANALYZE chunks');
    let partialBuildMs = 0;
    for (const t of tenants) {
      const [, ms] = await timed(() => database.pool.query(`CREATE INDEX ${partialName(t.id)} ON chunks ${HNSW_WITH} WHERE project_id = '${t.id}'`));
      partialBuildMs += ms;
    }
    await database.pool.query('ANALYZE chunks');
    const partialIndexes = await hnswIndexes(database.pool, 'chunks');
    const partialBytes = await relationBytes(database.pool, partialIndexes);
    const partialProbes = await measureProbes(database, 'chunks', target.id, LIVE, probes, references, scan, true);
    const partialAnalyzed = await analyze(database.pool, 'chunks', target.id, LIVE, probes[0], scan);
    step(`hnsw-tenancy ${scale}x: partial — rebuild`);
    const partialRebuild = await rebuild(database, 'chunks', target, probes, references, scan);
    step(`hnsw-tenancy ${scale}x: partial — project creation`);
    const partialCreation = await creationCost(database, tenants, target, probes[0], scan, PARTIAL_DDL);

    // --- partitioned: a copy of chunks, list-partitioned by project ----------------------------------
    step(`hnsw-tenancy ${scale}x: partitioned — copying and indexing`);
    for (const name of partialIndexes) await database.pool.query(`DROP INDEX ${name}`);
    await database.pool.query(
      `CREATE TABLE chunks_part (LIKE chunks INCLUDING DEFAULTS, PRIMARY KEY (id, project_id)) PARTITION BY LIST (project_id)`,
    );
    for (const t of tenants) await database.pool.query(`CREATE TABLE ${partitionName(t.id)} PARTITION OF chunks_part FOR VALUES IN ('${t.id}')`);
    const [, copyMs] = await timed(() => database.pool.query('INSERT INTO chunks_part SELECT * FROM chunks'));
    await database.pool.query('CREATE INDEX chunks_part_project_generation_idx ON chunks_part (project_id, index_generation, text_search_config)');
    const [, partBuildMs] = await timed(() => database.pool.query(`CREATE INDEX chunks_part_embedding_hnsw_idx ON chunks_part ${HNSW_WITH}`));
    await database.pool.query('ANALYZE chunks_part');
    const partIndexes = await hnswIndexes(database.pool, 'chunks_part');
    const partBytes = await relationBytes(database.pool, partIndexes);
    const partProbes = await measureProbes(database, 'chunks_part', target.id, LIVE, probes, references, scan, false);
    const partAnalyzed = await analyze(database.pool, 'chunks_part', target.id, LIVE, probes[0], scan);
    step(`hnsw-tenancy ${scale}x: partitioned — rebuild`);
    const partRebuild = await rebuild(database, 'chunks_part', target, probes, references, scan);
    step(`hnsw-tenancy ${scale}x: partitioned — project creation`);
    const partCreation = await creationCost(database, tenants, target, probes[0], scan, PARTITION_DDL);

    // --- single: the target alone ---------------------------------------------------------------------
    step(`hnsw-tenancy ${scale}x: single — the same project alone`);
    const single = await measureSingle(baseUrl, targetSpec, specs.indexOf(targetSpec), probes, scale, scan);

    return {
      scale,
      totalChunks: specs.reduce((n, s) => n + s.chunks, 0),
      targetChunks: targetSpec.chunks,
      seedMs,
      rowsAhead: { min: Math.min(...ahead), median: percentile(ahead, 50), max: Math.max(...ahead) },
      today,
      raisedMaxScanTuples: raised,
      partial: {
        arm: 'partial',
        indexes: partialIndexes.length,
        indexBytes: partialBytes,
        buildMs: partialBuildMs,
        copyMs: null,
        probes: partialProbes,
        analyzed: partialAnalyzed,
        rebuild: partialRebuild,
        creation: partialCreation,
        insert1000Ms: partialCreation.insert1000AtSixMs,
      },
      partitioned: {
        arm: 'partitioned',
        indexes: partIndexes.length,
        indexBytes: partBytes,
        buildMs: partBuildMs,
        copyMs,
        probes: partProbes,
        analyzed: partAnalyzed,
        rebuild: partRebuild,
        creation: partCreation,
        insert1000Ms: partCreation.insert1000AtSixMs,
      },
      single,
    };
  } finally {
    await dropTestDatabase(baseUrl, database);
  }
}

/** What an arm needs done, in DDL, for each project it holds; `null` where it needs nothing. */
interface PerProjectDdl {
  table: string;
  create: ((projectId: string) => string) | null;
  createConcurrently: ((projectId: string) => string) | null;
  drop: ((projectId: string) => string) | null;
}

const NO_DDL: PerProjectDdl = { table: 'chunks', create: null, createConcurrently: null, drop: null };

const PARTIAL_DDL: PerProjectDdl = {
  table: 'chunks',
  create: (id) => `CREATE INDEX ${partialName(id)} ON chunks ${HNSW_WITH} WHERE project_id = '${id}'`,
  createConcurrently: (id) => `CREATE INDEX CONCURRENTLY ${partialName(id)} ON chunks ${HNSW_WITH} WHERE project_id = '${id}'`,
  drop: (id) => `DROP INDEX IF EXISTS ${partialName(id)}`,
};

const PARTITION_DDL: PerProjectDdl = {
  table: 'chunks_part',
  create: (id) => `CREATE TABLE ${partitionName(id)} PARTITION OF chunks_part FOR VALUES IN ('${id}')`,
  createConcurrently: null,
  drop: (id) => `DROP TABLE IF EXISTS ${partitionName(id)}`,
};

/**
 * What creating a project costs under an arm, and what the instance looks like once it holds a hundred
 * of them: planning and running the target's search, and writing 1 000 chunks into the hundredth.
 * Leaves the arm as it found it — every project it adds, and whatever DDL came with it, is removed.
 */
async function creationCost(
  database: TestDatabase,
  tenants: Tenant[],
  target: Tenant,
  probe: number[],
  scan: Scan,
  ddl: PerProjectDdl,
): Promise<Creation & { insert1000AtSixMs: number }> {
  const pool = database.pool;
  const table = ddl.table;
  // What ships: the concurrent build where the arm has one, which is what `createProjectVectorIndex` runs.
  const shipped = ddl.createConcurrently ?? ddl.create;
  const createWith = async (name: string, statement: ((projectId: string) => string) | null): Promise<string> => {
    const id = await emptyProject(database, name);
    if (statement) await pool.query(statement(id));
    return id;
  };
  const createOne = (name: string): Promise<string> => createWith(name, shipped);
  const created: string[] = [];

  // Projects created the way the arm ships; the first is written into at six tenants.
  const shippedTimes: number[] = [];
  for (let i = 0; i < CREATE_SAMPLES; i++) {
    const [id, took] = await timed(() => createOne(i === 0 ? 'newcomer' : `newcomer-${i}`));
    created.push(id);
    shippedTimes.push(took);
  }
  const newcomer = created[0];
  const insert1000AtSixMs = await insertNewcomerRows(pool, table, newcomer, await newcomerDocument(database, newcomer), NEWCOMER_SEEDS.atSix);

  // The plain DDL beside it, and the lock it holds while it runs.
  let plainMs: number | null = null;
  if (ddl.create && ddl.createConcurrently) {
    const plainTimes: number[] = [];
    for (let i = 0; i < CREATE_SAMPLES; i++) {
      const [id, took] = await timed(() => createWith(`newcomer-plain-${i}`, ddl.create));
      created.push(id);
      plainTimes.push(took);
    }
    plainMs = percentile(plainTimes, 50);
  }
  let lock = 'none: a row in projects';
  if (ddl.create) {
    const locked = await emptyProject(database, 'newcomer-lock');
    created.push(locked);
    [lock] = await lockTaken(pool, table, ddl.create(locked));
  }

  const times: number[] = [];
  while (tenants.length + created.length < HUNDRED - 1) {
    const [id, took] = await timed(() => createOne(`filler-${created.length}`));
    created.push(id);
    times.push(took);
  }
  // The hundredth: a project that is written to, so the insert below pays whatever a hundred tenants cost a write.
  const last = await createOne('newcomer-hundred');
  created.push(last);
  await pool.query(`ANALYZE ${table}`);
  const indexesAtHundred = (await hnswIndexes(pool, table)).length;
  const hundred = await analyze(pool, table, target.id, LIVE, probe, scan);
  const p50 = [];
  for (let i = 0; i < 5; i++) p50.push((await dense(pool, table, target.id, LIVE, probe, scan)).ms);
  const hundredInsert1000Ms = await insertNewcomerRows(pool, table, last, await newcomerDocument(database, last), NEWCOMER_SEEDS.atHundred);

  if (ddl.drop) for (const id of created) await pool.query(ddl.drop(id));
  await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [created]);
  await pool.query(`VACUUM ANALYZE ${table}`);
  return {
    createMs: percentile(shippedTimes, 50),
    createMaxMs: Math.max(...shippedTimes),
    plainMs,
    lock,
    toHundredMeanMs: mean(times),
    toHundredMaxMs: Math.max(...times),
    hundredPlanningMs: hundred.planningMs,
    hundredP50Ms: percentile(p50, 50),
    hundredInsert1000Ms,
    indexesAtHundred,
    insert1000AtSixMs,
  };
}

/** The target, the same vectors, alone in a database of its own under the shipped global index. */
async function measureSingle(
  baseUrl: string,
  spec: TenantSpec,
  seedIndex: number,
  probes: number[][],
  scale: number,
  scan: Scan,
): Promise<ProbeSummary> {
  const database = await createTestDatabase(baseUrl, `hnsw_tenancy_single_${scale}x_${Date.now().toString(36)}`);
  try {
    await applySchema(database, DIMS);
    await database.pool.query(`DROP INDEX IF EXISTS ${GLOBAL_INDEX}`);
    const tenant = await seedTenant(database, spec, seedIndex);
    await database.pool.query(`CREATE INDEX ${GLOBAL_INDEX} ON chunks ${HNSW_WITH}`);
    await database.pool.query('ANALYZE');
    const references = [];
    for (const q of probes) references.push(await bruteForce(database.pool, 'chunks', tenant.id, LIVE, q));
    return await measureProbes(database, 'chunks', tenant.id, LIVE, probes, references, scan, true);
  } finally {
    await dropTestDatabase(baseUrl, database);
  }
}

// ---------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
const ms = (x: number | null): string => (x === null ? '–' : x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${x.toFixed(x < 10 ? 2 : 0)} ms`);
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const plans = (p: Record<string, number>): string =>
  Object.entries(p)
    .map(
      ([name, n]) =>
        `${name.startsWith('chunks_embedding_hnsw_p_') ? 'own partial' : name.startsWith('chunks_part_p_') ? 'own partition' : name} ×${n}`,
    )
    .join(', ');

function formatMarkdown(results: ScaleResult[], version: string): string {
  const lines: string[] = [];
  lines.push(
    `pgvector ${version}; recall@${K} against an index-free scan; dense statement of \`searchChunks\` at \`DENSE_CANDIDATES\` = ${DENSE_CANDIDATES};`,
  );
  lines.push(
    `shipped scan settings \`ef_search\` = ${DEFAULT_HNSW_SCAN.efSearch}, \`iterative_scan\` = ${DEFAULT_HNSW_SCAN.iterativeScan}, \`max_scan_tuples\` = ${DEFAULT_HNSW_SCAN.maxScanTuples}.`,
  );
  lines.push('');
  lines.push('### Recall of the crowded project');
  lines.push('');
  lines.push(
    `| scale | instance | \`${TARGET}\` | rows ahead (min / median / max) | arm | recall@${K} | exact pages | empty pages | through \`searchChunks\` | plan | p50 | p95 |`,
  );
  lines.push('|--:|--:|--:|--:|---|--:|--:|--:|--:|---|--:|--:|');
  for (const r of results) {
    const head = `| ${r.scale}× | ${r.totalChunks} | ${r.targetChunks} | ${r.rowsAhead.min} / ${r.rowsAhead.median} / ${r.rowsAhead.max}`;
    const row = (arm: string, p: ProbeSummary): string =>
      `${head} | ${arm} | ${pct(p.recall)} | ${p.exact}/${p.probes} | ${p.empty}/${p.probes} | ${p.productRecall === null ? '–' : pct(p.productRecall)} | ${plans(p.plans)} | ${ms(p.p50Ms)} | ${ms(p.p95Ms)} |`;
    lines.push(row('single (alone in its database)', r.single));
    lines.push(row('**today** (one global index)', r.today.probes));
    for (const raised of r.raisedMaxScanTuples) {
      const memory = raised.scanMemMultiplier === undefined ? '' : `, \`scan_mem_multiplier\` = ${raised.scanMemMultiplier}`;
      lines.push(row(`today, \`max_scan_tuples\` = ${raised.maxScanTuples}${memory}`, raised.probes));
    }
    lines.push(row('partial (one index per project)', r.partial.probes));
    lines.push(row('partitioned (one partition per project)', r.partitioned.probes));
  }
  lines.push('');
  lines.push('### What each strategy costs');
  lines.push('');
  lines.push(
    '| scale | arm | HNSW indexes | total size | build | table copy | rows removed by filter / returned | planning | rebuild: write next gen | live / next recall during | sweep | create a project, as shipped (median / max) | plain DDL, writers blocked (median) | lock the plain DDL holds |',
  );
  lines.push('|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|');
  for (const r of results) {
    for (const a of [r.today, r.partial, r.partitioned]) {
      const rb = a.rebuild;
      const c = a.creation;
      lines.push(
        `| ${r.scale}× | ${a.arm} | ${a.indexes} | ${mb(a.indexBytes)} | ${ms(a.buildMs)} | ${ms(a.copyMs)} | ${a.analyzed.rowsRemovedByFilter} / ${a.analyzed.rowsReturned} | ${ms(a.analyzed.planningMs)} | ${rb ? `${ms(rb.writeMs)} (${rb.rows} rows)` : '–'} | ${rb ? `${pct(rb.liveRecallDuring)} / ${pct(rb.nextRecallDuring)}` : '–'} | ${rb ? ms(rb.sweepMs) : '–'} | ${c ? `${ms(c.createMs)} / ${ms(c.createMaxMs)}` : '–'} | ${c ? ms(c.plainMs) : '–'} | ${c?.lock ?? '–'} |`,
      );
    }
  }
  lines.push('');
  lines.push('### At a hundred tenants');
  lines.push('');
  lines.push(
    '| scale | arm | HNSW indexes | creating one, as shipped (mean / max) | planning the search | search p50 | 1 000 chunks written, at 6 tenants → at 100 |',
  );
  lines.push('|--:|---|--:|--:|--:|--:|--:|');
  for (const r of results) {
    for (const a of [r.today, r.partial, r.partitioned]) {
      const c = a.creation;
      if (!c) continue;
      lines.push(
        `| ${r.scale}× | ${a.arm} | ${c.indexesAtHundred} | ${ms(c.toHundredMeanMs)} / ${ms(c.toHundredMaxMs)} | ${ms(c.hundredPlanningMs)} | ${ms(c.hundredP50Ms)} | ${ms(a.insert1000Ms)} → ${ms(c.hundredInsert1000Ms)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function run(options: Options): Promise<void> {
  const provided = process.env.HNSW_TENANCY_DATABASE_URL ?? process.env.EVAL_DATABASE_URL;
  let container: RunningPostgres | null = null;
  let baseUrl = provided ?? '';
  try {
    if (!provided) {
      step('hnsw-tenancy: starting a pgvector container (set HNSW_TENANCY_DATABASE_URL to use a server you already have)');
      container = await startPostgres();
      baseUrl = container.baseUrl;
    }
    const probeDb = await createTestDatabase(baseUrl, `hnsw_tenancy_probe_${Date.now().toString(36)}`);
    let version: string;
    try {
      await applySchema(probeDb, DIMS);
      version = await pgvectorVersion(probeDb.db);
    } finally {
      await dropTestDatabase(baseUrl, probeDb);
    }
    const results: ScaleResult[] = [];
    for (const scale of options.scales) results.push(await measureScale(baseUrl, scale, options.probes));
    if (options.json) {
      await fs.writeFile(options.json, `${JSON.stringify({ pgvector: version, results }, null, 2)}\n`, 'utf8');
      step(`hnsw-tenancy: wrote ${path.relative(path.join(HERE, '..'), options.json)}`);
    }
    process.stdout.write(formatMarkdown(results, version));
  } finally {
    if (container) await container.stop().catch((err: unknown) => step(`hnsw-tenancy: could not stop the container: ${String(err)}`));
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`\nhnsw-tenancy failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  }
}
