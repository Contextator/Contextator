import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import {
  addressFor,
  cleanEtag,
  MAX_LISTING_BYTES,
  defaultPathStyle,
  S3_SECRET,
  S3Client,
  S3RequestError,
  type S3Target,
} from '../src/services/s3/client.js';
import { MetricsRegistry } from '../src/services/metrics.js';
import { signRequest } from '../src/services/s3/sigv4.js';
import { EgressRefusedError, sourceEgress } from '../src/services/sources/confluence-egress.js';
import type { DriverContext } from '../src/services/sources/driver.js';
import { S3Driver } from '../src/services/sources/s3.js';
import { createSource, parseSourceConfig, PROBE_TOKEN_KEY, S3Config, SOURCE_TYPES, updateSource } from '../src/services/sources.js';
import { CREDENTIAL_SOURCE_TYPES } from '../src/services/encrypted-fields.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, routeToLoopback } from './support/egress-seams.js';

/**
 * The `s3` source ([ADR-0126](../.ssot/ADR.md#adr-0126)) against a fake S3 on the loopback interface,
 * reached **through** the egress guard by a made-up host name (`test/support/egress-seams.ts`).
 *
 * The fake checks the SigV4 signature of every request by recomputing it with the shared signer from the
 * request it actually received — the `Host` header included — so addressing (path-style or virtual-hosted)
 * and signing are asserted together, not each against its own idea of the other.
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const KEY = 'k'.repeat(64);
const ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYTESTSECRETKEY';
const CREDENTIAL = JSON.stringify({ v: 1, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY });
const REGION = 'eu-west-1';
const BUCKET = 'docs-bucket';
const PROJECT_ID = '00000000-0000-4000-8000-000000000061';
const SOURCE_ID = '00000000-0000-4000-8000-000000000062';

interface FakeObject {
  body: string;
  etag: string;
}

interface Logged {
  method: string;
  /** `list` for `ListObjectsV2`, `get` for `GetObject`, otherwise `other`. */
  kind: 'list' | 'get' | 'other';
  key: string | null;
  host: string;
  signed: boolean;
}

class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly log: Logged[] = [];
  /** Answers handed out before real handling, one per request, in order. */
  readonly scripted: Array<{ status: number; body: string; headers?: Record<string, string>; endless?: boolean } | 'ok'> = [];
  /** Bytes written to answers that never end, and whether the client closed such a connection. */
  endlessBytes = 0;
  endlessClosed: Promise<void> = Promise.resolve();
  pageSize = 1000;
  /** When set, a listing answers with this body whatever it was asked. */
  listOverride?: string;
  server!: http.Server;
  port = 0;

  put(key: string, body: string, etag = `"${Buffer.from(body).toString('hex').slice(0, 24) || 'empty'}"`): this {
    this.objects.set(key, { body, etag });
    return this;
  }

  get lists(): number {
    return this.log.filter((r) => r.kind === 'list').length;
  }
  get gets(): number {
    return this.log.filter((r) => r.kind === 'get').length;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private signatureHolds(req: http.IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', 'http://unused');
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
    const expected = signRequest({
      method: req.method ?? 'GET',
      host: String(req.headers.host),
      path: (req.url ?? '/').split('?')[0],
      query: [...url.searchParams.entries()],
      payloadHash: String(req.headers['x-amz-content-sha256']),
      region: REGION,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      date: new Date(iso),
    });
    return expected.authorization === req.headers.authorization;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://unused');
    const host = String(req.headers.host);
    // Virtual-hosted: the bucket is the first label of the Host; path-style: the first path segment.
    const virtual = host.startsWith(`${BUCKET}.`);
    const rawPath = url.pathname;
    let key: string | null;
    if (virtual) key = rawPath === '/' ? null : decodeURIComponent(rawPath.slice(1));
    else if (rawPath === `/${BUCKET}` || rawPath === `/${BUCKET}/`) key = null;
    else key = decodeURIComponent(rawPath.slice(`/${BUCKET}/`.length));
    const kind =
      req.method === 'GET' && key === null && url.searchParams.get('list-type') === '2'
        ? 'list'
        : req.method === 'GET' && key !== null
          ? 'get'
          : 'other';
    const signed = this.signatureHolds(req);
    this.log.push({ method: req.method ?? '', kind, key, host, signed });

    const scripted = this.scripted.shift();
    if (scripted && scripted !== 'ok') {
      res.writeHead(scripted.status, { 'content-type': 'application/xml', ...scripted.headers });
      if (scripted.endless) {
        // A body that never ends: the head, then a chunk every tick until the client hangs up.
        this.endlessBytes = 0;
        this.endlessClosed = new Promise<void>((resolve) => res.once('close', resolve));
        res.write(scripted.body);
        const chunk = 'x'.repeat(16 * 1024);
        const timer = setInterval(() => {
          this.endlessBytes += chunk.length;
          res.write(chunk);
        }, 1);
        res.once('close', () => clearInterval(timer));
        return;
      }
      res.end(scripted.body);
      return;
    }
    if (!signed) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match.</Message></Error>');
      return;
    }
    if (kind === 'list') {
      if (this.listOverride !== undefined) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(this.listOverride);
        return;
      }
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token');
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after ? all.findIndex((k) => k > Buffer.from(after, 'base64url').toString()) : 0;
      const page = start < 0 ? [] : all.slice(start, start + this.pageSize);
      const more = start >= 0 && start + this.pageSize < all.length;
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
      const contents = page
        .map(
          (k) =>
            `<Contents><Key>${enc(k)}</Key><ETag>${this.objects.get(k)!.etag.replace(/"/g, '&quot;')}</ETag><Size>${Buffer.byteLength(this.objects.get(k)!.body)}</Size></Contents>`,
        )
        .join('');
      const next = more ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]).toString('base64url')}</NextContinuationToken>` : '';
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${enc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><EncodingType>url</EncodingType><IsTruncated>${more}</IsTruncated>${contents}${next}</ListBucketResult>`,
      );
      return;
    }
    if (kind === 'get') {
      const object = key === null ? undefined : this.objects.get(key);
      if (!object) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', etag: object.etag, 'content-length': String(Buffer.byteLength(object.body)) });
      res.end(object.body);
      return;
    }
    res.writeHead(405).end();
  }
}

