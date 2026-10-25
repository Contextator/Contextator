import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvents, mcpRateLimits, mcpTokens, projects, type ProjectRow } from '../../src/db/schema.js';
import { createMcpToken } from '../../src/services/auth/mcp-tokens.js';
import { McpRateLimiter } from '../../src/services/rate-limit.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * Faz 04, over a real PostgreSQL and a real listening endpoint: the two guards that sit in front of an MCP
 * request after it has been identified.
 *
 * - **Rate limiting** ([ADR-0112](../../../.ssot/ADR.md#adr-0112)): a token over its ceiling is answered 429 with
 *   `Retry-After` and another token is untouched; an `open` project is limited per address; a tool limit applies
 *   to a legacy client that sends no `Mcp-Name`; a failed authentication costs nothing; a counter that cannot be
 *   reached serves the request (and counts the failure) or refuses it with 503, as configured.
 * - **Token networks** ([ADR-0118](../../../.ssot/ADR.md#adr-0118)): a static token outside its allowlist is
 *   answered 403, the address comes from `X-Forwarded-For` only when the proxy is trusted, and under
 *   `TRUST_PROXY=1` a list can be neither saved nor honoured.
 *
 * Every request is a raw POST. The modern (2026-07-28) era is stateless, which makes it the cheap way to send
 * one counted message; the legacy era is used where the point is that it carries no `Mcp-Name` header.
 */

const baseUrl = inject('postgresBaseUrl');
const ADMIN_TOKEN = 'an-admin-token-for-the-access-guard-suite';
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.
`;

const MODERN_VERSION = '2026-07-28';
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'access-guards-itest', version: '0.0.0' },
};

const PER_TOKEN = 4;
const PER_ANONYMOUS = 3;
const PER_TOOL = 2;

let database: TestDatabase;
let root: string;
/** TRUST_PROXY=1, every limit on. The address a request comes from is whatever `X-Forwarded-For` says. */
let limited: LiveInstance;
/** TRUST_PROXY=loopback, no token or tool limit; the default anonymous limit (60/min) applies. The address is read from `X-Forwarded-For` because the peer is trusted. */
let proxied: LiveInstance;
/** TRUST_PROXY=1, a token ceiling, and `MCP_RATE_LIMIT_FAIL_OPEN=0`. */
let strict: LiveInstance;
let guarded: ProjectRow;
let open: ProjectRow;

interface Reply {
  status: number;
  headers: Headers;
  json: { error?: { code: number; message: string; data?: { error: string; retryAfterSec: number; scope: string } }; id?: unknown; result?: unknown };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A modern-era request carrying one message. Stateless, so nothing has to be opened first. */
const modernCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args, _meta: ENVELOPE },
});

const SEARCH = (id = 1) => modernCall(id, 'search_docs', { query: 'install the package', limit: 2 });
const TOPICS = (id = 1) => modernCall(id, 'list_topics', {});

async function post(instance: LiveInstance, project: ProjectRow, body: unknown, headers: Record<string, string> = {}, modern = true): Promise<Reply> {
  const method = Array.isArray(body) ? 'tools/call' : ((body as { method?: string }).method ?? 'tools/call');
  const name = (body as { params?: { name?: string } }).params?.name;
  const res = await fetch(`${instance.origin}/mcp/${project.name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(modern ? { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Reply['json'] = {};
  if (text.length > 0) {
    // A served tool call may come back as an SSE frame; a refusal is always plain JSON.
    const data = res.headers.get('content-type')?.includes('text/event-stream') ? /data: (.*)/.exec(text)?.[1] : text;
    json = data ? JSON.parse(data) : {};
  }
  return { status: res.status, headers: res.headers, json };
}

/** A legacy 2025 session: `initialize`, then the session id every later POST must carry. */
async function legacySession(instance: LiveInstance, project: ProjectRow, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${instance.origin}/mcp/${project.name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-probe', version: '0.0.0' } },
    }),
  });
  await res.text();
  expect(res.status).toBe(200);
  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

const legacyCall = (
  instance: LiveInstance,
  project: ProjectRow,
  sessionId: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
  headers = {},
) =>
  post(
    instance,
    project,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18', ...headers },
    false,
  );

const counters = async (): Promise<Array<{ key: string; count: number }>> =>
  database.db.select({ key: mcpRateLimits.key, count: mcpRateLimits.count }).from(mcpRateLimits).orderBy(mcpRateLimits.key);

async function mint(
  instance: LiveInstance,
  project: ProjectRow,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { token: { id: string; allowedCidrs: string[] | null }; secret: string; error?: string } }> {
  const res = await instance.app.inject({ method: 'POST', url: `/api/projects/${project.id}/mcp-tokens`, headers: admin, payload: body });
  return { status: res.statusCode, json: res.json() };
}

/**
 * The fixed window is aligned to the wall clock, so a test that straddles a minute would see its counter
 * reset under it. Waiting out the last seconds of a minute is cheaper than a flaky suite.
 */
beforeEach(async () => {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 12_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
  await database.db.delete(mcpRateLimits);
});

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'access_guards');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-access-guards-'));

  guarded = await seedProject(database.db, 'guarded', { path: 'handbook/guide.md', body: HANDBOOK });
  await database.db.update(projects).set({ mcpAuth: 'token' }).where(eq(projects.id, guarded.id));
  open = await seedProject(database.db, 'open-door', { path: 'handbook/guide.md', body: HANDBOOK });

  const dir = (name: string) => ({ dataDir: path.join(root, name), docRoot: root });
  limited = await startMcpInstance(database, {
    ...dir('limited'),
    env: {
      ADMIN_TOKEN,
      MCP_RATE_LIMIT_PER_MINUTE: String(PER_TOKEN),
      MCP_RATE_LIMIT_ANON_PER_MINUTE: String(PER_ANONYMOUS),
      MCP_RATE_LIMIT_TOOLS: `list_topics=${PER_TOOL}`,
    },
  });
  proxied = await startMcpInstance(database, { ...dir('proxied'), env: { ADMIN_TOKEN, TRUST_PROXY: 'loopback' } });
  strict = await startMcpInstance(database, {
    ...dir('strict'),
    env: { ADMIN_TOKEN, MCP_RATE_LIMIT_PER_MINUTE: '5', MCP_RATE_LIMIT_FAIL_OPEN: '0' },
  });
});

afterAll(async () => {
  await Promise.all([limited?.close(), proxied?.close(), strict?.close()]);
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('the per-token ceiling', () => {
  it('answers 429 with Retry-After once a token is over, and leaves another token alone', async () => {
    const a = await mint(limited, guarded, { name: 'a' });
    const b = await mint(limited, guarded, { name: 'b' });

    for (let i = 1; i <= PER_TOKEN; i++) expect((await post(limited, guarded, SEARCH(i), bearer(a.json.secret))).status).toBe(200);

    const refused = await post(limited, guarded, SEARCH(99), bearer(a.json.secret));
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.json.error?.code).toBe(-32000);
    expect(refused.json.error?.data).toEqual({ error: 'rate_limited', retryAfterSec: retryAfter, scope: 'token' });
    // The 2026 era echoes the id so the client can match the refusal to its request.
    expect(refused.json.id).toBe(99);

    expect((await post(limited, guarded, SEARCH(1), bearer(b.json.secret))).status).toBe(200);
    expect(limited.ctx.metrics.mcpGuard().rateLimited.token).toBeGreaterThanOrEqual(1);
  });

  it('counts each request message of a batch, and neither notifications nor initialize nor ping', async () => {
    const t = await mint(limited, guarded, { name: 'batch' });
    const free = [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ];
    for (const message of free) expect((await post(limited, guarded, message, bearer(t.json.secret))).status).not.toBe(429);
    expect((await legacySession(limited, guarded, bearer(t.json.secret))).length).toBeGreaterThan(0);
    expect(await counters()).toEqual([]);

    const batch = [SEARCH(1), SEARCH(2), SEARCH(3)];
    expect((await post(limited, guarded, batch, bearer(t.json.secret), false)).status).not.toBe(429);
    expect(await counters()).toEqual([{ key: `tok:${t.json.token.id}`, count: 3 }]);

    // Two more messages would make five, over the ceiling of four.
    const over = await post(limited, guarded, [SEARCH(4), SEARCH(5)], bearer(t.json.secret), false);
    expect(over.status).toBe(429);
    expect(over.json.error?.data?.scope).toBe('token');
  });

  it('does not count a request that fails authentication', async () => {
    for (let i = 0; i < PER_TOKEN + 2; i++) {
      const res = await post(limited, guarded, SEARCH(i), bearer('ctxm_not-a-token-anybody-minted'));
      expect(res.status).toBe(401);
    }
    expect((await post(limited, guarded, SEARCH(1))).status).toBe(401);
    expect(await counters()).toEqual([]);
  });
});

describe('an open project', () => {
  it('is limited per address, by the anonymous ceiling', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.20' };
    for (let i = 1; i <= PER_ANONYMOUS; i++) expect((await post(limited, open, SEARCH(i), ip)).status).toBe(200);
    const refused = await post(limited, open, SEARCH(9), ip);
    expect(refused.status).toBe(429);
    expect(refused.json.error?.data?.scope).toBe('anonymous');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Another address has its own budget.
    expect((await post(limited, open, SEARCH(1), { 'x-forwarded-for': '198.51.100.21' })).status).toBe(200);
    expect((await counters()).map((c) => c.key).sort()).toEqual([`ip:${open.id}:198.51.100.20`, `ip:${open.id}:198.51.100.21`]);
  });

  it('is limited to 60 requests a minute per address when no anonymous ceiling is configured (the 0.4 default)', async () => {
    // `proxied` sets no MCP_RATE_LIMIT_ANON_PER_MINUTE, so this exercises the default end to end.
    expect(proxied.ctx.config.MCP_RATE_LIMIT_ANON_PER_MINUTE).toBe(60);
    const ip = { 'x-forwarded-for': '198.51.100.70' };
    for (let i = 1; i <= 60; i++) expect((await post(proxied, open, TOPICS(i), ip)).status).toBe(200);
    const refused = await post(proxied, open, TOPICS(61), ip);
    expect(refused.status).toBe(429);
    expect(refused.json.error?.data?.scope).toBe('anonymous');
    expect(await counters()).toEqual([{ key: `ip:${open.id}:198.51.100.70`, count: 61 }]);
  });

  it('folds an IPv4-mapped address onto the IPv4 one, and an IPv6 address onto its /64', async () => {
    await post(limited, open, SEARCH(1), { 'x-forwarded-for': '::ffff:198.51.100.30' });
    await post(limited, open, SEARCH(2), { 'x-forwarded-for': '198.51.100.30' });
    await post(limited, open, SEARCH(3), { 'x-forwarded-for': '2001:db8:1:2:aaaa::1' });
    await post(limited, open, SEARCH(4), { 'x-forwarded-for': '2001:db8:1:2:bbbb::2' });
    const rows = await counters();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey[`ip:${open.id}:198.51.100.30`]).toBe(2);
    const v6 = rows.filter((r) => r.key.includes('2001:db8:1:2'));
    expect(v6).toHaveLength(1);
    expect(v6[0].count).toBe(2);
  });

  it('counts a wrong Bearer in the anonymous bucket of its address, not in a token bucket and not for free (ADR-0112)', async () => {
    // An open project serves a caller whose token means nothing, exactly as it serves one with none ...
    const ip = { 'x-forwarded-for': '198.51.100.40' };
    const wrong = { ...ip, ...bearer('ctxm_a-token-nobody-minted') };
    for (let i = 1; i <= PER_ANONYMOUS; i++) expect((await post(limited, open, SEARCH(i), wrong)).status).toBe(200);
    // ... so it must not be a way round the address limit: the junk token shares the address's budget.
    expect((await post(limited, open, SEARCH(9), ip)).status).toBe(429);
    expect((await post(limited, open, SEARCH(9), wrong)).status).toBe(429);
    expect(await counters()).toEqual([{ key: `ip:${open.id}:198.51.100.40`, count: PER_ANONYMOUS + 2 }]);
  });

  it('keys a valid token by the token, not by the address, so one token shared across addresses has one ceiling', async () => {
    const t = await mint(limited, open, { name: 'on an open project' });
    for (let i = 1; i <= PER_TOKEN; i++) {
      expect((await post(limited, open, SEARCH(i), { ...bearer(t.json.secret), 'x-forwarded-for': `198.51.100.${50 + i}` })).status).toBe(200);
    }
    expect((await post(limited, open, SEARCH(9), { ...bearer(t.json.secret), 'x-forwarded-for': '198.51.100.99' })).status).toBe(429);
    expect(await counters()).toEqual([{ key: `tok:${t.json.token.id}`, count: PER_TOKEN + 1 }]);
  });
});

