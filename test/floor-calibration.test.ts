import { describe, expect, it } from 'vitest';
import {
  type CalibrationSample,
  FLOOR_GRID_MAX_MILLI,
  FLOOR_GRID_MIN_MILLI,
  fitFloor,
  PROBE_WORDS,
  probeFromChunk,
  refusedCount,
  summariseTopScores,
} from '../src/services/floor-calibration.js';
import type { SearchHit } from '../src/services/vector-store.js';

/**
 * The arithmetic behind a floor suggestion, with no database and no encoder: what "the highest floor
 * that refuses none of the answerable questions" means on a grid, and that the identifier escape hatch
 * is applied as the product applies it. `scripts/floor-calibration.ts` runs the same functions over the
 * four reference corpora.
 */

const hit = (score: number, lexicalRank: number | null = null): SearchHit => ({ score, lexicalRank }) as SearchHit;
const sample = (score: number, query = 'how do i tune the worker count', lexicalRank: number | null = null): CalibrationSample => ({
  query,
  hits: [hit(score, lexicalRank)],
});

describe('fitFloor', () => {
  it('is the highest grid step that refuses none of the questions, i.e. the lowest top score', () => {
    const samples = [sample(0.9), sample(0.812), sample(0.87)];
    expect(fitFloor(samples)).toBe(0.812);
    expect(refusedCount(samples, 0.812)).toBe(0);
    expect(refusedCount(samples, 0.813)).toBe(1);
  });

  it('rounds down onto the 0.001 grid', () => {
    expect(fitFloor([sample(0.8049), sample(0.95)])).toBe(0.804);
  });

  it('may refuse a share of the questions when asked to, floor(n * share) of them', () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(0.7 + i / 1000));
    expect(fitFloor(samples, 0)).toBe(0.7);
    expect(fitFloor(samples, 0.01)).toBe(0.701);
    expect(fitFloor(samples, 0.1)).toBe(0.71);
  });

  it('is 0 when the bottom of the grid already refuses a question', () => {
    expect(fitFloor([sample(0.55), sample(0.9)])).toBe(0);
  });

  it('stops at the top of the grid', () => {
    expect(fitFloor([sample(0.999), sample(0.998)])).toBe(FLOOR_GRID_MAX_MILLI / 1000);
    expect(FLOOR_GRID_MIN_MILLI / 1000).toBe(0.6);
  });

  it('fits the top of the grid for no questions at all, which is why the service asks for a minimum number of probes first', () => {
    expect(fitFloor([])).toBe(FLOOR_GRID_MAX_MILLI / 1000);
  });

  it('lets a result with no hits through, as the floor does: that is the older "found nothing" answer', () => {
    expect(fitFloor([{ query: 'anything at all', hits: [] }, sample(0.83)])).toBe(0.83);
  });

  it('does not count an identifier-shaped question the lexical half matched, because the floor would not refuse it', () => {
    const exact = sample(0.62, 'what does AUTH_COOKIE_SECURE do', 1);
    const plain = sample(0.84);
    expect(refusedCount([exact], 0.9)).toBe(0);
    expect(fitFloor([exact, plain])).toBe(0.84);
  });

  it('does count an identifier-shaped question no keyword matched', () => {
    const unmatched = sample(0.62, 'what does AUTH_COOKIE_SECURE do', null);
    expect(refusedCount([unmatched], 0.9)).toBe(1);
    expect(fitFloor([unmatched, sample(0.84)])).toBe(0.62);
  });
});

describe('summariseTopScores', () => {
  it('describes the rank-1 scores', () => {
    const summary = summariseTopScores([sample(0.9), sample(0.8), sample(0.7), sample(0.85), sample(0.75)]);
    expect(summary).toEqual({ min: 0.7, p05: expect.closeTo(0.71, 5), median: 0.8, max: 0.9 });
  });

  it('is null when nothing returned a hit', () => {
    expect(summariseTopScores([{ query: 'q', hits: [] }])).toBeNull();
  });
});

describe('probeFromChunk', () => {
  const prose =
    'Workers pull jobs from the queue. The scheduler assigns each job to the least busy worker in the pool. Idle workers are stopped after ten minutes of silence.';

  it(`is the last ${PROBE_WORDS} words of the middle sentence`, () => {
    expect(probeFromChunk(prose)).toBe('each job to the least busy worker in the pool.'.split(' ').slice(-PROBE_WORDS).join(' '));
  });

  it('never carries a heading, a table, a code fence, a quote or a list marker', () => {
    const content = [
      '# Scheduler',
      '| name | value |',
      '| --- | --- |',
      '```sh',
      'npm run scheduler --verbose --no-color --workers=4',
      '```',
      '> a quoted remark that has more than six words in it',
      '- Every worker reports its own heartbeat to the scheduler.',
    ].join('\n');
    expect(probeFromChunk(content)).toBe('worker reports its own heartbeat to the scheduler.'.split(' ').slice(-PROBE_WORDS).join(' '));
  });

  it('keeps the text of a link and drops its target and the emphasis marks', () => {
    expect(probeFromChunk('See the [retry policy](https://example.com/retry) for **every** failed job in the queue.')).toBe(
      'policy for every failed job in the queue.',
    );
  });

  it('is null for a chunk with no sentence of its own', () => {
    expect(probeFromChunk('| a | b |\n| - | - |\n| 1 | 2 |')).toBeNull();
    expect(probeFromChunk('Too short.')).toBeNull();
    expect(probeFromChunk('```\nconst value = compute(argument, other);\n```')).toBeNull();
  });

  it('shortens a sentence only from the front', () => {
    expect(probeFromChunk('One two three four five six.')).toBe('One two three four five six.');
  });
});
