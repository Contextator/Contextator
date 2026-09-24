import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import { METRICS_ROUTE } from '../src/auth/policy.js';
import type { AppContext } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { AuditWriter } from '../src/services/audit.js';
import { MetricsRegistry, type MetricsSnapshot, renderPrometheus } from '../src/services/metrics.js';
import { SetupGate } from '../src/services/auth/setup.js';
import { SlidingWindow } from '../src/services/rate-limit.js';

/**
 * `/metrics` ([ADR-0055](../.ssot/ADR.md#adr-0055)) — the exposition, and the door in front of it.
 *
 * The format is the part an external system parses and will complain about, so it is tested as text
 * against a plain snapshot, with no server and no database. The route is tested with `inject` for the
 * one thing the pure function cannot say: that it is behind the policy layer rather than beside it.
 */

const ADMIN_TOKEN = 'a-token-for-a-test';
const SCRAPE_TOKEN = 'a-scrape-token-long-enough';

const SNAPSHOT: MetricsSnapshot = {
  version: '1.2.3',
  uptimeSeconds: 61,
  embeddingId: 'local:intfloat/multilingual-e5-small:q8',
  embeddingReady: true,
  dbUp: true,
  pool: { total: 4, idle: 3, waiting: 0 },
  queue: { interactive: 2, scheduled: 5, running: 1 },
  lastIndexRun: { finishedAtSeconds: 1_700_000_000, durationSeconds: 12.5, ok: true },
  searches: { mcp: 41, dashboard: 3 },
  audit: { written: 7, failed: 0 },
};

/** Every sample line of one family, so an assertion can be about the family rather than about a substring. */
const samplesOf = (text: string, name: string): string[] =>
  text.split('\n').filter((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`));

describe('the Prometheus exposition', () => {
  const text = renderPrometheus(SNAPSHOT);

  it('gives every family exactly one HELP and one TYPE, which is what makes it ingestible', () => {
    const declared = text.split('\n').filter((line) => line.startsWith('# HELP'));
    const names = declared.map((line) => line.split(' ')[2]);
    // A duplicated family is an ingestion error rather than a cosmetic problem, so the claim is
    // uniqueness and not merely presence.
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(text).toContain(`# TYPE ${name} `);
    expect(text.endsWith('\n')).toBe(true);
  });

  /** The four things the phase asked this endpoint to carry, each asserted as a value and not a word. */
  it('carries the queue depth, by lane', () => {
    expect(samplesOf(text, 'contextator_index_queue_depth')).toEqual([
      'contextator_index_queue_depth{lane="interactive"} 2',
      'contextator_index_queue_depth{lane="scheduled"} 5',
    ]);
    expect(samplesOf(text, 'contextator_index_running')).toEqual(['contextator_index_running 1']);
  });

  it('carries the outcome of the last index run, as a number an alert can compare', () => {
    expect(samplesOf(text, 'contextator_last_index_run_ok')).toEqual(['contextator_last_index_run_ok 1']);
    expect(samplesOf(text, 'contextator_last_index_run_timestamp_seconds')).toEqual(['contextator_last_index_run_timestamp_seconds 1700000000']);
    expect(samplesOf(text, 'contextator_last_index_run_duration_seconds')).toEqual(['contextator_last_index_run_duration_seconds 12.5']);
    // A run that errored is 0 rather than a missing series, so `== 0` is the alert and `absent()` is
    // reserved for "this instance has never indexed anything".
    const failed = renderPrometheus({ ...SNAPSHOT, lastIndexRun: { ...SNAPSHOT.lastIndexRun!, ok: false } });
    expect(samplesOf(failed, 'contextator_last_index_run_ok')).toEqual(['contextator_last_index_run_ok 0']);
    const never = renderPrometheus({ ...SNAPSHOT, lastIndexRun: null });
    expect(samplesOf(never, 'contextator_last_index_run_ok')).toEqual([]);
  });

  it('carries the search counter, split by where the search came from', () => {
    expect(samplesOf(text, 'contextator_searches_total')).toEqual([
      'contextator_searches_total{actor="mcp"} 41',
      'contextator_searches_total{actor="dashboard"} 3',
    ]);
    expect(text).toContain('# TYPE contextator_searches_total counter');
  });

  it('carries the database pool, and says so when there is no database to report one from', () => {
    expect(samplesOf(text, 'contextator_db_pool_connections')).toEqual([
      'contextator_db_pool_connections{state="total"} 4',
      'contextator_db_pool_connections{state="idle"} 3',
      'contextator_db_pool_connections{state="waiting"} 0',
    ]);
    expect(samplesOf(text, 'contextator_db_up')).toEqual(['contextator_db_up 1']);
    const down = renderPrometheus({ ...SNAPSHOT, dbUp: false, pool: null, lastIndexRun: null });
    expect(samplesOf(down, 'contextator_db_up')).toEqual(['contextator_db_up 0']);
    // Omitted rather than zeroed: a pool reported as empty is a different claim from a pool nobody
    // could read, and an operator alerting on saturation must be able to tell them apart.
    expect(samplesOf(down, 'contextator_db_pool_connections')).toEqual([]);
  });

  it('escapes a label value rather than letting it end the line', () => {
    const awkward = renderPrometheus({ ...SNAPSHOT, embeddingId: 'local:a "quoted"\\model' });
    expect(awkward).toContain('embedding_id="local:a \\"quoted\\"\\\\model"');
    // And the family is still one line, which is what the escaping is for.
    expect(samplesOf(awkward, 'contextator_build_info')).toHaveLength(1);
  });

  it('never emits a value a scraper would reject', () => {
    const broken = renderPrometheus({ ...SNAPSHOT, uptimeSeconds: Number.NaN });
    expect(samplesOf(broken, 'contextator_uptime_seconds')).toEqual(['contextator_uptime_seconds 0']);
  });
});

