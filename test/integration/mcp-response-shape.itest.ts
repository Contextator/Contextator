import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { projects, type ProjectRow } from '../../src/db/schema.js';
import { documentUri } from '../../src/mcp/resources.js';
import { createProjectMcpServer, MAX_CACHE_TTL_MS } from '../../src/mcp/server-factory.js';
import { createMcpToken } from '../../src/services/auth/mcp-tokens.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * What a result looks like on the wire in each protocol era (0.3-02, 0.3-03, 0.3-05;
 * [ADR-0098](../../.ssot/ADR.md#adr-0098), [ADR-0100](../../.ssot/ADR.md#adr-0100)), against a real port
 * and a real PostgreSQL, read as raw JSON-RPC so nothing a client SDK adds or strips is in the way:
 *
 * - a 2026-07-28 result carries `resultType: "complete"`; a 2025 one does not;
 * - a resource that is not there is `-32602` in both eras, with the same message and data — for an
 *   unknown URI and for a project deleted under a request;
 * - `tools/list`, `resources/list` and `resources/read` carry the project's own `ttlMs` / `cacheScope`,
 *   `public` only for an `open` project; `server/discover` and `resources/templates/list` keep the SDK
 *   default; `tools/call` carries no cache field at all;
 * - a 2026-07-28 client always gets `outputSchema` and `structuredContent`, with `MCP_STRUCTURED_OUTPUT`
 *   off as well as on;
 * - a 2025 answer carries none of the 2026 fields, with the flag off and with it on.
 */

const baseUrl = inject('postgresBaseUrl');
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const TOOL_NAMES = ['search_docs', 'list_topics', 'read_document'];
const CACHE_FIELDS = ['ttlMs', 'cacheScope'];
const MODERN_ONLY_FIELDS = ['resultType', ...CACHE_FIELDS];

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'response-shape-itest', version: '0.0.0' },
};

interface JsonRpcReply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

let database: TestDatabase;
let root: string;
/** `MCP_STRUCTURED_OUTPUT` at its default (off). */
let live: LiveInstance;
/** The same product with `MCP_STRUCTURED_OUTPUT=1`. */
let flagged: LiveInstance;
let handbook: ProjectRow;

const GUIDE_URI = () => documentUri(handbook.name, 'handbook/guide.md');
const MISSING_URI = () => documentUri(handbook.name, 'handbook/nope.md');

/** Parses one answer, whether it came back as JSON or as the last SSE event. */
async function parse(res: Response): Promise<JsonRpcReply> {
  const text = await res.text();
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .pop()
    : text;
  return payload ? (JSON.parse(payload) as JsonRpcReply) : {};
}

/** The `Mcp-Name` a 2026-07-28 request carries for the methods that have one. */
function nameHeader(method: string, params: Record<string, unknown>): Record<string, string> {
  if (method === 'tools/call') return { 'mcp-name': String(params.name) };
  if (method === 'resources/read') return { 'mcp-name': String(params.uri) };
  return {};
}

function modernRequest(id: number, method: string, params: Record<string, unknown> = {}): { headers: Record<string, string>; body: unknown } {
  return {
    headers: { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, ...nameHeader(method, params) },
    body: { jsonrpc: '2.0', id, method, params: { ...params, _meta: ENVELOPE } },
  };
}

