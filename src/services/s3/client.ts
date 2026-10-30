import { z } from 'zod';
import { defineSecretBlob } from '../sources/secret-blob.js';
import { EgressRefusedError, type EgressFetch } from '../sources/confluence-egress.js';
import { canonicalQuery, encodeComponent, encodePath, sha256Hex, signRequest } from './sigv4.js';

/**
 * The read side of an S3-compatible API, for the `s3` source ([ADR-0126](../../../.ssot/ADR.md#adr-0126)):
 * `ListObjectsV2` and `GetObject`, signed with the one SigV4 implementation the backup command also uses
 * ([ADR-0120](../../../.ssot/ADR.md#adr-0120)), sent through an egress fetch the caller built.
 *
 * **The transport is injected, never `fetch`.** A source's endpoint is typed by an editor, so every request
 * leaves through the egress guard (`sourceEgress`, [ADR-0088](../../../.ssot/ADR.md#adr-0088)): loopback and
 * link-local are always refused, a private address only for a host listed in `SOURCE_ALLOWED_HOSTS`, on
 * every redirect. This module does not know how that is done; it cannot be given a bare `fetch` by
 * accident because its option has the egress's type.
 *
 * **Retries** ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 9): a network error or a `5xx` answer is
 * tried three times in all with a linear back-off; a `4xx` answer is raised at once with S3's own error
 * code. An egress refusal is not a network error and is never retried. Every `503 SlowDown` answer is
 * reported to `onThrottled`, whether or not a retry then succeeds.
 *
 * Nothing here ever puts a credential into an error: S3's `Code` and `Message` are quoted (truncated), the
 * request's headers and the key pair are not.
 */

// ---------------------------------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------------------------------

/** Printable ASCII without whitespace: what AWS issues, and what a signature header can carry. */
const KEY_CHARS = /^[\x21-\x7e]+$/;

/**
 * The `secret_enc` document of an `s3` source ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 3):
 * `{"v":1,"accessKeyId":…,"secretAccessKey":…}`.
 *
 * **Strict on purpose.** Temporary credentials (a session token) are not accepted: a stored credential that
 * expires in hours turns a scheduled source into an error a day later. The default behaviour of the blob
 * mechanism — dropping keys the schema does not name — would store a pasted `sessionToken`-bearing document
 * without it and fail with `InvalidToken` on the first request, so an unknown key is refused here instead.
 */
export const S3_SECRET = defineSecretBlob({
  type: 's3',
  schema: z
    .object({
      v: z.literal(1),
      accessKeyId: z.string().min(1).max(128).regex(KEY_CHARS, 'must be printable characters without spaces'),
      secretAccessKey: z.string().min(1).max(256).regex(KEY_CHARS, 'must be printable characters without spaces'),
    })
    .strict(),
});
export type S3Secret = ReturnType<typeof S3_SECRET.parse>;

// ---------------------------------------------------------------------------------------------------
// Where a request goes
// ---------------------------------------------------------------------------------------------------

export interface S3Target {
  /** Origin and optional base path of the API; `null` is AWS, `https://s3.<region>.amazonaws.com`. */
  endpoint: string | null;
  region: string;
  bucket: string;
  /** Path-style (`host/bucket/key`) or virtual-hosted (`bucket.host/key`) addressing. */
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/** `pathStyle` when the source does not say ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 2). */
export function defaultPathStyle(input: { endpoint: string | null | undefined; bucket: string }): boolean {
  if (input.endpoint) return true;
  // A dotted bucket name cannot be a label of a wildcard certificate (`a.b.s3.amazonaws.com`).
  return input.bucket.includes('.');
}

interface Address {
  url: string;
  host: string;
  path: string;
}

/** The URL, signed host and encoded path of a bucket-level (`key === null`) or object request. */
export function addressFor(target: S3Target, key: string | null, query: Array<[string, string]>): Address {
  const base = new URL(target.endpoint ?? `https://s3.${target.region}.amazonaws.com`);
  const basePath = base.pathname.replace(/\/+$/, '');
  let host = base.host;
  let path: string;
  if (target.pathStyle) {
    path = `${basePath}/${encodeComponent(target.bucket)}${key === null ? '' : `/${encodePath(key)}`}`;
  } else {
    host = `${target.bucket}.${base.host}`;
    path = `${basePath}${key === null ? '/' : `/${encodePath(key)}`}`;
  }
  const search = canonicalQuery(query);
  return { url: `${base.protocol}//${host}${path}${search ? `?${search}` : ''}`, host, path };
}

// ---------------------------------------------------------------------------------------------------
// XML — S3 answers in a small, flat dialect
// ---------------------------------------------------------------------------------------------------

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]) : undefined;
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1]);
}

