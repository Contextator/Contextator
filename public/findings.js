// Where the PII scan found secrets and personal numbers in a project's documents (Faz 08b, ADR-0130).
//
// The panel shows a place and a masked preview and nothing else: the server never sends the value, only the
// rule that matched, the document and position, the preview it masked, and a short group id that lets two
// findings of the same value be seen as one. There is no control here that takes a value and asks whether it
// was found (ADR-0130 decision 6: that would make a report a way of testing guesses).
//
// It is an `editor`'s section. A viewer can read every document, but a list of where the credentials are is a
// different thing to hand to the widest audience, so the section is not drawn for a viewer and is not asked
// for (the route answers 403 anyway; this mirrors it, as auth.js says of every gate).
//
// The state lives here and not in core.js `state`: it is read by this panel only, and app.js rebuilds #detail
// on every poll, so what the person chose (a rule, how many pages are open) has to outlive the DOM — a module
// variable does.

import { ApiError, api, el, emit, fmt, relativeTime, state } from './core.js';
import { canEdit } from './auth.js';
import { safeSourceUrl } from './search.js';

/** How many findings one read asks for; "Show more" asks for the next page of the same size. */
export const PAGE = 50;

/** What a rule is called, by the id the server sends. An id this panel does not know is shown as it came. */
const RULE_LABELS = {
  aws_access_key: 'AWS access key',
  github_token: 'GitHub token',
  private_key: 'Private key',
  jwt: 'JSON Web Token',
  tckn: 'Turkish citizen number',
  iban: 'IBAN',
};

export const ruleLabel = (rule) => RULE_LABELS[rule] ?? rule;

export const findingsState = {
  projectId: null,
  status: 'idle', // 'idle' | 'loading' | 'done' | 'error'
  error: '',
  /** The findings read so far, in the order the server sends them (document path, then reading order). */
  items: [],
  nextCursor: null,
  /** The newest `summary` the server sent: counts by rule, documents scanned/pending/capped/truncated, `enabled`, `grouped`. */
  summary: null,
  /** The rule the list is narrowed to; '' is every rule. */
  rule: '',
  /** A "Show more" read is in flight. */
  more: false,
  /** Why the last "Show more" read failed; the list in hand is still right, so it stays and the button offers another try. */
  moreError: '',
  /** What the list in hand was read for; a different key reads again. */
  loadedKey: null,
  loadedAt: null,
};

// ---------- pure helpers (tested without a DOM) ----------

/** How many of the findings in hand share each group id (a finding with no group is never counted). */
export function groupSizes(items) {
  const sizes = new Map();
  for (const item of items) if (item.group) sizes.set(item.group, (sizes.get(item.group) ?? 0) + 1);
  return sizes;
}

/** The findings the project holds, narrowed to a rule when one is chosen. */
export function totalFor(summary, rule) {
  if (!summary) return 0;
  if (rule) return summary.byRule?.[rule] ?? 0;
  return Object.values(summary.byRule ?? {}).reduce((sum, n) => sum + n, 0);
}

const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/** The text of an empty list, which is a different thing in each of these cases. */
export function emptyText(summary, rule) {
  if (!summary.enabled) {
    // Findings of other rules exist: say what this empty list is (nothing of this rule from before), not that nothing was ever reported.
    if (rule && totalFor(summary, '') > 0) {
      return `No findings for ${ruleLabel(rule)} among those found before scanning was switched off (PII_SCAN=0).`;
    }
    return 'Scanning is switched off on this server (PII_SCAN=0), so no document is being checked and none has been reported.';
  }
  if (rule) return `No findings for ${ruleLabel(rule)}.`;
  if (summary.documentsScanned === 0 && summary.documentsPending > 0) {
    return `Nothing has been scanned yet. ${plural(summary.documentsPending, 'document is', 'documents are')} waiting; use Refresh in a moment.`;
  }
  return `No findings. ${plural(summary.documentsScanned, 'document was', 'documents were')} scanned and none holds a secret or a personal number the rules recognise.`;
}

/**
 * The statements about the scan that are not findings, each in its own sentence: the scan is off, nothing is
 * grouped, documents wait, hit a ceiling, were cut or have no text. Each is a separate fact the reader needs to
 * read the list correctly, so none is folded into another.
 */
