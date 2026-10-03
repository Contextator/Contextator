import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { ClientMetadataResolver } from '../../src/mcp/cimd.js';
import { mcpTokens, oauthClients, projects, type ProjectRow } from '../../src/db/schema.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { createUser } from '../../src/services/auth/users.js';
import { fixtureMetadataFetch, MetadataHost } from '../support/cimd-fixture.js';
import { PUBLIC_FIXTURE_ADDRESS } from '../support/egress-seams.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';

/**
 * **A client with no registration, identified by the URL of its metadata document**
 * (draft-ietf-oauth-client-id-metadata-document), end to end: the SDK's own client reads
 * `client_id_metadata_document_supported` from the authorization server metadata, sends its document
 * URL as the `client_id`, and this server fetches that document — through the ADR-0088 egress, with
 * only DNS and the final dial pointed at a local stub — before a person approves the connection.
 */

const baseUrl = inject('postgresBaseUrl');

const METADATA_HOST = 'connector.example.test';
const CLIENT_ID = `https://${METADATA_HOST}/oauth/client.json`;
const REDIRECT_URI = 'http://127.0.0.1:61998/callback';
const PASSWORD = 'a-long-enough-password-1!';

let database: TestDatabase;
let live: LiveInstance;
let root: string;
let project: ProjectRow;
let sessionToken: string;
const metadataHost = new MetadataHost();

/** Documents by path. Anything else answers 404. */
let documents: Record<string, unknown> = {};
/** Paths served with a cache lifetime; every other document is `no-store`. */
const CACHEABLE_PATHS = new Set(['/oauth/cached.json']);

const document = (overrides: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: 'Metadata Connector',
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...overrides,
});

