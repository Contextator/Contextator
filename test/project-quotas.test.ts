import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QuotaExceededError, QuotaUsageUnavailableError } from '../src/services/errors.js';
import { sourceCurrentDir, stagingDir } from '../src/services/data-dir.js';
import { directoryBytes, overwrittenBytes, resolveQuota, resolveQuotas, UPLOAD_SESSION_TTL_MS } from '../src/services/quotas.js';
import { sweepExpiredUploadSessions, UploadRequestQuota, UploadService } from '../src/services/uploads.js';
import type { DocumentSourceRow } from '../src/db/schema.js';

/**
 * The parts of the per-project quotas ([ADR-0117](../.ssot/ADR.md#adr-0117)) that need no database: how the
 * effective limit is worked out, how stored bytes are measured, the shape of the two errors, and the
 * upload service's refusals, which only look at the filesystem.
 */

describe('resolveQuota', () => {
  it('inherits the instance value when the project has none of its own', () => {
    expect(resolveQuota(null, 500)).toEqual({ limit: 500, inherited: true });
  });

  it('uses the project value when it has one, whatever the instance says', () => {
    expect(resolveQuota(10, 500)).toEqual({ limit: 10, inherited: false });
    expect(resolveQuota(1000, 500)).toEqual({ limit: 1000, inherited: false });
  });

  it('treats the project own 0 as unlimited even when the instance sets a limit', () => {
    expect(resolveQuota(0, 500)).toEqual({ limit: 0, inherited: false });
  });

  it('inherits an unlimited instance (0) as unlimited', () => {
    expect(resolveQuota(null, 0)).toEqual({ limit: 0, inherited: true });
  });
});

describe('resolveQuotas', () => {
  it('resolves the three quotas independently', () => {
    const effective = resolveQuotas(
      { maxDocuments: 5, maxChunks: null, maxUploadBytes: 0 },
      { PROJECT_MAX_DOCUMENTS: 100, PROJECT_MAX_CHUNKS: 2000, PROJECT_MAX_UPLOAD_BYTES: 4096 },
    );
    expect(effective).toEqual({
      documents: { limit: 5, inherited: false },
      chunks: { limit: 2000, inherited: true },
      uploadBytes: { limit: 0, inherited: false },
    });
  });
});

describe('directoryBytes', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quotas-unit-'));
    await mkdir(path.join(root, 'tree', 'nested', 'deeper'), { recursive: true });
    await writeFile(path.join(root, 'tree', 'a.md'), '12345');
    await writeFile(path.join(root, 'tree', 'nested', 'b.md'), '1234567890');
    await writeFile(path.join(root, 'tree', 'nested', 'deeper', 'c.md'), '123');
    await writeFile(path.join(root, 'plain-file'), 'not a directory');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sums every regular file below the directory, recursively', async () => {
    expect(await directoryBytes(path.join(root, 'tree'))).toBe(18);
  });

  it('is 0 for a directory that does not exist', async () => {
    expect(await directoryBytes(path.join(root, 'missing'))).toBe(0);
  });

  it('is QuotaUsageUnavailableError when the path cannot be read as a directory', async () => {
    await expect(directoryBytes(path.join(root, 'plain-file'))).rejects.toBeInstanceOf(QuotaUsageUnavailableError);
  });
});

describe('the quota errors', () => {
  it('carries the numbers as fields and a stable code', () => {
    const err = new QuotaExceededError('max_upload_bytes', 100, 90, 20);
    expect(err.code).toBe('quota_exceeded');
    expect(err).toMatchObject({ quota: 'max_upload_bytes', limit: 100, used: 90, requested: 20 });
    expect(err.message).toContain('100');
    expect(err.message).toContain('90 used');
    expect(err.message).toContain('20 more requested');
  });

  it('names what is counted for each quota', () => {
    expect(new QuotaExceededError('max_documents', 3, 3, 1).message).toContain('documents');
    expect(new QuotaExceededError('max_chunks', 3, 3, 1).message).toContain('chunks');
  });

  it('keeps the unmeasurable-usage error apart from the refusal', () => {
    const err = new QuotaUsageUnavailableError('/data/x', new Error('EIO'));
    expect(err.code).toBe('quota_usage_unavailable');
    expect(err.path).toBe('/data/x');
    expect(err).not.toBeInstanceOf(QuotaExceededError);
  });
});

