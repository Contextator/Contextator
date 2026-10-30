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
import { GithubDriver } from '../../src/services/sources/github.js';
import { createSource, GITHUB_SERVER_KEYS, storedProbeToken, updateSource } from '../../src/services/sources.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, routeToLoopback } from '../support/egress-seams.js';
import { GOOD_TOKEN, OWNER, REPO, StubGithub } from '../support/github-stub.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A GitHub source, end to end ([ADR-0128](../../.ssot/ADR.md#adr-0128)): the driver reads the issues (and
 * Discussions) through the egress guard and its host pin, the indexer turns the files into documents with their
 * GitHub links, and `whats_new`'s record (`listDocumentChanges`) shows what happened to them. Then the scheduler
 * decides, twice, whether any of it needs doing again, a rate limit ends a run without moving the cursor, and the
 * admin API's Test button and its token rules are exercised.
 *
 * GitHub is a stub on the loopback interface (`test/support/github-stub.ts`) reached by a made-up host name through
 * the guard. The real API is checked by `scripts/smoke-github.ts`, which the operator runs with their own account.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const API_HOST = 'api.github.fixture.test';
const ADMIN_TOKEN = 'a-token-for-the-github-itest';

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

let stub: StubGithub;
let database: TestDatabase;
let project: ProjectRow;
let source: DocumentSourceRow;
let indexer: Indexer;
let config: Config;
let dataDir: string;
let schedulerConfig: Parameters<typeof runSyncTick>[0]['config'];

const ids = { rotate: 0, backup: 0, release: 0, old: 0 };

/** What the registered factory hands every driver the scheduler, the indexer and the admin API build. */
const seams = { egress: undefined as ConstructorParameters<typeof GithubDriver>[2], options: {} as ConstructorParameters<typeof GithubDriver>[3] };
registerDriver('github', (row, ctx) => new GithubDriver(row, ctx, seams.egress, seams.options));

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

const keys = () => ({ allowedRoots: [dataDir], keys: keyringOf(config) });

beforeAll(async () => {
  stub = new StubGithub();
  await stub.start();
  // The driver's clock is the real one here, so the stub's starts an hour before it: the fixture is older than the
  // five minutes an incremental run reaches back, and what the test changes afterwards is newer than the cursor.
  stub.nowMs = Date.now() - 60 * 60_000;
  seams.egress = {
    resolve: fakeResolver({ [API_HOST]: PUBLIC_FIXTURE_ADDRESS }),
    route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
  };
  seams.options = { retryDelayMs: 1, apiBase: stub.apiBase(API_HOST) };

  ids.rotate = stub.issue({ title: 'Rotate the signing secret' }).number;
  stub.comment(ids.rotate, 'The rotate-secret script handles the rotation of the signing secret.');
  ids.backup = stub.issue({ title: 'Backup schedule', body: 'The backup schedule runs nightly.' }).number;
  ids.release = stub.issue({ title: 'Release train' }).number;
  ids.old = stub.issue({ title: 'Settled decision', state: 'closed', body: 'A closed decision about the retention window.' }).number;
  stub.issue({ title: 'Fix a typo', pr: true });

  database = await createTestDatabase(baseUrl, 'github_source');
  await applySchema(database, DIMS);
  dataDir = await mkdtemp(path.join(tmpdir(), 'contextator-github-itest-'));

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

  [project] = await database.db.insert(projects).values({ name: 'github-project', embeddingModel: MODEL_ID }).returning();
  // Created through the service, as the admin API does: the token is stored encrypted as the bare string, and the
  // keys the server owns are written by the driver whatever the caller sent.
  source = await createSource(
    database.db,
    project.id,
    {
      type: 'github',
      name: 'gh',
      config: { owner: OWNER, repo: REPO, syncedSince: '2020-01-01T00:00:00Z', issuesEtag: 'W/"forged"', scope: 'forged' },
      secret: GOOD_TOKEN,
    },
    keys(),
  );
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  if (database) await dropTestDatabase(baseUrl, database);
  await stub?.stop();
});

