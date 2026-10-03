import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ProjectRow } from '../../src/db/schema.js';
import { MCP_PROMPT_NAMES } from '../../src/mcp/prompts.js';
import { MCP_TOOL_NAMES } from '../../src/mcp/tools.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * Three things 0.3.0 adds on top of the dual-era endpoint ([ADR-0098](../../.ssot/ADR.md#adr-0098)),
 * against a real port, a real PostgreSQL and real clients of both SDK generations:
 *
 * - **the standard request headers.** The 2026-07-28 revision has a client repeat parts of its body in
 *   `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`, and has the server refuse a request whose
 *   headers and body disagree. Contextator writes no code for this — the SDK's `createMcpHandler`
 *   checks it — so what is pinned here is the answer a client gets, HTTP status and JSON-RPC code, for
 *   every row of the matrix, and that a header-less 2025 request is still served;
 * - **the MCP metrics**: `contextator_mcp_requests_total{method,tool,era}` and
 *   `contextator_mcp_tool_duration_seconds{tool}`, seen through `/metrics` after real traffic in both eras;
 * - **the prompts**, listed and fetched in both eras.
 */

const baseUrl = inject('postgresBaseUrl');
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.
`;

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'headers-itest', version: '0.0.0' },
};

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let handbook: ProjectRow;

const endpoint = () => new URL(`${live.origin}/mcp/${handbook.name}`);

interface JsonRpcReply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** One raw JSON-RPC POST; the answer is parsed whether it came back as JSON or as one SSE event. */
async function post(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: JsonRpcReply; headers: Headers }> {
  const res = await fetch(endpoint(), {
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

/** A well-formed 2026-07-28 request: envelope in the body, the three standard headers beside it. */
function modern(method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = ENVELOPE) {
  return { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } };
}

const headersFor = (method: string, name?: string): Record<string, string> => ({
  'mcp-protocol-version': MODERN_VERSION,
  'mcp-method': method,
  ...(name !== undefined ? { 'mcp-name': name } : {}),
});

const without = <V>(record: Record<string, V>, key: string): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const base64Sentinel = (value: string) => `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;

const searchCall = { name: 'search_docs', arguments: { query: 'install the package', limit: 1 } };

async function modernClient(): Promise<ModernClient> {
  const client = new ModernClient({ name: 'headers-itest', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN_VERSION } } });
  await client.connect(new ModernTransport(endpoint()));
  return client;
}

async function legacyClient(): Promise<LegacyClient> {
  const client = new LegacyClient({ name: 'headers-itest-legacy', version: '0.0.0' });
  await client.connect(new LegacyTransport(endpoint()));
  return client;
}

async function scrape(): Promise<string> {
  const res = await fetch(`${live.origin}/metrics`);
  expect(res.status).toBe(200);
  return res.text();
}

