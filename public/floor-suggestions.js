// A relevance floor the server measured, offered for a manager to apply (Faz 08, ADR-0113).
//
// The suggestion is advice and mostly an upper bound: it is the floor that would have answered a
// fragment of each of up to 100 of the project's own passages, which is easier than a real question.
// So the panel never applies one by itself, says what it was measured from, and sends the manager to
// the price above (the preview, in both directions) before pressing Apply.
//
// The server has no "reject": a suggestion that is not applied just stays listed. "Dismiss" here hides
// it in this browser only (localStorage, best effort) so the list does not keep offering a floor
// somebody has already judged wrong; it changes nothing on the server and is worded that way.

import { ApiError, api, el, emit, fmt, relativeTime, state, toast } from './core.js';

const DISMISSED_KEY = 'contextator.dismissedFloorSuggestions';

/** How many suggestions the list shows before the rest are folded away. */
const SHOWN = 3;

function readDismissed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids) {
  try {
    // A project's list is short; keep the newest hundred so the key never grows without bound.
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-100)));
  } catch {
    // Private window or blocked storage: the dismissal lasts for this page view only.
  }
}

/** A floor as a person reads it: `off` for 0, the server default for null. */
export const floorLabel = (floor) => (floor === null || floor === undefined ? 'the server’s default' : floor === 0 ? 'off' : String(floor));

/** Whether a suggestion was measured against the index the project has now (the apply route refuses it otherwise). */
export function isCurrent(suggestion, current) {
  return !!current && suggestion.embeddingModel === current.embeddingModel && suggestion.liveGeneration === current.liveGeneration;
}

/**
 * What the server answered to "measure this project" when it did not create a suggestion — an outcome,
 * not an error, so it is worded as one.
 */
export function describeOutcome(outcome) {
  if (outcome.suggestion)
    return `A floor of ${outcome.suggestion.suggestedFloor} was measured from ${fmt(outcome.suggestion.basis.probes)} passages.`;
  if (outcome.reason === 'insufficient_data') {
    return `There is too little to measure from: ${fmt(outcome.probes)} usable passage${outcome.probes === 1 ? '' : 's'}, and at least ${fmt(outcome.required)} are needed.`;
  }
  if (outcome.reason === 'no_fit') {
    return `No floor would still answer the project’s own passages (${fmt(outcome.probes)} measured), so none is suggested.`;
  }
  return 'Nothing was suggested.';
}

/** The numbers a suggestion was reached from, in one line. */
export function describeBasis(suggestion) {
  const b = suggestion.basis;
  const parts = [`${fmt(b.probes)} passages measured`];
  parts.push(b.allowedShare === 0 ? 'none allowed to be refused' : `up to ${Math.round(b.allowedShare * 100)}% allowed to be refused`);
  if (b.topScores) parts.push(`best scores ${b.topScores.min.toFixed(3)} to ${b.topScores.max.toFixed(3)}, median ${b.topScores.median.toFixed(3)}`);
  if (b.refusedAtPrevious !== null && b.refusedAtPrevious !== undefined) {
    parts.push(`${fmt(b.refusedAtPrevious)} would be refused at ${floorLabel(suggestion.previousFloor)}`);
  }
  return parts.join(' · ');
}

// ---------- loading ----------

/**
 * What the list was read against: the index the project has now (the server stores a `model_change`
 * suggestion when the model moves, and each suggestion is current or stale by the model and generation)
 * and the window the queries panel looks back over. A change of either is a reason to read again.
 *
 * `current` must come from what the poll refreshes (the project), not from the questions summary, which
 * is read only when its own filters change and so keeps the old model for as long as the page is open.
 */
export const suggestionsReadKey = (current, days) => `${current ? `${current.embeddingModel}@${current.liveGeneration}` : ''}|${days}`;

/** The index part of a read key: what a model or generation change moves and a change of window does not. */
const indexPart = (key) => key.split('|')[0];

/**
 * The model of a read key, without the generation. A forced re-index with the same model moves the generation
 * only, and the server stores a suggestion after a *model* change alone, so only that is worth waiting for.
 * Split at the last `@`: a model id may carry one (`openai:m:384@host`).
 */
export const modelPart = (key) => {
  const index = indexPart(key);
  return index.slice(0, Math.max(0, index.lastIndexOf('@')));
};

/** How long, and how often, the list is read after the model or generation changed: the server measures and stores its suggestion after the re-index ends. */
export const WATCH_MS = 3 * 60 * 1000;
/** The poll runs at this pace meanwhile (app.js `POLL_WATCH_MS`), so it is also the fastest a read can follow another. */
export const WATCH_EVERY_MS = 4 * 1000;

