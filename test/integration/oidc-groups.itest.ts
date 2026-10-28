import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import {
  auditEvents,
  oidcGroupMappings,
  projectMembers,
  projects,
  userFederatedIdentities,
  userSessions,
  users,
  type AuditEventRow,
} from '../../src/db/schema.js';
import { linkFederatedIdentity } from '../../src/services/auth/federated-identities.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser } from '../../src/services/auth/users.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';
import { startLocalOidcProvider, type GroupsClaimSetting, type LocalOidcProvider } from './support/oidc-provider.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';

/**
 * **A provider group grants project memberships, and only that** ([ADR-0134](../../.ssot/ADR.md#adr-0134),
 * FR-702, FR-703; Faz 11b of the 0.6.0 plan).
 *
 * Two instances share one database and one in-process provider: `live` has `OIDC_GROUPS_CLAIM=groups`, `off`
 * does not. Every test names its own groups, projects and accounts (`label-…`), so none reads another's
 * rows, and none asserts an order the database does not promise: rows are looked up by project and a
 * list of groups is compared as the sorted list the code stores.
 */

const baseUrl = inject('postgresBaseUrl');

const ADMIN_BEARER = 'oidc-groups-itest-admin-token-12345';
const PASSWORD = 'a-long-enough-password-2!';

let database: TestDatabase;
let root: string;
let live: LiveInstance;
let off: LiveInstance;
let provider: LocalOidcProvider;
let seq = 0;

const jarFromSetCookie = (setCookies: string[], into: Record<string, string> = {}): Record<string, string> => {
  for (const raw of setCookies) {
    const pair = raw.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    into[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return into;
};

const cookieHeader = (jar: Record<string, string>): string =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

/** `/api/auth/oidc/login` → the provider's `/authorize`, by hand, as a browser would: stops at the callback URL. */
async function startOidcFlow(origin: string): Promise<{ jar: Record<string, string>; callbackUrl: string }> {
  const login = await fetch(`${origin}/api/auth/oidc/login`, { redirect: 'manual' });
  const authorizeUrl = login.headers.get('location');
  if (!authorizeUrl) throw new Error(`/api/auth/oidc/login did not redirect (status ${login.status})`);
  const jar = jarFromSetCookie(login.headers.getSetCookie());
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = authorize.headers.get('location');
  if (!callbackUrl) throw new Error(`the provider fixture did not redirect back (status ${authorize.status})`);
  return { jar, callbackUrl };
}

async function hitCallback(callbackUrl: string, jar: Record<string, string>): Promise<Response> {
  const callback = await fetch(callbackUrl, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  jarFromSetCookie(callback.headers.getSetCookie(), jar);
  return callback;
}

/** The whole of a sign-in: the flow, then the callback. */
async function driveOidcLogin(origin: string): Promise<{ callback: Response; jar: Record<string, string> }> {
  const { jar, callbackUrl } = await startOidcFlow(origin);
  return { callback: await hitCallback(callbackUrl, jar), jar };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until a backend of this database is queued on a lock **and is running a statement matching
 * `queryLike`** (an ILIKE pattern on `pg_stat_activity.query`), observed rather than guessed at. Naming the
 * statement is what makes the wait mean "the request under test has got there" and not "something is
 * waiting on something".
 */
async function waitForLockWaiter(queryLike: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await database.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1",
      [queryLike],
    );
    if ((res.rows[0]?.n ?? 0) > 0) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

/** What `deleteGroupMapping` queues on first (the exclusive advisory lock), and then on (the member rows it locks). */
const WAITING_ON_MAPPINGS_LOCK = '%pg_advisory_xact_lock(7213011)%';
const WAITING_ON_MEMBER_ROWS = '%from "project_members"%for update%';

interface Fixture {
  userId: string;
  username: string;
  sub: string;
}

/** A local account with a password, SSO-linked to a subject of its own. */
async function makeAccount(label: string, role: 'member' | 'admin' = 'member'): Promise<Fixture> {
  seq += 1;
  const username = `${label}-${seq}`;
  const sub = `sub-${username}`;
  const created = await createUser(database.db, { username, role, password: PASSWORD });
  await linkFederatedIdentity(database.db, { userId: created.id, provider: 'test', issuer: provider.issuer, subject: sub });
  return { userId: created.id, username, sub };
}

const makeProject = (label: string) => seedProject(database.db, `grp-${label}-${++seq}`, { path: 'guide.md', body: '# Guide' });

/** One SSO sign-in of `account`, the provider saying `groups` about it. */
async function ssoSignIn(account: Fixture, groups: GroupsClaimSetting, instance: LiveInstance = live) {
  provider.setGroups(account.sub, groups);
  provider.setNextIdentity({ sub: account.sub, preferred_username: account.username });
  return driveOidcLogin(instance.origin);
}

const signedIn = (result: { callback: Response; jar: Record<string, string> }): boolean =>
  result.callback.status === 302 && result.callback.headers.get('location') === '/' && Boolean(result.jar[SESSION_COOKIE]);

const passwordSignIn = (account: Fixture, instance: LiveInstance = live): Promise<Response> =>
  fetch(`${instance.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: account.username, password: PASSWORD }),
  });

const asAdmin = (instance: LiveInstance, method: string, urlPath: string, body?: unknown): Promise<Response> =>
  fetch(`${instance.origin}${urlPath}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_BEARER}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Maps `group` to `projectId` through the admin API, as an administrator would. */
async function mapGroup(group: string, projectId: string, role: 'viewer' | 'editor'): Promise<string> {
  const res = await asAdmin(live, 'POST', '/api/oidc/group-mappings', { group, projectId, role });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function membership(userId: string, projectId: string) {
  const [row] = await database.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)));
  return row;
}

const membershipEvents = async (userId: string): Promise<AuditEventRow[]> =>
  (await database.db.select().from(auditEvents).where(eq(auditEvents.targetId, userId))).filter((e) => e.targetType === 'membership');

const sessionCount = async (userId: string): Promise<number> =>
  (await database.db.select().from(userSessions).where(eq(userSessions.userId, userId))).length;

/**
 * The audit hook writes a request's own event from `onResponse`, which can run a beat after `fetch`
 * resolved; `settled()` alone could run before `record()` was called, so this polls.
 */
async function waitForEvents(match: (e: AuditEventRow) => boolean, atLeast = 1, timeoutMs = 5_000): Promise<AuditEventRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await live.ctx.audit.settled();
    const rows = (await database.db.select().from(auditEvents)).filter(match);
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'oidc_groups');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-oidc-groups-'));
  provider = await startLocalOidcProvider({ groupsClaim: 'groups' });
  const env = {
    OIDC_ISSUER_URL: provider.issuer,
    OIDC_CLIENT_ID: provider.clientId,
    OIDC_CLIENT_SECRET: provider.clientSecret,
    OIDC_AUTO_PROVISION: '1',
    OIDC_DEFAULT_ROLE: 'member',
    ADMIN_TOKEN: ADMIN_BEARER,
  };
  live = await startMcpInstance(database, { dataDir: path.join(root, 'on'), docRoot: root, env: { ...env, OIDC_GROUPS_CLAIM: 'groups' } });
  off = await startMcpInstance(database, { dataDir: path.join(root, 'off'), docRoot: root, env });
});

