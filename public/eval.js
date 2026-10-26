// A project's eval runs: the golden set asked of the live index by the server, and what came of it (ADR-0124).
//
// The server runs the set by itself after a swap, after an incremental run that changed something, after
// a change to the set, and when a manager asks. This panel only reads what it recorded: the history of
// recall@5 and MRR as a chart, the runs as a list, and, when the newest good run lost a question the
// previous good run had in its top five, the ids of the questions it lost. Nothing is scored here.
//
// Reading is for anybody who can see the project; asking for a run is a manager's (the route answers 403
// to anyone else, and the button is not offered to them).

import { api, el, emit, fmt, relativeTime, serverNow, state, toast } from './core.js';

/** How many runs one read asks for: the server keeps the last 100. */
const READ_LIMIT = 100;
/** How many runs the list draws before "Show more". */
export const PAGE = 10;
/** How many good runs the chart draws. */
export const MAX_POINTS = 30;
/** How long a run asked for by hand is waited for before the panel says no row came (the API does not promise one). */
export const WAIT_MS = 3 * 60 * 1000;
/**
 * A run is written when it ends, and the server starts one by itself: after an index build, after the set
 * was edited (a minute later), after somebody else's edit or import. Neither moves anything the poll reads,
 * so the panel asks for the newest run's id now and then, and reads the whole list only when it changed.
 */
export const PEEK_IDLE_MS = 15 * 1000;
/** The same question, asked faster for a while after something this browser knows will start a run (the poll runs at this pace meanwhile: app.js `POLL_WATCH_MS`). */
export const PEEK_WATCH_MS = 4 * 1000;
/** How long that while is: the set's 60-second debounce plus a run. */
export const WATCH_MS = 5 * 60 * 1000;

const SVG_NS = 'http://www.w3.org/2000/svg';

const TRIGGERS = {
  index_rebuild: 'index rebuilt',
  index_incremental: 'index updated',
  golden_set: 'questions changed',
  manual: 'started by hand',
};

// ---------- pure helpers (tested without a DOM) ----------

export const triggerLabel = (trigger) => TRIGGERS[trigger] ?? trigger;

/** recall@5 as a person reads a share: `86.7%`; `—` when the run has no figure. */
export const formatRecall = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

/** MRR to three places; `—` when the run has no figure. */
export const formatMrr = (value) => (value === null || value === undefined ? '—' : value.toFixed(3));

/** A change in words and a sign, never colour alone: `+2.5 points`, `−0.031`, `no change`. */
export function formatDelta(now, before, { points }) {
  if (now === null || now === undefined || before === null || before === undefined) return '';
  const diff = points ? (now - before) * 100 : now - before;
  const text = Math.abs(diff).toFixed(points ? 1 : 3);
  if (Number(text) === 0) return 'no change';
  return `${diff > 0 ? '+' : '−'}${text}${points ? ' points' : ''}`;
}

/** The good runs that have both figures, oldest first, at most `max` of the newest. `runs` is newest first, as the API sends it. */
export function chartRuns(runs, max = MAX_POINTS) {
  return runs
    .filter((r) => r.status === 'ok' && typeof r.recall5 === 'number' && typeof r.mrr === 'number')
    .slice(0, max)
    .reverse();
}

const PAD = { top: 12, right: 14, bottom: 26, left: 40 };

/**
 * Where everything goes in a `width` x `height` viewBox. The scale starts a little under the lowest
 * figure (rounded down to a tenth) and ends at 1, so a slip from 0.92 to 0.88 is visible, and the axis
 * says where it starts rather than pretending to begin at zero.
 */