/** Whether the suggestion the server stores after a model change is in the list for the index the project has now. */
export const hasModelChangeSuggestion = (data, current) =>
  Boolean(current) && (data?.suggestions ?? []).some((x) => x.trigger === 'model_change' && isCurrent(x, current));

/**
 * The number of the newest read. Two reads can share a key (a forced one after an apply asks what the
 * one in flight asks), so the key alone cannot say which answer is the newer.
 */
let latestRead = 0;

/**
 * Reads the stored suggestions: when the project changes, when forced, and when `readKey` differs from
 * the one the list in hand was read with. `readKey` is optional; without one the list is read once per
 * project. A failed read keeps its key, so the poll does not ask again every two seconds.
 */
export async function loadFloorSuggestions(project, force = false, readKey = null) {
  const s = state.floorSuggestions;
  if (s.projectId !== project.id)
    Object.assign(s, {
      projectId: project.id,
      status: 'idle',
      error: '',
      data: null,
      notice: '',
      busy: false,
      showAll: false,
      readKey: null,
      readAt: 0,
      watchUntil: 0,
    });
  const changed = readKey !== null && s.readKey !== readKey;
  if (!force && !changed && s.status !== 'idle') return;
  // A different model than the last list was read for: the re-index is over, and its suggestion is still being measured.
  if (changed && s.readKey !== null && modelPart(s.readKey) !== modelPart(readKey)) s.watchUntil = Date.now() + WATCH_MS;
  if (readKey !== null) s.readKey = readKey;
  s.readAt = Date.now();
  s.status = 'loading';
  const read = ++latestRead;
  const superseded = () => read !== latestRead || s.projectId !== project.id;
  try {
    const data = await api(`/api/projects/${project.id}/score-floor/suggestions`);
    if (superseded()) return;
    s.data = data;
    s.status = 'done';
    s.error = '';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (superseded()) return;
    s.status = 'error';
    s.error = err.message;
  }
  emit('render');
}

// ---------- actions ----------

async function measure(project) {
  const s = state.floorSuggestions;
  s.busy = true;
  s.notice = '';
  emit('render');
  try {
    const outcome = await api(`/api/projects/${project.id}/score-floor/suggestions`, { method: 'POST' });
    s.notice = describeOutcome(outcome);
    await loadFloorSuggestions(project, true, s.readKey);
  } catch (err) {
    // 409: busy, not indexed yet or model mismatch — the message is the remedy.
    s.notice = err.message;
  } finally {
    s.busy = false;
    emit('render');
  }
}

async function apply(project, suggestion, onApplied) {
  const s = state.floorSuggestions;
  s.busy = true;
  emit('render');
  try {
    await api(`/api/projects/${project.id}/score-floor/suggestions/${suggestion.id}/apply`, { method: 'POST' });
    toast(`${project.name}’s relevance floor is now ${suggestion.suggestedFloor}`);
    s.notice = '';
    await loadFloorSuggestions(project, true, s.readKey);
    await onApplied?.();
  } catch (err) {
    s.notice = err.message;
    toast(err.message);
    await loadFloorSuggestions(project, true, s.readKey);
  } finally {
    s.busy = false;
    emit('render');
  }
}

function dismiss(suggestion) {
  const ids = readDismissed();
  ids.add(suggestion.id);
  writeDismissed(ids);
  emit('render');
}

function restoreDismissed() {
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing stored that could be cleared.
  }
  emit('render');
}

// ---------- rendering ----------