export function scanNotes(summary, { listed = true } = {}) {
  const notes = [];
  // Said beside findings, to qualify them. With none listed the empty-list text already says scanning is off, and saying it twice is noise.
  if (!summary.enabled && listed) {
    notes.push({
      key: 'disabled',
      tone: 'warn',
      text: 'Scanning is switched off (PII_SCAN=0). New and changed documents are not checked; the findings below are from before it was switched off.',
    });
  }
  if (!summary.grouped) {
    notes.push({
      key: 'ungrouped',
      tone: 'info',
      text: 'Findings are not grouped: SECRET_KEY is not set, so the same value found twice is listed twice with nothing linking the two. Set SECRET_KEY to group them.',
    });
  }
  if (summary.enabled && summary.documentsPending > 0) {
    notes.push({
      key: 'pending',
      tone: 'info',
      text: `${plural(summary.documentsPending, 'document is', 'documents are')} waiting to be scanned, so the list may be incomplete. Refresh in a moment.`,
    });
  }
  if (summary.documentsCapped > 0) {
    notes.push({
      key: 'capped',
      tone: 'warn',
      text: `${plural(summary.documentsCapped, 'document has', 'documents have')} more findings than are kept. The first ones in reading order are listed; the counts above are of what is kept.`,
    });
  }
  if (summary.documentsTruncated > 0) {
    notes.push({
      key: 'truncated',
      tone: 'warn',
      text: `${plural(summary.documentsTruncated, 'document was', 'documents were')} cut when indexed, and the scan read the stored text only. Anything after the cut was not looked at.`,
    });
  }
  if (summary.documentsWithoutText > 0) {
    notes.push({
      key: 'no-text',
      tone: 'info',
      text: `${plural(summary.documentsWithoutText, 'document has', 'documents have')} no stored text, so there was nothing to scan.`,
    });
  }
  return notes;
}

// ---------- loading ----------

/** The number of the newest read; a rule changed or a project switched while one is in flight makes its answer stale. */
let latestRead = 0;

function reset(projectId) {
  Object.assign(findingsState, {
    projectId,
    status: 'idle',
    error: '',
    items: [],
    nextCursor: null,
    summary: null,
    rule: '',
    more: false,
    moreError: '',
    loadedKey: null,
    loadedAt: null,
  });
}

function readPath(project, cursor) {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (findingsState.rule) params.set('rule', findingsState.rule);
  if (cursor) params.set('cursor', cursor);
  return `/api/projects/${project.id}/findings?${params}`;
}

/**
 * Reads the first page when the selection moves, when the project's index moved (a build is what sets the scan
 * going), when the rule changes, and when forced. Otherwise the two-second poll that calls this is a no-op. The
 * scan runs after the build, so what it has found by the time of this read can be less than it will: the panel
 * says so (`scanNotes`) and carries a Refresh, and does not read again on its own — a "Show more" page the
 * person has opened would be thrown away by it.
 */
export async function loadFindings(force = false) {
  return loadFindingsFor(state.projects.find((p) => p.id === state.selectedId) ?? null, force);
}

/** `loadFindings` for a project given; nothing is asked for an account below `editor`. */
export async function loadFindingsFor(project, force = false) {
  const s = findingsState;
  if (!project) {
    s.projectId = null;
    s.status = 'idle';
    s.loadedKey = null;
    return;
  }
  if (s.projectId !== project.id) reset(project.id);
  if (!canEdit(project)) return;

  const key = `${project.id}|${project.lastIndexedAt ?? ''}|${project.documentCount}|${s.rule}`;
  if (!force && s.loadedKey === key) return;
  s.loadedKey = key;
  s.status = 'loading';
  s.more = false;
  s.moreError = '';
  // The list and its cursor answer the rule or the index of before: a failure of this read must not leave them under the new rule's name,
  // and a "Show more" taken while it runs must not send the old cursor with the new rule.
  s.items = [];
  s.nextCursor = null;
  // Draw "Reading…" now: a rule was just chosen, or Refresh pressed, and the list in hand answers something older.
  emit('render');
  const read = ++latestRead;
  const superseded = () => read !== latestRead || s.projectId !== project.id;
  try {
    const page = await api(readPath(project, null));
    if (superseded()) return;
    s.items = page.findings;
    s.nextCursor = page.nextCursor;
    s.summary = page.summary;
    s.status = 'done';
    s.error = '';
    s.loadedAt = new Date().toISOString();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (superseded()) return;
    s.status = 'error';
    s.error = err.message;
  }
  emit('render');
}

async function loadMore(project) {
  const s = findingsState;
  // Only a list that is read can be extended: while the first page is on its way (or failed) the cursor is not one to use.
  if (!s.nextCursor || s.more || s.status !== 'done') return;
  s.more = true;
  s.moreError = '';
  emit('render');
  const read = ++latestRead;
  const superseded = () => read !== latestRead || s.projectId !== project.id;
  try {
    const page = await api(readPath(project, s.nextCursor));
    if (superseded()) return;
    s.items = [...s.items, ...page.findings];
    s.nextCursor = page.nextCursor;
    s.summary = page.summary;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (superseded()) return;
    s.moreError = err.message;
  } finally {
    if (read === latestRead) s.more = false;
  }
  emit('render');
}

function chooseRule(project, rule) {
  findingsState.rule = rule;
  void loadFindingsFor(project, false);
}

// ---------- rendering ----------

