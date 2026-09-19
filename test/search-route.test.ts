import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import type { AppContext } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { SetupGate } from '../src/services/auth/setup.js';
import { SlidingWindow } from '../src/services/rate-limit.js';

/**
 * The bounds on `GET /api/projects/:id/search`, which are a contract (API.md) and the only thing
 * standing between a query string and a `LIMIT` — with no database and no embedding model, because
 * a rejected request never reaches either.
 *
 * The project read the policy hook makes, and the one `searchProject` makes, are the only two
 * questions asked of the database on this path; both are answered by the stub below with a project
 * that exists and has nothing indexed. That is what lets a request with *valid* bounds be told
 * apart from one with invalid bounds: the first reaches the handler and comes back `409`, the
 * second never gets there and comes back `400`.
 */

/** A real v4 UUID: `z.uuid()` checks the version and variant nibbles, and rejects a pretty one. */
const PROJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ADMIN_TOKEN = 'a-token-for-a-test';

/** Every query on this path is `select(...).from(...).where(...).limit(1)`, and both want the project. */
const stubDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: PROJECT_ID, chunkCount: 0, embeddingModel: null }],
      }),
    }),
  }),
} as unknown as Db;

async function buildApi(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const ctx = {
    config: { ALLOWED_ORIGINS: [], ALLOWED_DOC_ROOTS: ['/docs'], AUTH_SESSION_IDLE_MS: 1000, ADMIN_TOKEN, SECRET_KEY: undefined },
    db: stubDb,
    log: app.log,
    // Never called: nothing here gets far enough to embed anything.
    embeddings: { id: 'local:stub:fp32' },
    indexer: {},
    locks: {},
    uploads: {},
    sessions: {},
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await app.register(adminRoutes, { ctx });
  await app.ready();
  return app;
}

async function search(query: string): Promise<{ statusCode: number; body: { error?: string; message?: string } }> {
  const app = await buildApi();
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/search${query}`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  await app.close();
  return { statusCode: res.statusCode, body: res.json() };
}

describe('the search route validates its query string', () => {
  it('refuses a limit of 0, which would ask PostgreSQL for nothing', async () => {
    const res = await search('?q=rotate+the+key&limit=0');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('refuses a limit above 20, the same ceiling the search_docs tool has', async () => {
    const res = await search('?q=rotate+the+key&limit=21');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('refuses a limit that is not a whole number', async () => {
    for (const limit of ['2.5', 'five', '']) {
      const res = await search(`?q=rotate+the+key&limit=${limit}`);
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a missing or empty q, rather than searching for nothing', async () => {
    expect((await search('?limit=5')).statusCode).toBe(400);
    expect((await search('?q=')).statusCode).toBe(400);
    expect((await search('')).statusCode).toBe(400);
  });

  it('refuses a q over 2000 characters', async () => {
    expect((await search(`?q=${'x'.repeat(2001)}`)).statusCode).toBe(400);
  });

  it('refuses a version longer than a label can be, rather than sending it to a LIKE-free equals', async () => {
    // 64 characters, the same ceiling the source config and the `search_docs` argument carry
    // ([ADR-0058](../../.ssot/ADR.md#adr-0058)). The bound is here because this is the only thing
    // between a query string and a predicate, exactly as it is for `q` and `limit`.
    expect((await search(`?q=rotate+the+key&version=${'v'.repeat(65)}`)).statusCode).toBe(400);
  });

  it('drops an empty version rather than refusing it, because a form submits every field it has', async () => {
    // 409 and not 400: an empty filter is no filter, so the request reaches the handler and is
    // answered by the stub project's own guard — which is what "the default falls to today's
    // behaviour" means at this layer.
    const res = await search('?q=rotate+the+key&version=&source=&path_prefix=');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('not_indexed');
  });

  it('accepts both ends of the range and the absent limit, which then reach the handler', async () => {
    // 409, not 200: the stub project exists and has no chunks. Reaching that guard at all is the
    // assertion — a rejected bound would have answered 400 well before it.
    for (const query of ['?q=rotate+the+key', '?q=rotate+the+key&limit=1', '?q=rotate+the+key&limit=20']) {
      const res = await search(query);
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe('not_indexed');
    }
  });
});
