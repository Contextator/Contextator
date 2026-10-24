import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { ApiError, state } from '../public/core.js';
import {
  describeApiError,
  joinBytes,
  joinBytesChecked,
  loadQuotas,
  parseLimitField,
  quotaFigures,
  quotaFill,
  quotaPatch,
  splitBytes,
  // @ts-expect-error - see above.
} from '../public/quotas.js';

/**
 * **A quota the panel shows is a quota the server measured.** The panel reads the limits and usage from
 * the project's detail route, sends only the limits an administrator changed, and words a refused
 * upload (413) in the units a person thinks in (ADR-0117).
 */

let fetchMock: ReturnType<typeof vi.fn>;
const QUOTAS = {
  documents: { limit: 100, used: 40, inherited: true },
  chunks: { limit: 0, used: 900, inherited: false },
  uploadBytes: { limit: 1048576, used: null, inherited: false },
};

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ id: 'p1', quotas: QUOTAS }) }));
  vi.stubGlobal('fetch', fetchMock);
  state.projects = [{ id: 'p1', name: 'handbook', documentCount: 3, chunkCount: 30 }];
  state.selectedId = 'p1';
  Object.assign(state.quotas, { projectId: null, data: null, loadedKey: null, status: 'idle', error: '' });
});

afterEach(() => vi.unstubAllGlobals());

describe('reading the quotas', () => {
  it('asks the project detail route, once, until the project or its counts move', async () => {
    await loadQuotas();
    await loadQuotas();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/projects/p1');
    expect(state.quotas.data).toEqual(QUOTAS);

    state.projects[0].documentCount = 4; // an index run finished: usage moved
    await loadQuotas();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the error and does not hammer the route while it is failing', async () => {
    fetchMock.mockImplementation(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) }));
    await loadQuotas();
    await loadQuotas();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.quotas.status).toBe('error');
    await loadQuotas(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the figures', () => {
  it('reads used against the limit, and says so when there is no limit or no measurement', () => {
    expect(quotaFigures(QUOTAS.documents, false)).toBe('40 of 100');
    expect(quotaFigures(QUOTAS.chunks, false)).toBe('900 · no limit');
    expect(quotaFigures(QUOTAS.uploadBytes, true)).toBe('unknown of 1.0 MB');
  });

  it('has no fill to draw without a limit or a measurement, and never exceeds the bar', () => {
    expect(quotaFill(QUOTAS.chunks)).toBeNull();
    expect(quotaFill(QUOTAS.uploadBytes)).toBeNull();
    expect(quotaFill({ limit: 10, used: 25, inherited: false })).toBe(1);
    expect(quotaFill({ limit: 10, used: 5, inherited: false })).toBe(0.5);
  });
});

describe('editing the limits', () => {
  it('reads empty as inherit, 0 as unlimited and refuses anything that is not a whole number', () => {
    expect(parseLimitField('')).toEqual({ ok: true, value: null });
    expect(parseLimitField(' 0 ')).toEqual({ ok: true, value: 0 });
    expect(parseLimitField('250')).toEqual({ ok: true, value: 250 });
    for (const bad of ['-1', '1.5', '1e3', 'ten', '99999999999999999999']) expect(parseLimitField(bad).ok).toBe(false);
  });

  it('shows a byte limit in the largest unit that divides it exactly, and converts back', () => {
    expect(splitBytes(1048576)).toEqual({ value: 1, unit: 'MiB' });
    expect(splitBytes(3 * 1024 ** 3)).toEqual({ value: 3, unit: 'GiB' });
    expect(splitBytes(1500)).toEqual({ value: 1500, unit: 'bytes' });
    expect(joinBytes(2, 'MiB')).toBe(2097152);
    expect(joinBytes(splitBytes(7340032).value, splitBytes(7340032).unit)).toBe(7340032);
  });

  it('refuses a byte limit that was a safe number as typed but is not once it is in bytes', () => {
    expect(parseLimitField('9000000').ok).toBe(true);
    const tooBig = joinBytesChecked(9_000_000, 'GiB');
    expect(tooBig.ok).toBe(false);
    expect(tooBig.message).toMatch(/too large/);
    expect(joinBytesChecked(2, 'MiB')).toEqual({ ok: true, value: 2097152 });
    expect(joinBytesChecked(8000, 'GiB').ok).toBe(true);
  });

  it('sends only the limits that changed, null to go back to inheriting', () => {
    const initial = { documents: null, chunks: 500, uploadBytes: 1048576 };
    expect(quotaPatch(initial, { ...initial })).toEqual({});
    expect(quotaPatch(initial, { documents: 10, chunks: 500, uploadBytes: 1048576 })).toEqual({ maxDocuments: 10 });
    expect(quotaPatch(initial, { documents: null, chunks: null, uploadBytes: 0 })).toEqual({ maxChunks: null, maxUploadBytes: 0 });
  });
});

describe('a refused upload', () => {
  it('words a document quota in documents', () => {
    const err = new ApiError(413, {
      error: 'quota_exceeded',
      quota: 'max_documents',
      limit: 1000,
      used: 990,
      requested: 25,
      message: 'raw server text',
    });
    const text = describeApiError(err);
    expect(text).toContain('limited to 1,000 documents');
    expect(text).toContain('holds 990');
    expect(text).toContain('add 25');
    expect(text).toContain('administrator');
  });

  it('words the upload quota in bytes a person reads', () => {
    const err = new ApiError(413, {
      error: 'quota_exceeded',
      quota: 'max_upload_bytes',
      limit: 10 * 1024 * 1024,
      used: 9 * 1024 * 1024,
      requested: 3 * 1024 * 1024,
      message: 'raw',
    });
    const text = describeApiError(err);
    expect(text).toContain('10.0 MB of uploads');
    expect(text).toContain('holds 9.0 MB');
    expect(text).toContain('add 3.0 MB');
  });

  it('does not claim an upload "would add 0" when the project is already over its limit', () => {
    const err = new ApiError(413, { error: 'quota_exceeded', quota: 'max_upload_bytes', limit: 150, used: 198, requested: 0, message: 'raw' });
    const text = describeApiError(err);
    expect(text).toContain('already holds 198 B');
    expect(text).not.toContain('would add');
  });

  it('explains a quota that could not be checked, and leaves every other error alone', () => {
    expect(describeApiError(new ApiError(503, { error: 'quota_usage_unavailable', message: 'x' }))).toContain('could not be measured');
    expect(describeApiError(new ApiError(400, { message: 'Bad file' }))).toBe('Bad file');
    expect(describeApiError(new Error('offline'))).toBe('offline');
  });

  it('falls back to the server message when the numbers are missing', () => {
    expect(describeApiError(new ApiError(413, { error: 'quota_exceeded', quota: 'max_chunks', message: 'server says no' }))).toBe('server says no');
  });
});
