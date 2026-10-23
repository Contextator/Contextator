import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupRefused } from '../scripts/backup-archive.js';
import {
  fetchArchive,
  keepFromEnv,
  listArchives,
  publishArchive,
  S3Client,
  type S3Target,
  s3TargetFromEnv,
  signRequest,
  TIMESTAMPED_ARCHIVE,
} from '../scripts/backup-s3.js';
import { parseBackupArgs } from '../scripts/backup.js';
import { parseRestoreArgs } from '../scripts/restore.js';

// The two vectors are the worked examples in AWS's own Signature Version 4 documentation for S3
// ("Authenticating Requests: Using the Authorization Header"), so the signer is checked against the
// service's published answer and not against itself.
const DOC_KEY = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('signRequest', () => {
  it('matches the AWS documentation example for GET Object with a Range header', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: [],
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      date: new Date('2013-05-24T00:00:00Z'),
      ...DOC_KEY,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('matches the AWS documentation example for GET Bucket (List Objects) with a query string', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/',
      query: [
        ['prefix', 'J'],
        ['max-keys', '2'],
      ],
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      date: new Date('2013-05-24T00:00:00Z'),
      ...DOC_KEY,
    });
    expect(headers.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('signs the session token when there is one', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'h',
      path: '/',
      query: [],
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      sessionToken: 'tok',
      date: new Date('2013-05-24T00:00:00Z'),
      ...DOC_KEY,
    });
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.authorization).toContain('x-amz-security-token');
  });
});

describe('s3TargetFromEnv', () => {
  const base = { BACKUP_S3_BUCKET: 'backups', BACKUP_S3_ACCESS_KEY_ID: 'id', BACKUP_S3_SECRET_ACCESS_KEY: 'secret' };

  it('defaults to AWS in us-east-1 and normalises the prefix', () => {
    const target = s3TargetFromEnv({ ...base, BACKUP_S3_PREFIX: '/team/prod/' });
    expect(target).toMatchObject({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      bucket: 'backups',
      prefix: 'team/prod',
      region: 'us-east-1',
    });
  });

  it('keeps a custom endpoint, its port and its base path', () => {
    expect(s3TargetFromEnv({ ...base, BACKUP_S3_ENDPOINT: 'http://minio:9000/' }).endpoint).toBe('http://minio:9000');
    expect(s3TargetFromEnv({ ...base, BACKUP_S3_ENDPOINT: 'https://gw.example.com/s3/' }).endpoint).toBe('https://gw.example.com/s3');
  });

  it('names every missing variable at once and never echoes a secret', () => {
    const refusal = (() => {
      try {
        s3TargetFromEnv({ BACKUP_S3_SECRET_ACCESS_KEY: 'do-not-print' });
      } catch (err) {
        return err as BackupRefused;
      }
      throw new Error('expected a refusal');
    })();
    expect(refusal).toBeInstanceOf(BackupRefused);
    expect(refusal.code).toBe('s3_config');
    expect(refusal.message).toContain('BACKUP_S3_BUCKET');
    expect(refusal.message).toContain('BACKUP_S3_ACCESS_KEY_ID');
    expect(refusal.message).not.toContain('do-not-print');
  });

  it.each([
    ['an endpoint that is not a URL', { BACKUP_S3_ENDPOINT: 'minio' }],
    ['an endpoint with a scheme that is not http', { BACKUP_S3_ENDPOINT: 'ftp://minio' }],
    ['an endpoint carrying credentials', { BACKUP_S3_ENDPOINT: 'https://user:pass@minio' }],
    ['a prefix that climbs', { BACKUP_S3_PREFIX: 'a/../b' }],
    ['a bucket that is not a bucket name', { BACKUP_S3_BUCKET: 'Bad Bucket' }],
    ['a region with a slash', { BACKUP_S3_REGION: 'us/east' }],
    ['an upper-case region', { BACKUP_S3_REGION: 'US-EAST-1' }],
  ])('refuses %s', (_label, extra) => {
    expect(() => s3TargetFromEnv({ ...base, ...extra })).toThrow(BackupRefused);
  });
});

describe('keepFromEnv', () => {
  it('defaults to the sidecar default and refuses what the sidecar would not understand', () => {
    expect(keepFromEnv({})).toBe(7);
    expect(keepFromEnv({ BACKUP_KEEP: '3' })).toBe(3);
    for (const bad of ['0', '-1', 'abc', '1.5']) expect(() => keepFromEnv({ BACKUP_KEEP: bad })).toThrow(BackupRefused);
  });
});

