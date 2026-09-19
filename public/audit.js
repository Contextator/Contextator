// Who changed this instance, and what they changed — the panel over `audit_events` (ADR-0055).
//
// An instance view and not a project one, at #/~audit, beside the account list: a row may name a
// project that has since been deleted, and half of what the log records — an account created, a role
// granted, a password reset — belongs to no project at all. Only root and admin reach it; the server
// refuses /api/audit to anyone else.
//
// **Every filter and every page is the server's.** The panel sends actor, action, project and a UTC
// day range as query parameters and renders exactly the rows that come back. Nothing is narrowed in
// the browser, because a year of every state-changing request is not something to download in order
// to look at fifty rows of it.
//
// As with search.js and queries.js, everything transient lives in state.audit: app.js rebuilds
// #detail on every poll, and a chosen filter or the page somebody paged to would otherwise vanish
// while they were reading it. captureAuditFocus() below is the other half — which control had focus
// is unknowable once #detail has been emptied, so it is recorded before the wipe.

import { ApiError, api, el, emit, fmt, icon, relativeTime, state } from './core.js';

/** One screenful. The server's own default; sent explicitly so the two cannot drift apart. */
const PAGE_SIZE = 50;

/** Everything that decides which request to send; a change of any part of it refetches. */
const requestKey = () =>
  [state.audit.actor, state.audit.project, state.audit.action, state.audit.from, state.audit.to, state.audit.cursor ?? ''].join('|');

function params() {
  const search = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (state.audit.actor) search.set('actor', state.audit.actor);
  if (state.audit.action) search.set('action', state.audit.action);
  if (state.audit.project) search.set('project', state.audit.project);
  if (state.audit.from) search.set('from', state.audit.from);
  if (state.audit.to) search.set('to', state.audit.to);
  if (state.audit.cursor) search.set('cursor', state.audit.cursor);
  return search;
}

/**
 * Fetches a page when a filter or the position moves — and never on a poll.
 *
 * ADR-0050's rule, applied to the other log: app.js calls this on every refresh, and every one of
 * those is a no-op unless `requestKey()` has changed. Re-reading a filtered page of an append-only
 * table twice a second would put a scan on it for nothing, so what is here instead is a Refresh
 * button and the "read N ago" beside it, so the reader can see how old what they are looking at is.
 */
export async function loadAudit(force = false) {
  const key = requestKey();
  if (!force && state.audit.loadedKey === key) return;
  state.audit.loadedKey = key;
  state.audit.status = 'loading';
  emit('render'); // so the Refresh button says "Reading…" while it is
  try {
    const data = await api(`/api/audit?${params()}`);
    if (state.audit.loadedKey !== key) return; // a filter moved while this was in flight
    state.audit.events = data.events;
    state.audit.nextCursor = data.nextCursor;
    // The pickers come back only with the first page of a filter run; keep the ones in hand otherwise.
    if (data.filters) state.audit.filters = data.filters;
    state.audit.retentionDays = data.retentionDays;
    state.audit.loadedAt = new Date().toISOString();
    state.audit.status = 'done';
    state.audit.error = '';
    emit('render');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // core.js is already going to /login
    state.audit.status = 'error';
    state.audit.error = err.message;
    emit('render');
  }
}

// ---------- rendering ----------

/** The panel currently on screen. Every rebuild replaces it; the focus restore below checks. */
let panel = null;

export function renderAuditView() {
  const events = state.audit.events;
  const wrap = el('div', {});

  wrap.append(
    el('a', { class: 'back-link', href: '#/', text: '← Projects' }),
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-title' }, [
        el('div', { class: 'title-row' }, [
          el('h1', { text: 'Audit log' }),
          el('span', { class: 'pill idle', text: `${fmt(events.length)} event${events.length === 1 ? '' : 's'} on this page` }),
        ]),
        el('p', {
          class: 'users-lead',
          text:
            'Every state-changing admin request that succeeded, with the account that made it. It is written by the ' +
            'authorization layer rather than by each handler, so no route can opt out — and it carries no questions, no ' +
            'documents and no excerpts. What agents asked is the query log, on each project’s own page.',
        }),
      ]),
      el('div', { class: 'detail-actions' }, [
        el(
          'button',
          {
            type: 'button',
            class: 'ghost',
            'data-audit-key': 'refresh',
            title: 'This panel does not re-read itself on the dashboard’s poll',
            disabled: state.audit.status === 'loading' || undefined,
            onclick: () => void loadAudit(true),
          },
          [icon('refresh'), state.audit.status === 'loading' ? 'Reading…' : 'Refresh'],
        ),
      ]),
    ]),
    el('section', { class: 'panel' }, [el('div', { class: 'panel-body' }, [controls(), body(), pager(), foot()])]),
  );

  panel = wrap;
  restoreFocus(wrap);
  return wrap;
}

// ---------- the filter bar ----------

