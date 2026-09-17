import { describe, expect, it } from 'vitest';
import { buildRunRecord } from '../src/services/index-runs.js';

const base = {
  projectId: '11111111-1111-4111-8111-111111111111',
  force: false,
  phase: 'done' as const,
  filesTotal: 128,
  filesSkipped: 126,
  filesRemoved: 1,
  chunksDone: 41,
  startedAt: '2026-09-17T10:00:00.000Z',
  finishedAt: '2026-09-17T10:00:09.000Z',
};

describe('buildRunRecord', () => {
  it('derives mode, updated count and duration from a finished job', () => {
    const row = buildRunRecord(base);
    expect(row.mode).toBe('incremental');
    expect(row.status).toBe('done');
    expect(row.filesUpdated).toBe(2);
    expect(row.filesRemoved).toBe(1);
    expect(row.chunksWritten).toBe(41);
    expect(row.durationMs).toBe(9000);
    expect(row.error).toBeNull();
  });

  it('marks force runs and keeps the error message on failures', () => {
    const row = buildRunRecord({ ...base, force: true, phase: 'error', error: 'ENOENT: no such file or directory', filesSkipped: 0 });
    expect(row.mode).toBe('force');
    expect(row.status).toBe('error');
    expect(row.error).toBe('ENOENT: no such file or directory');
    expect(row.filesUpdated).toBe(128);
  });

  it('never produces negative counts or durations', () => {
    const row = buildRunRecord({ ...base, filesSkipped: 200, startedAt: '2026-09-17T10:00:10.000Z' });
    expect(row.filesUpdated).toBe(0);
    expect(row.durationMs).toBe(0);
  });

  it('falls back to now when timestamps are missing', () => {
    const before = Date.now();
    const row = buildRunRecord({ ...base, startedAt: undefined, finishedAt: undefined });
    expect(row.durationMs).toBe(0);
    expect(row.finishedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
