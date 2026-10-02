import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, indexRuns, projects } from '../../src/db/schema.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { INTERRUPTED_RUN_MESSAGE, recoverInterruptedRuns } from '../../src/services/index-runs.js';
import { runStartupMaintenance } from '../../src/services/startup-maintenance.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The two ways a run can fail to happen that are not about its content: the process died under it,
 * and the disk would not have held it.
 *
 * **A restart is simulated by the state it leaves behind**, not by killing anything: the only trace a
 * killed run leaves is `projects.status = 'indexing'` (its `index_runs` row is written when it
 * finishes, and it never did). Setting that column by hand is exactly the database a fresh process
 * finds, and `recoverInterruptedRuns` is exactly what that process runs on startup.
 *
 * **A full disk is simulated by a threshold no disk meets.** Filling a real file system is neither
 * portable nor kind to the machine running the suite; `DATA_DIR_MIN_FREE_BYTES` above any possible
 * free space is the same comparison failing for the same reason. The disk a rebuild is checked
 * against is the embedded database's (`CONTEXTATOR_EMBEDDED_PGDATA`); a temporary directory stands in
 * for it, and leaving it unset is the external-database topology, where no check is made.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const NO_DISK_IS_THIS_BIG = Number.MAX_SAFE_INTEGER;

function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const embeddings: EmbeddingProvider = {
  id: 'local:stub-bag-of-words:fp32',
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
  embedPassages: async (texts: string[]) => texts.map(stubVector),
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

/** Waits for the job to settle and then for the project row to stop saying `indexing` (see index-generations.itest.ts). */
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

async function runsOf(db: Db, projectId: string) {
  return db.select().from(indexRuns).where(eq(indexRuns.projectId, projectId)).orderBy(desc(indexRuns.finishedAt), desc(indexRuns.startedAt));
}

let database: TestDatabase;
let root: string;
let indexer: Indexer;
/** The same queue on the embedded topology with a threshold no disk meets — everything else identical. */
let fullDiskIndexer: Indexer;
/** The same threshold with an external database: no `CONTEXTATOR_EMBEDDED_PGDATA`, so nothing to measure. */
let externalDbIndexer: Indexer;

async function addProject(name: string): Promise<string> {
  const [project] = await database.db.insert(projects).values({ name }).returning({ id: projects.id });
  await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
  return project.id;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'run_recovery');
  await applySchema(database, DIMS);
  root = await mkdtemp(path.join(tmpdir(), 'run-recovery-'));
  await writeFile(path.join(root, 'alpha.md'), '# Alpha\n\nHow to rotate the alpha secret.\n', 'utf8');
  await writeFile(path.join(root, 'bravo.md'), '# Bravo\n\nHow to rotate the bravo secret.\n', 'utf8');
  const config = { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') };
  indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  fullDiskIndexer = new Indexer({
    db: database.db,
    embeddings,
    config: { ...config, DATA_DIR_MIN_FREE_BYTES: NO_DISK_IS_THIS_BIG, CONTEXTATOR_EMBEDDED_PGDATA: root },
    log: silentLogger,
    locks: new KeyedMutex(),
  });
  externalDbIndexer = new Indexer({
    db: database.db,
    embeddings,
    config: { ...config, DATA_DIR_MIN_FREE_BYTES: NO_DISK_IS_THIS_BIG },
    log: silentLogger,
    locks: new KeyedMutex(),
  });
});

afterAll(async () => {
  await indexer?.stop();
  await fullDiskIndexer?.stop();
  await externalDbIndexer?.stop();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('a run the previous process did not live to finish', () => {
  let stuckId: string;
  let idleId: string;
  let requeued: JobState[];
  let recovered: string[];

  beforeAll(async () => {
    stuckId = await addProject('stuck');
    idleId = await addProject('untouched');
    for (const id of [stuckId, idleId]) {
      expect((await settle(database.db, indexer.enqueue(id))).phase).toBe('done');
      indexer.forget(id);
    }
    // What a process killed mid-run leaves: the status it set on starting, and no history row.
    await database.db.update(projects).set({ status: 'indexing' }).where(eq(projects.id, stuckId));

    requeued = [];
    recovered = await recoverInterruptedRuns(database.db, (id) => requeued.push(indexer.enqueue(id, { trigger: 'scheduled' })), silentLogger);
  });

  it('is found, and only it: a project that was not indexing is left alone', () => {
    expect(recovered).toEqual([stuckId]);
    expect(requeued.map((job) => job.projectId)).toEqual([stuckId]);
  });

  it('goes into the history as interrupted, with the reason, in the background lane', async () => {
    const interrupted = (await runsOf(database.db, stuckId)).filter((r) => r.status === 'interrupted');
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ error: INTERRUPTED_RUN_MESSAGE, trigger: 'scheduled', mode: 'incremental' });
    expect(await runsOf(database.db, idleId)).toSatisfy((rows: { status: string }[]) => rows.every((r) => r.status === 'done'));
  });

  it('is run again to completion, which releases the project', async () => {
    const job = await settle(database.db, requeued[0]);
    expect(job).toMatchObject({ phase: 'done', trigger: 'scheduled' });
    const project = await getProjectById(database.db, stuckId);
    expect(project).toMatchObject({ status: 'idle', lastError: null });
    expect(project!.documentCount).toBe(2);
    const [latest] = await runsOf(database.db, stuckId);
    expect(latest.status).toBe('done');
  });

  it('is recovered once: a second pass finds nothing left in indexing', async () => {
    const again = await recoverInterruptedRuns(
      database.db,
      () => {
        throw new Error('nothing should be queued twice');
      },
      silentLogger,
    );
    expect(again).toEqual([]);
  });
});

