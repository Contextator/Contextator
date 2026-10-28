import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { NOTION_OAUTH_FLOW_COOKIE } from '../../src/admin/notion-oauth-routes.js';
import { auditEvents, documentSources, type DocumentSourceRow } from '../../src/db/schema.js';
import { createApiToken } from '../../src/services/auth/api-tokens.js';
import { removeMember, setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser } from '../../src/services/auth/users.js';
import { decryptSecret, isEncryptedSecret, keyringOf } from '../../src/services/crypto.js';
import { sourceCurrentDir } from '../../src/services/data-dir.js';
import { NotionDriver } from '../../src/services/sources/notion.js';
import { overrideNotionApiBaseUrlForTests } from '../../src/services/sources/notion-oauth.js';
import { replaceSourceSecretIfUnchanged } from '../../src/services/sources.js';
import { StubNotionOAuth } from '../support/notion-oauth-stub.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, type TestDatabase } from './support/postgres.js';

/**
 * **Notion OAuth, end to end against a real database** ([ADR-0129](../../../.ssot/ADR.md#adr-0129)): a
 * browser driven by `fetch` with a hand-rolled cookie jar goes through the product's own routes, a stub
 * of Notion's OAuth and API on a loopback port answers, and the assertions are about what the database
 * holds afterwards — an envelope in `secret_enc`, a compare-and-swap that turns a stale writer away, no
 * token in any row or response. Nothing here is a real credential.
 */

const baseUrl = inject('postgresBaseUrl');
const ADMIN_BEARER = 'notion-oauth-itest-admin-token-12345';
const PASSWORD = 'a-long-enough-password-2!';
/** Registered, as far as the stub is concerned, on this address; the test sends the browser's hop to the live instance. */
const REDIRECT_URI = 'http://localhost:3000/api/sources/notion/oauth/callback';
const KEYS = keyringOf({ SECRET_KEY: '0'.repeat(64) });

let database: TestDatabase;
let root: string;
let live: LiveInstance;
let stub: StubNotionOAuth;
let projectId: string;
let projectName: string;
let enqueue: ReturnType<typeof vi.fn>;

type Jar = Record<string, string>;

const jarFrom = (setCookies: string[], into: Jar = {}): Jar => {
  for (const raw of setCookies) {
    const [pair] = raw.split(';', 1);
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const value = pair.slice(eq + 1);
    // A cleared cookie arrives as an empty value; the browser drops it.
    if (value === '') delete into[pair.slice(0, eq)];
    else into[pair.slice(0, eq)] = value;
  }
  return into;
};
const cookieHeader = (jar: Jar): string =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

interface Account {
  jar: Jar;
  userId: string;
}

async function signIn(username: string, role: 'viewer' | 'editor' | null): Promise<Account> {
  const created = await createUser(database.db, { username, role: 'member', password: PASSWORD });
  if (role) await setMemberRole(database.db, projectId, created.id, role, null);
  const res = await fetch(`${live.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return { jar: jarFrom(res.headers.getSetCookie()), userId: created.id };
}

/** `sec-fetch-site` stands in for the header the same-site check requires of a browser's state-changing request. */
const startFlow = (jar: Jar, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  fetch(`${live.origin}/api/projects/${projectId}/sources/notion/oauth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: cookieHeader(jar), ...extra },
    body: JSON.stringify(body),
  });

/** Starts the flow, follows it through the stub's authorize page, and returns the callback URL aimed at the live instance. */
async function authorise(account: Account, body: Record<string, unknown>): Promise<{ callback: string; jar: Jar; authorizeUrl: string }> {
  const start = await startFlow(account.jar, body);
  expect(start.status).toBe(200);
  const jar = jarFrom(start.headers.getSetCookie(), { ...account.jar });
  const { url } = (await start.json()) as { url: string };
  const hop = await fetch(url, { redirect: 'manual' });
  const back = new URL(hop.headers.get('location')!);
  return { callback: `${live.origin}${back.pathname}${back.search}`, jar, authorizeUrl: url };
}

const callback = (url: string, jar: Jar) => fetch(url, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });

const sources = (name?: string) =>
  name
    ? database.db
        .select()
        .from(documentSources)
        .where(and(eq(documentSources.projectId, projectId), eq(documentSources.name, name)))
    : database.db.select().from(documentSources).where(eq(documentSources.projectId, projectId));

const notionRows = async (): Promise<DocumentSourceRow[]> => (await sources()).filter((r) => r.type === 'notion');

