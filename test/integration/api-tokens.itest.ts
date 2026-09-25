import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiTokens, auditEvents } from '../../src/db/schema.js';
import { createProject, deleteProject, NotFoundError } from '../../src/services/projects.js';
import { createApiToken, listApiTokens, revokeApiToken, verifyApiToken } from '../../src/services/auth/api-tokens.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser, updateUser } from '../../src/services/auth/users.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * [ADR-0076](../../.ssot/ADR.md#adr-0076) — an account's own bearer API tokens, exercised against a
 * real database. `verifyApiToken` re-reads the owner's live row on every call and compares both
 * deadlines in SQL, which is precisely why revocation, expiry and owner-narrowing are database
 * concerns and not something `test/permissions.test.ts`'s pure-logic assertions can cover.
 */

const baseUrl = inject('postgresBaseUrl');

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'api_tokens');
  await applySchema(database);
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('API tokens', () => {
  it('mints a token, lists it without the secret, and never returns the secret again', async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'ci-owner', role: 'member', password: 'a-real-password-1!' });

    const { token, view } = await createApiToken(db, {
      userId: owner.id,
      name: 'ci reindexer',
      scope: ['POST /api/projects/:id/reindex'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    expect(token.startsWith('ctxk_')).toBe(true);
    expect(view.name).toBe('ci reindexer');
    expect(view.prefix.startsWith('ctxk_')).toBe(true);
    expect(view.prefix).not.toBe(token); // only a prefix is kept in the clear
    expect(view.revokedAt).toBeNull();

    const listed = await listApiTokens(db, owner.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: view.id, name: 'ci reindexer', prefix: view.prefix });
    // No row anywhere on this type carries the full secret — only its hash does, and that is not it.
    expect(JSON.stringify(listed)).not.toContain(token);

    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, view.id)).limit(1);
    expect(row.tokenHash).not.toBe(token);
  });

  it('verifies a freshly minted token and reports its scope and owner', async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'verify-owner', role: 'admin', password: 'a-real-password-2!' });
    const { token } = await createApiToken(db, {
      userId: owner.id,
      name: 'my token',
      scope: ['GET /api/projects'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    const identity = await verifyApiToken(db, token);
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({ userId: owner.id, role: 'admin', scope: ['GET /api/projects'], projectId: null });
    expect(identity!.username).toBe('my token · verify-owner');

    expect(await verifyApiToken(db, 'ctxk_not-a-real-token')).toBeNull();
    expect(await verifyApiToken(db, 'not-shaped-like-ours-at-all')).toBeNull();
  });

  it('stops working on the very next request once revoked, uncached', async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'revoke-owner', role: 'member', password: 'a-real-password-3!' });
    const { token, view } = await createApiToken(db, {
      userId: owner.id,
      name: 'to be revoked',
      scope: ['GET /api/projects'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    expect(await verifyApiToken(db, token)).not.toBeNull();

    await revokeApiToken(db, owner.id, view.id);

    expect(await verifyApiToken(db, token)).toBeNull();

    const listed = await listApiTokens(db, owner.id);
    expect(listed.find((t) => t.id === view.id)?.revokedAt).not.toBeNull();
  });

  it("refuses to revoke a token that is not the caller's own, or one already revoked", async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'owner-a', role: 'member', password: 'a-real-password-4!' });
    const someoneElse = await createUser(db, { username: 'owner-b', role: 'member', password: 'a-real-password-5!' });
    const { view } = await createApiToken(db, {
      userId: owner.id,
      name: 'owner-a token',
      scope: ['GET /api/projects'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    await expect(revokeApiToken(db, someoneElse.id, view.id)).rejects.toThrow(NotFoundError);
    await revokeApiToken(db, owner.id, view.id);
    await expect(revokeApiToken(db, owner.id, view.id)).rejects.toThrow(NotFoundError);
  });

  it('rejects a token once its expiry has passed, compared in the database rather than the process', async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'expiry-owner', role: 'member', password: 'a-real-password-6!' });
    const { token, view } = await createApiToken(db, {
      userId: owner.id,
      name: 'short lived',
      scope: ['GET /api/projects'],
      projectId: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: owner.id,
    });

    expect(await verifyApiToken(db, token)).not.toBeNull();

    // Backdated directly on the row: what matters is that `verifyApiToken` compares against the
    // database's own `now()` on every call, not a value it cached at mint time.
    await db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, view.id));

    expect(await verifyApiToken(db, token)).toBeNull();
  });

  it("narrows to the owner's live role and access on every call, with nothing stored on the token itself", async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'narrow-owner', role: 'admin', password: 'a-real-password-7!' });
    const { token } = await createApiToken(db, {
      userId: owner.id,
      name: 'narrows with its owner',
      scope: ['POST /api/projects'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    const before = await verifyApiToken(db, token);
    expect(before?.role).toBe('admin');

    await updateUser(db, owner.id, { role: 'member' });
    const afterDemotion = await verifyApiToken(db, token);
    expect(afterDemotion?.role).toBe('member');

    await updateUser(db, owner.id, { isActive: false });
    expect(await verifyApiToken(db, token)).toBeNull();

    await updateUser(db, owner.id, { isActive: true });
    expect(await verifyApiToken(db, token)).not.toBeNull();
  });

  it('a project-scoped token stops working once its project is deleted, rather than widening', async () => {
    const { db } = database;
    const owner = await createUser(db, { username: 'scoped-owner', role: 'root', password: 'a-real-password-8!' });
    const project = await createProject(db, { name: 'scoped-project' }, []);
    const { token } = await createApiToken(db, {
      userId: owner.id,
      name: 'project scoped',
      scope: ['POST /api/projects/:id/reindex'],
      projectId: project.id,
      expiresAt: null,
      createdBy: owner.id,
    });

    const identity = await verifyApiToken(db, token);
    expect(identity?.projectId).toBe(project.id);

    await deleteProject(db, project.id, () => false);

    // `api_tokens_project_id_fkey` is `ON DELETE CASCADE`: the row is gone, not left behind with a
    // `project_id` of `NULL` — which would read as "every project the owner reaches", the widening
    // this test is named for. Before it deleted the project, the test could not tell the two apart.
    const left = await db.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.userId, owner.id));
    expect(left).toEqual([]);
    expect(await verifyApiToken(db, token)).toBeNull();
  });
});