const slowDown = { status: 503, body: '<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>' };

let s3: FakeS3;
let dataDir: string;

beforeEach(async () => {
  s3 = new FakeS3();
  await s3.start();
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-s3-driver-')));
});
afterEach(async () => {
  await s3.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const HOST = 'minio.fixture.test';
const seams = (...hosts: string[]) => ({
  resolve: fakeResolver(Object.fromEntries(hosts.map((h) => [h, PUBLIC_FIXTURE_ADDRESS]))),
  route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
});
const endpoint = () => `http://${HOST}:${s3.port}`;

const row = (config: Record<string, unknown> = {}, secret: string | null = CREDENTIAL): DocumentSourceRow =>
  ({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 's3',
    name: 'bucket',
    label: '',
    config: { endpoint: endpoint(), region: REGION, bucket: BUCKET, prefix: '', extensions: ['md', 'txt'], ...config },
    secretEnc: secret === null ? null : encryptSecret(secret, { current: KEY }),
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
  }) as DocumentSourceRow;

const context = (extra: Record<string, unknown> = {}): DriverContext => ({
  db: null as never,
  log,
  config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [], ...extra } as DriverContext['config'],
});

const driver = (
  config: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
  secret: string | null = CREDENTIAL,
  hosts: string[] = [HOST],
) => new S3Driver(row(config, secret), context(extra), seams(...hosts), { retryDelayMs: 1 });

const tree = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else out.push(`${rel}${entry.name}`);
    }
  };
  await walk(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), '');
  return out.sort();
};

