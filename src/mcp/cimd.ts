import { OAuthClientMetadataSchema } from '@modelcontextprotocol/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { oauthClients } from '../db/schema.js';
import { APPLICATION_TYPES, type ApplicationType, redirectUriAllowed } from '../services/auth/oauth.js';
import { confluenceEgress, type EgressFetch } from '../services/sources/confluence-egress.js';

/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00), beside
 * dynamic registration rather than instead of it.
 *
 * A client that has no registration here may use an https URL as its `client_id`. That URL serves a
 * JSON document describing the client, and the document's own `client_id` must be the URL itself, so
 * whoever controls the document controls the identity — the same trust a person extends to a web
 * origin. This server fetches the document when the authorization endpoint first sees the URL, and
 * from then on reads it like a registration: the `redirect_uri` must be one the document lists.
 *
 * **The fetch is an SSRF surface, and it goes through the one egress rule this product has**
 * ([ADR-0088](../../.ssot/ADR.md#adr-0088)): loopback, link-local (cloud metadata), unspecified,
 * multicast and private addresses are refused on the address the socket actually opens, after DNS and
 * on every redirect. Nothing may lift that here — there is no allow-list for client documents. On top
 * of it the fetch is https only, bounded in time and in size, and what it read is cached for as long
 * as the document's own HTTP cache headers allow, within a ceiling.
 */

/** §6.6 suggests 5 KB; a client document is a name, a few URIs and perhaps a logo URL. */
export const CIMD_MAX_BYTES = 5 * 1024;
/** The whole fetch — connect, redirects, headers and body — must fit in this. */
export const CIMD_TIMEOUT_MS = 5_000;
/** How long a document is reused when it says nothing about caching. */
export const CIMD_DEFAULT_TTL_MS = 5 * 60_000;
/** The longest a document is reused, whatever its headers say, so a change reaches this server. */
export const CIMD_MAX_TTL_MS = 24 * 60 * 60_000;
/** Documents held at once; the oldest goes first. */
const CIMD_MAX_ENTRIES = 1_000;

/** Uncached document fetches one host may cause in a window — the authorization endpoint is public. */
export const CIMD_FETCH_MAX_PER_HOST = 20;
export const CIMD_FETCH_WINDOW_MS = 10 * 60_000;

/** Why a client ID metadata document was not accepted. The message is shown to the person. */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMetadataError';
  }
}

/**
 * Whether a `client_id` is meant as a metadata document URL rather than a registration. Registered
 * ids are `ctxc_` and hex and never contain a colon, so anything with a scheme is a URL — and is then
 * held to every rule of {@link parseClientIdUrl}, never looked up as a registration.
 */
