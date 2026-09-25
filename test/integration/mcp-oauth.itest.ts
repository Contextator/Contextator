import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { mcpTokens, oauthClients, projects, type ProjectRow, type UserRow } from '../../src/db/schema.js';
import {
  findSpentRefreshToken,
  issueMcpCredential,
  revokeMcpCredentialsOfGrant,
  revokeMcpTokenById,
  verifyRefreshToken,
  withRotationTransaction,
} from '../../src/services/auth/mcp-tokens.js';
import { removeMember, setMemberRole } from '../../src/services/auth/memberships.js';
import { ClientLimitError, registerOauthClient, sweepStaleOauthClients } from '../../src/services/auth/oauth.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { createUser } from '../../src/services/auth/users.js';
import { OAUTH_REGISTER_MAX_PER_HOST } from '../../src/config.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * **A browser-based MCP client connecting over OAuth 2.1 and calling `search_docs`**
 * ([ADR-0054](../../.ssot/ADR.md#adr-0054)) — the first half of what that entry is for, end to end
 * against a real PostgreSQL.
 *
 * **The client half is the SDK's own**, deliberately: discovery, dynamic registration, the PKCE
 * challenge, the authorization URL and the token exchange are all
 * `@modelcontextprotocol/sdk/client/auth.js`, never assertions written against our own idea of the
 * protocol. A test that posted hand-built requests at these endpoints would prove they answer, and
 * prove nothing at all about whether a real connector can talk to them. What this file supplies is the
 * one part a connector gets from a human: the browser that visits the authorization URL, signs in, and
 * presses Allow.
 */

const baseUrl = inject('postgresBaseUrl');

const HANDBOOK = `# Delivery guide

## Install

Install the package from the registry before anything else. The container listens on one port.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

const REDIRECT_URI = 'http://127.0.0.1:61999/callback';
const OLD_PASSWORD = 'a-long-enough-password-1!';

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let project: ProjectRow;
let member: UserRow;
let sessionToken: string;

/** The connector's side of the flow, held in memory the way a desktop client holds it on disk. */
class TestClientProvider implements OAuthClientProvider {
  private client: OAuthClientInformationFull | undefined;
  private verifier = '';
  private saved: OAuthTokens | undefined;
  /** Where the SDK wanted to send the user agent. The browser step below starts from this. */
  authorizationUrl: URL | undefined;

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'A browser connector',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(info: OAuthClientInformationFull) {
    this.client = info;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }
}

const cookieHeader = () => `${SESSION_COOKIE}=${sessionToken}`;

/**
 * The human step, performed by a script: open the authorization URL signed in, read the form the
 * server rendered, and submit it. It reads the hidden fields back out of the page rather than
 * re-deriving them, because what the page carries is exactly what the server will re-validate.
 */
async function approveInBrowser(
  url: URL,
  opts: { cookie?: string; decision?: 'approve' | 'deny'; sameSite?: string; beforeSubmit?: () => Promise<void> } = {},
): Promise<Response> {
  const cookie = opts.cookie ?? cookieHeader();
  const page = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`The consent page answered ${page.status}: ${page.headers.get('location') ?? html.slice(0, 200)}`);

  const form = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    form.set(match[1], decodeHtml(match[2]));
  }
  form.set('decision', opts.decision ?? 'approve');
  // Whatever happens between the person reading the page and pressing the button.
  await opts.beforeSubmit?.();

  return fetch(`${live.origin}/oauth/authorize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': opts.sameSite ?? 'same-origin',
      cookie,
    },
    body: form,
    redirect: 'manual',
  });
}

/**
 * Registers a client, as a named host. The address matters: `/oauth/register` carries a per-host
 * budget (`OAUTH_REGISTER_MAX_PER_HOST`), which is the product behaviour that keeps one script from
 * walking the table to `MCP_OAUTH_MAX_CLIENTS` — so a suite that wants thirty clients has to look like
 * thirty callers, exactly as thirty real connectors would.
 */