/** The value of one exposition sample, by its full series name and labels; `undefined` when absent. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

const requests = (method: string, tool: string, era: string) => `contextator_mcp_requests_total{method="${method}",tool="${tool}",era="${era}"}`;

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_headers');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-headers-'));
  handbook = await seedProject(database.db, 'headers', { path: 'handbook/guide.md', body: HANDBOOK });
  live = await startMcpInstance(database, {
    dataDir: path.join(root, '.data'),
    docRoot: root,
    // `/metrics` is an authenticated route by default; this suite reads it without an account.
    env: { METRICS_PUBLIC: '1' },
  });
}, 180_000);

afterAll(async () => {
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('the standard request headers (validated by the SDK, not by Contextator)', () => {
  /** Each row: the request, and the HTTP status and JSON-RPC code the SDK answers it with. */
  const matrix: Array<{ name: string; body: unknown; headers: Record<string, string>; status: number; code: number }> = [
    {
      name: 'Mcp-Method missing',
      body: modern('tools/list'),
      headers: without(headersFor('tools/list'), 'mcp-method'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Method disagreeing with the body',
      body: modern('tools/list'),
      headers: headersFor('resources/list'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name missing on tools/call',
      body: modern('tools/call', searchCall),
      headers: headersFor('tools/call'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name disagreeing on tools/call',
      body: modern('tools/call', searchCall),
      headers: headersFor('tools/call', 'read_document'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name missing on resources/read',
      body: modern('resources/read', { uri: 'contextator://headers/handbook/guide.md' }),
      headers: headersFor('resources/read'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name disagreeing on resources/read',
      body: modern('resources/read', { uri: 'contextator://headers/handbook/guide.md' }),
      headers: headersFor('resources/read', 'contextator://headers/handbook/other.md'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name missing on prompts/get',
      body: modern('prompts/get', { name: 'answer_from_docs', arguments: { question: 'How do I install it?' } }),
      headers: headersFor('prompts/get'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name disagreeing on prompts/get',
      body: modern('prompts/get', { name: 'answer_from_docs', arguments: { question: 'How do I install it?' } }),
      headers: headersFor('prompts/get', 'explore_topic'),
      status: 400,
      code: -32020,
    },
    {
      name: 'Mcp-Name carrying a malformed Base64 sentinel',
      body: modern('tools/call', searchCall),
      headers: headersFor('tools/call', '=?base64?not base64!?='),
      status: 400,
      code: -32020,
    },
    {
      name: 'MCP-Protocol-Version disagreeing with _meta.protocolVersion',
      body: modern('tools/list'),
      headers: { ...headersFor('tools/list'), 'mcp-protocol-version': LEGACY_VERSION },
      status: 400,
      code: -32020,
    },
    {
      name: 'MCP-Protocol-Version missing',
      body: modern('tools/list'),
      headers: without(headersFor('tools/list'), 'mcp-protocol-version'),
      status: 400,
      code: -32020,
    },
    {
      name: 'an unsupported protocol version',
      body: modern('tools/list', {}, { ...ENVELOPE, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }),
      headers: { ...headersFor('tools/list'), 'mcp-protocol-version': '2099-01-01' },
      status: 400,
      code: -32022,
    },
    {
      name: 'an envelope missing a required field',
      body: modern('tools/list', {}, without(ENVELOPE, 'io.modelcontextprotocol/clientCapabilities')),
      headers: headersFor('tools/list'),
      status: 400,
      code: -32602,
    },
    {
      name: 'a modern MCP-Protocol-Version header on a body with no envelope',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      headers: headersFor('tools/list'),
      status: 400,
      code: -32602,
    },
    {
      name: 'a method the server does not know',
      body: modern('no/such-method'),
      headers: headersFor('no/such-method'),
      status: 404,
      code: -32601,
    },
  ];

  it.each(matrix)('$name → HTTP $status, JSON-RPC $code', async ({ body, headers, status, code }) => {
    const reply = await post(body, headers);
    expect(reply.status).toBe(status);
    expect(reply.json.error?.code).toBe(code);
  });

  it('accepts an Mcp-Name sent as a Base64 sentinel, and serves the call', async () => {
    const reply = await post(modern('tools/call', searchCall), headersFor('tools/call', base64Sentinel('search_docs')));
    expect(reply.status).toBe(200);
    expect(reply.json.error).toBeUndefined();
    expect(reply.json.result?.isError).not.toBe(true);
  });

  it('accepts a non-ASCII Mcp-Name sent as a Base64 sentinel', async () => {
    // A prompt name no ASCII header could carry. That the prompt does not exist is the point: the
    // answer is the in-band "unknown prompt" error (HTTP 200), not the -32020 header rejection.
    const name = 'açıklama_özeti';
    const reply = await post(modern('prompts/get', { name }), headersFor('prompts/get', base64Sentinel(name)));
    expect(reply.status).toBe(200);
    expect(reply.json.error?.code).not.toBe(-32020);
    expect(reply.json.error?.message).toContain(name);

    // The same name, encoded, disagreeing with the body: decoded before it is compared, so refused.
    const mismatch = await post(modern('prompts/get', { name }), headersFor('prompts/get', base64Sentinel('başka_bir_ad')));
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error?.code).toBe(-32020);
  });

  it('leaves a header-less 2025 request alone', async () => {
    const opened = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'bare-legacy', version: '0.0.0' } },
    });
    expect(opened.status).toBe(200);
    expect(opened.json.error).toBeUndefined();
    const sessionId = opened.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // A session request with no Mcp-Method, no Mcp-Name — the 2025 wire, untouched.
    const session = { 'mcp-session-id': sessionId as string };
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).status).toBe(202);
    const called = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: searchCall }, session);
    expect(called.status).toBe(200);
    expect(called.json.error).toBeUndefined();
    expect(called.json.result?.isError).not.toBe(true);

    expect((await fetch(endpoint(), { method: 'DELETE', headers: session })).status).toBe(200);
  });
});

