import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notionOAuthRoutes, NOTION_OAUTH_FLOW_COOKIE } from '../src/admin/notion-oauth-routes.js';
import { loadConfig, WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import type { Principal } from '../src/auth/types.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { decryptSecret, encryptSecret, isEncryptedSecret, keyringOf, type SecretKeyring } from '../src/services/crypto.js';
import { ForbiddenError, UnauthorizedError } from '../src/services/errors.js';
import { ValidationError } from '../src/services/projects.js';
import { NotionDriver } from '../src/services/sources/notion.js';
import {
  buildNotionAuthorizeUrl,
  exchangeAuthorizationCode,
  isOAuthSecret,
  NotionOAuthError,
  notionOAuthSettings,
  oauthSecretFromGrant,
  overrideNotionApiBaseUrlForTests,
  parseOAuthSecret,
  refreshAccessToken,
  serializeOAuthSecret,
  type NotionSecretStore,
} from '../src/services/sources/notion-oauth.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { createSource, updateSource } from '../src/services/sources.js';
import { StubNotionOAuth } from './support/notion-oauth-stub.js';

/**
 * Notion OAuth ([ADR-0129](../.ssot/ADR.md#adr-0129)) against a stub of Notion's OAuth and API
 * endpoints on a real loopback port. The tokens are `stub-…` strings; nothing here talks to Notion.
 *
 * What needs a database — a real session, the project membership, the compare-and-swap in SQL, the
 * stored envelope — is asserted in `test/integration/notion-oauth.itest.ts`; this file keeps to what a
 * process can show without one, with an in-memory stand-in for the one ciphertext the refresh reads.
 */

const KEYS: SecretKeyring = keyringOf({ SECRET_KEY: 'k'.repeat(64) });
const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const REDIRECT = 'http://localhost:3000/api/sources/notion/oauth/callback';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000a2';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';

let stub: StubNotionOAuth;
let dataDir: string;

beforeAll(async () => {
  stub = new StubNotionOAuth();
  await stub.start();
  overrideNotionApiBaseUrlForTests(stub.url);
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-notion-oauth-')));
});
afterAll(async () => {
  overrideNotionApiBaseUrlForTests(undefined);
  await stub.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const settings = () => ({ clientId: stub.clientId, clientSecret: stub.clientSecret, redirectUri: REDIRECT });

/** A source row whose `secret_enc` holds `plain` under {@link KEYS}. */
function sourceRow(plain: string | null): DocumentSourceRow {
  return {
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 'notion',
    name: 'wiki',
    label: '',
    config: { rootIds: [], extensions: ['md'] },
    secretEnc: plain === null ? null : encryptSecret(plain, KEYS),
    webhookSecret: null,
    flavor: 'plain',
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    documentCount: 0,
    syncIntervalMinutes: null,
    nextSyncAt: null,
    webhookVerificationExpiresAt: null,
    webhookDueAt: null,
    webhookMinIntervalMinutes: null,
    createdAt: new Date(),
  } as DocumentSourceRow;
}

/** The one ciphertext a refresh reads and compare-and-swaps, kept in memory. */
class MemoryStore implements NotionSecretStore {
  swaps = 0;
  constructor(public enc: string | null) {}
  async read(): Promise<string | null> {
    return this.enc;
  }
  async swap(_sourceId: string, expected: string | null, plain: string): Promise<boolean> {
    if (this.enc !== expected) return false;
    this.enc = encryptSecret(plain, KEYS);
    this.swaps++;
    return true;
  }
  plain(): unknown {
    return JSON.parse(decryptSecret(this.enc!, KEYS));
  }
}

function connect(): { store: MemoryStore; row: DocumentSourceRow } {
  const pair = stub.issuePair();
  const row = sourceRow(
    serializeOAuthSecret({
      v: 1,
      kind: 'oauth',
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      botId: stub.botId,
      workspaceId: stub.workspaceId,
    }),
  );
  return { store: new MemoryStore(row.secretEnc), row };
}

function driverFor(row: DocumentSourceRow, store: NotionSecretStore, withCredentials = true): NotionDriver {
  return new NotionDriver(
    row,
    {
      db: null as never,
      log,
      config: {
        ...WEB_LIMIT_DEFAULTS,
        DATA_DIR: dataDir,
        SECRET_KEY: 'k'.repeat(64),
        ALLOWED_DOC_ROOTS: [],
        IGNORE_GLOBS: [],
        ...(withCredentials ? { NOTION_OAUTH_CLIENT_ID: stub.clientId, NOTION_OAUTH_CLIENT_SECRET: stub.clientSecret } : {}),
      },
    },
    undefined,
    store,
  );
}

describe('the authorization-code exchange', () => {
  it('sends the browser to Notion with the client id, the redirect URI and the state', () => {
    const url = new URL(buildNotionAuthorizeUrl(settings(), 'state-abc'));
    expect(url.origin).toBe(stub.url);
    expect(url.pathname).toBe('/v1/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: stub.clientId,
      response_type: 'code',
      owner: 'user',
      redirect_uri: REDIRECT,
      state: 'state-abc',
    });
    // The client secret is the server's alone; it must not travel through the browser.
    expect(url.toString()).not.toContain(stub.clientSecret);
  });

  it('trades the code Notion sends back for the pair, with HTTP Basic and the redirect URI', async () => {
    const authorize = await fetch(buildNotionAuthorizeUrl(settings(), 'round-trip'), { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    // Notion echoes `state` untouched; the callback's whole check is that it comes back equal.
    expect(back.searchParams.get('state')).toBe('round-trip');

    const before = stub.tokenRequests.length;
    const grant = await exchangeAuthorizationCode(settings(), back.searchParams.get('code')!);
    expect(stub.tokenRequests.slice(before)).toEqual([{ grantType: 'authorization_code', authorised: true }]);
    expect(grant).toMatchObject({ bot_id: stub.botId, workspace_id: stub.workspaceId, workspace_name: stub.workspaceName });
    expect(oauthSecretFromGrant(grant)).toMatchObject({ v: 1, kind: 'oauth', accessToken: grant.access_token, refreshToken: grant.refresh_token });
  });

  it('refuses a code that is spent, a wrong client secret and a different redirect URI', async () => {
    const authorize = await fetch(buildNotionAuthorizeUrl(settings(), 's'), { redirect: 'manual' });
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;
    await expect(exchangeAuthorizationCode({ ...settings(), redirectUri: 'http://localhost:9/elsewhere' }, code)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    await exchangeAuthorizationCode(settings(), code);
    await expect(exchangeAuthorizationCode(settings(), code)).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(exchangeAuthorizationCode({ ...settings(), clientSecret: 'not-it' }, code)).rejects.toMatchObject({ code: 'invalid_client' });
  });

  it('reports an unreachable Notion as transient and keeps no response body in the error', async () => {
    overrideNotionApiBaseUrlForTests('http://127.0.0.1:1');
    try {
      const err = await exchangeAuthorizationCode(settings(), 'whatever').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotionOAuthError);
      expect((err as NotionOAuthError).transient).toBe(true);
      expect((err as Error).message).not.toContain('whatever');
    } finally {
      overrideNotionApiBaseUrlForTests(stub.url);
    }
  });
});

describe('the stored format', () => {
  it('tells an OAuth document from an integration token by its first character', () => {
    expect(isOAuthSecret('{"v":1}')).toBe(true);
    expect(isOAuthSecret('ntn_abc')).toBe(false);
    expect(isOAuthSecret('secret_abc')).toBe(false);
    expect(
      parseOAuthSecret(serializeOAuthSecret({ v: 1, kind: 'oauth', accessToken: 'a', refreshToken: 'r', botId: 'b', workspaceId: 'w' })),
    ).toEqual({
      v: 1,
      kind: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      botId: 'b',
      workspaceId: 'w',
    });
    expect(() => parseOAuthSecret('{"v":2}')).toThrow(/Reconnect/);
    expect(() => parseOAuthSecret('{not json')).toThrow(/Reconnect/);
  });

  it('reads a settings object only when both halves and a redirect are present', () => {
    expect(notionOAuthSettings({})).toBeNull();
    expect(notionOAuthSettings({ NOTION_OAUTH_CLIENT_ID: 'id' })).toBeNull();
    expect(notionOAuthSettings({ NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 's' })).toBeNull();
    expect(
      notionOAuthSettings({ NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://docs.example.com/' })
        ?.redirectUri,
    ).toBe('https://docs.example.com/api/sources/notion/oauth/callback');
    expect(
      notionOAuthSettings({
        NOTION_OAUTH_CLIENT_ID: 'id',
        NOTION_OAUTH_CLIENT_SECRET: 's',
        PUBLIC_BASE_URL: 'https://docs.example.com',
        NOTION_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/sources/notion/oauth/callback',
      })?.redirectUri,
    ).toBe('http://localhost:3000/api/sources/notion/oauth/callback');
  });
});

describe('(a) refreshing when Notion refuses the access token', () => {
  it('refreshes once, writes the new pair with a compare-and-swap, and repeats the request', async () => {
    const { store, row } = connect();
    stub.expireAccessToken();
    const grantsBefore = stub.refreshGrants;
    const originalEnc = store.enc;

    const driver = driverFor(row, store);
    await expect(driver.test()).resolves.toBe('Connected as Stub bot');

    expect(stub.refreshGrants - grantsBefore).toBe(1);
    expect(store.swaps).toBe(1);
    expect(store.enc).not.toBe(originalEnc);
    // The new pair is what Notion issued, and it is still the OAuth document, not a bare token.
    expect(store.plain()).toMatchObject({ v: 1, kind: 'oauth', accessToken: stub.currentAccessToken, refreshToken: stub.currentRefreshToken });
    expect(isEncryptedSecret(store.enc!)).toBe(true);

    // The refreshed token is kept for the rest of the driver's life: the next call does not refresh.
    await driver.test();
    expect(stub.refreshGrants - grantsBefore).toBe(1);
  });

  it('refreshes exactly once for two runs of one source that are refused together, and the second continues with the new token', async () => {
    const { store, row } = connect();
    stub.expireAccessToken();
    stub.tokenDelayMs = 120; // long enough that the second run is certainly waiting on the first
    const grantsBefore = stub.refreshGrants;
    const originalEnc = store.enc!;
    try {
      const results = await Promise.all([driverFor(row, store).test(), driverFor(row, store).test()]);
      expect(results).toEqual(['Connected as Stub bot', 'Connected as Stub bot']);
    } finally {
      stub.tokenDelayMs = 0;
    }
    expect(stub.refreshGrants - grantsBefore).toBe(1);
    expect(store.swaps).toBe(1);
    expect(store.plain()).toMatchObject({ accessToken: stub.currentAccessToken });

    // A late writer holding the ciphertext from before the refresh is turned away: zero rows affected.
    await expect(
      store.swap(SOURCE_ID, originalEnc, '{"v":1,"kind":"oauth","accessToken":"old","refreshToken":"old","botId":"b","workspaceId":"w"}'),
    ).resolves.toBe(false);
    expect(store.plain()).toMatchObject({ accessToken: stub.currentAccessToken });
  });

  it('refuses a second refresh with a spent refresh token, which is what makes the lock necessary', async () => {
    const { store } = connect();
    const oldRefresh = stub.currentRefreshToken;
    await refreshAccessToken(settings(), oldRefresh);
    await expect(refreshAccessToken(settings(), oldRefresh)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(store.enc).not.toBeNull();
  });

  it('syncs a workspace through the same client after a refresh', async () => {
    const { store, row } = connect();
    stub.pages = [
      { id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', title: 'Handbook', lastEdited: '2026-10-01T10:00:00.000Z', paragraphs: ['Rotate the keys.'] },
    ];
    stub.expireAccessToken();
    const driver = driverFor({ ...row, id: '00000000-0000-4000-8000-0000000000b2' }, store);
    const result = await driver.sync();
    expect(result.note).toContain('1 pages');
    const files = await fs.readdir(sourceCurrentDir(dataDir, PROJECT_ID, '00000000-0000-4000-8000-0000000000b2'));
    expect(files).toEqual(['handbook--aaaaaaaa.md']);
  });
});

describe('the API base URL seam', () => {
  it('only ever points at a loopback address, so the client secret cannot be steered to another host', () => {
    expect(() => overrideNotionApiBaseUrlForTests('https://evil.example.com')).toThrow(/loopback/);
    expect(() => overrideNotionApiBaseUrlForTests('http://203.0.113.7:80')).toThrow(/loopback/);
    expect(() => overrideNotionApiBaseUrlForTests(stub.url)).not.toThrow();
  });
});

describe('(b) a refresh token Notion no longer accepts', () => {
  it('ends the run in error, asks for a Reconnect, and leaves the stored secret as it was', async () => {
    const { store, row } = connect();
    stub.revokeEverything();
    const before = store.enc;
    const driver = driverFor(row, store);
    const failure = await driver.sync().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Reconnect/);
    expect(store.enc).toBe(before);
    expect(store.swaps).toBe(0);
  });

  it('does not keep asking Notion once it knows the connection is dead', async () => {
    const { store, row } = connect();
    stub.revokeEverything();
    const driver = driverFor(row, store);
    const grantsBefore = stub.refreshGrants;
    await expect(driver.test()).rejects.toThrow(/Reconnect/);
    await expect(driver.test()).rejects.toThrow(/Reconnect/);
    expect(stub.refreshGrants - grantsBefore).toBe(1);
  });

  it('says what is missing when the client id and secret were removed since the source was connected', async () => {
    const { store, row } = connect();
    stub.expireAccessToken();
    await expect(driverFor(row, store, false).test()).rejects.toThrow(/NOTION_OAUTH_CLIENT_ID/);
    expect(store.swaps).toBe(0);
  });

  it('asks for a Reconnect when the new tokens could not be saved, because the old refresh token is spent', async () => {
    const { store, row } = connect();
    stub.expireAccessToken();
    store.swap = async () => false;
    await expect(driverFor(row, store).test()).rejects.toThrow(/Reconnect/);
  });
});

describe('(b2) a refresh that fails for a passing reason must not look like pages that are gone', () => {
  const HOME_ID = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
  const CHILD_ID = '11112222333344445555666677778888';
  const SYNC_SOURCE_ID = '00000000-0000-4000-8000-0000000000d2';

  it('fails the run, and removes no file, when the token endpoint is down in the middle of the walk', async () => {
    const { store, row } = connect();
    stub.pages = [
      { id: HOME_ID, title: 'Home', lastEdited: '2026-10-01T10:00:00.000Z', paragraphs: ['Top.'] },
      { id: CHILD_ID, title: 'Child', lastEdited: '2026-10-02T10:00:00.000Z', paragraphs: ['Nested.'], parentId: HOME_ID },
    ];
    const rooted = { ...row, id: SYNC_SOURCE_ID, config: { rootIds: [HOME_ID], extensions: ['md'] } } as DocumentSourceRow;
    const dir = sourceCurrentDir(dataDir, PROJECT_ID, SYNC_SOURCE_ID);
    const listing = async () => (await fs.readdir(dir, { recursive: true })).sort();

    await driverFor(rooted, store).sync();
    const before = await listing();
    expect(before.filter((f) => f.endsWith('.md'))).toHaveLength(2);

    // The second walk is refused after reading the root and its list of children, and Notion's token endpoint is down.
    stub.expireAccessTokenAfter(2);
    stub.tokenFailureStatus = 503;
    try {
      const failure = await driverFor(rooted, store)
        .sync()
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/could not be refreshed/);
    } finally {
      stub.tokenFailureStatus = null;
    }
    // The nested page was not reached, and its file is still there: an unreachable page is not a deleted one.
    expect(await listing()).toEqual(before);
    // It is not a verdict on the connection either: the stored pair is untouched and the next run recovers.
    await expect(driverFor(rooted, store).sync()).resolves.toMatchObject({ note: expect.stringContaining('2 pages') });
    expect(await listing()).toEqual(before);
  });

  it('fails the same way when the stored credential cannot be read while refreshing', async () => {
    const { store, row } = connect();
    stub.expireAccessToken();
    store.read = async () => {
      throw new Error('connection terminated');
    };
    await expect(driverFor(row, store).test()).rejects.toThrow(/could not be refreshed/);
  });
});

describe('the internal token path is untouched', () => {
  it('builds a plain client from a bare token: Bearer <token> to api.notion.com, no OAuth endpoint', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ object: 'user', type: 'bot', name: 'Plain bot' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const driver = new NotionDriver(
        sourceRow('ntn_not-a-real-token-only-a-test'),
        {
          db: null as never,
          log,
          config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: 'k'.repeat(64), ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] },
        },
        undefined,
        new MemoryStore(null),
      );
      await expect(driver.test()).resolves.toBe('Connected as Plain bot');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual([{ url: 'https://api.notion.com/v1/users/me', authorization: 'Bearer ntn_not-a-real-token-only-a-test' }]);
  });
});

describe('(c) startup refusal', () => {
  const base = { DATABASE_URL: 'postgres://unused/unused' };
  const SECRET_KEY = 'k'.repeat(64);

  /** The error text a refused startup prints, or `null` when the configuration loads. */
  function startup(env: Record<string, string>): string | null {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      loadConfig({ ...base, ...env });
      return null;
    } catch {
      return error.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  }

  it('refuses a client id without its secret, and the secret without its id', () => {
    expect(startup({ NOTION_OAUTH_CLIENT_ID: 'id', PUBLIC_BASE_URL: 'https://docs.example.com', SECRET_KEY })).toContain(
      'NOTION_OAUTH_CLIENT_SECRET',
    );
    expect(startup({ NOTION_OAUTH_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://docs.example.com', SECRET_KEY })).toContain('NOTION_OAUTH_CLIENT_ID');
  });

  it('refuses both being set when there is neither a redirect URI nor a PUBLIC_BASE_URL', () => {
    expect(startup({ NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 's', SECRET_KEY })).toContain('NOTION_OAUTH_REDIRECT_URI');
  });

  it('refuses both being set when there is no SECRET_KEY to store the tokens with, and names it', () => {
    expect(startup({ NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://docs.example.com' })).toContain(
      'SECRET_KEY',
    );
  });

  it('starts when the flow is configured completely, with either way of naming the redirect', () => {
    expect(
      startup({ NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://docs.example.com', SECRET_KEY }),
    ).toBeNull();
    expect(
      startup({
        NOTION_OAUTH_CLIENT_ID: 'id',
        NOTION_OAUTH_CLIENT_SECRET: 's',
        NOTION_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/sources/notion/oauth/callback',
        SECRET_KEY,
      }),
    ).toBeNull();
  });

  it('changes nothing when the flow is off, with or without a SECRET_KEY', () => {
    expect(startup({})).toBeNull();
    expect(startup({ SECRET_KEY })).toBeNull();
  });
});

describe('(e) the API cannot write the OAuth format', () => {
  const OAUTH_LOOKING = '{"v":1,"kind":"oauth","accessToken":"x","refreshToken":"y","botId":"b","workspaceId":"w"}';

  /** `createSource`/`updateSource` refuse before they touch the database; this one fails loudly if they do not. */
  const untouchedDb = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('the database was touched');
      },
    },
  ) as never;
  const opts = { allowedRoots: [], keys: KEYS };

  it('refuses a new Notion source whose secret starts with "{", even after whitespace', async () => {
    for (const secret of [OAUTH_LOOKING, `  \n${OAUTH_LOOKING}`]) {
      const failure = await createSource(untouchedDb, PROJECT_ID, { type: 'notion', name: 'wiki', secret }, opts).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ValidationError);
      expect((failure as Error).message).toContain('Connect with Notion');
    }
  });

  it('refuses the same on an update, and leaves the row alone', async () => {
    const existing = sourceRow('ntn_not-a-real-token-only-a-test');
    const calls: string[] = [];
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      update: () => {
        calls.push('update');
        throw new Error('the row was written');
      },
    } as never;
    const failure = await updateSource(db, PROJECT_ID, SOURCE_ID, { secret: OAUTH_LOOKING }, opts).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ValidationError);
    expect(calls).toEqual([]);
  });

  it('still takes an ordinary integration token', async () => {
    const existing = sourceRow(null);
    let written: Record<string, unknown> | undefined;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          written = patch;
          return { where: () => ({ returning: async () => [{ ...existing, ...patch }] }) };
        },
      }),
    } as never;
    await updateSource(db, PROJECT_ID, SOURCE_ID, { secret: 'ntn_not-a-real-token-only-a-test' }, opts);
    expect(isEncryptedSecret(String(written?.secretEnc))).toBe(true);
  });
});

