// What the agent sees, on the page the operator is already looking at.
//
// This panel runs `GET /api/projects/:id/search`, which is the same retrieval path the project's
// `search_docs` tool runs — so the excerpts and the scores here are the ones an agent receives, not
// an approximation of them. The score is shown on purpose: comparing two configurations needs the
// number, not just the order.
//
// The awkward part is that app.js rebuilds #detail from scratch on every poll, so nothing typed here
// may live in the DOM. The query, the caret and whether the box has focus are all in state.search,
// and the input's `input` event writes there without re-rendering.

import { ApiError, api, el, emit, state } from './core.js';

const LIMITS = [5, 10, 20];

/** The input of the panel currently on screen. Every rebuild replaces it; the restore below checks. */
let input = null;

export function renderSearch(project) {
  const s = state.search;
  // A project change clears the box as well as the hits — one project's excerpts under another
  // project's name is worse than no excerpts. Every path into the detail view comes through here,
  // including the automatic selection in refresh(), so this is the one place that has to do it.
  if (s.projectId !== project.id) resetSearch(project.id);

  const empty = project.chunkCount === 0;

  input = el('input', {
    type: 'search',
    class: 'search-input',
    name: 'q',
    placeholder: empty ? 'Nothing indexed yet' : 'Ask the way an agent would: "how do I rotate the webhook secret?"',
    'aria-label': `Search ${project.name}`,
    maxlength: '2000',
    autocomplete: 'off',
    disabled: empty || undefined,
    value: s.query,
    oninput: (event) => {
      // Deliberately no render: re-rendering on every keystroke is what destroys the caret.
      s.query = event.target.value;
      s.caret = event.target.selectionStart ?? event.target.value.length;
    },
    // No blur handler on purpose. Chrome fires blur when a focused node is removed, and it does so
    // while the node still looks connected — so a blur handler cannot tell "the operator left the
    // box" from "renderDetail() wiped the panel". captureSearchFocus() below settles it instead, by
    // asking the document before the wipe rather than guessing after it. Measured, not assumed: the
    // first version of this file used the isConnected guard and lost the caret on every poll.
    onfocus: () => {
      s.focused = true;
    },
    onkeydown: (event) => {
      if (event.key === 'Escape') clear();
    },
  });

  const submit = el('button', { type: 'submit', class: 'primary small', text: 'Search', disabled: empty || undefined });

  const form = el(
    'form',
    {
      class: 'search-form',
      onsubmit: (event) => {
        event.preventDefault();
        void run(project);
      },
    },
    [
      input,
      el(
        'select',
        {
          class: 'search-limit',
          'aria-label': 'Number of excerpts',
          disabled: empty || undefined,
          onchange: (event) => {
            s.limit = Number(event.target.value);
          },
        },
        LIMITS.map((n) => el('option', { value: String(n), selected: s.limit === n || undefined, text: `${n} hits` })),
      ),
      submit,
    ],
  );

  restoreFocus(input, s.caret);

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: 'Search' }),
      el('p', {
        text: empty
          ? 'Index this project and its documents become searchable here, exactly as an agent would find them.'
          : 'The same query your agent would send to search_docs, against the same chunks. The score is the raw cosine similarity.',
      }),
    ]),
    el('div', { class: 'panel-body' }, [form, results(s)]),
  ]);
}

/**
 * Called by app.js as the first thing renderDetail() does, while `document.activeElement` still
 * means something: once #detail has been emptied, whether this box had focus is unknowable.
 * Also the moment the caret is read, so moving it with the arrow keys is remembered too.
 */
export function captureSearchFocus() {
  const node = input;
  if (!node) return;
  const active = document.activeElement === node;
  state.search.focused = active;
  if (active) state.search.caret = node.selectionStart ?? node.value.length;
}

/** Everything but the chosen `limit`, which is a preference and survives a change of project. */
function resetSearch(projectId) {
  Object.assign(state.search, { projectId, query: '', caret: 0, focused: false, status: 'idle', error: '', ranQuery: '', hits: [] });
}

// ---------- the results half ----------

function results(s) {
  if (s.status === 'searching') return el('p', { class: 'hint', text: 'Searching…' });
  if (s.status === 'error')
    return el('div', { class: 'callout error' }, [el('span', { class: 'callout-title', text: 'Search failed' }), el('pre', { text: s.error })]);
  if (s.status === 'idle')
    return el('p', { class: 'hint', text: 'Results appear here with the file they came from and the score that ranked them.' });
  if (s.hits.length === 0) {
    return el('p', { class: 'hint', text: `Nothing matched “${s.ranQuery}”. Try the words the documentation itself would use.` });
  }

  return el('div', { class: 'hit-list' }, [
    el('p', { class: 'hint', text: `${s.hits.length} excerpt${s.hits.length === 1 ? '' : 's'} for “${s.ranQuery}”, best first.` }),
    ...s.hits.map((hit, i) =>
      el('article', { class: 'hit' }, [
        el('div', { class: 'hit-head' }, [
          el('span', { class: 'hit-rank', text: String(i + 1) }),
          el('code', { class: 'hit-path', text: hit.path, title: hit.path }),
          hit.headingPath ? el('span', { class: 'hit-crumb', text: hit.headingPath, title: hit.headingPath }) : null,
          el('span', {
            class: 'hit-score',
            text: hit.score.toFixed(3),
            title: `Cosine similarity, higher is better · chunk #${hit.chunkIndex} of ${hit.title}`,
          }),
        ]),
        el('pre', { class: 'hit-body', text: hit.content.trim() }),
      ]),
    ),
  ]);
}

// ---------- actions ----------

async function run(project) {
  const s = state.search;
  const query = s.query.trim();
  if (!query) return;

  s.status = 'searching';
  s.error = '';
  s.ranQuery = query;
  emit('render');

  try {
    const params = new URLSearchParams({ q: query, limit: String(s.limit) });
    const result = await api(`/api/projects/${project.id}/search?${params}`);
    if (state.selectedId !== project.id) return; // selection moved on meanwhile
    s.hits = result.hits;
    s.status = 'done';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // core.js is already going to /login
    s.hits = [];
    s.status = 'error';
    // 409 not_indexed / model_mismatch arrive here too, and their message is the remedy.
    s.error = err.message;
  }
  emit('render');
}

function clear() {
  const s = state.search;
  s.query = '';
  s.caret = 0;
  s.status = 'idle';
  s.hits = [];
  s.ranQuery = '';
  emit('render');
}

/**
 * renderDetail() cannot always be avoided — finishing a search re-renders on purpose — so when the
 * box had focus before the rebuild, give it back afterwards with the caret where it was. Deferred
 * because the node this returns has not been appended to the document yet.
 */
function restoreFocus(node, caret) {
  if (!state.search.focused) return;
  setTimeout(() => {
    // Only for the panel still on screen, and never over a focus the operator has moved since.
    if (node !== input || !node.isConnected || document.activeElement === node) return;
    node.focus();
    const at = Math.min(caret, node.value.length);
    try {
      node.setSelectionRange(at, at);
    } catch {
      /* setSelectionRange is not supported on type="search" in every browser */
    }
  }, 0);
}
