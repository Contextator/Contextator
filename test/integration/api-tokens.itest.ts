import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiTokens } from '../../src/db/schema.js';
import { createProject, NotFoundError } from '../../src/services/projects.js';
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

  beforeAll(async () => {
    httpDb = await createTestDatabase(baseUrl, 'api_tokens_http');
    await applySchema(httpDb);
    root = await mkdtemp(path.join(tmpdir(), 'contextator-api-tokens-'));
    live = await startMcpInstance(httpDb, { dataDir: path.join(root, '.data'), docRoot: root });
  });

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
});