afterAll(async () => {
  await live?.close();
  await off?.close();
  await provider?.close();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('a member signing in through SSO', () => {
  it('becomes a group-granted member of the projects its group maps to, with the mapped role', async () => {
    const project = await makeProject('basic');
    const group = `basic-${++seq}-staff`;
    await mapGroup(group, project.id, 'editor');
    const account = await makeAccount('basic');

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);

    const row = await membership(account.userId, project.id);
    expect(row).toMatchObject({ role: 'editor', origin: 'oidc_group', oidcGroups: [group], createdBy: null });
  });

  it('loses the membership at the next sign-in once it has left the group', async () => {
    const project = await makeProject('leave');
    const group = `leave-${++seq}-staff`;
    await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('leave');

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, project.id)).toBeTruthy();

    expect(signedIn(await ssoSignIn(account, []))).toBe(true);
    expect(await membership(account.userId, project.id)).toBeUndefined();
  });

  it('keeps the membership while it stays in the group, and follows a change of the mapped role at the next sign-in', async () => {
    const project = await makeProject('role');
    const viewerGroup = `role-${++seq}-readers`;
    const editorGroup = `role-${seq}-writers`;
    await mapGroup(viewerGroup, project.id, 'viewer');
    await mapGroup(editorGroup, project.id, 'editor');
    const account = await makeAccount('role');

    expect(signedIn(await ssoSignIn(account, [viewerGroup]))).toBe(true);
    expect((await membership(account.userId, project.id))?.role).toBe('viewer');

    expect(signedIn(await ssoSignIn(account, [viewerGroup, editorGroup]))).toBe(true);
    expect((await membership(account.userId, project.id))?.role).toBe('editor');

    expect(signedIn(await ssoSignIn(account, [viewerGroup]))).toBe(true);
    expect((await membership(account.userId, project.id))?.role).toBe('viewer');
  });

  it('gets the higher role where two groups map one project to different roles, and records both groups', async () => {
    const project = await makeProject('two-groups');
    const viewerGroup = `two-${++seq}-readers`;
    const editorGroup = `two-${seq}-writers`;
    await mapGroup(viewerGroup, project.id, 'viewer');
    await mapGroup(editorGroup, project.id, 'editor');
    const account = await makeAccount('two-groups');

    expect(signedIn(await ssoSignIn(account, [editorGroup, viewerGroup]))).toBe(true);

    const row = await membership(account.userId, project.id);
    expect(row?.role).toBe('editor');
    expect([...(row?.oidcGroups ?? [])].sort()).toEqual([editorGroup, viewerGroup].sort());
  });

  it('is reconciled in the same sign-in that auto-provisions its account', async () => {
    const project = await makeProject('provision');
    const group = `provision-${++seq}-staff`;
    await mapGroup(group, project.id, 'viewer');
    const sub = `sub-provision-${seq}`;
    provider.setGroups(sub, [group]);
    provider.setNextIdentity({ sub, preferred_username: `provisioned-${seq}` });

    expect(signedIn(await driveOidcLogin(live.origin))).toBe(true);

    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, sub));
    expect(link).toBeTruthy();
    const [user] = await database.db.select().from(users).where(eq(users.id, link!.userId));
    expect(user?.role).toBe('member');
    expect(await membership(link!.userId, project.id)).toMatchObject({ role: 'viewer', origin: 'oidc_group', oidcGroups: [group] });
  });

  it('does not take a group matching by case: the names are compared exactly', async () => {
    const project = await makeProject('case');
    const group = `Case-${++seq}-Staff`;
    await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('case');

    expect(signedIn(await ssoSignIn(account, [group.toLowerCase()]))).toBe(true);
    expect(await membership(account.userId, project.id)).toBeUndefined();
  });
});

