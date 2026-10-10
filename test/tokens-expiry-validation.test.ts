import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCreateBody } from '../src/admin/tokens-routes.js';
import { SESSION_COOKIE } from '../src/auth/cookies.js';
import type { AppContext } from '../src/context.js';
import type { Db } from '../src/db/client.js';

/**
 * `POST /api/tokens` and a deadline already behind us (0.3.1 Faz 03). The check used to be a
 * hand-written `{ error: 'expiresAt must be in the future' }` with no `message`; it is now a refine
 * on the request schema, so it leaves through the same `validation_failed` handler as every other
 * field error. No database: the session lookup and the mint are replaced below.
 */

const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

vi.mock('../src/services/auth/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth/sessions.js')>()),
  findSessionUser: async () => ({
    sessionId: SESSION_ID,
    userId: USER_ID,
    username: 'tester',
    displayName: null,
    role: 'member',
    mustChangePassword: false,
    authMethod: 'password',
  }),
  touchSession: async () => undefined,
  isSessionLive: async () => true,
}));

vi.mock('../src/services/auth/users.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth/users.js')>()),
  withUserRowLock: async (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

const minted: Array<{ expiresAt: Date | null }> = [];

vi.mock('../src/services/auth/api-tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth/api-tokens.js')>()),
  createApiToken: async (_tx: unknown, input: { expiresAt: Date | null }) => {
    minted.push({ expiresAt: input.expiresAt });
    return { token: 'ctx_secret', view: { id: '11111111-1111-4111-8111-111111111111', expiresAt: input.expiresAt } };
  },
}));

// Imported after the mocks are declared (vi.mock is hoisted, but this keeps the order readable).
const { adminRoutes } = await import('../src/admin/routes.js');
const { AuditWriter } = await import('../src/services/audit.js');
const { SetupGate } = await import('../src/services/auth/setup.js');
const { SlidingWindow } = await import('../src/services/rate-limit.js');
const { MetricsRegistry } = await import('../src/services/metrics.js');

const SCOPE = ['POST /api/projects/:id/reindex'];

describe('buildCreateBody', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  const body = buildCreateBody(() => now);

  it('keeps a token without a deadline as it was', () => {
    expect(body.parse({ scope: SCOPE }).expiresAt).toBeNull();
    expect(body.parse({ scope: SCOPE, expiresAt: null }).expiresAt).toBeNull();
  });

  it('accepts a deadline after the clock', () => {
    expect(body.parse({ scope: SCOPE, expiresAt: '2026-10-10T12:00:00.001Z' }).expiresAt?.toISOString()).toBe('2026-10-10T12:00:00.001Z');
  });

  it('refuses a deadline at or before the clock, as an issue on expiresAt', () => {
    for (const expiresAt of ['2026-10-10T12:00:00.000Z', '2026-10-09T12:00:00.000Z']) {
      const result = body.safeParse({ scope: SCOPE, expiresAt });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.path).toEqual(['expiresAt']);
        expect(result.error.issues[0]?.message).toBe('must be in the future');
      }
    }
  });
});

describe('POST /api/tokens', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(cookie);
    const db = {
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as Db;
    const ctx = {
      config: { ALLOWED_ORIGINS: [], ALLOWED_DOC_ROOTS: ['/docs'], AUTH_SESSION_IDLE_MS: 1000, ADMIN_TOKEN: undefined, SECRET_KEY: undefined },
      db,
      log: app.log,
      embeddings: { id: 'local:stub:fp32' },
      indexer: {},
      locks: {},
      uploads: {},
      sessions: {},
      setup: new SetupGate(),
      loginLimiter: new SlidingWindow(10, 1000),
      metrics: new MetricsRegistry(),
      audit: new AuditWriter(db, app.log),
      version: '0.0.0-test',
      startedAt: Date.now(),
    } as unknown as AppContext;
    await app.register(adminRoutes, { ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: `${SESSION_COOKIE}=a-session`, 'sec-fetch-site': 'same-origin' },
      payload: payload as object,
    });

  it('answers a past expiresAt with the standard validation_failed body', async () => {
    const res = await post({ scope: SCOPE, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json).toEqual({
      error: 'validation_failed',
      message: expect.stringContaining('must be in the future'),
      issues: [expect.objectContaining({ code: 'custom', path: ['expiresAt'], message: 'must be in the future' })],
    });
  });

  it('mints a token for a future expiresAt', async () => {
    minted.length = 0;
    const expiresAt = new Date(Date.now() + 86_400_000);
    const res = await post({ scope: SCOPE, expiresAt: expiresAt.toISOString() });
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).toBe('ctx_secret');
    expect(minted).toEqual([{ expiresAt }]);
  });

  it('still mints a token that never expires when expiresAt is left out', async () => {
    minted.length = 0;
    const res = await post({ scope: SCOPE });
    expect(res.statusCode).toBe(201);
    expect(minted).toEqual([{ expiresAt: null }]);
  });
});