describe('the s3 credential document', () => {
  it('is stored canonically: the schema’s keys in its order, nothing else', () => {
    const messy = `  {"secretAccessKey":"${SECRET_ACCESS_KEY}",   "accessKeyId":"${ACCESS_KEY_ID}","v":1}  `;
    expect(S3_SECRET.canonicalize(messy)).toBe(CREDENTIAL);
  });

  it('refuses a session token, naming the key and never a value', () => {
    const withToken = JSON.stringify({
      v: 1,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: 'FwoGZXIvYXdzSECRETSESSION',
    });
    let message = '';
    try {
      S3_SECRET.canonicalize(withToken);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('sessionToken');
    expect(message).not.toContain('FwoGZXIvYXdzSECRETSESSION');
    expect(message).not.toContain(SECRET_ACCESS_KEY);
  });

  it('names the missing or malformed field and never echoes the rest', () => {
    const missing = () => S3_SECRET.canonicalize(JSON.stringify({ v: 1, accessKeyId: ACCESS_KEY_ID }));
    expect(missing).toThrow(/secretAccessKey/);
    expect(missing).toThrow(expect.objectContaining({ fields: ['secretAccessKey'] }) as never);
    expect(() => S3_SECRET.canonicalize(JSON.stringify({ v: 2, accessKeyId: 'a', secretAccessKey: 'b' }))).toThrow(/v/);
    expect(() => S3_SECRET.canonicalize(JSON.stringify({ v: 1, accessKeyId: 'has space', secretAccessKey: SECRET_ACCESS_KEY }))).toThrow(
      /accessKeyId/,
    );
    // A bare token, which is what every other credential type takes, is not a document.
    expect(() => S3_SECRET.canonicalize(SECRET_ACCESS_KEY)).toThrow(/valid JSON/);
  });
});

describe('the s3 settings', () => {
  const parse = (extra: Record<string, unknown>) => parseSourceConfig('s3', { bucket: BUCKET, ...extra });

  it('takes defaults: AWS, us-east-1, the whole bucket, three text types', () => {
    const cfg = parse({});
    expect(cfg).toMatchObject({ region: 'us-east-1', prefix: '', extensions: ['md', 'mdx', 'txt'] });
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.pathStyle).toBeUndefined();
  });

  it('normalises the endpoint and the prefix, and lets the empty string clear an endpoint', () => {
    expect(parse({ endpoint: 'https://minio.corp:9000///', prefix: '/guides/v2/' })).toMatchObject({
      endpoint: 'https://minio.corp:9000',
      prefix: 'guides/v2',
    });
    expect(parse({ endpoint: 'http://minio.corp:9000/base/' }).endpoint).toBe('http://minio.corp:9000/base');
    expect(parse({ endpoint: '' }).endpoint).toBeUndefined();
    expect(parse({ pathStyle: null }).pathStyle).toBeUndefined();
    expect(parse({ pathStyle: false }).pathStyle).toBe(false);
  });

  it('refuses a user in the endpoint, another scheme, a dotted prefix and a bad bucket', () => {
    expect(() => parse({ endpoint: 'https://key:secret@minio.corp' })).toThrow(/user or password/);
    expect(() => parse({ endpoint: 'ftp://minio.corp' })).toThrow(/http/);
    expect(() => parse({ endpoint: 'https://minio.corp/?x=1' })).toThrow(/query/);
    expect(() => parse({ prefix: 'a/../b' })).toThrow(/segments/);
    expect(() => parseSourceConfig('s3', { bucket: 'Bad_Bucket' })).toThrow(/bucket name/);
    expect(() => parseSourceConfig('s3', {})).toThrow(/bucket/);
  });

  it('is a source type with a credential, and the refusal on a type without one names the list', async () => {
    expect(SOURCE_TYPES).toContain('s3');
    expect(CREDENTIAL_SOURCE_TYPES).toContain('s3');
    expect(S3Config.safeParse({ bucket: BUCKET }).success).toBe(true);
    const db = { insert: () => ({ values: () => ({ returning: async () => [{}] }) }) } as never;
    const opts = { allowedRoots: [], keys: { current: KEY } };
    await expect(
      createSource(db, PROJECT_ID, { type: 'web', name: 'w', config: { entryUrl: 'https://docs.example.com/' }, secret: 'x' }, opts),
    ).rejects.toThrow('A web source takes no secret; only git, notion, confluence, s3, gdrive and github sources use one.');
    // A credential that is not the document is refused before anything is stored.
    await expect(createSource(db, PROJECT_ID, { type: 's3', name: 'b', config: { bucket: BUCKET }, secret: 'just-a-token' }, opts)).rejects.toThrow(
      /valid JSON/,
    );
    void updateSource;
  });
});

