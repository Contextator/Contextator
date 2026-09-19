import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  auditEvents,
  type AuditEventRow,
  documentSources,
  indexRuns,
  mcpTokens,
  projects,
  type ProjectRow,
  type UserRow,
} from '../../src/db/schema.js';
import { sweepAuditLog } from '../../src/services/audit.js';
import { registerOauthClient } from '../../src/services/auth/oauth.js';
import { createUser } from '../../src/services/auth/users.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * **Who changed this instance** ([ADR-0055](../../.ssot/ADR.md#adr-0055)) — the phase's claim, driven
 * through the real routes against a real PostgreSQL.
 *
 * Three acts are named in the acceptance criterion and all three are performed here as a signed-in
 * administrator would perform them: deleting a source, minting an MCP token, and changing a project's
 * MCP access mode. Nothing calls `recordAuditEvent`; nothing calls a service directly. The whole point
 * of the design is that no route asks to be recorded, so a test that asked for the recording would be
 * testing the wrong mechanism.
 *
 * `ctx.audit.settled()` is what makes this deterministic rather than a poll: the write starts in
 * Fastify's `onResponse`, after the reply has gone, so a test that asserted straight after the request
 * would be racing the insert. That method exists for `src/server.ts`'s shutdown first and for this
 * second, and both want the same guarantee — the process knows what it still owes.
 */