describe('a membership somebody added by hand', () => {
  it('keeps its role when a group maps the same project, and survives the group being lost', async () => {
    const project = await makeProject('manual');
    const group = `manual-${++seq}-staff`;
    await mapGroup(group, project.id, 'editor');
    const account = await makeAccount('manual');
    await setMemberRole(database.db, project.id, account.userId, 'viewer', null);

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'viewer', origin: 'manual', oidcGroups: null });

    expect(signedIn(await ssoSignIn(account, []))).toBe(true);
    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'viewer', origin: 'manual', oidcGroups: null });
  });

  it('writes no audit event for a project where the hand-made row won', async () => {
    const project = await makeProject('manual-audit');
    const group = `manual-audit-${++seq}-staff`;
    await mapGroup(group, project.id, 'editor');
    const account = await makeAccount('manual-audit');
    await setMemberRole(database.db, project.id, account.userId, 'viewer', null);

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect((await membershipEvents(account.userId)).filter((e) => e.projectId === project.id)).toEqual([]);
  });
});

describe('a claim that says nothing', () => {
  it.each<[string, GroupsClaimSetting]>([
    ['is not sent at all', 'omit'],
    ['is an empty object', 'empty-object'],
  ])('removes the group-granted memberships and keeps the hand-made ones when the claim %s', async (_label, setting) => {
    const granted = await makeProject('silent-granted');
    const manual = await makeProject('silent-manual');
    const group = `silent-${++seq}-staff`;
    await mapGroup(group, granted.id, 'viewer');
    const account = await makeAccount('silent');
    await setMemberRole(database.db, manual.id, account.userId, 'editor', null);

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, granted.id)).toBeTruthy();

    expect(signedIn(await ssoSignIn(account, setting))).toBe(true);
    expect(await membership(account.userId, granted.id)).toBeUndefined();
    expect(await membership(account.userId, manual.id)).toMatchObject({ role: 'editor', origin: 'manual' });
  });
});

describe('a claim that cannot be read', () => {
  /** The same account first signs in readably, so there is a row that the refused sign-in must leave alone. */
  async function groupedAccount(label: string) {
    const project = await makeProject(label);
    const group = `${label}-${++seq}-staff`;
    await mapGroup(group, project.id, 'editor');
    const account = await makeAccount(label);
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, project.id)).toBeTruthy();
    return { project, group, account, sessionsBefore: await sessionCount(account.userId) };
  }

  it.each<[string, (group: string) => GroupsClaimSetting]>([
    ['an Entra overage marker (_claim_names.groups)', () => 'overage'],
    ['a list of more than 1000 entries', (group) => [group, ...Array.from({ length: 1000 }, (_, i) => `extra-${i}`)]],
  ])('refuses the sign-in, opens no session and changes nothing for %s', async (_label, setting) => {
    const { project, group, account, sessionsBefore } = await groupedAccount(`unreadable-${++seq}`);
    const before = await membership(account.userId, project.id);

    const result = await ssoSignIn(account, setting(group));

    expect(result.callback.status).toBe(302);
    expect(result.callback.headers.get('location')).toBe('/login?oidc_error=groups_unavailable');
    expect(result.jar[SESSION_COOKIE]).toBeUndefined();
    expect(await sessionCount(account.userId)).toBe(sessionsBefore);
    expect(await membership(account.userId, project.id)).toEqual(before);
  });

  it('refuses an entry longer than 256 characters the same way', async () => {
    const { project, group, account } = await groupedAccount('long-entry');

    const result = await ssoSignIn(account, [group, 'x'.repeat(257)]);

    expect(result.callback.headers.get('location')).toBe('/login?oidc_error=groups_unavailable');
    expect(await membership(account.userId, project.id)).toBeTruthy();
  });

  it('does not create the account of an identity that is about to be auto-provisioned', async () => {
    const sub = `sub-unreadable-provision-${++seq}`;
    provider.setGroups(sub, 'overage');
    provider.setNextIdentity({ sub, preferred_username: `unreadable-provision-${seq}` });

    const result = await driveOidcLogin(live.origin);

    expect(result.callback.headers.get('location')).toBe('/login?oidc_error=groups_unavailable');
    expect(await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, sub))).toEqual([]);
  });
});

