import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import cookie from '@fastify/cookie';
import { eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, documents, projects, type DocumentSourceRow, type ProjectRow } from '../../src/db/schema.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { decryptSecret, keyringOf } from '../../src/services/crypto.js';
import { listDocumentChanges, type ListedChange } from '../../src/services/document-changes.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { runSyncTick, type SchedulerIndexer, type SyncTickResult } from '../../src/services/scheduler.js';
import { registerDriver } from '../../src/services/sources/driver.js';
import { S3Driver } from '../../src/services/sources/s3.js';
import { createSource, storedProbeToken } from '../../src/services/sources.js';
import { fakeResolver, publicFixture, routeToLoopback } from '../support/egress-seams.js';
import { MINIO_PASSWORD, MINIO_USER, startCountingProxy, startMinio, type CountingProxy, type MinioFixture } from './support/minio.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * An S3 source, end to end, against a real S3 server (MinIO) ([ADR-0126](../../.ssot/ADR.md#adr-0126)):
 * the driver lists and downloads through the egress guard, the indexer turns the objects into documents,
 * and `whats_new`'s record (`listDocumentChanges`) shows what happened to them. Then the scheduler decides,
 * twice, whether any of it needs doing again — and the admin API's Test button is pressed.
 *
 * **MinIO is reached through the guard, not around it.** The guard refuses loopback, so the source's
 * endpoint is the made-up host `s3.fixture.test`, which `resolve` answers with a public-looking address and
 * `route` dials on the loopback interface — where a counting proxy forwards to the container with the `Host`
 * header it arrived with (so the SigV4 signature still verifies). The proxy is how "the probe sent no
 * GetObject" is a count of what crossed the wire.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const BUCKET = 'contextator-docs';
const FIXTURE_HOST = 's3.fixture.test';
const ADMIN_TOKEN = 'a-token-for-the-s3-itest';
const KEY_PAIR = JSON.stringify({ v: 1, accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD });

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
  embedPassages: async (texts: string[]) => texts.map(stubVector),
  embedQuery: async (text: string) => stubVector(text),
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let minio: MinioFixture;
let proxy: CountingProxy;
let database: TestDatabase;
let project: ProjectRow;
let source: DocumentSourceRow;
let indexer: Indexer;
let config: Config;
let dataDir: string;
let schedulerConfig: Parameters<typeof runSyncTick>[0]['config'];

/** What the registered factory hands every driver the scheduler, the indexer and the admin API build. */
const seams: { current: ConstructorParameters<typeof S3Driver>[2] } = { current: undefined };
registerDriver('s3', (row, ctx) => new S3Driver(row, ctx, seams.current));

async function settle(db: Db, job: JobState): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await sleep(5);
  }
  for (;;) {
    const row = await getProjectById(db, job.projectId);
    if (row?.status !== 'indexing') return job;
    if (Date.now() > deadline) throw new Error(`project row still says "indexing" after the job settled as ${job.phase}`);
    await sleep(5);
  }
}

async function indexNow(): Promise<JobState> {
  const job = await settle(database.db, indexer.enqueue(project.id, { trigger: 'manual' }));
  indexer.forget(project.id);
  return job;
}

const sourceRow = async (): Promise<DocumentSourceRow> => {
  const [row] = await database.db.select().from(documentSources).where(eq(documentSources.id, source.id));
  return row;
};

const documentPaths = async (): Promise<string[]> =>
  (await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, project.id))).map((r) => r.p).sort();

const bodyOf = async (relativePath: string): Promise<string> => {
  const [row] = await database.db
    .select({ content: documents.content })
    .from(documents)
    .where(sql`${documents.projectId} = ${project.id} AND ${documents.relativePath} = ${relativePath}`);
  return row?.content ?? '';
};

/** A boundary taken from the database's clock, clear of the writes before it and after it. */
async function mark(): Promise<Date> {
  await sleep(40);
  const result = await database.db.execute(sql`SELECT (extract(epoch FROM now()) * 1000)::bigint AS ms`);
  const at = new Date(Number((result.rows[0] as { ms: string }).ms));
  await sleep(40);
  return at;
}