describe('the workspace of an OAuth source is the OAuth route\u2019s to write, and only its', () => {
  const opts = { allowedRoots: [], keys: KEYS };
  const INFO = { workspaceId: 'ws-1', workspaceName: 'Acme Docs', botId: 'bot-1' };
  const FORGED = { workspaceId: 'x', workspaceName: 'Forged', botId: 'y' };

  /** A database that remembers what an insert or an update wrote, and answers a select with `existing`. */
  function recordingDb(existing: DocumentSourceRow | null) {
    const written: { inserted?: Record<string, unknown>; updated?: Record<string, unknown> } = {};
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (existing ? [existing] : []) }) }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          written.inserted = v;
          return { returning: async () => [{ id: SOURCE_ID, ...v }] };
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          written.updated = v;
          return { where: () => ({ returning: async () => [{ ...existing, ...v }] }) };
        },
      }),
    } as never;
    return { db, written };
  }
  const stored = (config: Record<string, unknown>, secret: string | null = '{"v":1}'): DocumentSourceRow => ({ ...sourceRow(secret), config });

  it('drops a client\u2019s config.oauth on create, and keeps the callback\u2019s', async () => {
    const forged = recordingDb(null);
    await createSource(forged.db, PROJECT_ID, { type: 'notion', name: 'wiki', config: { rootIds: [], oauth: FORGED } }, opts);
    expect(forged.written.inserted?.config).not.toHaveProperty('oauth');

    const trusted = recordingDb(null);
    await createSource(trusted.db, PROJECT_ID, { type: 'notion', name: 'wiki', config: { rootIds: [], oauth: FORGED }, oauth: INFO }, opts);
    expect(trusted.written.inserted?.config).toMatchObject({ oauth: INFO });
  });

  it('ignores a client\u2019s config.oauth on update, whether the source is connected or not', async () => {
    const plain = recordingDb(stored({ rootIds: [], extensions: ['md'] }, 'ntn_not-a-real-token-only-a-test'));
    await updateSource(plain.db, PROJECT_ID, SOURCE_ID, { config: { oauth: FORGED } }, opts);
    expect(plain.written.updated?.config).not.toHaveProperty('oauth');

    const connected = recordingDb(stored({ rootIds: [], extensions: ['md'], oauth: INFO }));
    await updateSource(connected.db, PROJECT_ID, SOURCE_ID, { config: { oauth: FORGED } }, opts);
    expect(connected.written.updated?.config).toMatchObject({ oauth: INFO });
    // An edit that does not mention it keeps it too: the dashboard sends the config it built from its form.
    const resaved = recordingDb(stored({ rootIds: [], extensions: ['md'], oauth: INFO }));
    await updateSource(resaved.db, PROJECT_ID, SOURCE_ID, { config: { rootIds: ['a'.repeat(32)] } }, opts);
    expect(resaved.written.updated?.config).toMatchObject({ oauth: INFO });
  });

  it('lets the OAuth route set it on a reconnect, and forgets the probe token of the workspace it replaces', async () => {
    const reconnect = recordingDb(stored({ rootIds: [], extensions: ['md'], oauth: FORGED, syncProbeToken: 'edited=2026-10-01' }));
    await updateSource(reconnect.db, PROJECT_ID, SOURCE_ID, { oauth: INFO }, opts);
    expect(reconnect.written.updated?.config).toMatchObject({ oauth: INFO });
    expect(reconnect.written.updated?.config).not.toHaveProperty('syncProbeToken');
  });

  it('forgets the workspace when a pasted token replaces, or removes, the OAuth credential', async () => {
    for (const secret of ['ntn_not-a-real-token-only-a-test', null]) {
      const swap = recordingDb(stored({ rootIds: [], extensions: ['md'], oauth: INFO }));
      await updateSource(swap.db, PROJECT_ID, SOURCE_ID, { secret }, opts);
      expect(swap.written.updated?.config, String(secret)).not.toHaveProperty('oauth');
      // The rest of the settings are as they were.
      expect(swap.written.updated?.config).toMatchObject({ rootIds: [], extensions: ['md'] });
    }
  });

  it('leaves another type\u2019s config alone', async () => {
    const web = recordingDb(null);
    await createSource(web.db, PROJECT_ID, { type: 'web', name: 'site', config: { entryUrl: 'https://docs.example.com/sitemap.xml' } }, opts);
    expect(web.written.inserted?.config).toMatchObject({ entryUrl: 'https://docs.example.com/sitemap.xml' });
  });
});