describe('the stored token and the keys the server owns', () => {
  it('is the bare token, encrypted, never a JSON document', async () => {
    const row = await sourceRow();
    expect(row.secretEnc).toBeTruthy();
    expect(row.secretEnc).not.toContain(GOOD_TOKEN);
    expect(decryptSecret(row.secretEnc!, keyringOf(config))).toBe(GOOD_TOKEN);
  });

  it('drops a cursor and validators the caller sent', async () => {
    const row = await sourceRow();
    for (const key of GITHUB_SERVER_KEYS) expect(row.config).not.toHaveProperty(key);
    expect(row.config).toMatchObject({ owner: OWNER, repo: REPO, apiBaseUrl: 'https://api.github.com', includeClosed: false, includeBots: true });
  });

  it('allows a source with no token, which stores none', async () => {
    const open = await createSource(database.db, project.id, { type: 'github', name: 'tokenless', config: { owner: OWNER, repo: REPO } }, keys());
    expect(open.secretEnc).toBeNull();
    await database.db.delete(documentSources).where(eq(documentSources.id, open.id));
  });

  it('refuses Discussions with no token, on create and on an update that would leave none', async () => {
    await expect(
      createSource(
        database.db,
        project.id,
        { type: 'github', name: 'nodisc', config: { owner: OWNER, repo: REPO, includeDiscussions: true } },
        keys(),
      ),
    ).rejects.toThrow('includeDiscussions needs a token');

    const withToken = await createSource(
      database.db,
      project.id,
      { type: 'github', name: 'disc', config: { owner: OWNER, repo: REPO, includeDiscussions: true }, secret: GOOD_TOKEN },
      keys(),
    );
    await expect(updateSource(database.db, project.id, withToken.id, { secret: null }, keys())).rejects.toThrow('includeDiscussions needs a token');
    // Turning them off first makes removing the token legal.
    const off = await updateSource(
      database.db,
      project.id,
      withToken.id,
      { config: { owner: OWNER, repo: REPO, includeDiscussions: false }, secret: null },
      keys(),
    );
    expect(off.secretEnc).toBeNull();
    await database.db.delete(documentSources).where(eq(documentSources.id, withToken.id));
  });

  it('refuses a token a header could not carry, without echoing it', async () => {
    const bad = `${GOOD_TOKEN} with spaces`;
    const error = await createSource(
      database.db,
      project.id,
      { type: 'github', name: 'badtoken', config: { owner: OWNER, repo: REPO }, secret: bad },
      keys(),
    ).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('single word');
    expect((error as Error).message).not.toContain('with spaces');
  });
});