export const isClientIdUrl = (clientId: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(clientId);

/**
 * The `client_id` as a URL, or a refusal. §3: https, with a path component, no fragment, no
 * username or password, and no `.` or `..` path segment — the last checked on the string as sent,
 * because `URL` would quietly resolve them away.
 */
export function parseClientIdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError('The client_id is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new ClientMetadataError('A URL client_id must use https.');
  if (url.username || url.password) throw new ClientMetadataError('A URL client_id must not contain a username or password.');
  if (url.hash || clientId.includes('#')) throw new ClientMetadataError('A URL client_id must not contain a fragment.');
  if (url.pathname === '/' || url.pathname === '') throw new ClientMetadataError('A URL client_id must contain a path.');
  const rawPath = clientId.slice(clientId.indexOf('//') + 2).replace(/[?#].*$/, '');
  const dotSegment = (segment: string) => ['.', '..'].includes(segment.replace(/%2e/gi, '.'));
  if (rawPath.split('/').some(dotSegment)) {
    throw new ClientMetadataError('A URL client_id must not contain a "." or ".." path segment.');
  }
  return url;
}

/** What this server keeps of a document once it has been accepted. */
export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  applicationType: ApplicationType | undefined;
}

/**
 * The document as RFC 7591 metadata plus the three fields §4.1 and this server require. Unknown
 * fields are ignored, exactly as a registration's are.
 */
const DocumentSchema = OAuthClientMetadataSchema.extend({
  client_id: z.string().min(1),
  client_name: z.string().trim().min(1),
  application_type: z.enum(APPLICATION_TYPES).optional(),
});

/** The fields §4.1 forbids: a document is public, so a secret in it is no secret. */
const SECRET_FIELDS = ['client_secret', 'client_secret_expires_at'] as const;

/** Reads a document body into a string, refusing it the moment it passes `maxBytes`. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ClientMetadataError(`The client metadata document is larger than ${maxBytes} bytes.`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ClientMetadataError(`The client metadata document is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** The `Age` header in seconds; absent or not a non-negative integer counts as `0` (RFC 9111 §5.1). */
function ageSeconds(headers: Headers): number {
  const value = headers.get('age')?.trim() ?? '';
  return /^\d+$/.test(value) ? Number(value) : 0;
}

/**
 * How long a response may be reused, from its `Cache-Control` and `Expires`, capped at
 * {@link CIMD_MAX_TTL_MS}. `0` for `no-store`, `no-cache` and `private`-less `max-age=0` alike: this
 * cache does not revalidate, so a document that wants revalidation is simply fetched again.
 */
export function cacheLifetimeMs(headers: Headers, now: number): number {
  const control = (headers.get('cache-control') ?? '').toLowerCase();
  const directives = new Map(
    control
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, value] = part.split('=', 2);
        return [name.trim(), value?.trim().replace(/^"|"$/g, '')] as const;
      }),
  );
  if (directives.has('no-store') || directives.has('no-cache')) return 0;
  // What is left is the freshness lifetime less the time a cache upstream already held the response
  // (RFC 9111 §4.2): a document a CDN has kept for most of its max-age is nearly stale on arrival.
  const remaining = (lifetime: number): number => {
    const left = lifetime - ageSeconds(headers) * 1000;
    return left <= 0 ? 0 : Math.min(left, CIMD_MAX_TTL_MS);
  };
  const maxAge = directives.get('max-age');
  if (maxAge !== undefined) {
    const seconds = Number.parseInt(maxAge, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return remaining(seconds * 1000);
  }
  const expires = headers.get('expires');
  if (expires !== null) {
    const at = Date.parse(expires);
    // An invalid `Expires` means "already expired" (RFC 9111 §5.3).
    if (Number.isNaN(at)) return 0;
    const date = Date.parse(headers.get('date') ?? '');
    return remaining(at - (Number.isNaN(date) ? now : date));
  }
  return remaining(CIMD_DEFAULT_TTL_MS);
}

export interface ClientMetadataResolverOptions {
  /** Replaces the ADR-0088 egress. Tests point it at a local fixture through the same egress. */
  fetch?: EgressFetch;
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The production fetch: ADR-0088's egress, https only, nothing allow-listed. */
export const clientMetadataEgress = (timeoutMs: number = CIMD_TIMEOUT_MS): EgressFetch =>
  confluenceEgress({ allowedHosts: [], allowListName: null, label: 'The client metadata host', httpsOnly: true, timeoutMs });

/** Fetches, validates and caches client ID metadata documents. One per authorization server. */
export class ClientMetadataResolver {
  private readonly cache = new Map<string, { metadata: ClientMetadata; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<ClientMetadata>>();
  private readonly fetch: EgressFetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ClientMetadataResolverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? CIMD_TIMEOUT_MS;
    this.fetch = options.fetch ?? clientMetadataEgress(this.timeoutMs);
    this.maxBytes = options.maxBytes ?? CIMD_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  /** Whether `clientId` would be answered from the cache, without a fetch. */
  isCached(clientId: string): boolean {
    const hit = this.cache.get(clientId);
    return hit !== undefined && hit.expiresAt > this.now();
  }

  /** The accepted document for `clientId`, from the cache or fetched. Throws {@link ClientMetadataError}. */
  async resolve(clientId: string): Promise<ClientMetadata> {
    const url = parseClientIdUrl(clientId);
    const hit = this.cache.get(clientId);
    if (hit) {
      if (hit.expiresAt > this.now()) return hit.metadata;
      this.cache.delete(clientId);
    }
    const pending = this.inFlight.get(clientId);
    if (pending) return pending;
    const loading = this.load(clientId, url).finally(() => this.inFlight.delete(clientId));
    this.inFlight.set(clientId, loading);
    return loading;
  }

  private async load(clientId: string, url: URL): Promise<ClientMetadata> {
    const { metadata, ttlMs } = await this.withDeadline((signal) => this.fetchDocument(clientId, url, signal));
    if (ttlMs > 0) {
      if (this.cache.size >= CIMD_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(clientId, { metadata, expiresAt: this.now() + ttlMs });
    }
    return metadata;
  }

  /**
   * The egress bounds idle time per socket; this bounds the whole fetch, slow-drip bodies included.
   * The deadline aborts the signal `work` fetches with, which destroys the request or the response
   * and its socket — giving up on the promise alone would leave a dripping connection open for hours.
   * The race is for a `fetch` that ignores its signal: the caller still gets its answer on time.
   */
  private async withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ClientMetadataError(`The client metadata document did not arrive within ${this.timeoutMs / 1000} s.`)),
      this.timeoutMs,
    );
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const running = work(controller.signal);
    // The loser of the race must not surface as an unhandled rejection.
    running.catch(() => undefined);
    aborted.catch(() => undefined);
    try {
      return await Promise.race([running, aborted]);
    } finally {
      clearTimeout(timer);
      // Whatever is still open once the answer is in — a body nobody will read — is closed too.
      if (!controller.signal.aborted) controller.abort(new ClientMetadataError('The client metadata fetch is over.'));
    }
  }

