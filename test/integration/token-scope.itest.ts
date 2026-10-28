import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvents, documentChanges, documentSources, documents, mcpTokens, projects, type ProjectRow, type UserRow } from '../../src/db/schema.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { documentUri, registerResources } from '../../src/mcp/resources.js';
import { EMPTY_SCOPE_MESSAGE } from '../../src/mcp/tools.js';
import { createMcpToken, issueMcpCredential, verifyMcpToken } from '../../src/services/auth/mcp-tokens.js';
import { registerOauthClient } from '../../src/services/auth/oauth.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser } from '../../src/services/auth/users.js';
import { recountProject, searchChunks } from '../../src/services/vector-store.js';
import { OTHER_SCOPE, RESOURCE_METHOD_SCOPE, TOOL_SCOPE } from '../support/token-scope-inventory.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, type TestDatabase } from './support/postgres.js';
import { seedDocument, seedProject, startMcpInstance, stubVector, type LiveInstance } from './support/mcp-instance.js';

/**
 * **A token bound to sources reads nothing outside them** ([ADR-0133](../../.ssot/ADR.md#adr-0133)): the
 * claim of Faz 11a, asserted read path by read path against a real PostgreSQL and the real MCP router.
 *
 * The project has two sources, `handbook` (what the scoped token may read) and `payroll` (what it may not).
 * **Every negative assertion has a positive control beside it**: the same request with an unscoped token
 * finds the thing, so a "does not appear" is never the answer of an empty corpus or of a test that asked the
 * wrong question. What payroll holds carries markers (`LEAK_MARKERS`) that appear nowhere in handbook or in
 * any sentence the server writes itself, so one check — "none of these is in the answer" — covers a path, a
 * title, a body, a version and a source name at once.
 *
 * The requests are raw JSON-RPC in the 2026-07-28 era, one stateless request each, so a scope is read off
 * every request's own credential, as ADR-0099 says it is; one legacy session proves the other era reads it
 * too. A name in `MCP_TOOL_NAMES`, a resource method, or a surface this ADR lists as "not applied" that has no
 * assertion here fails the last test of the first block.
 */

const baseUrl = inject('postgresBaseUrl');
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const PASSWORD = 'a-long-enough-password-1!';
const SINCE = '2020-01-01';

/** Appear in payroll's paths, titles, bodies and version, and nowhere else. */
const LEAK_MARKERS = ['payroll', 'ZEBRAQUARTZ', 'v9-hidden', 'hidden-notes', 'salaries'];

/**
 * What a caller types to reach payroll's pages. **It must carry no marker**: `search_docs` echoes the query in its
 * own answer (`query` in the structured result, the sentence of a no-match), so a query that contained one would
 * "leak" it back to the person who typed it. The words are in payroll's bodies (`salary`, `bands`, `bonus`, `plan`),
 * and the marker that identifies a leak is something the answer would only have if it quoted a payroll page.
 */
const PAYROLL_QUERY = 'salary bands bonus plan';
const PAYROLL_QUERY_SHORT = 'salary bands';

const GUIDE = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;
const HANDBOOK_NOTES = '# Shared notes\n\nThe handbook copy of the shared notes lists the release checklist.\n';
const SALARIES = '# Salary bands\n\nZEBRAQUARTZ salary bands for the delivery team.\n';
const HIDDEN_NOTES = '# Bonus plan\n\nZEBRAQUARTZ bonus plan notes for the delivery team.\n';
const PAYROLL_NOTES = '# Shared notes\n\nThe payroll copy of the shared notes mentions ZEBRAQUARTZ.\n';

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'token-scope-itest', version: '0.0.0' },
};

interface JsonRpcReply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolAnswer {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
  /** Everything the answer carries, as one string: the thing a leak check reads. */
  all: string;
}

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let admin: UserRow;
let cookie: string;
/** The two-source project every read path is asserted on. */
let project: ProjectRow;
let handbookId: string;
let payrollId: string;
/** Reads the whole project: the positive control for every negative assertion. */
let wholeToken: string;
/** Bound to `handbook` alone. */
let scopedToken: string;

/** The names of the paths the proofs below have asserted, checked against the inventory at the end. */
const proved = new Set<string>();

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

function modernHeaders(method: string, params: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method };
  if (method === 'tools/call') headers['mcp-name'] = String(params.name);
  if (method === 'resources/read') headers['mcp-name'] = String(params.uri);
  return headers;
}

