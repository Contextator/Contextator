import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QuotaExceededError, QuotaUsageUnavailableError } from '../src/services/errors.js';
import { directoryBytes, resolveQuota, resolveQuotas } from '../src/services/quotas.js';
import { UploadRequestQuota, UploadService } from '../src/services/uploads.js';
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
    await expect(service.createSession(source, { limit: 100, used: 100 })).rejects.toMatchObject({
      code: 'quota_exceeded',
      quota: 'max_upload_bytes',
      limit: 100,
      used: 100,
      requested: 0,
    });
  });

  it('opens a session below the cap, and none is needed when the project is unlimited', async () => {
    expect(await service.createSession(source, { limit: 100, used: 10 })).toMatch(/^[0-9a-f]{32}$/);
    expect(await service.createSession(source)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses a file that would cross the cap and reports what it had counted', async () => {
    const { Readable } = await import('node:stream');
    const session = await service.createSession(source, { limit: 100, used: 0 });
    const tracker = await service.beginRequest(source, session, { limit: 100, used: 90 });
    expect(tracker).toBeInstanceOf(UploadRequestQuota);
    await expect(service.addFile(source, session, 'big.md', Readable.from([Buffer.from('x'.repeat(20))]), tracker)).rejects.toMatchObject({
      code: 'quota_exceeded',
      limit: 100,
      used: 90,
      requested: 20,
    });
    // The caller takes the request back; nothing of it is left once that has run.
    await service.rollbackRequest(tracker);
    expect(await directoryBytes(dataDir)).toBe(0);
  });

  it('accepts a file that fits and tracks the bytes it took', async () => {
    const { Readable } = await import('node:stream');
    const session = await service.createSession(source, { limit: 100, used: 0 });
    const tracker = await service.beginRequest(source, session, { limit: 100, used: 50 });
    await service.addFile(source, session, 'ok.md', Readable.from([Buffer.from('x'.repeat(20))]), tracker);
    expect(tracker.requestBytes).toBe(20);
    expect(tracker.paths).toHaveLength(1);
  });
});
