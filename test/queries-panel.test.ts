import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
// @ts-expect-error - see above.
import { floorBehind, loadQuerySummary, otherFloorSearches } from '../public/queries.js';

/**
 * **The panel names the relevance floor it wants figures for.** The log keeps the floor each search
 * was decided against, and the summary keeps one floor per configuration so that the weeks before and
 * after a floor change are never averaged into one "refused" figure. The panel's half of that is to
 * send the floor of the configuration picked — `none` for searches logged before the column existed —
 * and to take the model id apart from the right, since a model id may itself contain an `@`.
 */

const PROJECT = { id: 'p1', name: 'handbook', access: 'manager' };
const SUMMARY = { configuration: null, configurations: [], window: { retentionDays: 30 } };

let fetchMock: ReturnType<typeof vi.fn>;
const sent = (): URL[] => fetchMock.mock.calls.map((call) => new URL(String(call[0]), 'http://panel.test'));

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify(SUMMARY) }));
  vi.stubGlobal('fetch', fetchMock);
  state.projects = [PROJECT];
  state.selectedId = PROJECT.id;
  Object.assign(state.queries, { projectId: PROJECT.id, days: 7, actor: 'mcp', configKey: null, loadedKey: null, data: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which configuration the query panel asks for', () => {
  it('asks for whatever the server picks until a configuration is chosen', async () => {
    await loadQuerySummary();
    const [url] = sent();
    expect(url.pathname).toBe('/api/projects/p1/queries/summary');
    expect(url.searchParams.has('model')).toBe(false);
    expect(url.searchParams.has('floor')).toBe(false);
  });

  it('sends the model, the generation and the floor of the configuration picked', async () => {
    state.queries.configKey = 'Xenova/multilingual-e5-small@3@0.78';
    await loadQuerySummary();
    const [url] = sent();
    expect(url.searchParams.get('model')).toBe('Xenova/multilingual-e5-small');
    expect(url.searchParams.get('generation')).toBe('3');
    expect(url.searchParams.get('floor')).toBe('0.78');
  });

  it('sends none for searches logged before the floor was recorded, and survives an @ in the model id', async () => {
    state.queries.configKey = 'org/model@v2@1@none';
    await loadQuerySummary();
    const [url] = sent();
    expect(url.searchParams.get('model')).toBe('org/model@v2');
    expect(url.searchParams.get('generation')).toBe('1');
    expect(url.searchParams.get('floor')).toBe('none');
  });

  it('reads again when only the floor of the chosen configuration changes', async () => {
    state.queries.configKey = 'm@1@0.82';
    await loadQuerySummary();
    await loadQuerySummary();
    state.queries.configKey = 'm@1@0.78';
    await loadQuerySummary();
    expect(sent()).toHaveLength(2);
    expect(sent()[1].searchParams.get('floor')).toBe('0.78');
  });
});

/**
 * **After a floor change the panel does not pass the old floor's figures off as the current ones.** No
 * search has been decided against a floor the moment it is saved, so the configuration the server picks
 * by default — the one with the most searches — is still the old floor's, and the "refused" figures on
 * screen describe a floor that no longer applies. The panel says so; and the re-read it sends after the
 * save is the one that wins, even when an older read of the same question answers after it.
 */
describe('the query panel after a floor change', () => {
  const configuration = (scoreFloor: number | null) => ({ embeddingModel: 'm', liveGeneration: 1, scoreFloor, queries: 40 });
  const summary = (decided: number | null, effective: number) => ({
    ...SUMMARY,
    configuration: configuration(decided),
    configurations: [configuration(decided)],
    scoreFloor: { project: effective, instance: 0.82, effective },
  });

  it('flags figures decided against a floor other than the one in effect now', () => {
    expect(floorBehind(summary(0.82, 0.78))).toEqual({ decided: 0.82, now: 0.78 });
    expect(floorBehind(summary(0.78, 0.78))).toBeNull();
  });

  it('flags a floor turned off, and searches logged before the floor was recorded', () => {
    expect(floorBehind(summary(0.82, 0))).toEqual({ decided: 0.82, now: 0 });
    expect(floorBehind(summary(null, 0.82))).toEqual({ decided: null, now: 0.82 });
  });

  it('has nothing to flag when nothing was read or nothing was asked', () => {
    expect(floorBehind(null)).toBeNull();
    expect(floorBehind(SUMMARY)).toBeNull();
  });

  it('counts the searches under the current floor once, in the floor note, and leaves the rest to the other-floors line', () => {
    const data = {
      ...summary(0.82, 0.78),
      configurations: [
        configuration(0.82),
        { ...configuration(0.78), queries: 5 },
        { ...configuration(0.7), queries: 3 },
        { ...configuration(0.78), liveGeneration: 2, queries: 9 },
      ],
    };
    expect(otherFloorSearches(data)).toEqual({ current: 5, other: 3 });
    // Nothing flagged: every other floor is just another floor, as before the note existed.
    expect(otherFloorSearches({ ...data, scoreFloor: { project: 0.82, instance: 0.82, effective: 0.82 } })).toEqual({ current: 0, other: 8 });
    expect(otherFloorSearches(SUMMARY)).toEqual({ current: 0, other: 0 });
  });

  it('keeps the re-read after the save, not an older read of the same question that answers later', async () => {
    const before = summary(0.82, 0.82);
    const after = summary(0.82, 0.78);
    let answerBefore: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerBefore = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(async () => ({ status: 200, ok: true, text: async () => JSON.stringify(after) }));

    const slow = loadQuerySummary();
    await loadQuerySummary(true);
    answerBefore({ status: 200, ok: true, text: async () => JSON.stringify(before) });
    await slow;

    expect(sent()).toHaveLength(2);
    expect(state.queries.data.scoreFloor.effective).toBe(0.78);
    expect(floorBehind(state.queries.data)).toEqual({ decided: 0.82, now: 0.78 });
  });
});