function findingRow(item, sizes) {
  const href = safeSourceUrl(item.sourceUrl);
  const shared = item.group ? (sizes.get(item.group) ?? 0) : 0;
  return el('li', { class: 'finding' }, [
    el('div', { class: 'finding-head' }, [
      el('span', { class: 'finding-rule', text: ruleLabel(item.rule) }),
      href
        ? el('a', { class: 'finding-path', href, target: '_blank', rel: 'noopener noreferrer', title: href, text: item.path })
        : el('span', { class: 'finding-path', text: item.path }),
      el('span', { class: 'field-hint', text: `line ${fmt(item.line)}, column ${fmt(item.col)}` }),
    ]),
    el('div', { class: 'finding-body' }, [
      el('code', { class: 'finding-preview', text: item.preview }),
      shared > 1
        ? el('span', {
            class: 'finding-group',
            title: `Group ${item.group}: findings of the same value share it. Counted among the findings listed.`,
            text: `same value ${item.group.slice(0, 8)} ×${fmt(shared)}`,
          })
        : null,
    ]),
  ]);
}

function ruleFilter(project, summary) {
  const s = findingsState;
  const rules = Object.keys(summary.byRule ?? {});
  return el(
    'select',
    {
      class: 'search-limit findings-rule-select',
      'aria-label': 'Show findings of one rule',
      onchange: (event) => chooseRule(project, event.target.value),
    },
    [
      el('option', { value: '', selected: s.rule === '' || undefined, text: `All rules (${fmt(totalFor(summary, ''))})` }),
      ...rules.map((rule) =>
        el('option', { value: rule, selected: s.rule === rule || undefined, text: `${ruleLabel(rule)} (${fmt(summary.byRule[rule])})` }),
      ),
    ],
  );
}

function listBody(project) {
  const s = findingsState;
  const summary = s.summary;
  const total = totalFor(summary, s.rule);
  // Without SECRET_KEY the server sends no group; a group that came anyway is not drawn, since the note says there are none.
  const sizes = summary.grouped ? groupSizes(s.items) : new Map();

  return el('div', { class: 'findings-body' }, [
    el('div', { class: 'findings-controls' }, [
      ruleFilter(project, summary),
      el('span', {
        class: 'field-hint',
        role: 'status',
        text: s.items.length === 0 ? '' : `Showing ${fmt(s.items.length)} of ${fmt(total)}`,
      }),
    ]),
    ...scanNotes(summary, { listed: s.items.length > 0 }).map((note) =>
      el('p', { class: `findings-note ${note.tone}`, 'data-note': note.key, text: note.text }),
    ),
    // The first page failed (a rule was chosen, or Refresh pressed): there is no list to show, and the empty text would claim a result.
    s.status === 'error'
      ? el('p', { class: 'field-hint warn', role: 'alert', text: `The findings could not be read: ${s.error}. Use Refresh to try again.` })
      : null,
    // A rule was just chosen: the list in hand answers the old one.
    s.status === 'loading'
      ? el('p', { class: 'hint findings-empty', text: 'Reading the findings…' })
      : s.status === 'error'
        ? null
        : s.items.length === 0
          ? el('p', { class: 'hint findings-empty', text: emptyText(summary, s.rule) })
          : el(
              'ul',
              { class: 'findings-list', 'aria-label': 'Findings, by document path' },
              s.items.map((item) => findingRow(item, sizes)),
            ),
    s.moreError ? el('p', { class: 'field-hint warn', role: 'alert', text: `The next findings could not be read: ${s.moreError}` }) : null,
    s.nextCursor && s.status === 'done'
      ? el('button', {
          type: 'button',
          class: 'ghost small',
          text: s.more ? 'Loading…' : `Show ${fmt(Math.min(PAGE, Math.max(total - s.items.length, 0)) || PAGE)} more`,
          disabled: s.more || undefined,
          onclick: () => void loadMore(project),
        })
      : null,
  ]);
}

/**
 * The section for a project, or `null` for an account below `editor`: it is not drawn for a viewer (the route
 * refuses it as well). The caller appends it only when there is one.
 */
export function renderFindings(project) {
  if (!canEdit(project)) return null;
  const s = findingsState;
  const mine = s.projectId === project.id;
  const loading = !mine || s.status === 'idle' || (s.status === 'loading' && !s.summary);

  let body;
  if (loading) {
    body = el('p', { class: 'hint', text: 'Reading the findings…' });
  } else if (s.status === 'error' && !s.summary) {
    body = el('p', { class: 'form-error', role: 'alert' }, [
      `Could not read the findings: ${s.error} `,
      el('button', { type: 'button', class: 'ghost small', text: 'Retry', onclick: () => void loadFindingsFor(project, true) }),
    ]);
  } else {
    body = listBody(project);
  }

  return el('section', { class: 'panel', id: 'findings-panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Secrets and personal data' }),
        el('p', {
          text: 'Where the scan found credentials and personal numbers in the indexed documents. Only the rule, the place and a masked preview are shown, never the value.',
        }),
      ]),
      el('div', { class: 'source-actions' }, [
        s.loadedAt ? el('span', { class: 'field-hint', text: `read ${relativeTime(s.loadedAt)}` }) : null,
        el('button', {
          type: 'button',
          class: 'ghost small',
          text: s.status === 'loading' ? 'Loading…' : 'Refresh',
          disabled: s.status === 'loading' || undefined,
          onclick: () => void loadFindingsFor(project, true),
        }),
      ]),
    ]),
    body,
  ]);
}
