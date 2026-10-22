import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BackupRefused } from './backup-archive.js';

/**
 * An S3-compatible *destination for the archive `npm run backup` already writes*, and the same place
 * to read one back from (ACTION_PLAN 0.4-11, [ADR-0110](../.ssot/ADR.md#adr-0110)).
 *
 * **What this is not.** It is not an upload storage backend (K-11 stays rejected, ADR-0016): the
 * application never reads or writes S3, only this operator command does, and only with an archive that
 * is already a finished file. The server schedules nothing here either (ADR-0072/0110) — whoever runs
 * the command (cron, the compose sidecar, the Helm CronJob) owns the schedule and the failure channel.
 *
 * **No SDK, deliberately.** The five operations an archive needs — PutObject, multipart upload,
 * ListObjectsV2, DeleteObject, GetObject — are plain HTTP with an AWS Signature V4 header, and `fetch`
 * and `node:crypto` are already in the runtime. The AWS SDK v3 is hundreds of transitive packages in an
 * image whose dependency list is audited line by line (ADR-0091's reasoning for the web driver); a
 * ~300-line signer is the smaller thing to own. It is **path-style only** (`https://host/bucket/key`),
 * which is what MinIO, Ceph and every self-hosted gateway speak and what AWS still accepts.
 *
 * Credentials come from the environment only, are never printed, and never appear in an error message.
 */

/** `contextator-backup-2026-09-22T12-00-00Z.tar.gz` — exactly the shape `defaultArchiveName` writes. */
export const TIMESTAMPED_ARCHIVE = /^contextator-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz$/;

/** The compose sidecar's default (ADR-0110), so the same `BACKUP_KEEP` means the same on every path. */
export const DEFAULT_KEEP = 7;

/** S3 refuses multipart parts under 5 MiB (other than the last); 16 MiB keeps 10,000 parts above 150 GB. */
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;

export interface S3Target {
  /** Origin and optional base path, no trailing slash. `https://s3.<region>.amazonaws.com` when none is given. */
  endpoint: string;
  bucket: string;
  /** Without leading or trailing slash; empty means the bucket root. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

/** Reads `BACKUP_S3_*`; every problem is collected so an operator fixes the environment once, not four times. */
export function s3TargetFromEnv(env: NodeJS.ProcessEnv = process.env): S3Target {
  const read = (name: string): string => (env[name] ?? '').trim();
  const missing = ['BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'].filter((name) => read(name) === '');
  if (missing.length > 0) {
    throw new BackupRefused('s3_config', `The S3 target is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`);
  }

  const region = read('BACKUP_S3_REGION') || 'us-east-1';
  if (!/^[a-z0-9-]+$/i.test(region)) {
    throw new BackupRefused('s3_config', 'BACKUP_S3_REGION must be a region name such as us-east-1.');
  }

  const bucket = read('BACKUP_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new BackupRefused('s3_config', 'BACKUP_S3_BUCKET is not a valid bucket name (3-63 lowercase letters, digits, dots and hyphens).');
  }

  const rawEndpoint = read('BACKUP_S3_ENDPOINT') || `https://s3.${region}.amazonaws.com`;
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new BackupRefused('s3_config', 'BACKUP_S3_ENDPOINT is not a URL. Write it as https://minio.example.com:9000.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BackupRefused('s3_config', 'BACKUP_S3_ENDPOINT must be an http:// or https:// URL.');
  }
  // A credential in the URL would end up in logs and process listings; the key pair has its own variables.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BackupRefused(
      's3_config',
      'BACKUP_S3_ENDPOINT must not carry a user or password; use BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.',
    );
  }
  const endpoint = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;

  const prefix = read('BACKUP_S3_PREFIX').replace(/^\/+|\/+$/g, '');
  if (prefix.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new BackupRefused('s3_config', 'BACKUP_S3_PREFIX must not contain "." or ".." segments.');
  }

  const sessionToken = read('BACKUP_S3_SESSION_TOKEN');
  return {
    endpoint,
    bucket,
    prefix,
    region,
    accessKeyId: read('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: read('BACKUP_S3_SECRET_ACCESS_KEY'),
    ...(sessionToken ? { sessionToken } : {}),
  };
}

