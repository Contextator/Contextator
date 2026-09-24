import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import { requiredProjectAccess } from '../src/auth/policy.js';
import type { AppContext } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { AuditWriter } from '../src/services/audit.js';
import { SetupGate } from '../src/services/auth/setup.js';
import { MetricsRegistry } from '../src/services/metrics.js';
import { SlidingWindow } from '../src/services/rate-limit.js';

/**
 * The contract of `PATCH /api/projects/:id/score-floor` and of the `scoreFloor` block the query
 * summary carries — a project's own relevance floor beside the instance's `SEARCH_SCORE_FLOOR` — with
 * no database behind it.
 *
 * What the route takes is narrow on purpose: a cosine similarity between 0 and 1, or `null` to hand
 * the project back to the instance. Anything else is a 400 before the database is asked. Who may call
 * it is the same as who may switch the query log off: a manager.
 */

const PROJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ADMIN_TOKEN = 'a-token-for-a-test';
const INSTANCE_FLOOR = 0.82;

interface Stub {
  /** The project row the summary reads; `scoreFloor` is the column under test. */
  project: { scoreFloor: number | null } & Record<string, unknown>;
  /** Whether `update … returning` finds the project. */
  found: boolean;
  /** What the route asked the database to store, if it got that far. */
  written: Array<number | null>;
}

const rows = <T>(value: T[]) => Object.assign(Promise.resolve(value), { limit: async () => value });

function stubDb(stub: Stub): Db {
  return {
    select: () => ({ from: () => ({ where: () => rows([stub.project]) }) }),
    execute: async () => ({ rows: [] }),
    update: () => ({
      set: (values: { scoreFloor: number | null }) => ({
        where: () => ({
          returning: async () => {
            stub.written.push(values.scoreFloor);
            return stub.found ? [{ scoreFloor: values.scoreFloor }] : [];
          },
        }),
      }),
    }),
    insert: () => ({ values: async () => [] }),
  } as unknown as Db;
}