describe('UploadService against a quota', () => {
  let dataDir: string;
  let service: UploadService;
  const source = {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: '11111111-1111-4111-8111-111111111111',
    config: {},
    flavor: 'plain',
  } as unknown as DocumentSourceRow;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'quotas-upload-'));
    service = new UploadService({
      DATA_DIR: dataDir,
      UPLOAD_MAX_FILE_BYTES: 1024 * 1024,
      UPLOAD_MAX_ARCHIVE_BYTES: 1024 * 1024,
      ARCHIVE_MAX_ENTRIES: 100,
      ARCHIVE_MAX_TOTAL_BYTES: 1024 * 1024,
    });
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('opens no session for a project already at its cap', async () => {
    await expect(service.createSession(source, { limit: 100, used: 100, sourceCurrent: 0 })).rejects.toMatchObject({
      code: 'quota_exceeded',
      quota: 'max_upload_bytes',
      limit: 100,
      used: 100,
      requested: 0,
    });
  });

  it('opens a session below the cap, and none is needed when the project is unlimited', async () => {
    expect(await service.createSession(source, { limit: 100, used: 10, sourceCurrent: 0 })).toMatch(/^[0-9a-f]{32}$/);
    expect(await service.createSession(source)).toMatch(/^[0-9a-f]{32}$/);
  });

  const bytes = (n: number) => Buffer.from('x'.repeat(n));
  const stream = async (data: Buffer) => (await import('node:stream')).Readable.from([data]);
  const quota = (limit: number, used: number, sourceCurrent = 0) => ({ limit, used, sourceCurrent });

  /** A source of its own, so one test's files never count in another's. */
  const freshSource = (n: number): DocumentSourceRow =>
    ({ ...source, id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}` }) as unknown as DocumentSourceRow;
  const putCurrent = async (src: DocumentSourceRow, rel: string, data: Buffer) => {
    const file = path.join(sourceCurrentDir(dataDir, src.projectId, src.id), rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  };
  const stagedFile = (src: DocumentSourceRow, session: string, rel: string) =>
    path.join(stagingDir(dataDir, src.projectId, src.id, session), 'files', rel);

  it('refuses a file that would cross the cap and reports what it had counted', async () => {
    const src = freshSource(1);
    const session = await service.createSession(src, quota(100, 0));
    const tracker = await service.beginRequest(src, session, quota(100, 90));
    expect(tracker).toBeInstanceOf(UploadRequestQuota);
    await expect(service.addFile(src, session, 'big.md', await stream(bytes(20)), tracker)).rejects.toMatchObject({
      code: 'quota_exceeded',
      limit: 100,
      used: 90,
      requested: 20,
    });
    // The caller takes the request back; nothing of it is left once that has run.
    await service.rollbackRequest(tracker);
    expect(await directoryBytes(path.join(stagingDir(dataDir, src.projectId, src.id, session), '..'))).toBe(0);
  });

  it('accepts a file that fits and tracks the bytes it took', async () => {
    const src = freshSource(2);
    const session = await service.createSession(src, quota(100, 0));
    const tracker = await service.beginRequest(src, session, quota(100, 50));
    await service.addFile(src, session, 'ok.md', await stream(bytes(20)), tracker);
    expect(tracker.requestBytes).toBe(20);
    await service.finishRequest(tracker);
    expect((await stat(stagedFile(src, session, 'ok.md'))).size).toBe(20);
  });

  it('counts a re-uploaded file of an earlier request once', async () => {
    const src = freshSource(3);
    const session = await service.createSession(src, quota(100, 0));
    const first = await service.beginRequest(src, session, quota(100, 0));
    await service.addFile(src, session, 'a.md', await stream(bytes(60)), first);
    await service.finishRequest(first);
    // The session now stores 60 bytes; the same path again with 60 more bytes of content adds nothing.
    const second = await service.beginRequest(src, session, quota(100, 60));
    await service.addFile(src, session, 'a.md', await stream(bytes(60)), second);
    expect(second.requestBytes).toBe(0);
    await service.finishRequest(second);
    expect((await stat(stagedFile(src, session, 'a.md'))).size).toBe(60);
  });

  it('counts a file that overwrites a stored one by the difference only', async () => {
    const src = freshSource(4);
    await putCurrent(src, 'a.md', bytes(60));
    const session = await service.createSession(src, quota(100, 60));
    const tracker = await service.beginRequest(src, session, quota(100, 60, 60));
    await service.addFile(src, session, 'a.md', await stream(bytes(70)), tracker);
    expect(tracker.requestBytes).toBe(10);
  });

  it('does not count a stored file twice once a staged file overwrites it', async () => {
    const src = freshSource(5);
    await putCurrent(src, 'a.md', bytes(60));
    const session = await service.createSession(src, quota(200, 60));
    const first = await service.beginRequest(src, session, quota(200, 60, 60));
    await service.addFile(src, session, 'a.md', await stream(bytes(60)), first);
    await service.finishRequest(first);
    // Stored 60 + staged 60 = 120 on disk, of which the 60 stored bytes are going to be overwritten.
    const second = await service.beginRequest(src, session, quota(200, 120, 60));
    expect(second.baseUsed).toBe(60);
  });

  it('subtracts a stored file once when one request sends its path several times', async () => {
    const src = freshSource(7);
    await putCurrent(src, 'big.md', bytes(400));
    const session = await service.createSession(src, quota(1000, 400));
    const tracker = await service.beginRequest(src, session, quota(1000, 400, 400));
    for (let i = 0; i < 3; i++) await service.addFile(src, session, 'big.md', await stream(bytes(1)), tracker);
    // 400 stored bytes are replaced by 1, once: the repeats replace the request's own earlier copy.
    expect(tracker.requestBytes).toBe(-399);
    // 1 + 1500 over a cap of 1000 does not fit, which a thrice-subtracted 400 would have hidden.
    await expect(service.addFile(src, session, 'new.md', await stream(bytes(1500)), tracker)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  /** A source in a project of its own: the reservation is per project, and the other tests leave trackers open in theirs. */
  const isolatedSource = (n: number): DocumentSourceRow =>
    ({ ...freshSource(n), projectId: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}` }) as unknown as DocumentSourceRow;

  it('lets concurrent requests of one project see each other, though each measured the project alone', async () => {
    const src = isolatedSource(8);
    const sessions = await Promise.all([1, 2, 3].map(() => service.createSession(src, quota(100, 0))));
    // All three measured an empty project before any of them wrote.
    const trackers = await Promise.all(sessions.map((s) => service.beginRequest(src, s, quota(100, 0))));
    await service.addFile(src, sessions[0]!, 'a.md', await stream(bytes(40)), trackers[0]);
    await service.addFile(src, sessions[1]!, 'b.md', await stream(bytes(40)), trackers[1]);
    await expect(service.addFile(src, sessions[2]!, 'c.md', await stream(bytes(40)), trackers[2])).rejects.toMatchObject({
      code: 'quota_exceeded',
      limit: 100,
      used: 80,
      requested: 40,
    });
    await service.finishRequest(trackers[0]!);
    await service.finishRequest(trackers[1]!);
    await service.rollbackRequest(trackers[2]!);
  });

  it('gives the reservation back when a request is taken back, and keeps it while another request runs', async () => {
    const src = isolatedSource(9);
    const [s1, s2, s3, s4] = await Promise.all([1, 2, 3, 4].map(() => service.createSession(src, quota(100, 0))));
    const a = await service.beginRequest(src, s1!, quota(100, 0));
    const b = await service.beginRequest(src, s2!, quota(100, 0));
    await service.addFile(src, s1!, 'a.md', await stream(bytes(60)), a);
    await service.rollbackRequest(a);
    // The taken-back 60 bytes are neither on disk nor reserved: b may use them.
    await service.addFile(src, s2!, 'b.md', await stream(bytes(60)), b);
    // b is still running, so its 60 bytes are in the reservation for a request that starts now. That request
    // measures the disk after b wrote, so it does not count them a second time.
    const c = await service.beginRequest(src, s3!, quota(100, 60));
    expect(c.reservedAtStart).toBe(60);
    expect(c.projectedUsed).toBe(60);
    await service.finishRequest(b);
    // b finishing leaves its bytes in the total for the requests still running (c measured the disk
    // before it landed in `files/`): a later request of c's 40 bytes still fits exactly.
    await service.addFile(src, s3!, 'c.md', await stream(bytes(40)), c);
    await expect(service.addFile(src, s4!, 'd.md', await stream(bytes(1)), c)).rejects.toMatchObject({ code: 'quota_exceeded' });
    await service.rollbackRequest(c);
  });

  it('starts no tracking when the project has no quota, and leaves the reservation when measuring fails', async () => {
    const src = isolatedSource(10);
    const session = await service.createSession(src);
    expect(await service.startRequest(src, session, async () => undefined)).toBeUndefined();
    await expect(
      service.startRequest(src, session, async () => {
        throw new Error('measure failed');
      }),
    ).rejects.toThrow('measure failed');
    const tracker = await service.startRequest(src, session, async () => quota(100, 0));
    expect(tracker?.reservedAtStart).toBe(0);
    await service.rollbackRequest(tracker!);
  });

  it('keeps what earlier requests staged when a later request over the same path is refused', async () => {
    const src = freshSource(6);
    const session = await service.createSession(src, quota(100, 0));
    const first = await service.beginRequest(src, session, quota(100, 0));
    await service.addFile(src, session, 'a.md', await stream(Buffer.from('old content')), first);
    await service.finishRequest(first);
    const second = await service.beginRequest(src, session, quota(100, 11));
    await expect(service.addFile(src, session, 'a.md', await stream(bytes(150)), second)).rejects.toBeInstanceOf(QuotaExceededError);
    await service.rollbackRequest(second);
    expect(await readFile(stagedFile(src, session, 'a.md'), 'utf8')).toBe('old content');
  });

  it('measures the bytes of a tree that overwrite files of another', async () => {
    const src = freshSource(7);
    await putCurrent(src, 'a.md', bytes(5));
    await putCurrent(src, 'sub/b.md', bytes(7));
    const session = await service.createSession(src);
    await mkdir(path.dirname(stagedFile(src, session, 'sub/b.md')), { recursive: true });
    await writeFile(stagedFile(src, session, 'sub/b.md'), bytes(100));
    await writeFile(stagedFile(src, session, 'c.md'), bytes(100));
    expect(
      await overwrittenBytes(
        path.join(stagingDir(dataDir, src.projectId, src.id, session), 'files'),
        sourceCurrentDir(dataDir, src.projectId, src.id),
      ),
    ).toBe(7);
  });

  describe('the sweep of idle sessions', () => {
    const exists = (file: string) =>
      stat(file).then(
        () => true,
        () => false,
      );
    const age = async (dir: string, ms: number) => {
      const when = new Date(Date.now() - ms);
      await utimes(dir, when, when);
    };

    it('deletes a session idle past the expiry, files and scratch included, and leaves a live one', async () => {
      const src = isolatedSource(11);
      const stale = await service.createSession(src);
      const live = await service.createSession(src);
      await writeFile(stagedFile(src, stale, 'a.md'), bytes(30));
      await mkdir(path.join(stagingDir(dataDir, src.projectId, src.id, stale), 'request-abc'), { recursive: true });
      await writeFile(stagedFile(src, live, 'b.md'), bytes(30));
      await age(stagingDir(dataDir, src.projectId, src.id, stale), UPLOAD_SESSION_TTL_MS + 60_000);
      await age(stagingDir(dataDir, src.projectId, src.id, live), UPLOAD_SESSION_TTL_MS - 60_000);

      expect(await sweepExpiredUploadSessions(dataDir)).toBe(1);
      expect(await exists(stagingDir(dataDir, src.projectId, src.id, stale))).toBe(false);
      expect(await exists(stagedFile(src, live, 'b.md'))).toBe(true);
      // What the quota counts and what is on disk agree: only the live session's 30 bytes remain.
      expect(await directoryBytes(path.join(stagingDir(dataDir, src.projectId, src.id, live), '..'))).toBe(30);
    });

    it('keeps a session that any use renewed, however old its files are', async () => {
      const src = isolatedSource(12);
      const session = await service.createSession(src);
      await writeFile(stagedFile(src, session, 'a.md'), bytes(10));
      await age(stagingDir(dataDir, src.projectId, src.id, session), UPLOAD_SESSION_TTL_MS + 60_000);
      await service.renew(src, session);
      expect(await sweepExpiredUploadSessions(dataDir)).toBe(0);
      expect(await exists(stagedFile(src, session, 'a.md'))).toBe(true);
    });

    it('does not touch the committed tree, other files of .staging, or a missing data directory', async () => {
      const src = isolatedSource(13);
      await putCurrent(src, 'kept.md', bytes(5));
      const stray = path.join(stagingDir(dataDir, src.projectId, src.id, '0'.repeat(32)), '..', 'not-a-session');
      await mkdir(stray, { recursive: true });
      await age(stray, UPLOAD_SESSION_TTL_MS * 3);
      await sweepExpiredUploadSessions(dataDir);
      expect(await exists(path.join(sourceCurrentDir(dataDir, src.projectId, src.id), 'kept.md'))).toBe(true);
      expect(await exists(stray)).toBe(true);
      expect(await sweepExpiredUploadSessions(path.join(dataDir, 'does-not-exist'))).toBe(0);
    });

    it('sweeps by the clock it is given', async () => {
      const src = isolatedSource(14);
      const session = await service.createSession(src);
      expect(await sweepExpiredUploadSessions(dataDir)).toBe(0);
      expect(await sweepExpiredUploadSessions(dataDir, Date.now() + UPLOAD_SESSION_TTL_MS + 60_000)).toBeGreaterThanOrEqual(1);
      expect(await exists(stagingDir(dataDir, src.projectId, src.id, session))).toBe(false);
    });
  });

  describe('at commit', () => {
    const stage = async (src: DocumentSourceRow, files: Record<string, number>) => {
      const session = await service.createSession(src);
      for (const [rel, size] of Object.entries(files)) {
        await mkdir(path.dirname(stagedFile(src, session, rel)), { recursive: true });
        await writeFile(stagedFile(src, session, rel), bytes(size));
      }
      return session;
    };

    it('lets an add over the same paths through when the tree fits once', async () => {
      const src = freshSource(8);
      await putCurrent(src, 'a.md', bytes(60));
      const session = await stage(src, { 'a.md': 60 });
      // `used` leaves the committing session out; the stored 60 bytes are what the add overwrites.
      expect(await service.commit(src, session, 'add', quota(100, 60, 60))).toBe(1);
    });

    it('refuses an add that does not fit beside what stays', async () => {
      const src = freshSource(9);
      await putCurrent(src, 'a.md', bytes(60));
      const session = await stage(src, { 'b.md': 60 });
      await expect(service.commit(src, session, 'add', quota(100, 60, 60))).rejects.toMatchObject({
        code: 'quota_exceeded',
        used: 60,
        requested: 60,
      });
      // The session is still there for a retry after room is made.
      expect((await stat(stagedFile(src, session, 'b.md'))).size).toBe(60);
    });

    it('lets a replace through that fits once the stored tree is gone', async () => {
      const src = freshSource(10);
      await putCurrent(src, 'a.md', bytes(90));
      const session = await stage(src, { 'b.md': 90 });
      expect(await service.commit(src, session, 'replace', quota(100, 90, 90))).toBe(1);
    });

    it('counts other sources of the project in a replace', async () => {
      const src = freshSource(11);
      await putCurrent(src, 'a.md', bytes(40));
      const session = await stage(src, { 'b.md': 40 });
      // 30 more bytes live in another upload source: 40 + 30 stays after the swap, 70 > 60.
      await expect(service.commit(src, session, 'replace', quota(60, 70, 40))).rejects.toMatchObject({
        code: 'quota_exceeded',
        used: 30,
        requested: 40,
      });
    });
  });
});