let hostCounter = 0;
async function registerClient(body: Record<string, unknown>, host = `10.1.0.${(hostCounter++ % 250) + 1}`): Promise<Response> {
  return fetch(`${live.origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': host },
    body: JSON.stringify(body),
  });
}

/** `POST /oauth/token`, form-encoded, the way a client sends it. */
const tokenRequest = (body: Record<string, string>) =>
  fetch(`${live.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

/** One `initialize` carrying a credential — `200` means the endpoint accepted it. */
const initializeWith = (token: string) =>
  fetch(`${live.origin}/mcp/${project.name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } },
    }),
  });

const decodeHtml = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** The `code` a redirect back to the client carries, or the `error` it carries instead. */
function callbackParams(res: Response): URLSearchParams {
  const location = res.headers.get('location');
  if (!location) throw new Error(`Expected a redirect back to the client, got ${res.status}`);
  return new URL(location).searchParams;
}

/**
 * The whole connector flow, from "no credential at all" to a live MCP session, driven by the SDK.
 * Returns the connected client and the provider holding the tokens it was issued.
 */
/**
 * **It spends the loopback budget, one registration per call.** The SDK does its own dynamic
 * registration with its own `fetch`, so — unlike `registerClient` above — it cannot present a chosen
 * address and every flow in this file registers as `127.0.0.1`. `OAUTH_REGISTER_MAX_PER_HOST` is what
 * that budget is; a file that drove more flows than that would start failing inside the SDK with an
 * opaque error rather than at an assertion, so the count is worth keeping in view.
 */
async function connectThroughOAuth(cookie?: string): Promise<{ client: Client; provider: TestClientProvider }> {
  const provider = new TestClientProvider();
  const url = new URL(`${live.origin}/mcp/${project.name}`);

  // 1. The connector tries, is refused, and the SDK turns that 401 into a discovery + registration +
  //    authorization URL. It throws rather than returning, which is how a client learns it has to
  //    send a person somewhere.
  const first = new Client({ name: 'oauth-itest', version: '0.0.0' });
  await expect(first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authorizationUrl).toBeDefined();

  // 2. The person approves it in a browser.
  const code = callbackParams(await approveInBrowser(provider.authorizationUrl as URL, { cookie })).get('code');
  expect(code).toBeTruthy();

  // 3. The connector exchanges the code and connects for real.
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await transport.finishAuth(code as string);
  const client = new Client({ name: 'oauth-itest', version: '0.0.0' });
  await client.connect(transport);
  return { client, provider };
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_oauth');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-oauth-'));

  project = await seedProject(database.db, 'oauthdemo', { path: 'handbook/guide.md', body: HANDBOOK });
  member = await createUser(database.db, { username: 'robin', role: 'member', password: OLD_PASSWORD });
  await setMemberRole(database.db, project.id, member.id, 'viewer', null);
  sessionToken = (await createSession(database.db, member.id, 1, { userAgent: 'browser' })).token;

  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  // The mode the feature exists for: no anonymous reader, and no static token either.
  await database.db.update(projects).set({ mcpAuth: 'account' }).where(eq(projects.id, project.id));
});

afterAll(async () => {
  await live?.close();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('a browser-based MCP client', () => {
  it('discovers, registers, is authorized by a person, connects and calls search_docs', async () => {
    const { client, provider } = await connectThroughOAuth();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(['list_topics', 'read_document', 'search_docs']);

      const result = await client.callTool({ name: 'search_docs', arguments: { query: 'how do I install', limit: 3 } });
      const text = ((result.content as Array<{ type: string; text?: string }>) ?? []).find((c) => c.type === 'text')?.text ?? '';
      expect(result.isError).not.toBe(true);
      expect(text).toContain('handbook/guide.md');
      expect(text).toContain('Install the package from the registry');

      // And the credential it is holding is an account-backed row, not a static token that happens to
      // have arrived by another road — which is what makes the membership check apply to it.
      const tokens = provider.tokens();
      expect(tokens?.access_token).toMatch(/^ctxa_[0-9a-f]{64}$/);
      expect(tokens?.refresh_token).toMatch(/^ctxr_[0-9a-f]{64}$/);
      const [row] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.kind, 'access'));
      expect(row.userId).toBe(member.id);
      expect(row.projectId).toBe(project.id);
      expect(row.expiresAt).toBeInstanceOf(Date);
    } finally {
      await client.close();
    }
  });

  it('refreshes its credential without asking the person again, and the old refresh token dies', async () => {
    const { client, provider } = await connectThroughOAuth();
    await client.close();
    const first = provider.tokens();
    expect(first?.refresh_token).toBeTruthy();

    const refreshed = await fetch(`${live.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first?.refresh_token as string }),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as OAuthTokens;
    expect(next.access_token).not.toBe(first?.access_token);
    expect(next.refresh_token).not.toBe(first?.refresh_token);

    // Rotation: presenting the spent refresh token again is refused, so a copy of it is worth nothing
    // to whoever holds one.
    const replay = await fetch(`${live.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first?.refresh_token as string }),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  /**
   * **Handing back an access token takes the whole grant down, and the second assertion is the one
   * that matters.** A version that revoked only the string presented would pass the first three lines
   * of this test and leave the connector holding a refresh token that mints a new pair seconds later —
   * a revocation that undoes itself while looking like one (RFC 7009 §2.1).
   */
  it('hands its credential back, and the refresh token behind it dies with it', async () => {
    const { client, provider } = await connectThroughOAuth();
    await client.close();
    const access = provider.tokens()?.access_token as string;
    const refresh = provider.tokens()?.refresh_token as string;

    expect((await initializeWith(access)).status).toBe(200);

    const revoked = await fetch(`${live.origin}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access }),
    });
    expect(revoked.status).toBe(200);

    expect((await initializeWith(access)).status).toBe(401);
    // The half a row-level revoke would have left alive.
    const renew = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    expect(renew.status).toBe(400);
    expect((await renew.json()).error).toBe('invalid_grant');
  });

  /**
   * **Reuse detection** (OAuth 2.1 §4.3.1). A spent refresh token presented again is two parties
   * holding one credential, and the server cannot tell which is the owner — so the grant comes down
   * and both have to ask the person again. Without it the theft runs silently: the thief redeems
   * first, the owner's client is told only to re-authorize, and the thief's family lives on.
   */
  it('takes the whole grant down when a spent refresh token is presented again', async () => {
    const { client, provider } = await connectThroughOAuth();
    await client.close();
    const spent = provider.tokens()?.refresh_token as string;

    const rotated = (await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: spent })).json()) as OAuthTokens;
    expect(rotated.access_token).toBeTruthy();
    expect((await initializeWith(rotated.access_token)).status).toBe(200);

    // The owner's client now presents the copy it still has. That is the signal.
    const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: spent });
    expect(replay.status).toBe(400);

    // Everything the grant issued is gone, including the pair the *first* redemption produced.
    expect((await initializeWith(rotated.access_token)).status).toBe(401);
    const renew = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token as string });
    expect(renew.status).toBe(400);
  });

  /**
   * **Two exchanges of one refresh token, at the same time.** The rotation's revoke carries
   * `revoked_at IS NULL` in its `WHERE`, so the two race on one row and exactly one comes back having
   * changed it; the loser is holding a credential that was live when it verified it a moment ago and
   * is not now, which is the same event as a stolen copy being redeemed and gets the same answer. A
   * rotation that threw that row count away would hand out two valid families from one grant and tell
   * nobody — and both of these requests would answer `200`, which is what the count below is for.
   */
  it('hands out one family and not two when the same refresh token is exchanged twice at once', async () => {
    const { client, provider } = await connectThroughOAuth();
    await client.close();
    const refresh = provider.tokens()?.refresh_token as string;

    // Four rather than two, because what is being provoked is an interleaving and one pair of
    // requests can serialise by luck. Four is still one grant and still exactly one right answer.
    const all = await Promise.all(Array.from({ length: 4 }, () => tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);

    // And what the winner was handed does not survive the race either: one grant, two claimants, and
    // the server cannot tell which is the owner, so it makes both ask the person again.
    const issued = await Promise.all(all.filter((r) => r.status === 200).map((r) => r.json() as Promise<OAuthTokens>));
    for (const tokens of issued) expect((await initializeWith(tokens.access_token)).status).toBe(401);
  });

  /**
   * **The transaction around the rotation, and what happens without it.**
   *
   * The rotation is a read, a claim and two inserts. Statement by statement the loser's family revoke
   * lands in the gap between the winner's claim and the winner's inserts and misses the pair the
   * winner is about to write — the reuse is detected and the credentials the detection exists to take
   * down survive it. The gap is normally microseconds, so this test opens it with a `pg_sleep` and
   * drives the two halves by hand through the same functions the route calls. Drop the `db.transaction`
   * out of `withRotationTransaction` and the last assertion here answers `200`.
   */
  it('takes down the pair the winner minted, not the pair it had a moment ago', async () => {
    const client = await registerClient({ client_name: 'racer', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());
    const grant = { projectId: project.id, userId: member.id, clientId: client.client_id };
    const original = await issueMcpCredential(database.db, { ...grant, kind: 'refresh', name: 'oauth race', ttlMs: 60_000 });

    // The winner: claim the refresh token, dawdle, then mint the new pair — all inside the wrapper.
    const winner = withRotationTransaction(database.db, async (tx) => {
      const live = await verifyRefreshToken(tx, original.token);
      expect(await revokeMcpTokenById(tx, (live as { id: string }).id)).toBe(true);
      await tx.execute(sql`SELECT pg_sleep(0.5)`);
      return issueMcpCredential(tx, { ...grant, kind: 'access', name: 'oauth race', ttlMs: 60_000 });
    });

    // The loser, arriving in the middle of that — the route's refresh branch by hand, both arms of it,
    // because which arm it lands on is exactly what the transaction changes. In one transaction the
    // winner's claim is invisible, so the loser verifies a live token and loses at the `UPDATE`, which
    // waits for the commit. Statement by statement the claim is already committed, so the loser finds
    // nothing live and takes the reuse arm — *while the winner is still between its claim and its
    // inserts*. Either way it revokes the grant; only one of the two has the new pair in it yet.
    const loser = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return withRotationTransaction(database.db, async (tx) => {
        const live = await verifyRefreshToken(tx, original.token);
        if (!live) {
          const spent = await findSpentRefreshToken(tx, original.token);
          expect(spent).not.toBeNull();
          return revokeMcpCredentialsOfGrant(tx, spent as NonNullable<typeof spent>);
        }
        expect(await revokeMcpTokenById(tx, live.id)).toBe(false);
        return revokeMcpCredentialsOfGrant(tx, live);
      });
    })();

    const [minted] = await Promise.all([winner, loser]);
    expect((await initializeWith(minted.token)).status).toBe(401);
  });

  /**
   * **The claim the rotation races on, on its own.** `revokeMcpTokenById` carries
   * `revoked_at IS NULL` in its `WHERE` and reports its own row count, so exactly one caller can ever
   * be the one that revoked a given credential. It is asserted directly rather than through a race,
   * because a race that happens to serialise proves nothing and a race that does not is a flake: the
   * contract is "exactly one caller can be the one that revoked this", and that is a claim about two
   * sequential calls.
   */
  it('lets exactly one caller claim a credential, however many ask', async () => {
    const client = await registerClient({ client_name: 'claimant', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());
    const issued = await issueMcpCredential(database.db, {
      projectId: project.id,
      userId: member.id,
      clientId: client.client_id,
      kind: 'refresh',
      name: 'oauth claim',
      ttlMs: 60_000,
    });
    expect(await revokeMcpTokenById(database.db, issued.id)).toBe(true);
    expect(await revokeMcpTokenById(database.db, issued.id)).toBe(false);
  });

  /**
   * **An expired refresh token is not a stolen one.** A connector left closed for longer than
   * `MCP_OAUTH_REFRESH_TTL_DAYS` comes back and is refused, which is right — but the first cut asked
   * for "not live" and so put expiry and revocation in one bucket, which meant that ordinary return
   * revoked the grant and logged the sentence the README defines as a theft signal. A signal that
   * fires on the ordinary case is not a signal. Expiry is refused, revokes nothing, and warns nobody.
   */
  it('refuses an expired refresh token without calling it reuse', async () => {
    const client = await registerClient({ client_name: 'long absent', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());
    const grant = { projectId: project.id, userId: member.id, clientId: client.client_id };
    const stale = await issueMcpCredential(database.db, { ...grant, kind: 'refresh', name: 'oauth stale', ttlMs: -60_000 });
    const alive = await issueMcpCredential(database.db, { ...grant, kind: 'access', name: 'oauth stale', ttlMs: 60_000 });

    const refused = await tokenRequest({ grant_type: 'refresh_token', refresh_token: stale.token });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_grant');

    // Nothing else of that grant came down with it, which is the difference between the two readings.
    expect((await initializeWith(alive.token)).status).toBe(200);
  });

  it('revokes nothing when a refresh token it never issued is presented', async () => {
    const { client, provider } = await connectThroughOAuth();
    await client.close();
    const access = provider.tokens()?.access_token as string;

    const invented = await tokenRequest({ grant_type: 'refresh_token', refresh_token: `ctxr_${'a'.repeat(64)}` });
    expect(invented.status).toBe(400);
    // A guessed string must not be a way to knock somebody's connector out.
    expect((await initializeWith(access)).status).toBe(200);
  });

  /**
   * **A person changing their own password loses their connectors, and it is the real route that is
   * driven.** FR-148 ends every other *session* of the account, and that was the whole of what
   * "somebody else knows my password" could affect until an account could also be behind a `ctxa_…` —
   * a credential that outlives a sign-in by weeks and renews itself. This account is its own, created
   * here, so that changing its password cannot disturb the sessions the rest of this file signs in
   * with.
   */
  it('loses its credential when the person changes their own password', async () => {
    const worried = await createUser(database.db, { username: 'sam', role: 'member', password: OLD_PASSWORD });
    await setMemberRole(database.db, project.id, worried.id, 'viewer', null);
    const theirCookie = `${SESSION_COOKIE}=${(await createSession(database.db, worried.id, 1, { userAgent: 'browser' })).token}`;

    const { client, provider } = await connectThroughOAuth(theirCookie);
    await client.close();
    const access = provider.tokens()?.access_token as string;
    const refresh = provider.tokens()?.refresh_token as string;
    expect((await initializeWith(access)).status).toBe(200);

    const changed = await fetch(`${live.origin}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: theirCookie },
      body: JSON.stringify({ currentPassword: OLD_PASSWORD, newPassword: 'a-completely-different-one-2!' }),
    });
    expect(changed.status).toBe(204);

    expect((await initializeWith(access)).status).toBe(401);
    expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })).status).toBe(400);
  });
});

describe('the metadata a client discovers', () => {
  it('names this instance as the authorization server of that one project', async () => {
    const prm = await fetch(`${live.origin}/.well-known/oauth-protected-resource/mcp/${project.name}`).then((r) => r.json());
    expect(prm.resource).toBe(`${live.origin}/mcp/${project.name}`);
    expect(prm.authorization_servers).toEqual([live.origin]);

    const as = await fetch(`${live.origin}/.well-known/oauth-authorization-server`).then((r) => r.json());
    expect(as.issuer).toBe(live.origin);
    expect(as.authorization_endpoint).toBe(`${live.origin}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${live.origin}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${live.origin}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('is reachable by a client holding nothing at all, which is the only way it is any use', async () => {
    for (const url of [
      '/.well-known/oauth-protected-resource',
      `/.well-known/oauth-protected-resource/mcp/${project.name}`,
      '/.well-known/oauth-authorization-server',
    ]) {
      expect((await fetch(live.origin + url)).status).toBe(200);
    }
  });

  it('does not say whether a project exists, so a public document is not a project-name oracle', async () => {
    const real = await fetch(`${live.origin}/.well-known/oauth-protected-resource/mcp/${project.name}`);
    const invented = await fetch(`${live.origin}/.well-known/oauth-protected-resource/mcp/no-such-project`);
    expect(invented.status).toBe(real.status);
    expect((await invented.json()).authorization_servers).toEqual((await real.json()).authorization_servers);
  });
});

describe('the authorization endpoint refuses what it must', () => {
  /** Enough of a request to reach each check; the client is registered by the flow above. */
  async function authorizeUrl(overrides: Record<string, string> = {}): Promise<URL> {
    const registration = await registerClient({ client_name: 'probe', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());
    const url = new URL(`${live.origin}/oauth/authorize`);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      resource: `${live.origin}/mcp/${project.name}`,
      state: 'abc',
      ...overrides,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  it('sends an anonymous browser to sign in rather than rendering a consent page', async () => {
    const res = await fetch(await authorizeUrl(), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/login\?next=/);
    expect(await res.text()).not.toContain('decision');
  });

  /**
   * RFC 6749 §4.1.2.1: when the `redirect_uri` is the thing that is wrong, sending the browser to it
   * is the attack. The assertion is therefore about the **absence** of a redirect as much as about the
   * status code.
   */
  it('refuses an unregistered redirect URI in place, never by redirecting to it', async () => {
    const res = await fetch(await authorizeUrl({ redirect_uri: 'http://127.0.0.1:61999/callback.attacker.test' }), {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('Unregistered redirect URI');
  });

  it('refuses a resource that names another instance, and says so back at the client', async () => {
    const res = await fetch(await authorizeUrl({ resource: 'https://elsewhere.example/mcp/oauthdemo' }), {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    expect(callbackParams(res).get('error')).toBe('invalid_target');
  });

  /**
   * **`scope` is refused rather than swallowed** ([ADR-0054](../../.ssot/ADR.md#adr-0054)). This
   * server advertises no `scopes_supported` and issues none: what an account-backed credential reaches
   * is the membership. A client that asked for one, saw no complaint and received a token would have
   * been told it got what it asked for.
   */
  it('refuses a scope, because it issues none and will not pretend otherwise', async () => {
    const res = await fetch(await authorizeUrl({ scope: 'admin' }), { headers: { cookie: cookieHeader() }, redirect: 'manual' });
    expect(callbackParams(res).get('error')).toBe('invalid_scope');
    expect(callbackParams(res).get('code')).toBeNull();
  });

  it('refuses a challenge method that is not S256, because plain proves nothing', async () => {
    const res = await fetch(await authorizeUrl({ code_challenge_method: 'plain' }), {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    expect(callbackParams(res).get('error')).toBe('invalid_request');
  });

  it('carries the state back untouched, which is how a client knows the answer is to its own question', async () => {
    const res = await approveInBrowser(await authorizeUrl({ state: 'a-particular-value' }));
    expect(callbackParams(res).get('state')).toBe('a-particular-value');
    expect(callbackParams(res).get('code')).toBeTruthy();
  });

  it('gives no code when the person refuses', async () => {
    const res = await approveInBrowser(await authorizeUrl(), { decision: 'deny' });
    expect(callbackParams(res).get('error')).toBe('access_denied');
    expect(callbackParams(res).get('code')).toBeNull();
  });

  /**
   * The approval is a cookie-authenticated write, so it gets the same same-site check every other one
   * in this product gets — otherwise a foreign page could approve a connector on behalf of whoever is
   * signed in, and the first thing the victim would know about it is the connector reading their
   * documentation.
   */
  it('refuses an approval posted from another site', async () => {
    const res = await approveInBrowser(await authorizeUrl(), { sameSite: 'cross-site' });
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
  });

  /**
   * **A code is only ever handed to somebody who can read the project.** The exchange would refuse
   * such a code anyway, but a consent page for a project the account cannot open says it can, and a
   * code in a client's hands is a credential of that account for that project until it is refused.
   * Both halves ask: the `GET` before it draws the page, the `POST` because the page is not proof of
   * anything — it can be skipped, and access can be taken away while it is open.
   */
  describe('for an account that cannot read the project', () => {
    let outsider: UserRow;
    let outsiderCookie: string;

    beforeAll(async () => {
      outsider = await createUser(database.db, { username: 'outsider', role: 'member', password: OLD_PASSWORD });
      outsiderCookie = `${SESSION_COOKIE}=${(await createSession(database.db, outsider.id, 1, { userAgent: 'browser' })).token}`;
    });

    /** The approval, posted straight at the endpoint — what a page that was never rendered would have carried. */
    const postApproval = (url: URL, cookie: string) => {
      const form = new URLSearchParams(url.searchParams);
      form.set('decision', 'approve');
      return fetch(`${live.origin}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie },
        body: form,
        redirect: 'manual',
      });
    };

    /**
     * The `GET` answers on the page, not to the client. Registration is open, so whoever registered
     * the client can send a browser here; a redirect back would tell them, with no action from the
     * person, whether the account belongs to the project.
     */
    it('shows a 403 page instead of a consent page, and tells the client nothing', async () => {
      const res = await fetch(await authorizeUrl({ state: 'outsider-get' }), { headers: { cookie: outsiderCookie }, redirect: 'manual' });
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).toContain('No access to this project');
      expect(html).not.toContain('name="decision"');
      expect(html).not.toContain(REDIRECT_URI);
      expect(html).not.toContain('outsider-get');
    });

    it('gives no code to an approval posted without the page', async () => {
      const res = await postApproval(await authorizeUrl({ state: 'outsider-post' }), outsiderCookie);
      expect(res.status).toBe(302);
      const back = callbackParams(res);
      expect(back.get('error')).toBe('access_denied');
      expect(back.get('state')).toBe('outsider-post');
      expect(back.get('code')).toBeNull();
    });

    it('gives no code when access was taken away while the consent page was open', async () => {
      const leaver = await createUser(database.db, { username: 'leaver', role: 'member', password: OLD_PASSWORD });
      await setMemberRole(database.db, project.id, leaver.id, 'viewer', null);
      const cookie = `${SESSION_COOKIE}=${(await createSession(database.db, leaver.id, 1, { userAgent: 'browser' })).token}`;

      // The page renders — the account could read the project when it was drawn — and the membership
      // goes before the button is pressed.
      const res = await approveInBrowser(await authorizeUrl(), {
        cookie,
        beforeSubmit: () => removeMember(database.db, project.id, leaver.id),
      });
      expect(callbackParams(res).get('error')).toBe('access_denied');
      expect(callbackParams(res).get('code')).toBeNull();
    });

    it('still gives a code to the member who can read it, through the same two steps', async () => {
      // The control: the refusals above are about the account, not about the request they sent.
      const res = await approveInBrowser(await authorizeUrl());
      expect(callbackParams(res).get('code')).toBeTruthy();
    });
  });
});

describe('the token endpoint refuses what it must', () => {
  async function codeFor(projectName = project.name): Promise<{ code: string; clientId: string }> {
    const registration = await registerClient({ client_name: 'probe', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());
    const url = new URL(`${live.origin}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
      // sha256('a-verifier') in base64url, so the matching verifier below is a real one.
      code_challenge: 'NORfwpEYKakZsuYgaey8PFmACPx5Ikq_PyZGYQ7p8NI',
      code_challenge_method: 'S256',
      resource: `${live.origin}/mcp/${projectName}`,
    })) {
      url.searchParams.set(key, value);
    }
    const code = callbackParams(await approveInBrowser(url)).get('code');
    return { code: code as string, clientId: registration.client_id };
  }

  const exchange = (body: Record<string, string>) =>
    fetch(`${live.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

  it('refuses a verifier that does not match the challenge, and burns the code doing it', async () => {
    const { code, clientId } = await codeFor();
    const wrong = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'not-the-verifier',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_grant');

    // The code is gone even though the exchange failed: a code somebody presented with the wrong
    // verifier is a code that may be in the wrong hands.
    const right = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'a-verifier',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(right.status).toBe(400);
  });

  it('refuses a code presented twice', async () => {
    const { code, clientId } = await codeFor();
    expect(
      (await exchange({ grant_type: 'authorization_code', code, code_verifier: 'a-verifier', client_id: clientId, redirect_uri: REDIRECT_URI }))
        .status,
    ).toBe(200);
    expect(
      (await exchange({ grant_type: 'authorization_code', code, code_verifier: 'a-verifier', client_id: clientId, redirect_uri: REDIRECT_URI }))
        .status,
    ).toBe(400);
  });

  it('refuses a code presented by a different client, or at a different redirect URI', async () => {
    const first = await codeFor();
    const other = await codeFor();
    const wrongClient = await exchange({
      grant_type: 'authorization_code',
      code: first.code,
      code_verifier: 'a-verifier',
      client_id: other.clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect((await wrongClient.json()).error).toBe('invalid_grant');

    const wrongUri = await exchange({
      grant_type: 'authorization_code',
      code: other.code,
      code_verifier: 'a-verifier',
      client_id: other.clientId,
      redirect_uri: 'http://127.0.0.1:61999/elsewhere',
    });
    expect((await wrongUri.json()).error).toBe('invalid_grant');
  });

  /**
   * **A project deleted under a grant is a refused grant, never a server error.** Before the exchange
   * it is the project check that says so; in the window between that check and the insert — the
   * project row is read, not locked — it is the foreign key, and the answer has to be the same one.
   */
  describe('for a project deleted before the pair is minted', () => {
    let doomedCounter = 0;
    async function doomedProject(): Promise<ProjectRow> {
      const doomed = await seedProject(database.db, `doomed${doomedCounter++}`, { path: 'handbook/guide.md', body: HANDBOOK });
      await setMemberRole(database.db, doomed.id, member.id, 'viewer', null);
      return doomed;
    }
    const deleteRow = (id: string) => database.db.delete(projects).where(eq(projects.id, id));
    const tokensOf = async (id: string) => (await database.db.select().from(mcpTokens).where(eq(mcpTokens.projectId, id))).length;
    const refreshTokenFor = async (doomed: ProjectRow) => {
      const client = await registerClient({ client_name: 'doomed', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());
      return issueMcpCredential(database.db, {
        projectId: doomed.id,
        userId: member.id,
        clientId: client.client_id,
        kind: 'refresh',
        name: 'oauth doomed',
        ttlMs: 60_000,
      });
    };
    /** Until another backend of this database sits waiting on a lock in a `DELETE FROM projects`. */
    const waitForBlockedDelete = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await database.db.execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'delete from "projects"%'`);
        if (waiting.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the project delete never started waiting on a lock');
    };

    it('refuses a code whose project was deleted before the exchange', async () => {
      const doomed = await doomedProject();
      const { code, clientId } = await codeFor(doomed.name);
      await deleteRow(doomed.id);

      const res = await exchange({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'a-verifier',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_grant');
    });

    it('refuses a code whose project is deleted after the exchange checked it and before it minted', async () => {
      const doomed = await doomedProject();
      const { code, clientId } = await codeFor(doomed.name);
      // The delete lands exactly in the window: every check has passed, the inserts have not run.
      live.ctx.testHooks = { onCodeVerifiedBeforeIssue: async () => void (await deleteRow(doomed.id)) };
      try {
        const res = await exchange({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'a-verifier',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringMatching(/no longer exists/) });
      } finally {
        live.ctx.testHooks = undefined;
      }
      expect(await tokensOf(doomed.id)).toBe(0);
    });

    it('refuses a refresh whose project was deleted before it arrived', async () => {
      const doomed = await doomedProject();
      const refresh = await refreshTokenFor(doomed);
      await deleteRow(doomed.id);

      const res = await exchange({ grant_type: 'refresh_token', refresh_token: refresh.token });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_grant');
    });

    /**
     * The refresh branch holds the claimed token row when it mints, and a project delete cascades onto
     * that row — so the two used to lock in opposite orders and deadlock, and Postgres answered by
     * aborting one side: a `500` whenever it chose the rotation. With the project row taken first
     * (`keyShareProjectRow`) the delete that arrives in the window waits for the rotation to commit
     * and then takes the new pair down with the project. The delete is started inside the window and
     * the rotation is let go only once Postgres reports the delete waiting on a lock, so both halves
     * are in place every run.
     */
    it('lets a delete that arrives while a refresh is minting wait for it, then take the new pair down', async () => {
      const doomed = await doomedProject();
      const refresh = await refreshTokenFor(doomed);
      let deleting: Promise<unknown> | undefined;
      live.ctx.testHooks = {
        onRefreshClaimedBeforeIssue: async () => {
          // `.execute()`: a drizzle query only runs when awaited, and this one must run *now*.
          deleting = deleteRow(doomed.id).execute();
          await waitForBlockedDelete();
        },
      };
      let res: Response;
      try {
        res = await exchange({ grant_type: 'refresh_token', refresh_token: refresh.token });
      } finally {
        live.ctx.testHooks = undefined;
      }
      expect(res.status).toBe(200);
      const minted = await res.json();
      await deleting;

      expect(await database.db.select().from(projects).where(eq(projects.id, doomed.id))).toHaveLength(0);
      expect(await tokensOf(doomed.id)).toBe(0);
      expect((await initializeWith(minted.access_token)).status).toBe(401);
    });
  });

  it('refuses a grant type it does not support', async () => {
    const res = await exchange({ grant_type: 'client_credentials' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });
});

describe('registering a client', () => {
  it('grants nothing at all: the row exists and reads no project', async () => {
    const before = await database.db.select().from(mcpTokens);
    const registration = await registerClient({ client_name: 'nosy', redirect_uris: [REDIRECT_URI] });
    expect(registration.status).toBe(201);
    const { client_id } = await registration.json();
    expect(client_id).toMatch(/^ctxc_[0-9a-f]{32}$/);
    // No credential appeared, and the client_id itself opens nothing.
    expect(await database.db.select().from(mcpTokens)).toHaveLength(before.length);
    const attempt = await fetch(`${live.origin}/mcp/${project.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${client_id}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } },
      }),
    });
    expect(attempt.status).toBe(401);
  });

  it('refuses a redirect URI that would carry an authorization code in the clear', async () => {
    const res = await registerClient({ client_name: 'insecure', redirect_uris: ['http://attacker.test/cb'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  /**
   * **The ceiling, exercised against a database rather than described in a comment.** It ran untested
   * in the first cut of this feature: a sentence in `test/auth-coverage.test.ts` said "capped by
   * `MCP_OAUTH_MAX_CLIENTS`" and that sentence was a `Record` *value* nothing compared, so deleting
   * the check would have turned nothing red. `registerOauthClient` takes the cap as an argument, so it
   * is asked for a small one here and the third registration is the assertion.
   */
  it('refuses a registration that would take the table past its ceiling', async () => {
    const isolated = await createTestDatabase(baseUrl, 'mcp_oauth_cap');
    try {
      await applySchema(isolated);
      const two = { name: 'a connector', redirectUris: [REDIRECT_URI], maxClients: 2 };
      await registerOauthClient(isolated.db, two);
      await registerOauthClient(isolated.db, two);
      await expect(registerOauthClient(isolated.db, two)).rejects.toBeInstanceOf(ClientLimitError);
      // And it is a ceiling on rows, so one more room means one more client and not a reset.
      await expect(registerOauthClient(isolated.db, { ...two, maxClients: 3 })).resolves.toMatchObject({ name: 'a connector' });
    } finally {
      await dropTestDatabase(baseUrl, isolated);
    }
  });

  /**
   * The ceiling is only survivable because of this sweep, and the three cases are the three the
   * predicate distinguishes. Without the first the cap becomes a month-long lockout of every honest
   * connector after one script; without the third it silently cuts a working one off.
   */
  it('drops the clients nothing is using, on two windows, and keeps the one that is', async () => {
    const isolated = await createTestDatabase(baseUrl, 'mcp_oauth_sweep');
    try {
      await applySchema(isolated);
      const day = 24 * 60 * 60_000;
      const long = 30 * day;
      const make = (name: string) => registerOauthClient(isolated.db, { name, redirectUris: [REDIRECT_URI], maxClients: 100 });

      const neverUsed = await make('registered and vanished');
      const idle = await make('used once, long ago');
      const working = await make('still connected');
      const fresh = await make('registered a moment ago');
      // **The fixture that tells the two windows apart.** Two days old and never used: it survives the
      // month-long window the first cut had and falls to the day-long one this entry added, so a
      // regression to a single window turns this test red instead of leaving it quietly green.
      const twoDaysUnused = await make('registered the day before yesterday');

      const longAgo = new Date(Date.now() - 2 * long);
      await isolated.db.update(oauthClients).set({ createdAt: longAgo }).where(eq(oauthClients.clientId, neverUsed.clientId));
      await isolated.db.update(oauthClients).set({ createdAt: longAgo, lastUsedAt: longAgo }).where(eq(oauthClients.clientId, idle.clientId));
      await isolated.db.update(oauthClients).set({ createdAt: longAgo, lastUsedAt: longAgo }).where(eq(oauthClients.clientId, working.clientId));
      await isolated.db
        .update(oauthClients)
        .set({ createdAt: new Date(Date.now() - 2 * day) })
        .where(eq(oauthClients.clientId, twoDaysUnused.clientId));

      // The one thing that exempts a client whatever its age: it is holding a live credential.
      const [aProject] = await isolated.db.insert(projects).values({ name: 'swept', embeddingModel: 'x' }).returning();
      const owner = await createUser(isolated.db, { username: 'owner', role: 'member', password: OLD_PASSWORD });
      await issueMcpCredential(isolated.db, {
        projectId: aProject.id,
        userId: owner.id,
        clientId: working.clientId,
        kind: 'refresh',
        name: 'oauth swept',
        ttlMs: long,
      });

      const dropped = await sweepStaleOauthClients(isolated.db, { unusedMs: day, staleMs: long });
      expect(dropped).toBe(3);
      const left = (await isolated.db.select().from(oauthClients)).map((c) => c.clientId).sort();
      expect(left).toEqual([working.clientId, fresh.clientId].sort());
    } finally {
      await dropTestDatabase(baseUrl, isolated);
    }
  });

  /**
   * **The rate limit, driven through the route.** An earlier version of this test built its own
   * `SlidingWindow` and beat on that, which asserted that the class works and nothing about whether
   * `/oauth/register` uses it: deleting the limiter from the route left every test green. This one
   * spends a real host's budget against the real endpoint.
   */
  it('answers 429 with a retry-after once one host has spent its budget', async () => {
    const host = '203.0.113.7'; // its own address, so it spends nobody else's budget in this file
    for (let i = 0; i < OAUTH_REGISTER_MAX_PER_HOST; i++) {
      const allowed = await registerClient({ client_name: `burst ${i}`, redirect_uris: [REDIRECT_URI] }, host);
      expect(allowed.status).toBe(201);
    }
    const refused = await registerClient({ client_name: 'one too many', redirect_uris: [REDIRECT_URI] }, host);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await refused.json()).error).toBe('temporarily_unavailable');

    // Per host, so one noisy address does not close the door on everybody else.
    const elsewhere = await registerClient({ client_name: 'a different office', redirect_uris: [REDIRECT_URI] }, '203.0.113.8');
    expect(elsewhere.status).toBe(201);
  });

  /**
   * **A grant is scoped to a project as well as to a client and an account.** One person, one
   * connector, two projects is the ordinary shape of this — they approved it twice — and revoking one
   * must not disconnect the other. Drop `projectId` from `revokeMcpCredentialsOfGrant`'s `WHERE` and
   * the second assertion fails.
   */
  it('takes down one project\u2019s grant without touching the same client\u2019s grant on another', async () => {
    const other = await seedProject(database.db, 'second-project', { path: 'handbook/guide.md', body: HANDBOOK });
    await setMemberRole(database.db, other.id, member.id, 'viewer', null);
    // **`account`, or this test asserts nothing.** A seeded project is `open`, and an `open` project
    // answers a revoked credential exactly as it answers no credential at all — so the surviving-token
    // assertion below would read `200` whether or not the revocation had reached it.
    await database.db.update(projects).set({ mcpAuth: 'account' }).where(eq(projects.id, other.id));
    const client = await registerClient({ client_name: 'two projects', redirect_uris: [REDIRECT_URI] }).then((r) => r.json());

    const here = await issueMcpCredential(database.db, {
      projectId: project.id,
      userId: member.id,
      clientId: client.client_id,
      kind: 'access',
      name: 'oauth here',
      ttlMs: 60_000,
    });
    const there = await issueMcpCredential(database.db, {
      projectId: other.id,
      userId: member.id,
      clientId: client.client_id,
      kind: 'access',
      name: 'oauth there',
      ttlMs: 60_000,
    });

    await revokeMcpCredentialsOfGrant(database.db, { clientId: client.client_id, userId: member.id, projectId: project.id });

    expect((await initializeWith(here.token)).status).toBe(401);
    const stillThere = await fetch(`${live.origin}/mcp/${other.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${there.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } },
      }),
    });
    expect(stillThere.status).toBe(200);
  });
});
