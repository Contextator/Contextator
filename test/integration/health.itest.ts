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
import { MetricsRegistry } from '../../src/services/metrics.js';
import { AuditWriter } from '../../src/services/audit.js';

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
      // The two credentials `/metrics` accepts without a database ([ADR-0055](../../.ssot/ADR.md#adr-0055)),
      // which is the property the outage cases at the bottom of this file are about.
      ADMIN_TOKEN: 'a-token-for-a-test',
      METRICS_TOKEN: 'a-scrape-token-long-enough',
      METRICS_PUBLIC: false,
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
    indexer: { stats: () => ({ interactive: 0, scheduled: 0, running: 0 }) },
    locks: {},
    uploads: {},
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    // The process counters `/metrics` reports ([ADR-0055](../../.ssot/ADR.md#adr-0055)). Real rather
    // than stubbed: it is a handful of integers and the audit hook increments one on every write.
    metrics: new MetricsRegistry(),
    // A real writer, because the policy layer's `onResponse` hook calls it on every successful
    // write and `settled()` is what lets a test await the row instead of polling for it.
    audit: new AuditWriter(db, silentLogger),
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

  /**
   * **`/metrics` is the other route that has to survive the outage**, and the whole reason it exists is
   * to say something while the database is gone ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
   *
   * The three assertions are one decision seen from three sides. A scrape credential is checked
   * without the database, so it answers. A session cookie *cannot* be — a session is a row — so the
   * honest answer is `401`: the request continues anonymous rather than throwing, which is the thing
   * being fixed, because `500` on the one page that was supposed to explain the outage is the worst
   * answer of the three. And that is precisely why an operator is told to configure `METRICS_TOKEN`.
   */
  it('answers a scrape token while the database is gone, and says the database is gone', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer a-scrape-token-long-enough' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('contextator_db_up 0');
    // Omitted rather than zeroed: "the pool is empty" and "the pool could not be read" are different
    // observations, and an operator alerting on saturation has to be able to tell them apart.
    expect(res.body).not.toContain('contextator_db_pool_connections');
    expect(res.body).not.toContain('contextator_last_index_run_ok');
  });

  it('answers ADMIN_TOKEN too, which is checked before any cookie is looked at', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer a-token-for-a-test' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('contextator_db_up 0');
  });

  it('answers 401 and not 500 to the browser whose session cannot be confirmed', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', cookies: { [SESSION_COOKIE]: sessionToken } });
    // Not the 500 an unhandled session lookup would have produced, and not a 200 either: without the
    // database this request is anonymous, and anonymous is not one of the three ways into /metrics.
    expect(res.statusCode).toBe(401);
  });

  it('keeps answering 500 everywhere else, rather than pretending the caller signed out', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', cookies: { [SESSION_COOKIE]: sessionToken } });
    expect(res.statusCode).toBe(500);
  });
});