describe('argument parsing', () => {
  it('lets --s3 stand before or after the file, and refuses unknown flags', () => {
    expect(parseBackupArgs(['--s3'])).toEqual({ help: false, s3: true });
    expect(parseBackupArgs(['/data/x.tar.gz', '--s3'])).toEqual({ help: false, s3: true, file: '/data/x.tar.gz' });
    expect(parseBackupArgs(['--s3', '/data/x.tar.gz']).file).toBe('/data/x.tar.gz');
    expect(parseBackupArgs(['/data/x.tar.gz'])).toEqual({ help: false, s3: false, file: '/data/x.tar.gz' });
    expect(() => parseBackupArgs(['-s3'])).toThrow(BackupRefused);
    expect(() => parseBackupArgs(['a', 'b'])).toThrow(BackupRefused);
  });

  it('reads restore references the same way', () => {
    expect(parseRestoreArgs(['--s3', 'latest', '--check'])).toEqual({ help: false, s3: true, check: true, reference: 'latest' });
    expect(parseRestoreArgs(['a.tar.gz'])).toEqual({ help: false, s3: false, check: false, reference: 'a.tar.gz' });
    expect(() => parseRestoreArgs(['--bogus'])).toThrow(BackupRefused);
  });
});

describe('the archive name pattern', () => {
  it('matches exactly what defaultArchiveName writes and nothing a person named by hand', () => {
    expect(TIMESTAMPED_ARCHIVE.test('contextator-backup-2026-09-22T12-00-00Z.tar.gz')).toBe(true);
    for (const name of ['pre-upgrade.tar.gz', 'contextator-backup-2026-09-22T12-00-00Z.tar.gz.partial', 'contextator-backup-latest.tar.gz'])
      expect(TIMESTAMPED_ARCHIVE.test(name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// A fake bucket behind `fetch`, so the client's wire behaviour is exercised without a network.
// ---------------------------------------------------------------------------------------------------

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: Buffer;
}

class FakeBucket {
  readonly objects = new Map<string, Buffer>();
  readonly calls: Call[] = [];
  readonly uploads = new Map<string, Map<number, Buffer>>();
  pageSize = 1000;
  failNext: { status: number; code: string; times: number } | undefined;
  failPart: number | undefined;
  /** The completion commits, then its answer is lost (a 503); the retry finds the upload id spent. */
  loseCompletionAnswer = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const call: Call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body };
    this.calls.push(call);

    if (this.failNext && this.failNext.times > 0) {
      this.failNext.times--;
      return new Response(`<Error><Code>${this.failNext.code}</Code><Message>nope</Message></Error>`, { status: this.failNext.status });
    }

    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    const key = rest.join('/');
    if (bucket !== 'bkt') return new Response('<Error><Code>NoSuchBucket</Code><Message>no</Message></Error>', { status: 404 });

    const q = url.searchParams;
    if (call.method === 'GET' && key === '') return this.listing(q);
    if (call.method === 'POST' && q.has('uploads')) {
      const id = `upload-${this.uploads.size + 1}`;
      this.uploads.set(id, new Map());
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (call.method === 'PUT' && q.has('uploadId')) {
      const number = Number(q.get('partNumber'));
      if (this.failPart === number) return new Response('<Error><Code>InternalError</Code></Error>', { status: 400 });
      this.uploads.get(q.get('uploadId') as string)?.set(number, body);
      return new Response('', { headers: { etag: `"etag-${number}"` } });
    }
    if (call.method === 'POST' && q.has('uploadId')) {
      const parts = this.uploads.get(q.get('uploadId') as string);
      if (!parts) return new Response('<Error><Code>NoSuchUpload</Code><Message>spent</Message></Error>', { status: 404 });
      this.objects.set(key, Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part)));
      this.uploads.delete(q.get('uploadId') as string);
      if (this.loseCompletionAnswer) {
        this.loseCompletionAnswer = false;
        return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
      }
      return new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
    }
    if (call.method === 'DELETE' && q.has('uploadId')) {
      this.uploads.delete(q.get('uploadId') as string);
      return new Response(null, { status: 204 });
    }
    if (call.method === 'PUT') {
      this.objects.set(key, body);
      return new Response('', { headers: { etag: '"x"' } });
    }
    if (call.method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (call.method === 'HEAD') {
      const found = this.objects.get(key);
      return found ? new Response(null, { headers: { 'content-length': String(found.length) } }) : new Response(null, { status: 404 });
    }
    if (call.method === 'GET') {
      const found = this.objects.get(key);
      if (!found) return new Response('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>', { status: 404 });
      return new Response(new Uint8Array(found));
    }
    return new Response('?', { status: 400 });
  };

  private listing(q: URLSearchParams): Response {
    const prefix = q.get('prefix') ?? '';
    const all = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = q.get('continuation-token') ? Number(q.get('continuation-token')) : 0;
    const page = all.slice(start, start + this.pageSize);
    const more = start + this.pageSize < all.length;
    const contents = page
      .map(
        (key) =>
          `<Contents><Key>${key.replace(/&/g, '&amp;')}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${this.objects.get(key)?.length}</Size></Contents>`,
      )
      .join('');
    return new Response(
      `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`,
    );
  }
}

const TARGET: S3Target = {
  endpoint: 'http://minio:9000',
  bucket: 'bkt',
  prefix: 'team/prod',
  region: 'us-east-1',
  accessKeyId: 'AK',
  secretAccessKey: 'SECRET-VALUE',
};
const name = (n: number) => `contextator-backup-2026-09-${String(n).padStart(2, '0')}T12-00-00Z.tar.gz`;

describe('S3Client against a fake bucket', () => {
  let dir: string;
  let bucket: FakeBucket;
  const client = () => new S3Client(TARGET, { fetch: bucket.fetch, partSize: 5, retryDelayMs: 0, now: () => new Date('2026-09-22T12:00:00Z') });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'contextator-s3-'));
    bucket = new FakeBucket();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts a small archive in one request, path-style, signed with the real payload hash', async () => {
    const file = path.join(dir, name(1));
    await writeFile(file, 'abc');
    const result = await publishArchive(client(), file, 7, () => undefined);

    expect(result.key).toBe(`team/prod/${name(1)}`);
    expect(bucket.objects.get(result.key)?.toString()).toBe('abc');
    const put = bucket.calls[0];
    expect(put.url.pathname).toBe(`/bkt/team/prod/${name(1)}`);
    expect(put.headers.get('x-amz-content-sha256')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(put.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20260922\/us-east-1\/s3\/aws4_request/);
  });

  it('uploads a file larger than one part as a multipart upload and the object is the whole file', async () => {
    const file = path.join(dir, name(1));
    await writeFile(file, '0123456789ab'); // 12 bytes, parts of 5 -> 5 + 5 + 2
    await client().uploadFile(`team/prod/${name(1)}`, file);

    expect(bucket.objects.get(`team/prod/${name(1)}`)?.toString()).toBe('0123456789ab');
    expect(bucket.calls.filter((c) => c.url.searchParams.has('partNumber')).map((c) => c.body.length)).toEqual([5, 5, 2]);
    const completion = bucket.calls.at(-1);
    expect(completion?.body.toString()).toContain('<PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag>');
    expect(bucket.uploads.size).toBe(0);
  });

  it('aborts a multipart upload that fails, so nothing is left to be billed for', async () => {
    const file = path.join(dir, name(1));
    await writeFile(file, '0123456789ab');
    bucket.failPart = 2;
    await expect(client().uploadFile(`team/prod/${name(1)}`, file)).rejects.toThrow(/part 2/);
    expect(bucket.uploads.size).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });

  it('treats NoSuchUpload on a retried completion as success when the object is there in full', async () => {
    const file = path.join(dir, name(1));
    await writeFile(file, '0123456789ab');
    bucket.loseCompletionAnswer = true;
    await client().uploadFile(`team/prod/${name(1)}`, file);
    expect(bucket.objects.get(`team/prod/${name(1)}`)?.toString()).toBe('0123456789ab');
    expect(bucket.calls.filter((call) => call.method === 'POST' && call.url.searchParams.has('uploadId'))).toHaveLength(2);
    expect(bucket.calls.some((call) => call.method === 'HEAD')).toBe(true);
  });

  it('still fails a retried completion whose object is not there, rather than calling it done', async () => {
    const file = path.join(dir, name(1));
    await writeFile(file, '0123456789ab');
    // The first completion answers 503 having stored nothing, and the upload id is gone by the retry:
    // NoSuchUpload is then the true answer, and the missing object is what proves it.
    let completions = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' && new URL(String(input)).searchParams.has('uploadId') && completions++ === 0) {
        bucket.uploads.clear();
        return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
      }
      return bucket.fetch(input, init);
    };
    const lossy = new S3Client(TARGET, { fetch: flaky, partSize: 5, retryDelayMs: 0 });
    await expect(lossy.uploadFile(`team/prod/${name(1)}`, file)).rejects.toThrow(/NoSuchUpload/);
    expect(bucket.objects.size).toBe(0);
  });

  it('retries a 5xx on the same request and reports a 4xx with S3 code, not credentials', async () => {
    const file = path.join(dir, name(1));
    await writeFile(file, 'abc');
    bucket.failNext = { status: 503, code: 'SlowDown', times: 1 };
    await client().uploadFile(`team/prod/${name(1)}`, file);
    expect(bucket.objects.size).toBe(1);

    bucket.failNext = { status: 403, code: 'AccessDenied', times: 5 };
    const refusal: unknown = await client()
      .uploadFile(`team/prod/${name(2)}`, file)
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(BackupRefused);
    const { message } = refusal as BackupRefused;
    expect(message).toContain('AccessDenied');
    expect(message).not.toContain('SECRET-VALUE');
  });

  it('keeps the newest BACKUP_KEEP timestamped archives and leaves every other name alone', async () => {
    for (const n of [1, 2, 3, 4, 5]) bucket.objects.set(`team/prod/${name(n)}`, Buffer.from(String(n)));
    bucket.objects.set('team/prod/pre-upgrade.tar.gz', Buffer.from('mine'));
    bucket.objects.set(`team/other/${name(1)}`, Buffer.from('another prefix'));
    bucket.objects.set(`team/prod/sub/${name(1)}`, Buffer.from('nested'));
    const file = path.join(dir, name(6));
    await writeFile(file, 'new');

    const result = await publishArchive(client(), file, 3, () => undefined);

    expect(result.deleted.sort()).toEqual([`team/prod/${name(1)}`, `team/prod/${name(2)}`, `team/prod/${name(3)}`]);
    expect([...bucket.objects.keys()].sort()).toEqual(
      [
        `team/other/${name(1)}`,
        'team/prod/pre-upgrade.tar.gz',
        `team/prod/sub/${name(1)}`,
        `team/prod/${name(4)}`,
        `team/prod/${name(5)}`,
        `team/prod/${name(6)}`,
      ].sort(),
    );
  });

  it('deletes nothing when the upload fails', async () => {
    for (const n of [1, 2, 3]) bucket.objects.set(`team/prod/${name(n)}`, Buffer.from('x'));
    const file = path.join(dir, name(4));
    await writeFile(file, 'new');
    bucket.failNext = { status: 403, code: 'AccessDenied', times: 10 };
    await expect(publishArchive(client(), file, 1, () => undefined)).rejects.toThrow(BackupRefused);
    bucket.failNext = undefined;
    expect(bucket.objects.size).toBe(3);
  });

  it('follows continuation tokens when listing', async () => {
    for (let n = 1; n <= 5; n++) bucket.objects.set(`team/prod/${name(n)}`, Buffer.from('x'));
    bucket.pageSize = 2;
    const listed = await listArchives(client());
    expect(listed.map((o) => o.key)).toEqual([5, 4, 3, 2, 1].map((n) => `team/prod/${name(n)}`));
  });

  it('downloads "latest" and a named archive to a fixed local name, and refuses a path as a name', async () => {
    bucket.objects.set(`team/prod/${name(1)}`, Buffer.from('old'));
    bucket.objects.set(`team/prod/${name(2)}`, Buffer.from('new'));
    bucket.objects.set('team/prod/hand-made.tar.gz', Buffer.from('hand'));

    const latest = await fetchArchive(client(), 'latest', path.join(dir, 'a'), () => undefined);
    expect(path.basename(latest)).toBe('archive.tar.gz');
    expect((await readFile(latest)).toString()).toBe('new');

    const named = await fetchArchive(client(), 'hand-made.tar.gz', path.join(dir, 'b'), () => undefined);
    expect((await readFile(named)).toString()).toBe('hand');

    await expect(fetchArchive(client(), '../x.tar.gz', path.join(dir, 'c'), () => undefined)).rejects.toThrow(BackupRefused);
    await expect(fetchArchive(client(), 'missing.tar.gz', path.join(dir, 'd'), () => undefined)).rejects.toThrow(/NoSuchKey/);
  });

  it('says plainly when the bucket holds no archive for "latest"', async () => {
    await expect(fetchArchive(client(), 'latest', path.join(dir, 'a'), () => undefined)).rejects.toThrow(/No archive named/);
  });
});