describe('a password sign-in', () => {
  it('removes the group-granted memberships and keeps the hand-made ones, records why, and the next SSO sign-in brings the groups back', async () => {
    const granted = await makeProject('password-granted');
    const manual = await makeProject('password-manual');
    const group = `password-${++seq}-staff`;
    await mapGroup(group, granted.id, 'viewer');
    const account = await makeAccount('password');
    await setMemberRole(database.db, manual.id, account.userId, 'viewer', null);

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, granted.id)).toBeTruthy();

    const login = await passwordSignIn(account);
    expect(login.status).toBe(200);
    expect(await membership(account.userId, granted.id)).toBeUndefined();
    expect(await membership(account.userId, manual.id)).toMatchObject({ role: 'viewer', origin: 'manual' });

    const removal = (await membershipEvents(account.userId)).filter((e) => e.action === 'POST /api/auth/login');
    expect(removal).toHaveLength(1);
    expect(removal[0]).toMatchObject({ projectId: granted.id, targetType: 'membership', targetId: account.userId });
    expect(removal[0]?.detail).toMatchObject({ change: 'removed', previousRole: 'viewer', groups: [group], reason: 'password_sign_in' });

    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, granted.id)).toMatchObject({ role: 'viewer', origin: 'oidc_group' });
  });
});

describe('unlinking SSO', () => {
  it('removes the group-granted memberships under the same lock, leaves hand-made ones, and records why', async () => {
    const granted = await makeProject('unlink-granted');
    const manual = await makeProject('unlink-manual');
    const group = `unlink-${++seq}-staff`;
    await mapGroup(group, granted.id, 'viewer');
    const account = await makeAccount('unlink');
    await setMemberRole(database.db, manual.id, account.userId, 'editor', null);

    // The session the unlink is made with comes from the password, and comes first: a password sign-in is
    // itself a removal, so signing in with SSO afterwards is what leaves a row for the unlink to remove.
    const password = await passwordSignIn(account);
    expect(password.status).toBe(200);
    const sessionJar = jarFromSetCookie(password.headers.getSetCookie());
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, granted.id)).toBeTruthy();

    const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader(sessionJar), 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    });
    expect(unlink.status).toBe(204);

    expect(await membership(account.userId, granted.id)).toBeUndefined();
    expect(await membership(account.userId, manual.id)).toMatchObject({ role: 'editor', origin: 'manual' });

    const removal = (await membershipEvents(account.userId)).filter((e) => e.action === 'DELETE /api/auth/oidc/link');
    expect(removal).toHaveLength(1);
    expect(removal[0]).toMatchObject({ projectId: granted.id });
    expect(removal[0]?.detail).toMatchObject({ change: 'removed', previousRole: 'viewer', groups: [group], reason: 'unlink' });
  });
});

