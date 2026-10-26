import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { isWatching, state } from '../public/core.js';
import {
  MAX_POINTS,
  PEEK_IDLE_MS,
  PEEK_WATCH_MS,
  WAIT_MS,
  chartLayout,
  chartRuns,
  chartSummary,
  goldenIsEmpty,
  formatDelta,
  formatMrr,
  formatRecall,
  latestGoodRun,
  loadEval,
  previousGoodRun,
  renderEval,
  sentence,
  stillWaiting,
  triggerLabel,
  watchEvalRuns,
  watchSatisfied,
  // @ts-expect-error - see above.
} from '../public/eval.js';

/**
 * **The Eval panel reads what the server recorded and scores nothing** (ADR-0124). It draws the history of
 * recall@5 and MRR, says which questions the newest good run lost, and offers a manager the button that
 * asks for a run. There is no DOM library in this suite, so `document` is a minimal stand-in: enough tree
 * to read the rendered text and the handlers back.
 */

class FakeNode {
  className = '';
  children: Array<FakeNode | string> = [];
  attrs: Record<string, string> = {};
  handlers: Record<string, () => unknown> = {};
  constructor(readonly tag: string) {}
  set textContent(value: string) {
    this.children = [value];
  }
  set innerHTML(_value: string) {}
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name === 'class') this.className = value;
  }
  addEventListener(type: string, fn: () => unknown) {
    this.handlers[type] = fn;
  }
  append(...nodes: Array<FakeNode | string>) {
    this.children.push(...nodes);
  }
  get text(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.text)).join('');
  }
  findAll(predicate: (node: FakeNode) => boolean): FakeNode[] {
    const hits: FakeNode[] = predicate(this) ? [this] : [];
    for (const c of this.children) if (typeof c !== 'string') hits.push(...c.findAll(predicate));
    return hits;
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined {
    return this.findAll(predicate)[0];
  }
  hasClass(name: string): boolean {
    return this.className.split(' ').includes(name);
  }
}

/** The click starts a request and returns at once, as it does in the browser; wait for the request to finish. */
async function pressRunNow(panel: FakeNode) {
  (button(panel, 'Run now') as FakeNode).handlers.click();
  expect(state.evalRuns.busy).toBe(true);
  await vi.waitFor(() => expect(state.evalRuns.busy).toBe(false));
}

const byClass = (name: string) => (n: FakeNode) => n.hasClass(name);
const button = (root: FakeNode, text: string) => root.find((n) => n.tag === 'button' && n.text === text);

let n = 0;
const run = (over: Record<string, unknown> = {}) => ({
  id: `r${++n}`,
  trigger: 'index_incremental',
  status: 'ok',
  error: null,
  generation: 3,
  embeddingModel: 'm1',
  questionCount: 10,
  scoredCount: 10,
  recall5: 0.9,
  mrr: 0.75,
  regressed: false,
  comparedTo: null,
  lostKeys: [] as string[],
  skippedKeys: [] as string[],
  newlySkippedKeys: [] as string[],
  startedAt: '2026-10-25T10:00:00.000Z',
  finishedAt: '2026-10-25T10:00:05.000Z',
  ...over,
});

const reply = (runs: unknown[]) => ({ status: 200, ok: true, text: async () => JSON.stringify({ runs }) });
const PROJECT = { id: 'p1', name: 'handbook', access: 'manager', documentCount: 3, chunkCount: 30, lastIndexedAt: '2026-10-25T09:00:00.000Z' };

let fetchMock: ReturnType<typeof vi.fn>;
const emitted: string[] = [];