const driverOf = (row: DocumentSourceRow): NotionDriver =>
  new NotionDriver(row, {
    db: database.db,
    log: silentLogger,
    config: {
      ...live.ctx.config,
      NOTION_OAUTH_CLIENT_ID: stub.clientId,
      NOTION_OAUTH_CLIENT_SECRET: stub.clientSecret,
    },
  });

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'notion_oauth');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-notion-oauth-'));
  stub = new StubNotionOAuth();
  await stub.start();
  overrideNotionApiBaseUrlForTests(stub.url);
  live = await startMcpInstance(database, {
    dataDir: path.join(root, '.data'),
    docRoot: root,
    env: {
      ADMIN_TOKEN: ADMIN_BEARER,
      NOTION_OAUTH_CLIENT_ID: stub.clientId,
      NOTION_OAUTH_CLIENT_SECRET: stub.clientSecret,
      NOTION_OAUTH_REDIRECT_URI: REDIRECT_URI,
      SYNC_DEFAULT_INTERVAL_MINUTES: '0',
    },
  });
  enqueue = vi.fn();
  (live.ctx.indexer as unknown as { enqueue: unknown }).enqueue = enqueue;
  const project = await seedProject(database.db, 'notion-oauth', { path: 'a.md', body: '# A\n\nBody.\n' });
  projectId = project.id;
  projectName = project.name;
  stub.pages = [
    { id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', title: 'Runbook', lastEdited: '2026-10-01T10:00:00.000Z', paragraphs: ['Rotate the keys quarterly.'] },
  ];
});

