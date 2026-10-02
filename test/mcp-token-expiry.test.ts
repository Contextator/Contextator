import cors from '@fastify/cors';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { CreateBody, expiryFromDays, TOKEN_LIFETIME_DAYS } from '../src/admin/mcp-routes.js';
import type { Db } from '../src/db/client.js';
import { isLegacySseRequest, MCP_EXPOSED_HEADERS } from '../src/mcp/router.js';
import { recordLegacySseActivity } from '../src/services/projects.js';

/**
 * The pure halves of 0.2.1 Faz 05: what a static MCP token's lifetime may be, the moment it ends, and
 * which requests are the legacy SSE transport that answers with `Deprecation: true` (ADR-0096). The
 * behaviour on the wire is test/integration/token-expiry-and-sse.itest.ts.
 */
describe('POST /api/projects/:id/mcp-tokens body', () => {
  it('defaults to a token that never expires', () => {
    expect(CreateBody.parse({})).toEqual({ name: '', expiresInDays: null });
    expect(CreateBody.parse({ name: 'ci', expiresInDays: null })).toEqual({ name: 'ci', expiresInDays: null });
  });

  it('accepts exactly the lifetimes the panel offers: 30, 90 and 365 days', () => {
    expect(TOKEN_LIFETIME_DAYS).toEqual([30, 90, 365]);
    for (const days of [30, 90, 365]) expect(CreateBody.parse({ expiresInDays: days }).expiresInDays).toBe(days);
  });

  it('refuses any other lifetime', () => {
    for (const days of [1, 7, 45, 3650, 0, -30, 30.5, '30']) expect(CreateBody.safeParse({ expiresInDays: days }).success).toBe(false);
  });
});

describe('expiryFromDays', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');

  it('is null for a token that never expires', () => {
    expect(expiryFromDays(null, now)).toBeNull();
  });

  it('is exactly that many days after minting', () => {
    expect(expiryFromDays(30, now)?.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    expect(expiryFromDays(365, now)?.toISOString()).toBe('2027-10-02T12:00:00.000Z');
  });
});

describe('isLegacySseRequest', () => {
  it('matches the SSE stream and its /messages channel', () => {
    expect(isLegacySseRequest('GET', '/mcp/:project', undefined)).toBe(true);
    expect(isLegacySseRequest('HEAD', '/mcp/:project', undefined)).toBe(true);
    expect(isLegacySseRequest('POST', '/mcp/:project/messages', undefined)).toBe(true);
  });

  it('never matches Streamable HTTP', () => {
    expect(isLegacySseRequest('POST', '/mcp/:project', undefined)).toBe(false);
    expect(isLegacySseRequest('GET', '/mcp/:project', 'a-session-id')).toBe(false);
    expect(isLegacySseRequest('DELETE', '/mcp/:project', 'a-session-id')).toBe(false);
  });

  it('does not match a request no route answered', () => {
    expect(isLegacySseRequest('GET', undefined, undefined)).toBe(false);
  });
});

describe('the Deprecation header across origins', () => {
  it('is readable by an allowed browser origin', async () => {
    const app = Fastify({ logger: false });
    await app.register(cors, { origin: ['https://client.example'], exposedHeaders: MCP_EXPOSED_HEADERS });
    app.get('/legacy', async (_req, reply) => reply.header('deprecation', 'true').send('ok'));
    const res = await app.inject({ method: 'GET', url: '/legacy', headers: { origin: 'https://client.example' } });
    const exposed = String(res.headers['access-control-expose-headers'])
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining(['deprecation', 'mcp-session-id', 'mcp-protocol-version']));
    await app.close();
  });
});

describe('recordLegacySseActivity', () => {
  /** Counts the UPDATEs that reach the database; nothing else of `Db` is touched. */
  function countingDb(): { db: Db; writes: () => number } {
    let writes = 0;
    const chain = {
      set: () => chain,
      where: () => {
        writes += 1;
        return Promise.resolve();
      },
    };
    return { db: { update: () => chain } as unknown as Db, writes: () => writes };
  }

  it('writes at most once a minute per project, without asking the database in between', () => {
    const { db, writes } = countingDb();
    const project = crypto.randomUUID();
    const t0 = 1_800_000_000_000;

    expect(recordLegacySseActivity(db, project, t0)).toBe(true);
    for (const dt of [1, 1_000, 59_999]) expect(recordLegacySseActivity(db, project, t0 + dt)).toBe(false);
    expect(writes()).toBe(1);

    expect(recordLegacySseActivity(db, project, t0 + 60_000)).toBe(true);
    expect(writes()).toBe(2);
  });

  it('throttles each project on its own', () => {
    const { db, writes } = countingDb();
    const t0 = 1_800_000_000_000;
    expect(recordLegacySseActivity(db, crypto.randomUUID(), t0)).toBe(true);
    expect(recordLegacySseActivity(db, crypto.randomUUID(), t0)).toBe(true);
    expect(writes()).toBe(2);
  });

  it('never lets a failed write reach the caller', async () => {
    const db = { update: () => ({ set: () => ({ where: () => Promise.reject(new Error('pool exhausted')) }) }) } as unknown as Db;
    expect(recordLegacySseActivity(db, crypto.randomUUID(), 1_800_000_000_000)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve)); // an unhandled rejection would fail the run
  });
});
