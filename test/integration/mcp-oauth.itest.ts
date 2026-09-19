import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { mcpTokens, projects, type ProjectRow, type UserRow } from '../../src/db/schema.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { createUser } from '../../src/services/auth/users.js';
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
async function approveInBrowser(url: URL, opts: { cookie?: string; decision?: 'approve' | 'deny'; sameSite?: string } = {}): Promise<Response> {
  const page = await fetch(url, {
    headers: opts.cookie === undefined ? { cookie: cookieHeader() } : opts.cookie ? { cookie: opts.cookie } : {},
    redirect: 'manual',
  });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`The consent page answered ${page.status}: ${page.headers.get('location') ?? html.slice(0, 200)}`);

  const form = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    form.set(match[1], decodeHtml(match[2]));
  }
  form.set('decision', opts.decision ?? 'approve');

  return fetch(`${live.origin}/oauth/authorize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': opts.sameSite ?? 'same-origin',
      cookie: cookieHeader(),
    },
    body: form,
    redirect: 'manual',
  });
}

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
async function connectThroughOAuth(): Promise<{ client: Client; provider: TestClientProvider }> {
  const provider = new TestClientProvider();
  const url = new URL(`${live.origin}/mcp/${project.name}`);

  // 1. The connector tries, is refused, and the SDK turns that 401 into a discovery + registration +
  //    authorization URL. It throws rather than returning, which is how a client learns it has to
  //    send a person somewhere.
  const first = new Client({ name: 'oauth-itest', version: '0.0.0' });
  await expect(first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authorizationUrl).toBeDefined();

  // 2. The person approves it in a browser.
  const code = callbackParams(await approveInBrowser(provider.authorizationUrl as URL)).get('code');
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
  member = await createUser(database.db, { username: 'robin', role: 'member', password: 'a-long-enough-password-1!' });
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

  it('hands its credential back, and the endpoint stops accepting it', async () => {
    const { client, provider } = await connectThroughOAuth();
    await client.close();
    const access = provider.tokens()?.access_token as string;

    const before = await fetch(`${live.origin}/mcp/${project.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } },
      }),
    });
    expect(before.status).toBe(200);

    const revoked = await fetch(`${live.origin}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access }),
    });
    expect(revoked.status).toBe(200);

    const after = await fetch(`${live.origin}/mcp/${project.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } },
      }),
    });
    expect(after.status).toBe(401);
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
    const registration = await fetch(`${live.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'probe', redirect_uris: [REDIRECT_URI] }),
    }).then((r) => r.json());
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
});

describe('the token endpoint refuses what it must', () => {
  async function codeFor(): Promise<{ code: string; clientId: string }> {
    const registration = await fetch(`${live.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'probe', redirect_uris: [REDIRECT_URI] }),
    }).then((r) => r.json());
    const url = new URL(`${live.origin}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
      // sha256('a-verifier') in base64url, so the matching verifier below is a real one.
      code_challenge: 'NORfwpEYKakZsuYgaey8PFmACPx5Ikq_PyZGYQ7p8NI',
      code_challenge_method: 'S256',
      resource: `${live.origin}/mcp/${project.name}`,
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

  it('refuses a grant type it does not support', async () => {
    const res = await exchange({ grant_type: 'client_credentials' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });
});

describe('registering a client', () => {
  it('grants nothing at all: the row exists and reads no project', async () => {
    const before = await database.db.select().from(mcpTokens);
    const registration = await fetch(`${live.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'nosy', redirect_uris: [REDIRECT_URI] }),
    });
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
    const res = await fetch(`${live.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'insecure', redirect_uris: ['http://attacker.test/cb'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });
});
