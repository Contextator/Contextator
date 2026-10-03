import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { projects, searchQueries, type ProjectRow } from '../../src/db/schema.js';
import { createMcpToken, revokeMcpToken } from '../../src/services/auth/mcp-tokens.js';
import { QueryLog } from '../../src/services/query-log.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * Both protocol eras on the one `/mcp/:project` URL ([ADR-0098](../../.ssot/ADR.md#adr-0098)), against
 * a real port, a real PostgreSQL and real clients of both SDK generations:
 *
 * - a 2026-07-28 client discovers and calls `search_docs` without a handshake, and leaves nothing in
 *   the session registry behind it;
 * - a 2025 client still opens a session and searches, exactly as before;
 * - a revoked token is refused in both eras ([ADR-0099](../../.ssot/ADR.md#adr-0099));
 * - a search is attributed to the token that made it ([ADR-0047](../../.ssot/ADR.md#adr-0047)) — in the
 *   modern era, and in a legacy session whose client swaps its token half-way through.
 */

const baseUrl = inject('postgresBaseUrl');
const MODERN_VERSION = '2026-07-28';

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'dual-era-itest', version: '0.0.0' },
};

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let handbook: ProjectRow;
let queryLog: QueryLog;

const endpoint = (project = handbook.name) => new URL(`${live.origin}/mcp/${project}`);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The parts of a JSON-RPC answer these tests read. */
interface JsonRpcReply {
  id?: unknown;
  result?: { content: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

/** One raw JSON-RPC POST; the answer is parsed whether it came back as JSON or as one SSE event. */
async function post(
  body: unknown,
  headers: Record<string, string> = {},
  project = handbook.name,
): Promise<{ status: number; json: JsonRpcReply; headers: Headers }> {
  const res = await fetch(endpoint(project), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .pop()
    : text;
  let json: JsonRpcReply = {};
  try {
    json = payload ? (JSON.parse(payload) as JsonRpcReply) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json, headers: res.headers };
}

/**
 * The headers a 2026-07-28 `search_docs` call carries beside its body, which the SDK checks agree with
 * it. They are here so the raw requests are well-formed; what happens when they disagree is not this
 * suite's subject.
 */
const MODERN_HEADERS = { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call', 'mcp-name': 'search_docs' };

const modernSearch = (id: number, query: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'search_docs', arguments: { query, limit: 3 }, _meta: ENVELOPE },
});

/** A 2026-07-28 client, pinned so that a silent fallback to `initialize` would fail the test. */
async function modernClient(token?: string): Promise<ModernClient> {
  const client = new ModernClient({ name: 'dual-era-itest', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN_VERSION } } });
  await client.connect(new ModernTransport(endpoint(), { requestInit: token ? { headers: bearer(token) } : undefined }));
  return client;
}

const textOf = (result: unknown) =>
  (((result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined) ?? []).find((c) => c.type === 'text')?.text ??
  '';

const loggedQueries = () =>
  database.db.select().from(searchQueries).where(eq(searchQueries.projectId, handbook.id)).orderBy(asc(searchQueries.createdAt));

const setMode = (mode: 'open' | 'token') => database.db.update(projects).set({ mcpAuth: mode }).where(eq(projects.id, handbook.id));

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_dual_era');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-dual-era-'));
  handbook = await seedProject(database.db, 'dual-era', { path: 'handbook/guide.md', body: HANDBOOK });
  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  // The helper's context has no query log; this suite is partly about what lands in one.
  queryLog = new QueryLog(database.db, silentLogger);
  (live.ctx as { queryLog?: QueryLog }).queryLog = queryLog;
}, 180_000);

afterAll(async () => {
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

beforeEach(async () => {
  await setMode('open');
  await queryLog.flush();
  await database.db.delete(searchQueries);
});

describe('a 2026-07-28 client', () => {
  it('discovers and searches without a handshake', async () => {
    const client = await modernClient();
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['search_docs', 'list_topics', 'read_document']);
      const result = await client.callTool({ name: 'search_docs', arguments: { query: 'DISPATCH_WORKERS cores', limit: 3 } });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('handbook/guide.md');
    } finally {
      await client.close();
    }
  });

  it('leaves nothing in the session registry', async () => {
    const before = live.ctx.sessions.stats().total;
    const reply = await post(modernSearch(1, 'install the package'), MODERN_HEADERS);
    expect(reply.status).toBe(200);
    expect(reply.json.result?.content[0].text).toContain('handbook/guide.md');
    expect(reply.headers.get('mcp-session-id')).toBeNull();
    expect(live.ctx.sessions.stats().total).toBe(before);
  });

  it('is answered 404 with -32602 for a project that does not exist', async () => {
    const reply = await post(modernSearch(7, 'anything'), MODERN_HEADERS, 'no-such-project');
    expect(reply.status).toBe(404);
    expect(reply.json.id).toBe(7);
    expect(reply.json.error?.code).toBe(-32602);
  });
});