describe('deleting a mapping', () => {
  it('removes, in the same request, the membership that rested on that group alone', async () => {
    const project = await makeProject('delete-only');
    const group = `delete-only-${++seq}-staff`;
    const mappingId = await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('delete-only');
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect(await membership(account.userId, project.id)).toBeTruthy();

    const res = await asAdmin(live, 'DELETE', `/api/oidc/group-mappings/${mappingId}`);

    expect(res.status).toBe(204);
    expect(await membership(account.userId, project.id)).toBeUndefined();
    const [event] = await waitForEvents((e) => e.action === 'DELETE /api/oidc/group-mappings/:id' && e.targetId === mappingId);
    expect(event?.detail).toMatchObject({ membershipsUpdated: 0, membershipsRemoved: 1 });
  });

  it('recomputes the role from the groups that are left when another group still maps the project', async () => {
    const project = await makeProject('delete-shared');
    const viewerGroup = `delete-shared-${++seq}-readers`;
    const editorGroup = `delete-shared-${seq}-writers`;
    await mapGroup(viewerGroup, project.id, 'viewer');
    const editorMapping = await mapGroup(editorGroup, project.id, 'editor');
    const account = await makeAccount('delete-shared');
    expect(signedIn(await ssoSignIn(account, [viewerGroup, editorGroup]))).toBe(true);
    expect((await membership(account.userId, project.id))?.role).toBe('editor');

    const res = await asAdmin(live, 'DELETE', `/api/oidc/group-mappings/${editorMapping}`);

    expect(res.status).toBe(204);
    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'viewer', origin: 'oidc_group', oidcGroups: [viewerGroup] });
    const [event] = await waitForEvents((e) => e.action === 'DELETE /api/oidc/group-mappings/:id' && e.targetId === editorMapping);
    expect(event?.detail).toMatchObject({ membershipsUpdated: 1, membershipsRemoved: 0 });
  });

  it('leaves a hand-made membership of the same project alone and counts nothing', async () => {
    const project = await makeProject('delete-manual');
    const group = `delete-manual-${++seq}-staff`;
    const mappingId = await mapGroup(group, project.id, 'editor');
    const account = await makeAccount('delete-manual');
    await setMemberRole(database.db, project.id, account.userId, 'viewer', null);
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);

    expect((await asAdmin(live, 'DELETE', `/api/oidc/group-mappings/${mappingId}`)).status).toBe(204);

    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'viewer', origin: 'manual' });
    const [event] = await waitForEvents((e) => e.action === 'DELETE /api/oidc/group-mappings/:id' && e.targetId === mappingId);
    expect(event?.detail).toMatchObject({ membershipsUpdated: 0, membershipsRemoved: 0 });
  });

  it('answers 404 for a mapping that does not exist', async () => {
    const res = await asAdmin(live, 'DELETE', '/api/oidc/group-mappings/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('disappears with its project, and so does the membership it granted', async () => {
    const project = await makeProject('project-gone');
    const group = `project-gone-${++seq}-staff`;
    const mappingId = await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('project-gone');
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);

    // The row is what ON DELETE CASCADE acts on; the route around it (disk, indexer) is not this test's business.
    await database.db.delete(projects).where(eq(projects.id, project.id));

    expect(await database.db.select().from(oidcGroupMappings).where(eq(oidcGroupMappings.id, mappingId))).toEqual([]);
    expect(await membership(account.userId, project.id)).toBeUndefined();
  });
});

describe('an admin account', () => {
  it('gets no membership row from its groups, and an unreadable claim does not refuse its sign-in', async () => {
    const project = await makeProject('admin');
    const group = `admin-${++seq}-staff`;
    await mapGroup(group, project.id, 'editor');
    const admin = await makeAccount('admin', 'admin');

    expect(signedIn(await ssoSignIn(admin, [group]))).toBe(true);
    expect(await database.db.select().from(projectMembers).where(eq(projectMembers.userId, admin.userId))).toEqual([]);

    expect(signedIn(await ssoSignIn(admin, 'overage'))).toBe(true);
    expect(await database.db.select().from(projectMembers).where(eq(projectMembers.userId, admin.userId))).toEqual([]);
  });
});

