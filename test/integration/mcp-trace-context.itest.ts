import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { ProjectRow } from '../../src/db/schema.js';
import { initTracing, setTracing } from '../../src/services/tracing.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';

/**
 * A client's `traceparent` joins the search spans on every request path that reaches a search
 * ([ADR-0119](../../.ssot/ADR.md#adr-0119)): the stateless 2026-07-28 POST, the legacy Streamable HTTP
 * POST on a session, and the legacy SSE message POST. Each of the three wraps its own handler in
 * `withRemoteContext`, so each is proved separately — a fourth route that forgot to would otherwise be
 * the one trace that quietly starts from nothing. Real port, real PostgreSQL, in-memory exporter.
 */

const baseUrl = inject('postgresBaseUrl');
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const GUIDE = '# Delivery guide\n\n## Tuning\n\nSet DISPATCH_WORKERS to the number of cores the host can spare for delivery.\n';

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'trace-itest', version: '0.0.0' },
};

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let project: ProjectRow;
const exporter = new InMemorySpanExporter();

const endpoint = () => new URL(`${live.origin}/mcp/${project.name}`);

/** A W3C `traceparent` with a trace id of its own per test, so spans of one test never match another's. */
function newTraceparent(seed: string): { header: string; traceId: string; parentId: string } {
  const traceId = seed.padStart(32, '0');
  const parentId = '00f067aa0ba902b7';
  return { header: `00-${traceId}-${parentId}-01`, traceId, parentId };
}

/** The spans of one trace, once the in-memory exporter has seen the search root end. */
async function spansOf(traceId: string): Promise<ReadableSpan[]> {
  await expect
    .poll(() => exporter.getFinishedSpans().some((span) => span.spanContext().traceId === traceId && span.name === 'contextator.search.query'))
    .toBe(true);
  return exporter.getFinishedSpans().filter((span) => span.spanContext().traceId === traceId);
}

function expectSearchJoined(spans: ReadableSpan[], parentId: string): void {
  const root = spans.find((span) => span.name === 'contextator.search.query');
  expect(root?.parentSpanContext?.spanId).toBe(parentId);
  // The children hang off the search root, so the whole search is one subtree of the client's trace.
  const rootId = root?.spanContext().spanId;
  const children = spans.filter((span) => span !== root);
  expect(children.map((span) => span.name)).toContain('contextator.search.embed');
  for (const child of children.filter((span) => span.name !== 'contextator.search.rerank')) {
    expect(child.parentSpanContext?.spanId, child.name).toBe(rootId);
  }
}

const toolCall = (id: number, query: string, meta?: object) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'search_docs', arguments: { query, limit: 3 }, ...(meta ? { _meta: meta } : {}) },
});

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_trace_context');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-trace-'));
  project = await seedProject(database.db, 'trace-context', { path: 'handbook/guide.md', body: GUIDE });
  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  await initTracing(
    { endpoint: 'http://collector.invalid:4318', serviceName: 'contextator-itest', version: '0.0.0', spanExporter: exporter },
    { info: () => {}, warn: () => {} },
  );
}, 180_000);

afterAll(async () => {
  setTracing();
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

beforeEach(() => exporter.reset());

describe('a client traceparent', () => {
  it('joins the search on the stateless 2026-07-28 POST', async () => {
    const { header, traceId, parentId } = newTraceparent('a1');
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'search_docs',
        traceparent: header,
      },
      body: JSON.stringify(toolCall(1, 'DISPATCH_WORKERS cores', ENVELOPE)),
    });
    expect(res.status).toBe(200);
    await res.text();

    expectSearchJoined(await spansOf(traceId), parentId);
  });

  it('joins the search on a legacy Streamable HTTP session POST', async () => {
    const { header, traceId, parentId } = newTraceparent('b2');
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(endpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      });

    const opened = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'trace-itest-legacy', version: '0.0.0' } },
    });
    expect(opened.status).toBe(200);
    await opened.text();
    const sessionId = opened.headers.get('mcp-session-id') as string;
    const session = { 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_VERSION };
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).status).toBe(202);

    const searched = await post(toolCall(2, 'DISPATCH_WORKERS cores'), { ...session, traceparent: header });
    expect(searched.status).toBe(200);
    await searched.text();

    expectSearchJoined(await spansOf(traceId), parentId);
    await fetch(endpoint(), { method: 'DELETE', headers: session });
  });

  it('joins the search on a legacy SSE message POST', async () => {
    const { header, traceId, parentId } = newTraceparent('c3');
    const transport = new SSEClientTransport(endpoint(), { requestInit: { headers: { traceparent: header } } });
    const client = new LegacyClient({ name: 'trace-itest-sse', version: '0.0.0' });
    await client.connect(transport);
    try {
      await client.callTool({ name: 'search_docs', arguments: { query: 'DISPATCH_WORKERS cores', limit: 3 } });
    } finally {
      await client.close();
    }

    expectSearchJoined(await spansOf(traceId), parentId);
  });

  it('starts a trace of its own when the request carries none', async () => {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'search_docs',
      },
      body: JSON.stringify(toolCall(1, 'DISPATCH_WORKERS cores', ENVELOPE)),
    });
    expect(res.status).toBe(200);
    await res.text();

    await expect.poll(() => exporter.getFinishedSpans().some((span) => span.name === 'contextator.search.query')).toBe(true);
    const root = exporter.getFinishedSpans().find((span) => span.name === 'contextator.search.query');
    expect(root?.parentSpanContext).toBeUndefined();
  });
});