async function changesSince(since: Date): Promise<string[]> {
  const live = await getProjectById(database.db, project.id);
  const { changes }: { changes: ListedChange[] } = await listDocumentChanges(database.db, {
    projectId: project.id,
    liveGeneration: live?.liveGeneration ?? 0,
    since,
    limit: 200,
  });
  return changes.map((c) => `${c.change}:${c.path}`).sort();
}

async function makeDue(): Promise<void> {
  await database.db
    .update(documentSources)
    .set({ syncIntervalMinutes: 15, nextSyncAt: new Date(Date.now() - 60_000) })
    .where(eq(documentSources.id, source.id));
}

beforeAll(async () => {
  minio = await startMinio();
  proxy = await startCountingProxy({ host: minio.host, port: minio.port });
  await minio.createBucket(BUCKET);

  database = await createTestDatabase(baseUrl, 's3_source');
  await applySchema(database, DIMS);
  dataDir = await mkdtemp(path.join(tmpdir(), 'contextator-s3-itest-'));

  config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: dataDir,
    DATA_DIR: path.join(dataDir, '.data'),
    SECRET_KEY: '0'.repeat(64),
    CHUNK_MAX_TOKENS: '96',
    CHUNK_OVERLAP_TOKENS: '24',
    SEARCH_SCORE_FLOOR: '0.2',
  });
  seams.current = publicFixture(FIXTURE_HOST);
  indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  schedulerConfig = { ...config, SYNC_PROBES_PER_TICK: 10 };

  [project] = await database.db.insert(projects).values({ name: 's3-project', embeddingModel: MODEL_ID }).returning();
  // Created through the service, as the admin API does, so the credential is the canonical document, encrypted.
  source = await createSource(
    database.db,
    project.id,
    {
      type: 's3',
      name: 'bucket',
      config: { endpoint: `http://${FIXTURE_HOST}:${proxy.port}`, bucket: BUCKET, prefix: 'guides', extensions: ['md'] },
      secret: `  ${KEY_PAIR}  `,
    },
    { allowedRoots: [dataDir], keys: keyringOf(config) },
  );
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  if (database) await dropTestDatabase(baseUrl, database);
  await proxy?.stop();
  await minio?.stop();
});

describe('the stored credential', () => {
  it('is one encrypted document in canonical form', async () => {
    const row = await sourceRow();
    expect(row.secretEnc).toBeTruthy();
    expect(row.secretEnc).not.toContain(MINIO_PASSWORD);
    expect(decryptSecret(row.secretEnc!, keyringOf(config))).toBe(KEY_PAIR);
  });
});

