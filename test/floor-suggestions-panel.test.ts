import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
import {
  describeBasis,
  describeOutcome,
  floorLabel,
  isCurrent,
  loadFloorSuggestions,
  // @ts-expect-error - see above.
} from '../public/floor-suggestions.js';

/**
 * **A suggested floor is advice, and the panel says what it was measured from.** It lists what the
 * server stored, knows which suggestions can no longer be applied, and words the outcomes that are not
 * an error (too little to measure from, no floor that fits).
 */

const SUGGESTION = {
  id: 's1',
  createdAt: '2026-10-20T10:00:00.000Z',
  trigger: 'operator',
  embeddingModel: 'm1',
  liveGeneration: 3,
  suggestedFloor: 0.78,
  previousFloor: 0.8,
  basis: { method: 'sentences', probes: 100, allowedShare: 0.01, topScores: { min: 0.7, p05: 0.75, median: 0.86, max: 0.97 }, refusedAtPrevious: 4 },
  appliedAt: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ current: { project: 0.8, embeddingModel: 'm1', liveGeneration: 3 }, suggestions: [SUGGESTION] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('document', { dispatchEvent: () => true });
});

afterEach(() => vi.unstubAllGlobals());

describe('floorLabel', () => {
  it('names a floor the way a person reads it', () => {
    expect(floorLabel(0)).toBe('off');
    expect(floorLabel(0.8)).toBe('0.8');
    expect(floorLabel(null)).toBe('the server’s default');
  });
});

describe('isCurrent', () => {
  const current = { embeddingModel: 'm1', liveGeneration: 3 };
  it('is true for the index the project has now', () => {
    expect(isCurrent(SUGGESTION, current)).toBe(true);
  });
  it('is false after a model change or a new generation, which the apply route would refuse', () => {
    expect(isCurrent({ ...SUGGESTION, embeddingModel: 'm0' }, current)).toBe(false);
    expect(isCurrent({ ...SUGGESTION, liveGeneration: 2 }, current)).toBe(false);
    expect(isCurrent(SUGGESTION, undefined)).toBe(false);
  });
});

describe('describeBasis', () => {
  it('states what the figure rests on', () => {
    const text = describeBasis(SUGGESTION);
    expect(text).toContain('100 passages measured');
    expect(text).toContain('up to 1% allowed to be refused');
    expect(text).toContain('median 0.860');
    expect(text).toContain('4 would be refused at 0.8');
  });
  it('says so when none may be refused, and copes with a missing distribution', () => {
    const text = describeBasis({
      ...SUGGESTION,
      previousFloor: null,
      basis: { ...SUGGESTION.basis, allowedShare: 0, topScores: null, refusedAtPrevious: null },
    });
    expect(text).toContain('none allowed to be refused');
    expect(text).not.toContain('median');
  });
});

describe('describeOutcome', () => {
  it('words the two outcomes that are not errors', () => {
    expect(describeOutcome({ suggestion: null, reason: 'insufficient_data', probes: 3, required: 20 })).toContain('at least 20');
    expect(describeOutcome({ suggestion: null, reason: 'no_fit', probes: 80 })).toContain('No floor');
  });
});

describe('loadFloorSuggestions', () => {
  it('reads the stored suggestions once, and again only when forced', async () => {
    state.floorSuggestions.projectId = null;
    await loadFloorSuggestions({ id: 'p1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/projects/p1/score-floor/suggestions');
    expect(state.floorSuggestions.data.suggestions).toHaveLength(1);
    await loadFloorSuggestions({ id: 'p1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadFloorSuggestions({ id: 'p1' }, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops the previous project’s suggestions on a change of project', async () => {
    await loadFloorSuggestions({ id: 'p1' }, true);
    fetchMock.mockClear();
    await loadFloorSuggestions({ id: 'p2' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/projects/p2/score-floor/suggestions');
    expect(state.floorSuggestions.projectId).toBe('p2');
  });
});
