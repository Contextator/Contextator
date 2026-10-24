import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
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
import { auditEvents, documentSources, documents, indexRuns, projects } from '../../src/db/schema.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { AuditWriter } from '../../src/services/audit.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser } from '../../src/services/auth/users.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { ConversionService } from '../../src/services/conversion/client.js';
import { DocumentExtractionError } from '../../src/services/doc-types/index.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { stagingDir } from '../../src/services/data-dir.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { createProject, getProjectById } from '../../src/services/projects.js';
import { directoryBytes, projectUploadBytes, setProjectQuotas } from '../../src/services/quotas.js';
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

    it('lets concurrent file requests see each other: three sessions of 40 bytes against a limit of 100', async () => {
      const { project, source } = await newUploadProject('quota-concurrent', { maxUploadBytes: 100 });
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const sessions = await Promise.all(
        [1, 2, 3].map(async () => (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string),
      );
      const results = await Promise.all(
        sessions.map((session, i) => {
          const { payload, headers } = multipart([[`f${i}.md`, 'x'.repeat(40)]]);
          return api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload });
        }),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 413]);
      // What is on disk never exceeds the limit, whichever request lost.
      expect(await directoryBytes(path.join(dataDir, 'projects', project.id))).toBeLessThanOrEqual(100);
    });

    it('does not renew, and so does not 404, for a project without a quota', async () => {
      const { project, source } = await newUploadProject('quota-none-unknown-session');
      const unknown = '0'.repeat(32);
      const { payload, headers } = multipart([['a.md', 'hello']]);
      const res = await api.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/sources/${source.id}/uploads/${unknown}/files`,
        headers: { ...ADMIN, ...headers },
        payload,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().errors).toHaveLength(1);
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

    it('lets a tree be uploaded again over the same paths when it is larger than half the limit', async () => {
      const { project, source } = await newUploadProject('quota-reupload', { maxUploadBytes: 100 });
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const upload = async (mode: 'add' | 'replace', parts: Array<[string, string]>) => {
        const session = (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
        const { payload, headers } = multipart(parts);
        const put = await api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload });
        const commit =
          put.statusCode === 200 ? await api.app.inject({ method: 'POST', url: `${url}/${session}/commit?mode=${mode}`, headers: ADMIN }) : put;
        return { put, commit };
      };

      expect((await upload('add', [['a.md', 'a'.repeat(60)]])).commit.statusCode).toBe(202);
      // The same path again, 60 bytes: 60 stored + 60 staged only looks like 120 if the overwrite is counted twice.
      const again = await upload('add', [['a.md', 'b'.repeat(60)]]);
      expect(again.put.statusCode, again.put.body).toBe(200);
      expect(again.commit.statusCode, again.commit.body).toBe(202);
      // A different path is a real addition and is still refused.
      expect((await upload('add', [['other.md', 'c'.repeat(60)]])).put.statusCode).toBe(413);
      // A replace commits against what is kept after the old tree goes, so a smaller tree is accepted.
      const replaced = await upload('replace', [['fresh.md', 'd'.repeat(40)]]);
      expect(replaced.put.statusCode, replaced.put.body).toBe(200);
      expect(replaced.commit.statusCode, replaced.commit.body).toBe(202);
    });

    it('counts the staging of other open sessions, its own once, and stops counting a session left idle for a day', async () => {
      const { project, source } = await newUploadProject('quota-staging', { maxUploadBytes: 100 });
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const open = async () => (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
      const post = async (session: string, parts: Array<[string, string]>) => {
        const { payload, headers } = multipart(parts);
        return api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload });
      };
      const usedNow = async () =>
        (await api.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers: ADMIN })).json().quotas.uploadBytes.used as number;

      const first = await open();
      const second = await open();
      expect((await post(first, [['one.md', 'x'.repeat(60)]])).statusCode).toBe(200);
      // Only one session has staged anything, and its 60 bytes show once.
      expect(await usedNow()).toBe(60);

      // The second session does not fit beside the first one's staging, though nothing is committed yet.
      const refused = await post(second, [['two.md', 'y'.repeat(60)]]);
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toMatchObject({ limit: 100, used: 60, requested: 60 });

      // The first session is abandoned: after a day without a request it holds no quota.
      const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(stagingDir(dataDir, project.id, source.id, first), longAgo, longAgo);
      expect(await usedNow()).toBe(0);
      expect((await post(second, [['two.md', 'y'.repeat(60)]])).statusCode).toBe(200);

      // A request on the idle session renews it (even one the quota then refuses), and its files count again.
      expect((await post(first, [['one-more.md', 'z'.repeat(10)]])).statusCode).toBe(413);
      expect(await usedNow()).toBe(120);
    });

    it('does not count a .trash- directory or any other entry of .staging that is not a session, whatever its age', async () => {
      const { project, source } = await newUploadProject('quota-trash', { maxUploadBytes: 100 });
      const root = path.join(stagingDir(dataDir, project.id, source.id, '0'.repeat(32)), '..');
      for (const name of [`.trash-${'1'.repeat(32)}`, '.trash-x', 'not-a-session']) {
        await mkdir(path.join(root, name, 'files'), { recursive: true });
        await writeFile(path.join(root, name, 'files', 'a.md'), 'x'.repeat(40));
      }
      expect(await projectUploadBytes(apiDb.db, dataDir, project.id)).toBe(0);

      // A live session beside them is the only thing counted.
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const session = (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
      const { payload, headers } = multipart([['one.md', 'y'.repeat(30)]]);
      expect((await api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload })).statusCode).toBe(
        200,
      );
      expect(await projectUploadBytes(apiDb.db, dataDir, project.id)).toBe(30);
    });

    it('checks a commit against what other sessions and sources keep, with its own staging counted once', async () => {
      const { project, source } = await newUploadProject('quota-commit-staging', { maxUploadBytes: 100 });
      const url = `/api/projects/${project.id}/sources/${source.id}/uploads`;
      const session = (await api.app.inject({ method: 'POST', url, headers: ADMIN })).json().session as string;
      const { payload, headers } = multipart([['mine.md', 'm'.repeat(70)]]);
      expect((await api.app.inject({ method: 'POST', url: `${url}/${session}/files`, headers: { ...ADMIN, ...headers }, payload })).statusCode).toBe(
        200,
      );
      // 70 staged by this session alone: committing it must not be read as 140.
      expect((await api.app.inject({ method: 'POST', url: `${url}/${session}/commit`, headers: ADMIN })).statusCode).toBe(202);
    });

    it('reports access and sourceCount on a single project as the list does', async () => {
      const { project } = await newUploadProject('quota-single-read');
      const memberId = (globalThis as { __memberId?: string }).__memberId!;
      await setMemberRole(apiDb.db, project.id, memberId, 'viewer', null);
      const asViewer = await api.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, cookies: { [SESSION_COOKIE]: memberCookie } });
      expect(asViewer.statusCode, asViewer.body).toBe(200);
      expect(asViewer.json()).toMatchObject({ access: 'viewer', sourceCount: 1 });
      const asAdmin = await api.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers: ADMIN });
      expect(asAdmin.json()).toMatchObject({ access: 'manager', sourceCount: 1 });
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

  it('lets an incremental run at the chunk limit rename a document, because the old name stops counting', async () => {
    // 4 documents of 1 chunk each, and the limit is exactly that. A rename adds a document under the new path
    // while the old one only leaves the index at the end of the run, so it fits only if the chunks of the
    // document that is no longer on disk are not held against the run.
    await setProjectQuotas(database.db, projectId, { maxDocuments: 0, maxChunks: FILES.length });
    await rename(path.join(root, 'bravo.md'), path.join(root, 'bravo-renamed.md'));

    const renamed = await run();
    expect(renamed.phase, renamed.error).toBe('done');
    expect(await getProjectById(database.db, projectId)).toMatchObject({ documentCount: FILES.length, chunkCount: FILES.length });
    const paths = async () =>
      (await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, projectId))).map((r) => r.p).sort();
    expect(await paths()).toEqual(['handbook/alpha.md', 'handbook/bravo-renamed.md', 'handbook/charlie.md', 'handbook/delta.md']);

    await rename(path.join(root, 'bravo-renamed.md'), path.join(root, 'bravo.md'));
    const back = await run();
    expect(back.phase, back.error).toBe('done');
    expect(await paths()).toEqual(FILES.map((f) => `handbook/${f}`).sort());
  });

  it('keeps the documents an incremental run finished before the breach, deletes nothing, and recounts', async () => {
    // Sorted order puts `aaa-new.md` first: it fits once the chunk of the deleted `delta.md` is let go of,
    // and `zzz-big.md` is the one over. `delta.md` is gone from disk, but a run that ended in error skips the
    // removal pass, so its document and its chunks are still in the index and still searchable.
    await rm(path.join(root, 'delta.md'));
    await writeFile(path.join(root, 'aaa-new.md'), body('fresh', 'aaa-new'), 'utf8');
    await writeFile(path.join(root, 'zzz-big.md'), body('fresh', 'zzz-big'), 'utf8');
    await setProjectQuotas(database.db, projectId, { maxChunks: FILES.length });

    const job = await run();
    expect(job.phase).toBe('error');
    expect(job.errorCode).toBe('quota_exceeded');

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ status: 'error', documentCount: FILES.length + 1, chunkCount: FILES.length + 1 });

    const rows = (await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, projectId)))
      .map((r) => r.p)
      .sort();
    expect(rows).toEqual(['handbook/aaa-new.md', 'handbook/alpha.md', 'handbook/bravo.md', 'handbook/charlie.md', 'handbook/delta.md']);

    const hits = await hitsFor('fresh aaa new secret rotate');
    expect(hits.some((h) => h.includes('aaa-new.md|'))).toBe(true);
    expect(hits.some((h) => h.includes('zzz-big.md|'))).toBe(false);
    // Every document that was indexed before the run is still there, the deleted one included, and nothing
    // a search returns points at a document the index does not list.
    const everything = (await Promise.all(FILES.map((f) => hitsFor(`rotate the ${f.replace('.md', '')} secret`)))).flat().concat(await hitsFor());
    for (const file of FILES) expect(everything.some((h) => h.includes(`${file}|`))).toBe(true);
    for (const hit of everything) expect(rows).toContain(hit.split('|')[0]);
  });
});

/** A specification with one `get` operation per name, each with enough text to be a document of its own. */
function specWith(operations: string[]): string {
  const lines = ['openapi: 3.0.3', 'info:', '  title: Fleet API', '  version: "4.2"', 'paths:'];
  for (const name of operations) {
    lines.push(`  /fleet/${name}:`);
    lines.push('    get:');
    lines.push(`      summary: Read ${name}`);
    lines.push(`      description: The ${name} record of the fleet, with its telemetry and its maintenance window.`);
    lines.push('      responses:');
    lines.push('        "200": { description: OK }');
  }
  return lines.join('\n');
}

describe('chunk quota and the operations of a specification that no longer exist', () => {
  let database: TestDatabase;
  let root: string;
  let projectId: string;
  let embeddedTexts = 0;

  const counting: EmbeddingProvider = {
    ...embeddings,
    embedPassages: async (texts: string[]) => {
      embeddedTexts += texts.length;
      return embeddings.embedPassages(texts);
    },
  };

  const makeIndexer = (conversion?: ConversionService): Indexer =>
    new Indexer({
      db: database.db,
      embeddings: counting,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
      conversion,
    });

  const run = async (conversion?: ConversionService): Promise<JobState> => {
    const indexer = makeIndexer(conversion);
    const job = await settle(database.db, indexer.enqueue(projectId));
    indexer.forget(projectId);
    return job;
  };

  const storedPaths = async (): Promise<string[]> =>
    (await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, projectId))).map((r) => r.p).sort();

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'project_quotas_spec');
    await applySchema(database, DIMS);
    root = await mkdtemp(path.join(tmpdir(), 'quotas-spec-'));
    await writeFile(path.join(root, 'api.yaml'), specWith(['trucks', 'vans', 'buses']), 'utf8');
    const [project] = await database.db.insert(projects).values({ name: 'quota-spec' }).returning({ id: projects.id });
    projectId = project.id;
    await database.db
      .insert(documentSources)
      .values({ projectId, type: 'local', name: 'fleet', flavor: 'openapi', config: { path: root, extensions: ['md', 'yaml'] } });
    const first = await run();
    expect(first.phase, first.error).toBe('done');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  it('lets a run at the limit rename an operation, because the old operation stops counting', async () => {
    const before = await getProjectById(database.db, projectId);
    const operations = (await storedPaths()).filter((p) => p.startsWith('fleet/api.yaml/'));
    expect(operations).toHaveLength(3);
    await setProjectQuotas(database.db, projectId, { maxChunks: before?.chunkCount ?? 0 });

    await writeFile(path.join(root, 'api.yaml'), specWith(['trucks', 'vans', 'coaches']), 'utf8');
    const job = await run();
    expect(job.phase, job.error).toBe('done');

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ documentCount: before?.documentCount, chunkCount: before?.chunkCount });
    const renamed = (await storedPaths()).filter((p) => p.startsWith('fleet/api.yaml/'));
    expect(renamed).toHaveLength(3);
    expect(renamed.some((p) => p.includes('coaches'))).toBe(true);
    expect(renamed.some((p) => p.includes('buses'))).toBe(false);
  });

  it('lets a file sorted before the specification add chunks when the specification gives some back', async () => {
    const before = await getProjectById(database.db, projectId);
    await setProjectQuotas(database.db, projectId, { maxChunks: before?.chunkCount ?? 0 });

    // `aaa-intro.md` is processed first and adds a chunk while the limit is exact; the operation the
    // specification no longer has is the only thing that pays for it.
    await writeFile(path.join(root, 'aaa-intro.md'), '# Intro\n\nThis handbook introduces the fleet interface and how to read it.\n', 'utf8');
    await writeFile(path.join(root, 'api.yaml'), specWith(['trucks', 'coaches']), 'utf8');
    const job = await run();
    expect(job.phase, job.error).toBe('done');

    const after = await getProjectById(database.db, projectId);
    expect(after).toMatchObject({ documentCount: before?.documentCount, chunkCount: before?.chunkCount });
    const paths = await storedPaths();
    expect(paths).toContain('fleet/aaa-intro.md');
    expect(paths.filter((p) => p.startsWith('fleet/api.yaml/'))).toHaveLength(2);
  });

  it('refuses a run that really is over the limit before it embeds anything', async () => {
    const before = await getProjectById(database.db, projectId);
    await setProjectQuotas(database.db, projectId, { maxChunks: before?.chunkCount ?? 0 });
    // The new operation comes first in the file, so the document that crosses the limit is the first one the run
    // reaches. The file's hash changed, which makes every other operation a rewrite, and a rewrite is allowed to
    // embed: it gives its own chunk back. Nothing of that is reached.
    await writeFile(path.join(root, 'api.yaml'), specWith(['aardvarks', 'trucks', 'coaches']), 'utf8');

    embeddedTexts = 0;
    const job = await run();
    expect(job.phase).toBe('error');
    expect(job.errorCode).toBe('quota_exceeded');
    expect(embeddedTexts).toBe(0);
    expect(await getProjectById(database.db, projectId)).toMatchObject({ chunkCount: before?.chunkCount });
  });

  it('counts the operations again when the specification that gave them back in advance is then refused', async () => {
    // Four operations stored, no limit.
    await setProjectQuotas(database.db, projectId, { maxChunks: null });
    await writeFile(path.join(root, 'api.yaml'), specWith(['trucks', 'coaches', 'vans', 'buses']), 'utf8');
    expect((await run()).phase).toBe('done');
    const before = await getProjectById(database.db, projectId);
    const limit = before?.chunkCount ?? 0;
    await setProjectQuotas(database.db, projectId, { maxChunks: limit });

    // The introduction grows by a section, so it is the first file to cross the limit and the specification's three
    // vanished operations are found and given back. The specification is then refused on its second expansion, as
    // a worker that died would refuse it, and the three operations stay stored.
    await writeFile(
      path.join(root, 'aaa-intro.md'),
      '# Intro\n\nThis handbook introduces the fleet interface.\n\n## Reading\n\nHow to read the records of the fleet and what each field means.\n',
      'utf8',
    );
    await writeFile(path.join(root, 'api.yaml'), specWith(['trucks']), 'utf8');
    await writeFile(path.join(root, 'zzz-outro.md'), '# Outro\n\nThis closing page adds a chunk after the specification.\n', 'utf8');
    const conversion = new ConversionService({ timeoutMs: 120_000, idleMs: 60_000, log: silentLogger });
    let expansions = 0;
    const expand = conversion.expand.bind(conversion);
    conversion.expand = async (relativePath, bytes, limits) => {
      if (relativePath.endsWith('api.yaml') && ++expansions > 1) throw new DocumentExtractionError('the worker died');
      return expand(relativePath, bytes, limits);
    };

    try {
      const job = await run(conversion);
      expect(expansions).toBe(2);
      // The three operations are kept, so they count: the closing page, which comes after the specification, has no
      // room. Had they stayed out of the count it would have been written and the project left over its limit.
      expect(job.phase).toBe('error');
      expect(job.errorCode).toBe('quota_exceeded');
      const paths = await storedPaths();
      expect(paths.filter((p) => p.startsWith('fleet/api.yaml/'))).toHaveLength(4);
      expect(paths).not.toContain('fleet/zzz-outro.md');
    } finally {
      await conversion.stop();
    }
  });
});
