import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { mcpTokens, projects, type ProjectRow } from '../../src/db/schema.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * 0.2.1 Faz 05, over a real PostgreSQL and real MCP clients.
 *
 * 1. A static MCP token may be minted with a lifetime. Once it has passed, a `token` project answers
 *    `401` — and a token minted without one keeps working. The list says when each one ends.
 * 2. Every legacy HTTP+SSE response says `Deprecation: true` and no Streamable HTTP response does;
 *    nothing says `Sunset` ([ADR-0096](../../.ssot/ADR.md#adr-0096)). The legacy transport otherwise
 *    behaves exactly as before: a client connects, lists the tools and calls one.
 * 3. After a legacy SSE client has been seen, the admin API says when, per project — the signal the
 *    dashboard warns from. Streamable HTTP traffic never sets it.
 */

const baseUrl = inject('postgresBaseUrl');
const ADMIN_TOKEN = 'an-admin-token-for-the-token-expiry-suite';

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.
`;

let database: TestDatabase;
let live: LiveInstance;
let root: string;
/** `token` mode: where an expired token has to be refused. */
let guarded: ProjectRow;
/** `open`: the legacy SSE client's project. */
let legacy: ProjectRow;
/** `open`: only ever spoken to over Streamable HTTP. */
let modern: ProjectRow;

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
};

/** A Streamable HTTP `initialize`: the cheapest request that has to pass the access hook. */
async function initialize(project: ProjectRow, token?: string): Promise<Response> {
  return fetch(`${live.origin}/mcp/${project.name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(INITIALIZE),
  });
}

/**
 * Opens the legacy SSE stream and reads it as far as the `endpoint` event, which carries the
 * `/messages` URL of the session. The stream stays open until `abort()`.
 */
