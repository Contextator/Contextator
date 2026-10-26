import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see queries-panel.test.ts.
import { reportedGapsBlock } from '../../public/queries.js';
import { mcpTokens, projects, reportedGaps, searchQueries, type ProjectRow } from '../../src/db/schema.js';
import { createMcpToken } from '../../src/services/auth/mcp-tokens.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { QueryLog } from '../../src/services/query-log.js';
import { purgeProjectReportedGaps, pruneProjectReportedGaps, reportGap, sweepReportedGaps } from '../../src/services/report-gap.js';
import { descendants, fakeDocument } from '../helpers/fake-dom.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, type TestDatabase } from './support/postgres.js';

/**
 * `report_gap` ([ADR-0125](../../.ssot/ADR.md#adr-0125)) against a real port, a real PostgreSQL and real
 * clients: the first MCP tool that writes, and the four things the ADR makes it answerable for.
 *
 * - **Where it writes**: its own table, never `search_queries`, never documentation.
 * - **That the answer is one answer**: "received", for a report stored, one over the limit and one for a
 *   project whose switch is off, so that nothing about a report, a count or an identity can be read back.
 * - **That the switches hold at the write**: absent from `tools/list` under the instance's and the project's
 *   switch, and — the part `tools/list` cannot be trusted with — a legacy session that began before the
 *   switch was turned off writes nothing afterwards.
 * - **That the limit is its own**: per credential, one shared bucket for anonymous callers, counted from the
 *   table, and a refusal that is a success on the wire and a number on `/metrics`.
 */