/**
 * The claim the anonymous limit rests on ([ADR-0122](../../../.ssot/ADR.md#adr-0122)): under every supported
 * `TRUST_PROXY`, a caller cannot reset its own per-address budget by writing `X-Forwarded-For`. `1` is outside
 * this claim (it is deprecated, and 0.5.0 refuses it), which is why `limited` is not used here.
 */
describe('a forged X-Forwarded-For', () => {
  const forged = (i: number) => `192.0.2.${i}`;

  for (const trusting of ['0', '10.99.0.1']) {
    it(`does not reset the per-address limit when the peer is not trusted (TRUST_PROXY=${trusting})`, async () => {
      const instance = await startMcpInstance(database, {
        dataDir: path.join(root, `forged-${trusting === '0' ? 'off' : 'elsewhere'}`),
        docRoot: root,
        env: { ADMIN_TOKEN, TRUST_PROXY: trusting, MCP_RATE_LIMIT_ANON_PER_MINUTE: String(PER_ANONYMOUS) },
      });
      try {
        // A different forged address on every request: were the header believed, each would have a fresh budget.
        for (let i = 1; i <= PER_ANONYMOUS; i++) expect((await post(instance, open, SEARCH(i), { 'x-forwarded-for': forged(i) })).status).toBe(200);
        const refused = await post(instance, open, SEARCH(9), { 'x-forwarded-for': forged(9) });
        expect(refused.status).toBe(429);
        expect(refused.json.error?.data?.scope).toBe('anonymous');
        // One counter, keyed by the socket's own address: the forged values never became a key.
        const rows = await counters();
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(PER_ANONYMOUS + 1);
        expect(rows[0].key).not.toContain('192.0.2.');
      } finally {
        await instance.close();
      }
    });
  }

  it('does not reset the per-address limit when the proxy is named: the key is the right-most value, the one the proxy appended', async () => {
    // `proxied` is TRUST_PROXY=loopback and the test client connects from loopback, so it plays the proxy.
    // The client's own values sit to the left of the address the proxy saw (203.0.113.50).
    expect(proxied.ctx.config.MCP_RATE_LIMIT_ANON_PER_MINUTE).toBe(60);
    for (let i = 1; i <= 60; i++) {
      expect((await post(proxied, open, TOPICS(i), { 'x-forwarded-for': `${forged(i)}, 203.0.113.50` })).status).toBe(200);
    }
    const refused = await post(proxied, open, TOPICS(61), { 'x-forwarded-for': `${forged(61)}, 203.0.113.50` });
    expect(refused.status).toBe(429);
    expect(refused.json.error?.data?.scope).toBe('anonymous');
    expect(await counters()).toEqual([{ key: `ip:${open.id}:203.0.113.50`, count: 61 }]);
  });
});