/** `BACKUP_KEEP` as the compose sidecar reads it: unset means 7, anything but a positive integer is refused. */
export function keepFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.BACKUP_KEEP ?? '').trim();
  if (raw === '') return DEFAULT_KEEP;
  if (!/^[1-9]\d{0,5}$/.test(raw)) {
    throw new BackupRefused('s3_config', `BACKUP_KEEP must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------------------------------

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** RFC 3986 unreserved set only; `encodeURIComponent` leaves `!'()*` alone and SigV4 does not. */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(value: string): string {
  return value.split('/').map(encodeComponent).join('/');
}

function canonicalQuery(query: Array<[string, string]>): string {
  return query
    .map(([k, v]) => [encodeComponent(k), encodeComponent(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface SignInput {
  method: string;
  /** `URL.host`: hostname plus the port when it is not the scheme's default. */
  host: string;
  /** Already percent-encoded, starting with `/`. */
  path: string;
  query: Array<[string, string]>;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`, which are added here. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date: Date;
  service?: string;
}

/** Returns every header to send except `host` (which `fetch` derives from the URL it is given). */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3';
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const signedNames = ['host', ...Object.keys(headers)].sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${name === 'host' ? input.host : headers[name]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [input.method, input.path, canonicalQuery(input.query), canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------------------------------
// XML — S3 answers in a small, flat dialect; a parser would be more code than the five tags read.
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

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]) : undefined;
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1]);
}

// ---------------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------------

export interface S3ClientOptions {
  /** The transport; the unit tests pass a stub, everything else leaves it. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Multipart part size in bytes. */
  partSize?: number;
  /** Attempts per request for network errors and 5xx answers. */
  attempts?: number;
  retryDelayMs?: number;
}

export class S3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly partSize: number;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(
    readonly target: S3Target,
    options: S3ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.attempts = options.attempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  /** The object key for an archive name: `<prefix>/<name>`, or just the name at the bucket root. */
  keyFor(name: string): string {
    return this.target.prefix ? `${this.target.prefix}/${name}` : name;
  }

  /** What an operator can paste into `aws s3 ls` or the MinIO console. */
  describe(key: string): string {
    return `s3://${this.target.bucket}/${key}`;
  }

  /**
   * One signed request. Network errors and 5xx answers are retried on the same bytes; a 4xx is the
   * server saying no and is raised at once, with S3's own `<Code>` rather than a bare status.
   */
  private async send(
    method: string,
    key: string | null,
    query: Array<[string, string]>,
    body: Buffer | undefined,
    options: { allowNotFound?: boolean; what: string },
  ): Promise<Response> {
    const bucketPath = `/${encodeComponent(this.target.bucket)}`;
    const basePath = new URL(this.target.endpoint).pathname.replace(/\/+$/, '');
    const objectPath = key === null ? '' : `/${encodePath(key)}`;
    const pathname = `${basePath}${bucketPath}${objectPath}`;
    const origin = new URL(this.target.endpoint).origin;
    const search = canonicalQuery(query);
    const fullUrl = `${origin}${pathname}${search ? `?${search}` : ''}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const headers = signRequest({
        method,
        host: new URL(origin).host,
        path: pathname,
        query,
        payloadHash: body ? sha256Hex(body) : sha256Hex(''),
        region: this.target.region,
        accessKeyId: this.target.accessKeyId,
        secretAccessKey: this.target.secretAccessKey,
        sessionToken: this.target.sessionToken,
        date: this.now(),
      });
      try {
        const response = await this.fetchImpl(fullUrl, { method, headers, body: body ? new Uint8Array(body) : undefined });
        if (response.status >= 500 && attempt < this.attempts) {
          await response.arrayBuffer().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
          continue;
        }
        if (response.ok) return response;
        if (response.status === 404 && options.allowNotFound) return response;
        throw await this.failure(response, options.what);
      } catch (err) {
        if (err instanceof BackupRefused) throw err;
        lastError = err;
        if (attempt < this.attempts) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
    const reason = lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError);
    throw new BackupRefused('s3_unreachable', `S3 ${options.what} could not reach ${origin}: ${reason}`);
  }

  private async failure(response: Response, what: string): Promise<BackupRefused> {
    const text = (await response.text().catch(() => '')).slice(0, 2000);
    const code = xmlTag(text, 'Code');
    const message = xmlTag(text, 'Message');
    const detail = [code, message].filter(Boolean).join(': ').slice(0, 300);
    const refusal = code === 'NoSuchKey' || code === 'NoSuchBucket' ? 's3_not_found' : 's3_request_failed';
    return new BackupRefused(refusal, `S3 ${what} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}.`);
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    const response = await this.send('PUT', key, [], body, { what: `upload of ${key}` });
    await response.arrayBuffer();
  }

  /**
   * Uploads a file in memory-bounded pieces: one part at a time is read, hashed and sent. A file that
   * fits one part is a single PutObject; anything larger is a multipart upload that is aborted on any
   * failure, because an abandoned multipart upload is storage nobody can see in a listing and is billed.
   */
  async uploadFile(key: string, file: string): Promise<number> {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const first = await readChunk(handle, 0, this.partSize);
      if (size <= this.partSize) {
        await this.putObject(key, first);
        return size;
      }

      const created = await this.send('POST', key, [['uploads', '']], undefined, { what: `multipart start for ${key}` });
      const uploadId = xmlTag(await created.text(), 'UploadId');
      if (!uploadId) throw new BackupRefused('s3_request_failed', `S3 multipart start for ${key} answered without an UploadId.`);

      try {
        const parts: Array<{ number: number; etag: string }> = [];
        let offset = 0;
        let chunk = first;
        for (let number = 1; chunk.length > 0; number++) {
          const response = await this.send(
            'PUT',
            key,
            [
              ['partNumber', String(number)],
              ['uploadId', uploadId],
            ],
            chunk,
            { what: `upload of part ${number} of ${key}` },
          );
          await response.arrayBuffer();
          const etag = response.headers.get('etag');
          if (!etag) throw new BackupRefused('s3_request_failed', `S3 answered part ${number} of ${key} without an ETag.`);
          parts.push({ number, etag });
          offset += chunk.length;
          chunk = offset < size ? await readChunk(handle, offset, this.partSize) : Buffer.alloc(0);
        }
        const manifest = `<CompleteMultipartUpload>${parts
          .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
          .join('')}</CompleteMultipartUpload>`;
        const done = await this.send('POST', key, [['uploadId', uploadId]], Buffer.from(manifest, 'utf8'), {
          what: `multipart completion of ${key}`,
        });
        // S3 may answer 200 and still carry an <Error> element: the work happens after the headers.
        const doneBody = await done.text();
        if (/<Error>/.test(doneBody)) {
          throw new BackupRefused('s3_request_failed', `S3 multipart completion of ${key} failed: ${xmlTag(doneBody, 'Code') ?? 'unknown error'}.`);
        }
      } catch (err) {
        await this.send('DELETE', key, [['uploadId', uploadId]], undefined, {
          what: `abort of the multipart upload of ${key}`,
          allowNotFound: true,
        }).catch(() => undefined);
        throw err;
      }
      return size;
    } finally {
      await handle.close();
    }
  }

  /** Every object under `prefix`, following continuation tokens. */
  async list(prefix: string): Promise<S3Object[]> {
    const objects: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Array<[string, string]> = [['list-type', '2']];
      if (prefix) query.push(['prefix', prefix]);
      if (token) query.push(['continuation-token', token]);
      const response = await this.send('GET', null, query, undefined, { what: `listing of ${this.describe(prefix)}` });
      const xml = await response.text();
      for (const block of xmlBlocks(xml, 'Contents')) {
        const key = xmlTag(block, 'Key');
        if (key === undefined) continue;
        objects.push({ key, size: Number(xmlTag(block, 'Size') ?? 0), lastModified: xmlTag(block, 'LastModified') ?? '' });
      }
      token = xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return objects;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.send('DELETE', key, [], undefined, { what: `deletion of ${key}`, allowNotFound: true });
    await response.arrayBuffer();
  }

  /** Streams an object to `dest`; a partial file is removed on failure. */
  async downloadToFile(key: string, dest: string): Promise<number> {
    const response = await this.send('GET', key, [], undefined, { what: `download of ${key}` });
    if (!response.body) throw new BackupRefused('s3_request_failed', `S3 answered the download of ${key} without a body.`);
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        createWriteStream(dest, { mode: 0o600 }),
      );
    } catch (err) {
      await fs.rm(dest, { force: true });
      throw err;
    }
    return (await fs.stat(dest)).size;
  }
}

async function readChunk(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

// ---------------------------------------------------------------------------------------------------
// What the commands do with it
// ---------------------------------------------------------------------------------------------------

/** The archive names under the prefix that are exactly the timestamped shape, newest first. */
export async function listArchives(client: S3Client): Promise<S3Object[]> {
  const prefix = client.target.prefix ? `${client.target.prefix}/` : '';
  const objects = await client.list(prefix);
  return objects
    .filter((object) => {
      const name = object.key.slice(prefix.length);
      return object.key.startsWith(prefix) && !name.includes('/') && TIMESTAMPED_ARCHIVE.test(name);
    })
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

export interface PublishResult {
  key: string;
  bytes: number;
  deleted: string[];
}

/**
 * Uploads one finished archive and then applies retention to the target.
 *
 * Retention is the compose sidecar's rule moved to the bucket (ADR-0110): keep the newest `keep`
 * objects whose name is **exactly** the timestamped shape, delete the rest, leave every other name
 * alone — an archive somebody named by hand is one they meant to keep. It runs only *after* the new
 * archive is stored, so a failed upload deletes nothing, and the archive just written is never a
 * candidate even if clock skew would sort it older than `keep` others.
 */
export async function publishArchive(client: S3Client, file: string, keep: number, say: (line: string) => void): Promise<PublishResult> {
  const key = client.keyFor(path.basename(file));
  const bytes = await client.uploadFile(key, file);
  say(`  uploaded to ${client.describe(key)} — ${bytes} bytes.`);

  const deleted: string[] = [];
  const stale = (await listArchives(client)).slice(keep).filter((object) => object.key !== key);
  for (const object of stale) {
    await client.deleteObject(object.key);
    deleted.push(object.key);
  }
  if (deleted.length > 0)
    say(`  retention: kept the newest ${keep}, deleted ${deleted.length} older archive(s) from ${client.describe(client.keyFor(''))}.`);
  return { key, bytes, deleted };
}

/**
 * Resolves `latest` or an archive name to an object under the prefix and downloads it into `destDir`.
 *
 * The local file name is fixed rather than taken from the key: the name comes from a bucket, and a
 * bucket is not an authority on where on this disk a file may land.
 */
export async function fetchArchive(client: S3Client, reference: string, destDir: string, say: (line: string) => void): Promise<string> {
  let key: string;
  if (reference === 'latest') {
    const newest = (await listArchives(client))[0];
    if (!newest) {
      throw new BackupRefused(
        's3_not_found',
        `No archive named contextator-backup-<timestamp>.tar.gz under ${client.describe(client.keyFor(''))}. Name one explicitly if it was named by hand.`,
      );
    }
    key = newest.key;
  } else {
    if (reference.includes('/') || reference === '.' || reference === '..') {
      throw new BackupRefused('s3_config', 'Name the archive as it appears under BACKUP_S3_PREFIX, without a path, or use "latest".');
    }
    key = client.keyFor(reference);
  }

  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  const dest = path.join(destDir, 'archive.tar.gz');
  say(`  downloading ${client.describe(key)} ...`);
  const bytes = await client.downloadToFile(key, dest);
  say(`  downloaded ${bytes} bytes.`);
  return dest;
}