function suggestionRow(project, suggestion, current, mayManage, onApplied) {
  const s = state.floorSuggestions;
  const applied = suggestion.appliedAt !== null;
  const stale = !applied && !isCurrent(suggestion, current);
  const status = applied
    ? el('span', { class: 'pill small idle', text: `applied ${relativeTime(suggestion.appliedAt)}` })
    : stale
      ? el('span', { class: 'pill small stale', text: 'measured on an older index' })
      : el('span', { class: 'pill small queued', text: 'not applied' });

  return el('li', { class: 'floor-suggestion' }, [
    el('div', { class: 'floor-suggestion-head' }, [
      el('strong', { text: `Floor ${suggestion.suggestedFloor}` }),
      el('span', { class: 'field-hint', text: `instead of ${floorLabel(suggestion.previousFloor)}` }),
      status,
      el('span', {
        class: 'field-hint',
        text: `${suggestion.trigger === 'model_change' ? 'after a model change' : 'asked by an operator'} · ${relativeTime(suggestion.createdAt)}`,
      }),
    ]),
    el('p', { class: 'field-hint', text: describeBasis(suggestion) }),
    stale
      ? el('p', {
          class: 'field-hint warn',
          text: `Measured with ${suggestion.embeddingModel}, generation ${suggestion.liveGeneration}; the project now has ${current.embeddingModel}, generation ${current.liveGeneration}. It can no longer be applied: measure again.`,
        })
      : null,
    !applied && !stale && mayManage
      ? el('div', { class: 'token-foot' }, [
          el('button', {
            type: 'button',
            class: 'primary small',
            text: 'Apply this floor',
            disabled: s.busy || undefined,
            onclick: () => void apply(project, suggestion, onApplied),
          }),
          el('button', {
            type: 'button',
            class: 'ghost small',
            text: 'Dismiss',
            title: 'Hides this suggestion in this browser only. The server keeps it; nothing is rejected there.',
            onclick: () => dismiss(suggestion),
          }),
        ])
      : null,
  ]);
}

/**
 * The suggested-floor block under the project's relevance floor: measure now (manager), and the stored
 * suggestions with Apply / Dismiss. `onApplied` lets the queries panel re-read the floor it shows.
 */
export function renderFloorSuggestions(project, mayManage, onApplied, readKey = null, current = null) {
  const s = state.floorSuggestions;
  // After a re-index the server stores its suggestion for the new encoder a little later, so keep reading
  // for a while after the model or generation moved, until it is there.
  // What the watch waited for is in the list: the poll can go back to its idle pace.
  if (s.watchUntil && hasModelChangeSuggestion(s.data, current)) s.watchUntil = 0;
  const watching =
    readKey !== null &&
    s.projectId === project.id &&
    s.status !== 'loading' &&
    Date.now() < s.watchUntil &&
    Date.now() - s.readAt >= WATCH_EVERY_MS &&
    !hasModelChangeSuggestion(s.data, current);
  if (s.projectId !== project.id || s.status === 'idle' || (readKey !== null && s.readKey !== readKey) || watching)
    void loadFloorSuggestions(project, watching, readKey);

  const dismissed = readDismissed();
  const all = s.data?.suggestions ?? [];
  const visible = all.filter((x) => x.appliedAt !== null || !dismissed.has(x.id));
  const hidden = all.length - visible.length;
  const shown = s.showAll ? visible : visible.slice(0, SHOWN);

  return el('div', { class: 'floor-suggestions', id: 'floor-suggestions' }, [
    el('div', { class: 'token-foot' }, [
      el('strong', { text: 'Suggested floor' }),
      mayManage
        ? el('button', {
            type: 'button',
            class: 'ghost small',
            text: s.busy ? 'Measuring…' : 'Measure a floor',
            disabled: s.busy || undefined,
            onclick: () => void measure(project),
          })
        : null,
    ]),
    el('p', {
      class: 'field-hint',
      text:
        'Measured from the project’s own passages, so it is advice and mostly an upper bound on what real questions would justify. ' +
        'Check it with the price above — pick the value in the list and read what it would have changed in both directions — before applying it.',
    }),
    s.notice ? el('p', { class: 'members-note', role: 'status', text: s.notice }) : null,
    s.status === 'loading' && !s.data ? el('p', { class: 'field-hint', text: 'Reading the suggestions…' }) : null,
    s.status === 'error' ? el('p', { class: 'field-hint warn', text: `The suggestions could not be read: ${s.error}` }) : null,
    s.status === 'done' && visible.length === 0 && !s.notice
      ? el('p', {
          class: 'field-hint',
          text: mayManage ? 'None yet. Measure one to see what floor this project’s passages would justify.' : 'None yet.',
        })
      : null,
    shown.length > 0
      ? el(
          'ul',
          { class: 'floor-suggestion-list' },
          shown.map((x) => suggestionRow(project, x, s.data?.current, mayManage, onApplied)),
        )
      : null,
    visible.length > SHOWN
      ? el('button', {
          type: 'button',
          class: 'ghost small',
          text: s.showAll ? 'Show fewer' : `Show ${visible.length - SHOWN} older`,
          onclick: () => {
            s.showAll = !s.showAll;
            emit('render');
          },
        })
      : null,
    hidden > 0
      ? el('p', { class: 'field-hint' }, [
          `${hidden} dismissed in this browser. `,
          el('button', { type: 'button', class: 'ghost small', text: 'Show them again', onclick: restoreDismissed }),
        ])
      : null,
  ]);
}