/** Answers the two questions on this path — "is there a project" and `select 1` — and nothing else. */
const stubDb = {
  execute: async () => ({ rows: [{ '?column?': 1 }] }),
  select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
} as unknown as Db;

/** A database that is not there: every question to it fails the way a refused connection does. */
const downDb = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    },
  },
) as unknown as Db;

async function buildApi(config: Record<string, unknown> = {}, db: Db = stubDb): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const ctx = {
    config: {
      ALLOWED_ORIGINS: [],
      ALLOWED_DOC_ROOTS: ['/docs'],
      AUTH_SESSION_IDLE_MS: 1000,
      ADMIN_TOKEN,
      METRICS_PUBLIC: false,
      METRICS_TOKEN: undefined,
      ...config,
    },
    db,
    log: app.log,
    embeddings: { id: 'local:stub:fp32', ready: true },
    indexer: { stats: () => ({ interactive: 0, scheduled: 0, running: 0 }) },
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

async function scrape(config: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
  const app = await buildApi(config);
  const res = await app.inject({ method: 'GET', url: METRICS_ROUTE, headers });
  await app.close();
  return { statusCode: res.statusCode, body: res.body };
}

describe('the route in front of it', () => {
  it('refuses an anonymous scrape, which is the decision ADR-0055 records', async () => {
    const res = await scrape({});
    expect(res.statusCode).toBe(401);
  });

  it('answers ADMIN_TOKEN, in the content type the exposition format names', async () => {
    const app = await buildApi();
    const res = await app.inject({ method: 'GET', url: METRICS_ROUTE, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.body).toContain('# TYPE contextator_db_up gauge');
  });

  /**
   * The scrape credential is the reason the closed default is affordable: an operator does not have to
   * hand Prometheus an `ADMIN_TOKEN` that acts with root permissions over every project. So the test
   * that matters is not only that it opens `/metrics` — it is that it opens nothing else.
   */
  it('answers a scrape token, which reaches this route and no other', async () => {
    const withToken = await scrape({ METRICS_TOKEN: SCRAPE_TOKEN }, { authorization: `Bearer ${SCRAPE_TOKEN}` });
    expect(withToken.statusCode).toBe(200);

    const app = await buildApi({ METRICS_TOKEN: SCRAPE_TOKEN });
    const elsewhere = await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${SCRAPE_TOKEN}` } });
    await app.close();
    expect(elsewhere.statusCode).toBe(401);
  });

  it('refuses the wrong scrape token, and one presented when none is configured', async () => {
    expect((await scrape({ METRICS_TOKEN: SCRAPE_TOKEN }, { authorization: 'Bearer not-the-scrape-token' })).statusCode).toBe(401);
    expect((await scrape({}, { authorization: `Bearer ${SCRAPE_TOKEN}` })).statusCode).toBe(401);
  });

  /**
   * An `ctxk_` bearer is the one credential on this route that needs a row to be checked. With the
   * database gone, `/metrics` — which exists to be read precisely then — answers as it would to an
   * anonymous caller, and a route that needs a principal still answers the 500 it always has.
   */
  it('answers an API token as anonymous rather than 500 while the database is down', async () => {
    const bearer = { authorization: `Bearer ctxk_${'0'.repeat(64)}` };
    const app = await buildApi({ METRICS_PUBLIC: true }, downDb);
    const metrics = await app.inject({ method: 'GET', url: METRICS_ROUTE, headers: bearer });
    const elsewhere = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer });
    await app.close();
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('contextator_db_up 0');
    expect(elsewhere.statusCode).toBe(500);

    const closed = await buildApi({}, downDb);
    const refused = await closed.inject({ method: 'GET', url: METRICS_ROUTE, headers: bearer });
    await closed.close();
    expect(refused.statusCode).toBe(401);
  });

  it('answers anybody once METRICS_PUBLIC is on', async () => {
    const res = await scrape({ METRICS_PUBLIC: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('contextator_build_info');
  });
});
