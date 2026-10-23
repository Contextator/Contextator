import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import cookie from '@fastify/cookie';
import { desc, eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { auditEvents, documentSources, indexRuns, projects } from '../../src/db/schema.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { AuditWriter } from '../../src/services/audit.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser } from '../../src/services/auth/users.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { createProject, getProjectById } from '../../src/services/projects.js';
import { directoryBytes, setProjectQuotas } from '../../src/services/quotas.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { searchProject } from '../../src/services/search.js';
import { createSource } from '../../src/services/sources.js';
import { UploadService } from '../../src/services/uploads.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * Per-project quotas ([ADR-0117](../../.ssot/ADR.md#adr-0117)), end to end: the admin API over a real
 * database and a real `UploadService` on a real directory, and the indexer over a real corpus.
 * The two halves share nothing but the file, so each owns a database.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const ADMIN = { authorization: 'Bearer a-token-for-a-test' };
// A cookie session's writes must look like the dashboard's ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
const SAME_SITE = { 'sec-fetch-site': 'same-origin' };

// ---------------------------------------------------------------- the admin API

let apiDb: TestDatabase;
let dataDir: string;

interface Api {
  app: FastifyInstance;
  audit: AuditWriter;
}

async function buildApi(db: Db, configOverrides: Record<string, unknown> = {}): Promise<Api> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie);
  const config = {
    ALLOWED_ORIGINS: [],
    ALLOWED_DOC_ROOTS: ['/docs'],
    CHUNK_MAX_TOKENS: 400,
    AUTH_SESSION_IDLE_MS: 60_000,
    AUTH_COOKIE_SECURE: '0',
    DATA_DIR: dataDir,
    DATA_DIR_MIN_FREE_BYTES: 0,
    EMBEDDING_DTYPE: 'fp32',
    SECRET_KEY: undefined,
    UPLOAD_MAX_FILE_BYTES: 1024 * 1024,
    UPLOAD_MAX_FILES_PER_REQUEST: 10,
    UPLOAD_MAX_ARCHIVE_BYTES: 1024 * 1024,
    ARCHIVE_MAX_ENTRIES: 100,
    ARCHIVE_MAX_TOTAL_BYTES: 1024 * 1024,
    PROJECT_MAX_DOCUMENTS: 0,
    PROJECT_MAX_CHUNKS: 0,
    PROJECT_MAX_UPLOAD_BYTES: 0,
    ADMIN_TOKEN: 'a-token-for-a-test',
    METRICS_TOKEN: 'a-scrape-token-long-enough',
    METRICS_PUBLIC: false,
    ...configOverrides,
  };
  const audit = new AuditWriter(db, silentLogger);
  const ctx = {
    config,
    db,
    log: silentLogger,
    embeddings: {
      id: 'local:stub:fp32',
      provider: 'local',
      model: 'stub',
      dimensions: DIMS,
      ready: true,
      maxInputTokens: 128,
      truncatesAtTokens: 512,
      windowSource: 'known-model',
    },
    chunkBudget: { checked: true },
    indexer: {
      stats: () => ({ interactive: 0, scheduled: 0, running: 0 }),
      isBusy: () => false,
      getJob: () => undefined,
      queueInfo: () => undefined,
      enqueue: (projectId: string) => ({ projectId, phase: 'queued' }),
    },
    locks: new KeyedMutex(),
    uploads: new UploadService(config as ConstructorParameters<typeof UploadService>[0]),
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    metrics: new MetricsRegistry(),
    audit,
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  return { app: instance, audit };
}