/** A key as `encoding-type=url` returns it: percent-encoded, with a space as `+`. `null` for malformed encoding. */
function decodeKey(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** An ETag without its quotes and weak marker; what is compared for equality only. */
export function cleanEtag(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

// ---------------------------------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------------------------------

/**
 * The most a listing page may weigh. A page is at most 1 000 keys (about 1.5 MB at the worst, with 1 024-byte
 * keys), so the bound costs legitimate traffic nothing; it is there because the endpoint is typed by an editor,
 * and an answer that never ends must not be read into the process's memory. Counted on the bytes the egress
 * hands over, i.e. after a gzip answer is expanded.
 */
export const MAX_LISTING_BYTES = 8 * 1024 * 1024;

/** An error answer's body is only quoted (`Code`, `Message`), never needed whole: the first 2 000 bytes are read and the stream is cut. */
const ERROR_BODY_BYTES = 2000;

/**
 * The body as text, up to `limit` bytes. Past it the stream is cancelled and `onExceeded` decides: throw
 * (a listing) or keep the part read (an error body).
 */
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
    // Cutting the stream closes the socket; without it a body that never ends keeps the request open.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------------

export interface S3ListedObject {
  key: string;
  etag: string;
  size: number;
}

export interface S3Download {
  body: AsyncIterable<Uint8Array>;
  /** The ETag the `GetObject` answered, which is what the sync records. */
  etag: string;
}

/** What S3 (or a stand-in) said no with. `code` is its `<Code>`, e.g. `AccessDenied`, `NoSuchBucket`. */
export class S3RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'S3RequestError';
  }
}

export interface S3ClientOptions {
  /** The egress; the one thing that decides which addresses a request may reach. */
  fetch: EgressFetch;
  now?: () => Date;
  /** Attempts per request for network errors and 5xx answers (default 3). */
  attempts?: number;
  /** Back-off unit: attempt *n* waits *n* × this long (default 500 ms). */
  retryDelayMs?: number;
  /** Called once per throttling answer (`503 SlowDown`), retried or not. */
  onThrottled?: () => void;
}

/** ListObjectsV2 returns at most 1 000 keys a page. */
const PAGE_SIZE = 1000;