describe('addressing', () => {
  const target = (extra: Partial<S3Target>): S3Target => ({
    endpoint: null,
    region: REGION,
    bucket: BUCKET,
    pathStyle: false,
    accessKeyId: 'a',
    secretAccessKey: 'b',
    ...extra,
  });

  it('defaults: path-style with an endpoint, or on AWS for a dotted bucket; otherwise virtual-hosted', () => {
    expect(defaultPathStyle({ endpoint: 'https://minio.corp', bucket: 'plain' })).toBe(true);
    expect(defaultPathStyle({ endpoint: undefined, bucket: 'my.dotted.bucket' })).toBe(true);
    expect(defaultPathStyle({ endpoint: undefined, bucket: 'plain' })).toBe(false);
  });

  it('builds AWS virtual-hosted and path-style addresses, encoding every key segment', () => {
    const virtual = addressFor(target({}), 'guides/Hello World+(1).md', [['a', 'b c']]);
    expect(virtual.host).toBe(`${BUCKET}.s3.${REGION}.amazonaws.com`);
    expect(virtual.path).toBe('/guides/Hello%20World%2B%281%29.md');
    expect(virtual.url).toBe(`https://${BUCKET}.s3.${REGION}.amazonaws.com/guides/Hello%20World%2B%281%29.md?a=b%20c`);

    const pathStyle = addressFor(target({ pathStyle: true, endpoint: 'http://minio.corp:9000/base' }), null, [['list-type', '2']]);
    expect(pathStyle.host).toBe('minio.corp:9000');
    expect(pathStyle.url).toBe(`http://minio.corp:9000/base/${BUCKET}?list-type=2`);

    expect(addressFor(target({}), null, []).url).toBe(`https://${BUCKET}.s3.${REGION}.amazonaws.com/`);
  });

  it('strips the quotes and the weak marker from an ETag', () => {
    expect(cleanEtag('"abc-3"')).toBe('abc-3');
    expect(cleanEtag('W/"abc"')).toBe('abc');
    expect(cleanEtag(null)).toBe('');
  });
});

