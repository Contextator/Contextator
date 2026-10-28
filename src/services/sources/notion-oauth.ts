import { Client } from '@notionhq/client';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Logger } from '../../context.js';
import type { Db } from '../../db/client.js';
import { decryptSecret, type SecretKeyring } from '../crypto.js';
import { KeyedMutex } from '../locks.js';
import { getSourceById, replaceSourceSecretIfUnchanged } from '../sources.js';

/**
 * Notion OAuth ([ADR-0129](../../../.ssot/ADR.md#adr-0129)): the operator's own public connection, the
 * token exchange, and the refresh a source performs when Notion refuses its access token.
 *
 * Nothing here reads `process.env` (env is read in `config.ts` only) and nothing here logs a token, a
 * code or a `state`. The functions that talk to Notion take their credentials as arguments.
 */

/** The path Notion redirects the browser back to. The default redirect URI is `<PUBLIC_BASE_URL>` + this. */
export const NOTION_OAUTH_CALLBACK_PATH = '/api/sources/notion/oauth/callback';

const DEFAULT_API_BASE_URL = 'https://api.notion.com';
const TOKEN_TIMEOUT_MS = 15_000;

let apiBaseUrlOverride: string | undefined;

/** `https://api.notion.com`, or the stub a test pointed it at. Used for the token endpoint, the authorize URL and the API client. */
export function notionApiBaseUrl(): string {
  return apiBaseUrlOverride ?? DEFAULT_API_BASE_URL;
}

/**
 * **Test seam, not a setting.** Production has one Notion and it is the default; a suite that runs a
 * stub of Notion's OAuth and API endpoints points the module at it here. `undefined` restores the default.
 *
 * Refuses anything but a loopback `http` address: this is the host the client secret is sent to over HTTP
 * Basic, so the seam can never be turned into a way of sending it somewhere else.
 */
export function overrideNotionApiBaseUrlForTests(url: string | undefined): void {
  if (url !== undefined) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('The Notion API base URL can only be overridden with a loopback http address');
    }
  }
  apiBaseUrlOverride = url?.replace(/\/+$/, '');
}

/**
 * Serialises everything that replaces one source's OAuth tokens: a driver's refresh and the reconnect
 * callback. **Keyed by source id and deliberately not the project lock** (`locks`, keyed by project id):
 * the indexer holds the project lock for the whole sync and `runExclusive` is not re-entrant, so a
 * driver that waited for its own run's lock would never come back. The price is that this is a
 * process-local lock; two replicas are outside the product's single-process model, and the
 * compare-and-swap on the ciphertext is what keeps them from overwriting each other's newer pair.
 */
export const notionOAuthLocks = new KeyedMutex();

// ---------------------------------------------------------------------------------------------
// The operator's configuration
// ---------------------------------------------------------------------------------------------

export interface NotionOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface NotionOAuthSettings extends NotionOAuthCredentials {
  redirectUri: string;
}

