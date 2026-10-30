import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { z } from 'zod';
import type { EgressFetch } from './confluence-egress.js';
import { EgressRefusedError } from './confluence-egress.js';
import { defineSecretBlob, SECRET_BLOB_MAX_BYTES, SecretBlobError, type SecretBlob } from './secret-blob.js';

/**
 * The Google Drive v3 surface the `gdrive` source uses, and the service account sign-in it needs, with no
 * Google client library ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 3): the JWT bearer grant
 * (RFC 7523, RS256 with `node:crypto`), an in-memory token cache, and `files.get`, `files.list`,
 * `files.export`, `changes.getStartPageToken` and `changes.list` over an egress fetch the caller built.
 *
 * **The transport is injected, never `fetch`, and it is pinned.** The driver builds it with
 * `pinnedHosts` set to {@link GOOGLE_HOSTS}: a request, or a redirect hop, to any other host is refused
 * before a socket is opened, so the access token cannot be led off Google's hosts by a redirect and a
 * key file's own `token_uri` is never read ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decisions 2 and 4).
 *
 * **Retries** (decision 9): `429`, `403` with `rateLimitExceeded`/`userRateLimitExceeded`, `5xx` and a
 * network error are tried up to five more times with a jittered exponential back-off that honours
 * `Retry-After`. Every throttling answer (`429`, the two `403`s), retried or not, is reported to
 * `onThrottled`. An egress refusal is the guard's verdict and is never retried.
 *
 * Nothing here puts a credential into an error: Google's `error`, `reason` and `message` are quoted
 * (truncated); the key, the assertion and the access token are not.
 */

// ---------------------------------------------------------------------------------------------------
// Fixed addresses
// ---------------------------------------------------------------------------------------------------

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_API_BASE = 'https://www.googleapis.com/drive/v3';
/** The only hosts a `gdrive` request may reach ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 4). */
export const GOOGLE_HOSTS: readonly string[] = ['oauth2.googleapis.com', 'www.googleapis.com'];

export interface GdriveEndpoints {
  tokenUrl: string;
  apiBase: string;
}
export const GOOGLE_ENDPOINTS: GdriveEndpoints = { tokenUrl: GOOGLE_TOKEN_URL, apiBase: GOOGLE_API_BASE };

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/** What a Google-native file is exported as, and the extension the exported file is stored under. */
export interface ExportFormat {
  mimeType: string;
  extension: 'md' | 'xlsx' | 'pptx';
}
/** Docs, Sheets and Slides ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 6); every other Google-native type is skipped. */
export const EXPORT_FORMATS: Readonly<Record<string, ExportFormat>> = {
  'application/vnd.google-apps.document': { mimeType: 'text/markdown', extension: 'md' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
  },
};
/** `files.export` returns at most this much; the disk check counts an export as this ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 7). */
export const EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;

export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_NATIVE_PREFIX);
}

// ---------------------------------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------------------------------

function opensAsRsaKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/**
 * The stored shape: `{"v":1,"clientEmail":…,"privateKeyId":…,"privateKey":…}`
 * ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 2). Strict: nothing else of a key file is kept.
 */
const Stored = z
  .object({
    v: z.literal(1),
    clientEmail: z
      .string()
      .min(3)
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+$/, 'must be the service account’s e-mail address'),
    privateKeyId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/, 'must be the key id Google issued'),
    privateKey: z.string().min(1).max(8192),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!opensAsRsaKey(value.privateKey)) ctx.addIssue({ code: 'custom', path: ['privateKey'], message: 'must be an RSA private key in PEM form' });
  });

const stored = defineSecretBlob({ type: 'gdrive', schema: Stored });
export type GdriveSecret = ReturnType<typeof stored.parse>;

/** The fields of Google's key file this product reads, by the names Google gives them. */
const KEY_FILE_FIELDS = ['client_email', 'private_key_id', 'private_key'] as const;

/**
 * The `secret_enc` document of a `gdrive` source. What the API receives as `secret` is **the key file Google
 * issues** (`{"type":"service_account","private_key":…,"client_email":…,…}`); `canonicalize` keeps three of its
 * fields, checks that the key opens, and returns the document above. Every other field — `token_uri` first
 * among them — is dropped, not stored. The stored document itself is accepted too, so a value read back and
 * submitted again is not refused. Errors name a field and a rule, never a value.
 */