/** A multipart body with one part per `[filename, content]`. */
function multipart(parts: Array<[string, string]>): { payload: string; headers: Record<string, string> } {
  const boundary = 'contextator-quota-boundary';
  const body = parts
    .map(
      ([name, content]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n`,
    )
    .join('');
  return { payload: `${body}--${boundary}--\r\n`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function newUploadProject(name: string, quotas: Parameters<typeof setProjectQuotas>[2] = {}) {
  const project = await createProject(apiDb.db, { name }, []);
  const source = await createSource(apiDb.db, project.id, { type: 'upload', name: 'files' }, { allowedRoots: [], keys: { current: '0'.repeat(64) } });
  if (Object.keys(quotas).length > 0) await setProjectQuotas(apiDb.db, project.id, quotas);
  return { project, source };
}

describe('the project quotas API and the upload quota', () => {
  let api: Api;
  let memberCookie: string;
  let adminCookie: string;

  beforeAll(async () => {
    apiDb = await createTestDatabase(baseUrl, 'project_quotas_api');
    await applySchema(apiDb, DIMS);
    dataDir = await mkdtemp(path.join(tmpdir(), 'quotas-api-'));
    api = await buildApi(apiDb.db);

    const admin = await createUser(apiDb.db, { username: 'quota-admin', role: 'admin', password: 'administering-quotas-1!' });
    adminCookie = (await createSession(apiDb.db, admin.id, 1, { userAgent: 'probe' })).token;
    const member = await createUser(apiDb.db, { username: 'quota-member', role: 'member', password: 'a-member-password-1!' });
    memberCookie = (await createSession(apiDb.db, member.id, 1, { userAgent: 'probe' })).token;
    (globalThis as { __memberId?: string }).__memberId = member.id;
  });

  afterAll(async () => {
    await api.app.close();
    await dropTestDatabase(baseUrl, apiDb);
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('PATCH /api/projects/:id/quotas', () => {
    it('is refused to a project member, even one who can edit', async () => {
      const { project } = await newUploadProject('quota-member-denied');
      const memberId = (globalThis as { __memberId?: string }).__memberId!;
      await setMemberRole(apiDb.db, project.id, memberId, 'editor', null);

      const res = await api.app.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}/quotas`,
        cookies: { [SESSION_COOKIE]: memberCookie },
        headers: SAME_SITE,
        payload: { maxDocuments: 10 },
      });
      expect(res.statusCode).toBe(403);
      // Refused for the access level it lacks, not for the missing dashboard headers.
      expect(res.json().error).not.toBe('csrf_blocked');
      expect((await getProjectById(apiDb.db, project.id))?.maxDocuments).toBeNull();
    });

    it('lets an instance admin set, clear and exempt a quota, and shows where each limit came from', async () => {
      const { project } = await newUploadProject('quota-admin-sets');
      const inheriting = await buildApi(apiDb.db, { PROJECT_MAX_DOCUMENTS: 500, PROJECT_MAX_CHUNKS: 9000 });
      try {
        const patch = (payload: unknown) =>
          inheriting.app.inject({
            method: 'PATCH',
            url: `/api/projects/${project.id}/quotas`,
            cookies: { [SESSION_COOKIE]: adminCookie },
            headers: SAME_SITE,
            payload: payload as object,
          });

        const set = await patch({ maxDocuments: 25, maxChunks: 0 });
        expect(set.statusCode, set.body).toBe(200);
        expect(set.json().quotas).toMatchObject({
          documents: { limit: 25, used: 0, inherited: false },
          chunks: { limit: 0, used: 0, inherited: false },
          uploadBytes: { limit: 0, used: 0, inherited: true },
        });

        const cleared = await patch({ maxDocuments: null });
        expect(cleared.statusCode).toBe(200);
        expect(cleared.json().quotas.documents).toEqual({ limit: 500, used: 0, inherited: true });
        // The key that was absent kept its value: the project's own 0 still beats the instance's 9000.
        expect(cleared.json().quotas.chunks).toEqual({ limit: 0, used: 0, inherited: false });

        const read = await inheriting.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers: ADMIN });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json().quotas.documents).toEqual({ limit: 500, used: 0, inherited: true });
        expect(read.json().id).toBe(project.id);
      } finally {
        await inheriting.app.close();
      }
    });

    it('rejects values that are not whole non-negative numbers or null, unknown keys, and an empty body', async () => {
      const { project } = await newUploadProject('quota-bad-body');
      for (const payload of [{ maxDocuments: -1 }, { maxChunks: 1.5 }, { maxUploadBytes: '10' }, { unknown: 1 }, {}]) {
        const res = await api.app.inject({ method: 'PATCH', url: `/api/projects/${project.id}/quotas`, headers: ADMIN, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const gone = await api.app.inject({
        method: 'PATCH',
        url: '/api/projects/5c0e2f7a-7a39-4f7e-9e0a-0d3f1c2b3a4d/quotas',
        headers: ADMIN,
        payload: { maxDocuments: 1 },
      });
      expect(gone.statusCode).toBe(404);
    });

    it('leaves an audit record under the route template', async () => {
      const { project } = await newUploadProject('quota-audited');
      const res = await api.app.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}/quotas`,
        headers: ADMIN,
        payload: { maxUploadBytes: 4096 },
      });
      expect(res.statusCode).toBe(200);
      await api.audit.settled();
      const [event] = await apiDb.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'PATCH /api/projects/:id/quotas'))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      expect(event).toMatchObject({ actorKind: 'token', projectId: project.id, statusCode: 200 });
    });
  });

  describe('uploading against maxUploadBytes', () => {
    it('answers 413 with the numbers when a request would cross the limit, and keeps none of its files', async () => {
      const { project, source } = await newUploadProject('quota-413', { maxUploadBytes: 100 });
      const open = await api.app.inject({ method: 'POST', url: `/api/projects/${project.id}/sources/${source.id}/uploads`, headers: ADMIN });
      expect(open.statusCode).toBe(201);
      const session = open.json().session as string;

      const { payload, headers } = multipart([
        ['a.md', 'a'.repeat(60)],
        ['b.md', 'b'.repeat(60)],
      ]);
      const before = await directoryBytes(path.join(dataDir));
      const res = await api.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/sources/${source.id}/uploads/${session}/files`,
        headers: { ...ADMIN, ...headers },
        payload,
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        error: 'quota_exceeded',
        quota: 'max_upload_bytes',
        limit: 100,
        used: 0,
        requested: 120,
        message: expect.stringContaining('100 bytes of uploads'),
      });
      // Taken back as a whole: the first file fitted on its own, and it is not left staged.
      expect(await directoryBytes(path.join(dataDir))).toBe(before);
    });

    it('counts what earlier requests of the session and earlier commits already hold', async () => {
      const { project, source } = await newUploadProject('quota-cumulative', { maxUploadBytes: 100 });
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const post = async (session: string, parts: Array<[string, string]>) => {
        const { payload, headers } = multipart(parts);
        return api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload });
      };

      const first = (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
      expect((await post(first, [['one.md', 'x'.repeat(60)]])).statusCode).toBe(200);
      // Same session, second request: 60 staged + 60 more is over 100.
      const second = await post(first, [['two.md', 'y'.repeat(60)]]);
      expect(second.statusCode).toBe(413);
      expect(second.json()).toMatchObject({ limit: 100, used: 60, requested: 60 });

      const commit = await api.app.inject({ method: 'POST', url: `${url}/${first}/commit`, headers: ADMIN });
      expect(commit.statusCode).toBe(202);

      const read = await api.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers: ADMIN });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().quotas.uploadBytes).toEqual({ limit: 100, used: 60, inherited: false });

      // A new session may still open (60 < 100) but its 60 more bytes may not.
      const next = (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
      const refused = await post(next, [['three.md', 'z'.repeat(60)]]);
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toMatchObject({ used: 60, requested: 60 });
    });

    it('refuses to open a session once the project is at its limit', async () => {
      const { project, source } = await newUploadProject('quota-at-cap', { maxUploadBytes: 10 });
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const session = (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
      const { payload, headers } = multipart([['fill.md', 'f'.repeat(10)]]);
      expect((await api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload })).statusCode).toBe(
        200,
      );
      expect((await api.app.inject({ method: 'POST', url: `${url}/${session}/commit`, headers: ADMIN })).statusCode).toBe(202);

      const res = await api.app.inject({ method: 'POST', url, headers: ADMIN });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: 'quota_exceeded', quota: 'max_upload_bytes', limit: 10, used: 10, requested: 0 });
    });

    it('follows the instance default when the project has none, and 0 on the project lifts it', async () => {
      const strict = await buildApi(apiDb.db, { PROJECT_MAX_UPLOAD_BYTES: 50 });
      try {
        const inheriting = await newUploadProject('quota-inherits');
        const exempt = await newUploadProject('quota-exempt', { maxUploadBytes: 0 });
        const attempt = async (fx: Awaited<ReturnType<typeof newUploadProject>>) => {
          const url = `/api/projects/${fx.project.id}/sources/${fx.source.id}/uploads`;
          const session = (await strict.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
          const { payload, headers } = multipart([['big.md', 'b'.repeat(80)]]);
          return strict.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload });
        };
        const refused = await attempt(inheriting);
        expect(refused.statusCode).toBe(413);
        expect(refused.json()).toMatchObject({ limit: 50 });
        expect((await attempt(exempt)).statusCode).toBe(200);
      } finally {
        await strict.app.close();
      }
    });

    it('answers 503 and refuses the request when the stored bytes cannot be measured, while GET still answers', async () => {
      const { project, source } = await newUploadProject('quota-unmeasurable', { maxUploadBytes: 1000 });
      const sourceDir = path.join(dataDir, 'projects', project.id, 'sources', source.id);
      // Find where the service looks, rather than hard-coding the layout: a regular file where `current/` should be.
      const { sourceCurrentDir } = await import('../../src/services/data-dir.js');
      const current = sourceCurrentDir(dataDir, project.id, source.id);
      await mkdir(path.dirname(current), { recursive: true });
      await writeFile(current, 'a file where a directory belongs');
      expect(sourceDir).toBeTruthy();

      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const res = await api.app.inject({ method: 'POST', url, headers: ADMIN });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'quota_usage_unavailable' });

      const read = await api.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers: ADMIN });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().quotas.uploadBytes).toEqual({ limit: 1000, used: null, inherited: false });
    });
  });
});