beforeEach(() => {
  n = 0;
  fetchMock = vi.fn(async () => reply([]));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    getElementById: () => null,
    // toast() looks for its node here.
    querySelector: () => ({ textContent: '', classList: { add: () => {}, remove: () => {} } }),
    dispatchEvent: (event: { type: string }) => {
      emitted.push(event.type);
      return true;
    },
  });
  state.projects = [{ ...PROJECT }];
  state.selectedId = 'p1';
  state.golden.projectId = null;
  state.golden.status = 'idle';
  state.golden.questions = [];
  Object.assign(state.evalRuns, {
    projectId: null,
    status: 'idle',
    error: '',
    runs: [],
    loadedKey: null,
    busy: false,
    notice: '',
    pending: null,
    shown: 10,
    open: [],
    peekedAt: 0,
    watchUntil: 0,
    watchSince: 0,
  });
  state.floorSuggestions.watchUntil = 0;
  emitted.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('what a run is called', () => {
  it('words the figures and the triggers', () => {
    expect(formatRecall(0.8667)).toBe('86.7%');
    expect(formatRecall(null)).toBe('—');
    expect(formatMrr(0.74213)).toBe('0.742');
    expect(formatMrr(undefined)).toBe('—');
    expect(triggerLabel('manual')).toBe('started by hand');
    expect(triggerLabel('index_rebuild')).toBe('index rebuilt');
    expect(triggerLabel('something_new')).toBe('something_new');
  });

  it('says a change with a sign and a unit, not by colour', () => {
    expect(formatDelta(0.9, 0.875, { points: true })).toBe('+2.5 points');
    expect(formatDelta(0.8, 0.9, { points: true })).toBe('−10.0 points');
    expect(formatDelta(0.7, 0.731, { points: false })).toBe('−0.031');
    expect(formatDelta(0.5, 0.5, { points: false })).toBe('no change');
    expect(formatDelta(0.5, null, { points: false })).toBe('');
  });
});

describe('a reason the server wrote', () => {
  it('ends in a full stop, once', () => {
    expect(sentence('The index changed while the run was reading it')).toBe('The index changed while the run was reading it.');
    expect(sentence('Nothing to score.')).toBe('Nothing to score.');
  });
});

describe('the history the chart draws', () => {
  it('draws the good runs only, oldest first, and no more than the newest few', () => {
    const runs = [run({ id: 'new' }), run({ id: 'bad', status: 'error', recall5: null, mrr: null }), run({ id: 'old' })];
    expect(chartRuns(runs).map((r: { id: string }) => r.id)).toEqual(['old', 'new']);
    const many = Array.from({ length: MAX_POINTS + 5 }, (_, i) => run({ id: `x${i}` }));
    const drawn = chartRuns(many);
    expect(drawn).toHaveLength(MAX_POINTS);
    expect(drawn[drawn.length - 1].id).toBe('x0'); // the newest is last
  });

  it('puts the later run to the right and the better figure higher, inside the plot', () => {
    const points = chartRuns([run({ recall5: 0.95, mrr: 0.8 }), run({ recall5: 0.85, mrr: 0.7 })]);
    const g = chartLayout(points);
    expect(g.recall[1].x).toBeGreaterThan(g.recall[0].x);
    expect(g.recall[1].y).toBeLessThan(g.recall[0].y); // newest (0.95) is the higher figure
    for (const d of [...g.recall, ...g.mrr]) {
      expect(d.x).toBeGreaterThanOrEqual(g.plot.left);
      expect(d.x).toBeLessThanOrEqual(g.plot.right);
      expect(d.y).toBeGreaterThanOrEqual(g.plot.top);
      expect(d.y).toBeLessThanOrEqual(g.plot.bottom);
    }
    expect(g.recallPath).toMatch(/^M[\d. ]+L[\d. ]+$/);
  });

  it('starts the scale under the lowest figure and says so, and copes with one run or a perfect one', () => {
    const g = chartLayout(chartRuns([run({ recall5: 0.62, mrr: 0.5 }), run({ recall5: 0.7, mrr: 0.6 })]));
    expect(g.ticks[0].value).toBe(0.4);
    expect(g.ticks[2].value).toBe(1);
    const one = chartLayout(chartRuns([run({ recall5: 1, mrr: 1 })]));
    expect(one.ticks[0].value).toBe(0.9);
    expect(one.recall).toHaveLength(1);
    expect(Number.isFinite(one.recall[0].x) && Number.isFinite(one.recall[0].y)).toBe(true);
    expect(chartLayout([]).recall).toEqual([]);
  });

  it('is put in words for whoever cannot see it', () => {
    expect(chartSummary([])).toMatch(/No good run/);
    expect(chartSummary(chartRuns([run({ recall5: 0.9, mrr: 0.7 })]))).toContain('One good run');
    const text = chartSummary(chartRuns([run({ recall5: 0.92, mrr: 0.7 }), run({ recall5: 0.88, mrr: 0.65 })]));
    expect(text).toContain('from 88.0% to 92.0%');
    expect(text).toContain('MRR from 0.650 to 0.700');
  });
});

