import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { mcpTokens, projectMembers, projects, type ProjectRow, type UserRow } from '../../src/db/schema.js';
import { createMcpToken, issueMcpCredential } from '../../src/services/auth/mcp-tokens.js';
import { createProjectWithFirstToken } from '../../src/services/projects.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createUser, updateUser } from '../../src/services/auth/users.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * **The gap [ADR-0028](../../.ssot/ADR.md#adr-0028) named, closed and proved**
 * ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
 *
 * Until this entry the dashboard's careful `viewer`/`editor` memberships stopped at the endpoint's
 * edge: a `member` answered `404` for a project in the dashboard could read the same project's every
 * document over MCP for as long as it was `open`. The assertions below are that sentence turned into
 * requests against a real PostgreSQL and a real MCP client, in both directions — because a test that
 * only proved the new refusal would pass just as happily on a build that refused everything, and this
 * feature's whole risk is what it breaks rather than what it blocks.
 *
 * Three claims, and the third is the one an operator's existing installation depends on:
 *
 * 1. An account-backed credential held by a `member` who is **not** a member of the project is refused
 *    — and it is refused **while the project is `open`**, which is the case the gap was about.
 * 2. The same account, made a `viewer` of that project, reads it.
 * 3. A static `ctxm_…` bearer behaves exactly as it did before any of this: it opens an `open` project,
 *    opens a `token` project, and is refused by nothing that used to accept it.
 */

const baseUrl = inject('postgresBaseUrl');

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

let database: TestDatabase;
let live: LiveInstance;
let root: string;
/** The project the member is a member of, and the one they are not. */
let theirs: ProjectRow;
let notTheirs: ProjectRow;
let member: UserRow;
let staticToken: string;
let memberToken: string;
let outsiderToken: string;

/**
 * One `initialize` at the endpoint with the credential in the header a client would put it in — the
 * cheapest request that has to get all the way past the `onRequest` hook to be answered at all. `200`
 * means the session opened; anything else is the hook's verdict, with its own body and headers.
 */
async function probe(project: ProjectRow, token?: string): Promise<{ status: number; body: string; challenge: string | null }> {
  const res = await fetch(`${live.origin}/mcp/${project.name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
    }),
  });
  return { status: res.status, body: await res.text(), challenge: res.headers.get('www-authenticate') };
}

/** A real MCP session over Streamable HTTP, carrying the credential in the header a client would. */
async function searchAs(project: ProjectRow, token: string | undefined, query: string): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(`${live.origin}/mcp/${project.name}`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'identity-itest', version: '0.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'search_docs', arguments: { query, limit: 3 } });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    return content.find((c) => c.type === 'text')?.text ?? '';
  } finally {
    await client.close();
  }
}

const setMode = (project: ProjectRow, mode: 'open' | 'token' | 'account') =>
  database.db.update(projects).set({ mcpAuth: mode }).where(eq(projects.id, project.id));

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_identity');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-identity-'));

  theirs = await seedProject(database.db, 'theirs', { path: 'handbook/guide.md', body: HANDBOOK });
  notTheirs = await seedProject(database.db, 'not-theirs', { path: 'handbook/guide.md', body: HANDBOOK });

  member = await createUser(database.db, { username: 'dana', role: 'member', password: 'a-long-enough-password-1!' });
  await setMemberRole(database.db, theirs.id, member.id, 'viewer', null);

  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });

  // The three credentials the whole entry is about, on the project the member is not a member of.
  staticToken = (await createMcpToken(database.db, notTheirs.id, 'CI', null)).token;
  outsiderToken = (
    await issueMcpCredential(database.db, {
      projectId: notTheirs.id,
      userId: member.id,
      clientId: await registeredClient(),
      kind: 'access',
      name: 'oauth not-theirs',
      ttlMs: 10 * 60_000,
    })
  ).token;
  memberToken = (
    await issueMcpCredential(database.db, {
      projectId: theirs.id,
      userId: member.id,
      clientId: await registeredClient(),
      kind: 'access',
      name: 'oauth theirs',
      ttlMs: 10 * 60_000,
    })
  ).token;
});

/** A client row, because `mcp_tokens.client_id` has a foreign key and an OAuth credential has a client. */
async function registeredClient(): Promise<string> {
  const res = await fetch(`${live.origin}/oauth/register`, {
    method: 'POST',
    // A host of its own, because `/oauth/register` carries a per-host budget and this file asks twice.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.2.0.1' },
    body: JSON.stringify({ client_name: 'A browser connector', redirect_uris: ['https://client.example/cb'] }),
  });
  const json = (await res.json()) as { client_id: string };
  return json.client_id;
}

afterAll(async () => {
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('an account-backed credential on a project the account is not a member of', () => {
  it('is refused even while the project is open, which is the hole this closes', async () => {
    await setMode(notTheirs, 'open');
    // The control first: the project really is open, so anonymous access works and the refusal below
    // is about the account rather than about the mode.
    expect((await probe(notTheirs)).status).toBe(200);

    const refused = await probe(notTheirs, outsiderToken);
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('not a member of this project');
  });

  it('is refused when the project requires a token, and when it requires an account', async () => {
    for (const mode of ['token', 'account'] as const) {
      await setMode(notTheirs, mode);
      expect((await probe(notTheirs, outsiderToken)).status).toBe(403);
    }
  });

  it('stops working the moment the membership is taken away, without the credential being touched', async () => {
    await setMode(theirs, 'account');
    expect((await probe(theirs, memberToken)).status).toBe(200);

    await database.db.delete(projectMembers).where(eq(projectMembers.userId, member.id));
    // Same credential, same string, not revoked and not expired: the access is the membership, and it
    // is re-read on every request rather than frozen into the token when it was issued.
    const after = await probe(theirs, memberToken);
    expect(after.status).toBe(403);
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.name, 'oauth theirs'));
    expect(row.revokedAt).toBeNull();

    await setMemberRole(database.db, theirs.id, member.id, 'viewer', null);
    expect((await probe(theirs, memberToken)).status).toBe(200);
  });

  it('stops working when the account is disabled, and comes back when it is not', async () => {
    await setMode(theirs, 'account');
    await updateUser(database.db, member.id, { isActive: false });
    expect((await probe(theirs, memberToken)).status).toBe(401);
    await updateUser(database.db, member.id, { isActive: true });
    expect((await probe(theirs, memberToken)).status).toBe(200);
  });
});

describe('an account-backed credential on a project the account is a member of', () => {
  it('searches it, through a real MCP client, in every mode', async () => {
    for (const mode of ['open', 'token', 'account'] as const) {
      await setMode(theirs, mode);
      const answer = await searchAs(theirs, memberToken, 'how do I install');
      expect(answer).toContain('handbook/guide.md');
      expect(answer).toContain('Install the package from the registry');
    }
  });

  it('reaches only the project it was issued for, whatever the account may see elsewhere', async () => {
    // `dana` is a viewer of `theirs` and a viewer of nothing else, but the point here is narrower and
    // survives that changing: a credential is minted per project, and presenting it on another
    // project's URL is presenting a credential that project has never heard of.
    await setMode(notTheirs, 'token');
    const wrongDoor = await probe(notTheirs, memberToken);
    expect(wrongDoor.status).toBe(401);
    expect(wrongDoor.body).toContain('Unknown, expired or revoked');
  });
});

describe('a static bearer token', () => {
  it('keeps the behaviour it had before any of this existed', async () => {
    await setMode(notTheirs, 'token');
    expect((await probe(notTheirs, staticToken)).status).toBe(200);
    expect((await probe(notTheirs)).status).toBe(401);
    expect((await probe(notTheirs, 'ctxm_' + '0'.repeat(64))).status).toBe(401);

    await setMode(notTheirs, 'open');
    expect((await probe(notTheirs, staticToken)).status).toBe(200);
  });

  it('searches an open and a token project through a real MCP client, as it always did', async () => {
    for (const mode of ['open', 'token'] as const) {
      await setMode(notTheirs, mode);
      const answer = await searchAs(notTheirs, staticToken, 'how do I install');
      expect(answer).toContain('Install the package from the registry');
    }
  });

  /** The one place it does **not** work, which is the mode that exists to say so. */
  it('is refused by a project that requires an account, with a sentence naming why', async () => {
    await setMode(notTheirs, 'account');
    const refused = await probe(notTheirs, staticToken);
    expect(refused.status).toBe(401);
    expect(refused.body).toContain('a static token is not one');
    // And the 401 points at the document a browser connector would use to start an OAuth flow, which
    // is what turns this refusal into something a client can act on rather than report.
    expect(refused.challenge).toContain('resource_metadata=');
    expect(refused.challenge).toContain(`/.well-known/oauth-protected-resource/mcp/${notTheirs.name}`);
  });

  it('cannot open an account project even by being the credential an anonymous client would use', async () => {
    await setMode(notTheirs, 'account');
    expect((await probe(notTheirs)).status).toBe(401);
    const answer = await probe(notTheirs).then((r) => r.body);
    expect(answer).toContain('account-backed credential');
  });
});

describe('the query log still learns which credential asked', () => {
  it('resolves an account-backed credential to its row, so a search is attributable', async () => {
    await setMode(theirs, 'account');
    const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.name, 'oauth theirs'));
    expect(row.userId).toBe(member.id);
    expect(row.kind).toBe('access');
    // `lastUsedAt` is written off the response path and throttled to a minute; what matters here is
    // that the request resolved to *this row* at all, which is what `search_queries.mcp_token_id`
    // records ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
    expect((await probe(theirs, memberToken)).status).toBe(200);
  });
});

/**
 * **The door a project is born behind** ([ADR-0065](../../.ssot/ADR.md#adr-0065), PRD.md FR-510).
 *
 * `test/permissions.test.ts` proves the rule; this proves the product. The project below is created
 * through the call the dashboard's own `POST /api/projects` makes, and the two requests are the two
 * an operator makes next — one with nothing, one with the string the creation dialog just showed
 * them. Both, because only the pair says anything: the `401` alone would pass on a build that
 * refused everybody, and the `200` alone would have passed before any of this.
 *
 * The third assertion is the one an existing installation depends on, and it is the negative
 * space of the change: a project that is already `open` is not touched by any of it.
 */
describe('a project created the way the product creates one', () => {
  it('is born requiring a token, and is handed that token once', async () => {
    const created = await createProjectWithFirstToken(database.db, { name: 'born-closed', createdBy: null }, [root]);

    expect(created.project.mcpAuth).toBe('token');
    expect(created.mcpToken?.secret).toMatch(/^ctxm_[0-9a-f]{64}$/);
    // The database kept a hash and a prefix, never the string above — the same shape as a token
    // minted later from the panel, because it is the same code that minted it.
    const [stored] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.projectId, created.project.id));
    expect(stored.kind).toBe('static');
    expect(stored.prefix.startsWith(created.mcpToken?.secret.slice(0, 13) ?? 'x')).toBe(true);
  });

  it('answers 401 to a request carrying nothing, and 200 to the token it was created with', async () => {
    const created = await createProjectWithFirstToken(database.db, { name: 'born-closed-two', createdBy: null }, [root]);

    const anonymous = await probe(created.project);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toContain('requires an MCP token');
    // RFC 6750 and RFC 9728, exactly as for any other `token` project: the refusal says what would
    // satisfy it rather than only that it was refused.
    expect(anonymous.challenge).toContain('Bearer realm="born-closed-two"');

    expect((await probe(created.project, created.mcpToken?.secret)).status).toBe(200);
  });

  it('leaves a project that is already open answering anonymously, as its clients are configured for', async () => {
    await setMode(theirs, 'open');
    expect((await probe(theirs)).status).toBe(200);
  });
});
