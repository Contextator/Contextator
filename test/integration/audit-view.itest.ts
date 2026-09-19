import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PHRASED_ACTIONS } from '../../src/admin/audit-routes.js';
import { type ProjectRow, type UserRow, documentSources } from '../../src/db/schema.js';
import { createUser } from '../../src/services/auth/users.js';
import { type LiveInstance, seedProject, startMcpInstance } from './support/mcp-instance.js';
import { type TestDatabase, applySchema, createTestDatabase, dropTestDatabase } from './support/postgres.js';

/**
 * **Reading the audit log** ([ADR-0055](../../.ssot/ADR.md#adr-0055)) — `GET /api/audit` against a real
 * PostgreSQL, over rows written by real requests.
 *
 * `test/audit.itest.ts` proves the writing; `test/audit-view.test.ts` proves the sentence and the
 * cursor arithmetic with no database in them. What is left, and what only a database can answer, is the
 * half this file is: that the filters are **SQL** rather than a narrowing the browser does after
 * downloading the table, that the keyset page is a position and not an offset, and that the two rows an
 * operator most needs — an action on a project that has since been deleted, and an action by an account
 * that has since been deleted — survive the deletion and say what they are.
 *
 * Every row asserted here was written by the policy layer in response to a request made through
 * `app.inject`. Nothing in this file inserts into `audit_events`.
 */