describe('which run is the newest good one', () => {
  it('skips the failed runs, and finds the good run before it', () => {
    const runs = [run({ id: 'e', status: 'error' }), run({ id: 'g1' }), run({ id: 'e2', status: 'error' }), run({ id: 'g0' })];
    expect(latestGoodRun(runs).id).toBe('g1');
    expect(previousGoodRun(runs, runs[1]).id).toBe('g0');
    expect(previousGoodRun(runs, runs[3])).toBeNull();
    expect(latestGoodRun([run({ status: 'error' })])).toBeNull();
  });

  it('waits for a run asked for by hand until its row appears or the wait runs out', () => {
    const pending = { runId: 'r9', since: 1000 };
    expect(stillWaiting(null, [])).toBe(false);
    expect(stillWaiting(pending, [], 1000 + WAIT_MS - 1)).toBe(true);
    expect(stillWaiting(pending, [], 1000 + WAIT_MS)).toBe(false);
    expect(stillWaiting(pending, [run({ id: 'r9' })], 1001)).toBe(false);
  });
});

describe('reading the runs', () => {
  it("asks the project's eval-runs route, once, until the index moves", async () => {
    await loadEval();
    await loadEval();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/projects/p1/eval-runs?limit=100');
    expect(state.evalRuns.status).toBe('done');

    state.projects[0].lastIndexedAt = '2026-10-25T09:30:00.000Z'; // a run of the index finished: the server has asked the set again
    await loadEval();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops the previous project’s runs when the selection moves', async () => {
    fetchMock.mockImplementationOnce(async () => reply([run()]));
    await loadEval();
    expect(state.evalRuns.runs).toHaveLength(1);
    state.projects = [{ ...PROJECT, id: 'p2', name: 'other' }];
    state.selectedId = 'p2';
    await loadEval();
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/projects/p2/eval-runs?limit=100');
    expect(state.evalRuns.runs).toEqual([]);
  });

  it('keeps the error, and does not hammer the route while it is failing', async () => {
    fetchMock.mockImplementation(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) }));
    await loadEval();
    await loadEval();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.evalRuns.status).toBe('error');
    expect(state.evalRuns.error).toBe('boom');
    await loadEval(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer answer when the older request answers last', async () => {
    let releaseOld: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(async () => reply([run({ id: 'new' }), run({ id: 'old' })]));
    const stale = loadEval();
    await loadEval(true);
    releaseOld(reply([run({ id: 'old' })]));
    await stale;
    expect(state.evalRuns.runs.map((r: { id: string }) => r.id)).toEqual(['new', 'old']);
  });
});