export function chartLayout(points, { width = 400, height = 180 } = {}) {
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const lowest = points.length ? Math.min(...points.flatMap((r) => [r.recall5, r.mrr])) : 0;
  const lo = Math.max(0, Math.floor((lowest - 0.05) * 10) / 10);
  const x = (i) => PAD.left + (points.length <= 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (value) => PAD.top + (1 - (value - lo) / (1 - lo)) * plotH;
  const series = (key) => points.map((run, i) => ({ run, x: x(i), y: y(run[key]) }));
  const path = (dots) => dots.map((d, i) => `${i === 0 ? 'M' : 'L'}${d.x.toFixed(1)} ${d.y.toFixed(1)}`).join(' ');
  const recall = series('recall5');
  const mrr = series('mrr');
  return {
    width,
    height,
    plot: { left: PAD.left, right: width - PAD.right, top: PAD.top, bottom: PAD.top + plotH },
    ticks: [lo, (lo + 1) / 2, 1].map((value) => ({ value, y: y(value) })),
    recall,
    mrr,
    recallPath: path(recall),
    mrrPath: path(mrr),
  };
}

/** The chart in a sentence, for the people who cannot see it; the list below it carries every figure. */
export function chartSummary(points) {
  if (points.length === 0) return 'No good run to draw.';
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length === 1) return `One good run: recall@5 ${formatRecall(last.recall5)}, MRR ${formatMrr(last.mrr)}.`;
  return (
    `recall@5 and MRR over the last ${points.length} good runs. Recall@5 went from ${formatRecall(first.recall5)} to ${formatRecall(last.recall5)}, ` +
    `MRR from ${formatMrr(first.mrr)} to ${formatMrr(last.mrr)}.`
  );
}

/** The newest good run, when it lost questions: what the panel warns about. The error runs in between say nothing about retrieval. */
export function latestGoodRun(runs) {
  return runs.find((r) => r.status === 'ok') ?? null;
}

/** The good run before `run`, to say how the figures moved. */
export function previousGoodRun(runs, run) {
  const at = runs.findIndex((r) => r.id === run.id);
  return runs.slice(at + 1).find((r) => r.status === 'ok') ?? null;
}

/** Whether a run asked for by hand is still worth waiting for: its row has not appeared and the wait is not over. */
export function stillWaiting(pending, runs, now = Date.now()) {
  if (!pending) return false;
  if (runs.some((r) => r.id === pending.runId)) return false;
  return now - pending.since < WAIT_MS;
}

// ---------- loading ----------

/** The number of the newest read: an index run moves the key while a read is in flight, and the older answer must not land last. */
let latestRead = 0;
let inFlight = false;

function reset(projectId) {
  Object.assign(state.evalRuns, {
    projectId,
    status: 'idle',
    error: '',
    runs: [],
    loadedKey: null,
    busy: false,
    notice: '',
    pending: null,
    shown: PAGE,
    open: [],
    peekedAt: 0,
    watchUntil: 0,
    watchSince: 0,
  });
}

/** The golden set was just changed from this page: a run follows in about a minute, so look for it faster for a while. */
export function watchEvalRuns() {
  const project = state.projects.find((p) => p.id === state.selectedId);
  if (!goldenIsEmpty(project)) openWatch(state.evalRuns, serverNow());
}

/** Whether the panel knows the project has no golden questions: the server then asks nothing and records nothing (ADR-0124). */
export const goldenIsEmpty = (project) =>
  Boolean(project) && state.golden.projectId === project.id && state.golden.status === 'done' && state.golden.questions.length === 0;

/** Opens the fast-look window for a run that finishes after `since` (a server time, in ms). */
function openWatch(e, since) {
  e.watchUntil = Date.now() + WATCH_MS;
  e.watchSince = since;
}

/**
 * Whether the run the window was opened for is in the list: one that finished at or after the moment the
 * thing that starts it happened. Then the window closes, and the poll goes back to its idle pace.
 */
export const watchSatisfied = (runs, since) => runs.some((r) => Date.parse(r.finishedAt) >= since);

let peeking = false;

/** Asks only for the newest run; the whole list is read when its id is not the one in hand. */
async function peek(project, e) {
  e.peekedAt = Date.now();
  peeking = true;
  const read = latestRead;
  try {
    const { runs } = await api(`/api/projects/${project.id}/eval-runs?limit=1`);
    if (read !== latestRead || state.selectedId !== project.id || e.projectId !== project.id) return;
    if ((runs[0]?.id ?? null) !== (e.runs[0]?.id ?? null)) {
      peeking = false;
      await loadEval(true);
    }
  } catch {
    // A failed look is not a reason to replace a list that was read: the next one tries again.
  } finally {
    peeking = false;
  }
}

/**
 * Reads the project's runs when the selection moves, when a build of the index finished (the runs are
 * what that build set going), when forced, and on every poll while a run asked for by hand has not
 * shown up. Otherwise the poll that calls this every two seconds is a no-op.
 */