/** One stateless 2026-07-28 request to a project's endpoint with the credential in the header a client would put it in. */
async function rpc(target: ProjectRow, token: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<JsonRpcReply> {
  const res = await fetch(`${live.origin}/mcp/${target.name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...modernHeaders(method, params),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  });
  expect(res.status, `${method} answered ${res.status}`).toBe(200);
  return parse(res);
}

async function tool(token: string | undefined, name: string, args: Record<string, unknown> = {}, target: ProjectRow = project): Promise<ToolAnswer> {
  const reply = await rpc(target, token, 'tools/call', { name, arguments: args });
  expect(reply.error, `${name} answered a protocol error`).toBeUndefined();
  const result = reply.result ?? {};
  const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  const structured = (result.structuredContent as Record<string, unknown> | undefined) ?? {};
  return { text, structured, isError: result.isError === true, all: JSON.stringify({ text, structured }) };
}

const leaks = (answer: string): string[] => LEAK_MARKERS.filter((marker) => answer.includes(marker));

/** `text` with the name the caller typed taken out, so two refusals can be compared for being the same answer. */
const without = (text: string, typed: string): string => text.split(typed).join('<typed>');

/** A request as the dashboard makes it: the session cookie, and the header the same-site check reads. */
const asAdmin = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, body?: unknown) =>
  live.app.inject({
    method,
    url,
    headers: { cookie, 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const setAuthMode = (target: ProjectRow, mode: 'open' | 'token') =>
  database.db.update(projects).set({ mcpAuth: mode }).where(eq(projects.id, target.id));

/** A project with one source holding one document, and the counters the indexer would have written. */
async function seedSecondProject(name: string, sourceName: string, docPath: string): Promise<{ project: ProjectRow; sourceId: string }> {
  const seeded = await seedProject(database.db, name, { path: docPath, body: GUIDE });
  const [source] = await database.db.select().from(documentSources).where(eq(documentSources.projectId, seeded.id));
  await database.db.update(documentSources).set({ name: sourceName }).where(eq(documentSources.id, source.id));
  await database.db.update(projects).set({ mcpAuth: 'token' }).where(eq(projects.id, seeded.id));
  return { project: { ...seeded, mcpAuth: 'token' }, sourceId: source.id };
}

async function recount(target: ProjectRow): Promise<void> {
  await database.db
    .update(projects)
    .set(await recountProject(database.db, target.id, 0))
    .where(eq(projects.id, target.id));
}

const changeRow = (
  projectId: string,
  relativePath: string,
  change: 'added' | 'modified' | 'removed',
  at: ReturnType<typeof sql> = sql`now() + interval '1 minute'`,
) => ({ projectId, relativePath, change, title: relativePath, addedAt: change === 'added' ? at : null, changedAt: at });

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'token_scope');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-token-scope-'));

  project = await seedProject(database.db, 'scoped-project', { path: 'handbook/guide.md', body: GUIDE });
  const [handbook] = await database.db.select().from(documentSources).where(eq(documentSources.projectId, project.id));
  handbookId = handbook.id;
  const [payroll] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'payroll', label: 'Payroll records', config: { path: '/docs', extensions: ['md'] } })
    .returning();
  payrollId = payroll.id;
  await seedDocument(database.db, project.id, handbookId, 'handbook/shared/notes.md', HANDBOOK_NOTES);
  await seedDocument(database.db, project.id, payrollId, 'payroll/salaries.md', SALARIES);
  await seedDocument(database.db, project.id, payrollId, 'payroll/hidden-notes.md', HIDDEN_NOTES);
  await seedDocument(database.db, project.id, payrollId, 'payroll/shared/notes.md', PAYROLL_NOTES);
  await database.db.update(documents).set({ version: 'v9-hidden' }).where(eq(documents.relativePath, 'payroll/salaries.md'));
  await recount(project);
  // `seedProject` is `open` so its callers need no token; this file is about tokens.
  await setAuthMode(project, 'token');
  project = { ...project, mcpAuth: 'token' };

  // The change record, three rows per source: one of each kind. `now() + 1 minute` is after both sources were
  // created, which is what `whats_new` asks of a scoped source's rows.
  await database.db
    .insert(documentChanges)
    .values([
      changeRow(project.id, 'handbook/guide.md', 'modified'),
      changeRow(project.id, 'handbook/new-page.md', 'added'),
      changeRow(project.id, 'handbook/old-page.md', 'removed'),
      changeRow(project.id, 'payroll/salaries.md', 'modified'),
      changeRow(project.id, 'payroll/hired.md', 'added'),
      changeRow(project.id, 'payroll/fired.md', 'removed'),
    ]);

  admin = await createUser(database.db, { username: 'dana', role: 'admin', password: PASSWORD });
  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  const signIn = await live.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'dana', password: PASSWORD } });
  expect(signIn.statusCode).toBe(200);
  cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  wholeToken = (await createMcpToken(database.db, project.id, 'whole project', admin.id)).token;
  scopedToken = (await createMcpToken(database.db, project.id, 'handbook only', admin.id, null, null, ['handbook'])).token;
});

afterAll(async () => {
  await live?.close();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('the read paths, each asserted on its own', () => {
  it('search_docs: a passage, title or path of another source is not found, and the control finds it', async () => {
    // The queries are the caller's own words and come back in the answer; they must not be what a leak check trips on.
    expect(leaks(`${PAYROLL_QUERY} ${PAYROLL_QUERY_SHORT}`)).toEqual([]);
    const control = await tool(wholeToken, 'search_docs', { query: PAYROLL_QUERY, limit: 10 });
    expect(control.isError).toBe(false);
    expect(leaks(control.all).length, 'the control must find payroll, or the assertion below proves nothing').toBeGreaterThan(0);

    const scoped = await tool(scopedToken, 'search_docs', { query: PAYROLL_QUERY, limit: 10 });
    expect(leaks(scoped.all)).toEqual([]);

    // And it still finds what it is allowed to: a scope that returned nothing would also pass the line above.
    const own = await tool(scopedToken, 'search_docs', { query: 'DISPATCH_WORKERS cores', limit: 5 });
    expect(own.isError).toBe(false);
    expect(own.all).toContain('handbook/guide.md');
    proved.add('search_docs');
  });

  it('search_docs: the source parameter outside the scope is answered as an unknown source, listing only in-scope names', async () => {
    const outside = await tool(scopedToken, 'search_docs', { query: 'salary', source: 'payroll' });
    const unknown = await tool(scopedToken, 'search_docs', { query: 'salary', source: 'nosuchsource' });
    expect(outside.isError).toBe(true);
    expect(without(outside.text, 'payroll')).toBe(without(unknown.text, 'nosuchsource'));
    expect(outside.text).toContain('Its sources are: handbook.');
    // The only place the name appears is the one the caller typed it in.
    expect(without(outside.all, 'payroll')).not.toContain('payroll');
    expect(leaks(without(outside.all, 'payroll'))).toEqual([]);

    // The control: unscoped, the same name is a real source and the search runs.
    expect((await tool(wholeToken, 'search_docs', { query: 'salary', source: 'payroll' })).isError).toBe(false);
  });

  it('search_docs: unknown_version lists only versions inside the scope', async () => {
    const control = await tool(wholeToken, 'search_docs', { query: 'salary', version: 'v-none' });
    expect(control.text).toContain('v9-hidden');

    const outside = await tool(scopedToken, 'search_docs', { query: 'salary', version: 'v9-hidden' });
    const unknown = await tool(scopedToken, 'search_docs', { query: 'salary', version: 'v-none' });
    expect(outside.isError).toBe(true);
    expect(without(outside.text, 'v9-hidden')).toBe(without(unknown.text, 'v-none'));
    expect(leaks(without(without(outside.all, 'v9-hidden'), 'v-none'))).toEqual([]);
    expect(unknown.text).not.toContain('v9-hidden');
  });

  it('read_document: a path of another source is "Unknown document", the answer a path that does not exist gets', async () => {
    const control = await tool(wholeToken, 'read_document', { path: 'payroll/salaries.md' });
    expect(control.isError).toBe(false);
    expect(control.all).toContain('ZEBRAQUARTZ');

    const outside = await tool(scopedToken, 'read_document', { path: 'payroll/salaries.md' });
    const absent = await tool(scopedToken, 'read_document', { path: 'nowhere/salaries.md' });
    expect(outside.isError).toBe(true);
    expect(without(outside.text, 'payroll/salaries.md')).toBe(without(absent.text, 'nowhere/salaries.md'));
    expect(outside.text).toContain('Unknown document');
    expect(leaks(without(outside.all, 'payroll/salaries.md'))).toEqual([]);
    expect((await tool(scopedToken, 'read_document', { path: 'handbook/guide.md' })).isError).toBe(false);
    proved.add('read_document');
  });

  it('read_document: a suffix is resolved inside the scope, and a match outside it neither answers nor makes the answer ambiguous', async () => {
    // Unscoped, `shared/notes.md` matches a document in each source, so the suffix fallback refuses it.
    expect((await tool(wholeToken, 'read_document', { path: 'shared/notes.md' })).isError).toBe(true);

    // Scoped, the one match is inside the scope: ambiguity is counted there and only there.
    const scoped = await tool(scopedToken, 'read_document', { path: 'shared/notes.md' });
    expect(scoped.isError).toBe(false);
    expect(scoped.all).toContain('handbook copy');
    expect(leaks(scoped.all)).toEqual([]);

    // A suffix that only matches outside the scope is unknown, not found and not ambiguous.
    const only = await tool(scopedToken, 'read_document', { path: 'hidden-notes.md' });
    expect(only.isError).toBe(true);
    expect(only.text).toContain('Unknown document');
    expect(only.text.replace('hidden-notes.md', '')).not.toContain('hidden-notes');
    expect((await tool(wholeToken, 'read_document', { path: 'hidden-notes.md' })).isError).toBe(false);
  });

  it('list_topics: the documents, the source list, the versions and the totals are the scope’s own', async () => {
    const control = await tool(wholeToken, 'list_topics', {});
    expect(leaks(control.all).length).toBeGreaterThan(0);
    expect(control.structured.documentCount).toBe(5);

    const scoped = await tool(scopedToken, 'list_topics', {});
    expect(scoped.isError).toBe(false);
    expect(leaks(scoped.all)).toEqual([]);
    const documentPaths = (scoped.structured.documents as Array<{ path: string }>).map((d) => d.path);
    expect(documentPaths).toEqual(['handbook/guide.md', 'handbook/shared/notes.md']);
    expect((scoped.structured.sources as Array<{ name: string }>).map((s) => s.name)).toEqual(['handbook']);
    expect(scoped.structured.versions).toEqual([]);
    // The header's totals: the project has five documents, the scope two.
    expect(scoped.structured.documentCount).toBe(2);
    const scopeChunks = (
      await database.db
        .select({ n: sql<number>`sum(${documents.chunkCount})::int` })
        .from(documents)
        .where(eq(documents.sourceId, handbookId))
    )[0].n;
    expect(scoped.structured.chunkCount).toBe(scopeChunks);
    expect(scoped.text).toContain('2 documents');
    proved.add('list_topics');
  });

  it('whats_new: added, modified and removed rows of another source are not listed', async () => {
    const control = await tool(wholeToken, 'whats_new', { since: SINCE });
    const everyone = (control.structured.changes as Array<{ path: string; change: string }>).map((c) => `${c.change} ${c.path}`).sort();
    expect(everyone).toEqual(
      [
        'added handbook/new-page.md',
        'added payroll/hired.md',
        'modified handbook/guide.md',
        'modified payroll/salaries.md',
        'removed handbook/old-page.md',
        'removed payroll/fired.md',
      ].sort(),
    );

    const scoped = await tool(scopedToken, 'whats_new', { since: SINCE });
    expect(scoped.isError).toBe(false);
    expect(leaks(scoped.all)).toEqual([]);
    const own = (scoped.structured.changes as Array<{ path: string; change: string }>).map((c) => `${c.change} ${c.path}`).sort();
    // One assertion per kind, so a failure says which of the three leaked.
    expect(own.filter((c) => c.startsWith('added '))).toEqual(['added handbook/new-page.md']);
    expect(own.filter((c) => c.startsWith('modified '))).toEqual(['modified handbook/guide.md']);
    expect(own.filter((c) => c.startsWith('removed '))).toEqual(['removed handbook/old-page.md']);
    proved.add('whats_new');
  });

  it('whats_new: the source parameter outside the scope is an unknown source with the scope’s names, and lists nothing', async () => {
    const outside = await tool(scopedToken, 'whats_new', { since: SINCE, source: 'payroll' });
    const unknown = await tool(scopedToken, 'whats_new', { since: SINCE, source: 'nosuchsource' });
    expect(outside.structured.changes).toEqual([]);
    expect(without(outside.text, 'payroll')).toBe(without(unknown.text, 'nosuchsource'));
    expect(outside.text).toContain('its sources are: handbook');
    expect(leaks(without(outside.all, 'payroll'))).toEqual([]);
  });

  it('resources/list: only the scope’s documents are listed, and none of the other source is on any page', async () => {
    const control = await rpc(project, wholeToken, 'resources/list');
    expect(JSON.stringify(control.result)).toContain('payroll/salaries.md');

    const scoped = await rpc(project, scopedToken, 'resources/list');
    expect(scoped.error).toBeUndefined();
    const uris = ((scoped.result?.resources ?? []) as Array<{ uri: string }>).map((r) => r.uri);
    expect(uris.sort()).toEqual([documentUri(project.name, 'handbook/guide.md'), documentUri(project.name, 'handbook/shared/notes.md')].sort());
    expect(leaks(JSON.stringify(scoped.result))).toEqual([]);
    proved.add('resources/list');
  });

  it('resources/read: a resource of another source is not found, as a URI of another project is', async () => {
    const uri = documentUri(project.name, 'payroll/salaries.md');
    const control = await rpc(project, wholeToken, 'resources/read', { uri });
    expect(JSON.stringify(control.result)).toContain('ZEBRAQUARTZ');

    const outside = await rpc(project, scopedToken, 'resources/read', { uri });
    const otherProject = await rpc(project, scopedToken, 'resources/read', { uri: documentUri('another-project', 'handbook/guide.md') });
    const absent = await rpc(project, scopedToken, 'resources/read', { uri: documentUri(project.name, 'handbook/nope.md') });
    expect(outside.result).toBeUndefined();
    expect(outside.error?.code).toBe(otherProject.error?.code);
    expect(outside.error?.code).toBe(absent.error?.code);
    expect(without(outside.error?.message ?? '', uri)).toBe(without(absent.error?.message ?? '', documentUri(project.name, 'handbook/nope.md')));
    expect(leaks(without(JSON.stringify(outside), 'payroll/salaries.md'))).toEqual([]);
    expect((await rpc(project, scopedToken, 'resources/read', { uri: documentUri(project.name, 'handbook/guide.md') })).error).toBeUndefined();
    proved.add('resources/read');
  });

  it('a legacy-era session reads the scope too', async () => {
    const url = `${live.origin}/mcp/${project.name}`;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${scopedToken}` };
    const opened = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'token-scope-legacy', version: '0.0.0' } },
      }),
    });
    expect(opened.status).toBe(200);
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    const onSession = { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_VERSION };
    try {
      await (
        await fetch(url, { method: 'POST', headers: onSession, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
      ).text();
      const call = async (id: number, method: string, params: Record<string, unknown>) =>
        parse(await fetch(url, { method: 'POST', headers: onSession, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
      const search = await call(1, 'tools/call', { name: 'search_docs', arguments: { query: PAYROLL_QUERY_SHORT, limit: 10 } });
      expect(leaks(JSON.stringify(search.result))).toEqual([]);
      const list = await call(2, 'resources/list', {});
      expect(leaks(JSON.stringify(list.result))).toEqual([]);
      expect(JSON.stringify(list.result)).toContain('handbook/guide.md');
      const read = await call(3, 'resources/read', { uri: documentUri(project.name, 'payroll/salaries.md') });
      expect(read.result).toBeUndefined();
    } finally {
      await fetch(url, { method: 'DELETE', headers: onSession });
    }
  });

  it('the paths that do not apply the scope are the ones the ADR says do not read a document, a path or a source name', async () => {
    // Each answers a scoped token, and what it says names no source of the project.
    //
    // `report_gap` is registered only while the instance has a query log, which this helper's context does not;
    // a sink that records nothing is enough to register it, and it is taken off again.
    const withLog = live.ctx as unknown as { queryLog?: unknown };
    withLog.queryLog = { for: () => undefined, record: () => undefined };
    try {
      const report = await tool(scopedToken, 'report_gap', { query: 'where are the pay bands' });
      expect(report.isError).toBe(false);
      expect(report.structured).toEqual({ status: 'received' });
      expect(leaks(report.all)).toEqual([]);
    } finally {
      delete withLog.queryLog;
    }

    const templates = await rpc(project, scopedToken, 'resources/templates/list');
    expect(templates.error).toBeUndefined();
    expect(leaks(JSON.stringify(templates.result))).toEqual([]);

    const tools = await rpc(project, scopedToken, 'tools/list');
    expect(tools.error).toBeUndefined();
    expect(leaks(JSON.stringify(tools.result))).toEqual([]);

    const discover = await rpc(project, scopedToken, 'server/discover');
    expect(discover.error).toBeUndefined();
    expect(leaks(JSON.stringify(discover.result))).toEqual([]);

    const prompts = await rpc(project, scopedToken, 'prompts/list');
    expect(prompts.error).toBeUndefined();
    expect(leaks(JSON.stringify(prompts.result))).toEqual([]);

    const initialize = await fetch(`${live.origin}/mcp/${project.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
      }),
    });
    const initBody = await initialize.text();
    expect(initialize.status).toBe(200);
    expect(leaks(initBody)).toEqual([]);
    const sessionId = initialize.headers.get('mcp-session-id');
    if (sessionId) await fetch(`${live.origin}/mcp/${project.name}`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
  });

  it('a name in MCP_TOOL_NAMES, a resource method or a listed surface without an assertion fails here', () => {
    for (const [name, disposition] of [...Object.entries(TOOL_SCOPE), ...Object.entries(RESOURCE_METHOD_SCOPE)]) {
      if (disposition.applies) expect(proved.has(name), `${name} says the scope applies and has no negative assertion in this file`).toBe(true);
      else expect(disposition.reason.length, `${name} does not apply and gives no reason`).toBeGreaterThan(10);
    }
    for (const [name, disposition] of Object.entries(OTHER_SCOPE)) {
      expect(disposition.applies, `${name}: the ADR's table lists it as not applied`).toBe(false);
    }
  });
});

describe('what a ctxm_ token cannot reach', () => {
  const asScoped = (url: string) => live.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${scopedToken}` } });

  it('the dashboard search is a 401', async () => {
    const res = await asScoped(`/api/projects/${project.id}/search?q=salary`);
    expect(res.statusCode).toBe(401);
    expect(leaks(res.body)).toEqual([]);
  });

  it('the export is a 401', async () => {
    const res = await asScoped(`/api/projects/${project.id}/export`);
    expect(res.statusCode).toBe(401);
    expect(leaks(res.body)).toEqual([]);
  });

  it('the query-log panel is a 401', async () => {
    for (const url of [`/api/projects/${project.id}/queries/summary`, `/api/projects/${project.id}/queries/export`]) {
      const res = await asScoped(url);
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('a token with no scope, and a token that was never given one', () => {
  it('reads the whole project, exactly as before this feature', async () => {
    const list = await tool(wholeToken, 'list_topics', {});
    expect(list.structured.documentCount).toBe(5);
    expect((list.structured.sources as Array<{ name: string }>).map((s) => s.name)).toEqual(['handbook', 'payroll']);
    const search = await tool(wholeToken, 'search_docs', { query: PAYROLL_QUERY_SHORT, limit: 10 });
    expect(leaks(search.all).length).toBeGreaterThan(0);
  });

  it('is `null` at the resolver, and the scoped one is its source ids', async () => {
    const whole = await verifyMcpToken(database.db, project.id, wholeToken);
    expect(whole?.sourceScope).toBeNull();
    const scoped = await verifyMcpToken(database.db, project.id, scopedToken);
    expect(scoped?.sourceScope).toEqual([handbookId]);
    expect(scoped?.sourceScope).not.toContain(payrollId);
  });

  it('a token that predates the feature, with the flag at its default, is not scoped', async () => {
    const [legacy] = await database.db
      .insert(mcpTokens)
      .values({ projectId: project.id, name: 'before', tokenHash: 'h'.repeat(64), prefix: 'ctxm_x…' })
      .returning();
    expect(legacy.sourceScoped).toBe(false);
    await database.db.delete(mcpTokens).where(eq(mcpTokens.id, legacy.id));
  });

  it('the database refuses a scoped OAuth credential', async () => {
    const client = await registerOauthClient(database.db, { name: 'A connector', redirectUris: ['https://client.example/cb'], maxClients: 200 });
    const access = await issueMcpCredential(database.db, {
      projectId: project.id,
      userId: admin.id,
      clientId: client.clientId,
      kind: 'access',
      name: 'oauth',
      ttlMs: 60_000,
    });
    await expect(database.db.update(mcpTokens).set({ sourceScoped: true }).where(eq(mcpTokens.id, access.id))).rejects.toThrow();
  });
});

describe('the scope when its sources are gone, or reused by name', () => {
  it('a token whose only source is deleted reads nothing, and says so; it never reads the project', async () => {
    const { project: volatile, sourceId } = await seedSecondProject('volatile-empty', 'doomed', 'doomed/guide.md');
    // A second source the token is not bound to: if an emptied scope fell back to "all", this would show.
    const [other] = await database.db
      .insert(documentSources)
      .values({ projectId: volatile.id, type: 'local', name: 'bystander', config: { path: '/docs', extensions: ['md'] } })
      .returning();
    await seedDocument(database.db, volatile.id, other.id, 'bystander/notes.md', HANDBOOK_NOTES);
    await recount(volatile);
    const whole = (await createMcpToken(database.db, volatile.id, 'whole', admin.id)).token;
    const bound = await createMcpToken(database.db, volatile.id, 'doomed only', admin.id, null, null, ['doomed']);
    expect((await tool(bound.token, 'list_topics', {}, volatile)).structured.documentCount).toBe(1);

    expect((await asAdmin('DELETE', `/api/projects/${volatile.id}/sources/${sourceId}`)).statusCode).toBe(204);

    // The flag stays and the row is gone: the resolver says `[]`, never `null`.
    expect((await verifyMcpToken(database.db, volatile.id, bound.token))?.sourceScope).toEqual([]);
    for (const [name, args] of [
      ['search_docs', { query: 'handbook copy of the shared notes' }],
      ['list_topics', {}],
      ['read_document', { path: 'bystander/notes.md' }],
      ['whats_new', { since: SINCE }],
    ] as const) {
      const answer = await tool(bound.token, name, args, volatile);
      expect(answer.isError, name).toBe(true);
      expect(answer.text, name).toBe(EMPTY_SCOPE_MESSAGE);
      expect(answer.all, name).not.toContain('bystander');
    }
    const list = await rpc(volatile, bound.token, 'resources/list');
    expect(list.result?.resources).toEqual([]);
    const read = await rpc(volatile, bound.token, 'resources/read', { uri: documentUri(volatile.name, 'bystander/notes.md') });
    expect(read.result).toBeUndefined();

    // The control: the unscoped token still reads the bystander.
    expect((await tool(whole, 'list_topics', {}, volatile)).structured.documentCount).toBe(1);

    const listed = (await asAdmin('GET', `/api/projects/${volatile.id}/mcp-tokens`)).json() as Array<{
      id: string;
      sources: string[] | null;
      scopeEmpty: boolean;
    }>;
    expect(listed.find((t) => t.id === bound.view.id)).toMatchObject({ sources: [], scopeEmpty: true });
  });

  it('a source deleted and re-created under the same name does not bring back the old one’s removed rows', async () => {
    const { project: reused, sourceId } = await seedSecondProject('volatile-reuse', 'legacy', 'legacy/old-guide.md');
    const whole = (await createMcpToken(database.db, reused.id, 'whole', admin.id)).token;
    const [anchor] = await database.db
      .insert(documentSources)
      .values({ projectId: reused.id, type: 'local', name: 'anchor', config: { path: '/docs', extensions: ['md'] } })
      .returning();
    await seedDocument(database.db, reused.id, anchor.id, 'anchor/guide.md', GUIDE);
    await recount(reused);

    // The first `legacy` goes; `deleteSource` records a `removed` row for its document, under the name.
    expect((await asAdmin('DELETE', `/api/projects/${reused.id}/sources/${sourceId}`)).statusCode).toBe(204);
    const removed = await database.db
      .select()
      .from(documentChanges)
      .where(and(eq(documentChanges.projectId, reused.id), eq(documentChanges.relativePath, 'legacy/old-guide.md')));
    expect(removed.map((r) => r.change)).toEqual(['removed']);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A new source under the same name: a new id, and a `created_at` after the removal.
    const [reborn] = await database.db
      .insert(documentSources)
      .values({ projectId: reused.id, type: 'local', name: 'legacy', config: { path: '/docs', extensions: ['md'] } })
      .returning();
    expect(reborn.id).not.toBe(sourceId);
    await seedDocument(database.db, reused.id, reborn.id, 'legacy/fresh.md', GUIDE);
    await database.db.insert(documentChanges).values(changeRow(reused.id, 'legacy/fresh.md', 'added'));
    await recount(reused);

    // Control: the unscoped token sees the old one's removal.
    const everyone = await tool(whole, 'whats_new', { since: SINCE }, reused);
    expect((everyone.structured.changes as Array<{ path: string }>).map((c) => c.path)).toContain('legacy/old-guide.md');

    // A token scoped to the new `legacy` sees its own row and not the old one's.
    const bound = await createMcpToken(database.db, reused.id, 'reborn', admin.id, null, null, ['legacy']);
    const scoped = await tool(bound.token, 'whats_new', { since: SINCE }, reused);
    expect((scoped.structured.changes as Array<{ path: string; change: string }>).map((c) => `${c.change} ${c.path}`)).toEqual([
      'added legacy/fresh.md',
    ]);
    expect(scoped.all).not.toContain('old-guide');
  });
});

describe('the admin API', () => {
  const mint = (body: Record<string, unknown>) => asAdmin('POST', `/api/projects/${project.id}/mcp-tokens`, body);
  const patch = (tokenId: string, body: unknown) => asAdmin('PATCH', `/api/projects/${project.id}/mcp-tokens/${tokenId}/sources`, body);
  const lastEvent = async (action: string) => {
    await live.ctx.audit.settled();
    const [row] = await database.db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(desc(auditEvents.createdAt)).limit(1);
    return row;
  };

  it('refuses an empty scope and an unknown name at mint, each with its own code', async () => {
    const empty = await mint({ name: 'nothing', sources: [] });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('empty_scope');

    const unknown = await mint({ name: 'typo', sources: ['handbok'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('unknown_source');
    expect(unknown.json().message).toContain('handbok');

    // Neither created a token.
    const tokens = (await asAdmin('GET', `/api/projects/${project.id}/mcp-tokens`)).json() as Array<{ name: string }>;
    expect(tokens.map((t) => t.name)).not.toContain('nothing');
    expect(tokens.map((t) => t.name)).not.toContain('typo');
  });

  it('mints a scoped token, returns its sources, and writes the names into the audit row', async () => {
    const minted = await mint({ name: 'ci', sources: ['handbook'] });
    expect(minted.statusCode).toBe(201);
    const body = minted.json() as { token: { id: string; sources: string[] | null; scopeEmpty: boolean }; secret: string };
    expect(body.token).toMatchObject({ sources: ['handbook'], scopeEmpty: false });
    expect(leaks((await tool(body.secret, 'search_docs', { query: PAYROLL_QUERY_SHORT, limit: 10 })).all)).toEqual([]);

    const event = await lastEvent('POST /api/projects/:id/mcp-tokens');
    expect(event.detail).toMatchObject({ scoped: true, sources: ['handbook'] });
    expect(event.targetId).toBe(body.token.id);
  });

  it('an unscoped mint has `sources: null`, and absent and null are the same', async () => {
    for (const payload of [{ name: 'a' }, { name: 'b', sources: null }]) {
      const res = await mint(payload);
      expect(res.statusCode).toBe(201);
      expect((res.json() as { token: { sources: unknown; scopeEmpty: boolean } }).token).toMatchObject({ sources: null, scopeEmpty: false });
    }
  });

  it('GET returns `sources` and `scopeEmpty` for every token', async () => {
    const tokens = (await asAdmin('GET', `/api/projects/${project.id}/mcp-tokens`)).json() as Array<{
      name: string;
      sources: string[] | null;
      scopeEmpty: boolean;
    }>;
    expect(tokens.find((t) => t.name === 'ci')).toMatchObject({ sources: ['handbook'], scopeEmpty: false });
    expect(tokens.find((t) => t.name === 'whole project')).toMatchObject({ sources: null, scopeEmpty: false });
  });

  it('PATCH replaces the scope, null removes it, and each takes effect on the next request', async () => {
    const { token, view } = await createMcpToken(database.db, project.id, 'moving', admin.id, null, null, ['handbook']);
    expect(leaks((await tool(token, 'list_topics', {})).all)).toEqual([]);

    // Widened to payroll alone: the same token string now reads payroll and no longer handbook.
    const toPayroll = await patch(view.id, { sources: ['payroll'] });
    expect(toPayroll.statusCode).toBe(200);
    expect(toPayroll.json()).toMatchObject({ sources: ['payroll'], scopeEmpty: false });
    const payrollPaths = ((await tool(token, 'list_topics', {})).structured.documents as Array<{ path: string }>).map((d) => d.path);
    expect(payrollPaths.every((p) => p.startsWith('payroll/'))).toBe(true);
    expect(payrollPaths.length).toBe(3);

    const audited = await lastEvent('PATCH /api/projects/:id/mcp-tokens/:tokenId/sources');
    expect(audited.detail).toMatchObject({ scoped: true, sources: ['payroll'] });
    expect(audited.targetId).toBe(view.id);

    const removed = await patch(view.id, { sources: null });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ sources: null, scopeEmpty: false });
    expect(((await tool(token, 'list_topics', {})).structured.documentCount as number) >= 5).toBe(true);
    expect((await lastEvent('PATCH /api/projects/:id/mcp-tokens/:tokenId/sources')).detail).toMatchObject({ scoped: false });
  });

  it('PATCH refuses an empty list and an unknown name, and leaves the scope as it was', async () => {
    const { view } = await createMcpToken(database.db, project.id, 'steady', admin.id, null, null, ['handbook']);
    const empty = await patch(view.id, { sources: [] });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('empty_scope');
    const unknown = await patch(view.id, { sources: ['nosuchsource'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('unknown_source');
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.id, view.id));
    expect(row.sourceScoped).toBe(true);
    const names = await database.db.execute(sql`select source_id from mcp_token_sources where token_id = ${view.id}`);
    expect(names.rows).toHaveLength(1);
  });

  it('PATCH on an OAuth access credential is 409 not_static, not a 500, and on an unknown token a 404', async () => {
    const client = await registerOauthClient(database.db, {
      name: 'Another connector',
      redirectUris: ['https://client.example/cb'],
      maxClients: 200,
    });
    const access = await issueMcpCredential(database.db, {
      projectId: project.id,
      userId: admin.id,
      clientId: client.clientId,
      kind: 'access',
      name: 'oauth access',
      ttlMs: 60_000,
    });
    const refused = await patch(access.id, { sources: ['handbook'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('not_static');
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.id, access.id));
    expect(row.sourceScoped).toBe(false);

    expect((await patch('00000000-0000-4000-8000-000000000000', { sources: ['handbook'] })).statusCode).toBe(404);
  });

  it('a name from another project is unknown here', async () => {
    const other = await seedSecondProject('elsewhere', 'elsewhere-docs', 'elsewhere-docs/guide.md');
    const res = await mint({ name: 'cross', sources: ['elsewhere-docs'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_source');
    expect(other.project.id).not.toBe(project.id);
  });

  it('a token of another project cannot be reached through this project’s URL: 404, and its scope is untouched', async () => {
    const other = await seedSecondProject('cross-project', 'cross-docs', 'cross-docs/guide.md');
    const { view } = await createMcpToken(database.db, other.project.id, 'theirs', admin.id);
    const res = await patch(view.id, { sources: ['handbook'] });
    expect(res.statusCode).toBe(404);
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.id, view.id));
    expect(row.sourceScoped).toBe(false);
    expect((await database.db.execute(sql`select 1 from mcp_token_sources where token_id = ${view.id}`)).rows).toHaveLength(0);
  });

  it('a viewer of the project cannot change a scope: 403, and the scope is as it was', async () => {
    const viewer = await createUser(database.db, { username: 'vera', role: 'member', password: PASSWORD });
    await setMemberRole(database.db, project.id, viewer.id, 'viewer', null);
    const signIn = await live.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'vera', password: PASSWORD } });
    expect(signIn.statusCode).toBe(200);
    const viewerCookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const { view } = await createMcpToken(database.db, project.id, 'viewer-target', admin.id, null, null, ['handbook']);
    const res = await live.app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}/mcp-tokens/${view.id}/sources`,
      headers: { cookie: viewerCookie, 'sec-fetch-site': 'same-origin' },
      payload: { sources: null },
    });
    expect(res.statusCode).toBe(403);
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.id, view.id));
    expect(row.sourceScoped).toBe(true);
    // The control: the same viewer may read the list, so the 403 is about the write.
    const read = await live.app.inject({ method: 'GET', url: `/api/projects/${project.id}/mcp-tokens`, headers: { cookie: viewerCookie } });
    expect(read.statusCode).toBe(200);
  });

  it('a request with no credential cannot change a scope', async () => {
    const { view } = await createMcpToken(database.db, project.id, 'guarded', admin.id, null, null, ['handbook']);
    const anonymous = await live.app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}/mcp-tokens/${view.id}/sources`,
      payload: { sources: null },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('pages of a scoped listing', () => {
  it('list_topics: the last page of the scope has no cursor, where the unscoped listing has more after the same document', async () => {
    const first = await tool(scopedToken, 'list_topics', { limit: 1 });
    expect((first.structured.documents as Array<{ path: string }>).map((d) => d.path)).toEqual(['handbook/guide.md']);
    expect(first.structured.nextCursor).not.toBeNull();

    const second = await tool(scopedToken, 'list_topics', { limit: 1, cursor: first.structured.nextCursor as string });
    expect((second.structured.documents as Array<{ path: string }>).map((d) => d.path)).toEqual(['handbook/shared/notes.md']);
    // Scope-dependent rows after the limit would have said "more": payroll's documents sort after this one.
    expect(second.structured.nextCursor).toBeNull();
    expect(second.text).not.toContain('next_cursor');

    // The control: the same two pages without a scope, and the second one is not the last.
    const wholeFirst = await tool(wholeToken, 'list_topics', { limit: 1 });
    const wholeSecond = await tool(wholeToken, 'list_topics', { limit: 1, cursor: wholeFirst.structured.nextCursor as string });
    expect((wholeSecond.structured.documents as Array<{ path: string }>).map((d) => d.path)).toEqual(['handbook/shared/notes.md']);
    expect(wholeSecond.structured.nextCursor).not.toBeNull();
  });

  it('resources/list: the last page of the scope has no cursor, where the unscoped listing has more after it', async () => {
    type ListHandler = (request: unknown, call: unknown) => Promise<{ resources: Array<{ name: string }>; nextCursor?: string }>;
    let list: ListHandler | undefined;
    const server = {
      server: {
        registerCapabilities: () => undefined,
        setRequestHandler: (method: string, handler: unknown) => {
          if (method === 'resources/list') list = handler as ListHandler;
        },
      },
    };
    // A page of one, so the boundary is reachable with five documents; the router's own page is far larger.
    registerResources(server as unknown as McpServer, { db: database.db, log: silentLogger }, project, { pageSize: 1 });
    const page = (scope: string[] | null, cursor?: string) =>
      list?.(
        { params: cursor === undefined ? {} : { cursor } },
        { http: { authInfo: { token: 't', clientId: 'c', scopes: [], extra: { sourceScope: scope } } } },
      );

    const first = await page([handbookId]);
    expect(first?.resources.map((r) => r.name)).toEqual(['handbook/guide.md']);
    expect(first?.nextCursor).toBeDefined();
    const second = await page([handbookId], first?.nextCursor);
    expect(second?.resources.map((r) => r.name)).toEqual(['handbook/shared/notes.md']);
    expect(second?.nextCursor).toBeUndefined();

    const wholeFirst = await page(null);
    const wholeSecond = await page(null, wholeFirst?.nextCursor);
    expect(wholeSecond?.resources.map((r) => r.name)).toEqual(['handbook/shared/notes.md']);
    expect(wholeSecond?.nextCursor).toBeDefined();
  });
});

describe('what lies outside the scope cannot change the order inside it', () => {
  const RARE = 'KODADIZEBRA';
  /**
   * The rare word, plus one word from each of two other handbook pages. **It is chosen so that no two handbook chunks
   * from different documents are exactly as far from it.** Asking for the rare word alone put every chunk without it at
   * cosine distance 1, and two of them (the first chunk of `guide.md` and of `notes.md`) are then tied on distance and on
   * `chunk_index`: the dense list breaks that last tie on the chunk's uuid (ADR-0041, ADR-0067: "almost unreachable"
   * for real embeddings, which are never equal across documents), so which one was rank 2 depended on the uuids two
   * freshly built projects happened to draw. The test passed two runs in three. It is not about the scope, and a
   * fixture that sits on that tie cannot say whether the scope changed anything; `assertNoDistanceTies` makes the
   * choice checkable.
   */
  const QUERY = `${RARE} install release`;
  const handbookPages: Array<[string, string]> = [
    ['handbook/guide.md', GUIDE],
    ['handbook/codename.md', `# Codename\n\nThe launch is known internally as ${RARE} and nothing else.\n`],
    ['handbook/shared/notes.md', HANDBOOK_NOTES],
  ];

  /** A project with the same handbook, and `noise` pages in a second source that all use the rare word. */
  async function build(name: string, noise: number): Promise<{ project: ProjectRow; handbook: string }> {
    const seeded = await seedProject(database.db, name, { path: 'handbook/guide.md', body: GUIDE });
    const [source] = await database.db.select().from(documentSources).where(eq(documentSources.projectId, seeded.id));
    for (const [relativePath, body] of handbookPages.slice(1)) await seedDocument(database.db, seeded.id, source.id, relativePath, body);
    if (noise > 0) {
      const [other] = await database.db
        .insert(documentSources)
        .values({ projectId: seeded.id, type: 'local', name: 'noise', config: { path: '/docs', extensions: ['md'] } })
        .returning();
      for (let i = 0; i < noise; i++)
        await seedDocument(database.db, seeded.id, other.id, `noise/page-${i}.md`, `# Noise ${i}\n\n${RARE} appears here, page ${i}.\n`);
    }
    await recount(seeded);
    return { project: seeded, handbook: source.id };
  }

  /** Fails, naming the pair, if two chunks of different handbook documents tie on (distance, chunk_index): the uuid would order them. */
  async function assertNoDistanceTies(target: { project: ProjectRow; handbook: string }): Promise<void> {
    const found = await database.db.execute(sql`
      select d.relative_path as path, c.chunk_index as idx, (c.embedding <=> ${JSON.stringify(stubVector(QUERY))}::vector)::float8 as distance
      from chunks c join documents d on d.id = c.document_id
      where c.project_id = ${target.project.id} and c.index_generation = 0 and d.source_id = ${target.handbook}`);
    const seen = new Map<string, string>();
    for (const row of found.rows as Array<{ path: string; idx: number; distance: number }>) {
      const key = `${row.distance}|${row.idx}`;
      const other = seen.get(key);
      expect(
        other === undefined || other === row.path,
        `${row.path} and ${other} are tied on distance and chunk_index; the uuid would order them`,
      ).toBe(true);
      seen.set(key, row.path);
    }
    expect(seen.size).toBeGreaterThan(1);
  }

  const search = async (target: { project: ProjectRow; handbook: string }, scoped: boolean, limit = 10) =>
    (
      await searchChunks(database.db, {
        projectId: target.project.id,
        generation: 0,
        queryEmbedding: stubVector(QUERY),
        queryText: QUERY,
        limit,
        ...(scoped ? { sourceIds: [target.handbook] } : {}),
      })
    ).map((hit) => ({ file: hit.file, fusedScore: hit.fusedScore, denseRank: hit.denseRank, lexicalRank: hit.lexicalRank }));

  it('a term common only outside the scope still matches inside it, exactly as in a project without the other source', async () => {
    const alone = await build('order-alone', 0);
    const crowded = await build('order-crowded', 14);
    await assertNoDistanceTies(alone);
    await assertNoDistanceTies(crowded);

    // The control: with no scope the term is in 15 of the chunks, over the threshold, and the lexical half drops it.
    // A page wide enough to hold every page of the project, so the control is about the lexical half and not about the cut.
    const unscoped = await search(crowded, false, 20);
    const unscopedCodename = unscoped.find((h) => h.file === 'handbook/codename.md');
    expect(unscopedCodename, 'the control must return the page, found by meaning alone').toBeDefined();
    expect(unscopedCodename?.lexicalRank).toBeNull();

    // Scoped to the handbook, the project's other source is not counted, so the term is rare and matches.
    const scoped = await search(crowded, true);
    const codename = scoped.find((h) => h.file === 'handbook/codename.md');
    expect(codename, 'the page that carries the term must be in the scoped result').toBeDefined();
    expect(codename?.lexicalRank).toEqual(expect.any(Number));
    expect(scoped.every((h) => h.file.startsWith('handbook/'))).toBe(true);

    // And the whole answer, ranks and fused scores included, is the one a project holding only the handbook gives.
    expect(scoped).toEqual(await search(alone, true));
    expect(scoped).toEqual(await search(alone, false));
  });

  it('an emptied scope matches nothing, in the count as in the candidates', async () => {
    const crowded = await build('order-empty', 14);
    const none = await searchChunks(database.db, {
      projectId: crowded.project.id,
      generation: 0,
      queryEmbedding: stubVector(RARE),
      queryText: RARE,
      limit: 10,
      sourceIds: [],
    });
    expect(none).toEqual([]);
  });
});

