import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import type { AppContext } from '../../src/context.js';
import { createDb, type Db } from '../../src/db/client.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { createUser } from '../../src/services/auth/users.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * `/api/health` is the only thing in the deployment that can report the embedded PostgreSQL
 * (ADR-0032), and the one assertion that matters about it — that it turns 503 when the database
 * stops answering — cannot be made without a database to stop. `pingDb` is not stubbed here; the
 * pool is really closed, which is the same error the server sees when the postmaster goes away.
 */

const baseUrl = inject('postgresBaseUrl');

let database: TestDatabase;
/** The app's own handle, so closing it to simulate the outage leaves the teardown one alive. */
let appDb: ReturnType<typeof createDb>;
let app: FastifyInstance;
let sessionToken: string;

/** Everything `/api/health` reads, and hollow stand-ins for everything adminRoutes only registers. */
async function buildApi(db: Db): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie);
  const ctx = {
    config: {
      ALLOWED_ORIGINS: [],
      ALLOWED_DOC_ROOTS: ['/docs'],
      CHUNK_MAX_TOKENS: 400,
      AUTH_SESSION_IDLE_MS: 60_000,
      AUTH_COOKIE_SECURE: '0',
      DATA_DIR: '/tmp/contextator-health-itest',
      EMBEDDING_DTYPE: 'fp32',
      SECRET_KEY: undefined,
      UPLOAD_MAX_FILE_BYTES: 1024,
      UPLOAD_MAX_FILES_PER_REQUEST: 1,
      UPLOAD_MAX_ARCHIVE_BYTES: 1024,
    },
    db,
    log: silentLogger,
    embeddings: {
      id: 'local:stub:fp32',
      provider: 'local',
      model: 'stub',
      dimensions: TEST_EMBEDDING_DIMENSIONS,
      ready: true,
      maxInputTokens: 128,
      truncatesAtTokens: 512,
      windowSource: 'known-model',
    },
    // What `verifyChunkBudget` would have left behind after warmup found 400 against a 128-token
    // window — the shipped defect, which this route has to be able to carry (ADR-0035).
    chunkBudget: { checked: true, warning: { suggestedChunkMaxTokens: 96 } },
    indexer: {},
    locks: {},
    uploads: {},
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  return instance;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'health');
  await applySchema(database);

  appDb = createDb(database.url, silentLogger);
  app = await buildApi(appDb.db);

  const user = await createUser(database.db, { username: 'watcher', role: 'admin', password: 'watching-the-lights-1!' });
  sessionToken = (await createSession(database.db, user.id, 1, { userAgent: 'probe' })).token;
});

afterAll(async () => {
  await app.close();
  await dropTestDatabase(baseUrl, database);
});

describe('while the database answers', () => {
  it('reports 200 and db: up to an anonymous probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.0.0-test', db: 'up', authRequired: true, needsSetup: true });
  });

  it('adds the detail a signed-in caller gets, without moving the four public fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', cookies: { [SESSION_COOKIE]: sessionToken } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, db: 'up', authRequired: true, allowedDocRoots: ['/docs'] });
    expect(body.embeddings.id).toBe('local:stub:fp32');
  });

  it('carries both window numbers and the chunk-budget flag to a signed-in caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', cookies: { [SESSION_COOKIE]: sessionToken } });
    const body = res.json();
    // Both, always: 128 alone reads as false to anyone who watches a 400-token chunk be accepted.
    expect(body.embeddings).toMatchObject({ maxInputTokens: 128, truncatesAtTokens: 512, windowSource: 'known-model' });
    expect(body.chunkBudget).toEqual({ checked: true, ok: false, chunkMaxTokens: 400, suggestedChunkMaxTokens: 96 });
  });

  it('keeps the flag out of the anonymous shape, which is what an external monitor watches', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).not.toHaveProperty('chunkBudget');
    expect(res.json()).not.toHaveProperty('embeddings');
  });
});

describe('once the database stops answering', () => {
  // Last, and one-way: every case above needs the pool this closes.
  beforeAll(async () => {
    await appDb.pool.end();
  });

  it('answers 503 so the container healthcheck fails, and says why in the body', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    // `r.ok` in the Dockerfile's HEALTHCHECK is false for this, and true for every 2xx.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, version: '0.0.0-test', db: 'down', authRequired: true, needsSetup: true });
  });

  it('still answers 503 to the dashboard poll, which carries a cookie no database can resolve', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', cookies: { [SESSION_COOKIE]: sessionToken } });
    // The reduced shape, because the session lookup could not run — but a 503 and not the 500 that
    // an unhandled lookup failure would have produced, so the dashboard can read `db` off it.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, db: 'down' });
  });

  it('keeps answering 500 everywhere else, rather than pretending the caller signed out', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', cookies: { [SESSION_COOKIE]: sessionToken } });
    expect(res.statusCode).toBe(500);
  });
});