export async function loadEval(force = false) {
  const project = state.projects.find((p) => p.id === state.selectedId);
  const e = state.evalRuns;
  if (!project) {
    e.projectId = null;
    e.runs = [];
    e.loadedKey = null;
    e.status = 'idle';
    return;
  }
  if (e.projectId !== project.id) reset(project.id);
  // A set that turned out to be empty (the last question was deleted) will not be asked: nothing to watch for.
  if (e.watchUntil && goldenIsEmpty(project)) e.watchUntil = 0;
  // The wait for a run asked for by hand can run out between two polls without a read being due.
  if (e.pending && !stillWaiting(e.pending, e.runs)) {
    settlePending(e);
    emit('render');
  }

  const key = `${project.id}|${project.lastIndexedAt ?? ''}|${project.documentCount}|${project.chunkCount}`;
  const waiting = stillWaiting(e.pending, e.runs);
  if (!force && !waiting && e.loadedKey === key) {
    const every = Date.now() < e.watchUntil ? PEEK_WATCH_MS : PEEK_IDLE_MS;
    if (e.status === 'done' && !inFlight && !peeking && Date.now() - e.peekedAt >= every) await peek(project, e);
    return;
  }
  if (waiting && !force && inFlight) return;

  // The index moved after the list was read: a build is over, and the run it set going will be written later.
  if (e.loadedKey !== null && e.loadedKey !== key && !goldenIsEmpty(project)) openWatch(e, Date.parse(project.lastIndexedAt ?? '') || serverNow());
  e.loadedKey = key;
  e.peekedAt = Date.now();
  e.status = 'loading';
  inFlight = true;
  const read = ++latestRead;
  const superseded = () => read !== latestRead || state.selectedId !== project.id || e.projectId !== project.id;
  try {
    const { runs } = await api(`/api/projects/${project.id}/eval-runs?limit=${READ_LIMIT}`);
    if (superseded()) return;
    e.runs = runs;
    e.status = 'done';
    e.error = '';
    settlePending(e);
    if (e.watchUntil && watchSatisfied(runs, e.watchSince)) e.watchUntil = 0;
  } catch (err) {
    if (superseded()) return;
    e.status = 'error';
    e.error = err.message;
  } finally {
    if (read === latestRead) inFlight = false;
  }
  emit('render');
}

/** A run asked for by hand is over for the panel once its row is in the list, or once waiting for it has run out. */
function settlePending(e) {
  if (!e.pending) return;
  if (e.runs.some((r) => r.id === e.pending.runId)) {
    e.pending = null;
  } else if (!stillWaiting(e.pending, e.runs)) {
    e.pending = null;
    // The row is written when a run ends, so a big set on a slow encoder is not late for being slow; the list
    // goes on being looked at, and the row shows up when it comes.
    e.notice =
      'The run you started is not recorded yet. A run is written when it finishes, so a large set can take a while, and the list shows it when it does. If it never appears, the project may have been deleted or the server restarted while it ran.';
  }
}

// ---------- actions ----------

async function startRun(project) {
  const e = state.evalRuns;
  e.busy = true;
  e.notice = '';
  emit('render');
  try {
    const { runId } = await api(`/api/projects/${project.id}/eval-runs`, { method: 'POST' });
    if (e.projectId === project.id) e.pending = { runId, since: Date.now() };
    toast('Eval run started');
    await loadEval(true);
  } catch (err) {
    // 409: this project or the server is already running one, or the project has no golden questions — the message is the remedy.
    // Another project may have been opened while the request was out; its panel is not the one this answers.
    if (e.projectId === project.id) e.notice = err.message;
  } finally {
    if (e.projectId === project.id) e.busy = false;
    emit('render');
  }
}

function toggleOpen(id) {
  const e = state.evalRuns;
  e.open = e.open.includes(id) ? e.open.filter((x) => x !== id) : [...e.open, id];
  emit('render');
  // The render replaces the button that was pressed; a keyboard user would otherwise be sent back to the top of the page.
  document.getElementById(`eval-toggle-${id}`)?.focus();
}

// ---------- chart ----------

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const child of children) node.append(child);
  return node;
}