describe('the administration surface', () => {
  async function memberSession(label: string): Promise<Record<string, string>> {
    const account = await makeAccount(label);
    const res = await passwordSignIn(account);
    expect(res.status).toBe(200);
    return jarFromSetCookie(res.headers.getSetCookie());
  }

  it('refuses a member on every mapping route with 403', async () => {
    const jar = await memberSession('mgmt-member');
    const asMember = (method: string, urlPath: string, body?: unknown) =>
      fetch(`${live.origin}${urlPath}`, {
        method,
        headers: {
          cookie: cookieHeader(jar),
          'sec-fetch-site': 'same-origin',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const project = await makeProject('mgmt-member');

    expect((await asMember('GET', '/api/oidc/group-mappings')).status).toBe(403);
    expect((await asMember('POST', '/api/oidc/group-mappings', { group: 'g', projectId: project.id, role: 'viewer' })).status).toBe(403);
    expect((await asMember('DELETE', '/api/oidc/group-mappings/00000000-0000-4000-8000-000000000000')).status).toBe(403);
  });

  it('lists mappings with the project name, and answers 409 mapping_exists for a repeat', async () => {
    const project = await makeProject('mgmt-list');
    const group = `mgmt-list-${++seq}-staff`;
    const id = await mapGroup(group, project.id, 'viewer');

    const list = await asAdmin(live, 'GET', '/api/oidc/group-mappings');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { mappings: { id: string; group: string; projectId: string; projectName: string; role: string }[] };
    expect(body.mappings.find((m) => m.id === id)).toMatchObject({ group, projectId: project.id, projectName: project.name, role: 'viewer' });

    const again = await asAdmin(live, 'POST', '/api/oidc/group-mappings', { group, projectId: project.id, role: 'editor' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'mapping_exists' });
    // The repeat changed nothing: a role change is a delete and an add.
    const [row] = await database.db.select().from(oidcGroupMappings).where(eq(oidcGroupMappings.id, id));
    expect(row?.role).toBe('viewer');
  });

  it('rejects a mapping for a project that does not exist (404) and a role that does not (400)', async () => {
    const project = await makeProject('mgmt-bad');
    expect(
      (await asAdmin(live, 'POST', '/api/oidc/group-mappings', { group: 'g', projectId: '00000000-0000-4000-8000-000000000000', role: 'viewer' }))
        .status,
    ).toBe(404);
    expect((await asAdmin(live, 'POST', '/api/oidc/group-mappings', { group: 'g', projectId: project.id, role: 'manager' })).status).toBe(400);
    expect((await asAdmin(live, 'POST', '/api/oidc/group-mappings', { group: '   ', projectId: project.id, role: 'viewer' })).status).toBe(400);
  });

  it('audits a mapping write by role and project, never by the group name', async () => {
    const project = await makeProject('mgmt-audit');
    const group = `mgmt-audit-${++seq}-staff`;
    const id = await mapGroup(group, project.id, 'editor');

    const [event] = await waitForEvents((e) => e.action === 'POST /api/oidc/group-mappings' && e.targetId === id);
    expect(event?.detail).toMatchObject({ role: 'editor', projectId: project.id });
    expect(JSON.stringify(event?.detail)).not.toContain(group);
  });

  it('answers 409 membership_managed_by_group to a change or removal of a group-granted row, and shows its origin and groups', async () => {
    const project = await makeProject('mgmt-managed');
    const group = `mgmt-managed-${++seq}-staff`;
    await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('mgmt-managed');
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);

    const put = await asAdmin(live, 'PUT', `/api/projects/${project.id}/members/${account.userId}`, { role: 'editor' });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ error: 'membership_managed_by_group' });
    const del = await asAdmin(live, 'DELETE', `/api/projects/${project.id}/members/${account.userId}`);
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ error: 'membership_managed_by_group' });
    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'viewer', origin: 'oidc_group' });

    const list = await asAdmin(live, 'GET', `/api/projects/${project.id}/members`);
    const members = (await list.json()) as { userId: string; origin: string; groups: string[] }[];
    expect(members.find((m) => m.userId === account.userId)).toMatchObject({ origin: 'oidc_group', groups: [group] });
  });

  it('still lets the members API add and change a hand-made membership while the feature is on', async () => {
    const project = await makeProject('mgmt-manual');
    const account = await makeAccount('mgmt-manual');

    expect((await asAdmin(live, 'PUT', `/api/projects/${project.id}/members/${account.userId}`, { role: 'viewer' })).status).toBe(200);
    expect((await asAdmin(live, 'PUT', `/api/projects/${project.id}/members/${account.userId}`, { role: 'editor' })).status).toBe(200);
    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'editor', origin: 'manual', oidcGroups: null });

    const list = await asAdmin(live, 'GET', `/api/projects/${project.id}/members`);
    const members = (await list.json()) as { userId: string; origin: string; groups: string[] }[];
    expect(members.find((m) => m.userId === account.userId)).toMatchObject({ origin: 'manual', groups: [] });

    expect((await asAdmin(live, 'DELETE', `/api/projects/${project.id}/members/${account.userId}`)).status).toBe(204);
  });
});