const baseUrl = inject('postgresBaseUrl');
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const ADMIN_TOKEN = 'a-token-for-the-report-gap-suite';
const LIMIT = 3;
const RECEIVED = 'Received. Thank you — the documentation maintainers review these reports.';

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.
`;

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'report-gap-itest', version: '0.0.0' },
};

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let handbook: ProjectRow;
let queryLog: QueryLog;

const endpoint = (project = handbook.name) => new URL(`${live.origin}/mcp/${project}`);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const setMode = (mode: 'open' | 'token') => database.db.update(projects).set({ mcpAuth: mode }).where(eq(projects.id, handbook.id));
const setLog = (enabled: boolean) => database.db.update(projects).set({ queryLogEnabled: enabled }).where(eq(projects.id, handbook.id));
const reports = () => database.db.select().from(reportedGaps).where(eq(reportedGaps.projectId, handbook.id)).orderBy(asc(reportedGaps.createdAt));

interface JsonRpcReply {
  id?: unknown;
  result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
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

/** A 2026-07-28 `tools/call`, with the headers the SDK checks beside its body. */
const modernCall = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: ENVELOPE } },
    { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call', 'mcp-name': name, ...headers },
  );

const modernList = () =>
  post(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } },
    { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' },
  );

const textOf = (reply: JsonRpcReply): string => reply.result?.content?.find((c) => c.type === 'text')?.text ?? '';
const namesOf = (reply: JsonRpcReply): string[] => (reply.result?.tools ?? []).map((t) => t.name);

async function modernClient(token?: string): Promise<ModernClient> {
  const client = new ModernClient({ name: 'report-gap-itest', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN_VERSION } } });
  await client.connect(new ModernTransport(endpoint(), { requestInit: token ? { headers: bearer(token) } : undefined }));
  return client;
}

/** A legacy session, opened by hand so the test controls exactly when each message is sent. */
async function legacySession(
  headers: Record<string, string> = {},
): Promise<{ send: (body: unknown) => ReturnType<typeof post>; close: () => Promise<void> }> {
  const opened = await post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'report-gap-legacy', version: '0.0.0' } },
    },
    headers,
  );
  expect(opened.status).toBe(200);
  const sessionId = opened.headers.get('mcp-session-id') as string;
  const onSession = { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_VERSION };
  expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, onSession)).status).toBe(202);
  let id = 1;
  return {
    send: (body) => post({ jsonrpc: '2.0', id: ++id, ...(body as object) }, onSession),
    close: async () => {
      await fetch(endpoint(), { method: 'DELETE', headers: onSession });
    },
  };
}

const callTool = (name: string, args: Record<string, unknown>) => ({ method: 'tools/call', params: { name, arguments: args } });

async function scrape(): Promise<string> {
  const res = await fetch(`${live.origin}/metrics`);
  expect(res.status).toBe(200);
  return res.text();
}

const outcomeCount = (text: string, outcome: string): number => {
  const series = `contextator_mcp_gap_reports_total{outcome="${outcome}"}`;
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
};

/** The four counters now, to subtract from the four later: the registry is the process's, not the test's. */
async function counters(): Promise<Record<string, number>> {
  const text = await scrape();
  return Object.fromEntries(['accepted', 'limited', 'disabled', 'failed'].map((o) => [o, outcomeCount(text, o)]));
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'report_gap');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-report-gap-'));
  handbook = await seedProject(database.db, 'gap', { path: 'handbook/guide.md', body: HANDBOOK });
  live = await startMcpInstance(database, {
    dataDir: path.join(root, '.data'),
    docRoot: root,
    env: { METRICS_PUBLIC: '1', ADMIN_TOKEN, MCP_REPORT_GAP_PER_HOUR: String(LIMIT) },
  });
  // The helper's context has no query log, which is `SEARCH_QUERY_LOG=0`; this suite is about both states.
  queryLog = new QueryLog(database.db, silentLogger);
  (live.ctx as { queryLog?: QueryLog }).queryLog = queryLog;
}, 180_000);

afterAll(async () => {
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

beforeEach(async () => {
  (live.ctx as { queryLog?: QueryLog }).queryLog = queryLog;
  await setMode('open');
  await setLog(true);
  await database.db.delete(reportedGaps);
  await database.db.delete(searchQueries);
});

describe('what a report is, and where it goes', () => {
  it('is written to reported_gaps and never to search_queries, and the answer is "received" in text and structure', async () => {
    const client = await modernClient();
    try {
      const result = await client.callTool({
        name: 'report_gap',
        arguments: { query: 'How do I rotate the  Webhook Secret?', note: 'The page only says how to create one.' },
      });
      expect(result.isError).toBeFalsy();
      expect((result.content as Array<{ text: string }>)[0].text).toBe(RECEIVED);
      expect(result.structuredContent).toEqual({ status: 'received' });
    } finally {
      await client.close();
    }
    await queryLog.flush();
    const rows = await reports();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: handbook.id,
      query: 'How do I rotate the  Webhook Secret?',
      queryNorm: 'how do i rotate the webhook secret?',
      note: 'The page only says how to create one.',
      rateKey: 'anon',
      mcpTokenId: null,
      liveGeneration: handbook.liveGeneration,
    });
    // It never writes a row that says a search ran.
    expect(await database.db.select().from(searchQueries)).toEqual([]);
  });

  it('keeps no note as NULL rather than an empty string', async () => {
    await modernCall('report_gap', { query: 'a question with no note', note: '   ' });
    expect((await reports())[0].note).toBeNull();
  });

  it('refuses a query or note over its length, as a validation error, and writes nothing', async () => {
    const tooLong = await modernCall('report_gap', { query: 'x'.repeat(2001) });
    const noteTooLong = await modernCall('report_gap', { query: 'fine', note: 'x'.repeat(1001) });
    const empty = await modernCall('report_gap', { query: '' });
    const blank = await modernCall('report_gap', { query: '   \n  ' });
    for (const reply of [tooLong, noteTooLong, empty, blank]) {
      expect(reply.json.result?.isError ?? reply.json.error).toBeTruthy();
    }
    expect(await reports()).toEqual([]);
  });

  it('attributes a report to the token that made it, in a bucket named for that token', async () => {
    await setMode('token');
    const { token, view } = await createMcpToken(database.db, handbook.id, 'reporting agent', null);
    const client = await modernClient(token);
    try {
      await client.callTool({ name: 'report_gap', arguments: { query: 'where is the backup guide' } });
    } finally {
      await client.close();
    }
    const [row] = await reports();
    expect(row).toMatchObject({ mcpTokenId: view.id, rateKey: `tok:${view.id}` });
  });

  it('keeps a report when its token is deleted, with the token forgotten (ON DELETE SET NULL)', async () => {
    await setMode('token');
    const { token, view } = await createMcpToken(database.db, handbook.id, 'short lived', null);
    const client = await modernClient(token);
    try {
      await client.callTool({ name: 'report_gap', arguments: { query: 'what happened to the old page' } });
    } finally {
      await client.close();
    }
    await database.db.delete(mcpTokens).where(eq(mcpTokens.id, view.id));
    const [row] = await reports();
    expect(row.mcpTokenId).toBeNull();
    expect(row.rateKey).toBe(`tok:${view.id}`);
  });
});

describe('the one answer', () => {
  it('is the same, byte for byte, for a report that was stored, one over the limit and one for a project whose switch is off', async () => {
    const stored = await modernCall('report_gap', { query: 'first' });
    for (let i = 1; i < LIMIT; i++) await modernCall('report_gap', { query: `fill ${i}` });
    const limited = await modernCall('report_gap', { query: 'over the limit' });
    expect(await reports()).toHaveLength(LIMIT);

    // A session that began with the log on keeps the tool for its lifetime; the switch is read at the write.
    await database.db.delete(reportedGaps);
    const session = await legacySession();
    const written = await session.send(callTool('report_gap', { query: 'while it is on' }));
    await setLog(false);
    const disabled = await session.send(callTool('report_gap', { query: 'after it was turned off' }));
    await session.close();

    for (const reply of [stored, limited, written, disabled]) {
      expect(reply.json.result?.isError).toBeFalsy();
      expect(textOf(reply.json)).toBe(RECEIVED);
    }
    expect(limited.json.result?.structuredContent).toEqual(stored.json.result?.structuredContent);
    expect((await reports()).map((r) => r.query)).toEqual(['while it is on']);
  });
});

describe('the limit', () => {
  it('drops a report over the limit as a success, writes no row, and counts it on /metrics', async () => {
    const before = await counters();
    for (let i = 0; i < LIMIT; i++) expect(textOf((await modernCall('report_gap', { query: `report ${i}` })).json)).toBe(RECEIVED);
    expect(await reports()).toHaveLength(LIMIT);

    const over = await modernCall('report_gap', { query: 'one more than the limit' });
    expect(over.status).toBe(200);
    expect(over.json.result?.isError).toBeFalsy();
    expect(textOf(over.json)).toBe(RECEIVED);
    expect(await reports()).toHaveLength(LIMIT);
    expect((await reports()).map((r) => r.query)).not.toContain('one more than the limit');

    const after = await counters();
    expect(after.accepted - before.accepted).toBe(LIMIT);
    expect(after.limited - before.limited).toBe(1);
    expect(after.disabled - before.disabled).toBe(0);
    expect(after.failed - before.failed).toBe(0);
  });

  it('counts per credential: one token over its limit does not stop another', async () => {
    await setMode('token');
    const a = await createMcpToken(database.db, handbook.id, 'noisy', null);
    const b = await createMcpToken(database.db, handbook.id, 'quiet', null);
    for (let i = 0; i < LIMIT + 2; i++) await modernCall('report_gap', { query: `a ${i}` }, bearer(a.token));
    await modernCall('report_gap', { query: 'b once' }, bearer(b.token));
    const rows = await reports();
    expect(rows.filter((r) => r.rateKey === `tok:${a.view.id}`)).toHaveLength(LIMIT);
    expect(rows.filter((r) => r.rateKey === `tok:${b.view.id}`)).toHaveLength(1);
  });

  it('puts every anonymous caller of an open project in one bucket, however many addresses they come from', async () => {
    // Three different addresses (this instance trusts the loopback peer as a proxy), a fourth that is over.
    const from = (address: string) => ({ 'x-forwarded-for': address });
    await modernCall('report_gap', { query: 'from one' }, from('203.0.113.1'));
    await modernCall('report_gap', { query: 'from two' }, from('203.0.113.2'));
    await modernCall('report_gap', { query: 'from three' }, from('203.0.113.3'));
    const fourth = await modernCall('report_gap', { query: 'from four' }, from('203.0.113.4'));
    expect(textOf(fourth.json)).toBe(RECEIVED);
    const rows = await reports();
    expect(rows).toHaveLength(LIMIT);
    expect(new Set(rows.map((r) => r.rateKey))).toEqual(new Set(['anon']));
    expect(rows.every((r) => r.mcpTokenId === null)).toBe(true);
  });

  it('puts a call with a junk Bearer on an open project in the anonymous bucket, not in one of its own', async () => {
    await modernCall('report_gap', { query: 'with a junk header' }, bearer('ctxm_not-a-token'));
    expect((await reports()).map((r) => r.rateKey)).toEqual(['anon']);
  });

  it('forgets a report after an hour: only rows from the last hour count', async () => {
    const db = database.db;
    const deps = { db, log: silentLogger, limitPerHour: LIMIT };
    const input = { projectId: handbook.id, tokenId: null };
    for (let i = 0; i < LIMIT; i++) expect(await reportGap(deps, { ...input, query: `r${i}` })).toBe('accepted');
    expect(await reportGap(deps, { ...input, query: 'over' })).toBe('limited');
    // The same three rows, two hours old: the bucket is empty again.
    await db.execute(sql`UPDATE reported_gaps SET created_at = now() - interval '2 hours' WHERE project_id = ${handbook.id}`);
    expect(await reportGap(deps, { ...input, query: 'after the hour' })).toBe('accepted');
  });

  it('is off at 0, and the project row cap is then the only bound', async () => {
    const deps = { db: database.db, log: silentLogger, limitPerHour: 0 };
    for (let i = 0; i < LIMIT + 4; i++) expect(await reportGap(deps, { projectId: handbook.id, tokenId: null, query: `r${i}` })).toBe('accepted');
    expect(await reports()).toHaveLength(LIMIT + 4);
  });
});

describe('the cap on rows, per project', () => {
  it('keeps the newest rows and prunes the oldest, as the query log does', async () => {
    // Eight rows with a clock that says which is oldest (a tie is kept, not cut), then one more write with a cap of five.
    await database.db.insert(reportedGaps).values(
      Array.from({ length: 8 }, (_, i) => ({
        projectId: handbook.id,
        rateKey: 'anon',
        query: `r${i}`,
        queryNorm: `r${i}`,
        liveGeneration: 0,
        createdAt: new Date(Date.now() - (20 - i) * 60_000),
      })),
    );
    const deps = { db: database.db, log: silentLogger, limitPerHour: 0, projectRowCap: 5 };
    expect(await reportGap(deps, { projectId: handbook.id, tokenId: null, query: 'new' })).toBe('accepted');
    expect((await reports()).map((r) => r.query)).toEqual(['r4', 'r5', 'r6', 'r7', 'new']);
    // Pruning again with nothing over the cap removes nothing.
    expect(await pruneProjectReportedGaps(database.db, handbook.id, 5)).toBe(0);
  });

  it('cuts one project and leaves the next alone', async () => {
    const [other] = await database.db.insert(projects).values({ name: 'other-gap', embeddingModel: handbook.embeddingModel }).returning();
    const deps = { db: database.db, log: silentLogger, limitPerHour: 0, projectRowCap: 2 };
    for (let i = 0; i < 4; i++) await reportGap(deps, { projectId: other.id, tokenId: null, query: `other ${i}` });
    await reportGap(deps, { projectId: handbook.id, tokenId: null, query: 'mine' });
    expect(await database.db.select().from(reportedGaps).where(eq(reportedGaps.projectId, handbook.id))).toHaveLength(1);
    await database.db.delete(projects).where(eq(projects.id, other.id));
    // Deleting the project deletes its reports with it.
    expect(await database.db.select().from(reportedGaps).where(eq(reportedGaps.projectId, other.id))).toEqual([]);
  });
});

describe('the switches', () => {
  it('is absent from tools/list, in both eras, while the instance has no query log (SEARCH_QUERY_LOG=0)', async () => {
    (live.ctx as { queryLog?: QueryLog }).queryLog = undefined;
    expect(namesOf((await modernList()).json)).toEqual(['search_docs', 'list_topics', 'read_document', 'whats_new']);
    const session = await legacySession();
    try {
      expect(namesOf((await session.send({ method: 'tools/list', params: {} })).json)).toEqual([
        'search_docs',
        'list_topics',
        'read_document',
        'whats_new',
      ]);
      // A call to it is a call to a tool that does not exist, in the legacy era's shape.
      const call = await session.send(callTool('report_gap', { query: 'anything' }));
      expect(call.json.result?.isError).toBe(true);
      expect(textOf(call.json)).toContain('Tool report_gap not found');
    } finally {
      await session.close();
    }
    expect(await reports()).toEqual([]);
  });

  it('is absent from tools/list for a project whose own query log is off, and present for one whose log is on', async () => {
    expect(namesOf((await modernList()).json)).toContain('report_gap');
    await setLog(false);
    expect(namesOf((await modernList()).json)).not.toContain('report_gap');
    const call = await modernCall('report_gap', { query: 'anything' });
    expect(call.json.error ?? call.json.result?.isError).toBeTruthy();
    expect(await reports()).toEqual([]);
  });

  /**
   * The case `tools/list` cannot be trusted with: a legacy session holds the project row it began with, so
   * its server still has the tool registered after the operator turned the switch off. The write re-reads it.
   */
  it('writes nothing, answers the same and counts it as disabled when a session that began with the log on is called after it was turned off', async () => {
    const session = await legacySession();
    try {
      expect(namesOf((await session.send({ method: 'tools/list', params: {} })).json)).toContain('report_gap');
      const first = await session.send(callTool('report_gap', { query: 'before the switch' }));
      expect(textOf(first.json)).toBe(RECEIVED);
      expect(await reports()).toHaveLength(1);

      const before = await counters();
      await setLog(false);
      // The session's own `tools/list` is as stale as its server: it still offers the tool...
      expect(namesOf((await session.send({ method: 'tools/list', params: {} })).json)).toContain('report_gap');
      // ...and the call it invites is not written.
      const second = await session.send(callTool('report_gap', { query: 'after the switch' }));
      expect(second.json.result?.isError).toBeFalsy();
      expect(textOf(second.json)).toBe(RECEIVED);
      expect((await reports()).map((r) => r.query)).toEqual(['before the switch']);

      const after = await counters();
      expect(after.disabled - before.disabled).toBe(1);
      expect(after.accepted - before.accepted).toBe(0);

      // Turned back on, the same session writes again.
      await setLog(true);
      expect(textOf((await session.send(callTool('report_gap', { query: 'on again' }))).json)).toBe(RECEIVED);
      expect((await reports()).map((r) => r.query)).toEqual(['before the switch', 'on again']);
    } finally {
      await session.close();
    }
  });

  it('names no project that does not exist as written to: a deleted project is a failure, not a row', async () => {
    const [gone] = await database.db.insert(projects).values({ name: 'gone-gap', embeddingModel: handbook.embeddingModel }).returning();
    await database.db.delete(projects).where(eq(projects.id, gone.id));
    const metrics = new MetricsRegistry();
    const outcome = await reportGap(
      { db: database.db, log: silentLogger, limitPerHour: 0, metrics },
      { projectId: gone.id, tokenId: null, query: 'x' },
    );
    expect(outcome).toBe('failed');
    expect(metrics.gapReports()).toEqual({ accepted: 0, limited: 0, disabled: 0, failed: 1 });
  });
});

describe('forgetting', () => {
  it('sweeps rows older than the retention window and keeps the rest, whatever the query log switch says', async () => {
    const deps = { db: database.db, log: silentLogger, limitPerHour: 0 };
    await reportGap(deps, { projectId: handbook.id, tokenId: null, query: 'old' });
    await reportGap(deps, { projectId: handbook.id, tokenId: null, query: 'recent' });
    await database.db.execute(sql`UPDATE reported_gaps SET created_at = now() - interval '31 days' WHERE query = 'old'`);
    // The project's switch is off: the sweep does not look at it (nor at the instance's), which is the point.
    await setLog(false);
    expect(await sweepReportedGaps(database.db, 30)).toBe(1);
    expect((await reports()).map((r) => r.query)).toEqual(['recent']);
  });

  it('is removed with the rest of a project’s query log by the purge route, counted apart', async () => {
    const deps = { db: database.db, log: silentLogger, limitPerHour: 0 };
    await reportGap(deps, { projectId: handbook.id, tokenId: null, query: 'one' });
    await reportGap(deps, { projectId: handbook.id, tokenId: null, query: 'two' });
    const res = await live.app.inject({ method: 'DELETE', url: `/api/projects/${handbook.id}/query-log`, headers: bearer(ADMIN_TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 0, dumpsUnaffected: true, reportedGapsDeleted: 2 });
    expect(await reports()).toEqual([]);
    expect(await purgeProjectReportedGaps(database.db, handbook.id)).toBe(0);
  });
});

describe('the panel API', () => {
  const summary = async (query = '') => {
    const res = await live.app.inject({ method: 'GET', url: `/api/projects/${handbook.id}/queries/summary${query}`, headers: bearer(ADMIN_TOKEN) });
    expect(res.statusCode).toBe(200);
    return res;
  };

  it('shows reports grouped by normalised question, most reported first, with the latest note, and apart from the ranked questions', async () => {
    const deps = { db: database.db, log: silentLogger, limitPerHour: 0 };
    const at = (query: string, note: string | undefined, minutesAgo: number) =>
      reportGap(deps, { projectId: handbook.id, tokenId: null, query, note }).then(() =>
        database.db.execute(
          sql`UPDATE reported_gaps SET created_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = (SELECT id FROM reported_gaps WHERE query = ${query} AND created_at > now() - interval '1 minute' LIMIT 1)`,
        ),
      );
    await at('How do I rotate the webhook secret?', 'older note', 30);
    await at('how  do I ROTATE the webhook secret?', 'newer note', 10);
    await at('Where is the backup guide?', undefined, 5);

    const body = (await summary()).json() as { reportedGaps: Array<Record<string, unknown>>; questions: unknown[] };
    expect(body.questions).toEqual([]);
    expect(body.reportedGaps).toHaveLength(2);
    expect(body.reportedGaps[0]).toMatchObject({
      queryNorm: 'how do i rotate the webhook secret?',
      // The most recent spelling, as it was written.
      sample: 'how  do I ROTATE the webhook secret?',
      reports: 2,
      lastNote: 'newer note',
    });
    expect(body.reportedGaps[1]).toMatchObject({ queryNorm: 'where is the backup guide?', reports: 1, lastNote: null });
    // No rank, no score and no classification is on a report: it is not merged with the questions' ordering.
    expect(Object.keys(body.reportedGaps[0]).sort()).toEqual(
      ['firstReportedAt', 'lastNote', 'lastReportedAt', 'queryNorm', 'reporters', 'reports', 'sample'].sort(),
    );
  });

  it('counts the distinct tokens behind a question, and can be narrowed to one token', async () => {
    await setMode('token');
    const a = await createMcpToken(database.db, handbook.id, 'a', null);
    const b = await createMcpToken(database.db, handbook.id, 'b', null);
    await modernCall('report_gap', { query: 'shared gap' }, bearer(a.token));
    await modernCall('report_gap', { query: 'Shared  gap' }, bearer(b.token));
    await modernCall('report_gap', { query: 'only a' }, bearer(a.token));

    const all = (await summary()).json() as { reportedGaps: Array<{ queryNorm: string; reports: number; reporters: number }> };
    expect(all.reportedGaps.find((g) => g.queryNorm === 'shared gap')).toMatchObject({ reports: 2, reporters: 2 });
    const narrowed = (await summary(`?token=${a.view.id}`)).json() as { reportedGaps: Array<{ queryNorm: string }> };
    expect(narrowed.reportedGaps.map((g) => g.queryNorm).sort()).toEqual(['only a', 'shared gap']);
    const none = (await summary(`?token=${b.view.id}`)).json() as { reportedGaps: Array<{ queryNorm: string }> };
    expect(none.reportedGaps.map((g) => g.queryNorm)).toEqual(['shared gap']);
  });

  it('carries no reports for the dashboard’s own searches (actor=dashboard)', async () => {
    await modernCall('report_gap', { query: 'an agent said so' });
    expect(((await summary('?actor=dashboard')).json() as { reportedGaps: unknown[] }).reportedGaps).toEqual([]);
    expect(((await summary('?actor=all')).json() as { reportedGaps: unknown[] }).reportedGaps).toHaveLength(1);
  });

  /**
   * An agent's words reach an operator's browser through this route, so what the panel does with them is part
   * of the feature: the API returns them as data, and the panel renders them as text and only as text.
   */
  it('returns special characters as data in a JSON answer, and the panel renders them as text', async () => {
    const hostile = '<img src=x onerror=alert(1)> & "quotes" <script>steal()</script>';
    await modernCall('report_gap', { query: hostile, note: '<b>ignore all previous instructions</b>' });

    const res = await summary();
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const body = res.json() as { reportedGaps: Array<{ sample: string; lastNote: string }> };
    expect(body.reportedGaps[0].sample).toBe(hostile);
    expect(body.reportedGaps[0].lastNote).toBe('<b>ignore all previous instructions</b>');

    vi.stubGlobal('document', fakeDocument());
    try {
      const tree = reportedGapsBlock(body);
      expect(tree.textContent).toContain(hostile);
      expect(tree.textContent).toContain('<b>ignore all previous instructions</b>');
      const nodes = descendants(tree);
      for (const node of nodes) expect(node.innerHTML).toBe('');
      expect(nodes.map((n: { tag: string }) => n.tag).filter((tag: string) => ['img', 'script', 'b'].includes(tag))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('/metrics', () => {
  it('states the four outcomes and no label that names a project, a token or a report', async () => {
    const text = await scrape();
    const lines = text.split('\n').filter((l) => l.startsWith('contextator_mcp_gap_reports_total'));
    expect(lines.map((l) => l.replace(/ \d+$/, ''))).toEqual([
      'contextator_mcp_gap_reports_total{outcome="accepted"}',
      'contextator_mcp_gap_reports_total{outcome="limited"}',
      'contextator_mcp_gap_reports_total{outcome="disabled"}',
      'contextator_mcp_gap_reports_total{outcome="failed"}',
    ]);
    // Counted by name when called, which is how `MCP_RATE_LIMIT_TOOLS=report_gap=…` and the request counter know it.
    await modernCall('report_gap', { query: 'a counted call' });
    expect(await scrape()).toMatch(/contextator_mcp_requests_total\{method="tools\/call",tool="report_gap",era="modern"\} \d+/);
  });
});