const when = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** The time of day, for a chart that lies inside one day, where two identical dates would say nothing. */
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const whenFull = (iso) => new Date(iso).toLocaleString();

function runTitle(run) {
  return `${whenFull(run.finishedAt)} · ${triggerLabel(run.trigger)} · recall@5 ${formatRecall(run.recall5)} · MRR ${formatMrr(run.mrr)}${run.regressed ? ' · lost a question' : ''}`;
}

export function renderChart(runs) {
  const points = chartRuns(runs);
  if (points.length === 0) return null;
  const g = chartLayout(points);
  const first = points[0];
  const last = points[points.length - 1];

  const grid = g.ticks.flatMap((tick) => [
    svg('line', { class: 'eval-grid', x1: g.plot.left, x2: g.plot.right, y1: tick.y, y2: tick.y }),
    svg('text', { class: 'eval-axis', x: g.plot.left - 6, y: tick.y + 4, 'text-anchor': 'end' }, [tick.value.toFixed(2)]),
  ]);
  const label = sameDay(first.finishedAt, last.finishedAt) ? clock : when;
  const xLabels =
    points.length > 1
      ? [
          svg('text', { class: 'eval-axis', x: g.plot.left, y: g.height - 8, 'text-anchor': 'start' }, [label(first.finishedAt)]),
          svg('text', { class: 'eval-axis', x: g.plot.right, y: g.height - 8, 'text-anchor': 'end' }, [label(last.finishedAt)]),
        ]
      : [
          svg('text', { class: 'eval-axis', x: (g.plot.left + g.plot.right) / 2, y: g.height - 8, 'text-anchor': 'middle' }, [
            label(last.finishedAt),
          ]),
        ];

  // Recall is a solid line with circles, MRR a dashed one with squares: they stay apart without the colours.
  const recallDots = g.recall.flatMap((d) => [
    d.run.regressed ? svg('circle', { class: 'eval-lost', cx: d.x, cy: d.y, r: 7 }) : null,
    svg('circle', { class: 'eval-dot recall', cx: d.x, cy: d.y, r: 3.5 }, [svg('title', {}, [runTitle(d.run)])]),
  ]);
  const mrrDots = g.mrr.map((d) =>
    svg('rect', { class: 'eval-dot mrr', x: d.x - 3, y: d.y - 3, width: 6, height: 6 }, [svg('title', {}, [runTitle(d.run)])]),
  );

  return el('figure', { class: 'eval-chart' }, [
    svg(
      'svg',
      { viewBox: `0 0 ${g.width} ${g.height}`, role: 'img', 'aria-label': chartSummary(points), class: 'eval-svg', focusable: 'false' },
      [
        ...grid,
        ...xLabels,
        points.length > 1 ? svg('path', { class: 'eval-line mrr', d: g.mrrPath }) : null,
        points.length > 1 ? svg('path', { class: 'eval-line recall', d: g.recallPath }) : null,
        ...mrrDots,
        ...recallDots,
      ].filter(Boolean),
    ),
    el('figcaption', { class: 'eval-legend' }, [
      el('span', { class: 'eval-key recall', text: 'recall@5' }),
      el('span', { class: 'eval-key mrr', text: 'MRR' }),
      el('span', { class: 'eval-key lost', text: 'ring: a question was lost' }),
      el('span', {
        class: 'field-hint',
        text: `scale from ${g.ticks[0].value.toFixed(2)} to 1 · ${points.length} good run${points.length === 1 ? '' : 's'}`,
      }),
    ]),
  ]);
}

// ---------- panel ----------

/** A reason the server wrote, as a sentence that ends: they come without a full stop. */
export const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

const keyChips = (keys) => keys.map((key) => el('code', { class: 'eval-key-chip', text: key }));