async function buildApi(db: Db, instanceFloor: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const ctx = {
    config: {
      ALLOWED_ORIGINS: [],
      ALLOWED_DOC_ROOTS: ['/docs'],
      AUTH_SESSION_IDLE_MS: 1000,
      ADMIN_TOKEN,
      SECRET_KEY: undefined,
      SEARCH_QUERY_LOG: true,
      SEARCH_QUERY_LOG_RETENTION_DAYS: 30,
      SEARCH_SCORE_FLOOR: instanceFloor,
    },
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
  return app;
}

function newStub(scoreFloor: number | null = null, found = true): Stub {
  return {
    project: {
      id: PROJECT_ID,
      name: 'handbook',
      chunkCount: 0,
      embeddingModel: 'local:stub:fp32',
      liveGeneration: 3,
      queryLogEnabled: true,
      scoreFloor,
    },
    found,
    written: [],
  };
}

async function call(stub: Stub, method: 'GET' | 'PATCH', url: string, payload?: unknown, instanceFloor = INSTANCE_FLOOR) {
  const app = await buildApi(stubDb(stub), instanceFloor);
  const res = await app.inject({
    method,
    url,
    payload: payload as Record<string, unknown> | undefined,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  await app.close();
  return res;
}

const patch = (stub: Stub, payload: unknown) => call(stub, 'PATCH', `/api/projects/${PROJECT_ID}/score-floor`, payload);

describe('setting a project’s relevance floor', () => {
  it.each([0.78, 0, 1, null])('stores %s and answers with it and the instance’s floor', async (floor) => {
    const stub = newStub();
    const res = await patch(stub, { floor });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scoreFloor: floor, instanceScoreFloor: INSTANCE_FLOOR, effectiveScoreFloor: floor ?? INSTANCE_FLOOR });
    expect(stub.written).toEqual([floor]);
  });

  it.each([
    ['above 1', { floor: 1.5 }],
    ['below 0', { floor: -0.1 }],
    ['a string', { floor: '0.8' }],
    ['missing', {}],
  ])('refuses a floor %s without asking the database', async (_label, body) => {
    const stub = newStub();
    const res = await patch(stub, body);
    expect(res.statusCode).toBe(400);
    expect(stub.written).toEqual([]);
  });

  it('answers 404 for a project that is not there', async () => {
    const res = await patch(newStub(null, false), { floor: 0.8 });
    expect(res.statusCode).toBe(404);
  });

  it('is a manager’s control, like switching the query log off', () => {
    expect(requiredProjectAccess('PATCH', '/api/projects/:id/score-floor')).toBe('manager');
    expect(requiredProjectAccess('PATCH', '/api/projects/:id/score-floor')).toBe(requiredProjectAccess('PATCH', '/api/projects/:id/query-log'));
  });
});

describe('the floor the query summary reports', () => {
  const summary = (stub: Stub) => call(stub, 'GET', `/api/projects/${PROJECT_ID}/queries/summary`);

  it('is the instance’s when the project has none of its own', async () => {
    const res = await summary(newStub(null));
    expect(res.json().scoreFloor).toEqual({ project: null, instance: INSTANCE_FLOOR, effective: INSTANCE_FLOOR });
  });

  it('is the project’s when it has one, including 0 for off', async () => {
    expect((await summary(newStub(0.78))).json().scoreFloor).toEqual({ project: 0.78, instance: INSTANCE_FLOOR, effective: 0.78 });
    expect((await summary(newStub(0))).json().scoreFloor).toEqual({ project: 0, instance: INSTANCE_FLOOR, effective: 0 });
  });

  it('is off, the project’s own included, when the server’s floor is 0', async () => {
    const res = await call(newStub(0.9), 'GET', `/api/projects/${PROJECT_ID}/queries/summary`, undefined, 0);
    expect(res.json().scoreFloor).toEqual({ project: 0.9, instance: 0, effective: 0 });
  });
});

describe('naming the floor a configuration was decided against', () => {
  const summary = (qs: string) => call(newStub(), 'GET', `/api/projects/${PROJECT_ID}/queries/summary?${qs}`);

  it.each([
    ['a number', 'model=local%3Astub%3Afp32&generation=3&floor=0.77'],
    ['none, for the rows logged before it was recorded', 'model=local%3Astub%3Afp32&generation=3&floor=none'],
    ['nothing, which takes the biggest floor of that model and generation', 'model=local%3Astub%3Afp32&generation=3'],
  ])('takes %s', async (_label, qs) => {
    expect((await summary(qs)).statusCode).toBe(200);
  });

  it('answers an unmatched floor with an empty configuration that names it', async () => {
    const res = await summary('model=local%3Astub%3Afp32&generation=3&floor=0.77');
    expect(res.json().configuration).toMatchObject({ embeddingModel: 'local:stub:fp32', liveGeneration: 3, scoreFloor: 0.77, queries: 0 });
    expect((await summary('model=local%3Astub%3Afp32&generation=3&floor=none')).json().configuration.scoreFloor).toBeNull();
  });

  it.each([
    ['without the model and generation it narrows', 'floor=0.77'],
    ['above 1', 'model=m&generation=3&floor=1.5'],
    ['that is not a number', 'model=m&generation=3&floor=high'],
    ['that is negative', 'model=m&generation=3&floor=-0.1'],
  ])('refuses a floor %s', async (_label, qs) => {
    expect((await summary(qs)).statusCode).toBe(400);
  });
});

describe('the price of a floor, before it is set', () => {
  const preview = (qs: string, stub = newStub(), instanceFloor = INSTANCE_FLOOR) =>
    call(stub, 'GET', `/api/projects/${PROJECT_ID}/score-floor/preview?${qs}`, undefined, instanceFloor);

  it('names the floor now and the one proposed, over the encoder and generation the next search uses', async () => {
    const res = await preview('floor=0.77');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configuration: { embeddingModel: 'local:stub:fp32', liveGeneration: 3 },
      current: { project: null, effective: INSTANCE_FLOOR },
      proposed: { project: 0.77, effective: 0.77 },
      instanceOff: false,
      atMost: true,
      searches: 0,
      gained: 0,
      lost: 0,
      gainedSamples: [],
      lostSamples: [],
    });
  });

  it('previews handing the project back to the server’s floor', async () => {
    const res = await preview('floor=instance', newStub(0.77));
    expect(res.json()).toMatchObject({ current: { project: 0.77, effective: 0.77 }, proposed: { project: null, effective: INSTANCE_FLOOR } });
  });

  it('says a project floor changes nothing while the server’s floor is off', async () => {
    const res = await preview('floor=0.9', newStub(0.77), 0);
    expect(res.json()).toMatchObject({ instanceOff: true, current: { effective: 0 }, proposed: { project: 0.9, effective: 0 } });
  });

  it.each([
    ['missing', ''],
    ['above 1', 'floor=1.5'],
    ['a word', 'floor=off'],
    ['beyond the window', 'floor=0.8&days=365'],
  ])('refuses a floor %s', async (_label, qs) => {
    expect((await preview(qs)).statusCode).toBe(400);
  });

  it('answers 404 for a project that is not there', async () => {
    const stub = newStub();
    const db = stubDb(stub);
    (db as unknown as { select: () => unknown }).select = () => ({ from: () => ({ where: () => rows([]) }) });
    const app = await buildApi(db, INSTANCE_FLOOR);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/score-floor/preview?floor=0.8`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it('is a viewer’s read, like the summary it prices, while setting the floor stays a manager’s', () => {
    expect(requiredProjectAccess('GET', '/api/projects/:id/score-floor/preview')).toBe('viewer');
    expect(requiredProjectAccess('GET', '/api/projects/:id/score-floor/preview')).toBe(
      requiredProjectAccess('GET', '/api/projects/:id/queries/summary'),
    );
    expect(requiredProjectAccess('PATCH', '/api/projects/:id/score-floor')).toBe('manager');
  });
});