// ---------------------------------------------------------------- the indexer

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
  PROJECT_MAX_DOCUMENTS: 0,
  PROJECT_MAX_CHUNKS: 0,
};

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

async function generationsOf(db: Db, projectId: string): Promise<number[]> {
  const rows = await db.execute(sql`SELECT DISTINCT index_generation AS g FROM documents WHERE project_id = ${projectId} ORDER BY g`);
  return rows.rows.map((r) => (r as { g: number }).g);
}

describe('document and chunk quotas in an indexing run', () => {
  let database: TestDatabase;
  let root: string;
  let projectId: string;
  let indexer: Indexer;
  let baseline: string[];

  const makeIndexer = (overrides: Partial<typeof indexerConfig> = {}): Indexer =>
    new Indexer({
      db: database.db,
      embeddings,
      config: { ...indexerConfig, ...overrides, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
    });

  const run = async (opts?: { force?: boolean }, using: Indexer = indexer): Promise<JobState> => {
    const job = await settle(database.db, using.enqueue(projectId, opts));
    using.forget(projectId);
    return job;
  };

  const hitsFor = async (query = QUERY): Promise<string[]> => {
    const outcome = await searchProject({ db: database.db, embeddings }, { projectId, query, limit: 8 });
    expect(outcome.status).toBe('ok');
    return outcome.status === 'ok' ? outcome.hits.map((h) => `${h.file}|${h.content}`) : [];
  };

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'project_quotas_index');
    await applySchema(database, DIMS);
    root = await mkdtemp(path.join(tmpdir(), 'quotas-index-'));
    for (const file of FILES) await writeFile(path.join(root, file), body('original', file.replace('.md', '')), 'utf8');
    const [project] = await database.db.insert(projects).values({ name: 'quota-index' }).returning({ id: projects.id });
    projectId = project.id;
    await database.db.insert(documentSources).values({ projectId, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
    indexer = makeIndexer();

    const first = await run();
    expect(first.phase).toBe('done');
    const live = await getProjectById(database.db, projectId);
    expect(live).toMatchObject({ documentCount: FILES.length, liveGeneration: 0 });
    baseline = await hitsFor();
    expect(baseline.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  it('ends an incremental run that would add a document over the limit, and leaves the index as it was', async () => {
    await writeFile(path.join(root, 'echo.md'), body('original', 'echo'), 'utf8');
    await setProjectQuotas(database.db, projectId, { maxDocuments: FILES.length });

    const job = await run();
    expect(job.phase).toBe('error');
    expect(job.errorCode).toBe('quota_exceeded');
    expect(job.error).toMatch(/4 documents/);

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ status: 'error', documentCount: FILES.length, liveGeneration: 0 });
    expect(await hitsFor()).toEqual(baseline);
    const [latest] = await database.db.select().from(indexRuns).where(eq(indexRuns.projectId, projectId)).orderBy(desc(indexRuns.startedAt)).limit(1);
    expect(latest?.status).toBe('error');

    await rm(path.join(root, 'echo.md'));
  });

  it('ends a forced rebuild that would hold too many documents, publishing nothing', async () => {
    await setProjectQuotas(database.db, projectId, { maxDocuments: FILES.length - 1 });

    const job = await run({ force: true });
    expect(job.phase).toBe('error');
    expect(job.errorCode).toBe('quota_exceeded');

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ liveGeneration: 0, documentCount: FILES.length });
    expect(await generationsOf(database.db, projectId)).toEqual([0]);
    expect(await hitsFor()).toEqual(baseline);
  });

  it('applies the instance default to a project with no limit of its own, and 0 on the project lifts it', async () => {
    await setProjectQuotas(database.db, projectId, { maxDocuments: null });
    const strict = makeIndexer({ PROJECT_MAX_DOCUMENTS: FILES.length - 1 });

    const refused = await run({ force: true }, strict);
    expect(refused.phase).toBe('error');
    expect(refused.errorCode).toBe('quota_exceeded');
    expect(await generationsOf(database.db, projectId)).toEqual([0]);

    await setProjectQuotas(database.db, projectId, { maxDocuments: 0 });
    const lifted = await run({ force: true }, strict);
    expect(lifted.phase).toBe('done');
    expect(lifted.errorCode).toBeUndefined();
    expect(await generationsOf(database.db, projectId)).toEqual([1]);
    baseline = await hitsFor();
  });

  it('ends a forced rebuild at the chunk that crosses the limit and keeps serving the previous generation', async () => {
    const live = await getProjectById(database.db, projectId);
    await setProjectQuotas(database.db, projectId, { maxDocuments: 0, maxChunks: 2 });

    const job = await run({ force: true });
    expect(job.phase).toBe('error');
    expect(job.errorCode).toBe('quota_exceeded');
    expect(job.error).toMatch(/2 chunks/);

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ liveGeneration: live?.liveGeneration, chunkCount: live?.chunkCount, documentCount: FILES.length, status: 'error' });
    // The half-built generation was swept on the way out; only the live one is left.
    expect(await generationsOf(database.db, projectId)).toEqual([live?.liveGeneration]);
    expect(await hitsFor()).toEqual(baseline);
  });

  it('keeps the documents an incremental run finished before the breach, deletes nothing, and recounts', async () => {
    // Sorted order puts `aaa-new.md` first: it fits (5 chunks of 5), `zzz-big.md` is the one over.
    await writeFile(path.join(root, 'aaa-new.md'), body('fresh', 'aaa-new'), 'utf8');
    await writeFile(path.join(root, 'zzz-big.md'), body('fresh', 'zzz-big'), 'utf8');
    await setProjectQuotas(database.db, projectId, { maxChunks: FILES.length + 1 });

    const job = await run();
    expect(job.phase).toBe('error');
    expect(job.errorCode).toBe('quota_exceeded');

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ status: 'error', documentCount: FILES.length + 1, chunkCount: FILES.length + 1 });

    const hits = await hitsFor('fresh aaa new secret rotate');
    expect(hits.some((h) => h.startsWith('aaa-new.md|') || h.includes('aaa-new.md|'))).toBe(true);
    expect(hits.some((h) => h.includes('zzz-big.md|'))).toBe(false);
    // Every document that was indexed before the run is still there.
    const old = await hitsFor();
    for (const file of FILES)
      expect(old.concat(await hitsFor(`rotate the ${file.replace('.md', '')} secret`)).some((h) => h.includes(`${file}|`))).toBe(true);
  });
});
