import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import type { AppContext } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { SetupGate } from '../src/services/auth/setup.js';
import { SlidingWindow } from '../src/services/rate-limit.js';
import { MetricsRegistry } from '../src/services/metrics.js';
import { AuditWriter } from '../src/services/audit.js';

/**
 * The contract of `/api/projects/:id/queries/*` ([ADR-0050](../.ssot/ADR.md#adr-0050)) — the bounds a
 * query string is held to, and the shape of the answer when the log is empty — with no database and
 * no model behind it.
 *
 * The empty case is worth a test of its own rather than being left to the panel: an instance that has
 * just turned the log on, and one whose window holds nothing, are the first thing most operators will
 * see, and `configuration: null` is what the panel renders "nothing was asked in this window" from.
 */

const PROJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ADMIN_TOKEN = 'a-token-for-a-test';

const PROJECT = { id: PROJECT_ID, name: 'handbook', chunkCount: 0, embeddingModel: 'local:stub:fp32', liveGeneration: 3, queryLogEnabled: true };

/**
 * `where()` is awaited directly by one caller and chained with `.limit(1)` by another, so it is both
 * a promise and an object with a `limit`.
 */
const rows = <T>(value: T[]) => Object.assign(Promise.resolve(value), { limit: async () => value });

const stubDb = {
  select: () => ({ from: () => ({ where: () => rows([PROJECT]) }) }),
  // No query log at all: the empty window, which is the state a fresh instance is in.
  execute: async () => ({ rows: [] }),
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ enabled: false }] }) }) }),
  delete: () => ({ where: () => ({ returning: async () => [] }) }),
} as unknown as Db;

async function buildApi(): Promise<FastifyInstance> {
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
    },
    db: stubDb,
    log: app.log,
    embeddings: { id: 'local:stub:fp32' },
    indexer: {},
    locks: {},
    uploads: {},
    sessions: {},
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    // The process counters `/metrics` reports ([ADR-0055](../../.ssot/ADR.md#adr-0055)). Real rather
    // than stubbed: it is a handful of integers and the audit hook increments one on every write.
    metrics: new MetricsRegistry(),
    // A real writer, because the policy layer's `onResponse` hook calls it on every successful
    // write and `settled()` is what lets a test await the row instead of polling for it.
    audit: new AuditWriter(stubDb, app.log),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await app.register(adminRoutes, { ctx });
  await app.ready();
  return app;
}

/** Only the fields these tests read; the contract itself is [API.md](../.ssot/API.md) §2. */
interface Body {
  error?: string;
  actor?: string;
  configuration?: unknown;
  configurations?: unknown[];
  questions?: unknown[];
  chunks?: unknown[];
  neverReturned?: unknown;
  queriesOutsideConfiguration?: number;
  current?: unknown;
  window?: { retentionDays: number; beyondRetention: boolean };
  queryLogEnabled?: boolean;
  deleted?: number;
  dumpsUnaffected?: boolean;
}

async function call(
  method: 'GET' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; body: string; json: () => Body }> {
  const app = await buildApi();
  const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  await app.close();
  return { statusCode: res.statusCode, body: res.body, json: () => res.json<Body>() };
}

const summary = (query = '') => call('GET', `/api/projects/${PROJECT_ID}/queries/summary${query}`);

describe('the bounds on the query summary', () => {
  it('accepts a window and a page size inside the bounds', async () => {
    expect((await summary('?days=30&limit=50&actor=all')).statusCode).toBe(200);
  });

  it.each(['?days=0', '?days=91', '?limit=0', '?limit=101', '?actor=nobody'])('refuses %s', async (query) => {
    const res = await summary(query);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  /**
   * A generation without the model it belongs to names half a retrieval configuration, and half a
   * configuration is precisely the averaging across a model change this panel exists to prevent.
   */
  it('refuses a model without its generation, and a generation without its model', async () => {
    expect((await summary('?model=local%3Astub%3Afp32')).statusCode).toBe(400);
    expect((await summary('?generation=2')).statusCode).toBe(400);
    expect((await summary('?model=local%3Astub%3Afp32&generation=2')).statusCode).toBe(200);
  });

  it('bounds the export by its own, larger page size', async () => {
    expect((await call('GET', `/api/projects/${PROJECT_ID}/queries/export?limit=500`)).statusCode).toBe(200);
    expect((await call('GET', `/api/projects/${PROJECT_ID}/queries/export?limit=501`)).statusCode).toBe(400);
  });
});

describe('a project whose log is empty', () => {
  it('names no configuration rather than inventing one, and carries empty figures', async () => {
    const body = (await summary()).json();
    expect(body.configuration).toBeNull();
    expect(body.configurations).toEqual([]);
    expect(body.questions).toEqual([]);
    expect(body.chunks).toEqual([]);
    expect(body.neverReturned).toEqual({ documentsInGeneration: 0, rows: [] });
    expect(body.queriesOutsideConfiguration).toBe(0);
  });

  it('answers about agents unless asked otherwise, so an operator is not reading their own typing back', async () => {
    expect((await summary()).json().actor).toBe('mcp');
    expect((await summary('?actor=dashboard')).json().actor).toBe('dashboard');
  });

  /** The caution OPERATIONS §6.1 gives somebody holding `psql`, as a field the panel can render. */
  it('says when the window asked for is longer than the log is kept', async () => {
    expect((await summary('?days=7')).json().window).toMatchObject({ retentionDays: 30, beyondRetention: false });
    expect((await summary('?days=90')).json().window?.beyondRetention).toBe(true);
  });

  it('names what the project runs now, so the panel can say when it is showing something older', async () => {
    expect((await summary()).json().current).toEqual({ embeddingModel: 'local:stub:fp32', liveGeneration: 3 });
  });

  it('writes an empty file rather than a header for an export with nothing in it', async () => {
    const res = await call('GET', `/api/projects/${PROJECT_ID}/queries/export`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

describe('the two manager controls', () => {
  it('takes a boolean and nothing else', async () => {
    expect((await call('PATCH', `/api/projects/${PROJECT_ID}/query-log`, { enabled: false })).json()).toEqual({ queryLogEnabled: false });
    expect((await call('PATCH', `/api/projects/${PROJECT_ID}/query-log`, { enabled: 'no' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/projects/${PROJECT_ID}/query-log`, {})).statusCode).toBe(400);
  });

  it('reports what a purge deleted, and that it did not reach the dumps already taken', async () => {
    expect((await call('DELETE', `/api/projects/${PROJECT_ID}/query-log`)).json()).toEqual({ deleted: 0, dumpsUnaffected: true });
  });
});