function banners(runs) {
  const newest = runs[0];
  const good = latestGoodRun(runs);
  const out = [];
  if (newest && newest.status === 'error') {
    out.push(
      el('div', { class: 'eval-banner error' }, [
        el('strong', { text: 'The latest run failed' }),
        el('p', { text: `${sentence(newest.error ?? 'No reason was recorded')} It left no figures, so it is not compared with anything.` }),
      ]),
    );
  }
  if (good?.regressed) {
    const prev = previousGoodRun(runs, good);
    out.push(
      el('div', { class: 'eval-banner regression' }, [
        el('strong', { text: `Regression: ${fmt(good.lostKeys.length)} question${good.lostKeys.length === 1 ? '' : 's'} lost` }),
        el('p', {
          text:
            `These were in the top five in the previous good run${prev ? ` (${relativeTime(prev.finishedAt)})` : ''} and are not any more, ` +
            `in the run ${relativeTime(good.finishedAt)} (${triggerLabel(good.trigger)}). A question gained elsewhere does not cancel one lost.`,
        }),
        el('p', { class: 'eval-keys' }, keyChips(good.lostKeys)),
      ]),
    );
  }
  if (good && good.newlySkippedKeys.length > 0) {
    out.push(
      el('div', { class: 'eval-banner skipped' }, [
        el('strong', {
          text: `${fmt(good.newlySkippedKeys.length)} question${good.newlySkippedKeys.length === 1 ? ' was' : 's were'} skipped this time`,
        }),
        el('p', {
          text: 'The file each one expects is no longer in the index, so it left the count instead of failing. It cannot show as a regression while it is skipped: rename the file in the question, or delete the question.',
        }),
        el('p', { class: 'eval-keys' }, keyChips(good.newlySkippedKeys)),
      ]),
    );
  }
  return out;
}

function figure(label, value, delta) {
  return el('div', { class: 'eval-figure' }, [
    el('span', { class: 'eval-figure-label', text: label }),
    el('strong', { class: 'eval-figure-value', text: value }),
    delta ? el('span', { class: 'field-hint', text: delta }) : null,
  ]);
}

function summary(runs) {
  const good = latestGoodRun(runs);
  if (!good) return null;
  const prev = previousGoodRun(runs, good);
  const vs = (text) => (text && text !== 'no change' ? `${text} since the run before` : text);
  return el('div', { class: 'eval-figures' }, [
    figure('recall@5', formatRecall(good.recall5), vs(prev ? formatDelta(good.recall5, prev.recall5, { points: true }) : '')),
    figure('MRR', formatMrr(good.mrr), vs(prev ? formatDelta(good.mrr, prev.mrr, { points: false }) : '')),
    figure(
      'Questions scored',
      `${fmt(good.scoredCount)} of ${fmt(good.questionCount)}`,
      good.skippedKeys.length ? `${fmt(good.skippedKeys.length)} skipped` : '',
    ),
    figure('Latest good run', relativeTime(good.finishedAt), whenFull(good.finishedAt)),
  ]);
}

function statusPill(run) {
  if (run.status === 'error') return el('span', { class: 'pill small error', text: 'failed' });
  if (run.regressed) return el('span', { class: 'pill small error', text: `lost ${fmt(run.lostKeys.length)}` });
  return el('span', { class: 'pill small idle', text: 'ok' });
}

function keyLine(label, keys) {
  return keys.length ? el('p', { class: 'eval-keys' }, [el('span', { class: 'field-hint', text: `${label}: ` }), ...keyChips(keys)]) : null;
}

function runRow(run) {
  const open = state.evalRuns.open.includes(run.id);
  const panelId = `eval-run-${run.id}`;
  return el('li', { class: `eval-run${run.regressed ? ' regressed' : ''}` }, [
    el('div', { class: 'eval-run-head' }, [
      el('span', { class: 'eval-when', title: whenFull(run.finishedAt), text: relativeTime(run.finishedAt) }),
      el('span', { class: 'eval-trigger', text: triggerLabel(run.trigger) }),
      statusPill(run),
      run.status === 'ok'
        ? el('span', { class: 'eval-nums mono' }, [
            `recall@5 ${formatRecall(run.recall5)} · MRR ${formatMrr(run.mrr)} · ${fmt(run.scoredCount)}/${fmt(run.questionCount)} scored`,
          ])
        : el('span', { class: 'eval-nums', text: run.error ?? 'failed' }),
      el('button', {
        type: 'button',
        id: `eval-toggle-${run.id}`,
        class: 'ghost small',
        text: open ? 'Hide' : 'Details',
        'aria-expanded': open ? 'true' : 'false',
        // The body is in the page only while it is open, so there is nothing to point at otherwise.
        'aria-controls': open ? panelId : null,
        'aria-label': `${open ? 'Hide' : 'Show'} the details of the run ${relativeTime(run.finishedAt)}`,
        onclick: () => toggleOpen(run.id),
      }),
    ]),
    open
      ? el('div', { class: 'eval-run-body', id: panelId }, [
          el('p', {
            class: 'field-hint',
            text: `${whenFull(run.startedAt)} to ${whenFull(run.finishedAt)} · ${run.embeddingModel} · generation ${run.generation}`,
          }),
          run.status === 'error' ? el('p', { class: 'form-error', text: run.error ?? 'No reason was recorded.' }) : null,
          keyLine('Lost', run.lostKeys),
          keyLine('Newly skipped', run.newlySkippedKeys),
          keyLine('Skipped', run.skippedKeys),
          run.status === 'ok' && !run.regressed && run.lostKeys.length === 0 && !run.comparedTo
            ? el('p', { class: 'field-hint', text: 'The first good run: nothing to compare it with.' })
            : null,
        ])
      : null,
  ]);
}

