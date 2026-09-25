import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import { indexRuns } from '../../src/db/schema.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { ConflictError, createProject, deleteProject, getProjectById } from '../../src/services/projects.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * **A project delete and the start of a re-index never both happen.** `deleteProject` used to ask
 * "is it being indexed?" and then delete, and a re-index enqueued between the two started on a project
 * that was about to vanish. The decision is now taken again under the project's mutex — the one an
 * index run holds from the moment it touches the project — and the delete happens before that mutex
 * is released, while an index run re-reads the project once it holds the mutex and does nothing if the
 * project is gone.
 *
 * Every race here is placed, not hoped for: the enqueue happens inside the `isBusy` callback the delete
 * calls (first at the check outside the mutex, then at the one inside it), and the last case holds the
 * mutex itself and lets go only once the indexer is known to be waiting on it. None of it depends on
 * which of two promises the event loop happens to run first.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

/** A mutex that remembers who asked for it, so a test can wait for "the indexer is queued on it". */
class WatchedMutex extends KeyedMutex {
  readonly requests: string[] = [];
  private waiters: Array<() => void> = [];

  override runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.requests.push(key);
    for (const wake of this.waiters.splice(0)) wake();
    return super.runExclusive(key, fn);
  }

  /** Resolves once the mutex has been asked for `count` times in all. */
  async requested(count: number): Promise<void> {
    while (this.requests.length < count) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

const embeddings: EmbeddingProvider = {
  id: 'local:stub:fp32',
  provider: 'local',
  model: 'stub',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: (text) => Math.ceil(text.length / 4),
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => texts.map(() => [1, ...new Array<number>(DIMS - 1).fill(0)]),
  embedQuery: async () => [1, ...new Array<number>(DIMS - 1).fill(0)],
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

async function settled(job: JobState): Promise<JobState> {
  const deadline = Date.now() + 30_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return job;
}

describe('deleting a project while a re-index is on its way', () => {
  let database: TestDatabase;
  let dataDir: string;
  let locks: WatchedMutex;
  let indexer: Indexer;
  let counter = 0;

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'delete_project_race');
    await applySchema(database);
    dataDir = await mkdtemp(path.join(tmpdir(), 'delete-project-race-'));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  // A fresh indexer and mutex per case, so one case's job or lock history is never another's evidence.
  const fresh = () => {
    locks = new WatchedMutex();
    indexer = new Indexer({ db: database.db, embeddings, config: { ...indexerConfig, DATA_DIR: dataDir }, log: silentLogger, locks });
  };
  afterEach(async () => {
    await indexer?.stop();
  });

  const project = () => createProject(database.db, { name: `racer-${counter++}` }, []);
  const runsOf = async (id: string) => (await database.db.select().from(indexRuns).where(eq(indexRuns.projectId, id))).length;

  it('refuses the delete when the re-index was enqueued after the first look and before the mutex', async () => {
    fresh();
    const target = await project();
    let job: JobState | undefined;
    let looks = 0;

    const deleting = deleteProject(
      database.db,
      target.id,
      (id) => {
        looks++;
        if (looks === 1) {
          // The first look answers "not busy", and the re-index is enqueued right behind it.
          job = indexer.enqueue(id);
          return false;
        }
        return indexer.isBusy(id);
      },
      locks,
    );

    await expect(deleting).rejects.toBeInstanceOf(ConflictError);
    expect(looks).toBe(2);
    // The re-index went ahead on a project that is still there, and the project is still there after it.
    expect((await settled(job as JobState)).phase).toBe('done');
    expect(await getProjectById(database.db, target.id)).toBeDefined();
    expect(await runsOf(target.id)).toBe(1);
  });

  it('lets the delete through and stops the re-index when it was enqueued after the decision', async () => {
    fresh();
    const target = await project();
    let job: JobState | undefined;
    let looks = 0;

    const deleted = await deleteProject(
      database.db,
      target.id,
      (id) => {
        looks++;
        if (looks === 2) {
          // The look under the mutex answers "not busy" — and only then does the re-index arrive.
          job = indexer.enqueue(id);
          return false;
        }
        return indexer.isBusy(id);
      },
      locks,
    );

    expect(deleted.id).toBe(target.id);
    expect(looks).toBe(2);
    const settledJob = await settled(job as JobState);
    // The re-index never started: no `indexing` status, no run recorded, nothing to record it against.
    expect(settledJob.phase).toBe('error');
    expect(settledJob.error).toBe('Project no longer exists');
    expect(await getProjectById(database.db, target.id)).toBeUndefined();
    expect(await runsOf(target.id)).toBe(0);
  });

  it('stops a re-index that found the project and then waited on the mutex while it was deleted', async () => {
    fresh();
    const target = await project();

    // The mutex is held here while the indexer reads the project (it is there) and queues on the
    // mutex; the project goes while it waits — which is what `deleteProject` does under the mutex.
    let release!: () => void;
    const holding = locks.runExclusive(target.id, () => new Promise<void>((resolve) => (release = resolve)));
    await locks.requested(1);
    const job = indexer.enqueue(target.id);
    await locks.requested(2);
    expect(job.phase).toBe('syncing');

    await deleteProject(database.db, target.id, () => false, { runExclusive: (_key, fn) => fn() });
    release();
    await holding;

    const settledJob = await settled(job);
    expect(settledJob.phase).toBe('error');
    expect(settledJob.error).toBe('Project no longer exists');
    expect(await runsOf(target.id)).toBe(0);
  });
});