const baseUrl = inject('postgresBaseUrl');

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare.
`;

const PASSWORD = 'a-long-enough-password-1!';

let database: TestDatabase;
let live: LiveInstance;
let root: string;
/** The project the destructive acts are performed on; it does not survive this file. */
let project: ProjectRow;
let sourceId: string;
/** A second project, untouched, so the read and the scrape are not asserted against wreckage. */
let spare: ProjectRow;
let admin: UserRow;
let cookie: string;

/** Everything recorded, oldest first — the order a panel over this table would read it in. */
const events = async (): Promise<AuditEventRow[]> => database.db.select().from(auditEvents).orderBy(asc(auditEvents.createdAt));

const eventFor = async (action: string): Promise<AuditEventRow | undefined> => (await events()).find((row) => row.action === action);

/** The three actor columns as one value, so an assertion is about the whole attribution rather than a field. */
const actorOf = (row?: AuditEventRow) => (row ? { kind: row.actorKind, userId: row.actorUserId, label: row.actorLabel } : undefined);

/**
 * A request as the dashboard makes it: the session cookie, and the header the same-site check reads.
 * `src/auth/csrf.ts` refuses a cookie-authenticated unsafe method without one, so leaving it out here
 * would fail every write for a reason that has nothing to do with this entry.
 */
const asAdmin = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, body?: unknown) =>
  live.app.inject({
    method,
    url,
    headers: { cookie, 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { payload: body as object }),
  });

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'audit_log');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-audit-'));

  project = await seedProject(database.db, 'handbook', { path: 'handbook/guide.md', body: HANDBOOK });
  const [source] = await database.db.select().from(documentSources).where(eq(documentSources.projectId, project.id));
  sourceId = source.id;
  spare = await seedProject(database.db, 'handbook-spare', { path: 'handbook/guide.md', body: HANDBOOK });

  admin = await createUser(database.db, { username: 'dana', role: 'admin', password: PASSWORD });
  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });

  const signIn = await live.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'dana', password: PASSWORD },
  });
  expect(signIn.statusCode).toBe(200);
  cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  expect(cookie).toContain('contextator_session=');
  // The sign-in is itself an event, so the table is not empty before the first case runs.
  await live.ctx.audit.settled();
});

afterAll(async () => {
  await live?.close();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('the three acts the audit log exists for', () => {
  /**
   * The three acts, performed once as a signed-in administrator would perform them, and then asserted
   * one at a time. One `it` each rather than one loop: each of them is a separate claim in the phase's
   * acceptance criterion, and a single test covering all three would report one failure whether one
   * act went unrecorded or all of them did.
   *
   * The deletion goes last because it is the one that destroys what the others act on.
   */
  beforeAll(async () => {
    const minted = await asAdmin('POST', `/api/projects/${project.id}/mcp-tokens`, { name: 'CI' });
    expect(minted.statusCode).toBe(201);

    const switched = await asAdmin('PATCH', `/api/projects/${project.id}/mcp-auth`, { mode: 'account' });
    expect(switched.statusCode).toBe(200);

    const deleted = await asAdmin('DELETE', `/api/projects/${project.id}/sources/${sourceId}`);
    expect(deleted.statusCode).toBe(204);

    // Deterministic rather than a poll: the writes start in `onResponse`, after each reply has gone.
    await live.ctx.audit.settled();
  });

  it('records who minted an MCP token', async () => {
    const row = await eventFor('POST /api/projects/:id/mcp-tokens');
    expect(row).toBeDefined();
    expect(actorOf(row)).toEqual({ kind: 'user', userId: admin.id, label: 'dana' });
    expect(row?.projectId).toBe(project.id);
    expect(row?.statusCode).toBe(201);
  });

  it("records who changed a project's MCP access mode, and which way", async () => {
    const row = await eventFor('PATCH /api/projects/:id/mcp-auth');
    expect(row).toBeDefined();
    expect(actorOf(row)).toEqual({ kind: 'user', userId: admin.id, label: 'dana' });
    // The one fact a reader wants next, and the only body field this route may record.
    expect(row?.detail).toEqual({ mode: 'account' });
  });

  it('records who deleted a source, and which source it was', async () => {
    const row = await eventFor('DELETE /api/projects/:id/sources/:sid');
    expect(row).toBeDefined();
    expect(actorOf(row)).toEqual({ kind: 'user', userId: admin.id, label: 'dana' });
    // Taken from the path rather than from the body, which is what keeps this column free of content.
    expect(row?.targetType).toBe('sid');
    expect(row?.targetId).toBe(sourceId);
  });

  it('records them in the order they happened, and records nothing else', async () => {
    // **The field the whole table exists for.** Before this entry, `mcp_tokens.created_by` was the
    // only record of who did anything, and the other two acts left none at all.
    //
    // The sign-in leads the list, and it is there because it was taken *out* of the exemptions: a log
    // holding logouts and no sign-ins describes half a session, and `users.last_login_at` — the record
    // that exemption deferred to — is one column overwritten every time rather than a history.
    expect((await events()).map((row) => row.action)).toEqual([
      'POST /api/auth/login',
      'POST /api/projects/:id/mcp-tokens',
      'PATCH /api/projects/:id/mcp-auth',
      'DELETE /api/projects/:id/sources/:sid',
    ]);
    // And the sign-in names the account it created the session for, which is the actor no hook could
    // have resolved: `installAuth`'s identity pass ran before there was one.
    expect(actorOf(await eventFor('POST /api/auth/login'))).toEqual({ kind: 'user', userId: admin.id, label: 'dana' });
  });

  /**
   * **A creating route names nothing in its path**, so without reading the response back the row would
   * say a token was minted and not which — leaving "who minted this one" unanswerable and impossible
   * to line up against the `DELETE …/mcp-tokens/:tokenId` that does name one.
   */
  it('records which token was minted, not merely that one was', async () => {
    const row = await eventFor('POST /api/projects/:id/mcp-tokens');
    expect(row?.targetType).toBe('tokenId');
    // The id is real: it is the row `mcp_tokens` actually holds for this project.
    const [minted] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.projectId, project.id));
    expect(row?.targetId).toBe(minted.id);
    // And the secret that came back in the same response is nowhere in the event.
    expect(JSON.stringify(row)).not.toContain('ctxm_');
  });

  /**
   * **What is not recorded**, which is the half that keeps `public/pages/privacy.html` true.
   *
   * A search is a read, so it leaves no audit row — the query log is where a question goes, under its
   * own retention and its own per-project switch. If these two records were ever merged, the privacy
   * page would be describing one regime for two different kinds of data.
   */
  it('records nothing for a read, however privileged, and nothing a refused request asked for', async () => {
    const before = (await events()).length;

    const search = await asAdmin('GET', `/api/projects/${spare.id}/search?q=install+the+package`);
    expect(search.statusCode).toBe(200);

    // Refused: no credential at all, and a body that would have been a detail if it had succeeded.
    const anonymous = await live.app.inject({
      method: 'PATCH',
      url: `/api/projects/${spare.id}/mcp-auth`,
      payload: { mode: 'open' },
    });
    expect(anonymous.statusCode).toBe(401);

    // Refused differently: signed in, but the project does not exist, so nothing changed.
    const missing = await asAdmin('DELETE', '/api/projects/00000000-0000-4000-8000-000000000000/sources/11111111-1111-4111-8111-111111111111');
    expect(missing.statusCode).toBe(404);

    await live.ctx.audit.settled();
    expect((await events()).length).toBe(before);
  });

  /**
   * The row cannot be anonymous, and the database is where that is enforced rather than only the
   * writer. `src/services/audit.ts` derives the actor from the principal so no call site can omit it;
   * these three statements are the second lock, for a backfill, a panel or a migration written later.
   */
  it('refuses an actorless row at the database, not only at the writer', async () => {
    const insert = (columns: string, values: string) =>
      database.db.execute(sql.raw(`INSERT INTO audit_events (action, status_code, ${columns}) VALUES ('POST /api/anything', 200, ${values})`));

    // No label at all.
    await expect(insert('actor_kind', `'user'`)).rejects.toThrow();
    // A label that is only whitespace, which is the way an empty actor usually arrives.
    await expect(insert('actor_kind, actor_label', `'user', '   '`)).rejects.toThrow();
    // A kind outside the two that exist.
    await expect(insert('actor_kind, actor_label', `'nobody', 'someone'`)).rejects.toThrow();
    // Machine access carrying an account id, which would attribute ADMIN_TOKEN to a person.
    await expect(insert('actor_kind, actor_label, actor_user_id', `'token', 'ADMIN_TOKEN', '${admin.id}'`)).rejects.toThrow();
  });

  /**
   * The one deletion an audit log has to survive. `actor_user_id` is `ON DELETE SET NULL` and the
   * label was copied at the time, so removing the account leaves the deed attributed — and
   * `project_id` carries no foreign key at all, which is why the row about deleting a project is not
   * deleted by it.
   */
  it('keeps the record when the account that acted is deleted, and when the project is', async () => {
    const [victim] = await database.db
      .insert(auditEvents)
      .values({
        action: 'DELETE /api/projects/:id',
        actorKind: 'user',
        actorUserId: admin.id,
        actorLabel: 'dana',
        projectId: project.id,
        statusCode: 204,
      })
      .returning();

    await database.db.delete(projects).where(eq(projects.id, project.id));
    const [afterProject] = await database.db.select().from(auditEvents).where(eq(auditEvents.id, victim.id));
    expect(afterProject.projectId).toBe(project.id);

    const ghost = await createUser(database.db, { username: 'erol', role: 'admin', password: PASSWORD });
    const [byGhost] = await database.db
      .insert(auditEvents)
      .values({ action: 'POST /api/projects', actorKind: 'user', actorUserId: ghost.id, actorLabel: 'erol', statusCode: 201 })
      .returning();
    await database.db.execute(sql`DELETE FROM users WHERE id = ${ghost.id}`);

    const [afterUser] = await database.db.select().from(auditEvents).where(eq(auditEvents.id, byGhost.id));
    expect(afterUser.actorUserId).toBeNull();
    // The name is still there, which is the whole reason it is a column and not a join.
    expect(afterUser.actorLabel).toBe('erol');
  });
});

/**
 * **The OAuth approval is the same class of act, on a surface the admin plugin's hooks cannot reach**
 * ([ADR-0055](../../.ssot/ADR.md#adr-0055)). A person granting a client lasting read access to one
 * project is `PATCH /api/projects/:id/mcp-auth` wearing different clothes, and it is the moment
 * [ADR-0054](../../.ssot/ADR.md#adr-0054)'s credential-that-names-a-person comes into existence.
 *
 * So the audit hooks are installed on `oauthRoutes` as well, and this drives the real route.
 */
describe('approving a connector', () => {
  const CHALLENGE = 'a'.repeat(43);
  const REDIRECT = 'https://connector.example/callback';

  /**
   * Over a real socket, and that is not a preference: `resource` has to name an MCP endpoint of *this*
   * instance, which the route checks against the request's own host — so a request that did not
   * actually arrive at this port cannot carry a resource this server will accept.
   */
  const decide = async (decision: 'approve' | 'deny', clientId: string, site = 'same-origin') =>
    fetch(`${live.origin}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'sec-fetch-site': site, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        state: 'a-state',
        resource: `${live.origin}/mcp/${spare.name}`,
        decision,
      }),
    });

  it('records who approved which client, on which project, and which way they decided', async () => {
    const client = await registerOauthClient(database.db, { name: 'A browser connector', redirectUris: [REDIRECT], maxClients: 50 });
    const res = await decide('approve', client.clientId);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('code=');

    await live.ctx.audit.settled();
    const row = await eventFor('POST /oauth/authorize');
    expect(row).toBeDefined();
    expect(actorOf(row)).toEqual({ kind: 'user', userId: admin.id, label: 'dana' });
    // The project the grant reaches, which the route template does not carry: /oauth/authorize is not
    // project-scoped, and the row would otherwise say a grant was made and not what over.
    expect(row?.projectId).toBe(spare.id);
    expect(row?.detail).toEqual({ decision: 'approve' });
    // The client id, the redirect URI and the state are all in the body and none of them is in the
    // row: `decision` is the only field this route is allowed to record.
    expect(JSON.stringify(row)).not.toContain(client.clientId);
    expect(JSON.stringify(row)).not.toContain('connector.example');
  });

  it('records a refusal as the person refusing, which is the one refusal this table holds', async () => {
    const client = await registerOauthClient(database.db, { name: 'Another connector', redirectUris: [REDIRECT], maxClients: 50 });
    const before = (await events()).length;
    const res = await decide('deny', client.clientId);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=access_denied');

    await live.ctx.audit.settled();
    const rows = await events();
    expect(rows.length).toBe(before + 1);
    // Every other refusal in this product is the permission matrix declining and is not recorded.
    // This one is a person deciding, which is exactly what the table is for.
    expect(rows.at(-1)?.detail).toEqual({ decision: 'deny' });
  });

  it('records nothing for a request that never became a decision', async () => {
    const before = (await events()).length;
    // An unknown client is refused in place, before the person could decide anything.
    const unknown = await decide('approve', 'ctxc_0000000000000000');
    expect(unknown.status).toBe(400);
    // And an approval that did not come from this site is refused by the same-site check, which is the
    // guard that stops a foreign page approving a connector on behalf of whoever is signed in.
    const foreign = await decide('approve', 'ctxc_0000000000000000', 'cross-site');
    expect(foreign.status).toBe(403);

    await live.ctx.audit.settled();
    expect((await events()).length).toBe(before);
  });
});