describe('a 2025 client on the same URL', () => {
  it('still opens a session and searches', async () => {
    const before = live.ctx.sessions.stats().total;
    const transport = new LegacyTransport(endpoint());
    const client = new LegacyClient({ name: 'dual-era-legacy', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeTruthy();
      expect(live.ctx.sessions.stats().total).toBe(before + 1);
      const result = await client.callTool({ name: 'search_docs', arguments: { query: 'DISPATCH_WORKERS cores', limit: 3 } });
      expect(textOf(result)).toContain('handbook/guide.md');
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  });

  it('is answered 404 with -32001 for a project that does not exist', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dual-era-legacy', version: '0.0.0' } },
    };
    const reply = await post(initialize, {}, 'no-such-project');
    expect(reply.status).toBe(404);
    expect(reply.json.error).toEqual({ code: -32001, message: 'Unknown project "no-such-project"' });
  });

  it('is answered 404 with -32001 for a project that does not exist even when the body cannot be read', async () => {
    const send = (project: string, contentType: string, body: string) =>
      fetch(endpoint(project), { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json, text/event-stream' }, body });

    for (const [contentType, body] of [
      ['application/json', '{bad'],
      ['application/json', ''],
      ['application/x-unparsed', 'whatever'],
    ]) {
      const res = await send('no-such-project', contentType, body);
      expect(res.status, `${contentType} ${JSON.stringify(body)}`).toBe(404);
      expect(((await res.json()) as JsonRpcReply).error?.code).toBe(-32001);
    }
    // A project that does exist still gets Fastify's own answer to a body it cannot parse.
    expect((await send(handbook.name, 'application/json', '{bad')).status).toBe(400);
  });
});

describe('the token, per request', () => {
  it('is refused with 401 in both eras once revoked', async () => {
    await setMode('token');
    const { token, view } = await createMcpToken(database.db, handbook.id, 'soon revoked', null);

    // Both eras work with the live token first, so the refusal below is about the revocation.
    expect((await post(modernSearch(1, 'install'), { ...MODERN_HEADERS, ...bearer(token) })).status).toBe(200);
    const legacy = new LegacyTransport(endpoint(), { requestInit: { headers: bearer(token) } });
    const legacyClient = new LegacyClient({ name: 'dual-era-legacy', version: '0.0.0' });
    await legacyClient.connect(legacy);
    const sessionId = legacy.sessionId as string;

    await revokeMcpToken(database.db, handbook.id, view.id);

    expect((await post(modernSearch(2, 'install'), { ...MODERN_HEADERS, ...bearer(token) })).status).toBe(401);
    const onSession = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_docs', arguments: { query: 'install' } } },
      { ...bearer(token), 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25' },
    );
    expect(onSession.status).toBe(401);
    await legacyClient.close().catch(() => {});
    // The revoked token cannot end the session it opened, so it is ended without one: an open project
    // takes a DELETE with no credential. Nothing is left in the registry for a later assertion to trip on.
    await setMode('open');
    expect((await fetch(endpoint(), { method: 'DELETE', headers: { 'mcp-session-id': sessionId } })).status).toBe(200);
    expect(live.ctx.sessions.get(sessionId, 'streamable')).toBeUndefined();
  });

  it('attributes a modern-era search to the token that made it', async () => {
    await setMode('token');
    const { token, view } = await createMcpToken(database.db, handbook.id, 'modern agent', null);
    const client = await modernClient(token);
    try {
      await client.callTool({ name: 'search_docs', arguments: { query: 'install the package', limit: 3 } });
    } finally {
      await client.close();
    }
    await queryLog.flush();
    const rows = await loggedQueries();
    expect(rows).toHaveLength(1);
    expect(rows[0].mcpTokenId).toBe(view.id);
  });

  it('follows a legacy session whose client swaps from token A to token B', async () => {
    await setMode('token');
    const a = await createMcpToken(database.db, handbook.id, 'token A', null);
    const b = await createMcpToken(database.db, handbook.id, 'token B', null);

    const opened = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'swapper', version: '0.0.0' } },
      },
      bearer(a.token),
    );
    expect(opened.status).toBe(200);
    const sessionId = opened.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();
    const onSession = (token: string) => ({ ...bearer(token), 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25' });
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, onSession(a.token))).status).toBe(202);

    const search = (id: number, query: string) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query, limit: 3 } },
    });
    expect((await post(search(2, 'first query from A'), onSession(a.token))).status).toBe(200);
    expect((await post(search(3, 'second query from B'), onSession(b.token))).status).toBe(200);

    await queryLog.flush();
    const rows = await loggedQueries();
    expect(rows.map((r) => [r.query, r.mcpTokenId])).toEqual([
      ['first query from A', a.view.id],
      ['second query from B', b.view.id],
    ]);

    await fetch(endpoint(), { method: 'DELETE', headers: onSession(b.token) });
  });
});