describe('with OIDC_GROUPS_CLAIM unset', () => {
  /** A row left by a time the feature was on: written directly, since nothing now would write it. */
  async function frozenRow(userId: string, projectId: string, groups: string[], role: 'viewer' | 'editor' = 'viewer') {
    await database.db.insert(projectMembers).values({ userId, projectId, role, origin: 'oidc_group', oidcGroups: groups });
  }

  it('lets an SSO sign-in touch no membership: not the mapped ones to add, not the frozen ones to remove', async () => {
    const mapped = await makeProject('off-mapped');
    const frozen = await makeProject('off-frozen');
    const group = `off-${++seq}-staff`;
    await mapGroup(group, mapped.id, 'editor');
    const account = await makeAccount('off');
    await frozenRow(account.userId, frozen.id, ['gone-group']);

    expect(signedIn(await ssoSignIn(account, [group], off))).toBe(true);
    expect(signedIn(await ssoSignIn(account, 'overage', off))).toBe(true);

    expect(await membership(account.userId, mapped.id)).toBeUndefined();
    expect(await membership(account.userId, frozen.id)).toMatchObject({ origin: 'oidc_group', oidcGroups: ['gone-group'] });
    expect(await membershipEvents(account.userId)).toEqual([]);
  });

  it('lets a password sign-in leave the frozen rows alone too', async () => {
    const frozen = await makeProject('off-password');
    const account = await makeAccount('off-password');
    await frozenRow(account.userId, frozen.id, ['gone-group']);

    expect((await passwordSignIn(account, off)).status).toBe(200);

    expect(await membership(account.userId, frozen.id)).toMatchObject({ origin: 'oidc_group' });
  });

  it('lets the members API take over a frozen row (it becomes manual) and remove another', async () => {
    const taken = await makeProject('off-takeover');
    const removed = await makeProject('off-removed');
    const account = await makeAccount('off-members');
    await frozenRow(account.userId, taken.id, ['gone-group']);
    await frozenRow(account.userId, removed.id, ['gone-group']);

    const put = await asAdmin(off, 'PUT', `/api/projects/${taken.id}/members/${account.userId}`, { role: 'editor' });
    expect(put.status).toBe(200);
    expect(await membership(account.userId, taken.id)).toMatchObject({ role: 'editor', origin: 'manual', oidcGroups: null });

    const del = await asAdmin(off, 'DELETE', `/api/projects/${removed.id}/members/${account.userId}`);
    expect(del.status).toBe(204);
    expect(await membership(account.userId, removed.id)).toBeUndefined();
  });

  it('keeps the mapping routes open', async () => {
    const project = await makeProject('off-routes');
    const res = await asAdmin(off, 'POST', '/api/oidc/group-mappings', { group: `off-routes-${++seq}`, projectId: project.id, role: 'viewer' });
    expect(res.status).toBe(201);
  });
});

describe('the audit log of a reconciliation', () => {
  it('has one membership event per addition, role change and removal, each naming the project, the groups and the roles', async () => {
    const [p1, p2, p3] = await Promise.all([makeProject('audit-1'), makeProject('audit-2'), makeProject('audit-3')]);
    const n = ++seq;
    const [a, b, c, d] = [`audit-${n}-a`, `audit-${n}-b`, `audit-${n}-c`, `audit-${n}-d`];
    await mapGroup(a, p1.id, 'viewer');
    await mapGroup(b, p2.id, 'viewer');
    await mapGroup(c, p3.id, 'viewer');
    await mapGroup(d, p2.id, 'editor');
    const account = await makeAccount('audit');

    expect(signedIn(await ssoSignIn(account, [a, b, c]))).toBe(true);
    const added = await membershipEvents(account.userId);
    expect(added).toHaveLength(3);
    for (const event of added) {
      expect(event).toMatchObject({ action: 'GET /api/auth/oidc/callback', targetType: 'membership', targetId: account.userId, statusCode: 302 });
      expect(event.detail).toMatchObject({ change: 'added', role: 'viewer' });
    }
    expect(added.map((e) => e.projectId).sort()).toEqual([p1.id, p2.id, p3.id].sort());

    expect(signedIn(await ssoSignIn(account, [a, b, d]))).toBe(true);
    const later = (await membershipEvents(account.userId)).filter((e) => (e.detail as { change?: string }).change !== 'added');
    expect(later).toHaveLength(2);
    const changed = later.find((e) => e.projectId === p2.id);
    expect(changed?.detail).toMatchObject({ change: 'role_changed', role: 'editor', previousRole: 'viewer', groups: [b, d].sort() });
    const removed = later.find((e) => e.projectId === p3.id);
    expect(removed?.detail).toMatchObject({ change: 'removed', previousRole: 'viewer', groups: [c] });
    // The project that did not move wrote nothing beyond its addition.
    expect((await membershipEvents(account.userId)).filter((e) => e.projectId === p1.id)).toHaveLength(1);
  });
});