describe('(d) who may start and finish the flow, without a database', () => {
  let app: FastifyInstance;
  const configured = {
    NOTION_OAUTH_CLIENT_ID: 'id',
    NOTION_OAUTH_CLIENT_SECRET: 's',
    NOTION_OAUTH_REDIRECT_URI: REDIRECT,
    SECRET_KEY: 'k'.repeat(64),
    ALLOWED_DOC_ROOTS: ['/docs'],
    AUTH_COOKIE_SECURE: '0',
    SYNC_DEFAULT_INTERVAL_MINUTES: 0,
  };

  const principals: Record<string, Principal> = {
    admin: { kind: 'token', role: 'root', userId: null, username: 'ADMIN_TOKEN', mustChangePassword: false },
    api: {
      kind: 'apiToken',
      role: 'admin',
      userId: 'u1',
      username: 't · u',
      tokenId: 't1',
      scope: ['POST /api/projects/:id/sources/notion/oauth'],
      projectId: null,
      mustChangePassword: false,
    },
    editor: { kind: 'session', role: 'member', userId: 'u1', username: 'dana', sessionId: 'session-1', mustChangePassword: false },
  };

  beforeEach(async () => {
    app = Fastify();
    await app.register(cookie);
    // Stands in for the policy layer: the principal comes from a header; the rules under test are the handlers' own.
    app.addHook('onRequest', async (req) => {
      const name = req.headers['x-principal'];
      req.principal = typeof name === 'string' ? (principals[name] ?? null) : null;
    });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.code });
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.code });
      if (err instanceof ValidationError) return reply.code(400).send({ error: 'invalid_request', message: err.message });
      return reply.code(500).send({ error: 'unexpected', message: String(err) });
    });
    const ctx = {
      config: configured,
      db: untouchedDbForRoutes(),
      log,
      indexer: { enqueue: vi.fn() },
      audit: { record: vi.fn() },
    } as unknown as AppContext;
    await app.register(notionOAuthRoutes, { ctx });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  function untouchedDbForRoutes(): unknown {
    return new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('the database was touched');
        },
      },
    );
  }

  const flowCookie = (over: Record<string, unknown> = {}): string =>
    `${NOTION_OAUTH_FLOW_COOKIE}=${Buffer.from(
      JSON.stringify({
        state: 'the-state',
        projectId: PROJECT_ID,
        sessionId: 'session-1',
        expiresAt: Date.now() + 60_000,
        create: { name: 'wiki', rootIds: [] },
        ...over,
      }),
    ).toString('base64url')}`;

  it('turns away ADMIN_TOKEN and an API token at the start, whatever their scope says', async () => {
    for (const who of ['admin', 'api']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/sources/notion/oauth`,
        headers: { 'x-principal': who },
        payload: { name: 'wiki' },
      });
      expect(res.statusCode, who).toBe(403);
      expect(res.headers['set-cookie'], who).toBeUndefined();
    }
  });

  it('answers 404 for both routes when the flow is not configured, and the panel is told so', async () => {
    const off = Fastify();
    await off.register(cookie);
    off.addHook('onRequest', async (req) => {
      req.principal = principals.editor;
    });
    off.setErrorHandler((err, _req, reply) => reply.code((err as { name?: string }).name === 'NotFoundError' ? 404 : 500).send({}));
    await off.register(notionOAuthRoutes, {
      ctx: { config: { ALLOWED_DOC_ROOTS: [] }, db: {}, log, indexer: {}, audit: {} } as unknown as AppContext,
    });
    await off.ready();
    expect((await off.inject({ method: 'GET', url: '/api/sources/notion/oauth' })).json()).toEqual({ enabled: false });
    expect(
      (await off.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/sources/notion/oauth`, payload: { name: 'wiki' } })).statusCode,
    ).toBe(404);
    expect((await off.inject({ method: 'GET', url: '/api/sources/notion/oauth/callback?code=c&state=s' })).statusCode).toBe(404);
    await off.close();
  });

  it('reports the flow as enabled when it is configured', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sources/notion/oauth', headers: { 'x-principal': 'editor' } })).json()).toEqual({
      enabled: true,
    });
  });

  it('rejects a callback with no flow cookie, a wrong state, an expired flow, and another session', async () => {
    const hit = (headers: Record<string, string>, state = 'the-state') =>
      app.inject({
        method: 'GET',
        url: `/api/sources/notion/oauth/callback?code=stub-code&state=${state}`,
        headers: { 'x-principal': 'editor', ...headers },
      });

    /** A refusal sends the browser home with a reason and **no project name**, and spends no code. */
    const refused = (res: Awaited<ReturnType<typeof hit>>, outcome: string) => {
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/?notion_oauth=${outcome}`);
      // Every refusal also clears the single-use flow cookie.
      expect(String(res.headers['set-cookie'])).toContain(`${NOTION_OAUTH_FLOW_COOKIE}=;`);
    };
    refused(await hit({}), 'expired');
    refused(await hit({ cookie: flowCookie() }, 'a-different-state'), 'expired');
    refused(await hit({ cookie: flowCookie({ expiresAt: Date.now() - 1 }) }), 'expired');
    refused(await hit({ cookie: flowCookie({ sessionId: 'someone-elses-session' }) }), 'forbidden');
  });

  it('turns away ADMIN_TOKEN and an API token at the callback', async () => {
    for (const who of ['admin', 'api']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sources/notion/oauth/callback?code=stub-code&state=the-state',
        headers: { 'x-principal': who, cookie: flowCookie() },
      });
      expect(res.statusCode, who).toBe(403);
    }
  });
});
