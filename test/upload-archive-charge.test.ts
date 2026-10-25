import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DocumentSourceRow } from '../src/db/schema.js';
import { ArchiveLimitError } from '../src/services/archives.js';
import { stagingDir, stagingRootDir } from '../src/services/data-dir.js';
import { directoryBytes } from '../src/services/quotas.js';
import { UploadService } from '../src/services/uploads.js';

/**
 * An archive that stops part-way still counts what it had already unpacked against the project's upload
 * quota. `vi.mock` applies to the whole file, which is why this is not a case of `test/project-quotas.test.ts`.
 *
 * A real zip cannot make "stops in the middle" deterministic — it would depend on the order `readdir` returns
 * the entries in — so the unpacking is replaced by one that writes a fixed 40-byte file, records it in `stats`
 * exactly as `extractArchive` does, and then throws the error a limit throws. Everything around it
 * (`addFile`, `charge`, the tracker, `finishRequest`) is the real code.
 */

const PARTIAL_BYTES = 40;

vi.mock('../src/services/archives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/archives.js')>();
  return {
    ...actual,
    extractArchive: vi.fn(async (_archive: string, dest: string, _limits: unknown, stats: import('../src/services/archives.js').ImportStats) => {
      const target = path.join(dest, 'partial.md');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'x'.repeat(PARTIAL_BYTES));
      stats.added?.push(target);
      stats.files++;
      stats.bytes += PARTIAL_BYTES;
      throw new actual.ArchiveLimitError('Too many files (limit 1)');
    }),
  };
});

describe('an archive that stops part-way, against a quota', () => {
  let dataDir: string;
  let service: UploadService;
  const source = {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: '11111111-1111-4111-8111-111111111111',
    config: {},
    flavor: 'plain',
  } as unknown as DocumentSourceRow;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'archive-charge-'));
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

  const bytes = (n: number) => Buffer.from('x'.repeat(n));
  const stream = (data: Buffer) => Readable.from([data]);
  const quota = (limit: number, used: number, sourceCurrent = 0) => ({ limit, used, sourceCurrent });
  /** A project of its own, so one test's staged files are never in another's measurement. */
  const isolatedSource = (n: number): DocumentSourceRow =>
    ({
      ...source,
      id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
      projectId: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`,
    }) as unknown as DocumentSourceRow;
  /** What the upload route measures: the staging tree without the scratch directories of the requests running now. */
  const measureLikeTheRoute = (src: DocumentSourceRow, limit: number) => async (skipDirs: ReadonlySet<string>) =>
    quota(limit, await directoryBytes(stagingRootDir(dataDir, src.projectId, src.id), skipDirs));

  it('counts the files it had unpacked, once, and still reports the archive error', async () => {
    const src = isolatedSource(1);
    const session = await service.createSession(src, quota(100, 0));
    const tracker = await service.startRequest(src, session, measureLikeTheRoute(src, 100));
    expect(tracker).toBeDefined();

    // The error is the archive's, not a quota error: 40 of 100 bytes fit.
    const failure = await service.addFile(src, session, 'x.zip', stream(bytes(10)), tracker).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArchiveLimitError);
    expect((failure as Error).message).toBe('Too many files (limit 1)');

    expect(tracker!.requestBytes).toBe(PARTIAL_BYTES);
    expect(tracker!.projectedUsed).toBe(PARTIAL_BYTES);

    // The files already unpacked are kept (the route carries on with the request) and reach the session.
    await service.finishRequest(tracker!);
    expect((await stat(path.join(stagingDir(dataDir, src.projectId, src.id, session), 'files', 'partial.md'))).size).toBe(PARTIAL_BYTES);
  });

  it('shows those bytes to a request that joins after the archive stopped and before the first one has finished', async () => {
    const src = isolatedSource(2);
    const [first, second, third] = await Promise.all([1, 2, 3].map(() => service.createSession(src, quota(100, 0))));
    const a = await service.startRequest(src, first!, measureLikeTheRoute(src, 100));
    await expect(service.addFile(src, first!, 'x.zip', stream(bytes(10)), a)).rejects.toBeInstanceOf(ArchiveLimitError);

    // `a` has not finished: its scratch directory is left out of the measurement, so only the reservation tells the next request.
    const b = await service.startRequest(src, second!, measureLikeTheRoute(src, 100));
    expect(b!.baseUsed).toBe(0);
    expect(b!.inflightAtStart).toBe(PARTIAL_BYTES);

    // 40 + 61 is over 100; 40 + 60 is not.
    await expect(service.addFile(src, second!, 'b.md', stream(bytes(61)), b)).rejects.toMatchObject({ code: 'quota_exceeded', limit: 100 });
    await service.rollbackRequest(b!);
    const c = await service.startRequest(src, third!, measureLikeTheRoute(src, 100));
    expect(c!.inflightAtStart).toBe(PARTIAL_BYTES);
    await service.addFile(src, third!, 'c.md', stream(bytes(60)), c);
    expect(c!.projectedUsed).toBe(100);

    await service.finishRequest(c!);
    await service.finishRequest(a!);
  });

  it('answers with a quota error, not the archive error, when what it had unpacked is already over the limit', async () => {
    const src = isolatedSource(3);
    const session = await service.createSession(src, quota(30, 0));
    const tracker = await service.startRequest(src, session, measureLikeTheRoute(src, 30));
    const failure = await service.addFile(src, session, 'x.zip', stream(bytes(10)), tracker).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(ArchiveLimitError);
    expect(failure).toMatchObject({ code: 'quota_exceeded', limit: 30, used: 0, requested: PARTIAL_BYTES });
    await service.rollbackRequest(tracker!);
  });

  it('changes nothing for a project without a quota: no tracker, the archive error as it was', async () => {
    const src = isolatedSource(4);
    const session = await service.createSession(src);
    await expect(service.addFile(src, session, 'x.zip', stream(bytes(10)))).rejects.toBeInstanceOf(ArchiveLimitError);
  });
});