/** The credentials alone: all a refresh grant needs. `null` when the flow is not configured. */
export function notionOAuthCredentials(
  config: Partial<Pick<Config, 'NOTION_OAUTH_CLIENT_ID' | 'NOTION_OAUTH_CLIENT_SECRET'>>,
): NotionOAuthCredentials | null {
  const clientId = config.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = config.NOTION_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * The full settings, or `null` when "Connect with Notion" is off. The redirect URI is the pinned one or
 * `<PUBLIC_BASE_URL>/api/sources/notion/oauth/callback`; it is never built from a request, because a
 * request's host is what an attacker controls and the authorization code is sent to this address.
 */
export function notionOAuthSettings(
  config: Partial<Pick<Config, 'NOTION_OAUTH_CLIENT_ID' | 'NOTION_OAUTH_CLIENT_SECRET' | 'NOTION_OAUTH_REDIRECT_URI' | 'PUBLIC_BASE_URL'>>,
): NotionOAuthSettings | null {
  const credentials = notionOAuthCredentials(config);
  if (!credentials) return null;
  const redirectUri =
    config.NOTION_OAUTH_REDIRECT_URI ??
    (config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}${NOTION_OAUTH_CALLBACK_PATH}` : undefined);
  return redirectUri ? { ...credentials, redirectUri } : null;
}

// ---------------------------------------------------------------------------------------------
// Notion's token endpoint
// ---------------------------------------------------------------------------------------------

/**
 * A failed call to Notion's token endpoint. `code` is Notion's OAuth error code (`invalid_grant`,
 * `invalid_client`, …) or `network` / `http_<status>`; **the response body is never kept**, so nothing
 * here can carry a token or a code into a log line.
 */
export class NotionOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Notion's token endpoint refused the request (${code})`);
    this.name = 'NotionOAuthError';
  }

  /** The endpoint could not be reached or failed on its side: worth telling apart from a refusal of this grant. */
  get transient(): boolean {
    return this.code === 'network' || (this.status !== undefined && this.status >= 500);
  }
}

/**
 * Anything that goes wrong while an OAuth source's access token is being replaced. **A common base so the
 * driver can tell "the credential could not be made to work" from "this one page is not accessible"**: its
 * discovery code swallows the second kind to keep going, and swallowing the first would drop every page the
 * rest of the walk did not reach — and the sync would then delete their files.
 */
export class NotionAuthFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotionAuthFailure';
  }
}

/** The connection can no longer act: the user revoked it or Notion no longer honours its refresh token. The remedy is the same flow again. */
export class NotionReconnectRequired extends NotionAuthFailure {
  constructor(detail?: string) {
    super(
      `The Notion connection was revoked or has expired${detail ? ` (${detail})` : ''}. ` +
        'Open this source in the dashboard and press Reconnect to authorise it again.',
    );
    this.name = 'NotionReconnectRequired';
  }
}

/** The refresh could not be completed for a reason that is not the connection's fault (Notion or the database was unavailable, the client credentials were removed). The run fails; the next one tries again. */
export class NotionRefreshFailed extends NotionAuthFailure {
  constructor(detail: string) {
    super(
      `The Notion access token was refused and could not be refreshed: ${detail}. The sync was stopped so that nothing is removed; the next run will try again.`,
    );
    this.name = 'NotionRefreshFailed';
  }
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullish(),
  bot_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_name: z.string().nullish(),
});
export type NotionTokenGrant = z.infer<typeof TokenResponse>;

const ERROR_CODE_RE = /^[a-z_]{1,64}$/;

function errorCodeOf(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).code;
    if (typeof candidate === 'string' && ERROR_CODE_RE.test(candidate)) return candidate;
  }
  return `http_${status}`;
}