/**
 * The reviewer's BLOCKER and the second half of MAJOR 3, driven through real HTTP requests rather than
 * through `checkRequest` or a service call alone: a member-owned token must not see more than its
 * owner's own membership would (`src/admin/routes.ts`'s `GET /api/projects` filter — the exact route
 * that over-read before the fix), and `/api/tokens` must refuse a bearer credential even when the
 * token's own scope would otherwise let it through, because `requireSession` (`src/auth/plugin.ts`) is
 * a second, independent lock and not merely a restatement of the scope check.
 */
describe('an ADR-0076 token over a real request', () => {
  let httpDb: TestDatabase;
  let live: LiveInstance;
  let root: string;

  const ADMIN_TOKEN = 'an-admin-token-for-the-api-tokens-suite';
  const PASSWORD = 'a-real-password-11!';

  beforeAll(async () => {
    httpDb = await createTestDatabase(baseUrl, 'api_tokens_http');
    await applySchema(httpDb);
    root = await mkdtemp(path.join(tmpdir(), 'contextator-api-tokens-'));
    live = await startMcpInstance(httpDb, { dataDir: path.join(root, '.data'), docRoot: root, env: { ADMIN_TOKEN } });
  });

  async function signIn(username: string): Promise<string> {
    const res = await live.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
    expect(res.statusCode, `${username} could not sign in: ${res.body}`).toBe(200);
    return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  const asSession = (cookie: string) => ({ cookie, 'sec-fetch-site': 'same-origin' });

  afterAll(async () => {
    await live?.close();
    await dropTestDatabase(baseUrl, httpDb);
    await rm(root, { recursive: true, force: true });
  });

  it("filters a member-owned token's GET /api/projects to the owner's own membership, exactly as the owner's own session would", async () => {
    const { db } = httpDb;
    const owner = await createUser(db, { username: 'mona', role: 'member', password: 'a-real-password-9!' });
    const own = await createProject(db, { name: 'mona-own' }, []);
    const other = await createProject(db, { name: 'mona-cannot-see' }, []);
    await setMemberRole(db, own.id, owner.id, 'viewer', null);

    const { token } = await createApiToken(db, {
      userId: owner.id,
      name: 'dashboard reader',
      scope: ['GET /api/projects'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    const res = await live.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((p: { id: string }) => p.id);
    expect(ids).toEqual([own.id]);
    expect(ids).not.toContain(other.id);
  });

  it('refuses a token bearer on /api/tokens even when the token is scoped to allow the route', async () => {
    const { db } = httpDb;
    const owner = await createUser(db, { username: 'gil', role: 'admin', password: 'a-real-password-10!' });
    const { token } = await createApiToken(db, {
      userId: owner.id,
      name: 'over-scoped',
      // Scoped to the very route being asked for, so a 403 here can only be `requireSession`'s own
      // check firing — `checkRequest`'s scope check in `src/auth/authorize.ts` would have let this
      // one through, which is exactly why this route needs the second lock.
      scope: ['GET /api/tokens'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    const res = await live.app.inject({ method: 'GET', url: '/api/tokens', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('token_has_no_account');
  });
  /**
   * [ADR-0080](../../.ssot/ADR.md#adr-0080), FR-601: `authKind` names the credential that asked. All
   * three are asserted against one route on one instance, so a constant in `auth-routes.ts` — any of
   * the three — turns this red.
   */
  it('answers GET /api/auth/me with the kind of credential that asked: session, apiToken, token', async () => {
    const { db } = httpDb;
    const owner = await createUser(db, { username: 'ines', role: 'member', password: PASSWORD });
    const { token } = await createApiToken(db, {
      userId: owner.id,
      name: 'whoami',
      scope: ['GET /api/auth/me'],
      projectId: null,
      expiresAt: null,
      createdBy: owner.id,
    });

    const bySession = await live.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: await signIn('ines') } });
    expect(bySession.statusCode, bySession.body).toBe(200);
    expect(bySession.json()).toMatchObject({ id: owner.id, username: 'ines', authKind: 'session' });

    const byToken = await live.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(byToken.statusCode, byToken.body).toBe(200);
    // Every other field is the owner's, exactly as the owner's own session sees it (FR-601).
    const { authKind: sessionKind, ...sessionRest } = bySession.json();
    const { authKind: tokenKind, ...tokenRest } = byToken.json();
    expect(sessionKind).toBe('session');
    expect(tokenKind).toBe('apiToken');
    expect(tokenRest).toEqual(sessionRest);

    const byAdminToken = await live.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(byAdminToken.statusCode, byAdminToken.body).toBe(200);
    expect(byAdminToken.json()).toMatchObject({ id: null, authKind: 'token' });
  });

  /**
   * A project id no project has — never created, or deleted since the dashboard drew its form — is the
   * caller's mistake. It used to reach the foreign key and come back `500 internal_error`.
   */
  it('refuses a mint scoped to a project that does not exist, or no longer does, with a 400', async () => {
    const { db } = httpDb;
    const owner = await createUser(db, { username: 'oona', role: 'admin', password: PASSWORD });
    const cookie = await signIn('oona');
    const gone = await createProject(db, { name: 'oona-gone' }, []);
    await deleteProject(db, gone.id, () => false);

    for (const projectId of [gone.id, '11111111-1111-4111-8111-111111111111']) {
      const res = await live.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: asSession(cookie),
        payload: { name: 'stale form', scope: ['POST /api/projects/:id/reindex'], projectId },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
    expect(await listApiTokens(db, owner.id)).toEqual([]);

    // The same request against a project that exists still mints — the refusal is the missing row,
    // not the field.
    const kept = await createProject(db, { name: 'oona-kept' }, []);
    const ok = await live.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: asSession(cookie),
      payload: { name: 'fresh form', scope: ['POST /api/projects/:id/reindex'], projectId: kept.id },
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  /**
   * An action taken with a token is recorded with the token's own id, and the audit panel's actor
   * filter finds it under the token's own label, told apart by `detail.tokenId` — not under the
   * owner's name (that is `actorUser`, below). Two same-named tokens of one owner are told apart by
   * the id alone, and a token whose *name* imitates another account stays its own owner's.
   */
  it("records the acting token's id beside its label, and the actor filter stays the label exactly", async () => {
    const { db } = httpDb;
    const owner = await createUser(db, { username: 'pia', role: 'admin', password: PASSWORD });
    const mimic = await createUser(db, { username: 'quinn', role: 'admin', password: PASSWORD });
    const project = await createProject(db, { name: 'pia-audited' }, []);
    const scope = ['PATCH /api/projects/:id/mcp-auth'];
    const mint = (userId: string, name: string) => createApiToken(db, { userId, name, scope, projectId: null, expiresAt: null, createdBy: userId });
    const first = await mint(owner.id, 'ops');
    const second = await mint(owner.id, 'ops');
    const imitation = await mint(mimic.id, 'ops · pia');

    for (const [minted, mode] of [
      [first, 'token'],
      [second, 'account'],
      [imitation, 'open'],
    ] as const) {
      const res = await live.app.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}/mcp-auth`,
        headers: { authorization: `Bearer ${minted.token}` },
        payload: { mode },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    await live.ctx.audit.settled();

    const rows = await db
      .select({ label: auditEvents.actorLabel, userId: auditEvents.actorUserId, detail: auditEvents.detail })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'PATCH /api/projects/:id/mcp-auth'), eq(auditEvents.actorKind, 'api_token')));
    const byMode = new Map(rows.map((r) => [(r.detail as { mode: string }).mode, r]));
    // The label is kept, and cannot tell `first` from `second`; the id can.
    expect(byMode.get('token')).toEqual({ label: 'ops · pia', userId: owner.id, detail: { mode: 'token', tokenId: first.view.id } });
    expect(byMode.get('account')).toEqual({ label: 'ops · pia', userId: owner.id, detail: { mode: 'account', tokenId: second.view.id } });
    expect(byMode.get('open')).toEqual({ label: 'ops · pia · quinn', userId: mimic.id, detail: { mode: 'open', tokenId: imitation.view.id } });

    // `actor` is `actor_label` exactly (API.md, FR-451): a token's events are found under the token's
    // label, and told apart by `detail.tokenId`, the one thing the label cannot do.
    const audit = async (actor: string) => {
      const res = await live.app.inject({
        method: 'GET',
        url: `/api/audit?limit=200&actor=${encodeURIComponent(actor)}`,
        headers: { cookie: await signIn('pia') },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { events: Array<{ summary: string; actor: { kind: string; label: string }; detail: Record<string, unknown> }> }).events;
    };
    const tokens = await audit('ops · pia');
    expect(tokens.every((e) => e.actor.kind === 'api_token' && e.actor.label === 'ops · pia')).toBe(true);
    expect(tokens.map((e) => e.detail.tokenId).sort()).toEqual([first.view.id, second.view.id].sort());
    expect(tokens.map((e) => e.summary).join('\n')).toContain(`via token ${first.view.id.slice(0, 8)}…`);
    expect(tokens.map((e) => e.summary).join('\n')).toContain(`via token ${second.view.id.slice(0, 8)}…`);

    // Not a suffix, not an owner lookup: the account's own name finds none of its tokens' events, and
    // the imitation stays under its own, longer label.
    expect((await audit('pia')).filter((e) => e.actor.kind === 'api_token')).toEqual([]);
    expect((await audit('ops · pia · quinn')).map((e) => e.detail.tokenId)).toEqual([imitation.view.id]);
  });

  /**
   * `actorUser` ([ADR-0076](../../.ssot/ADR.md#adr-0076), FR-617): the owner's id, matched exactly
   * against `actor_user_id`, so an account's tokens' events are found by the account — the one thing the
   * `actor` label filter above deliberately cannot do. Combines with the other filters; not a UUID is
   * `400 validation_failed`; leaving it out changes nothing.
   */
  it("finds a token's events by its owner's id, exactly, and only its owner's", async () => {
    const { db } = httpDb;
    const owner = await createUser(db, { username: 'rhea', role: 'admin', password: PASSWORD });
    const other = await createUser(db, { username: 'sami', role: 'admin', password: PASSWORD });
    // An account that never acts: the picker must not offer it.
    const idle = await createUser(db, { username: 'tove', role: 'member', password: PASSWORD });
    const project = await createProject(db, { name: 'rhea-audited' }, []);
    const scope = ['PATCH /api/projects/:id/mcp-auth', 'POST /api/projects/:id/mcp-tokens'];
    const mint = (userId: string, name: string) => createApiToken(db, { userId, name, scope, projectId: null, expiresAt: null, createdBy: userId });
    const mine = await mint(owner.id, 'deploy');
    // Named after the owner on purpose: a label that starts like hers must not be found by her id.
    const theirs = await mint(other.id, 'deploy · rhea');

    const act = async (token: string, method: 'PATCH' | 'POST', url: string, payload: object) => {
      const res = await live.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
      expect(res.statusCode, res.body).toBeLessThan(300);
    };
    await act(mine.token, 'PATCH', `/api/projects/${project.id}/mcp-auth`, { mode: 'token' });
    await act(mine.token, 'POST', `/api/projects/${project.id}/mcp-tokens`, { name: 'ci' });
    await act(theirs.token, 'PATCH', `/api/projects/${project.id}/mcp-auth`, { mode: 'account' });
    await live.ctx.audit.settled();

    const cookie = await signIn('rhea');
    type Page = {
      events: Array<{ action: string; actor: { kind: string; label: string; userId: string | null }; detail: Record<string, unknown> }>;
      nextCursor: string | null;
      filters: { accounts: Array<{ id: string; username: string }> } | null;
    };
    const audit = async (query: string) => {
      const res = await live.app.inject({ method: 'GET', url: `/api/audit?limit=200&${query}`, headers: { cookie } });
      return { status: res.statusCode, body: res.json() as Page & { error?: string } };
    };

    // Positive: every event it answers carries her id, and it holds both of her token's acts.
    const hers = await audit(`actorUser=${owner.id}`);
    expect(hers.status).toBe(200);
    expect(hers.body.events.length).toBeGreaterThan(0);
    expect(hers.body.events.every((e) => e.actor.userId === owner.id)).toBe(true);
    const hersByToken = hers.body.events.filter((e) => e.actor.kind === 'api_token');
    expect(hersByToken.map((e) => e.detail.tokenId)).toEqual([mine.view.id, mine.view.id]);
    expect(hersByToken.map((e) => e.action).sort()).toEqual(['PATCH /api/projects/:id/mcp-auth', 'POST /api/projects/:id/mcp-tokens']);

    // Negative: the other owner's id answers only the other owner's token, and an id nobody holds
    // answers nothing — an exact match, not a label or prefix search.
    const his = await audit(`actorUser=${other.id}`);
    expect(his.body.events.map((e) => e.detail.tokenId)).toEqual([theirs.view.id]);
    expect((await audit('actorUser=00000000-0000-4000-8000-000000000002')).body.events).toEqual([]);

    // Combined with the other filters, which still apply.
    const narrowed = await audit(`actorUser=${owner.id}&action=${encodeURIComponent('PATCH /api/projects/:id/mcp-auth')}&project=${project.id}`);
    expect(narrowed.body.events.map((e) => e.detail.tokenId)).toEqual([mine.view.id]);
    // A token's label is `<name> · <owner>`: hers is `deploy · rhea`, his `deploy · rhea · sami`.
    const ownLabel = await audit(`actorUser=${owner.id}&actor=${encodeURIComponent('deploy · rhea')}`);
    expect(ownLabel.body.events.map((e) => e.detail.tokenId)).toEqual([mine.view.id, mine.view.id]);
    const hisLabel = await audit(`actorUser=${owner.id}&actor=${encodeURIComponent('deploy · rhea · sami')}`);
    expect(hisLabel.body.events).toEqual([]);

    // Without the parameter the page is what it was: all three token acts are on it.
    const everything = await audit(`project=${project.id}`);
    expect(
      everything.body.events
        .filter((e) => e.actor.kind === 'api_token')
        .map((e) => e.detail.tokenId)
        .sort(),
    ).toEqual([mine.view.id, mine.view.id, theirs.view.id].sort());

    // The picker behind it ([F06-MINOR-2], faz 06 review): the first page's `filters.accounts` offers
    // each account with an event as `{ id, username }` — the id the filter takes, the name a person
    // reads — and nobody who has none; a later page carries no facets at all.
    const first = await audit('');
    const accounts = first.body.filters?.accounts ?? [];
    expect(accounts).toContainEqual({ id: owner.id, username: 'rhea' });
    expect(accounts).toContainEqual({ id: other.id, username: 'sami' });
    expect(accounts.map((a) => a.id)).not.toContain(idle.id);
    const paged = await live.app.inject({ method: 'GET', url: '/api/audit?limit=1', headers: { cookie } });
    const cursor = (paged.json() as Page).nextCursor;
    expect(cursor).not.toBeNull();
    const next = await live.app.inject({
      method: 'GET',
      url: `/api/audit?limit=1&cursor=${encodeURIComponent(cursor as string)}`,
      headers: { cookie },
    });
    expect(next.statusCode).toBe(200);
    expect((next.json() as Page).filters).toBeNull();

    // Not a UUID is refused before it reaches a `uuid` column.
    for (const bad of ['rhea', '1234', `${owner.id}x`]) {
      const refused = await audit(`actorUser=${encodeURIComponent(bad)}`);
      expect(refused.status, bad).toBe(400);
      expect(refused.body.error).toBe('validation_failed');
    }
  });
});