describe('a per-tool limit', () => {
  it('applies to a modern client and, from the body, to a legacy one that sends no Mcp-Name', async () => {
    const t = await mint(limited, guarded, { name: 'tool' });
    const auth = bearer(t.json.secret);

    // Modern, with the header.
    expect((await post(limited, guarded, TOPICS(1), auth)).status).toBe(200);
    // Legacy: the session is opened by `initialize`, and no request carries `Mcp-Name`.
    const sessionId = await legacySession(limited, guarded, auth);
    const second = await legacyCall(limited, guarded, sessionId, 2, 'list_topics', {}, auth);
    expect(second.status).toBe(200);
    const third = await legacyCall(limited, guarded, sessionId, 3, 'list_topics', {}, auth);
    expect(third.status).toBe(429);
    expect(third.json.error?.data?.scope).toBe('tool');
    // Legacy refusals carry no id to echo.
    expect(third.json.id).toBeNull();

    // A tool with no limit of its own is still served while the token has room (2 listed + 1 refused so far).
    expect((await legacyCall(limited, guarded, sessionId, 4, 'search_docs', { query: 'install' }, auth)).status).toBe(200);
  });

  it('does not take the Mcp-Name header at its word: a header that disagrees with the body is refused, and what was counted is the tool the body names', async () => {
    const t = await mint(limited, guarded, { name: 'liar' });
    const lying = { ...bearer(t.json.secret), 'mcp-name': 'search_docs' };
    expect((await post(limited, guarded, TOPICS(1), lying)).status).toBe(400);
    const id = t.json.token.id;
    expect(await counters()).toEqual([
      { key: `tok:${id}`, count: 1 },
      { key: `tok:${id}:tool:list_topics`, count: 1 },
    ]);
  });
});