describe('prompts', () => {
  it('are listed and fetched by a 2026-07-28 client', async () => {
    const client = await modernClient();
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const listed = await client.listPrompts();
      expect(listed.prompts.map((p) => p.name)).toEqual([...MCP_PROMPT_NAMES]);
      const got = await client.getPrompt({ name: 'answer_from_docs', arguments: { question: 'How do I install it?' } });
      const message = got.messages[0];
      expect(message.role).toBe('user');
      expect(message.content.type === 'text' && message.content.text).toContain('Question: How do I install it?');
      expect(message.content.type === 'text' && message.content.text).toContain('"headers"');
    } finally {
      await client.close();
    }
  });

  it('keep the SDK cache default on a 2026-07-28 answer, even on an open project', async () => {
    // The project's own hint (`public` on an `open` project) is for tools and resources only:
    // `prompts/list` keeps `ttlMs: 0`, `cacheScope: "private"`, and `prompts/get` — like `tools/call` —
    // carries no hint at all, so neither can be cached as public.
    const listed = await post(modern('prompts/list'), headersFor('prompts/list'));
    expect(listed.status).toBe(200);
    expect({ ttlMs: listed.json.result?.ttlMs, cacheScope: listed.json.result?.cacheScope }).toEqual({ ttlMs: 0, cacheScope: 'private' });

    const got = await post(
      modern('prompts/get', { name: 'explore_topic', arguments: { topic: 'installation' } }),
      headersFor('prompts/get', 'explore_topic'),
    );
    expect(got.status).toBe(200);
    expect(got.json.result?.cacheScope).not.toBe('public');
    expect(got.json.result?.ttlMs ?? 0).toBe(0);
  });

  it('are listed and fetched by a 2025 client', async () => {
    const client = await legacyClient();
    try {
      expect(client.getServerCapabilities()?.prompts).toBeDefined();
      const listed = await client.listPrompts();
      expect(listed.prompts.map((p) => p.name)).toEqual([...MCP_PROMPT_NAMES]);
      const got = await client.getPrompt({ name: 'explore_topic', arguments: { topic: 'installation' } });
      expect(got.messages[0].content.type === 'text' && got.messages[0].content.text).toContain('Topic: installation');
    } finally {
      await client.close();
    }
  });

  it('refuse a missing argument in both eras', async () => {
    const modernReply = await post(modern('prompts/get', { name: 'answer_from_docs', arguments: {} }), headersFor('prompts/get', 'answer_from_docs'));
    expect(modernReply.json.error?.code).toBe(-32602);

    const client = await legacyClient();
    try {
      await expect(client.getPrompt({ name: 'answer_from_docs', arguments: {} })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe('/metrics', () => {
  it('labels tools by exactly the names tools/list answers with', async () => {
    const listed = await post(modern('tools/list'), headersFor('tools/list'));
    const names = ((listed.json.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
    expect([...names].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('counts MCP traffic by method, tool and era, and times tool calls', async () => {
    const before = await scrape();
    const modernBefore = sample(before, requests('tools/call', 'search_docs', 'modern')) ?? 0;
    const legacyBefore = sample(before, requests('tools/call', 'search_docs', 'legacy')) ?? 0;
    const timedBefore = sample(before, 'contextator_mcp_tool_duration_seconds_count{tool="search_docs"}') ?? 0;

    const modernSide = await modernClient();
    try {
      await modernSide.callTool({ name: 'search_docs', arguments: { query: 'install', limit: 1 } });
      await modernSide.callTool({ name: 'list_topics', arguments: {} });
    } finally {
      await modernSide.close();
    }
    const legacySide = await legacyClient();
    try {
      await legacySide.callTool({ name: 'search_docs', arguments: { query: 'install', limit: 1 } });
      // Unknown to the server: counted, but under `other` rather than under a name it made up.
      await legacySide.callTool({ name: 'no_such_tool', arguments: {} });
    } finally {
      await legacySide.close();
    }
    // An unknown method, also folded into `other` — and still counted although the SDK turns it away.
    await post(modern('made/up'), headersFor('made/up'));

    const after = await scrape();
    expect(after).toContain('# TYPE contextator_mcp_requests_total counter');
    expect(after).toContain('# TYPE contextator_mcp_tool_duration_seconds histogram');

    expect(sample(after, requests('tools/call', 'search_docs', 'modern'))).toBe(modernBefore + 1);
    expect(sample(after, requests('tools/call', 'search_docs', 'legacy'))).toBe(legacyBefore + 1);
    expect(sample(after, requests('tools/call', 'list_topics', 'modern'))).toBeGreaterThanOrEqual(1);
    expect(sample(after, requests('tools/call', 'other', 'legacy'))).toBeGreaterThanOrEqual(1);
    expect(sample(after, requests('initialize', '', 'legacy'))).toBeGreaterThanOrEqual(1);
    expect(sample(after, requests('other', '', 'modern'))).toBeGreaterThanOrEqual(1);
    // Neither the made-up tool nor the made-up method became a label of its own.
    expect(after).not.toContain('no_such_tool');
    expect(after).not.toContain('made/up');

    // Two answered `search_docs` calls, one per era; the unknown tool never reached a handler.
    expect(sample(after, 'contextator_mcp_tool_duration_seconds_count{tool="search_docs"}')).toBe(timedBefore + 2);
    expect(sample(after, 'contextator_mcp_tool_duration_seconds_count{tool="list_topics"}')).toBeGreaterThanOrEqual(1);
    expect(after).not.toContain('contextator_mcp_tool_duration_seconds_count{tool="other"}');
  });
});