describe('an S3 source, indexed and then changed', () => {
  let afterFirstRun: Date;

  it('indexes the objects under the prefix, without the prefix, and only the types it reads', async () => {
    await minio.putObject(BUCKET, 'guides/alpha.md', '# Alpha\n\nThe alpha guide explains rotation of the signing secret.\n');
    await minio.putObject(BUCKET, 'guides/nested/bravo.md', '# Bravo\n\nThe bravo guide explains the backup schedule.\n');
    await minio.putObject(BUCKET, 'guides/charlie.md', '# Charlie\n\nThe charlie guide explains the release train.\n');
    await minio.putObject(BUCKET, 'guides/diagram.png', 'not text');
    await minio.putObject(BUCKET, 'elsewhere/delta.md', '# Delta\n\nOutside the prefix.\n');

    const job = await indexNow();
    expect(job.phase).toBe('done');
    expect(await documentPaths()).toEqual(['bucket/alpha.md', 'bucket/charlie.md', 'bucket/nested/bravo.md']);
    expect((await sourceRow()).status).toBe('idle');
    expect(storedProbeToken((await sourceRow()).config)).toMatch(/^s3:v1:3:[0-9a-f]{64}$/);
    afterFirstRun = await mark();
  });

  it('probes an unchanged bucket with list requests only: no GetObject', async () => {
    proxy.reset();
    const probe = await new S3Driver(await sourceRow(), { db: database.db, log: silentLogger, config }, seams.current).probe();
    expect(probe).toBe(storedProbeToken((await sourceRow()).config));
    // One listing page for the prefix (ceil(5 keys / 1000)), and nothing else crossed the wire.
    expect({ list: proxy.count('list'), get: proxy.count('get'), all: proxy.requests.length }).toEqual({ list: 1, get: 0, all: 1 });
  });

  const enqueued: string[] = [];
  const recorder: SchedulerIndexer = {
    isBusy: () => false,
    enqueue: (projectId, opts = {}) => {
      enqueued.push(projectId);
      return {
        projectId,
        force: false,
        trigger: opts.trigger ?? 'manual',
        phase: 'queued',
        filesTotal: 0,
        filesDone: 0,
        filesSkipped: 0,
        filesRemoved: 0,
        chunksDone: 0,
        sources: [],
        queuedAt: new Date().toISOString(),
      };
    },
  };
  const tick = (): Promise<SyncTickResult> => runSyncTick({ db: database.db, indexer: recorder, log: silentLogger, config: schedulerConfig });

  it('lets the scheduler skip an unchanged bucket with one listing and no download', async () => {
    await makeDue();
    proxy.reset();
    enqueued.length = 0;
    const result = await tick();
    expect(result).toMatchObject({ probed: 1, unchanged: 1 });
    expect(enqueued).toEqual([]);
    expect({ list: proxy.count('list'), get: proxy.count('get') }).toEqual({ list: 1, get: 0 });
  });

  it('re-indexes an object whose ETag changed, indexes a new one and drops a deleted one', async () => {
    await minio.putObject(BUCKET, 'guides/alpha.md', '# Alpha\n\nThe alpha guide now explains rotation of the signing secret and the audit trail.\n');
    await minio.putObject(BUCKET, 'guides/echo.md', '# Echo\n\nThe echo guide explains incident response.\n');
    await minio.deleteObject(BUCKET, 'guides/nested/bravo.md');

    // The scheduler sees the change through the same listing and queues the run.
    await makeDue();
    enqueued.length = 0;
    expect((await tick()).enqueued).toBe(1);
    expect(enqueued).toEqual([project.id]);

    proxy.reset();
    const job = await indexNow();
    expect(job.phase).toBe('done');
    expect(await documentPaths()).toEqual(['bucket/alpha.md', 'bucket/charlie.md', 'bucket/echo.md']);
    expect(await bodyOf('bucket/alpha.md')).toContain('audit trail');
    // Only the two objects that changed were downloaded; charlie was not, and the run listed once.
    expect({ list: proxy.count('list'), get: proxy.count('get') }).toEqual({ list: 1, get: 2 });
    expect(storedProbeToken((await sourceRow()).config)).toMatch(/^s3:v1:3:/);
  });

  it('records the three changes for whats_new as added, modified and removed', async () => {
    expect(await changesSince(afterFirstRun)).toEqual(['added:bucket/echo.md', 'modified:bucket/alpha.md', 'removed:bucket/nested/bravo.md']);
  });

  it('is quiet again once the run has stored its token', async () => {
    await makeDue();
    enqueued.length = 0;
    expect((await tick()).unchanged).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('re-indexes an object whose ETag changed and whose size did not', async () => {
    // Same byte length ("train" → "trian"): only the ETag differs, so only the ETag can say it changed.
    const before = '# Charlie\n\nThe charlie guide explains the release train.\n';
    const after = '# Charlie\n\nThe charlie guide explains the release trian.\n';
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    await minio.putObject(BUCKET, 'guides/charlie.md', after);

    await makeDue();
    enqueued.length = 0;
    expect((await tick()).enqueued).toBe(1);

    proxy.reset();
    expect((await indexNow()).phase).toBe('done');
    expect(await bodyOf('bucket/charlie.md')).toContain('trian');
    expect({ list: proxy.count('list'), get: proxy.count('get') }).toEqual({ list: 1, get: 1 });
  });
});

describe('what the egress guard decides for an S3 endpoint', () => {
  const driverFor = (endpoint: string, hosts: string[], extra: ConstructorParameters<typeof S3Driver>[2]) =>
    new S3Driver(
      { ...source, config: { ...source.config, endpoint } } as DocumentSourceRow,
      { db: database.db, log: silentLogger, config: { ...config, SOURCE_ALLOWED_HOSTS: hosts } },
      extra,
    );

  it('refuses a private host that SOURCE_ALLOWED_HOSTS does not list, naming the rule, the host and the setting', async () => {
    const guarded = driverFor(`http://minio.corp:${proxy.port}`, [], {
      resolve: fakeResolver({ 'minio.corp': '10.9.8.7' }),
      route: routeToLoopback('10.9.8.7'),
    });
    proxy.reset();
    await expect(guarded.test()).rejects.toThrow(
      'refused: `minio.corp` resolves to a private address; list `minio.corp` in SOURCE_ALLOWED_HOSTS to allow it',
    );
    expect(proxy.requests).toEqual([]);
  });

  it('reaches the same host once it is listed', async () => {
    const listed = driverFor(`http://minio.corp:${proxy.port}`, ['minio.corp'], {
      resolve: fakeResolver({ 'minio.corp': '10.9.8.7' }),
      route: routeToLoopback('10.9.8.7'),
    });
    await expect(listed.test()).resolves.toContain(`Connected to s3://${BUCKET}/guides/`);
  });

  it('still refuses loopback for a listed host', async () => {
    const loopback = driverFor(`http://minio.corp:${proxy.port}`, ['minio.corp'], {
      resolve: fakeResolver({ 'minio.corp': '127.0.0.1' }),
      route: routeToLoopback(),
    });
    await expect(loopback.test()).rejects.toThrow(/`minio.corp` resolves to a loopback address/);
  });
});

describe('the admin API, as the panel uses it', () => {
  let app: FastifyInstance;
  let adminProject: ProjectRow;

  beforeAll(async () => {
    [adminProject] = await database.db.insert(projects).values({ name: 's3-panel', embeddingModel: MODEL_ID }).returning();
    app = Fastify({ logger: false });
    await app.register(cookie);
    const ctx = {
      config: { ...config, ADMIN_TOKEN },
      db: database.db,
      log: silentLogger,
      embeddings,
      indexer: { enqueue: () => ({}), isBusy: () => false, getJob: () => null, queueInfo: () => undefined },
      locks: new KeyedMutex(),
      uploads: {},
      sessions: {},
      setup: new SetupGate(),
      loginLimiter: new SlidingWindow(10, 1000),
      version: '0.0.0-test',
      startedAt: Date.now(),
    } as unknown as AppContext;
    await app.register(adminRoutes, { ctx });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, ...(payload ? { payload } : {}) });

  it('creates a source, tests it, and never returns the credential', async () => {
    const created = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 's3',
      name: 'panel',
      index: false,
      syncIntervalMinutes: null,
      config: { endpoint: `http://${FIXTURE_HOST}:${proxy.port}`, bucket: BUCKET, prefix: 'guides', region: '', pathStyle: null, extensions: ['md'] },
      secret: KEY_PAIR,
    });
    expect(created.statusCode).toBe(201);
    const view = created.json() as { id: string; hasSecret: boolean; config: Record<string, unknown> };
    expect(view.hasSecret).toBe(true);
    // A cleared region and addressing from the form are the defaults, not stored blanks.
    expect(view.config).toMatchObject({ bucket: BUCKET, prefix: 'guides', region: 'us-east-1' });
    expect(view.config).not.toHaveProperty('pathStyle');

    const tested = await call('POST', `/api/projects/${adminProject.id}/sources/${view.id}/test`);
    expect(tested.json()).toEqual({
      ok: true,
      message: `Connected to s3://${BUCKET}/guides/ on ${FIXTURE_HOST}:${proxy.port} — 3 object(s) with a readable type (.md) among 4 key(s) listed`,
    });

    const listed = await call('GET', `/api/projects/${adminProject.id}/sources`);
    for (const response of [created, tested, listed]) {
      expect(response.body).not.toContain(MINIO_PASSWORD);
      expect(response.body).not.toContain(MINIO_USER);
    }
  });

  it('refuses a credential that is not the key-pair document, and one that carries a session token, without echoing it', async () => {
    const bare = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 's3',
      name: 'bare',
      index: false,
      config: { bucket: BUCKET },
      secret: MINIO_PASSWORD,
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ error: 'invalid_request' });
    expect(bare.body).not.toContain(MINIO_PASSWORD);

    const temporary = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 's3',
      name: 'temporary',
      index: false,
      config: { bucket: BUCKET },
      secret: JSON.stringify({ v: 1, accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD, sessionToken: 'FwoGZXIvYXdzSESSION' }),
    });
    expect(temporary.statusCode).toBe(400);
    expect(temporary.body).toContain('sessionToken');
    expect(temporary.body).not.toContain('FwoGZXIvYXdzSESSION');
    expect(temporary.body).not.toContain(MINIO_PASSWORD);
  });
});