describe("a forced re-index with the embedded database's disk below DATA_DIR_MIN_FREE_BYTES", () => {
  let projectId: string;
  let before: NonNullable<Awaited<ReturnType<typeof getProjectById>>>;

  beforeAll(async () => {
    projectId = await addProject('disk-full');
    expect((await settle(database.db, indexer.enqueue(projectId))).phase).toBe('done');
    indexer.forget(projectId);
    before = (await getProjectById(database.db, projectId))!;
  });

  it('still runs incrementally, which writes into the live generation and needs no second copy', async () => {
    const job = await settle(database.db, fullDiskIndexer.enqueue(projectId));
    expect(job.phase).toBe('done');
    fullDiskIndexer.forget(projectId);
  });

  it('is refused with insufficient_disk, and the live index stays exactly as it was', async () => {
    const job = await settle(database.db, fullDiskIndexer.enqueue(projectId, { force: true }));
    expect(job).toMatchObject({ phase: 'error', errorCode: 'insufficient_disk' });
    expect(job.error).toContain('DATA_DIR_MIN_FREE_BYTES');
    expect(job.error).toContain("embedded database's data directory");

    const project = (await getProjectById(database.db, projectId))!;
    // The message lands where the dashboard already shows a project's error.
    expect(project.status).toBe('error');
    expect(project.lastError).toBe(job.error);
    expect(project).toMatchObject({
      liveGeneration: before.liveGeneration,
      documentCount: before.documentCount,
      chunkCount: before.chunkCount,
    });

    const [latest] = await runsOf(database.db, projectId);
    expect(latest).toMatchObject({ status: 'error', mode: 'force', error: job.error });
  });
});

describe('a forced re-index with an external database', () => {
  it('is not checked, because that disk cannot be measured from here, and runs', async () => {
    const projectId = await addProject('external-db');
    expect((await settle(database.db, indexer.enqueue(projectId))).phase).toBe('done');
    indexer.forget(projectId);
    const job = await settle(database.db, externalDbIndexer.enqueue(projectId, { force: true }));
    expect(job).toMatchObject({ phase: 'done', force: true });
    externalDbIndexer.forget(projectId);
  });
});

describe('recovery of several interrupted projects', () => {
  it('still recovers the rest when one of them fails', async () => {
    const firstId = await addProject('fails-to-requeue');
    const secondId = await addProject('requeues-fine');
    await database.db.update(projects).set({ status: 'indexing' }).where(eq(projects.id, firstId));
    await database.db.update(projects).set({ status: 'indexing' }).where(eq(projects.id, secondId));

    const queued: string[] = [];
    const recovered = await recoverInterruptedRuns(
      database.db,
      (id) => {
        if (id === firstId) throw new Error('queue refused this one');
        queued.push(id);
      },
      silentLogger,
    );

    expect(recovered).toEqual([secondId]);
    expect(queued).toEqual([secondId]);
    // The failed one is still out of `indexing`, so its sources can be edited and it can be re-run.
    for (const id of [firstId, secondId]) {
      expect(await getProjectById(database.db, id)).toMatchObject({ status: 'error', lastError: INTERRUPTED_RUN_MESSAGE });
    }
  });
  it('still queues the re-run when writing the history row fails', async () => {
    const stuckId = await addProject('history-write-fails');
    await database.db.update(projects).set({ status: 'indexing' }).where(eq(projects.id, stuckId));
    // History is best-effort (ADR-0024); a database that refuses the insert must not cost the re-run.
    const historyRefusingDb = new Proxy(database.db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return () => {
            throw new Error('history write refused');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const queued: string[] = [];
    const recovered = await recoverInterruptedRuns(historyRefusingDb, (id) => queued.push(id), silentLogger);

    expect(recovered).toEqual([stuckId]);
    expect(queued).toEqual([stuckId]);
    expect(await getProjectById(database.db, stuckId)).toMatchObject({ status: 'error', lastError: INTERRUPTED_RUN_MESSAGE });
    const history = await database.db.select().from(indexRuns).where(eq(indexRuns.projectId, stuckId));
    expect(history).toEqual([]);
  });
});

describe('startup maintenance', () => {
  it('re-queues an interrupted run in the background lane, even when the sweep before it fails', async () => {
    const stuckId = await addProject('stuck-at-startup');
    await database.db.update(projects).set({ status: 'indexing' }).where(eq(projects.id, stuckId));

    const queued: { projectId: string; trigger: unknown }[] = [];
    await runStartupMaintenance({
      db: database.db,
      dataDir: path.join(root, '.data'),
      // The generation sweep runs under each project's lock; a lock that throws is a sweep that fails.
      locks: {
        runExclusive: async () => {
          throw new Error('the generation sweep failed');
        },
      },
      indexer: {
        enqueue: (projectId, opts) => {
          queued.push({ projectId, trigger: opts?.trigger });
          return {} as JobState;
        },
      },
      log: silentLogger,
    });

    expect(queued).toEqual([{ projectId: stuckId, trigger: 'scheduled' }]);
    const interrupted = (await runsOf(database.db, stuckId)).filter((r) => r.status === 'interrupted');
    expect(interrupted).toHaveLength(1);
  });
});
