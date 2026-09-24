import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { Logger } from '../../src/context.js';
import { bootstrapDatabase } from '../../src/db/bootstrap.js';
import type { Db } from '../../src/db/client.js';
import { documentSources } from '../../src/db/schema.js';
import { LEGACY_VECTOR_INDEX, PROJECT_VECTOR_INDEX_PREFIX, projectVectorIndexName } from '../../src/db/vector-indexes.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { createProject, deleteProject, getProjectById } from '../../src/services/projects.js';
import { searchProject } from '../../src/services/search.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * One partial HNSW index per project (`src/db/vector-indexes.ts`, ROADMAP.md Item 16): where it is
 * created, where it goes, what a start does about an instance whose indexes disagree with its projects,
 * and — the contract the change had to carry — a forced re-index ([ADR-0039](../../.ssot/ADR.md#adr-0039))
 * with both generations living in that one index.
 *
 * What the index *buys* is `hnsw-scan.itest.ts`'s subject, measured on its crowded corpus. This file is
 * about the index's lifecycle, and it reads the catalogue rather than trusting the code that wrote it.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';

interface VectorIndex {
  name: string;
  oid: number;
  valid: boolean;
  predicate: string | null;
}

/** Every HNSW index on `chunks`, per-project or not, with what the catalogue says about it. */
async function vectorIndexes(db: Db): Promise<VectorIndex[]> {
  const result = await db.execute(sql`
    SELECT c.relname AS name, c.oid::int AS oid, i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid = 'chunks'::regclass AND am.amname = 'hnsw'
    ORDER BY c.relname`);
  return result.rows as unknown as VectorIndex[];
}

/** A logger that keeps what the bootstrap said at `info` and `warn`, so "nothing to do" is observable. */
function recordingLogger(): { log: Logger; lines: Array<{ fields: unknown; message: string }> } {
  const lines: Array<{ fields: unknown; message: string }> = [];
  const record = (fields: unknown, message?: string) => {
    lines.push(typeof fields === 'string' ? { fields: {}, message: fields } : { fields, message: message ?? '' });
  };
  const log = { ...silentLogger, info: record, warn: record } as unknown as Logger;
  return { log, lines };
}

function bootstrap(database: TestDatabase, log: Logger, dimensions = DIMS, resetVectors = false): Promise<void> {
  return bootstrapDatabase(database.db, { pool: database.pool, dimensions, resetVectors, log });
}

describe('a project and its vector index', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'vector_indexes_lifecycle');
    await applySchema(database);
  });

  afterAll(async () => {
    await dropTestDatabase(baseUrl, database);
  });

  it('are created together and dropped together', async () => {
    const first = await createProject(database.db, { name: 'first' }, []);
    const second = await createProject(database.db, { name: 'second' }, []);

    const created = await vectorIndexes(database.db);
    expect(created.map(({ name, valid, predicate }) => ({ name, valid, predicate }))).toEqual(
      [first, second]
        .map((project) => ({ name: projectVectorIndexName(project.id), valid: true, predicate: `(project_id = '${project.id}'::uuid)` }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );

    await deleteProject(database.db, first.id, () => false);
    expect((await vectorIndexes(database.db)).map((index) => index.name)).toEqual([projectVectorIndexName(second.id)]);
  });

  it('leaves no index behind for a project that was refused', async () => {
    // A duplicate name is refused by the insert, before an index is ever attempted — and the refusal is
    // a `ConflictError`, not a half-made project with an index of its own.
    const before = await vectorIndexes(database.db);
    await expect(createProject(database.db, { name: 'second' }, [])).rejects.toThrow(/already exists/);
    expect(await vectorIndexes(database.db)).toEqual(before);
  });
});