export const GDRIVE_SECRET: SecretBlob<GdriveSecret> = {
  type: 'gdrive',
  parse: stored.parse,
  serialize: stored.serialize,
  canonicalize(raw: string): string {
    if (Buffer.byteLength(raw, 'utf8') > SECRET_BLOB_MAX_BYTES) {
      throw new SecretBlobError(`The gdrive credential is too large (over ${SECRET_BLOB_MAX_BYTES} bytes)`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately not `err.message`: V8 quotes the text around the fault.
      throw new SecretBlobError('The gdrive credential must be the JSON key file of a Google service account');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SecretBlobError('The gdrive credential must be the JSON key file of a Google service account');
    }
    const file = parsed as Record<string, unknown>;
    if ('v' in file) return stored.canonicalize(raw);
    if (file.type !== 'service_account') {
      throw new SecretBlobError(
        'The gdrive credential must be a service account key file ("type": "service_account"); user OAuth credentials are not supported',
        ['type'],
      );
    }
    for (const field of KEY_FILE_FIELDS) {
      if (typeof file[field] !== 'string' || file[field] === '') {
        throw new SecretBlobError(`The gdrive credential is invalid: ${field}: must be a non-empty string`, [field]);
      }
    }
    return stored.serialize({
      v: 1,
      clientEmail: file.client_email,
      privateKeyId: file.private_key_id,
      privateKey: file.private_key,
    });
  },
};

// ---------------------------------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------------------------------

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** RS256 over `header.claims`, per RFC 7523 / Google's service account flow. `sub` is never set (decision 1). */
function signAssertion(secret: GdriveSecret, audience: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: secret.privateKeyId }));
  const claims = base64url(JSON.stringify({ iss: secret.clientEmail, scope: GDRIVE_SCOPE, aud: audience, iat, exp: iat + 3600 }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(createPrivateKey(secret.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  /** When it stops being used: 60 s before Google says it expires. */
  usableUntil: number;
}
/**
 * Access tokens, in this process's memory and nowhere else, keyed by (service account, key id, token
 * endpoint). A driver is built per probe and per run, so the cache outlives it: idle, a source costs at
 * most one token request an hour ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 5).
 */
const tokenCache = new Map<string, CachedToken>();
const tokenInFlight = new Map<string, Promise<string>>();

/** Forgets every cached token. For tests; production never needs it. */
export function clearGdriveTokenCache(): void {
  tokenCache.clear();
  tokenInFlight.clear();
}

// ---------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------

/** What Google said no with. `reason` is the first `errors[].reason` of the answer, e.g. `notFound`, `rateLimitExceeded`. */
export class GdriveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | undefined,
  ) {
    super(message);
    this.name = 'GdriveRequestError';
  }
}

/** Google refused the service account key at the token endpoint (a deleted key, a wrong clock, a disabled account). */
export class GdriveAuthError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'GdriveAuthError';
  }
}

const clip = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

// ---------------------------------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------------------------------

/** The most a listing page may weigh: 1 000 files with long names and links is about 1 MB. */
export const MAX_LISTING_BYTES = 8 * 1024 * 1024;
/** An error answer is only quoted, never needed whole. */
const ERROR_BODY_BYTES = 4000;
/** A token answer is a few hundred bytes; an access token itself can reach about 2 KB. */
const TOKEN_BODY_BYTES = 64 * 1024;