describe('a token network allowlist', () => {
  it('lets a token through from inside its list and refuses it from outside with a 403 that names neither', async () => {
    const t = await mint(proxied, guarded, { name: 'office', allowedCidrs: ['203.0.113.0/24', '2001:db8::/32'] });
    expect(t.status).toBe(201);
    expect(t.json.token.allowedCidrs).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    const before = proxied.ctx.metrics.mcpGuard().accessDenied.network;

    // `X-Forwarded-For` is believed because the peer (loopback) is a trusted proxy.
    expect((await post(proxied, guarded, SEARCH(1), { ...bearer(t.json.secret), 'x-forwarded-for': '203.0.113.77' })).status).toBe(200);
    expect((await post(proxied, guarded, SEARCH(1), { ...bearer(t.json.secret), 'x-forwarded-for': '2001:db8:abcd::1' })).status).toBe(200);

    const outside = await post(proxied, guarded, SEARCH(2), { ...bearer(t.json.secret), 'x-forwarded-for': '198.51.100.7' });
    expect(outside.status).toBe(403);
    expect(outside.json.error?.code).toBe(-32000);
    const text = JSON.stringify(outside.json);
    expect(text).not.toContain('198.51.100');
    expect(text).not.toContain('203.0.113');
    expect(proxied.ctx.metrics.mcpGuard().accessDenied.network).toBe(before + 1);

    // An unrestricted token on the same project is unaffected by anybody's list.
    const free = await mint(proxied, guarded, { name: 'anywhere' });
    expect((await post(proxied, guarded, SEARCH(3), { ...bearer(free.json.secret), 'x-forwarded-for': '198.51.100.7' })).status).toBe(200);
  });

  it('judges a request that spoofs the header from a peer that is not trusted by the socket address, not by the header', async () => {
    // Same list, but a TRUST_PROXY that trusts a proxy that is not this peer: the header is ignored.
    const mistrusting = await startMcpInstance(database, {
      dataDir: path.join(root, 'mistrusting'),
      docRoot: root,
      env: { ADMIN_TOKEN, TRUST_PROXY: '10.99.0.1' },
    });
    try {
      const t = await mint(mistrusting, guarded, { name: 'spoof', allowedCidrs: ['203.0.113.0/24'] });
      expect(t.status).toBe(201);
      const spoofed = await post(mistrusting, guarded, SEARCH(1), { ...bearer(t.json.secret), 'x-forwarded-for': '203.0.113.77' });
      expect(spoofed.status).toBe(403);
      // And from the allowed range itself, were the socket in it, the request would pass; loopback is not.
    } finally {
      await mistrusting.close();
    }
  });

  it('is enforced on an open project too: a token that carries a list is not a way round it', async () => {
    const t = await mint(proxied, open, { name: 'open but bound', allowedCidrs: ['203.0.113.0/24'] });
    expect((await post(proxied, open, SEARCH(1), { ...bearer(t.json.secret), 'x-forwarded-for': '203.0.113.5' })).status).toBe(200);
    expect((await post(proxied, open, SEARCH(2), { ...bearer(t.json.secret), 'x-forwarded-for': '198.51.100.5' })).status).toBe(403);
    // Anonymous requests to the open project carry no token, so no list applies to them.
    expect((await post(proxied, open, SEARCH(3), { 'x-forwarded-for': '198.51.100.5' })).status).toBe(200);
  });

  it('round-trips the list through cidr[] exactly as it was written and removes it with null or []', async () => {
    const t = await mint(proxied, guarded, { name: 'roundtrip', allowedCidrs: ['10.0.0.0/8', '192.0.2.10/32'] });
    const [row] = await database.db.select({ allowedCidrs: mcpTokens.allowedCidrs }).from(mcpTokens).where(eq(mcpTokens.id, t.json.token.id));
    expect(row.allowedCidrs).toEqual(['10.0.0.0/8', '192.0.2.10/32']);

    const patch = (payload: unknown) =>
      proxied.app.inject({
        method: 'PATCH',
        url: `/api/projects/${guarded.id}/mcp-tokens/${t.json.token.id}`,
        headers: admin,
        payload: payload as object,
      });

    const narrowed = await patch({ allowedCidrs: ['203.0.113.0/24'] });
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.json().allowedCidrs).toEqual(['203.0.113.0/24']);
    expect((await post(proxied, guarded, SEARCH(1), { ...bearer(t.json.secret), 'x-forwarded-for': '10.1.2.3' })).status).toBe(403);

    const cleared = await patch({ allowedCidrs: [] });
    expect(cleared.statusCode).toBe(200);
    expect((await post(proxied, guarded, SEARCH(2), { ...bearer(t.json.secret), 'x-forwarded-for': '10.1.2.3' })).status).toBe(200);
    expect((await patch({ allowedCidrs: null })).statusCode).toBe(200);
  });

  it('refuses a list that cannot be kept: /0, a host with bits, junk, too many, and an unknown token', async () => {
    for (const allowedCidrs of [
      ['0.0.0.0/0'],
      ['::/0'],
      ['203.0.113.5/24'],
      ['not-an-address'],
      ['203.0.113.0/33'],
      Array.from({ length: 33 }, (_, i) => `10.0.${i}.0/24`),
    ]) {
      expect((await mint(proxied, guarded, { name: 'bad', allowedCidrs })).status).toBe(400);
    }
    const missing = await proxied.app.inject({
      method: 'PATCH',
      url: `/api/projects/${guarded.id}/mcp-tokens/00000000-0000-4000-8000-000000000000`,
      headers: admin,
      payload: { allowedCidrs: ['203.0.113.0/24'] },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('writes the change to the audit log without writing the list into it', async () => {
    const t = await mint(proxied, guarded, { name: 'audited' });
    const res = await proxied.app.inject({
      method: 'PATCH',
      url: `/api/projects/${guarded.id}/mcp-tokens/${t.json.token.id}`,
      headers: admin,
      payload: { allowedCidrs: ['203.0.113.0/24'] },
    });
    expect(res.statusCode).toBe(200);
    await proxied.ctx.audit.settled();
    const rows = await database.db.select().from(auditEvents).where(eq(auditEvents.action, 'PATCH /api/projects/:id/mcp-tokens/:tokenId'));
    const row = rows.find((r) => r.targetId === t.json.token.id);
    expect(row).toBeDefined();
    expect(row?.statusCode).toBe(200);
    expect(JSON.stringify(row?.detail)).not.toContain('203.0.113');
  });
});

describe('a network allowlist under TRUST_PROXY=1', () => {
  it('cannot be saved, by POST or by PATCH, and the existing list is left as it was', async () => {
    const plain = await mint(limited, guarded, { name: 'plain' });
    expect((await mint(limited, guarded, { name: 'listed', allowedCidrs: ['203.0.113.0/24'] })).status).toBe(400);
    const patched = await limited.app.inject({
      method: 'PATCH',
      url: `/api/projects/${guarded.id}/mcp-tokens/${plain.json.token.id}`,
      headers: admin,
      payload: { allowedCidrs: ['203.0.113.0/24'] },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.body).toContain('TRUST_PROXY');
    const [row] = await database.db.select({ allowedCidrs: mcpTokens.allowedCidrs }).from(mcpTokens).where(eq(mcpTokens.id, plain.json.token.id));
    expect(row.allowedCidrs).toBeNull();

    // Removing a restriction is always allowed, and an empty list is not a restriction.
    const cleared = await limited.app.inject({
      method: 'PATCH',
      url: `/api/projects/${guarded.id}/mcp-tokens/${plain.json.token.id}`,
      headers: admin,
      payload: { allowedCidrs: [] },
    });
    expect(cleared.statusCode).toBe(200);
  });

  it('refuses a token that already carries a list, whatever address the header claims', async () => {
    // Written under a trustworthy TRUST_PROXY and then served by an instance configured with `1`.
    const { token } = await createMcpToken(database.db, guarded.id, 'carried over', null, null, ['203.0.113.0/24']);
    const before = limited.ctx.metrics.mcpGuard().accessDenied.network;
    const res = await post(limited, guarded, SEARCH(1), { ...bearer(token), 'x-forwarded-for': '203.0.113.9' });
    expect(res.status).toBe(403);
    expect(limited.ctx.metrics.mcpGuard().accessDenied.network).toBe(before + 1);
  });
});

describe('a counter that cannot be reached', () => {
  const rename = (from: string, to: string) => database.db.execute(sql.raw(`alter table ${from} rename to ${to}`));

  it('serves the request and counts the failure by default, and refuses with 503 under MCP_RATE_LIMIT_FAIL_OPEN=0', async () => {
    const open_ = await mint(limited, guarded, { name: 'fail open' });
    const closed = await mint(strict, guarded, { name: 'fail closed' });
    const errorsBefore = limited.ctx.metrics.mcpGuard().rateLimitErrors;
    const strictBefore = strict.ctx.metrics.mcpGuard().rateLimitErrors;

    await rename('mcp_rate_limits', 'mcp_rate_limits_broken');
    try {
      const served = await post(limited, guarded, SEARCH(1), bearer(open_.json.secret));
      expect(served.status).toBe(200);
      expect(limited.ctx.metrics.mcpGuard().rateLimitErrors).toBe(errorsBefore + 1);

      const refused = await post(strict, guarded, SEARCH(2), bearer(closed.json.secret));
      expect(refused.status).toBe(503);
      expect(refused.json.error?.code).toBe(-32000);
      expect(refused.json.id).toBe(2);
      expect(strict.ctx.metrics.mcpGuard().rateLimitErrors).toBe(strictBefore + 1);

      // A request that costs nothing never touches the table, so a client can still connect and ping.
      expect((await post(strict, guarded, { jsonrpc: '2.0', id: 3, method: 'ping' }, bearer(closed.json.secret))).status).not.toBe(503);
    } finally {
      await rename('mcp_rate_limits_broken', 'mcp_rate_limits');
    }
  });

  it('exports the three guard families on /metrics', async () => {
    const res = await limited.app.inject({ method: 'GET', url: '/metrics', headers: admin });
    expect(res.statusCode).toBe(200);
    for (const family of [
      'contextator_mcp_rate_limited_total{scope="token"}',
      'contextator_mcp_rate_limited_total{scope="anonymous"}',
      'contextator_mcp_rate_limited_total{scope="tool"}',
      'contextator_mcp_rate_limit_errors_total',
      'contextator_mcp_access_denied_total{reason="network"}',
    ]) {
      expect(res.body).toContain(family);
    }
  });
});

describe('the fixed window itself', () => {
  const key = (k: string, limit = 3, cost = 1) => ({ key: k, limit, cost, scope: 'token' as const });

  it('resets at the next window, reports the seconds left, and sweeps what is long closed', async () => {
    let now = Date.parse('2026-10-24T10:00:10.000Z');
    const limiter = new McpRateLimiter(database.db, 60_000, () => now);

    for (let i = 0; i < 3; i++) expect(await limiter.hit([key('tok:window')])).toBe(0);
    const denial = await limiter.hit([key('tok:window')]);
    expect(denial).toMatchObject({ scope: 'token', limit: 3, retryAfterSec: 50 });

    now = Date.parse('2026-10-24T10:00:59.200Z');
    expect(await limiter.hit([key('tok:window')])).toMatchObject({ retryAfterSec: 1 });

    now = Date.parse('2026-10-24T10:01:00.000Z');
    expect(await limiter.hit([key('tok:window')])).toBe(0);
    expect((await counters()).find((c) => c.key === 'tok:window')?.count).toBe(1);

    // A batch of three at a ceiling of three fits; a fourth message does not, and the denial still counts.
    expect(await limiter.hit([key('tok:batch', 3, 3)])).toBe(0);
    expect(await limiter.hit([key('tok:batch', 3, 1)])).not.toBe(0);

    // Only the row whose window closed more than ten minutes ago goes (the fake clock's rows are long closed too).
    await database.db.delete(mcpRateLimits);
    await database.db.insert(mcpRateLimits).values({ key: 'tok:ancient', windowStart: new Date(Date.now() - 30 * 60_000), count: 9 });
    await database.db.insert(mcpRateLimits).values({ key: 'tok:recent', windowStart: new Date(Date.now() - 2 * 60_000), count: 9 });
    expect(await new McpRateLimiter(database.db).sweep()).toBe(1);
    expect((await counters()).map((c) => c.key)).not.toContain('tok:ancient');
    expect((await counters()).map((c) => c.key)).toContain('tok:recent');
  });

  it('stops at the first check it is over, so a refusal by the token does not also spend the tool', async () => {
    const limiter = new McpRateLimiter(database.db);
    await limiter.hit([key('tok:first', 1)]);
    const denial = await limiter.hit([
      key('tok:first', 1),
      { key: 'tok:first:tool:search_docs', limit: 5, cost: 1, scope: 'tool', tool: 'search_docs' },
    ]);
    expect(denial).toMatchObject({ scope: 'token' });
    expect((await counters()).map((c) => c.key)).toEqual(['tok:first']);
  });
});