async function tokenRequest(credentials: NotionOAuthCredentials, body: Record<string, string>): Promise<NotionTokenGrant> {
  let res: Response;
  try {
    res = await fetch(`${notionApiBaseUrl()}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'notion-version': Client.defaultNotionVersion,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new NotionOAuthError('network');
  }
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new NotionOAuthError(errorCodeOf(json, res.status), res.status);
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw new NotionOAuthError('invalid_response', res.status);
  return parsed.data;
}

/** The URL the browser is sent to so that the person can pick the pages Contextator may read. */
export function buildNotionAuthorizeUrl(settings: NotionOAuthSettings, state: string): string {
  const url = new URL(`${notionApiBaseUrl()}/v1/oauth/authorize`);
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export function exchangeAuthorizationCode(settings: NotionOAuthSettings, code: string): Promise<NotionTokenGrant> {
  return tokenRequest(settings, { grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri });
}

/** Rotating: the response carries a new refresh token and the old one stops working. */
export function refreshAccessToken(credentials: NotionOAuthCredentials, refreshToken: string): Promise<NotionTokenGrant> {
  return tokenRequest(credentials, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

// ---------------------------------------------------------------------------------------------
// What `secret_enc` holds for an OAuth source
// ---------------------------------------------------------------------------------------------

const OAuthSecret = z.object({
  v: z.literal(1),
  kind: z.literal('oauth'),
  accessToken: z.string().min(1),
  /** Empty when Notion issued none; a refresh then ends in a Reconnect. */
  refreshToken: z.string(),
  botId: z.string(),
  workspaceId: z.string(),
});
export type NotionOAuthSecret = z.infer<typeof OAuthSecret>;

/** An internal integration token never starts with `{`; the stored OAuth document always does (ADR-0129 §4). */
export const isOAuthSecret = (plain: string): boolean => plain.startsWith('{');

export function serializeOAuthSecret(secret: NotionOAuthSecret): string {
  return JSON.stringify(secret);
}

export function parseOAuthSecret(plain: string): NotionOAuthSecret {
  let json: unknown;
  try {
    json = JSON.parse(plain);
  } catch {
    throw new NotionReconnectRequired('the stored credential is unreadable');
  }
  const parsed = OAuthSecret.safeParse(json);
  if (!parsed.success) throw new NotionReconnectRequired('the stored credential is unreadable');
  return parsed.data;
}

export function oauthSecretFromGrant(grant: NotionTokenGrant): NotionOAuthSecret {
  return {
    v: 1,
    kind: 'oauth',
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token ?? '',
    botId: grant.bot_id,
    workspaceId: grant.workspace_id,
  };
}

// ---------------------------------------------------------------------------------------------
// Refresh on refusal
// ---------------------------------------------------------------------------------------------

/** The two operations on a source's ciphertext the refresh needs; a test supplies an in-memory one. */
export interface NotionSecretStore {
  /** The ciphertext now in the row, or `null` if the row has none (or is gone). */
  read(sourceId: string): Promise<string | null>;
  /** Compare-and-swap on the ciphertext; `false` means the row moved first and nothing was written. */
  swap(sourceId: string, expectedEnc: string | null, plain: string): Promise<boolean>;
}

export function databaseSecretStore(db: Db, keys: SecretKeyring): NotionSecretStore {
  return {
    read: async (sourceId) => (await getSourceById(db, sourceId))?.secretEnc ?? null,
    swap: (sourceId, expectedEnc, plain) => replaceSourceSecretIfUnchanged(db, sourceId, expectedEnc, plain, keys),
  };
}

export interface NotionOAuthSessionOptions {
  sourceId: string;
  /** The pair the driver read from the row when it was built. */
  secret: NotionOAuthSecret;
  keys: SecretKeyring;
  /** `null` when the operator removed the client id/secret since the source was connected. */
  credentials: NotionOAuthCredentials | null;
  store: NotionSecretStore;
  log: Logger;
}

/**
 * One OAuth source's tokens for the length of one driver, and the `fetch` the Notion client is built on.
 *
 * The client's own request path stays as it is: every request carries the current access token; when
 * Notion answers `401`, the tokens are refreshed once and **that request** is sent again. A refresh is
 * therefore invisible to the discovery, throttling and rendering code above it.
 *
 * Refreshing follows [ADR-0129](../../../.ssot/ADR.md#adr-0129) §5: under the source's lock the row is
 * read again, and if another run (or a reconnect) already replaced the tokens, those are used; otherwise
 * the refresh grant runs and the new pair is written with a compare-and-swap on the ciphertext that was
 * read. A refresh token is single-use, so the failure that cannot be recovered from is a pair that was
 * obtained and could not be saved; it ends the run asking for a Reconnect.
 */
export class NotionOAuthSession {
  private current: NotionOAuthSecret;
  /** Once the connection is known to be dead, every later request of this session fails the same way without another round trip. */
  private dead: NotionReconnectRequired | null = null;

  constructor(private readonly options: NotionOAuthSessionOptions) {
    this.current = options.secret;
  }

  get accessToken(): string {
    return this.current.accessToken;
  }

  /** Handed to `new Client({ fetch })`. */
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.dead) throw this.dead;
    const used = this.current.accessToken;
    const first = await this.send(input, init, used);
    if (first.status !== 401) return first;
    // The refused answer is replaced by the retry's; release its connection instead of leaving the body unread.
    await first.body?.cancel().catch(() => undefined);
    const next = await this.refresh(used);
    return this.send(input, init, next);
  };

  private send(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], token: string): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return globalThis.fetch(input, { ...init, headers });
  }

  private fail(reason: string): never {
    this.dead = new NotionReconnectRequired(reason);
    throw this.dead;
  }

  /** The access token to retry with. `failedToken` is the one Notion just refused. Fails only with a {@link NotionAuthFailure}. */
  private refresh(failedToken: string): Promise<string> {
    return notionOAuthLocks.runExclusive(this.options.sourceId, async () => {
      try {
        return await this.refreshLocked(failedToken);
      } catch (err) {
        if (err instanceof NotionAuthFailure) throw err;
        // A database error, an undecryptable row: not a verdict on the connection, but not something to carry on past either.
        this.options.log.error({ err, sourceId: this.options.sourceId }, 'notion oauth refresh failed unexpectedly');
        throw new NotionRefreshFailed('an unexpected error occurred');
      }
    });
  }

  private async refreshLocked(failedToken: string): Promise<string> {
    const { sourceId, keys, credentials, store, log } = this.options;
    if (this.dead) throw this.dead;
    // A request of this session that waited for the lock may find the work already done.
    if (this.current.accessToken !== failedToken) return this.current.accessToken;

    const enc = await store.read(sourceId);
    if (!enc) this.fail('the source no longer holds a credential');
    let stored: NotionOAuthSecret | undefined;
    try {
      const plain = decryptSecret(enc, keys);
      stored = isOAuthSecret(plain) ? parseOAuthSecret(plain) : undefined;
    } catch (err) {
      if (!(err instanceof NotionReconnectRequired)) throw err;
    }
    if (!stored) this.fail('the source no longer holds an OAuth credential');
    // Another run replaced the pair while this one was working: use it instead of spending the refresh token.
    if (stored.accessToken !== failedToken) {
      this.current = stored;
      return stored.accessToken;
    }

    if (!credentials) {
      throw new NotionRefreshFailed(
        'NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET are not set. Set them again, or reconnect the source with an integration token',
      );
    }
    if (!stored.refreshToken) this.fail('Notion issued no refresh token for this connection');

    let grant: NotionTokenGrant;
    try {
      grant = await refreshAccessToken(credentials, stored.refreshToken);
    } catch (err) {
      if (err instanceof NotionOAuthError) {
        if (err.code === 'invalid_grant') this.fail('Notion no longer accepts the refresh token');
        log.warn({ sourceId, code: err.code, status: err.status }, 'notion oauth refresh failed');
        throw new NotionRefreshFailed(`Notion's token endpoint answered ${err.code}`);
      }
      throw err;
    }

    const next: NotionOAuthSecret = { ...stored, accessToken: grant.access_token, refreshToken: grant.refresh_token ?? stored.refreshToken };
    let swapped: boolean;
    try {
      swapped = await store.swap(sourceId, enc, serializeOAuthSecret(next));
    } catch (err) {
      log.error({ err, sourceId }, 'notion oauth tokens were refreshed but could not be saved');
      this.fail('the refreshed tokens could not be saved');
    }
    if (!swapped) {
      // The old refresh token is spent and someone else's write is in the row: nothing here can be trusted to be current.
      log.warn({ sourceId }, 'notion oauth tokens were refreshed but the source changed first');
      this.fail('the source changed while its tokens were being refreshed');
    }
    this.current = next;
    return next.accessToken;
  }
}