/** One stateless 2026-07-28 request. */
async function modern(
  method: string,
  params: Record<string, unknown> = {},
  opts: { instance?: LiveInstance; token?: string } = {},
): Promise<JsonRpcReply> {
  const { headers, body } = modernRequest(1, method, params);
  const res = await fetch(`${(opts.instance ?? live).origin}/mcp/${handbook.name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(res.status, `${method} answered ${res.status}`).toBe(200);
  return parse(res);
}

/** A 2025 session: `initialize`, `notifications/initialized`, then each request in turn, then `DELETE`. */
async function legacy(instance: LiveInstance, requests: Array<{ method: string; params?: Record<string, unknown> }>): Promise<JsonRpcReply[]> {
  const url = `${instance.origin}/mcp/${handbook.name}`;
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const opened = await send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'response-shape-legacy', version: '0.0.0' } },
  });
  expect(opened.status).toBe(200);
  const sessionId = opened.headers.get('mcp-session-id') as string;
  expect(sessionId).toBeTruthy();
  await opened.text();
  const onSession = { 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_VERSION };
  expect((await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, onSession)).status).toBe(202);
  try {
    const replies: JsonRpcReply[] = [];
    let id = 1;
    for (const { method, params = {} } of requests) replies.push(await parse(await send({ jsonrpc: '2.0', id: id++, method, params }, onSession)));
    return replies;
  } finally {
    await fetch(url, { method: 'DELETE', headers: onSession });
  }
}

/** The tool definitions of a `tools/list` answer — all three, or the test fails here rather than passing on none. */
function toolsOf(reply: JsonRpcReply): Array<{ name: string; outputSchema?: unknown }> {
  const tools = (reply.result?.tools ?? []) as Array<{ name: string; outputSchema?: unknown }>;
  expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
  return tools;
}

const setProject = (values: Partial<Pick<ProjectRow, 'mcpAuth' | 'lastIndexedAt' | 'status'>>) =>
  database.db.update(projects).set(values).where(eq(projects.id, handbook.id));

/** Thirty days ago: old enough that the lifetime is the cap, so it is a number a test can state exactly. */
const LONG_AGO = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

/** Every read of the surface a 2025 client can make, one request each. */
const LEGACY_SURFACE = () => [
  { method: 'tools/list' },
  { method: 'tools/call', params: { name: 'search_docs', arguments: { query: 'DISPATCH_WORKERS cores', limit: 3 } } },
  { method: 'resources/list' },
  { method: 'resources/templates/list' },
  { method: 'resources/read', params: { uri: GUIDE_URI() } },
];

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_response_shape');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-response-shape-'));
  handbook = await seedProject(database.db, 'response-shape', { path: 'handbook/guide.md', body: HANDBOOK });
  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  flagged = await startMcpInstance(database, { dataDir: path.join(root, '.data-flagged'), docRoot: root, env: { MCP_STRUCTURED_OUTPUT: '1' } });
}, 180_000);

afterAll(async () => {
  await live?.close();
  await flagged?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

beforeEach(async () => {
  await setProject({ mcpAuth: 'open', lastIndexedAt: LONG_AGO(), status: 'idle' });
});

describe('resultType (0.3-02)', () => {
  it('is "complete" on every 2026-07-28 result', async () => {
    for (const [method, params] of [
      ['tools/list', {}],
      ['tools/call', { name: 'search_docs', arguments: { query: 'DISPATCH_WORKERS cores', limit: 3 } }],
      ['resources/list', {}],
      ['resources/templates/list', {}],
      ['resources/read', { uri: GUIDE_URI() }],
      ['server/discover', {}],
    ] as const) {
      const reply = await modern(method, params);
      expect(reply.error, method).toBeUndefined();
      expect(reply.result?.resultType, method).toBe('complete');
    }
  });

  it('is absent from every 2025 result', async () => {
    for (const reply of await legacy(live, LEGACY_SURFACE())) {
      expect(reply.error).toBeUndefined();
      expect(reply.result).not.toHaveProperty('resultType');
    }
  });
});

describe('a resource that is not there (0.3-02)', () => {
  it('is -32602 with the same message and data in both eras, for an unknown URI', async () => {
    const uri = MISSING_URI();
    const expected = { code: -32602, message: `Resource not found: ${uri}`, data: { uri } };
    expect((await modern('resources/read', { uri })).error).toEqual(expected);
    const [onLegacy] = await legacy(live, [{ method: 'resources/read', params: { uri } }]);
    expect(onLegacy.error).toEqual(expected);
  });

  it('is -32602 with the same message and data in both eras, for a project deleted under the request', async () => {
    // The router reads the project before the server is built; this is the project going away between
    // that read and the handler's own — the only window in which the handler, not the router, answers.
    const doomed = await seedProject(database.db, 'response-shape-doomed', { path: 'handbook/guide.md', body: HANDBOOK });
    await database.db.delete(projects).where(eq(projects.id, doomed.id));
    const uri = documentUri(doomed.name, 'handbook/guide.md');
    const expected = { code: -32602, message: `Resource not found: ${uri}`, data: { uri } };

    const handler = createMcpHandler(({ era, authInfo }) => createProjectMcpServer(live.ctx, { project: doomed, era, auth: authInfo }), {
      legacy: 'stateless',
    });
    try {
      const { headers, body } = modernRequest(1, 'resources/read', { uri });
      const modernReply = await parse(
        await handler.fetch(
          new Request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
            body: JSON.stringify(body),
          }),
        ),
      );
      expect(modernReply.error).toEqual(expected);

      const legacyReply = await parse(
        await handler.fetch(
          new Request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY_VERSION },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
          }),
        ),
      );
      expect(legacyReply.error).toEqual(expected);
    } finally {
      await handler.close();
    }
  });
});

describe('cache hints (0.3-03)', () => {
  it("puts the project's own hint on tools/list, resources/list and resources/read", async () => {
    for (const [method, params] of [
      ['tools/list', {}],
      ['resources/list', {}],
      ['resources/read', { uri: GUIDE_URI() }],
    ] as const) {
      const { result } = await modern(method, params);
      expect({ ttlMs: result?.ttlMs, cacheScope: result?.cacheScope }, method).toEqual({ ttlMs: MAX_CACHE_TTL_MS, cacheScope: 'public' });
    }
  });

  it('derives the lifetime from the last index run, and is 0 when there is none or one is running', async () => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    await setProject({ lastIndexedAt: new Date(tenMinutesAgo) });
    const recent = (await modern('tools/list')).result?.ttlMs as number;
    // A tenth of the age: ten minutes old is a minute, plus whatever the request itself took.
    expect(recent).toBeGreaterThanOrEqual(60_000);
    expect(recent).toBeLessThan(60_000 + 5_000);

    await setProject({ lastIndexedAt: null });
    expect((await modern('resources/list')).result?.ttlMs).toBe(0);

    await setProject({ lastIndexedAt: LONG_AGO(), status: 'indexing' });
    expect((await modern('resources/read', { uri: GUIDE_URI() })).result?.ttlMs).toBe(0);
  });

  it('keeps the SDK default on server/discover and resources/templates/list', async () => {
    for (const method of ['server/discover', 'resources/templates/list']) {
      const { result } = await modern(method);
      expect({ ttlMs: result?.ttlMs, cacheScope: result?.cacheScope }, method).toEqual({ ttlMs: 0, cacheScope: 'private' });
    }
  });

  it('puts no cache field on tools/call', async () => {
    const { result } = await modern('tools/call', { name: 'search_docs', arguments: { query: 'install the package', limit: 3 } });
    for (const field of CACHE_FIELDS) expect(result).not.toHaveProperty(field);
  });

  it('is never public on a token-protected project', async () => {
    await setProject({ mcpAuth: 'token' });
    const { token } = await createMcpToken(database.db, handbook.id, 'cache scope', null);
    for (const [method, params] of [
      ['tools/list', {}],
      ['tools/call', { name: 'list_topics', arguments: {} }],
      ['resources/list', {}],
      ['resources/templates/list', {}],
      ['resources/read', { uri: GUIDE_URI() }],
      ['server/discover', {}],
    ] as const) {
      const { result, error } = await modern(method, params, { token });
      expect(error, method).toBeUndefined();
      expect(result?.cacheScope, method).not.toBe('public');
    }
    expect((await modern('tools/list', {}, { token })).result?.cacheScope).toBe('private');
  });
});

describe('structured output (0.3-05)', () => {
  for (const [label, instance] of [
    ['with MCP_STRUCTURED_OUTPUT off', () => live],
    ['with MCP_STRUCTURED_OUTPUT on', () => flagged],
  ] as const) {
    it(`is always there for a 2026-07-28 client, ${label}`, async () => {
      for (const tool of toolsOf(await modern('tools/list', {}, { instance: instance() }))) expect(tool.outputSchema, tool.name).toBeDefined();

      const call = await modern(
        'tools/call',
        { name: 'search_docs', arguments: { query: 'DISPATCH_WORKERS cores', limit: 3 } },
        { instance: instance() },
      );
      expect(call.result?.structuredContent).toBeTypeOf('object');
      const content = (call.result?.content ?? []) as Array<{ type: string; text?: string }>;
      expect(content.find((c) => c.type === 'text')?.text).toContain('handbook/guide.md');
    });
  }

  it('still follows the flag for a 2025 client', async () => {
    const [offList, offCall] = await legacy(live, LEGACY_SURFACE().slice(0, 2));
    for (const tool of toolsOf(offList)) expect(tool).not.toHaveProperty('outputSchema');
    expect(offCall.result).not.toHaveProperty('structuredContent');

    const [onList, onCall] = await legacy(flagged, LEGACY_SURFACE().slice(0, 2));
    for (const tool of toolsOf(onList)) expect(tool.outputSchema).toBeDefined();
    expect(onCall.result?.structuredContent).toBeTypeOf('object');
  });
});

describe('a 2025 answer', () => {
  for (const [label, instance] of [
    ['with MCP_STRUCTURED_OUTPUT off', () => live],
    ['with MCP_STRUCTURED_OUTPUT on', () => flagged],
  ] as const) {
    it(`carries no 2026 field, ${label}`, async () => {
      for (const reply of await legacy(instance(), LEGACY_SURFACE())) {
        expect(reply.error).toBeUndefined();
        for (const field of MODERN_ONLY_FIELDS) expect(reply.result).not.toHaveProperty(field);
      }
    });
  }
});