const baseUrl = inject('postgresBaseUrl');

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else.
`;

const PASSWORD = 'a-long-enough-password-1!';

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let kept: ProjectRow;
/** Created, acted on, then deleted — the rows about it must outlive it. */
let doomed: ProjectRow;
let admin: UserRow;
let cookie: string;
/** An admin who acts and is then deleted; `actor_user_id` is `ON DELETE SET NULL`. */
let departed: UserRow;

interface AuditPage {
  events: Array<{
    id: string;
    createdAt: string;
    action: string;
    summary: string;
    actor: { kind: string; label: string; userId: string | null; accountGone: boolean };
    project: { id: string; name: string | null } | null;
    target: { type: string; id: string } | null;
    statusCode: number;
  }>;
  nextCursor: string | null;
  filters: {
    actors: Array<{ label: string }>;
    actions: Array<{ action: string; summary: string }>;
    projects: Array<{ id: string; name: string | null }>;
  } | null;
  retentionDays: number;
}

const request = (who: string, method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, body?: unknown) =>
  live.app.inject({
    method,
    url,
    headers: { cookie: who, 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { payload: body as object }),
  });

async function signIn(username: string): Promise<string> {
  const res = await live.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  expect(res.statusCode, `${username} could not sign in`).toBe(200);
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function read(query: string): Promise<AuditPage> {
  const res = await request(cookie, 'GET', `/api/audit?${query}`);
  expect(res.statusCode, `GET /api/audit?${query} answered ${res.statusCode}: ${res.body}`).toBe(200);
  return res.json() as AuditPage;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'audit_view');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-audit-view-'));

  kept = await seedProject(database.db, 'handbook', { path: 'handbook/guide.md', body: HANDBOOK });
  doomed = await seedProject(database.db, 'retired-wiki', { path: 'wiki/index.md', body: HANDBOOK });
  admin = await createUser(database.db, { username: 'dana', role: 'admin', password: PASSWORD });
  departed = await createUser(database.db, { username: 'kerem', role: 'admin', password: PASSWORD });

  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  cookie = await signIn('dana');
  const other = await signIn('kerem');

  // Twelve recorded acts, made the way the dashboard makes them. Enough that a page of five leaves
  // two more pages behind it, which is what the cursor has to be asserted over.
  const [source] = await database.db.select().from(documentSources).where(eq(documentSources.projectId, kept.id));
  for (let i = 0; i < 6; i++) {
    expect((await request(cookie, 'POST', `/api/projects/${kept.id}/mcp-tokens`, { name: `CI-${i}` })).statusCode).toBe(201);
  }
  expect((await request(cookie, 'PATCH', `/api/projects/${kept.id}/mcp-auth`, { mode: 'account' })).statusCode).toBe(200);
  expect((await request(cookie, 'DELETE', `/api/projects/${kept.id}/sources/${source.id}`)).statusCode).toBe(204);

  // kerem acts on the project that is about to go, and is then deleted himself.
  expect((await request(other, 'PATCH', `/api/projects/${doomed.id}/mcp-auth`, { mode: 'token' })).statusCode).toBe(200);
  expect((await request(other, 'POST', `/api/projects/${doomed.id}/mcp-tokens`, { name: 'wiki' })).statusCode).toBe(201);
  const del = await request(cookie, 'DELETE', `/api/projects/${doomed.id}`);
  expect(del.statusCode, del.body).toBe(204);
  expect((await request(cookie, 'DELETE', `/api/users/${departed.id}`)).statusCode).toBe(204);

  // Deterministic rather than a poll: every write starts in `onResponse`, after the reply has gone.
  await live.ctx.audit.settled();
});

afterAll(async () => {
  await live?.close();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('who may read the audit log', () => {
  it('answers an admin, refuses a member, and refuses a caller holding nothing', async () => {
    const member = await createUser(database.db, { username: 'mert', role: 'member', password: PASSWORD });
    expect(member.role).toBe('member');
    const asMember = await signIn('mert');

    expect((await request(cookie, 'GET', '/api/audit?limit=5')).statusCode).toBe(200);
    expect((await request(asMember, 'GET', '/api/audit?limit=5')).statusCode).toBe(403);
    expect((await live.app.inject({ method: 'GET', url: '/api/audit?limit=5' })).statusCode).toBe(401);
  });

  it('is not itself an event, so reading the log does not write to it', async () => {
    const before = (await read('limit=200')).events.length;
    await read('limit=200');
    await live.ctx.audit.settled();
    expect((await read('limit=200')).events.length).toBe(before);
  });
});

describe('what a page says about rows that outlived what they name', () => {
  it('keeps a deleted project’s rows and says the name can no longer be looked up', async () => {
    const page = await read(`limit=200&project=${doomed.id}`);
    expect(page.events.length).toBeGreaterThanOrEqual(3);
    for (const event of page.events) {
      expect(event.project).toEqual({ id: doomed.id, name: null });
    }
    // Including the deletion itself, which is the row a foreign key would have refused or erased.
    const deletion = page.events.find((e) => e.action === 'DELETE /api/projects/:id');
    expect(deletion?.summary).toBe(`dana deleted the project ${doomed.id.slice(0, 8)}… (no longer exists)`);
  });

  it('still names an actor whose account has been deleted', async () => {
    const page = await read('limit=200&actor=kerem');
    expect(page.events.length).toBeGreaterThanOrEqual(2);
    for (const event of page.events) {
      // The label is copied onto the row; the id is `ON DELETE SET NULL`, which is the whole point.
      expect(event.actor.label).toBe('kerem');
      expect(event.actor.userId).toBeNull();
      expect(event.actor.accountGone).toBe(true);
    }

    // The contrast, so the assertion above is about a deletion rather than about nothing being set.
    const living = await read('limit=200&actor=dana');
    expect(living.events.length).toBeGreaterThan(0);
    for (const event of living.events) {
      expect(event.actor.userId).toBe(admin.id);
      expect(event.actor.accountGone).toBe(false);
    }
  });

  it('offers a deleted project in the picker, so its events can still be reached', async () => {
    const page = await read('limit=1');
    expect(page.filters?.projects).toContainEqual({ id: doomed.id, name: null });
    expect(page.filters?.projects).toContainEqual({ id: kept.id, name: 'handbook' });
  });
});

describe('the filters, which are SQL and not the browser', () => {
  it('narrows by actor', async () => {
    const all = await read('limit=200');
    const mine = await read('limit=200&actor=dana');
    expect(mine.events.length).toBeLessThan(all.events.length);
    expect(new Set(mine.events.map((e) => e.actor.label))).toEqual(new Set(['dana']));
  });

  it('narrows by action', async () => {
    const all = await read('limit=200');
    const page = await read('limit=200&action=POST%20%2Fapi%2Fprojects%2F%3Aid%2Fmcp-tokens');
    // Counted from the unfiltered page rather than written down here: a number in this file would
    // only say what the seeding does, where this says the server narrowed to exactly the right rows.
    const expected = all.events.filter((e) => e.action === 'POST /api/projects/:id/mcp-tokens');
    expect(expected.length).toBeGreaterThan(4);
    expect(page.events.map((e) => e.id)).toEqual(expected.map((e) => e.id));
    expect(page.events.length).toBeLessThan(all.events.length);
  });

  it('narrows by project, and `none` means the events that belong to none', async () => {
    const onKept = await read(`limit=200&project=${kept.id}`);
    expect(new Set(onKept.events.map((e) => e.project?.id))).toEqual(new Set([kept.id]));

    const instanceWide = await read('limit=200&project=none');
    expect(instanceWide.events.length).toBeGreaterThan(0);
    for (const event of instanceWide.events) expect(event.project).toBeNull();
    // Deleting an account is instance-wide; it must be in here and not in the project pages above.
    expect(instanceWide.events.some((e) => e.action === 'DELETE /api/users/:id')).toBe(true);
    expect(onKept.events.some((e) => e.action === 'DELETE /api/users/:id')).toBe(false);
  });

  it('narrows by a UTC day range that includes the day typed into both boxes', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const all = await read('limit=200');
    const sameDay = await read(`limit=200&from=${today}&to=${today}`);
    expect(sameDay.events.length).toBe(all.events.length);

    // A window that ended yesterday holds nothing this suite wrote.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await read(`limit=200&from=2020-01-01&to=${yesterday}`)).events).toHaveLength(0);
  });

  it('refuses a limit past the cap, a date that is not one, and a cursor it did not produce', async () => {
    for (const query of ['limit=1000', 'from=19-09-2026', 'cursor=nonsense']) {
      expect((await request(cookie, 'GET', `/api/audit?${query}`)).statusCode, query).toBe(400);
    }
  });
});

describe('the keyset page', () => {
  it('walks the whole log without repeating or skipping a row, newest first', async () => {
    const whole = await read('limit=200');
    expect(whole.events.length).toBeGreaterThan(10);
    const times = whole.events.map((e) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const next: AuditPage = await read(`limit=5${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      walked.push(...next.events.map((e) => e.id));
      // The pickers ride with the first page only; paging must not re-run three DISTINCT scans.
      expect(next.filters === null, `page ${page} carried filters`).toBe(page > 0);
      cursor = next.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(whole.events.map((e) => e.id));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('keeps the filter while paging, so page two is still the filter’s rows', async () => {
    const filter = 'action=POST%20%2Fapi%2Fprojects%2F%3Aid%2Fmcp-tokens';
    const whole = await read(`limit=200&${filter}`);
    expect(whole.events.length).toBeGreaterThan(4);

    const first = await read(`limit=4&${filter}`);
    expect(first.events).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();

    const second = await read(`limit=4&${filter}&cursor=${encodeURIComponent(first.nextCursor ?? '')}`);
    expect(second.events).toHaveLength(whole.events.length - 4);
    expect(new Set(second.events.map((e) => e.action))).toEqual(new Set(['POST /api/projects/:id/mcp-tokens']));
    expect(second.nextCursor).toBeNull();
    // The two pages are the filtered set, in order — not a re-count that a new row could shift.
    expect([...first.events, ...second.events].map((e) => e.id)).toEqual(whole.events.map((e) => e.id));
  });
});

/**
 * The half `test/audit-view.test.ts` cannot assert: `auditSubject()` answers for any unsafe `/api/*`
 * template, whether or not a route of that name was ever registered — so a phrase keyed on a template
 * with a typo in it passes there and is rendered for nothing. Here there is a built application to ask.
 */
describe('the phrase table against the routes that exist', () => {
  it('has a phrase only for routes this application actually registers', () => {
    for (const action of PHRASED_ACTIONS) {
      const [method, url] = action.split(' ');
      expect(live.app.hasRoute({ method: method as 'GET', url }), `${action} is not a route this application registers`).toBe(true);
    }
  });
});