describe('a reconciliation that fails', () => {
  it('refuses the sign-in with sync_failed, opens no session and changes no membership', async () => {
    const [p1, p2] = await Promise.all([makeProject('sync-1'), makeProject('sync-2')]);
    const n = ++seq;
    const [a, b] = [`sync-${n}-a`, `sync-${n}-b`];
    await mapGroup(a, p1.id, 'viewer');
    await mapGroup(b, p2.id, 'viewer');
    const account = await makeAccount('sync');
    expect(signedIn(await ssoSignIn(account, [a]))).toBe(true);
    const before = await membership(account.userId, p1.id);
    const sessionsBefore = await sessionCount(account.userId);
    const eventsBefore = (await membershipEvents(account.userId)).length;

    // The insert for the second project is what fails, the way a database error in the middle of a
    // reconciliation would; the trigger is scoped to that one project and dropped afterwards.
    const trigger = `grp_itest_fail_${n}`;
    await database.db.execute(
      sql.raw(
        `CREATE OR REPLACE FUNCTION grp_itest_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced by the test'; END $$`,
      ),
    );
    await database.db.execute(
      sql.raw(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON project_members FOR EACH ROW WHEN (NEW.project_id = '${p2.id}') EXECUTE FUNCTION grp_itest_fail()`,
      ),
    );
    try {
      const result = await ssoSignIn(account, [a, b]);

      expect(result.callback.status).toBe(302);
      expect(result.callback.headers.get('location')).toBe('/login?oidc_error=sync_failed');
      expect(result.jar[SESSION_COOKIE]).toBeUndefined();
      expect(await sessionCount(account.userId)).toBe(sessionsBefore);
      expect(await membership(account.userId, p1.id)).toEqual(before);
      expect(await membership(account.userId, p2.id)).toBeUndefined();
      expect((await membershipEvents(account.userId)).length).toBe(eventsBefore);
    } finally {
      await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON project_members`));
    }

    // Nothing was left behind: with the fault gone the same sign-in goes through.
    expect(signedIn(await ssoSignIn(account, [a, b]))).toBe(true);
    expect(await membership(account.userId, p2.id)).toMatchObject({ origin: 'oidc_group' });
  });
});

describe('deleting a mapping against what else is happening', () => {
  it('waits for a sign-in in flight, so that sign-in cannot leave a membership behind a mapping that is gone', async () => {
    const project = await makeProject('race-signin');
    const group = `race-signin-${++seq}-staff`;
    const mappingId = await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('race-signin');
    provider.setGroups(account.sub, [group]);
    provider.setNextIdentity({ sub: account.sub, preferred_username: account.username });
    const flow = await startOidcFlow(live.origin);

    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Fires after the reconciliation has read the mappings and written the row, still inside the sign-in's
    // transaction: the shared lock on the mappings is held here.
    live.ctx.testHooks = {
      onOidcLoginBeforeSignIn: async () => {
        entered();
        await releasePromise;
      },
    };
    try {
      const callbackPromise = hitCallback(flow.callbackUrl, flow.jar);
      await enteredPromise;

      const deletePromise = asAdmin(live, 'DELETE', `/api/oidc/group-mappings/${mappingId}`);
      const outcome = await Promise.race([deletePromise.then(() => 'resolved' as const), sleep(300).then(() => 'pending' as const)]);
      expect(outcome).toBe('pending');
      expect(await waitForLockWaiter(WAITING_ON_MAPPINGS_LOCK)).toBe(true);

      release();
      const [callback, del] = await Promise.all([callbackPromise, deletePromise]);
      expect(callback.status).toBe(302);
      expect(del.status).toBe(204);
    } finally {
      release();
      live.ctx.testHooks = undefined;
    }

    // The deletion ran after the sign-in committed, so it saw the row and took it away with the mapping.
    expect(await membership(account.userId, project.id)).toBeUndefined();
    const [event] = await waitForEvents((e) => e.action === 'DELETE /api/oidc/group-mappings/:id' && e.targetId === mappingId);
    expect(event?.detail).toMatchObject({ membershipsRemoved: 1 });
  });

  it('leaves alone a row that became a hand-made membership while it was waiting for the row', async () => {
    const project = await makeProject('race-manual');
    const group = `race-manual-${++seq}-staff`;
    const mappingId = await mapGroup(group, project.id, 'viewer');
    const account = await makeAccount('race-manual');
    expect(signedIn(await ssoSignIn(account, [group]))).toBe(true);
    expect((await membership(account.userId, project.id))?.origin).toBe('oidc_group');

    let deletePromise!: Promise<Response>;
    await database.db.transaction(async (tx) => {
      // Holds the row the way the members API does while it takes a membership over.
      await tx
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, account.userId), eq(projectMembers.projectId, project.id)))
        .for('update');
      deletePromise = asAdmin(live, 'DELETE', `/api/oidc/group-mappings/${mappingId}`);
      expect(await waitForLockWaiter(WAITING_ON_MEMBER_ROWS)).toBe(true);
      await tx
        .update(projectMembers)
        .set({ role: 'editor', origin: 'manual', oidcGroups: null })
        .where(and(eq(projectMembers.userId, account.userId), eq(projectMembers.projectId, project.id)));
    });

    expect((await deletePromise).status).toBe(204);
    expect(await membership(account.userId, project.id)).toMatchObject({ role: 'editor', origin: 'manual', oidcGroups: null });
    const [event] = await waitForEvents((e) => e.action === 'DELETE /api/oidc/group-mappings/:id' && e.targetId === mappingId);
    expect(event?.detail).toMatchObject({ membershipsUpdated: 0, membershipsRemoved: 0 });
  });
});
