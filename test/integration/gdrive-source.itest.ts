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
import { clearGdriveTokenCache } from '../../src/services/sources/gdrive-client.js';
import { GdriveDriver } from '../../src/services/sources/gdrive.js';
import { createSource, storedProbeToken, updateSource } from '../../src/services/sources.js';
import { DOC, makeTestKey, StubDrive, type TestKey } from '../support/gdrive-stub.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A Google Drive source, end to end ([ADR-0127](../../.ssot/ADR.md#adr-0127)): the driver signs in, walks the
 * folders and exports or downloads through the egress guard and its host pin, the indexer turns the files
 * into documents with their Drive links, and `whats_new`'s record (`listDocumentChanges`) shows what happened
 * to them. Then the scheduler decides, twice, whether any of it needs doing again, and the admin API's Test
 * button is pressed.
 *
 * Google is a stub on the loopback interface (`test/support/gdrive-stub.ts`) reached by made-up host names
 * through the guard, with the RS256 assertion verified the way Google verifies it. The real API is checked by
 * `scripts/smoke-gdrive.ts`, which the operator runs with their own account.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const TOKEN_HOST = 'oauth.fixture.test';
const API_HOST = 'drive.fixture.test';
const ADMIN_TOKEN = 'a-token-for-the-gdrive-itest';

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

let key: TestKey;
let stub: StubDrive;
let database: TestDatabase;
let project: ProjectRow;
let source: DocumentSourceRow;
let indexer: Indexer;
let config: Config;
let dataDir: string;
let schedulerConfig: Parameters<typeof runSyncTick>[0]['config'];
let rootId: string;

const guideId: { current: string } = { current: '' };
const stateId: { current: string } = { current: '' };
const notesId: { current: string } = { current: '' };

/** What the registered factory hands every driver the scheduler, the indexer and the admin API build. */
const seams = { egress: undefined as ConstructorParameters<typeof GdriveDriver>[2], options: {} as ConstructorParameters<typeof GdriveDriver>[3] };
registerDriver('gdrive', (row, ctx) => new GdriveDriver(row, ctx, seams.egress, seams.options));

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

const rowOf = async (relativePath: string) => {
  const [row] = await database.db
    .select({ content: documents.content, sourceUrl: documents.sourceUrl, sourceModifiedAt: documents.sourceModifiedAt })
    .from(documents)
    .where(sql`${documents.projectId} = ${project.id} AND ${documents.relativePath} = ${relativePath}`);
  return row;
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
  clearGdriveTokenCache();
  key = makeTestKey();
  stub = new StubDrive(key);
  await stub.start();
  // Both made-up hosts resolve to one public-looking address, which `route` dials on the loopback interface.
  seams.egress = {
    resolve: async (host) => {
      if (host !== TOKEN_HOST && host !== API_HOST) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: '203.0.113.7', family: 4 }];
    },
    route: (address) => (address === '203.0.113.7' ? '127.0.0.1' : address),
  };
  seams.options = { retryDelayMs: 1, endpoints: stub.endpoints(TOKEN_HOST, API_HOST) };

  const root = stub.folder('Handbook');
  rootId = root.id;
  guideId.current = stub.add({
    name: 'Guide',
    mimeType: DOC,
    parent: root.id,
    content: '# Guide\n\nThe guide explains rotation of the signing secret.\n',
  }).id;
  stateId.current = stub.add({ name: 'state.md', parent: root.id, content: '# State\n\nThe state page explains the backup schedule.\n' }).id;
  const sub = stub.folder('Sub', root.id);
  notesId.current = stub.add({ name: 'notes.txt', mimeType: 'text/plain', parent: sub.id, content: 'Plain notes about the release train.\n' }).id;
  stub.add({ name: 'diagram.png', mimeType: 'image/png', parent: root.id, content: 'not text' });

  database = await createTestDatabase(baseUrl, 'gdrive_source');
  await applySchema(database, DIMS);
  dataDir = await mkdtemp(path.join(tmpdir(), 'contextator-gdrive-itest-'));

  config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: dataDir,
    DATA_DIR: path.join(dataDir, '.data'),
    SECRET_KEY: '0'.repeat(64),
    CHUNK_MAX_TOKENS: '96',
    CHUNK_OVERLAP_TOKENS: '24',
    SEARCH_SCORE_FLOOR: '0.2',
  });
  indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  schedulerConfig = { ...config, SYNC_PROBES_PER_TICK: 10 };

  [project] = await database.db.insert(projects).values({ name: 'gdrive-project', embeddingModel: MODEL_ID }).returning();
  // Created through the service, as the admin API does, so the credential is the canonical document, encrypted,
  // and the two keys the server owns are written by it whatever the caller sent.
  source = await createSource(
    database.db,
    project.id,
    {
      type: 'gdrive',
      name: 'drive',
      config: { folderIds: [rootId], extensions: ['md', 'txt'], serviceAccountEmail: 'forged@example.com', changesCursor: '1' },
      secret: key.keyFile,
    },
    { allowedRoots: [dataDir], keys: keyringOf(config) },
  );
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  if (database) await dropTestDatabase(baseUrl, database);
  await stub?.stop();
});