function controls() {
  const f = state.audit.filters;
  const picker = (key, label, options) =>
    field(
      label,
      el(
        'select',
        {
          class: 'search-limit',
          'data-audit-key': key,
          onchange: (event) => {
            state.audit[key] = event.target.value;
            resetPaging();
            emit('render');
            void loadAudit();
          },
        },
        options,
      ),
    );

  const day = (key, label) =>
    field(
      label,
      el('input', {
        type: 'date',
        class: 'search-limit',
        'data-audit-key': key,
        value: state.audit[key],
        max: '9999-12-31',
        onchange: (event) => {
          state.audit[key] = event.target.value;
          resetPaging();
          emit('render');
          void loadAudit();
        },
      }),
    );

  const option = (value, text, selected) => el('option', { value, text, selected: selected || undefined });

  return el('div', { class: 'audit-controls' }, [
    picker('actor', 'Who', [
      option('', 'anyone', state.audit.actor === ''),
      ...(f?.actors ?? []).map((a) => option(a.label, a.kind === 'token' ? `${a.label} (credential)` : a.label, state.audit.actor === a.label)),
    ]),
    picker('action', 'What', [
      option('', 'any action', state.audit.action === ''),
      ...(f?.actions ?? []).map((a) => option(a.action, a.summary, state.audit.action === a.action)),
    ]),
    picker('project', 'Where', [
      option('', 'anywhere', state.audit.project === ''),
      option('none', 'no project (accounts, sessions)', state.audit.project === 'none'),
      ...(f?.projects ?? []).map((p) => option(p.id, p.name ?? `${p.id.slice(0, 8)}… (deleted)`, state.audit.project === p.id)),
    ]),
    day('from', 'From (UTC)'),
    day('to', 'To (UTC)'),
    hasFilter()
      ? el('button', { type: 'button', class: 'ghost small', 'data-audit-key': 'clear', text: 'Clear filters', onclick: clearFilters })
      : null,
    state.audit.loadedAt ? el('span', { class: 'field-hint', text: `read ${relativeTime(state.audit.loadedAt)}` }) : null,
    f?.truncated
      ? el('span', {
          class: 'field-hint warn',
          text: 'These pickers show the first 200 distinct values only; a filter you cannot find here can still be reached by narrowing the dates.',
        })
      : null,
  ]);
}

/** A visible label, joined to its control by wrapping it: no id to keep in step with index.html. */
const field = (label, control) => el('label', { class: 'audit-field' }, [el('span', { class: 'field-hint', text: label }), control]);

/** `2026-09-19 08:30:12Z` — an ISO instant with the `T` opened out, still unambiguous and UTC. */
const utcStamp = (when) => `${when.toISOString().slice(0, 19).replace('T', ' ')}Z`;

const hasFilter = () => Boolean(state.audit.actor || state.audit.action || state.audit.project || state.audit.from || state.audit.to);

function clearFilters() {
  state.audit.actor = '';
  state.audit.action = '';
  state.audit.project = '';
  state.audit.from = '';
  state.audit.to = '';
  resetPaging();
  emit('render');
  void loadAudit();
}

/** Any change of filter starts at the newest row again: a cursor names a position in the old order. */
function resetPaging() {
  state.audit.cursor = null;
  state.audit.back = [];
}

// ---------- the rows ----------

function body() {
  if (state.audit.status === 'error') {
    return el('div', { class: 'callout error' }, [
      el('span', { class: 'callout-title', text: 'Could not read the audit log' }),
      el('pre', { text: state.audit.error }),
    ]);
  }
  if (state.audit.events.length === 0) {
    return el('p', {
      class: 'hint',
      text:
        state.audit.status === 'loading' && state.audit.loadedAt === null
          ? 'Reading the log…'
          : hasFilter()
            ? 'Nothing matches these filters. Widen the dates, or clear them.'
            : 'Nothing has been recorded yet. The log fills as accounts, projects and sources are changed.',
    });
  }

  return el('div', { class: 'audit-table' }, [
    el('div', { class: 'audit-grid head' }, [
      el('span', { text: 'When' }),
      el('span', { text: 'Who' }),
      el('span', { text: 'What happened' }),
      el('span', { class: 'right', text: 'Result' }),
    ]),
    ...state.audit.events.map(row),
  ]);
}

/**
 * The exact instant first and the human one under it.
 *
 * "2 min ago" is what a dashboard usually shows and it is the wrong primary value here: in an
 * accountability record *when exactly* is the fact somebody is establishing, and a relative time
 * cannot be compared against a log line, a ticket or another instance. It is shown in **UTC**, which
 * is also the zone the two date filters are in — a row stamped in local time beside a filter counted
 * in UTC is how an operator concludes a row is missing.
 */