  private async fetchDocument(clientId: string, url: URL, signal: AbortSignal): Promise<{ metadata: ClientMetadata; ttlMs: number }> {
    let res: Response;
    try {
      res = await this.fetch(url.toString(), { method: 'GET', headers: { accept: 'application/json' }, signal });
    } catch (err) {
      if (err instanceof ClientMetadataError) throw err;
      throw new ClientMetadataError(`The client metadata document could not be fetched: ${(err as Error).message}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new ClientMetadataError(`The client metadata document answered HTTP ${res.status}, not 200.`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readBounded(res, this.maxBytes));
    } catch (err) {
      if (err instanceof ClientMetadataError) throw err;
      throw new ClientMetadataError('The client metadata document is not valid JSON.');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ClientMetadataError('The client metadata document is not a JSON object.');
    }
    for (const field of SECRET_FIELDS) {
      if (field in raw) throw new ClientMetadataError(`The client metadata document must not contain ${field}.`);
    }
    const parsed = DocumentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ClientMetadataError(`The client metadata document is incomplete or invalid: ${z.prettifyError(parsed.error)}`);
    }
    const doc = parsed.data;
    if (doc.client_id !== clientId) {
      throw new ClientMetadataError('The client metadata document names a different client_id than the URL it was fetched from.');
    }
    const method = doc.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
      throw new ClientMetadataError(`token_endpoint_auth_method must be "none" here, not "${method}".`);
    }
    return {
      metadata: {
        clientId,
        clientName: doc.client_name.slice(0, 200),
        redirectUris: doc.redirect_uris.map(String),
        applicationType: doc.application_type,
      },
      ttlMs: cacheLifetimeMs(res.headers, this.now()),
    };
  }
}

/**
 * Whether `redirectUri` may receive a code for this client: listed in the document, compared as a
 * whole string, and a URI this server would have accepted at registration for the same
 * `application_type`.
 */
export const metadataRedirectAllowed = (metadata: ClientMetadata, redirectUri: string): boolean =>
  metadata.redirectUris.includes(redirectUri) && redirectUriAllowed(redirectUri, metadata.applicationType);

/** Whether every redirect URI the document lists points back at this computer. */
export function redirectsOnlyToLoopback(metadata: ClientMetadata): boolean {
  return metadata.redirectUris.every((uri) => {
    try {
      const host = new URL(uri).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
    } catch {
      return false;
    }
  });
}

/**
 * The `oauth_clients` row a metadata-document client needs once a person has approved it: issued
 * credentials reference the client by foreign key. Written only after an approval, so it needs none
 * of registration's ceiling — every row is one somebody chose. A repeat approval refreshes the name
 * and redirect URIs from the document as it was just read.
 */
export async function upsertMetadataClient(db: Db, metadata: ClientMetadata): Promise<void> {
  await db
    .insert(oauthClients)
    .values({ clientId: metadata.clientId, name: metadata.clientName, redirectUris: metadata.redirectUris, lastUsedAt: new Date() })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: { name: metadata.clientName, redirectUris: metadata.redirectUris, lastUsedAt: sql`now()` },
    });
}