describe('asking for a run', () => {
  const panelFor = async () => {
    await loadEval();
    return renderEval(state.projects[0]) as FakeNode;
  };

  it('offers the button to a manager only', async () => {
    fetchMock.mockImplementation(async () => reply([run()]));
    expect(button(await panelFor(), 'Run now')).toBeDefined();
    state.projects[0].access = 'viewer';
    expect(button(renderEval(state.projects[0]) as FakeNode, 'Run now')).toBeUndefined();
  });

  it('posts, then reads until the run’s row shows up', async () => {
    fetchMock.mockImplementation(async () => reply([run({ id: 'old' })]));
    const panel = await panelFor();
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(async () => ({ status: 202, ok: true, text: async () => JSON.stringify({ runId: 'new' }) }));
    fetchMock.mockImplementationOnce(async () => reply([run({ id: 'old' })])); // not written yet
    await pressRunNow(panel);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/projects/p1/eval-runs');
    expect(state.evalRuns.pending).toMatchObject({ runId: 'new' });

    // The next poll reads again although nothing else moved, because the row is still missing.
    fetchMock.mockImplementationOnce(async () => reply([run({ id: 'new', trigger: 'manual' }), run({ id: 'old' })]));
    await loadEval();
    expect(state.evalRuns.pending).toBeNull();
    // ...and stops asking once it is there.
    const calls = fetchMock.mock.calls.length;
    await loadEval();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('says so when the server refuses (busy, nothing to ask) and leaves nothing pending', async () => {
    fetchMock.mockImplementation(async () => reply([run()]));
    const panel = await panelFor();
    fetchMock.mockImplementationOnce(async () => ({
      status: 409,
      ok: false,
      text: async () => JSON.stringify({ message: 'A run of this project is already going or waiting; wait for it to finish' }),
    }));
    await pressRunNow(panel);
    expect(state.evalRuns.pending).toBeNull();
    expect(state.evalRuns.busy).toBe(false);
    expect(state.evalRuns.notice).toContain('already going');
    const again = renderEval(state.projects[0]) as FakeNode;
    expect(again.find(byClass('eval-notice'))?.text).toContain('already going');
  });

  it('stops waiting for a row that does not come, and says what that can mean without calling it a loss', async () => {
    fetchMock.mockImplementation(async () => reply([run({ id: 'old' })]));
    await loadEval();
    state.evalRuns.pending = { runId: 'never', since: Date.now() - WAIT_MS - 1 };
    await loadEval();
    expect(state.evalRuns.pending).toBeNull();
    expect(state.evalRuns.notice).toMatch(/not recorded yet/);
  });

  it('is not offered while the project has no golden questions to ask', async () => {
    state.golden.projectId = 'p1';
    state.golden.status = 'done';
    state.golden.questions = [];
    const panel = await panelFor();
    expect(button(panel, 'Run now')?.attrs.disabled).toBeDefined();
    expect(panel.text).toContain('no golden questions');
  });
});

describe('what the panel says', () => {
  const draw = async (runs: unknown[]) => {
    fetchMock.mockImplementation(async () => reply(runs));
    await loadEval();
    return renderEval(state.projects[0]) as FakeNode;
  };

  it('reads before it knows, says when there is nothing yet, and says when it cannot read', async () => {
    expect((renderEval(state.projects[0]) as FakeNode).text).toContain('Reading the runs');
    expect((await draw([])).text).toContain('No runs yet');

    state.evalRuns.projectId = null;
    fetchMock.mockImplementation(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) }));
    await loadEval();
    const panel = renderEval(state.projects[0]) as FakeNode;
    expect(panel.text).toContain('Could not read the eval runs: boom');
    expect(button(panel, 'Retry')).toBeDefined();
  });

  it('names the questions the newest good run lost, and says it is not a net count', async () => {
    const panel = await draw([run({ regressed: true, lostKeys: ['reset-password', 'rotate-keys'], recall5: 0.8 }), run({ recall5: 0.9 })]);
    const banner = panel.find(byClass('regression'));
    expect(banner?.text).toContain('Regression: 2 questions lost');
    expect(banner?.text).toContain('does not cancel');
    expect(banner?.findAll(byClass('eval-key-chip')).map((c) => c.text)).toEqual(['reset-password', 'rotate-keys']);
    expect(panel.text).toContain('−10.0 points since the run before');
  });

  it('is quiet about regression when the newest good run lost nothing', async () => {
    const panel = await draw([run(), run({ regressed: true, lostKeys: ['old-loss'] })]);
    expect(panel.find(byClass('regression'))).toBeUndefined();
  });

  it('warns about a question skipped for the first time, in words that say it is not a regression', async () => {
    const panel = await draw([run({ newlySkippedKeys: ['moved-page'], skippedKeys: ['moved-page'], scoredCount: 9 }), run()]);
    const banner = panel.find(byClass('skipped'));
    expect(banner?.text).toContain('1 question was skipped this time');
    expect(banner?.text).toContain('cannot show as a regression');
    expect(banner?.findAll(byClass('eval-key-chip')).map((c) => c.text)).toEqual(['moved-page']);
    expect(panel.text).toContain('9 of 10');
  });

  it('shows a failed newest run without figures, and still reports the last good one', async () => {
    const panel = await draw([run({ status: 'error', error: 'The index changed while the run was reading it', recall5: null, mrr: null }), run()]);
    expect(panel.find(byClass('eval-banner'))?.text).toContain('The latest run failed');
    expect(panel.find(byClass('eval-banner'))?.text).toContain('reading it. It left no figures');
    expect(panel.text).toContain('The index changed while the run was reading it');
    expect(panel.text).toContain('90.0%'); // the good run's figure
  });

  it('draws the chart as an image with a text alternative, and a run list under it', async () => {
    const panel = await draw([run({ recall5: 0.88 }), run({ recall5: 0.92 })]);
    const chart = panel.find((x) => x.tag === 'svg');
    expect(chart?.attrs.role).toBe('img');
    expect(chart?.attrs['aria-label']).toContain('from 92.0% to 88.0%');
    expect(chart?.findAll((x) => x.tag === 'circle' && x.hasClass('eval-dot'))).toHaveLength(2);
    expect(chart?.findAll((x) => x.tag === 'rect' && x.hasClass('eval-dot'))).toHaveLength(2);
    expect(panel.findAll(byClass('eval-run'))).toHaveLength(2);
  });

  it('rings the run that lost a question on the chart', async () => {
    const panel = await draw([run({ regressed: true, lostKeys: ['a'] }), run()]);
    expect(panel.findAll(byClass('eval-lost'))).toHaveLength(1);
  });

  it('draws no chart without a good run, and folds the older runs behind Show more', async () => {
    const failed = Array.from({ length: 12 }, () => run({ status: 'error', error: 'x', recall5: null, mrr: null }));
    const panel = await draw(failed);
    expect(panel.find((x) => x.tag === 'svg')).toBeUndefined();
    expect(panel.findAll(byClass('eval-run'))).toHaveLength(10);
    expect(button(panel, 'Show 2 more (2 older)')).toBeDefined();
  });

  it('opens a run’s details on the button, which says whether it is open', async () => {
    const first = run({ lostKeys: ['a'], regressed: true });
    const panel = await draw([first]);
    const toggle = button(panel, 'Details') as FakeNode;
    expect(toggle.attrs['aria-expanded']).toBe('false');
    toggle.handlers.click();
    expect(state.evalRuns.open).toEqual([first.id]);
    const open = renderEval(state.projects[0]) as FakeNode;
    expect(button(open, 'Hide')?.attrs['aria-expanded']).toBe('true');
    expect(open.find(byClass('eval-run-body'))?.text).toContain('Lost: a');
  });
});

