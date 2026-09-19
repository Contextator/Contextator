import { describe, expect, it } from 'vitest';
import { buildRunRecord } from '../src/services/index-runs.js';

const base = {
  projectId: '11111111-1111-4111-8111-111111111111',
  force: false,
  trigger: 'manual' as const,
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

  it('records the generation a rebuild wrote into, and NULL for a run that wrote into the live one', () => {
    // The column is how "which run produced the index being served" is answered — it is only
    // meaningful when the run chose a generation, which an incremental run does not (ADR-0039).
    expect(buildRunRecord(base).generation).toBeNull();
    expect(buildRunRecord({ ...base, force: true, generation: 4 }).generation).toBe(4);
    // Generation 0 is a real generation, and `?? null` rather than `|| null` is what keeps it one.
    expect(buildRunRecord({ ...base, force: true, generation: 0 }).generation).toBe(0);
  });

  it('records what asked for the run, and never leaves the column for the code to fill in', () => {
    // NULL in `index_runs.trigger` means "recorded before ADR-0048 added the column" and nothing
    // else, so every value this function can produce has to be one of the three.
    expect(buildRunRecord(base).trigger).toBe('manual');
    expect(buildRunRecord({ ...base, trigger: 'webhook' }).trigger).toBe('webhook');
    expect(buildRunRecord({ ...base, trigger: 'scheduled' }).trigger).toBe('scheduled');
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