function row(event) {
  const when = new Date(event.createdAt);
  return el('div', { class: 'audit-grid' }, [
    el('span', { class: 'audit-when' }, [
      el('span', { class: 'mono', text: utcStamp(when), title: `${event.createdAt} — local: ${when.toLocaleString()}` }),
      el('span', { class: 'sub', text: relativeTime(event.createdAt) }),
    ]),
    el('span', { class: 'audit-actor' }, [
      el('span', { class: 'audit-who', text: event.actor.label }),
      event.actor.kind === 'token'
        ? el('span', { class: 'pill small', text: 'credential', title: 'ADMIN_TOKEN — machine access, not a person' })
        : null,
      event.actor.accountGone
        ? el('span', { class: 'sub', text: 'account deleted', title: 'The account is gone; the name it acted under is kept on the row itself' })
        : null,
      event.actor.ip
        ? el('span', {
            class: 'sub mono',
            text: event.actor.ip,
            title: 'The address the request appeared to come from — a hint beside the actor, never the identity',
          })
        : null,
    ]),
    el('span', { class: 'audit-cell' }, [
      el('span', { class: 'audit-summary', text: event.summary }),
      el('span', {
        class: 'sub mono',
        text: event.action,
        title: `${event.action}${event.target ? ` · ${event.target.type} ${event.target.id}` : ''}`,
      }),
      event.project && event.project.name === null
        ? el('span', {
            class: 'sub warn',
            text: `project ${event.project.id} no longer exists`,
            title:
              'audit_events keeps the project id and no foreign key, so deleting a project does not delete the record of it — but the name cannot be looked up afterwards',
          })
        : null,
    ]),
    el('span', { class: 'right mono sub', text: String(event.statusCode) }),
  ]);
}

// ---------- paging and the limits of the thing ----------

function pager() {
  const page = state.audit.back.length + 1;
  const hasOlder = state.audit.nextCursor !== null;
  if (page === 1 && !hasOlder) return null;

  return el('div', { class: 'audit-pager' }, [
    el('button', {
      type: 'button',
      class: 'ghost small',
      'data-audit-key': 'newer',
      text: '← Newer',
      disabled: state.audit.back.length === 0 || undefined,
      onclick: () => {
        state.audit.cursor = state.audit.back.pop() ?? null;
        emit('render');
        void loadAudit();
      },
    }),
    el('span', { class: 'field-hint', text: `page ${fmt(page)}` }),
    el('button', {
      type: 'button',
      class: 'ghost small',
      'data-audit-key': 'older',
      text: 'Older →',
      disabled: !hasOlder || undefined,
      onclick: () => {
        state.audit.back.push(state.audit.cursor);
        state.audit.cursor = state.audit.nextCursor;
        emit('render');
        void loadAudit();
      },
    }),
  ]);
}

/**
 * What this log is not, said here rather than left for somebody to assume.
 *
 * Nothing about these rows proves they are complete: an operator with database access can delete one,
 * and there is no hash chain or external sink that would show it. SECURITY.md states it as a known
 * limit, and a panel that presented the table as evidence while the documentation called it a record
 * would be the panel doing the misleading.
 */
function foot() {
  const days = state.audit.retentionDays;
  return el('p', { class: 'field-hint audit-foot' }, [
    days ? `Events are kept for ${fmt(days)} days (AUDIT_LOG_RETENTION_DAYS) and then swept. ` : '',
    'The log is not tamper-evident: anyone with database access can remove a row, and nothing here would show it. ',
    'It records what was done — never what was asked or read.',
  ]);
}

// ---------- focus across the rebuild ----------

/**
 * Called by app.js as the first thing renderDetail() does, while `document.activeElement` still means
 * something: once #detail has been emptied, which control the operator was using is unknowable.
 *
 * search.js learned this the hard way with a blur handler — Chrome fires blur when a focused node is
 * removed, so a blur handler cannot tell "they left the field" from "the poll wiped the panel".
 */
export function captureAuditFocus() {
  // Not on screen at all — a different view, or the first render. Nothing to give back later.
  if (!panel || !panel.isConnected) {
    state.audit.focusKey = null;
    return;
  }
  const node = document.activeElement;
  if (!node || !panel.contains(node)) {
    state.audit.focusKey = null;
    return;
  }
  state.audit.focusKey = node.dataset?.auditKey ?? null;
  state.audit.caret = caretOf(node);
}

/** `selectionStart` throws on an `input[type=date]` in Chrome, which is two of these controls. */
function caretOf(node) {
  try {
    return typeof node.selectionStart === 'number' ? node.selectionStart : 0;
  } catch {
    return 0;
  }
}

/** Deferred, because the tree this is handed has not been appended to the document yet. */
function restoreFocus(root) {
  const key = state.audit.focusKey;
  if (!key) return;
  const caret = state.audit.caret;
  setTimeout(() => {
    // Only for the panel still on screen, and never over a focus the operator has moved since.
    if (root !== panel || !root.isConnected) return;
    const node = root.querySelector(`[data-audit-key="${key}"]`);
    if (!node || node.disabled || document.activeElement === node) return;
    node.focus();
    try {
      if (typeof node.selectionStart === 'number') node.setSelectionRange(caret, caret);
    } catch {
      /* not supported on every input type */
    }
  }, 0);
}