class MetadataClientProvider implements OAuthClientProvider {
  private client: OAuthClientInformationFull | undefined;
  private verifier = '';
  private saved: OAuthTokens | undefined;
  authorizationUrl: URL | undefined;
  readonly clientMetadataUrl = CLIENT_ID;

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Metadata Connector',
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

const cookie = () => `${SESSION_COOKIE}=${sessionToken}`;

const decodeHtml = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** An authorization URL for `clientId`, as a client would build it, without the SDK. */
function authorizeUrl(clientId: string, redirectUri = REDIRECT_URI, origin = live.origin): URL {
  const url = new URL(`${origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'st',
    resource: `${origin}/mcp/${project.name}`,
  }).toString();
  return url;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_cimd');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-cimd-'));

  project = await seedProject(database.db, 'cimddemo', { path: 'handbook/guide.md', body: '# Guide\n\n## Install\n\nInstall the package first.\n' });
  const member = await createUser(database.db, { username: 'sasha', role: 'member', password: PASSWORD });
  await setMemberRole(database.db, project.id, member.id, 'viewer', null);
  sessionToken = (await createSession(database.db, member.id, 1, { userAgent: 'browser' })).token;

  metadataHost.respond = (req, res) => {
    const body = documents[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    const cacheControl = CACHEABLE_PATHS.has(req.url ?? '') ? 'max-age=60' : 'no-store';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': cacheControl });
    res.end(JSON.stringify(body));
  };
  await metadataHost.start();

  const clientMetadata = new ClientMetadataResolver({ fetch: fixtureMetadataFetch(metadataHost, { [METADATA_HOST]: PUBLIC_FIXTURE_ADDRESS }) });
  live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root, clientMetadata });
  await database.db.update(projects).set({ mcpAuth: 'account' }).where(eq(projects.id, project.id));
});

beforeEach(() => {
  documents = { '/oauth/client.json': document() };
  metadataHost.hits.length = 0;
});

afterAll(async () => {
  await live?.close();
  await metadataHost.stop();
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('client ID metadata documents', () => {
  it('advertises support beside dynamic registration', async () => {
    const res = await fetch(`${live.origin}/.well-known/oauth-authorization-server`);
    const metadata = (await res.json()) as Record<string, unknown>;
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.registration_endpoint).toBe(`${live.origin}/oauth/register`);
  });

  it('connects an unregistered client by its document URL, through the SDK', async () => {
    const provider = new MetadataClientProvider();
    const url = new URL(`${live.origin}/mcp/${project.name}`);

    const first = new Client({ name: 'cimd-itest', version: '0.0.0' });
    await expect(first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))).rejects.toBeInstanceOf(UnauthorizedError);
    const authorization = provider.authorizationUrl as URL;
    expect(authorization.searchParams.get('client_id')).toBe(CLIENT_ID);

    // The consent page names where the answer goes, and warns about a loopback-only client.
    const page = await fetch(authorization, { headers: { cookie: cookie() }, redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Connect Metadata Connector');
    expect(html).toContain(`described by <strong>${METADATA_HOST}</strong>`);
    expect(html).toContain('you will be sent to <strong>127.0.0.1</strong>');
    expect(html).toContain('only send you back to this computer');

    const form = new URLSearchParams();
    for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) form.set(match[1], decodeHtml(match[2]));
    form.set('decision', 'approve');
    const answer = await fetch(`${live.origin}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie: cookie() },
      body: form,
      redirect: 'manual',
    });
    const code = new URL(answer.headers.get('location') as string).searchParams.get('code');
    expect(code).toBeTruthy();

    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await transport.finishAuth(code as string);
    const client = new Client({ name: 'cimd-itest', version: '0.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'search_docs', arguments: { query: 'install', limit: 1 } });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }

    // Approval wrote the row credentials hang off; nothing went through /oauth/register.
    const rows = await database.db.select().from(oauthClients);
    expect(rows.map((r) => r.clientId)).toEqual([CLIENT_ID]);
    expect(rows[0].name).toBe('Metadata Connector');
    const [token] = await database.db.select().from(mcpTokens).where(eq(mcpTokens.kind, 'access'));
    expect(token.clientId).toBe(CLIENT_ID);
    expect(metadataHost.hits.length).toBeGreaterThan(0);
  });

  /** Every refusal is shown in place: the redirect URI is not known good until the document is. */
  async function refusedInPlace(url: URL, expected: string): Promise<void> {
    const res = await fetch(url, { headers: { cookie: cookie() }, redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain(expected);
  }

  it('refuses a redirect_uri the document does not list', async () => {
    await refusedInPlace(authorizeUrl(CLIENT_ID, 'http://127.0.0.1:61998/elsewhere'), 'Unregistered redirect URI');
  });

  it('refuses a document whose client_id is another URL', async () => {
    documents['/oauth/client.json'] = document({ client_id: `https://${METADATA_HOST}/other.json` });
    await refusedInPlace(authorizeUrl(CLIENT_ID), 'different client_id');
  });

  it('refuses a document missing a required field', async () => {
    const { client_name: _omitted, ...rest } = document();
    documents['/oauth/client.json'] = rest;
    await refusedInPlace(authorizeUrl(CLIENT_ID), 'Client metadata refused');
  });

  it.each([
    ['https://169.254.169.254/latest/meta-data/client.json', 'link-local'],
    ['https://127.0.0.1/client.json', 'loopback'],
    [`http://${METADATA_HOST}/oauth/client.json`, 'must use https'],
    [`https://${METADATA_HOST}`, 'must contain a path'],
  ])('refuses %s without fetching it', async (clientId, why) => {
    await refusedInPlace(authorizeUrl(clientId), why);
    expect(metadataHost.hits).toEqual([]);
  });

  it('names the app behind a private-use scheme on the consent page', async () => {
    const nativeRedirect = 'com.example.app:/callback';
    documents['/oauth/client.json'] = document({ application_type: 'native', redirect_uris: [nativeRedirect] });
    const page = await fetch(authorizeUrl(CLIENT_ID, nativeRedirect), { headers: { cookie: cookie() }, redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('you will be sent to the app on this device that opens <strong>com.example.app:</strong> links');
    expect(html).not.toContain('<strong></strong>');
  });

  it('rate limits fetches of new documents per host, but not documents already cached', async () => {
    const limited = await startMcpInstance(database, {
      dataDir: path.join(root, '.data-limited'),
      docRoot: root,
      clientMetadata: new ClientMetadataResolver({ fetch: fixtureMetadataFetch(metadataHost, { [METADATA_HOST]: PUBLIC_FIXTURE_ADDRESS }) }),
      clientMetadataFetchLimit: 2,
    });
    try {
      const cachedId = `https://${METADATA_HOST}/oauth/cached.json`;
      const freshId = (n: number) => `https://${METADATA_HOST}/oauth/fresh-${n}.json`;
      documents[new URL(cachedId).pathname] = document({ client_id: cachedId });
      for (const n of [1, 2]) documents[new URL(freshId(n)).pathname] = document({ client_id: freshId(n) });
      const open = (clientId: string) =>
        fetch(authorizeUrl(clientId, REDIRECT_URI, limited.origin), { headers: { cookie: cookie() }, redirect: 'manual' });

      expect((await open(cachedId)).status).toBe(200);
      expect((await open(freshId(1))).status).toBe(200);

      const refused = await open(freshId(2));
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await refused.text()).toContain('Too many new clients');

      // The cached document needs no fetch, so the limit does not stand in its way.
      expect((await open(cachedId)).status).toBe(200);
      expect(metadataHost.hits.filter((hit) => hit === '/oauth/cached.json')).toHaveLength(1);
      expect(metadataHost.hits).not.toContain('/oauth/fresh-2.json');
    } finally {
      await limited.close();
    }
  });

  it('leaves a registration id to the registration table', async () => {
    await refusedInPlace(authorizeUrl('ctxc_00000000000000000000000000000000'), 'Unknown client');
    expect(metadataHost.hits).toEqual([]);
  });
});
