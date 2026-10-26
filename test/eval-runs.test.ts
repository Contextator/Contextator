import { describe, expect, it } from 'vitest';

import type { EvalRunResult } from '../src/db/schema.js';
import { compareRuns, fingerprint } from '../src/services/eval-runs.js';

/**
 * The comparison rules of ADR-0124 on their own, with no database: which questions a run lost, and which
 * it newly skipped. The runner that applies them over a real index is `test/integration/eval-runs.itest.ts`.
 */

const result = (key: string, rank: number | null, fp = `fp-${key}`): EvalRunResult => ({ key, fp, rank });

describe('compareRuns: a lost question', () => {
  it('is one that was in the top five and is not now', () => {
    const before = [result('a', 0), result('b', 4), result('c', 2)];
    const after = [result('a', 0), result('b', 5), result('c', null)];
    expect(compareRuns(before, after, []).lostKeys).toEqual(['b', 'c']);
  });

  it('is not one that was already out of the top five', () => {
    expect(compareRuns([result('a', 5), result('b', null)], [result('a', null), result('b', 9)], []).lostKeys).toEqual([]);
  });

  it('is not one that moved within the top five', () => {
    expect(compareRuns([result('a', 0)], [result('a', 4)], []).lostKeys).toEqual([]);
  });

  it('is counted gross: a question gained elsewhere cancels nothing', () => {
    const before = [result('lost', 1), result('gained', 7)];
    const after = [result('lost', 8), result('gained', 0)];
    expect(compareRuns(before, after, []).lostKeys).toEqual(['lost']);
  });

  it('is not one whose question was edited since, because its fingerprint changed', () => {
    const before = [result('a', 0, 'old'), result('b', 0)];
    const after = [result('a', null, 'new'), result('b', null)];
    expect(compareRuns(before, after, []).lostKeys).toEqual(['b']);
  });

  it('is not one that is new, or one that was not asked this time', () => {
    expect(compareRuns([result('a', 0)], [result('z', null)], []).lostKeys).toEqual([]);
  });

  it('comes out in code-unit order whatever order the runs held', () => {
    const before = [result('b', 0), result('B', 0), result('a', 0)];
    const after = [result('a', null), result('b', null), result('B', null)];
    expect(compareRuns(before, after, []).lostKeys).toEqual(['B', 'a', 'b']);
  });
});

describe('compareRuns: a newly skipped question', () => {
  it('is one skipped now that the last good run asked', () => {
    const before = [result('a', 0), result('b', 1)];
    expect(compareRuns(before, [result('a', 0)], ['b']).newlySkippedKeys).toEqual(['b']);
  });

  it('is not one that was never asked, so a set that was always stale stays quiet', () => {
    expect(compareRuns([result('a', 0)], [result('a', 0)], ['never-asked']).newlySkippedKeys).toEqual([]);
  });

  it('is not a regression', () => {
    const comparison = compareRuns([result('a', 0), result('b', 0)], [result('a', 0)], ['b']);
    expect(comparison.lostKeys).toEqual([]);
    expect(comparison.newlySkippedKeys).toEqual(['b']);
  });
});

describe('fingerprint', () => {
  const row = { query: 'how do I rotate the key', expectFile: 'ops/keys.md', expectHeading: 'Rotation' };

  it('is stable, and short enough to keep a thousand of them per run', () => {
    expect(fingerprint(row)).toBe(fingerprint({ ...row }));
    expect(fingerprint(row)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes with the query, the file and the heading, each alone', () => {
    const base = fingerprint(row);
    expect(fingerprint({ ...row, query: 'how do I rotate keys' })).not.toBe(base);
    expect(fingerprint({ ...row, expectFile: 'ops/other.md' })).not.toBe(base);
    expect(fingerprint({ ...row, expectHeading: 'Other' })).not.toBe(base);
  });

  it('tells an absent heading from none that merely looks alike', () => {
    const { expectHeading: _drop, ...bare } = row;
    expect(fingerprint(bare)).not.toBe(fingerprint({ ...row, expectHeading: '' }));
  });

  it('does not let a boundary slide between fields', () => {
    expect(fingerprint({ query: 'a', expectFile: 'bc' })).not.toBe(fingerprint({ query: 'ab', expectFile: 'c' }));
  });
});