afterAll(async () => {
  overrideNotionApiBaseUrlForTests(undefined);
  await live?.close();
  await stub?.stop();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('connecting a new Notion source', () => {
  let editor: Account;
  let sourceId: string;
  /** Every token the stub has handed out, so the scans below can look for them. */
  const issued = (): string[] => [stub.currentAccessToken, stub.currentRefreshToken];

  it('starts as a session editor: Notion’s URL with the state, and a flow cookie that is HttpOnly, SameSite=Lax and path-scoped', async () => {
    editor = await signIn('oauth-editor', 'editor');
    const res = await startFlow(editor.jar, { name: 'wiki', rootIds: [] });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin).toBe(stub.url);
    expect(authorize.searchParams.get('client_id')).toBe(stub.clientId);
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain(stub.clientSecret);

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${NOTION_OAUTH_FLOW_COOKIE}=`))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api\/sources\/notion\/oauth(;|$)/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Nothing exists until Notion sends the person back.
    expect(await notionRows()).toHaveLength(0);
  });

  it('creates the source on the way back, sealing the pair in an envelope and the workspace name beside it', async () => {
    const flow = await authorise(editor, { name: 'wiki', rootIds: [] });
    const res = await callback(flow.callback, flow.jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?notion_oauth=connected#/${projectName}`);
    // The flow cookie is single-use.
    expect(jarFrom(res.headers.getSetCookie(), { ...flow.jar })[NOTION_OAUTH_FLOW_COOKIE]).toBeUndefined();

    const [row] = await sources('wiki');
    sourceId = row.id;
    expect(row.type).toBe('notion');
    expect(row.config).toMatchObject({ rootIds: [], oauth: { workspaceName: stub.workspaceName, workspaceId: stub.workspaceId, botId: stub.botId } });
    expect(isEncryptedSecret(row.secretEnc!)).toBe(true);
    expect(JSON.parse(decryptSecret(row.secretEnc!, KEYS))).toEqual({
      v: 1,
      kind: 'oauth',
      accessToken: stub.currentAccessToken,
      refreshToken: stub.currentRefreshToken,
      botId: stub.botId,
      workspaceId: stub.workspaceId,
    });
    expect(enqueue).toHaveBeenCalledWith(projectId);
  });

  it('keeps every token out of the database in the clear, out of the API’s answers, and out of the audit log', async () => {
    const dump = await database.pool.query(
      `select (select coalesce(string_agg(row_to_json(d)::text, ' '), '') from document_sources d)
            || (select coalesce(string_agg(row_to_json(a)::text, ' '), '') from audit_events a) as text`,
    );
    for (const token of issued()) expect(String(dump.rows[0].text)).not.toContain(token);

    const list = await fetch(`${live.origin}/api/projects/${projectId}/sources`, { headers: { cookie: cookieHeader(editor.jar) } });
    const body = await list.text();
    for (const token of issued()) expect(body).not.toContain(token);
    expect(JSON.parse(body).find((s: { name: string }) => s.name === 'wiki')).toMatchObject({
      hasSecret: true,
      config: { oauth: { workspaceName: stub.workspaceName } },
    });
    expect(body).not.toContain('secretEnc');
  });

  it('records the connection as an audit event naming the source, with no token, code or state in it', async () => {
    await live.ctx.audit.settled();
    const rows = await database.db.select().from(auditEvents).where(eq(auditEvents.targetId, sourceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'POST /api/projects/:id/sources', projectId, actorLabel: 'oauth-editor', statusCode: 302 });
    expect(rows[0].detail).toEqual({ connection: 'notion-oauth' });
    const started = await database.db.select().from(auditEvents).where(sql`${auditEvents.action} = 'POST /api/projects/:id/sources/notion/oauth'`);
    expect(started.length).toBeGreaterThan(0);
  });

  it('syncs the workspace through the connected source and writes its pages as Markdown', async () => {
    const [row] = await sources('wiki');
    const result = await driverOf(row).sync();
    expect(result.note).toContain('1 pages');
    expect(await readdir(sourceCurrentDir(live.ctx.config.DATA_DIR, projectId, sourceId))).toEqual(['runbook--aaaaaaaa.md']);
  });

  it('refreshes against the real row: the new pair replaces the old one through a compare-and-swap in SQL', async () => {
    const [before] = await sources('wiki');
    stub.expireAccessToken();
    const grants = stub.refreshGrants;
    await driverOf(before).test();
    expect(stub.refreshGrants - grants).toBe(1);

    const [after] = await sources('wiki');
    expect(after.secretEnc).not.toBe(before.secretEnc);
    expect(JSON.parse(decryptSecret(after.secretEnc!, KEYS))).toMatchObject({
      accessToken: stub.currentAccessToken,
      refreshToken: stub.currentRefreshToken,
    });

    // A writer that still holds the ciphertext from before the refresh affects no rows.
    const stale = await replaceSourceSecretIfUnchanged(
      database.db,
      sourceId,
      before.secretEnc,
      '{"v":1,"kind":"oauth","accessToken":"old","refreshToken":"old","botId":"b","workspaceId":"w"}',
      KEYS,
    );
    expect(stale).toBe(false);
    const [still] = await sources('wiki');
    expect(still.secretEnc).toBe(after.secretEnc);
  });

  it('refreshes once when two runs of the source are refused together', async () => {
    const [row] = await sources('wiki');
    stub.expireAccessToken();
    stub.tokenDelayMs = 100;
    const grants = stub.refreshGrants;
    try {
      await Promise.all([driverOf(row).test(), driverOf(row).test()]);
    } finally {
      stub.tokenDelayMs = 0;
    }
    expect(stub.refreshGrants - grants).toBe(1);
  });

  it('a revoked connection ends the run asking for a Reconnect and leaves the stored secret exactly as it was', async () => {
    const [before] = await sources('wiki');
    stub.revokeEverything();
    await expect(driverOf(before).sync()).rejects.toThrow(/Reconnect/);
    const [after] = await sources('wiki');
    expect(after.secretEnc).toBe(before.secretEnc);
  });

  it('reconnects the same source: new tokens in the same row, workspace refreshed, a sync queued, an audit row', async () => {
    const [before] = await sources('wiki');
    enqueue.mockClear();
    const flow = await authorise(editor, { sourceId });
    const res = await callback(flow.callback, flow.jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?notion_oauth=reconnected#/${projectName}`);

    const [after] = await sources('wiki');
    expect(after.id).toBe(sourceId);
    expect(after.secretEnc).not.toBe(before.secretEnc);
    expect(JSON.parse(decryptSecret(after.secretEnc!, KEYS))).toMatchObject({ accessToken: stub.currentAccessToken });
    expect(await notionRows()).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith(projectId);
    // And it works again.
    await expect(driverOf(after).test()).resolves.toBe('Connected as Stub bot');

    await live.ctx.audit.settled();
    const rows = await database.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, sourceId), eq(auditEvents.action, 'PATCH /api/projects/:id/sources/:sid')));
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ connection: 'notion-oauth' });
  });

  it('comes back to the dashboard, creating nothing, when the person cancels in Notion', async () => {
    stub.denyNextAuthorization = true;
    const flow = await authorise(editor, { name: 'cancelled', rootIds: [] });
    const res = await callback(flow.callback, flow.jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?notion_oauth=denied#/${projectName}`);
    expect(await sources('cancelled')).toHaveLength(0);
  });
});