describe('a run the server starts by itself', () => {
  // The index build ends, `lastIndexedAt` moves and the panel reads once; the run it set going is written
  // when it ends, some seconds later, and the poll reads nothing that says so.
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]).replace('/api/projects/p1/eval-runs', ''));
  const regressedRun = () => run({ id: 'late', regressed: true, lostKeys: ['reset-password'], recall5: 0.8 });
  let served: unknown[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    served = [run({ id: 'before' })];
    fetchMock.mockImplementation(async (url: string) =>
      reply(String(url).includes('limit=1&') || String(url).endsWith('limit=1') ? served.slice(0, 1) : served),
    );
  });

  afterEach(() => vi.useRealTimers());

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('shows the run, and the regression banner, a few polls after the build that started it', async () => {
    await loadEval();
    state.projects[0].lastIndexedAt = '2026-10-26T10:00:30.000Z'; // the build is over
    later(30_000);
    await loadEval();
    expect(state.evalRuns.runs.map((r: { id: string }) => r.id)).toEqual(['before']); // the run is not written yet

    later(PEEK_WATCH_MS - 1);
    await loadEval();
    expect(urls().at(-1)).toBe('?limit=100'); // too soon to look again

    served = [regressedRun(), run({ id: 'before' })]; // the run ends and is written
    later(1);
    await loadEval();
    expect(urls().at(-2)).toBe('?limit=1'); // a look at the newest id...
    expect(state.evalRuns.runs.map((r: { id: string }) => r.id)).toEqual(['late', 'before']); // ...and the list read because it changed
    const panel = renderEval(state.projects[0]) as FakeNode;
    expect(panel.find(byClass('regression'))?.text).toContain('Regression: 1 question lost');
  });

  it('looks at the newest id only, and reads nothing more while it has not changed', async () => {
    await loadEval();
    state.projects[0].lastIndexedAt = '2026-10-26T10:00:30.000Z';
    later(1000);
    await loadEval();
    fetchMock.mockClear();
    for (let i = 0; i < 3; i++) {
      later(PEEK_WATCH_MS);
      await loadEval();
    }
    expect(urls()).toEqual(['?limit=1', '?limit=1', '?limit=1']);
  });

  it('picks up a run nothing in this browser announced (another account edited the set), at the slow pace', async () => {
    await loadEval();
    fetchMock.mockClear();
    served = [regressedRun(), run({ id: 'before' })];
    later(PEEK_IDLE_MS - 1);
    await loadEval();
    expect(fetchMock).not.toHaveBeenCalled();
    later(1);
    await loadEval();
    expect(urls()).toEqual(['?limit=1', '?limit=100']);
    expect(state.evalRuns.runs[0].id).toBe('late');
  });

  it('looks faster for a while after the set was changed here, and goes back to the slow pace after that', async () => {
    await loadEval();
    watchEvalRuns();
    fetchMock.mockClear();
    later(PEEK_WATCH_MS);
    await loadEval();
    expect(urls()).toEqual(['?limit=1']);
    later(5 * 60 * 1000);
    fetchMock.mockClear();
    await loadEval(); // the watch has run out: this look was due anyway
    later(PEEK_WATCH_MS);
    await loadEval();
    expect(urls()).toEqual(['?limit=1']);
  });

  it('closes the window when the run the build set going is in the list, and the poll goes back to its idle pace', async () => {
    await loadEval();
    state.projects[0].lastIndexedAt = '2026-10-26T10:00:30.000Z';
    later(30_000);
    await loadEval();
    expect(isWatching()).toBe(true); // the build is over; its run is not written yet

    served = [run({ id: 'late', finishedAt: '2026-10-26T10:00:34.000Z' }), run({ id: 'before' })];
    later(PEEK_WATCH_MS);
    await loadEval();
    expect(state.evalRuns.runs[0].id).toBe('late');
    expect(isWatching()).toBe(false);
    expect(state.evalRuns.watchUntil).toBe(0);

    fetchMock.mockClear();
    later(PEEK_WATCH_MS);
    await loadEval();
    expect(fetchMock).not.toHaveBeenCalled(); // idle pace again
  });

  it('keeps the window open for a run that finished before the build did', async () => {
    await loadEval();
    state.projects[0].lastIndexedAt = '2026-10-26T10:00:30.000Z';
    later(30_000);
    await loadEval();
    served = [run({ id: 'manual-before', finishedAt: '2026-10-26T10:00:20.000Z' }), run({ id: 'before' })];
    later(PEEK_WATCH_MS);
    await loadEval();
    expect(state.evalRuns.runs[0].id).toBe('manual-before');
    expect(isWatching()).toBe(true);
  });

  it('closes the window opened by a change of the set when the run a minute later arrives', async () => {
    await loadEval();
    watchEvalRuns();
    expect(isWatching()).toBe(true);
    later(60_000 + PEEK_WATCH_MS);
    served = [run({ id: 'late', trigger: 'golden_set', finishedAt: '2026-10-26T10:01:02.000Z' }), run({ id: 'before' })];
    await loadEval();
    expect(isWatching()).toBe(false);
  });

  describe('a project with no golden questions', () => {
    const golden = (questions: unknown[], status = 'done') => {
      state.golden.projectId = 'p1';
      state.golden.status = status;
      state.golden.questions = questions;
    };
    const buildEnds = async () => {
      await loadEval();
      state.projects[0].lastIndexedAt = '2026-10-26T10:00:30.000Z';
      later(30_000);
      await loadEval();
    };

    it('opens no window when an index build ends: the server asks nothing and records nothing', async () => {
      golden([]);
      await buildEnds();
      expect(state.evalRuns.watchUntil).toBe(0);
      expect(isWatching()).toBe(false);
    });

    it('opens one when the set has questions, or when it is not known to be empty', async () => {
      golden([{ id: 'q1' }]);
      await buildEnds();
      expect(isWatching()).toBe(true);
      state.evalRuns.watchUntil = 0;
      golden([], 'loading'); // read again, not known
      expect(goldenIsEmpty(state.projects[0])).toBe(false);
      await buildEnds();
    });

    it('opens none for a change of the set that left it empty, and closes the one the last delete opened', async () => {
      await loadEval();
      golden([{ id: 'q1' }]);
      watchEvalRuns();
      expect(isWatching()).toBe(true);
      golden([]); // the delete has been read back: the set is empty
      await loadEval();
      expect(isWatching()).toBe(false);
      watchEvalRuns();
      expect(isWatching()).toBe(false);
    });

    it('does not take another project’s empty set for its own', async () => {
      golden([]);
      state.golden.projectId = 'someone-else';
      await buildEnds();
      expect(isWatching()).toBe(true);
    });
  });

  it('knows a run is the awaited one by when it finished', () => {
    const at = Date.parse('2026-10-26T10:00:30.000Z');
    expect(watchSatisfied([run({ finishedAt: '2026-10-26T10:00:29.999Z' })], at)).toBe(false);
    expect(watchSatisfied([run({ finishedAt: '2026-10-26T10:00:30.000Z' })], at)).toBe(true);
    expect(watchSatisfied([], at)).toBe(false);
  });

  it('keeps looking after the wait for a run asked for by hand ran out, so the late row still arrives', async () => {
    await loadEval();
    state.evalRuns.pending = { runId: 'slow', since: Date.now() };
    later(WAIT_MS + 1);
    await loadEval();
    expect(state.evalRuns.pending).toBeNull();
    expect(state.evalRuns.notice).toMatch(/not recorded yet/);
    served = [run({ id: 'slow', trigger: 'manual' }), run({ id: 'before' })];
    later(PEEK_IDLE_MS);
    await loadEval();
    expect(state.evalRuns.runs[0].id).toBe('slow');
  });

  it('does not let a failed look replace the list in hand', async () => {
    await loadEval();
    fetchMock.mockImplementation(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) }));
    later(PEEK_IDLE_MS);
    await loadEval();
    expect(state.evalRuns.status).toBe('done');
    expect(state.evalRuns.runs).toHaveLength(1);
  });
});