describe('the client', () => {
  const clientFor = (opts: { pathStyle?: boolean; onThrottled?: () => void; attempts?: number } = {}) => {
    const virtual = opts.pathStyle === false;
    return new S3Client(
      {
        endpoint: endpoint(),
        region: REGION,
        bucket: BUCKET,
        pathStyle: opts.pathStyle ?? true,
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
      {
        fetch: sourceEgress({ allowedHosts: [], ...seams(HOST, `${BUCKET}.${HOST}`), label: 'the S3 endpoint', httpsOnly: false }),
        retryDelayMs: 1,
        ...(opts.attempts ? { attempts: opts.attempts } : {}),
        ...(opts.onThrottled ? { onThrottled: opts.onThrottled } : {}),
        ...(virtual ? {} : {}),
      },
    );
  };
  const collect = async (client: S3Client, prefix = '') => {
    const out = [];
    for await (const page of client.listPages(prefix)) out.push(...page);
    return out;
  };

  it('pages a listing through its continuation token, decodes url-encoded keys and sends a valid signature', async () => {
    s3.pageSize = 2;
    s3.put('a b.md', 'one').put('é/ü.md', 'two').put('plain.md', 'three').put('z+plus.md', 'four').put('zz.md', 'five');
    const objects = await collect(clientFor());
    expect(objects.map((o) => o.key)).toEqual(['a b.md', 'plain.md', 'z+plus.md', 'zz.md', 'é/ü.md']);
    expect(objects[0]).toMatchObject({ size: 3, etag: expect.not.stringContaining('"') });
    expect(s3.lists).toBe(3);
    expect(s3.log.every((r) => r.signed)).toBe(true);
  });

  it('signs for the virtual-hosted host as well', async () => {
    s3.put('a.md', 'x');
    const objects = await collect(clientFor({ pathStyle: false }));
    expect(objects.map((o) => o.key)).toEqual(['a.md']);
    expect(s3.log[0]).toMatchObject({ host: `${BUCKET}.${HOST}:${s3.port}`, signed: true });
  });

  it('downloads an object with the ETag the answer carried', async () => {
    s3.put('a.md', 'hello', '"etag-1"');
    const download = await clientFor().getObject('a.md');
    expect(download.etag).toBe('etag-1');
    const chunks: Buffer[] = [];
    for await (const chunk of download.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('retries a 503 SlowDown, counting every throttling answer, and then succeeds', async () => {
    s3.put('a.md', 'x');
    s3.scripted.push(slowDown, slowDown, 'ok');
    let throttled = 0;
    const objects = await collect(clientFor({ onThrottled: () => throttled++ }));
    expect(objects).toHaveLength(1);
    expect(throttled).toBe(2);
    expect(s3.lists).toBe(3);
  });

  it('reports each throttling answer of a driver to the metrics registry, under s3 only', async () => {
    s3.put('a.md', 'x');
    s3.scripted.push(slowDown, slowDown, 'ok');
    const metrics = new MetricsRegistry();
    const d = new S3Driver(row(), { ...context(), metrics }, seams(HOST), { retryDelayMs: 1 });
    await d.probe();
    expect(metrics.sourceThrottled()).toEqual({ s3: 2, gdrive: 0 });
  });

  it('gives up after three attempts on a 5xx, with S3’s own code', async () => {
    s3.scripted.push(slowDown, slowDown, slowDown);
    let throttled = 0;
    const err = await collect(clientFor({ onThrottled: () => throttled++ })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3RequestError);
    expect((err as S3RequestError).code).toBe('SlowDown');
    expect((err as Error).message).toBe('S3 listing failed: HTTP 503 SlowDown: Please reduce your request rate.');
    expect(s3.lists).toBe(3);
    expect(throttled).toBe(3);
  });

  it('raises a 4xx at once, without retrying', async () => {
    s3.scripted.push({ status: 403, body: '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' });
    const err = await collect(clientFor()).catch((e: unknown) => e);
    expect((err as S3RequestError).status).toBe(403);
    expect((err as Error).message).toBe('S3 listing failed: HTTP 403 AccessDenied: Access Denied');
    expect(s3.lists).toBe(1);
  });

  it('does not take a 200 that is not a listing for an empty bucket', async () => {
    s3.listOverride = '<html><body>Please sign in to the network</body></html>';
    await expect(collect(clientFor())).rejects.toThrow(/not with an S3 listing/);
  });

  it('does not take a truncated listing with no way to continue for the end', async () => {
    s3.listOverride = '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>';
    await expect(collect(clientFor())).rejects.toThrow(/without a way to continue/);
  });

  it('never retries an egress refusal, and the refusal names the rule, the host and the setting', async () => {
    const client = new S3Client(
      { endpoint: 'http://minio.corp:9000', region: REGION, bucket: BUCKET, pathStyle: true, accessKeyId: 'a', secretAccessKey: 'b' },
      {
        fetch: sourceEgress({
          allowedHosts: [],
          resolve: fakeResolver({ 'minio.corp': '10.9.8.7' }),
          route: routeToLoopback(),
          label: 'the S3 endpoint',
        }),
        retryDelayMs: 1,
      },
    );
    const err = await collect(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect((err as Error).message).toBe('refused: `minio.corp` resolves to a private address; list `minio.corp` in SOURCE_ALLOWED_HOSTS to allow it');
  });
});

describe('the s3 driver', () => {
  it('probes with list requests only, and its token equals the one a sync stores', async () => {
    s3.put('guide.md', 'one').put('notes.txt', 'two').put('image.png', 'binary');
    const d = driver();
    const sync = await d.sync();
    const stored = sync.configPatch?.[PROBE_TOKEN_KEY];
    expect(stored).toMatch(/^s3:v1:2:[0-9a-f]{64}$/);
    expect(s3.gets).toBe(2);

    const before = { lists: s3.lists, gets: s3.gets };
    expect(await driver().probe()).toBe(stored);
    expect(s3.lists - before.lists).toBe(1);
    expect(s3.gets - before.gets).toBe(0);
  });

  it('moves the probe token when an object changes, appears or disappears', async () => {
    s3.put('a.md', 'one').put('b.md', 'two');
    const base = await driver().probe();
    s3.put('a.md', 'one!');
    const edited = await driver().probe();
    s3.put('c.md', 'new');
    const added = await driver().probe();
    s3.objects.delete('b.md');
    const removed = await driver().probe();
    expect(new Set([base, edited, added, removed]).size).toBe(4);
  });

  it('takes a change of ETag alone, at the same size, for a changed object', async () => {
    s3.put('a.md', 'one', '"etag-one"');
    const first = await driver().sync();
    expect(s3.gets).toBe(1);
    // Same bytes, same size, a different ETag: nothing but the ETag says the object was replaced.
    s3.put('a.md', 'one', '"etag-two"');
    const probed = await driver().probe();
    expect(probed).not.toBe(first.configPatch?.[PROBE_TOKEN_KEY]);
    await driver().sync();
    expect(s3.gets).toBe(2);
    // And an unchanged ETag is not downloaded again, whatever else moved.
    await driver().sync();
    expect(s3.gets).toBe(2);
  });

  it('reads a listing no further than MAX_LISTING_BYTES, and says so', async () => {
    s3.listOverride = `<ListBucketResult>${'x'.repeat(MAX_LISTING_BYTES + 1)}</ListBucketResult>`;
    await expect(driver().probe()).rejects.toThrow(/S3 listing failed: `.+` the answer is larger than \d+ bytes/);
  });

  it('stops reading an error answer after its head, and hangs up on a body that never ends', async () => {
    s3.scripted.push({
      status: 403,
      body: '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      endless: true,
    });
    const err = (await driver()
      .probe()
      .catch((e: unknown) => e)) as Error;
    // The call returned with S3's code while the server was still writing: the old whole-body read would hang here.
    expect(err.message).toBe('S3 listing failed: HTTP 403 AccessDenied: Access Denied');
    // And the connection was closed by the client, not left open for the rest of the answer.
    await s3.endlessClosed;
    expect(s3.endlessBytes).toBeLessThan(1024 * 1024);
  });

  it('reads one listing page per 1000 keys', async () => {
    s3.pageSize = 2;
    for (const n of ['a', 'b', 'c', 'd', 'e']) s3.put(`${n}.md`, n);
    await driver().probe();
    expect(s3.lists).toBe(3);
    expect(s3.gets).toBe(0);
  });

  it('mirrors the prefix without the prefix, keeps only the source’s extensions and skips folder markers and dot files', async () => {
    s3.put('docs/guide.md', 'g')
      .put('docs/deep/Notes.TXT', 'n')
      .put('docs/photo.png', 'p')
      .put('docs/.hidden.md', 'h')
      .put('docs/', '')
      .put('docs/empty-dir/', '')
      .put('other/skip.md', 's')
      .put('docsx/skip.md', 's');
    const result = await driver({ prefix: 'docs' }).sync();
    expect(await tree()).toEqual(['deep/Notes.TXT', 'guide.md']);
    expect(result.note).toContain('2 objects, 2 downloaded');
    expect(s3.log.filter((r) => r.kind === 'get').map((r) => r.key)).toEqual(['docs/deep/Notes.TXT', 'docs/guide.md']);
  });

  it('downloads only what changed, and removes what is gone', async () => {
    s3.put('a.md', 'one').put('b.md', 'two').put('c.md', 'three');
    await driver().sync();
    expect(s3.gets).toBe(3);

    s3.put('b.md', 'two, edited').objects.delete('c.md');
    s3.put('d.md', 'four');
    const result = await driver().sync();
    expect(s3.gets).toBe(3 + 2);
    expect(await tree()).toEqual(['a.md', 'b.md', 'd.md']);
    expect(await fs.readFile(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), 'b.md'), 'utf8')).toBe('two, edited');
    expect(result.note).toContain('3 objects, 2 downloaded, 1 unchanged, 1 removed');
  });

  it('notes how many keys were listed, so a wide prefix shows', async () => {
    s3.put('a.md', 'x').put('b.bin', 'y').put('c.bin', 'z');
    const result = await driver().sync();
    expect(result.note).toContain('3 key(s) listed under s3://docs-bucket/');
  });

  it('stops at S3_MAX_OBJECTS in key order and says so in capitals, with the probe still counting every object', async () => {
    for (const n of ['a', 'b', 'c', 'd']) s3.put(`${n}.md`, n);
    const result = await driver({}, { S3_MAX_OBJECTS: 2 }).sync();
    expect(await tree()).toEqual(['a.md', 'b.md']);
    expect(result.note).toContain('STOPPED AT THE 2-OBJECT CEILING (S3_MAX_OBJECTS)');
    expect(result.configPatch?.[PROBE_TOKEN_KEY]).toMatch(/^s3:v1:4:/);
    expect(await driver({}, { S3_MAX_OBJECTS: 2 }).probe()).toBe(result.configPatch?.[PROBE_TOKEN_KEY]);
  });

  it('refuses an object over MAX_CONVERTED_FILE_BYTES by name, without downloading it', async () => {
    s3.put('small.md', 'ok').put('big.md', 'x'.repeat(5000));
    const result = await driver({}, { MAX_CONVERTED_FILE_BYTES: 1000 }).sync();
    expect(await tree()).toEqual(['small.md']);
    expect(result.note).toContain('1 over the size limit and not indexed (big.md)');
    expect(s3.log.filter((r) => r.kind === 'get').map((r) => r.key)).toEqual(['small.md']);
  });

  it('skips a key that could leave the root, and says so', async () => {
    s3.put('ok.md', 'ok').put('a/../escape.md', 'bad').put('a//double.md', 'bad');
    const result = await driver().sync();
    expect(await tree()).toEqual(['ok.md']);
    expect(result.note).toContain('2 with a name that cannot be a file path');
  });

  it('fails a run whose download fails, and leaves the files and the token where they were', async () => {
    s3.put('a.md', 'one');
    const first = await driver().sync();
    s3.put('a.md', 'one, edited').put('b.md', 'two');
    s3.scripted.push('ok', slowDown, slowDown, slowDown);
    await expect(driver().sync()).rejects.toThrow(/HTTP 503 SlowDown/);
    expect(await tree()).toEqual(['a.md']);
    expect(await fs.readFile(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), 'a.md'), 'utf8')).toBe('one');
    expect(first.configPatch?.[PROBE_TOKEN_KEY]).not.toBe(await driver().probe());
  });

  it('names the missing credential rather than sending an unsigned request', async () => {
    await expect(driver({}, {}, null).probe()).rejects.toThrow(/no access key stored/);
    expect(s3.log).toEqual([]);
  });

  it('refuses a private host that SOURCE_ALLOWED_HOSTS does not list, naming the rule, the host and the setting', async () => {
    const d = new S3Driver(row({ endpoint: 'http://minio.corp:9000' }), context(), {
      resolve: fakeResolver({ 'minio.corp': '10.9.8.7' }),
      route: routeToLoopback(),
    });
    const err = await d.test().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect(err?.message).toBe('refused: `minio.corp` resolves to a private address; list `minio.corp` in SOURCE_ALLOWED_HOSTS to allow it');
  });

  it('reaches a private host that SOURCE_ALLOWED_HOSTS lists, and only that one', async () => {
    s3.put('a.md', 'x');
    const resolve = fakeResolver({ [HOST]: '10.9.8.7' });
    const route = routeToLoopback('10.9.8.7');
    const listed = new S3Driver(row(), context({ SOURCE_ALLOWED_HOSTS: [HOST] }), { resolve, route }, { retryDelayMs: 1 });
    await expect(listed.test()).resolves.toContain('1 object(s)');
    const unlisted = new S3Driver(row(), context({ SOURCE_ALLOWED_HOSTS: ['other.corp'] }), { resolve, route }, { retryDelayMs: 1 });
    await expect(unlisted.test()).rejects.toThrow(`list \`${HOST}\` in SOURCE_ALLOWED_HOSTS`);
  });

  it('is not widened by the deprecated CONFLUENCE_ALLOWED_HOSTS', async () => {
    const d = new S3Driver(row(), context({ CONFLUENCE_ALLOWED_HOSTS: [HOST] }), {
      resolve: fakeResolver({ [HOST]: '10.9.8.7' }),
      route: routeToLoopback('10.9.8.7'),
    });
    await expect(d.test()).rejects.toThrow(/SOURCE_ALLOWED_HOSTS/);
  });

  it('always refuses loopback and link-local, even for a listed host', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254']) {
      const d = new S3Driver(row({ endpoint: 'http://meta.corp' }), context({ SOURCE_ALLOWED_HOSTS: ['meta.corp'] }), {
        resolve: fakeResolver({ 'meta.corp': address }),
        route: routeToLoopback(),
      });
      await expect(d.test()).rejects.toThrow(/loopback|link-local/);
    }
  });

  it('answers Test with the bucket, the prefix and what it found, and no part of the credential', async () => {
    s3.put('docs/a.md', 'x').put('docs/b.png', 'y');
    const message = await driver({ prefix: 'docs' }).test();
    expect(message).toBe(
      `Connected to s3://${BUCKET}/docs/ on ${HOST}:${s3.port} — 1 object(s) with a readable type (.md, .txt) among 2 key(s) listed`,
    );
    expect(message).not.toContain(ACCESS_KEY_ID);
    expect(message).not.toContain(SECRET_ACCESS_KEY);
  });

  it('does not put the secret anywhere in an error from S3', async () => {
    s3.scripted.push({
      status: 403,
      body: `<Error><Code>InvalidAccessKeyId</Code><Message>The access key you provided does not exist.</Message></Error>`,
    });
    const err = (await driver()
      .test()
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('InvalidAccessKeyId');
    expect(err.message).not.toContain(SECRET_ACCESS_KEY);
  });
});