describe('an open project', () => {
  it('filters a scoped token’s answers and marks a modern answer to it private; the unscoped one stays public', async () => {
    await setAuthMode(project, 'open');
    try {
      const scoped = await tool(scopedToken, 'list_topics', {});
      expect(leaks(scoped.all)).toEqual([]);
      expect(scoped.structured.documentCount).toBe(2);

      // The control: with no token at all the project is open and the whole of it is read.
      const anonymous = await tool(undefined, 'list_topics', {});
      expect(anonymous.structured.documentCount).toBe(5);

      const scopedList = await rpc(project, scopedToken, 'resources/list');
      expect(scopedList.result?.cacheScope).toBe('private');
      expect(leaks(JSON.stringify(scopedList.result))).toEqual([]);
      const anonymousList = await rpc(project, undefined, 'resources/list');
      expect(anonymousList.result?.cacheScope).toBe('public');
      // An unscoped token on an open project keeps the project's own hint.
      expect((await rpc(project, wholeToken, 'resources/list')).result?.cacheScope).toBe('public');
      expect((await rpc(project, scopedToken, 'resources/read', { uri: documentUri(project.name, 'handbook/guide.md') })).result?.cacheScope).toBe(
        'private',
      );
    } finally {
      await setAuthMode(project, 'token');
    }
  });
});

describe('the scope as the database holds it', () => {
  it('deleting a source removes its row and leaves the flag; deleting the token removes its rows', async () => {
    const { project: scratch, sourceId } = await seedSecondProject('scratch', 'scratch-docs', 'scratch-docs/guide.md');
    const { view } = await createMcpToken(database.db, scratch.id, 'scratch', admin.id, null, null, ['scratch-docs']);
    const rowsOf = async () => (await database.db.execute(sql`select source_id from mcp_token_sources where token_id = ${view.id}`)).rows.length;
    expect(await rowsOf()).toBe(1);
    await database.db.delete(documentSources).where(eq(documentSources.id, sourceId));
    expect(await rowsOf()).toBe(0);
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.id, view.id));
    expect(row.sourceScoped).toBe(true);

    const { view: second } = await createMcpToken(database.db, project.id, 'goes away', admin.id, null, null, ['handbook']);
    await database.db.delete(mcpTokens).where(eq(mcpTokens.id, second.id));
    expect((await database.db.execute(sql`select 1 from mcp_token_sources where token_id = ${second.id}`)).rows).toHaveLength(0);
  });
});