/**
 * Retention, shaped exactly like the query log's sweep test — a backdated row, one statement, and the
 * boundary asserted so that the window is a window and not a rounding. The value differs (a year
 * against thirty days) and the mechanism is deliberately the same.
 */
describe('retention', () => {
  it('deletes what is past the window and nothing else', async () => {
    const [old] = await database.db
      .insert(auditEvents)
      .values({ action: 'POST /api/projects/:id/reindex', actorKind: 'token', actorLabel: 'ADMIN_TOKEN', statusCode: 202 })
      .returning();
    const [recent] = await database.db
      .insert(auditEvents)
      .values({ action: 'POST /api/projects/:id/reindex', actorKind: 'token', actorLabel: 'ADMIN_TOKEN', statusCode: 202 })
      .returning();

    // Backdated in the database rather than by faking a clock: the sweep compares against `now()` in
    // SQL, which is the property that keeps the window immune to the process's clock.
    await database.db.update(auditEvents).set({ createdAt: sql`now() - interval '366 days'` }).where(eq(auditEvents.id, old.id));

    const before = (await events()).length;
    expect(await sweepAuditLog(database.db, 365)).toBe(1);

    const after = await events();
    expect(after.length).toBe(before - 1);
    expect(after.map((row) => row.id)).not.toContain(old.id);
    expect(after.map((row) => row.id)).toContain(recent.id);

    // A second pass deletes nothing: everything left is inside the window.
    expect(await sweepAuditLog(database.db, 365)).toBe(0);
  });
});