async function readBounded(response: Response, limit: number, onExceeded: 'throw' | 'truncate'): Promise<string> {
  const stream = response.body;
  if (!stream) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        if (onExceeded === 'throw') throw new Error(`the answer is larger than ${limit} bytes`);
        chunks.push(value.subarray(0, value.byteLength - (received - limit)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// ---------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------

/** One entry of a folder listing, as `files.list` answers for it. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes; `null` for a Google-native file, which has none until exported. */
  size: number | null;
  version: string | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
}

export interface DriveFolder {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
}

export interface GdriveClientOptions {
  /** The egress, pinned to {@link GOOGLE_HOSTS}; the one thing that decides where a request may go. */
  fetch: EgressFetch;
  /** Test seam: where the token and API requests go. Production leaves it unset (Google's own addresses). */
  endpoints?: GdriveEndpoints;
  now?: () => number;
  /** Retries after the first attempt (default 5, [ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 9). */
  retries?: number;
  /** Back-off unit: retry *n* waits about this × 2^(n-1), jittered (default 500 ms). */
  retryDelayMs?: number;
  random?: () => number;
  /** Called once per throttling answer, retried or not. */
  onThrottled?: () => void;
}

/** A longer wait than this is not honoured, whatever `Retry-After` says: the run would look hung. */
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const PAGE_SIZE = 1000;
const FILE_FIELDS = 'id,name,mimeType,size,version,md5Checksum,modifiedTime,webViewLink';

export class GdriveClient {
  private readonly endpoints: GdriveEndpoints;
  private readonly now: () => number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly random: () => number;
  private readonly cacheKey: string;
  /** Requests sent, token requests included; the probe logs it ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 5). */
  requests = 0;

  constructor(
    private readonly secret: GdriveSecret,
    private readonly options: GdriveClientOptions,
  ) {
    this.endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
    this.now = options.now ?? Date.now;
    this.retries = options.retries ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.random = options.random ?? Math.random;
    // **The key itself is part of the identity.** The e-mail and the key id are not secrets (the first is shown in
    // the panel, the second travels in every JWT header and is listable in GCP), so a cache keyed by them alone
    // would hand one project's access token to any other project that pasted the same two values with a key of
    // its own. The digest of the *public* half proves possession of the matching private key without the key
    // material, or a digest of it, sitting in a map key.
    const publicDer = createPublicKey(createPrivateKey(secret.privateKey)).export({ type: 'spki', format: 'der' });
    this.cacheKey = createHash('sha256')
      .update(`${secret.clientEmail}\n${secret.privateKeyId}\n${this.endpoints.tokenUrl}\n`)
      .update(publicDer)
      .digest('hex');
  }

  get serviceAccountEmail(): string {
    return this.secret.clientEmail;
  }

  // -- transport --------------------------------------------------------------------------------------

  private waitFor(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null) {
      const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - this.now()) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    }
    const base = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * One request with the retry policy of decision 9. `build` runs for every attempt (an assertion is signed
   * fresh, a token re-read after a `401` dropped it). Returns a 2xx response; anything else is raised as the
   * error `failure` makes of it.
   */
  private async perform(
    what: string,
    build: () => Promise<{ url: string; init: Parameters<EgressFetch>[1] }>,
    failure: (status: number, text: string) => Error,
  ): Promise<Response> {
    let lastError: unknown;
    let reauthenticated = false;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      const { url, init } = await build();
      let response: Response;
      this.requests++;
      try {
        response = await this.options.fetch(url, init);
      } catch (err) {
        // A refusal is the guard's answer about the host, not a flaky network: say it, once.
        if (err instanceof EgressRefusedError) throw err;
        lastError = err;
        if (attempt <= this.retries) await this.sleep(this.waitFor(attempt, null));
        continue;
      }
      if (response.ok) return response;

      const text = await readBounded(response, ERROR_BODY_BYTES, 'truncate').catch(() => '');
      const error = failure(response.status, text);
      const reason = error instanceof GdriveRequestError ? error.reason : undefined;
      const throttled = response.status === 429 || (response.status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason));
      if (throttled) this.options.onThrottled?.();
      if (response.status === 401 && !reauthenticated && this.cachedToken()) {
        // A token revoked before it ran out: drop it and sign in again, once, without spending a retry.
        reauthenticated = true;
        tokenCache.delete(this.cacheKey);
        attempt--;
        continue;
      }
      if (throttled || response.status >= 500) {
        lastError = error;
        if (attempt <= this.retries) await this.sleep(this.waitFor(attempt, response.headers.get('retry-after')));
        continue;
      }
      throw error;
    }
    if (lastError instanceof GdriveRequestError || lastError instanceof GdriveAuthError) throw lastError;
    const reason = lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError);
    throw new Error(`Google Drive ${what} could not be completed: ${clip(reason)}`);
  }

  // -- sign-in ----------------------------------------------------------------------------------------

  private cachedToken(): string | null {
    const hit = tokenCache.get(this.cacheKey);
    return hit && hit.usableUntil > this.now() ? hit.token : null;
  }

  private async accessToken(): Promise<string> {
    const cached = this.cachedToken();
    if (cached) return cached;
    let pending = tokenInFlight.get(this.cacheKey);
    if (!pending) {
      pending = this.signIn().finally(() => tokenInFlight.delete(this.cacheKey));
      tokenInFlight.set(this.cacheKey, pending);
    }
    return pending;
  }

  private async signIn(): Promise<string> {
    const audience = this.endpoints.tokenUrl;
    const response = await this.perform(
      'sign-in',
      async () => {
        const assertion = signAssertion(this.secret, audience, this.now());
        const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
        return {
          url: audience,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: Buffer.from(body, 'utf8'),
          },
        };
      },
      (status, text) => this.authFailure(status, text),
    );
    const answer = jsonObject(await readBounded(response, TOKEN_BODY_BYTES, 'truncate').catch(() => ''));
    const token = str(answer?.access_token);
    if (!token) throw new GdriveAuthError('Google answered the sign-in without an access token', undefined);
    const lifetime = typeof answer?.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 3600;
    // Pruned here rather than on a timer: a map of a few service accounts, expired entries dropped on insert.
    for (const [key, entry] of tokenCache) if (entry.usableUntil <= this.now()) tokenCache.delete(key);
    tokenCache.set(this.cacheKey, { token, usableUntil: this.now() + Math.max(0, lifetime - 60) * 1000 });
    return token;
  }

  private authFailure(status: number, text: string): GdriveAuthError | GdriveRequestError {
    const answer = jsonObject(text);
    const code = str(answer?.error) ?? undefined;
    const description = str(answer?.error_description);
    if (status >= 500 || status === 429) {
      return new GdriveRequestError(`Google sign-in failed: HTTP ${status}${code ? ` ${code}` : ''}`, status, code);
    }
    const detail = clip([code, description].filter(Boolean).join(': '), 200);
    if (code === 'invalid_grant') {
      return new GdriveAuthError(
        `Google refused the service account key (${detail || 'invalid_grant'}). If the key was deleted or disabled, create a new one and replace the credential; if it is current, check this server’s clock.`,
        code,
      );
    }
    return new GdriveAuthError(`Google refused the service account key: HTTP ${status}${detail ? ` ${detail}` : ''}`, code);
  }

  // -- API --------------------------------------------------------------------------------------------

  private apiFailure(what: string): (status: number, text: string) => GdriveRequestError {
    return (status, text) => {
      const root = jsonObject(text);
      const record = typeof root?.error === 'object' && root.error !== null ? (root.error as Record<string, unknown>) : null;
      const first = Array.isArray(record?.errors) ? (record.errors[0] as Record<string, unknown> | undefined) : undefined;
      const reason = str(first?.reason) ?? str(record?.status) ?? undefined;
      const message = str(record?.message) ?? '';
      if (
        status === 403 &&
        (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(message))
      ) {
        return new GdriveRequestError(
          `Google Drive ${what} failed: the Drive API is not enabled in the service account’s Google Cloud project; enable “Google Drive API” there`,
          status,
          reason,
        );
      }
      return new GdriveRequestError(
        `Google Drive ${what} failed: HTTP ${status}${reason ? ` ${reason}` : ''}${message ? `: ${clip(message)}` : ''}`,
        status,
        reason,
      );
    };
  }

  private async get(what: string, path: string, query: Record<string, string>): Promise<Response> {
    const url = `${this.endpoints.apiBase}${path}?${new URLSearchParams(query).toString()}`;
    return this.perform(
      what,
      async () => ({ url, init: { method: 'GET', headers: { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' } } }),
      this.apiFailure(what),
    );
  }

  private async getJson(what: string, path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.get(what, path, query);
    const text = await readBounded(response, MAX_LISTING_BYTES, 'throw').catch((err: unknown) => {
      throw new Error(`Google Drive ${what} failed: the answer could not be read (${err instanceof Error ? err.message : 'unknown'})`, {
        cause: err,
      });
    });
    const answer = jsonObject(text);
    if (!answer)
      throw new Error(`Google Drive ${what} failed: the answer was not a JSON object; check that nothing between this server and Google rewrites it`);
    return answer;
  }

  /** `changes.getStartPageToken`: a cursor for "now". The sync takes it before it walks anything. */
  async startPageToken(): Promise<string> {
    const answer = await this.getJson('start-page-token request', '/changes/startPageToken', { supportsAllDrives: 'true', fields: 'startPageToken' });
    const token = str(answer.startPageToken);
    if (!token) throw new Error('Google Drive start-page-token request failed: the answer carried no startPageToken');
    return token;
  }

  /**
   * `changes.list` from `cursor`, one change at most: whether anything the account can see has changed
   * since. One request ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 5); an invalid cursor is Google's `400` and is raised.
   */
  async changedSince(cursor: string): Promise<boolean> {
    const answer = await this.getJson('change check', '/changes', {
      pageToken: cursor,
      pageSize: '1',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'changes(fileId),nextPageToken,newStartPageToken',
    });
    return (Array.isArray(answer.changes) && answer.changes.length > 0) || str(answer.nextPageToken) !== null;
  }

  /** `files.get` of a folder the source names: its name, or the error that says it is not shared with the account. */
  async folder(id: string): Promise<DriveFolder> {
    const answer = await this.getJson(`lookup of folder ${id}`, `/files/${encodeURIComponent(id)}`, {
      supportsAllDrives: 'true',
      fields: 'id,name,mimeType,trashed',
    });
    return { id: str(answer.id) ?? id, name: str(answer.name) ?? '', mimeType: str(answer.mimeType) ?? '', trashed: answer.trashed === true };
  }

  /**
   * The children of one folder, a page of at most 1 000 at a time, shortcuts and Google-native files
   * included (the driver decides what to do with them). A listing that cannot be completed throws: a
   * partial one would delete files.
   */
  async *listChildren(folderId: string): AsyncGenerator<DriveFile[]> {
    const escaped = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let token: string | undefined;
    for (;;) {
      const query: Record<string, string> = {
        q: `'${escaped}' in parents and trashed = false`,
        pageSize: String(PAGE_SIZE),
        orderBy: 'name',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      };
      if (token) query.pageToken = token;
      const answer = await this.getJson(`listing of folder ${folderId}`, '/files', query);
      if (!Array.isArray(answer.files)) throw new Error(`Google Drive listing of folder ${folderId} failed: the answer carried no file list`);
      const page: DriveFile[] = [];
      for (const raw of answer.files as unknown[]) {
        const item = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
        const id = str(item?.id);
        const mimeType = str(item?.mimeType);
        if (!item || !id || !mimeType || typeof item.name !== 'string') continue;
        // Drive reports `size` as a decimal string.
        const size = typeof item.size === 'string' && /^\d+$/.test(item.size) ? Number(item.size) : typeof item.size === 'number' ? item.size : null;
        page.push({
          id,
          name: item.name,
          mimeType,
          size,
          version: typeof item.version === 'string' || typeof item.version === 'number' ? String(item.version) : null,
          md5Checksum: str(item.md5Checksum),
          modifiedTime: str(item.modifiedTime),
          webViewLink: str(item.webViewLink),
        });
      }
      yield page;
      const next = str(answer.nextPageToken);
      if (!next) return;
      if (next === token) throw new Error(`Google Drive listing of folder ${folderId} failed: the same page token came back twice`);
      token = next;
    }
  }

  private body(response: Response, describe: string): AsyncIterable<Uint8Array> {
    if (!response.body) throw new Error(`Google Drive ${describe} failed: the answer had no body`);
    const declared = response.headers.get('content-length');
    const expected = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
    const stream = response.body as unknown as AsyncIterable<Uint8Array>;
    // A connection cut after the headers must fail the run, not leave a shorter file the manifest would record.
    async function* checked(): AsyncGenerator<Uint8Array> {
      let received = 0;
      for await (const chunk of stream) {
        received += chunk.byteLength;
        yield chunk;
      }
      if (expected !== null && received !== expected) throw new Error(`Google Drive ${describe} ended after ${received} of ${expected} bytes`);
    }
    return checked();
  }

  /** `files.export` of a Google-native file. Throws {@link GdriveRequestError} (see {@link isExportTooLarge}) when Google refuses it. */
  async exportFile(id: string, format: ExportFormat): Promise<AsyncIterable<Uint8Array>> {
    const describe = `export of file ${id}`;
    const response = await this.get(describe, `/files/${encodeURIComponent(id)}/export`, { mimeType: format.mimeType });
    return this.body(response, describe);
  }

  /** `files.get?alt=media` of a stored file. */
  async downloadFile(id: string): Promise<AsyncIterable<Uint8Array>> {
    const describe = `download of file ${id}`;
    const response = await this.get(describe, `/files/${encodeURIComponent(id)}`, { alt: 'media', supportsAllDrives: 'true' });
    return this.body(response, describe);
  }
}

/**
 * Whether an export failed because Google will not produce one this large (10 MB,
 * [ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 6). Google's documentation names the limit and not the
 * reason string, so the test is the `403` with either the documented-by-convention reason or a message about
 * size; the real answer is recorded by the smoke run.
 */
export function isExportTooLarge(err: unknown): boolean {
  if (!(err instanceof GdriveRequestError) || err.status !== 403) return false;
  return err.reason === 'exportSizeLimitExceeded' || /too large|exceeds? the (maximum|limit)|size limit/i.test(err.message);
}
