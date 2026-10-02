import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertDiskSpace,
  assertRebuildDiskSpace,
  formatBytes,
  InsufficientDiskError,
  readDiskSpace,
  type DiskSpace,
} from '../src/services/disk-space.js';

const GiB = 1024 * 1024 * 1024;
const fixed =
  (freeBytes: number, totalBytes = 100 * GiB) =>
  async (): Promise<DiskSpace> => ({ freeBytes, totalBytes });

describe('readDiskSpace', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'contextator-disk-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports free and total bytes of the file system the directory is on', async () => {
    const space = await readDiskSpace(dir);
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeGreaterThanOrEqual(0);
    expect(space.freeBytes).toBeLessThanOrEqual(space.totalBytes);
  });

  it('answers for a DATA_DIR that does not exist yet from its nearest existing ancestor', async () => {
    const missing = path.join(dir, 'not', 'created', 'yet');
    const space = await readDiskSpace(missing);
    expect(space.totalBytes).toBe((await readDiskSpace(dir)).totalBytes);
  });
});

describe('assertDiskSpace', () => {
  it('refuses with insufficient_disk below the threshold, naming both figures', async () => {
    const err = await assertDiskSpace('/data', 2 * GiB, fixed(1 * GiB)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientDiskError);
    const e = err as InsufficientDiskError;
    expect(e.code).toBe('insufficient_disk');
    expect(e.freeBytes).toBe(1 * GiB);
    expect(e.minFreeBytes).toBe(2 * GiB);
    expect(e.message).toContain('1.0 GiB free');
    expect(e.message).toContain('2.0 GiB required');
  });

  it('lets work start at or above the threshold', async () => {
    await expect(assertDiskSpace('/data', 2 * GiB, fixed(2 * GiB))).resolves.toBeUndefined();
    await expect(assertDiskSpace('/data', 2 * GiB, fixed(50 * GiB))).resolves.toBeUndefined();
  });

  it('is off at 0 or unset, without reading the disk at all', async () => {
    const read = async (): Promise<DiskSpace> => {
      throw new Error('must not be called');
    };
    await expect(assertDiskSpace('/data', 0, read)).resolves.toBeUndefined();
    await expect(assertDiskSpace('/data', undefined, read)).resolves.toBeUndefined();
  });

  it('does not refuse work because statfs itself failed', async () => {
    const read = async (): Promise<DiskSpace> => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    await expect(assertDiskSpace('/data', GiB, read)).resolves.toBeUndefined();
  });
});

describe('assertRebuildDiskSpace', () => {
  it("checks the embedded database's data directory, which is where a rebuild writes", async () => {
    const asked: string[] = [];
    const read = async (dir: string): Promise<DiskSpace> => {
      asked.push(dir);
      return { freeBytes: GiB / 4, totalBytes: 100 * GiB };
    };
    const err = await assertRebuildDiskSpace({ CONTEXTATOR_EMBEDDED_PGDATA: '/var/lib/postgresql/data', DATA_DIR_MIN_FREE_BYTES: GiB }, read).catch(
      (e: unknown) => e,
    );
    expect(asked).toEqual(['/var/lib/postgresql/data']);
    expect(err).toBeInstanceOf(InsufficientDiskError);
    expect((err as Error).message).toContain("embedded database's data directory");
    expect((err as Error).message).toContain('DATA_DIR_MIN_FREE_BYTES');
  });

  it('checks nothing with an external database, whose disk is not measurable from here', async () => {
    const read = async (): Promise<DiskSpace> => {
      throw new Error('no disk should be read');
    };
    await expect(assertRebuildDiskSpace({ DATA_DIR_MIN_FREE_BYTES: Number.MAX_SAFE_INTEGER }, read)).resolves.toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512.0 MiB');
    expect(formatBytes(3 * GiB + GiB / 2)).toBe('3.5 GiB');
  });
});