describe('another project is opened while a run is asked for', () => {
  it('leaves the answer to the first project out of the second one’s panel', async () => {
    fetchMock.mockImplementation(async () => reply([run()]));
    await loadEval();
    const panel = renderEval(state.projects[0]) as FakeNode;
    let answer: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    (button(panel, 'Run now') as FakeNode).handlers.click();
    state.projects = [{ ...PROJECT, id: 'p2', name: 'other' }];
    state.selectedId = 'p2';
    await loadEval();
    answer({ status: 409, ok: false, text: async () => JSON.stringify({ message: 'A run of this project is already going or waiting' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.evalRuns.projectId).toBe('p2');
    expect(state.evalRuns.notice).toBe('');
    expect(state.evalRuns.busy).toBe(false);
  });
});

describe('the details button', () => {
  it('points at the body only while there is a body', async () => {
    fetchMock.mockImplementation(async () => reply([run()]));
    await loadEval();
    const closed = button(renderEval(state.projects[0]) as FakeNode, 'Details') as FakeNode;
    expect(closed.attrs['aria-controls']).toBeUndefined();
    closed.handlers.click();
    const open = button(renderEval(state.projects[0]) as FakeNode, 'Hide') as FakeNode;
    expect(open.attrs['aria-controls']).toMatch(/^eval-run-/);
  });
});

describe('the golden questions panel tells the Eval panel the set changed', () => {
  it('after a save and after a delete', async () => {
    const js = await readFile(new URL('../public/golden.js', import.meta.url), 'utf8');
    expect(js).toContain("import { watchEvalRuns } from './eval.js';");
    expect(js.match(/watchEvalRuns\(\)/g)).toHaveLength(2);
  });

  // The Eval panel opens no watch for a set it knows to be empty, so the first question added to an empty set
  // needs the set read back before the call, or it would find the set still empty.
  it('calls it only after the set has been read back, on both paths', async () => {
    const js = await readFile(new URL('../public/golden.js', import.meta.url), 'utf8');
    const calls = [...js.matchAll(/watchEvalRuns\(\)/g)].map((m) => m.index ?? 0);
    expect(calls).toHaveLength(2);
    for (const at of calls) {
      const before = js.slice(0, at);
      expect(before.lastIndexOf('await loadGolden(true)')).toBeGreaterThan(
        before.lastIndexOf('await request()') >= 0 ? before.lastIndexOf('await request()') : before.lastIndexOf("method: 'DELETE'"),
      );
    }
  });

  it('opens the watch for the first question of an empty set once the list shows it, and not before', () => {
    state.projects = [{ ...PROJECT }];
    state.selectedId = 'p1';
    state.golden.projectId = 'p1';
    state.golden.status = 'done';
    state.golden.questions = []; // the list as it was when the question was saved
    watchEvalRuns();
    expect(isWatching()).toBe(false);
    state.golden.questions = [{ id: 'q1' }]; // read back
    watchEvalRuns();
    expect(isWatching()).toBe(true);
  });
});

describe('the poll runs faster while a panel waits for something the server writes by itself', () => {
  it('is watching until the eval or the floor watch runs out', () => {
    const now = 1_000_000;
    expect(isWatching(now)).toBe(false);
    state.evalRuns.watchUntil = now + 1;
    expect(isWatching(now)).toBe(true);
    expect(isWatching(now + 1)).toBe(false);
    state.evalRuns.watchUntil = 0;
    state.floorSuggestions.watchUntil = now + 1;
    expect(isWatching(now)).toBe(true);
    state.floorSuggestions.watchUntil = 0;
  });

  it('is what schedule() reads, below the indexing pace and above the idle one', async () => {
    const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(js).toContain('active || modelLoading ? POLL_ACTIVE_MS : isWatching() ? POLL_WATCH_MS : POLL_IDLE_MS');
    expect(js).toContain('const POLL_WATCH_MS = 4000;');
  });
});