async function openSseStream(project: ProjectRow): Promise<{ res: Response; endpoint: string; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${live.origin}/mcp/${project.name}`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`SSE stream ended before an endpoint event: ${buffered}`);
    buffered += decoder.decode(value, { stream: true });
    const match = /event: endpoint\r?\ndata: (\S+)/.exec(buffered);
    if (match) return { res, endpoint: match[1], abort: () => controller.abort() };
  }
}

interface Minted {
  token: { id: string; name: string; expiresAt: string | null };
  secret: string;
}

async function mint(body: Record<string, unknown>): Promise<{ status: number; json: Minted }> {
  const res = await live.app.inject({ method: 'POST', url: `/api/projects/${guarded.id}/mcp-tokens`, headers: admin, payload: body });
  return { status: res.statusCode, json: res.json() };
}

async function projectFromList(project: ProjectRow): Promise<Record<string, unknown>> {
  const res = await live.app.inject({ method: 'GET', url: '/api/projects', headers: admin });
  expect(res.statusCode).toBe(200);
  return res.json().find((p: { id: string }) => p.id === project.id);
}

async function projectFromStatus(project: ProjectRow): Promise<Record<string, unknown>> {
  const res = await live.app.inject({ method: 'GET', url: `/api/projects/${project.id}/status`, headers: admin });
  expect(res.statusCode).toBe(200);
  return res.json().project;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'token_expiry_sse');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-token-expiry-'));

  guarded = await seedProject(database.db, 'guarded', { path: 'handbook/guide.md', body: HANDBOOK });
  await database.db.update(projects).set({ mcpAuth: 'token' }).where(eq(projects.id, guarded.id));
  legacy = await seedProject(database.db, 'legacy', { path: 'handbook/guide.md', body: HANDBOOK });
  modern = await seedProject(database.db, 'modern', { path: 'handbook/guide.md', body: HANDBOOK });

  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root, env: { ADMIN_TOKEN } });
});

afterAll(async () => {
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('a static MCP token with a lifetime', () => {
  it('is minted with expiresAt that many days ahead, and works until then', async () => {
    const before = Date.now();
    const { status, json } = await mint({ name: 'thirty days', expiresInDays: 30 });
    expect(status).toBe(201);
    const expiresAt = Date.parse(json.token.expiresAt ?? '');
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + thirtyDays);

    expect((await initialize(guarded, json.secret)).status).toBe(200);
  });

  it('is minted without one by default, and that token never expires', async () => {
    const { status, json } = await mint({ name: 'forever' });
    expect(status).toBe(201);
    expect(json.token.expiresAt).toBeNull();
    expect((await initialize(guarded, json.secret)).status).toBe(200);
  });

  it('is refused with 401 once its lifetime has passed', async () => {
    const { json } = await mint({ name: 'soon gone', expiresInDays: 30 });
    expect((await initialize(guarded, json.secret)).status).toBe(200);

    // A month is a long test. The database's own clock is what the check reads, so move the row instead.
    await database.db
      .update(mcpTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(mcpTokens.id, json.token.id));

    const res = await initialize(guarded, json.secret);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
  });

  it('lists every token with its expiresAt, an expired one included', async () => {
    // Its own tokens, so the test stands alone (`vitest -t`) and in any order.
    const forever = await mint({ name: 'listed forever' });
    const yearly = await mint({ name: 'listed yearly', expiresInDays: 365 });
    const expired = await mint({ name: 'listed expired', expiresInDays: 90 });
    for (const minted of [forever, yearly, expired]) expect(minted.status).toBe(201);
    await database.db
      .update(mcpTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(mcpTokens.id, expired.json.token.id));

    const res = await live.app.inject({ method: 'GET', url: `/api/projects/${guarded.id}/mcp-tokens`, headers: admin });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.json().map((t: { name: string; expiresAt: string | null }) => [t.name, t.expiresAt]));
    expect(byName['listed forever']).toBeNull();
    expect(Date.parse(byName['listed yearly'])).toBeGreaterThan(Date.now() + 364 * 24 * 60 * 60 * 1000);
    expect(Date.parse(byName['listed expired'])).toBeLessThan(Date.now());
  });

  it('refuses a lifetime the API does not offer', async () => {
    for (const expiresInDays of [1, 45, 3650, 0, -30, 30.5, '30']) {
      expect((await mint({ name: 'bad', expiresInDays })).status).toBe(400);
    }
  });
});

describe('the legacy SSE transport (ADR-0096)', () => {
  it('Streamable HTTP answers carry neither Deprecation nor Sunset', async () => {
    const init = await initialize(modern);
    expect(init.status).toBe(200);
    expect(init.headers.get('deprecation')).toBeNull();
    expect(init.headers.get('sunset')).toBeNull();
    const sessionId = init.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    await init.text();

    // The server stream of the same session — a GET, like the legacy stream, but with a session header.
    const controller = new AbortController();
    const stream = await fetch(`${live.origin}/mcp/${modern.name}`, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('deprecation')).toBeNull();
    expect(stream.headers.get('sunset')).toBeNull();
    controller.abort();

    const end = await fetch(`${live.origin}/mcp/${modern.name}`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
    });
    expect(end.headers.get('deprecation')).toBeNull();
    expect(end.headers.get('sunset')).toBeNull();
  });

  it('marks the SSE stream and its /messages answers Deprecation: true, and nothing Sunset', async () => {
    const { res, endpoint, abort } = await openSseStream(legacy);
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(res.headers.get('deprecation')).toBe('true');
      expect(res.headers.get('sunset')).toBeNull();

      const message = await fetch(new URL(endpoint, live.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(INITIALIZE),
      });
      expect(message.status).toBe(202);
      expect(message.headers.get('deprecation')).toBe('true');
      expect(message.headers.get('sunset')).toBeNull();
    } finally {
      abort();
    }

    // A refusal on the legacy channel is still a legacy answer.
    const unknown = await fetch(`${live.origin}/mcp/${legacy.name}/messages?sessionId=not-a-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(INITIALIZE),
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('deprecation')).toBe('true');
    expect(unknown.headers.get('sunset')).toBeNull();

    const refused = await fetch(`${live.origin}/mcp/${guarded.name}`, { headers: { accept: 'text/event-stream' } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('deprecation')).toBe('true');
    expect(refused.headers.get('sunset')).toBeNull();
  });

  it('still connects, lists the tools and answers a call', async () => {
    const client = new Client({ name: 'legacy-sse-itest', version: '0.0.0' });
    await client.connect(new SSEClientTransport(new URL(`${live.origin}/mcp/${legacy.name}`)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('search_docs');

      const result = await client.callTool({ name: 'search_docs', arguments: { query: 'install the package', limit: 3 } });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
      expect(text).toContain('handbook/guide.md');
    } finally {
      await client.close();
    }
  });

  it('is reported per project by the admin API once a legacy client has been seen', async () => {
    // Its own legacy client and its own refused one, so the test stands alone (`vitest -t`) and in any order.
    const { abort } = await openSseStream(legacy);
    abort();
    const refused = await fetch(`${live.origin}/mcp/${guarded.name}`, { headers: { accept: 'text/event-stream' } });
    expect(refused.status).toBe(401);
    expect((await initialize(modern)).status).toBe(200);

    await vi.waitFor(
      async () => {
        expect((await projectFromList(legacy)).lastLegacySseAt).toEqual(expect.any(String));
      },
      { timeout: 5_000, interval: 100 },
    );
    const fromList = (await projectFromList(legacy)).lastLegacySseAt as string;
    expect(Date.now() - Date.parse(fromList)).toBeLessThan(5 * 60_000);
    expect((await projectFromStatus(legacy)).lastLegacySseAt).toBe(fromList);

    // Streamable HTTP traffic never stamps it, and neither does a refused SSE request.
    expect((await projectFromList(modern)).lastLegacySseAt).toBeNull();
    expect((await projectFromStatus(modern)).lastLegacySseAt).toBeNull();
    expect((await projectFromList(guarded)).lastLegacySseAt).toBeNull();
  });
});
