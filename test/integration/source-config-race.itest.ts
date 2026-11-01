import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { documentSources, projects, type DocumentSourceRow } from '../../src/db/schema.js';
import { keyringOf } from '../../src/services/crypto.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { createSource, PROBE_TOKEN_KEY, updateSource, type SourceServiceOptions } from '../../src/services/sources.js';
import { registerDriver } from '../../src/services/sources/driver.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A run writes its driver's `configPatch` back when it finishes, and it used to write
 * `{ ...source.config, ...configPatch }` — the config as the job **started**. A `PATCH` of the source that
 * landed while the sync was reading (a new host and its credential included) was put back to what it had been
 * (envelope item A-03, [ADR-0126](../../.ssot/ADR.md#adr-0126) decision 8).
 *
 * The driver here is a stub that stops in `sync()` until the test lets it go, which is the only way to place an
 * edit inside a run deterministically. It is registered for `github`, the type whose host setting (`apiBaseUrl`),
 * credential and cursor keys all matter to the cases below.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const SECRET_KEY = '0'.repeat(64);
const GHE = 'https://ghe.example.com/api/v3';

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
  embedPassages: async (texts: string[]) => texts.map(() => new Array<number>(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
  embedQuery: async () => new Array<number>(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
};

/** What the stub driver is told to do on the next `sync()`; armed by `runWithEditDuring` before the run is queued. */
const run: { entered: Promise<void>; markEntered: () => void; released: Promise<void>; release: () => void; patch: Record<string, unknown> } = {
  entered: Promise.resolve(),
  markEntered: () => undefined,
  released: Promise.resolve(),
  release: () => undefined,
  patch: {},
};

function arm(patch: Record<string, unknown>): void {
  run.patch = patch;
  run.entered = new Promise<void>((resolve) => (run.markEntered = resolve));
  run.released = new Promise<void>((resolve) => (run.release = resolve));
}

let database: TestDatabase;
let dataDir: string;
let indexer: Indexer;
let opts: SourceServiceOptions;

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'source_config_race');
  await applySchema(database, DIMS);
  dataDir = await mkdtemp(path.join(tmpdir(), 'source-config-race-'));
  const config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: dataDir,
    DATA_DIR: path.join(dataDir, '.data'),
    SECRET_KEY,
  });
  indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  opts = { allowedRoots: [dataDir], keys: keyringOf(config) };

  registerDriver('github', () => ({
    async sync() {
      run.markEntered();
      await run.released;
      return { configPatch: run.patch };
    },
    async docRoot() {
      const dir = path.join(dataDir, 'empty');
      await mkdir(dir, { recursive: true });
      return dir;
    },
  }));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  await dropTestDatabase(baseUrl, database);
});

async function seedSource(name: string, secret?: string): Promise<{ projectId: string; source: DocumentSourceRow }> {
  const [project] = await database.db.insert(projects).values({ name, embeddingModel: MODEL_ID }).returning();
  const source = await createSource(
    database.db,
    project.id,
    { type: 'github', name: 'repo', config: { owner: 'acme', repo: 'docs' }, ...(secret ? { secret } : {}) },
    opts,
  );
  return { projectId: project.id, source };
}

async function settle(job: JobState): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (;;) {
    const row = await getProjectById(database.db, job.projectId);
    if (row?.status !== 'indexing') return;
    if (Date.now() > deadline) throw new Error('project row still says "indexing" after the job settled');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Starts a run, waits until the driver is inside `sync()`, lets `during` edit the source, then lets the run finish. */
async function runWithEditDuring(projectId: string, patch: Record<string, unknown>, during: () => Promise<void>): Promise<void> {
  arm(patch);
  const job = indexer.enqueue(projectId, { trigger: 'manual' });
  await run.entered;
  await during();
  run.release();
  await settle(job);
  indexer.forget(projectId);
}

const stored = async (id: string): Promise<DocumentSourceRow> => {
  const [row] = await database.db.select().from(documentSources).where(eq(documentSources.id, id));
  return row;
};

describe("a run's configPatch against a source edited while it ran", () => {
  it('stores the patch when nothing else moved', async () => {
    const { projectId, source } = await seedSource('race-quiet');
    await runWithEditDuring(projectId, { issuesEtag: 'etag-1', [PROBE_TOKEN_KEY]: 'issues:etag-1' }, async () => undefined);

    const row = await stored(source.id);
    expect(row.status).toBe('idle');
    expect(row.config).toMatchObject({ owner: 'acme', repo: 'docs', issuesEtag: 'etag-1', [PROBE_TOKEN_KEY]: 'issues:etag-1' });
  });

  it('keeps a setting changed during the run, and still stores the cursor (but not the probe token of the old settings)', async () => {
    const { projectId, source } = await seedSource('race-setting');
    await runWithEditDuring(projectId, { issuesEtag: 'etag-2', [PROBE_TOKEN_KEY]: 'issues:etag-2' }, async () => {
      await updateSource(database.db, projectId, source.id, { config: { includeClosed: true } }, opts);
    });

    const row = await stored(source.id);
    expect(row.config).toMatchObject({ includeClosed: true, issuesEtag: 'etag-2' });
    // The edit removed the token on purpose; the run read the settings from before it.
    expect(row.config).not.toHaveProperty(PROBE_TOKEN_KEY);
  });

  it('keeps a new host and credential, and writes nothing of the old host back', async () => {
    const { projectId, source } = await seedSource('race-host', 'ghp_oldtoken');
    const before = await stored(source.id);
    await runWithEditDuring(
      projectId,
      { issuesEtag: 'etag-of-old-host', syncedSince: '2026-10-01T00:00:00.000Z', [PROBE_TOKEN_KEY]: 'issues:old' },
      async () => {
        await updateSource(database.db, projectId, source.id, { config: { apiBaseUrl: GHE }, secret: 'ghp_newtoken' }, opts);
      },
    );

    const row = await stored(source.id);
    expect(row.config).toMatchObject({ apiBaseUrl: GHE });
    expect(row.secretEnc).not.toBeNull();
    expect(row.secretEnc).not.toBe(before.secretEnc);
    expect(row.config).not.toHaveProperty('issuesEtag');
    expect(row.config).not.toHaveProperty('syncedSince');
    expect(row.config).not.toHaveProperty(PROBE_TOKEN_KEY);
    // The run itself still ended normally.
    expect(row.status).toBe('idle');
    expect(row.lastSyncedAt).not.toBeNull();
  });

  it('keeps a replaced credential on its own, without the old cursor coming back', async () => {
    const { projectId, source } = await seedSource('race-secret', 'ghp_oldtoken');
    await runWithEditDuring(projectId, { issuesEtag: 'etag-of-old-token' }, async () => {
      await updateSource(database.db, projectId, source.id, { secret: 'ghp_newtoken' }, opts);
    });

    const row = await stored(source.id);
    expect(row.config).not.toHaveProperty('issuesEtag');
  });

  it('removes a key the patch sets to undefined, as before', async () => {
    const { projectId, source } = await seedSource('race-undefined');
    await runWithEditDuring(projectId, { issuesEtag: 'etag-a' }, async () => undefined);
    await runWithEditDuring(projectId, { issuesEtag: undefined, syncedSince: '2026-10-02T00:00:00.000Z' }, async () => undefined);

    const row = await stored(source.id);
    expect(row.config).not.toHaveProperty('issuesEtag');
    expect(row.config).toMatchObject({ syncedSince: '2026-10-02T00:00:00.000Z' });
  });
});