describe('a GitHub source, indexed and then changed', () => {
  let afterFirstRun: Date;

  it('indexes the open issues with their comments and their GitHub links, and leaves out closed issues and pull requests', async () => {
    const job = await indexNow();
    expect(job.phase).toBe('done');
    expect(await documentPaths()).toEqual([`gh/issues/${ids.rotate}.md`, `gh/issues/${ids.backup}.md`, `gh/issues/${ids.release}.md`].sort());
    const row = await sourceRow();
    expect(row.status).toBe('idle');
    expect(row.config.syncedSince).toBeTruthy();
    expect(row.config.lastFullRunAt).toBeTruthy();
    expect(storedProbeToken(row.config)).toBe(`issues:${String(row.config.issuesEtag)}`);

    const rotate = await rowOf(`gh/issues/${ids.rotate}.md`);
    expect(rotate?.content).toContain('rotation of the signing secret');
    expect(rotate?.sourceUrl).toBe(`https://github.com/${OWNER}/${REPO}/issues/${ids.rotate}`);
    expect(rotate?.sourceModifiedAt).toBeInstanceOf(Date);
    afterFirstRun = await mark();
  });

  it('probes an unchanged repository with one conditional request', async () => {
    stub.reset();
    const probe = await new GithubDriver(await sourceRow(), { db: database.db, log: silentLogger, config }, seams.egress, seams.options).probe();
    expect(probe).toBe(storedProbeToken((await sourceRow()).config));
    expect(stub.requests).toBe(1);
    expect(stub.log[0]).toMatchObject({ kind: 'newest', ifNoneMatch: (await sourceRow()).config.issuesEtag, authorization: `Bearer ${GOOD_TOKEN}` });
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

  it('lets the scheduler skip an unchanged repository with one request and no listing', async () => {
    await makeDue();
    stub.reset();
    enqueued.length = 0;
    const result = await tick();
    expect(result).toMatchObject({ probed: 1, unchanged: 1 });
    expect(enqueued).toEqual([]);
    expect({ requests: stub.requests, issues: stub.count('issues'), comments: stub.count('repo-comments') }).toEqual({
      requests: 1,
      issues: 0,
      comments: 0,
    });
  });

  it('re-indexes an issue with a new comment, indexes a new issue and drops one that was closed', async () => {
    stub.advance(120);
    stub.comment(ids.backup, 'The backup also covers the object store since the audit.');
    const added = stub.issue({ title: 'Incident response', body: 'The incident response checklist.' }).number;
    stub.close(ids.release);

    // The scheduler sees the change through the conditional request and queues the run.
    await makeDue();
    enqueued.length = 0;
    expect((await tick()).enqueued).toBe(1);
    expect(enqueued).toEqual([project.id]);

    stub.reset();
    const job = await indexNow();
    expect(job.phase).toBe('done');
    expect(await documentPaths()).toEqual([`gh/issues/${ids.rotate}.md`, `gh/issues/${ids.backup}.md`, `gh/issues/${added}.md`].sort());
    expect((await rowOf(`gh/issues/${ids.backup}.md`))?.content).toContain('object store');
    // An incremental run: the list was asked with `since`, and the issue nobody touched had no comment request.
    expect(stub.log.filter((r) => r.kind === 'issues').every((r) => r.query.since !== undefined)).toBe(true);
    expect(stub.log.filter((r) => r.kind === 'issue-comments').some((r) => r.path.includes(`/issues/${ids.rotate}/`))).toBe(false);
    expect(storedProbeToken((await sourceRow()).config)).toMatch(/^issues:/);
  });

  it('records the three changes for whats_new as added, modified and removed', async () => {
    const added = [...stub.issues.values()].find((issue) => issue.title === 'Incident response')?.number;
    expect(await changesSince(afterFirstRun)).toEqual(
      [`added:gh/issues/${added}.md`, `modified:gh/issues/${ids.backup}.md`, `removed:gh/issues/${ids.release}.md`].sort(),
    );
  });

  it('is quiet again once the run has stored its validator', async () => {
    await makeDue();
    enqueued.length = 0;
    expect((await tick()).unchanged).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('keeps a deleted issue until a full run finds it, and then records its removal', async () => {
    const before = await mark();
    stub.delete(ids.backup);
    stub.advance(10);
    stub.edit(ids.rotate, { body: 'Rotate the signing secret, revised.' });
    expect((await indexNow()).phase).toBe('done');
    expect(await documentPaths()).toContain(`gh/issues/${ids.backup}.md`);

    // The last full run is a day and more old: the next run lists every number.
    const row = await sourceRow();
    await database.db
      .update(documentSources)
      .set({ config: { ...row.config, lastFullRunAt: new Date(Date.now() - 48 * 3_600_000).toISOString() } })
      .where(eq(documentSources.id, source.id));
    expect((await indexNow()).phase).toBe('done');
    expect(await documentPaths()).not.toContain(`gh/issues/${ids.backup}.md`);
    expect(await changesSince(before)).toContain(`removed:gh/issues/${ids.backup}.md`);
  });
});

describe('a run that is stopped by GitHub', () => {
  it('ends as an error naming the reset time, and moves neither the cursor nor the validator', async () => {
    const before = await sourceRow();
    stub.advance(60);
    stub.comment(ids.rotate, 'Written while the limit was spent.');
    const reset = Math.floor((Date.now() + 3_600_000) / 1000);
    // The freshness request passes; the issue listing is refused.
    stub.scripted.push(
      { status: 200, body: [] },
      { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
    );
    await indexNow();
    const failed = await sourceRow();
    expect(failed.status).toBe('error');
    expect(failed.lastError).toContain('rate limit reached');
    expect(failed.lastError).toContain(new Date(reset * 1000).toISOString());
    expect(failed.config.syncedSince).toBe(before.config.syncedSince);
    expect(failed.config.issuesEtag).toBe(before.config.issuesEtag);
    expect(storedProbeToken(failed.config)).toBe(storedProbeToken(before.config));

    // The next run starts from the same cursor and finds what the failed one would have.
    expect((await indexNow()).phase).toBe('done');
    expect((await sourceRow()).status).toBe('idle');
    expect((await rowOf(`gh/issues/${ids.rotate}.md`))?.content).toContain('Written while the limit was spent.');
  });
});

describe('a token that is replaced', () => {
  it('forgets the cursor, the validators and the probe token, so the next check runs the source', async () => {
    const before = await sourceRow();
    expect(before.config.syncedSince).toBeTruthy();
    const after = await updateSource(
      database.db,
      project.id,
      source.id,
      {
        secret: 'fixture-replacement-token-not-a-real-credential',
        config: { ...before.config, syncedSince: '2020-01-01T00:00:00Z', issuesEtag: 'W/"forged"' },
      },
      keys(),
    );
    for (const key of GITHUB_SERVER_KEYS) expect(after.config).not.toHaveProperty(key);
    expect(storedProbeToken(after.config)).toBeUndefined();
    // Put the working token back, as the rest of the file expects it.
    await updateSource(database.db, project.id, source.id, { secret: GOOD_TOKEN }, keys());
    expect((await indexNow()).phase).toBe('done');
  });

  it('keeps the server’s keys, and the probe token with them, when an edit changes nothing', async () => {
    const before = await sourceRow();
    const edited = await updateSource(
      database.db,
      project.id,
      source.id,
      { config: { ...before.config, syncedSince: '2020-01-01T00:00:00Z', issuesEtag: 'W/"forged"' } },
      keys(),
    );
    expect(edited.config.syncedSince).toBe(before.config.syncedSince);
    expect(edited.config.issuesEtag).toBe(before.config.issuesEtag);
    expect(storedProbeToken(edited.config)).toBe(storedProbeToken(before.config));
  });
});

describe('what the driver reaches', () => {
  it('refuses a request that redirects off the API host, and sends the token nowhere else', async () => {
    const guarded = new GithubDriver(
      await sourceRow(),
      { db: database.db, log: silentLogger, config: { ...config, DATA_DIR: path.join(dataDir, '.guarded') } },
      seams.egress,
      seams.options,
    );
    stub.scripted.push({ status: 302, body: {}, headers: { location: `http://evil.fixture.test:${stub.port}/steal` } });
    await expect(guarded.sync()).rejects.toThrow('the server redirected to `evil.fixture.test`');
    expect(stub.log.some((r) => r.host === 'evil.fixture.test')).toBe(false);
  });
});

describe('the admin API, as the panel uses it', () => {
  let app: FastifyInstance;
  let adminProject: ProjectRow;

  beforeAll(async () => {
    [adminProject] = await database.db.insert(projects).values({ name: 'github-panel', embeddingModel: MODEL_ID }).returning();
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

  it('creates a tokenless source for a public repository, tests it, and never returns a token', async () => {
    const created = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'github',
      name: 'public',
      index: false,
      syncIntervalMinutes: null,
      config: { owner: OWNER, repo: REPO },
    });
    expect(created.statusCode).toBe(201);
    const view = created.json() as { id: string; hasSecret: boolean; config: Record<string, unknown> };
    expect(view.hasSecret).toBe(false);
    expect(view.config).toMatchObject({ owner: OWNER, repo: REPO, includeDiscussions: false });

    const tested = await call('POST', `/api/projects/${adminProject.id}/sources/${view.id}/test`);
    expect(tested.json()).toMatchObject({ ok: true });
    expect((tested.json() as { message: string }).message).toContain(`Connected to ${OWNER}/${REPO} (public), without a token`);
  });

  it('creates a source with a token and Discussions, tests it, and keeps the token out of every answer', async () => {
    const created = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'github',
      name: 'tokened',
      index: false,
      syncIntervalMinutes: null,
      config: { owner: OWNER, repo: REPO, includeDiscussions: true },
      secret: GOOD_TOKEN,
    });
    expect(created.statusCode).toBe(201);
    const view = created.json() as { id: string; hasSecret: boolean };
    expect(view.hasSecret).toBe(true);

    const tested = await call('POST', `/api/projects/${adminProject.id}/sources/${view.id}/test`);
    expect((tested.json() as { message: string }).message).toBe(`Connected to ${OWNER}/${REPO} (public), with a token — Discussions are readable`);
    const listed = await call('GET', `/api/projects/${adminProject.id}/sources`);
    for (const response of [created, tested, listed]) expect(response.body).not.toContain(GOOD_TOKEN);
  });

  it('refuses Discussions without a token as 400 invalid_request, naming the reason', async () => {
    const refused = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'github',
      name: 'nodiscussions',
      index: false,
      config: { owner: OWNER, repo: REPO, includeDiscussions: true },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_request' });
    expect(refused.body).toContain('needs a token');
  });

  it('refuses a plain-http API address and a malformed repository', async () => {
    const http = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'github',
      name: 'insecure',
      index: false,
      config: { owner: OWNER, repo: REPO, apiBaseUrl: 'http://ghe.example.com/api/v3' },
    });
    expect(http.statusCode).toBe(400);
    expect(http.body).toContain('apiBaseUrl');
    const malformed = await call('POST', `/api/projects/${adminProject.id}/sources`, {
      type: 'github',
      name: 'malformed',
      index: false,
      config: { owner: 'a/b', repo: REPO },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toContain('owner');
  });
});
