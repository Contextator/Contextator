import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { isWatching, state } from '../public/core.js';
import {
  describeBasis,
  describeOutcome,
  floorLabel,
  WATCH_EVERY_MS,
  WATCH_MS,
  isCurrent,
  modelPart,
  loadFloorSuggestions,
  renderFloorSuggestions,
  suggestionsReadKey,
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

describe('reading again when the index the list is read against moves', () => {
  const project = { id: 'p1' };
  const current = { embeddingModel: 'm1', liveGeneration: 3 };

  it('builds the key from the model, the generation and the window', () => {
    expect(suggestionsReadKey(current, 7)).toBe('m1@3|7');
    expect(suggestionsReadKey(undefined, 7)).toBe('|7');
    expect(suggestionsReadKey(current, 7)).not.toBe(suggestionsReadKey({ ...current, embeddingModel: 'm2' }, 7));
  });

  it('refetches on a changed model, generation or window, and only then', async () => {
    state.floorSuggestions.projectId = null;
    await loadFloorSuggestions(project, false, 'm1@3|7');
    await loadFloorSuggestions(project, false, 'm1@3|7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadFloorSuggestions(project, false, 'm2@3|7'); // a model change: the server has stored a model_change suggestion
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await loadFloorSuggestions(project, false, 'm2@4|7');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await loadFloorSuggestions(project, false, 'm2@4|30'); // another window
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await loadFloorSuggestions(project, false, 'm2@4|30');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not keep asking while the read is failing', async () => {
    state.floorSuggestions.projectId = null;
    fetchMock.mockImplementation(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) }));
    await loadFloorSuggestions(project, false, 'm1@3|7');
    await loadFloorSuggestions(project, false, 'm1@3|7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.floorSuggestions.status).toBe('error');
  });

  it('keeps the newer read when an older one answers last', async () => {
    state.floorSuggestions.projectId = null;
    const reply = (suggestions: unknown[]) => ({ status: 200, ok: true, text: async () => JSON.stringify({ current, suggestions }) });
    let releaseOld: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(async () => reply([SUGGESTION, { ...SUGGESTION, id: 's2' }]));
    const old = loadFloorSuggestions(project, false, 'm1@3|7');
    await loadFloorSuggestions(project, false, 'm2@3|7');
    releaseOld(reply([]));
    await old;
    expect(state.floorSuggestions.data.suggestions).toHaveLength(2);
  });
});

/**
 * **The model and generation come from the project the poll keeps current.** The questions summary the
 * panel used to take them from is read only when its own filters change, so after a re-index it kept the
 * old model and the list was never read again. These go through `renderFloorSuggestions`, the way the
 * queries panel calls it on every poll.
 */
describe('the list follows the project the poll refreshes', () => {
  class FakeNode {
    className = '';
    children: Array<FakeNode | string> = [];
    set textContent(value: string) {
      this.children = [value];
    }
    set innerHTML(_value: string) {}
    setAttribute() {}
    addEventListener() {}
    append(...nodes: Array<FakeNode | string>) {
      this.children.push(...nodes);
    }
  }
  const project = { id: 'p1', name: 'handbook' };
  const modelChange = (model: string, generation: number) => ({
    ...SUGGESTION,
    id: `mc-${model}-${generation}`,
    trigger: 'model_change',
    embeddingModel: model,
    liveGeneration: generation,
  });
  let served: unknown[];

  /** What the queries panel does on a poll: key and current from the project, then render. */
  const poll = async (index: { embeddingModel: string; liveGeneration: number }, days = 7) => {
    renderFloorSuggestions(project, true, undefined, suggestionsReadKey(index, days), index);
    // A real macrotask: lets the read finish without `vi.waitFor` nudging the faked clock.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const OLD = { embeddingModel: 'm1', liveGeneration: 3 };
  const NEW = { embeddingModel: 'm2', liveGeneration: 4 };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    vi.stubGlobal('document', { createElement: () => new FakeNode(), dispatchEvent: () => true });
    state.floorSuggestions.projectId = null;
    served = [SUGGESTION];
    fetchMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ current: { project: 0.8, ...NEW }, suggestions: served }),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('reads again when the project’s model or generation changes, without anything else moving', async () => {
    await poll(OLD);
    await poll(OLD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await poll({ ...OLD, liveGeneration: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await poll(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps reading until the suggestion the server stores after the re-index is there, and then stops', async () => {
    await poll(OLD);
    await poll(NEW); // the swap is done; the server is still measuring the new encoder
    expect(fetchMock).toHaveBeenCalledTimes(2);

    later(WATCH_EVERY_MS - 1);
    await poll(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(2); // too soon

    later(1);
    await poll(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(3); // nothing yet

    served = [modelChange('m2', 4), SUGGESTION];
    later(WATCH_EVERY_MS);
    await poll(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.floorSuggestions.data.suggestions).toHaveLength(2);

    later(WATCH_EVERY_MS * 3);
    await poll(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(4); // there; no more reading
  });

  it('closes the window, and so the faster poll, when the suggestion is there', async () => {
    await poll(OLD);
    await poll(NEW);
    expect(isWatching()).toBe(true);

    served = [modelChange('m2', 4), SUGGESTION];
    later(WATCH_EVERY_MS);
    await poll(NEW); // reads it...
    await poll(NEW); // ...and the next render sees it
    expect(state.floorSuggestions.watchUntil).toBe(0);
    expect(isWatching()).toBe(false);
  });

  it('opens no window for a re-index with the same model: the server stores a suggestion after a model change only', async () => {
    await poll(OLD);
    await poll({ ...OLD, liveGeneration: 4 }); // a forced re-index, same encoder: read once
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.floorSuggestions.watchUntil).toBe(0);
    expect(isWatching()).toBe(false);
    later(WATCH_EVERY_MS * 2);
    await poll({ ...OLD, liveGeneration: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('takes the model out of a read key, which may itself carry an @', () => {
    expect(modelPart(suggestionsReadKey({ embeddingModel: 'm1', liveGeneration: 3 }, 7))).toBe('m1');
    expect(modelPart(suggestionsReadKey({ embeddingModel: 'openai:m:384@host:4200', liveGeneration: 3 }, 7))).toBe('openai:m:384@host:4200');
    expect(modelPart(suggestionsReadKey(undefined, 7))).toBe('');
  });

  it('gives up waiting after a while, and does not wait at all for a change of window', async () => {
    await poll(OLD);
    await poll(NEW);
    fetchMock.mockClear();
    later(WATCH_MS + 1);
    await poll(NEW);
    expect(fetchMock).not.toHaveBeenCalled();

    state.floorSuggestions.projectId = null;
    await poll(NEW, 7);
    await poll(NEW, 30); // another window reads once...
    fetchMock.mockClear();
    later(WATCH_EVERY_MS * 2);
    await poll(NEW, 30);
    expect(fetchMock).not.toHaveBeenCalled(); // ...and is not watched
  });
});

describe('the queries panel feeds it from the project, not from the summary', () => {
  // A source-text check, like test/dashboard-wiring.test.ts: the dashboard has no build step and no DOM to render.
  it('builds the key and the current index from the polled project', async () => {
    const js = await readFile(new URL('../public/queries.js', import.meta.url), 'utf8');
    expect(js).toContain('const current = { embeddingModel: project.embeddingModel, liveGeneration: project.liveGeneration };');
    expect(js).toMatch(/renderFloorSuggestions\([^\n]*suggestionsReadKey\(current, q\.days\), current\)/);
    expect(js).not.toMatch(/suggestionsReadKey\(data\.current/);
  });
});