export class S3Client {
  private readonly now: () => Date;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(
    readonly target: S3Target,
    private readonly options: S3ClientOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.attempts = options.attempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  /** `s3://bucket/key`, for messages. */
  describe(key = ''): string {
    return `s3://${this.target.bucket}/${key}`;
  }

  /** The host a request is made to, for messages (never a credential). */
  get host(): string {
    return addressFor(this.target, null, []).host;
  }

  private async send(key: string | null, query: Array<[string, string]>, what: string): Promise<Response> {
    const address = addressFor(this.target, key, query);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const headers = signRequest({
        method: 'GET',
        host: address.host,
        path: address.path,
        query,
        payloadHash: sha256Hex(''),
        region: this.target.region,
        accessKeyId: this.target.accessKeyId,
        secretAccessKey: this.target.secretAccessKey,
        date: this.now(),
      });
      let response: Response;
      try {
        response = await this.options.fetch(address.url, { method: 'GET', headers });
      } catch (err) {
        // A refusal is the guard's answer about the address, not a flaky network: say it, once.
        if (err instanceof EgressRefusedError) throw err;
        lastError = err;
        if (attempt < this.attempts) await this.backOff(attempt);
        continue;
      }
      if (response.ok) return response;

      const text = await readBounded(response, ERROR_BODY_BYTES, 'truncate').catch(() => '');
      const code = xmlTag(text, 'Code');
      if (response.status === 503 && code === 'SlowDown') this.options.onThrottled?.();
      const failure = this.failure(response.status, code, xmlTag(text, 'Message'), what);
      if (response.status >= 500) {
        lastError = failure;
        if (attempt < this.attempts) await this.backOff(attempt);
        continue;
      }
      throw failure;
    }
    if (lastError instanceof S3RequestError) throw lastError;
    const reason = lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError);
    throw new Error(`S3 ${what} could not reach \`${this.host}\`: ${reason}`);
  }

  private failure(status: number, code: string | undefined, message: string | undefined, what: string): S3RequestError {
    const detail = [code, message].filter(Boolean).join(': ').slice(0, 300);
    return new S3RequestError(`S3 ${what} failed: HTTP ${status}${detail ? ` ${detail}` : ''}`, status, code);
  }

  private backOff(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
  }

  /**
   * The keys under `prefix` (`''` for the whole bucket; a prefix is matched as written, so a directory
   * is `docs/`), one page of at most 1 000 at a time. A listing that cannot be completed throws: a partial
   * one would delete files. A server that says "truncated" without a way to continue is an error, not the end.
   */
  async *listPages(prefix: string): AsyncGenerator<S3ListedObject[]> {
    let token: string | undefined;
    for (;;) {
      const query: Array<[string, string]> = [
        ['encoding-type', 'url'],
        ['list-type', '2'],
        ['max-keys', String(PAGE_SIZE)],
      ];
      if (prefix) query.push(['prefix', prefix]);
      if (token) query.push(['continuation-token', token]);
      const xml = await readBounded(await this.send(null, query, 'listing'), MAX_LISTING_BYTES, 'throw').catch((err: unknown) => {
        throw new Error(`S3 listing failed: \`${this.host}\` ${err instanceof Error ? err.message : 'could not be read'}`, { cause: err });
      });
      // A 200 that is not a listing (a portal, a proxy's landing page) would read as an empty bucket, and an
      // empty bucket deletes every file the source holds.
      if (!/<ListBucketResult[\s>]/.test(xml)) {
        throw new Error(`S3 listing failed: \`${this.host}\` answered, but not with an S3 listing; check the endpoint`);
      }

      const page: S3ListedObject[] = [];
      for (const block of xmlBlocks(xml, 'Contents')) {
        const key = decodeKey(xmlTag(block, 'Key') ?? '');
        if (key === null || key === '') continue;
        const size = Number(xmlTag(block, 'Size'));
        page.push({ key, etag: cleanEtag(xmlTag(block, 'ETag')), size: Number.isFinite(size) && size >= 0 ? size : 0 });
      }
      yield page;

      if (xmlTag(xml, 'IsTruncated') !== 'true') return;
      const next = xmlTag(xml, 'NextContinuationToken');
      if (!next || next === token) throw new Error('S3 listing failed: the server reported a truncated listing without a way to continue it');
      token = next;
    }
  }

  async getObject(key: string): Promise<S3Download> {
    const response = await this.send(key, [], `download of ${this.describe(key)}`);
    if (!response.body) throw new Error(`S3 download of ${this.describe(key)} failed: the answer had no body`);
    const declared = response.headers.get('content-length');
    const expected = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
    const stream = response.body as unknown as AsyncIterable<Uint8Array>;
    const describe = this.describe(key);
    // A connection cut after the headers must fail the run, not leave a shorter file that the manifest
    // would then record as the object (the size check on the stream only catches too much).
    async function* checked(): AsyncGenerator<Uint8Array> {
      let received = 0;
      for await (const chunk of stream) {
        received += chunk.byteLength;
        yield chunk;
      }
      if (expected !== null && received !== expected) {
        throw new Error(`S3 download of ${describe} ended after ${received} of ${expected} bytes`);
      }
    }
    return { body: checked(), etag: cleanEtag(response.headers.get('etag')) };
  }
}