describe('a start, against indexes that disagree with the projects', () => {
  let database: TestDatabase;
  const kept: Record<string, string> = {};

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'vector_indexes_reconcile');
    await applySchema(database);
    for (const name of ['missing', 'invalid', 'intact']) kept[name] = (await createProject(database.db, { name }, [])).id;
  });

  afterAll(async () => {
    await dropTestDatabase(baseUrl, database);
  });

  it('drops the shared index, the orphan and the invalid one, and builds what is missing', async () => {
    const run = (statement: string) => database.db.execute(sql.raw(statement));
    const orphan = randomUUID();

    // An upgrade: the shared index an older build left, and nothing per-project for one of the projects.
    await run(`CREATE INDEX ${LEGACY_VECTOR_INDEX} ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
    await run(`DROP INDEX ${projectVectorIndexName(kept.missing)}`);
    // What a failed `CREATE INDEX CONCURRENTLY` leaves: an index marked not valid, which `IF NOT EXISTS`
    // would take for done. Marked by hand, because a build that fails on cue is not something a test
    // can arrange without a second session racing the first.
    await run(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${projectVectorIndexName(kept.invalid)}'::regclass`);
    // A project deleted while its index could not be dropped.
    await run(`CREATE INDEX ${projectVectorIndexName(orphan)} ON chunks USING hnsw (embedding vector_cosine_ops) WHERE project_id = '${orphan}'`);

    const before = await vectorIndexes(database.db);
    const intactOid = before.find((index) => index.name === projectVectorIndexName(kept.intact))?.oid;
    expect(intactOid).toBeDefined();
    expect(before.map((index) => index.name)).toContain(LEGACY_VECTOR_INDEX);

    const { log, lines } = recordingLogger();
    await bootstrap(database, log);

    const after = await vectorIndexes(database.db);
    expect(after.map(({ name, valid }) => ({ name, valid }))).toEqual(
      Object.values(kept)
        .map((id) => ({ name: projectVectorIndexName(id), valid: true }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    // The intact one is the same index, not a rebuild of it: a start pays only for what was wrong.
    expect(after.find((index) => index.name === projectVectorIndexName(kept.intact))?.oid).toBe(intactOid);

    expect(lines.map((line) => line.message)).toContain('dropped the shared vector index; every project gets its own');
    const reconciled = lines.find((line) => line.message === 'reconciled the per-project vector indexes');
    expect(reconciled?.fields).toEqual({ created: 2, dropped: 2, projects: 3 });
  });

  it('does nothing on the next start, and says nothing', async () => {
    const before = await vectorIndexes(database.db);
    const { log, lines } = recordingLogger();
    await bootstrap(database, log);
    expect(await vectorIndexes(database.db)).toEqual(before);
    expect(lines.map((line) => line.message).filter((message) => /vector index/.test(message))).toEqual([]);
  });

  it('rebuilds every project index at the new dimension under RESET_VECTORS', async () => {
    const reset = DIMS / 2;
    const { log } = recordingLogger();
    await bootstrap(database, log, reset, true);

    const column = await database.db.execute(sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a WHERE a.attrelid = 'chunks'::regclass AND a.attname = 'embedding'`);
    expect((column.rows[0] as { type: string }).type).toBe(`vector(${reset})`);
    expect((await vectorIndexes(database.db)).map(({ name, valid }) => ({ name, valid }))).toEqual(
      Object.values(kept)
        .map((id) => ({ name: projectVectorIndexName(id), valid: true }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  });
});

// --- The generation swap -------------------------------------------------------------------------

/** Word-hash bag of words, L2-normalised — the deterministic stand-in the other indexer suites use. */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

/**
 * Parks the run at the start of its `n`-th `embedPassages` call — `index-generations.itest.ts`'s gate,
 * reduced to the one way out this file needs. Nothing sleeps: the run cannot advance until `release`.
 */
const gate = (() => {
  let calls = 0;
  let armedAt: number | null = null;
  let announce: (() => void) | null = null;
  let open: (() => void) | null = null;
  let held: Promise<void> | null = null;
  return {
    armAt(call: number): Promise<void> {
      calls = 0;
      armedAt = call;
      held = new Promise<void>((resolve) => {
        open = resolve;
      });
      return new Promise<void>((resolve) => {
        announce = resolve;
      });
    },
    release(): void {
      armedAt = null;
      open?.();
    },
    async pass(): Promise<void> {
      calls++;
      if (armedAt === null || calls !== armedAt) return;
      announce?.();
      await held;
    },
  };
})();

const embeddings: EmbeddingProvider = {
  id: MODEL_ID,
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: (text) => Math.ceil(text.length / 4),
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => {
    await gate.pass();
    return texts.map(stubVector);
  },
  embedQuery: async (text: string) => stubVector(text),
};

const indexerConfig = {
  ...WEB_LIMIT_DEFAULTS,
  ALLOWED_DOC_ROOTS: [] as string[],
  IGNORE_GLOBS: [] as string[],
  CHUNK_MAX_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 64,
  EMBEDDING_BATCH_SIZE: 64,
  DATA_DIR: '',
  SECRET_KEY: '0'.repeat(64),
  MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
  MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
  MAX_SPEC_FILE_BYTES: 8 * 1024 * 1024,
  MAX_PDF_PAGES: 2000,
  MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
  CONVERSION_TIMEOUT_MS: 120_000,
  CONVERSION_IDLE_MS: 60_000,
};

/** One chunk per file at these settings, so one `embedPassages` call is one document. */
const FILES = ['alpha.md', 'bravo.md', 'charlie.md', 'delta.md'];
const QUERY = 'rotate the alpha secret';

function body(marker: string, name: string): string {
  return `# ${name}\n\nThe ${marker} handbook explains how to rotate the ${name} secret from the source panel.\n`;
}

async function settle(db: Db, job: JobState): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (;;) {
    const project = await getProjectById(db, job.projectId);
    if (project?.status !== 'indexing') return job;
    if (Date.now() > deadline) throw new Error(`project row still says "indexing" after the job settled as ${job.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The dense half of a search of one generation, **through the project's own index** and nothing else:
 * four documents are nothing the planner would use an HNSW index for unprompted, so the alternatives
 * are taken away — `hnsw-scan.itest.ts`'s `forceVectorIndex`, for the same reason — and the plan it ran
 * under is read back in the same transaction. What is on trial is not the planner's taste at four rows
 * but whether the index holds both generations and the post-filter still separates them.
 */
async function throughProjectIndex(database: TestDatabase, projectId: string, generation: number): Promise<{ plan: string; contents: string[] }> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    await client.query('SET LOCAL enable_sort = off');
    await client.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
    const text = `SELECT c.content FROM chunks c WHERE c.project_id = $1::uuid AND c.index_generation = $2
      ORDER BY c.embedding <=> $3::vector LIMIT 10`;
    const parameters = [projectId, generation, `[${stubVector(QUERY).join(',')}]`];
    const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, parameters);
    const rows = await client.query<{ content: string }>(text, parameters);
    await client.query('COMMIT');
    return { plan: plan.rows.map((row) => row['QUERY PLAN']).join('\n'), contents: rows.rows.map((row) => row.content) };
  } finally {
    client.release();
  }
}

describe("a forced re-index, with both generations in the project's one index", () => {
  let database: TestDatabase;
  let root: string;
  let projectId: string;
  let indexer: Indexer;
  let indexOid: number;

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'vector_indexes_generations');
    await applySchema(database);
    root = await mkdtemp(path.join(tmpdir(), 'vector-indexes-'));
    for (const file of FILES) await writeFile(path.join(root, file), body('original', file.replace('.md', '')), 'utf8');

    // Through `createProject`, which is what builds the index — before the project has a single chunk,
    // so every row below reaches it by the incremental path a real index run takes.
    projectId = (await createProject(database.db, { name: 'handbook' }, [])).id;
    await database.db.insert(documentSources).values({ projectId, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
    // A neighbour with its own index and its own rows, so "the project's index" is told apart from
    // "whatever index there is".
    await createProject(database.db, { name: 'neighbour' }, []);

    indexer = new Indexer({
      db: database.db,
      embeddings,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
    });
    const first = await settle(database.db, indexer.enqueue(projectId));
    expect(first.phase).toBe('done');
    indexer.forget(projectId);

    const own = (await vectorIndexes(database.db)).find((index) => index.name === projectVectorIndexName(projectId));
    expect(own?.valid).toBe(true);
    indexOid = own?.oid ?? 0;
  });

  afterAll(async () => {
    gate.release();
    await rm(root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  it('serves the old generation from the index while the new one is written into it, then swaps', async () => {
    const ownIndex = projectVectorIndexName(projectId);

    const live = await throughProjectIndex(database, projectId, 0);
    expect(live.plan).toContain(ownIndex);
    expect(live.contents).toHaveLength(FILES.length);
    expect(live.contents.every((content) => content.includes('original'))).toBe(true);

    for (const file of FILES) await writeFile(path.join(root, file), body('replacement', file.replace('.md', '')), 'utf8');
    const reached = gate.armAt(2); // parked on the second document, with the first already written
    const job = indexer.enqueue(projectId, { force: true });
    await reached;

    // Mid-rebuild: generation 1 has a row, generation 0 still has all of its own, and both are being
    // read out of the same index — the post-filter on `index_generation` is what keeps them apart.
    const old = await throughProjectIndex(database, projectId, 0);
    expect(old.plan).toContain(ownIndex);
    expect(old.contents).toHaveLength(FILES.length);
    expect(old.contents.every((content) => content.includes('original'))).toBe(true);

    const next = await throughProjectIndex(database, projectId, 1);
    expect(next.plan).toContain(ownIndex);
    expect(next.contents).toHaveLength(1);
    expect(next.contents[0]).toContain('replacement');

    // The product's own read path during the rebuild: the live generation, unchanged.
    const during = await searchProject({ db: database.db, embeddings }, { projectId, query: QUERY, limit: 5 });
    expect(during.status).toBe('ok');
    if (during.status === 'ok') expect(during.hits.every((hit) => hit.content.includes('original'))).toBe(true);

    gate.release();
    const done = await settle(database.db, job);
    expect(done.phase).toBe('done');
    indexer.forget(projectId);

    const project = await getProjectById(database.db, projectId);
    expect(project?.liveGeneration).toBe(1);

    const swapped = await throughProjectIndex(database, projectId, 1);
    expect(swapped.plan).toContain(ownIndex);
    expect(swapped.contents).toHaveLength(FILES.length);
    expect(swapped.contents.every((content) => content.includes('replacement'))).toBe(true);
    // The generation it replaced was swept, and nothing of it is left in the index to be read.
    expect((await throughProjectIndex(database, projectId, 0)).contents).toEqual([]);

    const after = await searchProject({ db: database.db, embeddings }, { projectId, query: QUERY, limit: 5 });
    expect(after.status).toBe('ok');
    if (after.status === 'ok') {
      expect(after.hits.length).toBeGreaterThan(0);
      expect(after.hits.every((hit) => hit.content.includes('replacement'))).toBe(true);
    }

    // And the swap did no DDL: the same index, still valid, served both sides of it.
    const own = (await vectorIndexes(database.db)).find((index) => index.name === ownIndex);
    expect(own).toMatchObject({ oid: indexOid, valid: true });
    expect((await vectorIndexes(database.db)).every((index) => index.name.startsWith(PROJECT_VECTOR_INDEX_PREFIX))).toBe(true);
  });
});