describe('(d) who may start and finish it', () => {
  it('turns away ADMIN_TOKEN and an API token at the start, and a viewer with 403', async () => {
    const owner = await signIn('oauth-api-owner', 'editor');
    const { token } = await createApiToken(database.db, {
      userId: owner.userId,
      name: 'ci',
      scope: ['POST /api/projects/:id/sources/notion/oauth'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.userId,
    });
    for (const bearer of [ADMIN_BEARER, token]) {
      const res = await fetch(`${live.origin}/api/projects/${projectId}/sources/notion/oauth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ name: 'machine' }),
      });
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie().some((c) => c.startsWith(NOTION_OAUTH_FLOW_COOKIE))).toBe(false);
    }
    const viewer = await signIn('oauth-viewer', 'viewer');
    expect((await startFlow(viewer.jar, { name: 'viewer-made' })).status).toBe(403);
    const outsider = await signIn('oauth-outsider', null);
    expect([403, 404]).toContain((await startFlow(outsider.jar, { name: 'outsider-made' })).status);
    expect(await sources('machine')).toHaveLength(0);
    expect(await sources('viewer-made')).toHaveLength(0);
  });

  it('refuses a callback reached by another session, creating nothing and changing no secret', async () => {
    const starter = await signIn('oauth-starter', 'editor');
    const intruder = await signIn('oauth-intruder', 'editor');
    const flow = await authorise(starter, { name: 'hijack' });
    // The flow cookie (planted in the intruder's browser) with the intruder's own session.
    const jar: Jar = { ...intruder.jar, [NOTION_OAUTH_FLOW_COOKIE]: flow.jar[NOTION_OAUTH_FLOW_COOKIE] };
    const before = await notionRows();
    const exchanges = stub.tokenRequests.length;
    const res = await callback(flow.callback, jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?notion_oauth=forbidden');
    expect(await sources('hijack')).toHaveLength(0);
    expect((await notionRows()).map((r) => r.secretEnc)).toEqual(before.map((r) => r.secretEnc));
    // Refused before the code was spent.
    expect(stub.tokenRequests.length).toBe(exchanges);
  });

  it('refuses a callback whose state is not the one that was issued, and one with no flow cookie', async () => {
    const account = await signIn('oauth-state', 'editor');
    const flow = await authorise(account, { name: 'wrong-state' });
    const tampered = new URL(flow.callback);
    tampered.searchParams.set('state', 'not-the-state');
    const exchanges = stub.tokenRequests.length;
    const wrongState = await callback(tampered.toString(), flow.jar);
    expect([wrongState.status, wrongState.headers.get('location')]).toEqual([302, '/?notion_oauth=expired']);
    const { [NOTION_OAUTH_FLOW_COOKIE]: _gone, ...withoutCookie } = flow.jar;
    const noCookie = await callback(flow.callback, withoutCookie);
    expect([noCookie.status, noCookie.headers.get('location')]).toEqual([302, '/?notion_oauth=expired']);
    expect(await sources('wrong-state')).toHaveLength(0);
    expect(stub.tokenRequests.length).toBe(exchanges);
  });

  it('refuses a callback when the account stopped being an editor of the project in the meantime', async () => {
    const account = await signIn('oauth-demoted', 'editor');
    const flow = await authorise(account, { name: 'demoted' });
    await removeMember(database.db, projectId, account.userId);
    const exchanges = stub.tokenRequests.length;
    const res = await callback(flow.callback, flow.jar);
    expect([res.status, res.headers.get('location')]).toEqual([302, '/?notion_oauth=forbidden']);
    expect(await sources('demoted')).toHaveLength(0);
    expect(stub.tokenRequests.length).toBe(exchanges);

    // Demoted to viewer rather than removed: the same answer.
    await setMemberRole(database.db, projectId, account.userId, 'editor', null);
    const second = await authorise(account, { name: 'demoted-viewer' });
    await setMemberRole(database.db, projectId, account.userId, 'viewer', null);
    const demoted = await callback(second.callback, second.jar);
    expect([demoted.status, demoted.headers.get('location')]).toEqual([302, '/?notion_oauth=forbidden']);
    expect(await sources('demoted-viewer')).toHaveLength(0);
  });

  it('leaves the secret of a source being reconnected alone when the callback is refused', async () => {
    const owner = await signIn('oauth-reconnector', 'editor');
    const [row] = await notionRows();
    const flow = await authorise(owner, { sourceId: row.id });
    await removeMember(database.db, projectId, owner.userId);
    const refused = await callback(flow.callback, flow.jar);
    expect([refused.status, refused.headers.get('location')]).toEqual([302, '/?notion_oauth=forbidden']);
    const [after] = await sources(row.name);
    expect(after.secretEnc).toBe(row.secretEnc);
  });

  it('sends a name that is already taken back to the dashboard without storing the new tokens', async () => {
    const account = await signIn('oauth-name-taken', 'editor');
    const flow = await authorise(account, { name: 'racer' });
    // Someone else takes the name while the person is in Notion.
    const created = await fetch(`${live.origin}/api/projects/${projectId}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}` },
      body: JSON.stringify({ type: 'notion', name: 'racer', secret: 'ntn_not-a-real-token-only-a-test', index: false }),
    });
    expect(created.status).toBe(201);
    const [before] = await sources('racer');
    const res = await callback(flow.callback, flow.jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?notion_oauth=name_taken#/${projectName}`);
    const [after] = await sources('racer');
    expect(after.secretEnc).toBe(before.secretEnc);
  });
});

describe('(e) the API cannot choose the stored format', () => {
  const OAUTH_LOOKING = '{"v":1,"kind":"oauth","accessToken":"x","refreshToken":"y","botId":"b","workspaceId":"w"}';
  const adminJson = { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}` };

  it('refuses a new Notion source whose secret starts with "{" and creates nothing', async () => {
    const res = await fetch(`${live.origin}/api/projects/${projectId}/sources`, {
      method: 'POST',
      headers: adminJson,
      body: JSON.stringify({ type: 'notion', name: 'smuggled', secret: OAUTH_LOOKING, index: false }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    expect(await sources('smuggled')).toHaveLength(0);
  });

  it('refuses the same on a patch and leaves the stored secret untouched', async () => {
    const [row] = await sources('racer');
    const res = await fetch(`${live.origin}/api/projects/${projectId}/sources/${row.id}`, {
      method: 'PATCH',
      headers: adminJson,
      body: JSON.stringify({ secret: `  ${OAUTH_LOOKING}` }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    const [after] = await sources('racer');
    expect(after.secretEnc).toBe(row.secretEnc);
  });

  it('ignores a config.oauth sent through the API, on create and on patch', async () => {
    const forged = { workspaceId: 'x', workspaceName: 'Forged', botId: 'y' };
    const created = await fetch(`${live.origin}/api/projects/${projectId}/sources`, {
      method: 'POST',
      headers: adminJson,
      body: JSON.stringify({
        type: 'notion',
        name: 'forger',
        config: { rootIds: [], oauth: forged },
        secret: 'ntn_not-a-real-token-only-a-test',
        index: false,
      }),
    });
    expect(created.status).toBe(201);
    const [row] = await sources('forger');
    expect(row.config).not.toHaveProperty('oauth');
    const patched = await fetch(`${live.origin}/api/projects/${projectId}/sources/${row.id}`, {
      method: 'PATCH',
      headers: adminJson,
      body: JSON.stringify({ config: { rootIds: [], oauth: forged } }),
    });
    expect(patched.status).toBe(200);
    const [after] = await sources('forger');
    expect(after.config).not.toHaveProperty('oauth');
  });

  it('forgets the workspace of an OAuth source when a pasted token replaces its credential', async () => {
    const [row] = await sources('wiki');
    expect((row.config as { oauth?: unknown }).oauth).toBeDefined();
    const res = await fetch(`${live.origin}/api/projects/${projectId}/sources/${row.id}`, {
      method: 'PATCH',
      headers: adminJson,
      body: JSON.stringify({ secret: 'ntn_not-a-real-token-only-a-test' }),
    });
    expect(res.status).toBe(200);
    const [after] = await sources('wiki');
    expect(after.config).not.toHaveProperty('oauth');
    expect(decryptSecret(after.secretEnc!, KEYS)).toBe('ntn_not-a-real-token-only-a-test');
  });

  it('still takes a pasted integration token on an existing source', async () => {
    const [row] = await sources('wiki');
    const res = await fetch(`${live.origin}/api/projects/${projectId}/sources/${row.id}`, {
      method: 'PATCH',
      headers: adminJson,
      body: JSON.stringify({ secret: 'ntn_not-a-real-token-only-a-test' }),
    });
    expect(res.status).toBe(200);
    const [after] = await sources('wiki');
    expect(decryptSecret(after.secretEnc!, KEYS)).toBe('ntn_not-a-real-token-only-a-test');
  });
});

describe('the panel asks whether the flow is on', () => {
  it('answers enabled to a signed-in account, and 401 to nobody', async () => {
    const account = await signIn('oauth-panel', 'viewer');
    const res = await fetch(`${live.origin}/api/sources/notion/oauth`, { headers: { cookie: cookieHeader(account.jar) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect((await fetch(`${live.origin}/api/sources/notion/oauth`)).status).toBe(401);
  });
});
