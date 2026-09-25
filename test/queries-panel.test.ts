import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
// @ts-expect-error - see above.
import { loadQuerySummary } from '../public/queries.js';

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