describe('the stored credential and the keys the server owns', () => {
  it('is one encrypted document in canonical form, without the key file’s token_uri', async () => {
    const row = await sourceRow();
    expect(row.secretEnc).toBeTruthy();
    expect(row.secretEnc).not.toContain('PRIVATE KEY');
    const stored = JSON.parse(decryptSecret(row.secretEnc!, keyringOf(config))) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['v', 'clientEmail', 'privateKeyId', 'privateKey']);
    expect(JSON.stringify(stored)).not.toContain('evil.example.invalid');
  });

  it('writes the service account’s e-mail itself and ignores a forged one and a forged cursor', async () => {
    const row = await sourceRow();
    expect(row.config.serviceAccountEmail).toBe(key.clientEmail);
    expect(row.config).not.toHaveProperty('changesCursor');
  });
});

describe('a Drive source, indexed and then changed', () => {
  let afterFirstRun: Date;

  it('indexes the Docs export and the stored files under the folder’s name, with their Drive links', async () => {
    const job = await indexNow();
    expect(job.phase).toBe('done');
    expect(await documentPaths()).toEqual(['drive/Handbook/Guide.md', 'drive/Handbook/Sub/notes.txt', 'drive/Handbook/state.md']);
    expect((await sourceRow()).status).toBe('idle');
    const cursor = String(stub.changeId);
    expect(storedProbeToken((await sourceRow()).config)).toBe(cursor);
    expect((await sourceRow()).config.changesCursor).toBe(cursor);

    const guide = await rowOf('drive/Handbook/Guide.md');
    expect(guide?.content).toContain('rotation of the signing secret');
    expect(guide?.sourceUrl).toBe(`https://drive.google.com/file/d/${guideId.current}/view`);
    expect(guide?.sourceModifiedAt).toBeInstanceOf(Date);
    afterFirstRun = await mark();
  });

  it('probes an unchanged Drive with one request', async () => {
    stub.reset();
    const probe = await new GdriveDriver(await sourceRow(), { db: database.db, log: silentLogger, config }, seams.egress, seams.options).probe();
    expect(probe).toBe(storedProbeToken((await sourceRow()).config));
    expect({ api: stub.apiRequests, changes: stub.count('changes'), token: stub.count('token') }).toEqual({ api: 1, changes: 1, token: 0 });
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

  it('lets the scheduler skip an unchanged Drive with one request and no walk', async () => {
    await makeDue();
    stub.reset();
    enqueued.length = 0;
    const result = await tick();
    expect(result).toMatchObject({ probed: 1, unchanged: 1 });
    expect(enqueued).toEqual([]);
    expect({ api: stub.apiRequests, list: stub.count('list'), media: stub.count('media'), exports: stub.count('export') }).toEqual({
      api: 1,
      list: 0,
      media: 0,
      exports: 0,
    });
  });

  it('re-indexes an edited Doc, indexes a new file and drops a trashed one', async () => {
    stub.update(guideId.current, '# Guide\n\nThe guide now explains rotation of the signing secret and the audit trail.\n');
    stub.add({ name: 'extra.md', parent: rootId, content: '# Extra\n\nThe extra page explains incident response.\n' });
    stub.trash(notesId.current);

    // The scheduler sees the change through the feed and queues the run.
    await makeDue();
    enqueued.length = 0;
    expect((await tick()).enqueued).toBe(1);
    expect(enqueued).toEqual([project.id]);

    stub.reset();
    const job = await indexNow();
    expect(job.phase).toBe('done');
    expect(await documentPaths()).toEqual(['drive/Handbook/Guide.md', 'drive/Handbook/extra.md', 'drive/Handbook/state.md']);
    expect((await rowOf('drive/Handbook/Guide.md'))?.content).toContain('audit trail');
    // Only the Doc and the new file were fetched; state.md was not, and the folders were listed again.
    expect({ exports: stub.count('export'), media: stub.count('media'), list: stub.count('list') }).toEqual({ exports: 1, media: 1, list: 2 });
    expect(storedProbeToken((await sourceRow()).config)).toBe(String(stub.changeId));
  });

  it('records the three changes for whats_new as added, modified and removed', async () => {
    expect(await changesSince(afterFirstRun)).toEqual([
      'added:drive/Handbook/extra.md',
      'modified:drive/Handbook/Guide.md',
      'removed:drive/Handbook/Sub/notes.txt',
    ]);
  });

  it('is quiet again once the run has stored its cursor', async () => {
    await makeDue();
    enqueued.length = 0;
    expect((await tick()).unchanged).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('shows a rename as a removal and an addition', async () => {
    const before = await mark();
    stub.rename(stateId.current, 'status.md');
    expect((await indexNow()).phase).toBe('done');
    expect(await changesSince(before)).toEqual(['added:drive/Handbook/status.md', 'removed:drive/Handbook/state.md']);
  });
});

describe('a service account key that is replaced', () => {
  it('forgets the cursor and the probe token, so the next check runs the source, and writes the new e-mail', async () => {
    const other = makeTestKey('second@contextator-test.iam.gserviceaccount.com');
    const before = await sourceRow();
    expect(before.config.changesCursor).toBeTruthy();
    const after = await updateSource(
      database.db,
      project.id,
      source.id,
      { secret: other.keyFile, config: { ...before.config, serviceAccountEmail: 'forged@example.com', changesCursor: '5' } },
      { allowedRoots: [dataDir], keys: keyringOf(config) },
    );
    expect(after.config.serviceAccountEmail).toBe('second@contextator-test.iam.gserviceaccount.com');
    expect(after.config).not.toHaveProperty('changesCursor');
    expect(storedProbeToken(after.config)).toBeUndefined();

    // Put the first key back, as the rest of the file expects it.
    await updateSource(database.db, project.id, source.id, { secret: key.keyFile }, { allowedRoots: [dataDir], keys: keyringOf(config) });
    expect((await sourceRow()).config.serviceAccountEmail).toBe(key.clientEmail);
  });

  it('keeps the server’s keys when only the folders change, and runs on the new folders', async () => {
    expect((await indexNow()).phase).toBe('done');
    const before = await sourceRow();
    const edited = await updateSource(
      database.db,
      project.id,
      source.id,
      { config: { ...before.config, folderIds: [rootId], serviceAccountEmail: 'forged@example.com', changesCursor: '7' } },
      { allowedRoots: [dataDir], keys: keyringOf(config) },
    );
    expect(edited.config.serviceAccountEmail).toBe(key.clientEmail);
    expect(edited.config.changesCursor).toBe(before.config.changesCursor);
    // Nothing else moved, so the probe token stayed with it.
    expect(storedProbeToken(edited.config)).toBe(storedProbeToken(before.config));
  });
});

describe('what the driver reaches', () => {
  it('refuses a download that redirects off Google’s hosts', async () => {
    const guarded = new GdriveDriver(
      await sourceRow(),
      { db: database.db, log: silentLogger, config: { ...config, DATA_DIR: path.join(dataDir, '.guarded') } },
      seams.egress,
      seams.options,
    );
    stub.redirectDownloadsTo = `http://evil.fixture.test:${stub.port}/steal`;
    stub.add({ name: 'redirected.md', parent: rootId, content: 'redirected' });
    try {
      await expect(guarded.sync()).rejects.toThrow('the server redirected to `evil.fixture.test`');
    } finally {
      stub.redirectDownloadsTo = undefined;
    }
    expect(stub.log.some((r) => r.host === 'evil.fixture.test')).toBe(false);
  });
});

describe('the admin API, as the panel uses it', () => {
  let app: FastifyInstance;
  let adminProject: ProjectRow;

  beforeAll(async () => {
    [adminProject] = await database.db.insert(projects).values({ name: 'gdrive-panel', embeddingModel: MODEL_ID }).returning();
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

  it('creates a source from the key file, tests it, shows the account to share with, and never returns the key', async () => {
    const created = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'gdrive',
      name: 'panel',
      index: false,
      syncIntervalMinutes: null,
      config: { folderIds: [rootId] },
      secret: key.keyFile,
    });
    expect(created.statusCode).toBe(201);
    const view = created.json() as { id: string; hasSecret: boolean; config: Record<string, unknown> };
    expect(view.hasSecret).toBe(true);
    expect(view.config).toMatchObject({ folderIds: [rootId], serviceAccountEmail: key.clientEmail });

    const tested = await call('POST', `/api/projects/${adminProject.id}/sources/${view.id}/test`);
    expect(tested.json()).toEqual({ ok: true, message: `Signed in as ${key.clientEmail} — 1 folder(s) shared with it: Handbook` });

    const listed = await call('GET', `/api/projects/${adminProject.id}/sources`);
    for (const response of [created, tested, listed]) {
      expect(response.body).not.toContain('PRIVATE KEY');
      expect(response.body).not.toContain(key.privateKeyId);
    }
  });

  it('refuses a credential that is not a service account key file, without echoing it', async () => {
    const oauth = JSON.stringify({
      type: 'authorized_user',
      client_id: 'abc',
      client_secret: 'hunter2-not-a-real-secret',
      refresh_token: 'refresh-not-real',
    });
    const refused = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'gdrive',
      name: 'oauth',
      index: false,
      config: { folderIds: [rootId] },
      secret: oauth,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_request' });
    expect(refused.body).toContain('service account');
    expect(refused.body).not.toContain('hunter2');
    expect(refused.body).not.toContain('refresh-not-real');

    const bare = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'gdrive',
      name: 'bare',
      index: false,
      config: { folderIds: [rootId] },
      secret: 'a-bare-token-is-not-a-key-file',
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.body).not.toContain('a-bare-token-is-not-a-key-file');
  });

  it('refuses a source with no folder', async () => {
    const response = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'gdrive',
      name: 'nofolder',
      index: false,
      config: { folderIds: [] },
      secret: key.keyFile,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('folderIds');
  });
});