export function renderEval(project) {
  const e = state.evalRuns;
  const mine = e.projectId === project.id;
  const runs = mine ? e.runs : [];
  const mayManage = project.access === 'manager';
  const noQuestions = state.golden.projectId === project.id && state.golden.status === 'done' && state.golden.questions.length === 0;
  const running = Boolean(mine && e.pending);

  let body;
  if (!mine || e.status === 'idle' || (e.status === 'loading' && runs.length === 0)) {
    body = el('p', { class: 'hint', text: 'Reading the runs…' });
  } else if (e.status === 'error' && runs.length === 0) {
    body = el('p', { class: 'form-error', role: 'alert' }, [
      `Could not read the eval runs: ${e.error} `,
      el('button', { type: 'button', class: 'ghost small', text: 'Retry', onclick: () => void loadEval(true) }),
    ]);
  } else if (runs.length === 0) {
    body = el('p', {
      class: 'hint',
      text: noQuestions
        ? 'This project has no golden questions, so nothing is asked and nothing is recorded. Add some above.'
        : `No runs yet. One starts by itself when the index changes or the golden questions do${mayManage ? ', and you can start one now' : ', and a manager can start one now'}.`,
    });
  } else {
    const shown = runs.slice(0, e.shown);
    body = el('div', { class: 'eval-body' }, [
      e.status === 'error'
        ? el('p', { class: 'field-hint warn', text: `The runs could not be read again: ${e.error}. What follows is from the last read.` })
        : null,
      ...banners(runs),
      summary(runs),
      renderChart(runs),
      el(
        'ul',
        { class: 'eval-list', 'aria-label': 'Eval runs, newest first' },
        shown.map((run) => runRow(run)),
      ),
      runs.length > shown.length
        ? el('button', {
            type: 'button',
            class: 'ghost small',
            text: `Show ${Math.min(PAGE, runs.length - shown.length)} more (${fmt(runs.length - shown.length)} older)`,
            onclick: () => {
              e.shown += PAGE;
              emit('render');
            },
          })
        : null,
    ]);
  }

  return el('section', { class: 'panel', id: 'eval-panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Eval runs' }),
        el('p', {
          text: 'The server asks the golden questions of the live index after every change to the index or to the set, and keeps the answers, so a question that stops being answered shows here without anybody running anything.',
        }),
      ]),
      el('div', { class: 'source-actions' }, [
        el('button', { type: 'button', class: 'ghost small', text: 'Refresh', onclick: () => void loadEval(true) }),
        mayManage
          ? el('button', {
              type: 'button',
              class: 'primary small',
              text: running ? 'Running…' : e.busy ? 'Starting…' : 'Run now',
              disabled: e.busy || running || noQuestions || undefined,
              title: noQuestions ? 'The project has no golden questions to ask' : 'Ask every golden question of the live index now',
              onclick: () => void startRun(project),
            })
          : null,
      ]),
    ]),
    mine && e.notice ? el('p', { class: 'members-note eval-notice', role: 'status', text: e.notice }) : null,
    running ? el('p', { class: 'field-hint eval-wait', text: 'A run is going. Its result appears here when it is recorded.' }) : null,
    body,
  ]);
}