/**
 * `/metrics` ([ADR-0055](../../.ssot/ADR.md#adr-0055)) against the live instance, for the four things
 * the acceptance criterion names. `test/metrics.test.ts` asserts the format against a snapshot; this
 * asserts that the numbers come from the running server — the pool gauges from the pool this database
 * opened, the last run from a row, the search counter from a search that really went through the route.
 */
describe('the metrics endpoint of a running instance', () => {
  it('answers Prometheus text carrying the queue, the last run, the searches and the pool', async () => {
    const finishedAt = new Date();
    await database.db.insert(indexRuns).values({
      projectId: spare.id,
      mode: 'incremental',
      status: 'done',
      startedAt: new Date(finishedAt.getTime() - 4_000),
      finishedAt,
      durationMs: 4_000,
      trigger: 'manual',
    });

    const searched = await asAdmin('GET', `/api/projects/${spare.id}/search?q=install+the+package`);
    expect(searched.statusCode).toBe(200);

    // Over a real socket rather than through `inject`, because the acceptance criterion is about what
    // `curl localhost:3444/metrics` answers: this instance listens on an ephemeral port, so the scrape
    // goes through the HTTP stack a Prometheus server would use.
    const res = await fetch(`${live.origin}/metrics`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const body = await res.text();
    // The first line a `| head` would show, so the format claim is about the top of the output too.
    expect(body.split('\n')[0]).toMatch(/^# HELP contextator_/);

    expect(body).toContain('contextator_index_queue_depth{lane="interactive"} 0');
    expect(body).toContain('contextator_index_queue_depth{lane="scheduled"} 0');
    expect(body).toContain('contextator_last_index_run_ok 1');
    expect(body).toContain(`contextator_last_index_run_timestamp_seconds ${Math.round(finishedAt.getTime() / 1000)}`);
    expect(body).toContain('contextator_last_index_run_duration_seconds 4');
    // The counter moved because a search went through the route, not because a test incremented it.
    expect(body).toMatch(/contextator_searches_total\{actor="dashboard"\} [1-9]\d*/);
    expect(body).toContain('contextator_db_up 1');
    // The pool this test database opened. `total` is at least one, because this scrape used it.
    expect(body).toMatch(/contextator_db_pool_connections\{state="total"\} [1-9]\d*/);
    expect(body).toContain('contextator_db_pool_connections{state="waiting"} 0');
    // And the audit counter, which is the only way "an event could not be written" is visible at all.
    expect(body).toMatch(/contextator_audit_events_total\{outcome="written"\} [1-9]\d*/);
    expect(body).toContain('contextator_audit_events_total{outcome="failed"} 0');
  });

  it('refuses a scrape that holds nothing', async () => {
    const res = await fetch(`${live.origin}/metrics`);
    expect(res.status).toBe(401);
  });
});
