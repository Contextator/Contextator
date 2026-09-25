// What agents asked this project, and what the documentation did with it.
//
// The panel ADR-0047 wrote the table for and deliberately did not build, because it is worth nothing
// until there are weeks of rows behind it (ADR-0050).
//
// **Nothing here classifies a question.** ADR-0042 measured that a question shaped exactly like the
// product whose answer is absent scores *inside* the band of questions that are answered, and ADR-0045
// re-measured that against an independently written set and took away even the off-domain separation.
// So there is no threshold that can print "unanswered" beside a row, and `below_floor` — the column
// that looks like it means exactly that — reports the questions that were not about this documentation
// while missing every question the documentation failed. What this panel shows instead is the count
// and the score, ordered so that "asked forty-one times and never above 0.84" rises to the top, and
// the operator makes the judgement the product cannot.
//
// Every figure describes **one embedding model, one index generation and one relevance floor**, named
// above the table. A week that spans a model change averaged into one number is the confusion the
// whole feature was written about, and a floor change is the same confusion one column over: the week
// before it refused different searches than the week after, and one "refused" figure across both
// describes neither.
//
// As with search.js, everything transient lives in state.queries: app.js rebuilds #detail on every
// poll, and a tab or a window length held in the DOM would vanish while somebody was reading it.

import { ApiError, api, el, emit, fmt, relativeTime, state, toast } from './core.js';

const WINDOWS = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const ACTORS = [
  { value: 'mcp', label: 'agents (MCP)' },
  { value: 'dashboard', label: 'this dashboard' },
  { value: 'all', label: 'both' },
];

const TABS = [
  { key: 'questions', label: 'Questions' },
  { key: 'documents', label: 'Never returned' },
  { key: 'chunks', label: 'Most returned' },
  { key: 'volume', label: 'Volume' },
];

/**
 * `<model>@<generation>@<floor>`, with `none` for a floor the log did not record (searches logged before
 * the column existed). The model is split off last-`@`-first, so a model id that contains one survives.
 */
const configKey = (c) => (c ? `${c.embeddingModel}@${c.liveGeneration}@${c.scoreFloor ?? 'none'}` : '');
const modelKey = (c) => `${c.embeddingModel}@${c.liveGeneration}`;
const floorText = (floor) => (floor === null ? 'floor not recorded' : floor === 0 ? 'floor off' : `floor ${floor}`);
const score = (value) => (value === null || value === undefined ? '—' : value.toFixed(3));

/** Everything that decides which request to send; a change of any part of it refetches. */
const requestKey = (projectId) => {
  const q = state.queries;
  return [projectId, q.days, q.actor, q.configKey ?? ''].join('|');
};

function params(limit) {
  const q = state.queries;
  const search = new URLSearchParams({ days: String(q.days), actor: q.actor, limit: String(limit) });
  if (q.configKey) {
    const floorAt = q.configKey.lastIndexOf('@');
    const rest = q.configKey.slice(0, floorAt);
    const generationAt = rest.lastIndexOf('@');
    search.set('model', rest.slice(0, generationAt));
    search.set('generation', rest.slice(generationAt + 1));
    search.set('floor', q.configKey.slice(floorAt + 1));
  }
  return search;
}

/**
 * Fetches the summary when the selection, the window, the actor or the configuration changes — and
 * never on a poll. A panel that refetched every two seconds would be four queries a poll against the
 * table the product's own searches are writing into.
 */
export async function loadQuerySummary(force = false) {
  const project = state.projects.find((p) => p.id === state.selectedId);
  const q = state.queries;
  if (!project) {
    q.projectId = null;
    q.data = null;
    q.loadedKey = null;
    return;
  }
  if (q.projectId !== project.id) reset(project.id);

  const key = requestKey(project.id);
  if (!force && q.loadedKey === key) return;
  q.loadedKey = key;
  q.status = 'loading';
  try {
    const data = await api(`/api/projects/${project.id}/queries/summary?${params(20)}`);
    if (state.selectedId !== project.id || q.loadedKey !== key) return; // moved on meanwhile
    q.data = data;
    q.loadedAt = new Date().toISOString();
    q.status = 'done';
    emit('render');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // core.js is already going to /login
    q.status = 'error';
    q.error = err.message;
    emit('render');
  }
}

/** The chosen configuration is the one thing that must not survive a change of project. */
function reset(projectId) {
  Object.assign(state.queries, {
    projectId,
    configKey: null,
    loadedKey: null,
    loadedAt: null,
    status: 'idle',
    error: '',
    data: null,
    confirmPurge: false,
    floorPending: undefined,
    floorPreview: null,
  });
}

// ---------- rendering ----------

export function renderQueries(project) {
  const q = state.queries;
  if (q.projectId !== project.id) reset(project.id);
  const data = q.projectId === project.id ? q.data : null;
  const mayManage = project.access === 'manager';

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', {}, [
        'What agents asked ',
        data && !data.logEnabled ? el('span', { class: 'pill small error', text: 'recording off' }) : null,
        data && data.logEnabled && !data.instanceLogEnabled ? el('span', { class: 'pill small error', text: 'off instance-wide' }) : null,
      ]),
      el('p', {
        text:
          'A question asked many times whose best match never rose far is the one signal that your documentation fails ' +
          'to answer something — no single search can say it, because a question about a feature you do not have scores ' +
          'about as well as one you do. The rows are ordered, not labelled: the count and the score are here so you can ' +
          'judge, and nothing is hidden by a threshold.',
      }),
    ]),
    el('div', { class: 'panel-body' }, [
      controls(project),
      configurationLine(data),
      body(data, q),
      foot(project, data, mayManage),
      floorLine(project, data, mayManage),
    ]),
  ]);
}

function controls(project) {
  const q = state.queries;
  const pick = (key, options, label) =>
    el(
      'select',
      {
        class: 'search-limit',
        'aria-label': label,
        onchange: (event) => {
          q[key] = key === 'days' ? Number(event.target.value) : event.target.value;
          // A price read off another window is not the price of this one.
          if (q.floorPending !== undefined) void previewFloor(project, q.floorPending);
          void loadQuerySummary();
          emit('render');
        },
      },
      options,
    );

  return el('div', { class: 'queries-controls' }, [
    pick(
      'days',
      WINDOWS.map((w) => el('option', { value: String(w.days), selected: q.days === w.days || undefined, text: `last ${w.label}` })),
      'How far back to look',
    ),
    pick(
      'actor',
      ACTORS.map((a) => el('option', { value: a.value, selected: q.actor === a.value || undefined, text: `asked by ${a.label}` })),
      'Whose searches',
    ),
    el('button', {
      type: 'button',
      class: 'ghost small',
      text: q.status === 'loading' ? 'Loading…' : 'Refresh',
      disabled: q.status === 'loading' || undefined,
      onclick: () => void loadQuerySummary(true),
    }),
    // A plain link, because the session lives in a cookie the browser attaches by itself.
    el('a', {
      class: 'ghost small button-like',
      href: `/api/projects/${project.id}/queries/export?${params(100)}`,
      download: `${project.name}-questions.jsonl`,
      title: 'The same questions in the evaluation harness JSONL shape. Each row still needs the document that should answer it.',
      text: 'Export questions',
    }),
    q.loadedAt ? el('span', { class: 'field-hint', text: `read ${relativeTime(q.loadedAt)}` }) : null,
  ]);
}

/**
 * Which retrieval configuration the figures describe, and how much of the window is outside it.
 *
 * This line is the reason the panel can be believed at all: scores from two embedding models are not
 * comparable, and a re-index makes a new generation whose documents are different rows. It is a
 * selector rather than a caption because an operator comparing before and after a model change needs
 * both halves, one at a time.
 */
function configurationLine(data) {
  if (!data) return null;
  const q = state.queries;
  const chosen = data.configuration;
  if (!chosen) {
    return el('p', { class: 'hint', text: 'Nothing was asked of this project in this window.' });
  }
  const stale = data.current.embeddingModel && modelKey(chosen) !== `${data.current.embeddingModel}@${data.current.liveGeneration}`;
  // The same model and generation decided against another floor: the other side of a floor change.
  const otherFloors = data.configurations
    .filter((c) => modelKey(c) === modelKey(chosen) && configKey(c) !== configKey(chosen))
    .reduce((sum, c) => sum + c.queries, 0);
  const otherConfigurations = data.queriesOutsideConfiguration - otherFloors;
  return el('div', { class: 'queries-config' }, [
    el('span', { class: 'field-hint', text: 'These figures describe' }),
    el(
      'select',
      {
        class: 'search-limit mono',
        'aria-label': 'Retrieval configuration',
        onchange: (event) => {
          q.configKey = event.target.value || null;
          void loadQuerySummary();
          emit('render');
        },
      },
      data.configurations.map((c) =>
        el('option', {
          value: configKey(c),
          selected: configKey(c) === configKey(chosen) || undefined,
          text: `${c.embeddingModel} · generation ${c.liveGeneration} · ${floorText(c.scoreFloor)} · ${fmt(c.queries)} searches`,
        }),
      ),
    ),
    otherFloors > 0
      ? el('span', {
          class: 'field-hint warn',
          text: `${fmt(otherFloors)} more searches of this model and generation were decided against another relevance floor. They are kept apart because a floor changes which searches were refused; pick them above to compare.`,
        })
      : null,
    otherConfigurations > 0
      ? el('span', {
          class: 'field-hint warn',
          text: `${fmt(otherConfigurations)} more searches in this window were answered by another model or generation and are not in these figures.`,
        })
      : null,
    stale
      ? el('span', { class: 'field-hint warn', text: 'This is not what the project runs now — it has been re-indexed or the model changed.' })
      : null,
    data.window.beyondRetention
      ? el('span', {
          class: 'field-hint warn',
          text: `The log only keeps ${data.window.retentionDays} days (SEARCH_QUERY_LOG_RETENTION_DAYS), so a longer window shows what is left of it.`,
        })
      : null,
  ]);
}

function body(data, q) {
  if (q.status === 'error') {
    return el('div', { class: 'callout error' }, [
      el('span', { class: 'callout-title', text: 'Could not read the query log' }),
      el('pre', { text: q.error }),
    ]);
  }
  if (!data) return el('p', { class: 'hint', text: q.status === 'loading' ? 'Reading the log…' : 'Nothing read yet.' });
  if (!data.logEnabled) {
    return el('div', { class: 'callout warn' }, [
      el('span', { class: 'callout-title', text: 'This project is not recording what is asked of it' }),
      el('p', {
        text:
          'Anything below is what was recorded before it was switched off. With recording off this panel cannot tell you ' +
          'what your documentation fails to answer, because repetition over real traffic is the only instrument that can.',
      }),
      tabs(),
      table(data),
    ]);
  }
  return el('div', {}, [tabs(), table(data)]);
}

function tabs() {
  const q = state.queries;
  return el(
    'div',
    { class: 'tabs', role: 'tablist' },
    TABS.map((t) =>
      el('button', {
        type: 'button',
        class: 'tab',
        role: 'tab',
        'aria-selected': q.tab === t.key ? 'true' : 'false',
        text: t.label,
        onclick: () => {
          q.tab = t.key;
          emit('render');
        },
      }),
    ),
  );
}

const table = (data) =>
  ({
    questions: () => questionsTable(data),
    documents: () => documentsTable(data),
    chunks: () => chunksTable(data),
    volume: () => volumeTable(data),
  })[state.queries.tab]();

/**
 * The figure the panel exists for.
 *
 * Ordered by "asked often" and "best match never rose far" fused together — the same reciprocal rank
 * fusion the search itself uses to turn two rankings into one — so neither number has to be converted
 * into the other's units, which is what a threshold would be. Both are shown, and so is how many
 * distinct tokens and days the asking is spread over, because forty-one agents and one agent in a
 * loop are different facts and only the second is noise.
 */
function questionsTable(data) {
  if (data.questions.length === 0) return el('p', { class: 'hint', text: 'No searches in this window for this configuration.' });
  return el('div', { class: 'queries-table' }, [
    el('div', { class: 'query-grid head' }, [
      el('span', { text: 'Question' }),
      el('span', { class: 'right', text: 'Asked' }),
      el('span', { class: 'right', text: 'Spread' }),
      el('span', { class: 'right', text: 'Best match' }),
    ]),
    ...data.questions.map((row) =>
      el('div', { class: 'query-grid' }, [
        el('span', { class: 'query-cell' }, [
          el('span', { class: 'query-text', text: row.sample, title: row.queryNorm }),
          el('span', {
            class: 'sub',
            text:
              row.paths.length === 0
                ? 'returned nothing at all'
                : `returned ${row.paths.map((p) => `${p.relativePath}${p.headingPath ? ` › ${p.headingPath}` : ''} (${score(p.bestScore)})`).join(', ')}`,
          }),
        ]),
        el('span', { class: 'right mono', text: fmt(row.asked) }),
        el('span', {
          class: 'right sub',
          title:
            'How widely the asking is spread. One token asking forty-one times on one day is a client in a loop; ' +
            'forty-one tokens across six days is a documentation gap. An open project verifies no token, so it can attribute none.',
          text: `${row.askers || (row.unattributed ? '—' : 0)} × ${row.days}d`,
        }),
        el('span', {
          class: `right mono${row.everRefused ? ' warn' : ''}`,
          title: row.everRefused
            ? 'At least one of these askings was refused by the relevance floor. That is not what makes it a gap — a refusal usually means the question was not about this documentation at all.'
            : 'The best cosine similarity any of these askings ever reached.',
          text: score(row.bestScore),
        }),
      ]),
    ),
  ]);
}

/**
 * Documents nothing ever returned — and the count that keeps yesterday's page off the list.
 *
 * "Never returned" is meaningless without saying *never out of how many*: a page added an hour ago has
 * not been returned because it did not exist. So each row carries the number of searches that ran
 * while that document was in the index, and the list is ordered by it. `0 of 3` is a new document;
 * `0 of 412` is a document nobody can find.
 */
function documentsTable(data) {
  const never = data.neverReturned;
  if (never.documentsInGeneration === 0) {
    return el('p', {
      class: 'hint',
      text:
        'This configuration’s index generation no longer exists — a re-index superseded it and its documents were reclaimed. ' +
        'Pick the current configuration above to ask this of the documents that are actually indexed.',
    });
  }
  if (never.rows.length === 0) {
    return el('p', {
      class: 'hint',
      text: `Every one of the ${fmt(never.documentsInGeneration)} documents in this generation was returned at least once.`,
    });
  }
  return el('div', { class: 'queries-table' }, [
    el('p', {
      class: 'hint',
      text: `${fmt(never.rows.length)} of ${fmt(never.documentsInGeneration)} documents were never returned. “Of N” counts only the searches that ran after the document was indexed — a document added today cannot have been returned yesterday.`,
    }),
    el('div', { class: 'query-grid doc head' }, [
      el('span', { text: 'Document' }),
      el('span', { class: 'right', text: 'Returned' }),
      el('span', { class: 'right', text: 'Indexed' }),
    ]),
    ...never.rows.map((row) =>
      el('div', { class: 'query-grid doc' }, [
        el('span', { class: 'query-cell' }, [
          el('code', { class: 'hit-path', text: row.relativePath, title: row.relativePath }),
          el('span', { class: 'sub', text: row.title }),
        ]),
        el('span', { class: 'right mono', text: `0 of ${fmt(row.searchesSince)}` }),
        el('span', { class: 'right sub', title: new Date(row.indexedAt).toLocaleString(), text: relativeTime(row.indexedAt) }),
      ]),
    ),
  ]);
}

/** What agents are actually being handed, which is the other half of "what is this corpus for". */
function chunksTable(data) {
  if (data.chunks.length === 0) return el('p', { class: 'hint', text: 'Nothing was returned in this window for this configuration.' });
  return el('div', { class: 'queries-table' }, [
    el('div', { class: 'query-grid doc head' }, [
      el('span', { text: 'Excerpt' }),
      el('span', { class: 'right', text: 'Returned' }),
      el('span', { class: 'right', text: 'Mean score' }),
    ]),
    ...data.chunks.map((row) =>
      el('div', { class: 'query-grid doc' }, [
        el('span', { class: 'query-cell' }, [
          el('code', { class: 'hit-path', text: row.relativePath, title: row.relativePath }),
          el('span', { class: 'sub', text: `${row.headingPath || 'no heading'} · chunk #${row.chunkIndex} · best rank ${row.bestRank}` }),
        ]),
        el('span', { class: 'right mono', text: fmt(row.returned) }),
        el('span', { class: 'right mono', text: score(row.avgScore) }),
      ]),
    ),
  ]);
}

/** Searches per UTC day, with the silent days present so a gap reads as a gap rather than as absence. */
function volumeTable(data) {
  if (data.volume.length === 0) return el('p', { class: 'hint', text: 'No window to draw.' });
  const peak = Math.max(1, ...data.volume.map((b) => b.searches));
  return el('div', { class: 'queries-table' }, [
    el('div', { class: 'query-grid vol head' }, [
      el('span', { text: 'Day (UTC)' }),
      el('span', { text: '' }),
      el('span', { class: 'right', text: 'Searches' }),
      el('span', { class: 'right', text: 'Mean best' }),
    ]),
    ...data.volume.map((bucket) =>
      el('div', { class: 'query-grid vol' }, [
        el('span', { class: 'sub mono', text: bucket.day }),
        el('span', { class: 'vol-bar' }, el('span', { style: `width:${Math.round((bucket.searches / peak) * 100)}%` })),
        el('span', {
          class: 'right mono',
          title: `${bucket.empty} returned nothing · ${bucket.refused} refused by the relevance floor`,
          text: fmt(bucket.searches),
        }),
        el('span', { class: 'right mono', text: score(bucket.avgTopScore) }),
      ]),
    ),
  ]);
}

/** The manager's half: whether this project records at all, and throwing away what it has recorded. */
function foot(project, data, mayManage) {
  if (!data) return null;
  const q = state.queries;
  if (!mayManage) {
    return el('p', {
      class: 'field-hint',
      text: `Kept for ${data.window.retentionDays} days. Switching the recording off, or clearing it now, is a manager’s call.`,
    });
  }
  return el('div', { class: 'token-foot' }, [
    el('button', {
      type: 'button',
      class: data.logEnabled ? 'ghost small' : 'primary small',
      text: data.logEnabled ? 'Stop recording' : 'Start recording',
      onclick: () => void setRecording(project, !data.logEnabled),
    }),
    el('button', {
      type: 'button',
      class: `danger small${q.confirmPurge ? ' confirm' : ''}`,
      text: q.confirmPurge ? 'Confirm — delete every row' : 'Clear the log',
      onclick: () => (q.confirmPurge ? void purge(project) : askPurge()),
    }),
    el('span', {
      class: 'field-hint',
      text: `Rows older than ${data.window.retentionDays} days are deleted automatically. Neither the switch nor a clear reaches a database dump already taken.`,
    }),
  ]);
}

/**
 * The relevance floor the project's next search will be decided against — which is not necessarily the
 * floor of the figures above; the configuration line names that one — and, for a manager, a choice of
 * this project's own. A select and not a number box: app.js rebuilds the panel on every poll, and a
 * select survives that where a half-typed number would not.
 *
 * Choosing a value does not apply it. It asks the server what the value would have done to the searches
 * this window already holds — how many refused ones it would have answered and how many answered ones it
 * would have refused, with the questions behind them — and only the Apply button beside that price sends
 * the change. A floor is the one setting here that silently decides what agents are told.
 *
 * The presets span what eval/BASELINE.md measured across corpus shapes: the floor that falsely refuses
 * at most 1% of answerable questions runs from 0.773 on English prose to 0.811 on a product guide (the
 * floor that refuses none of them goes down to 0.738). A value set through the API outside them is kept
 * as an option of its own so it is never misread.
 */
const FLOOR_PRESETS = [0.84, 0.83, 0.82, 0.81, 0.8, 0.79, 0.78, 0.77, 0.76, 0.75];

/** The select's value for a project column: '' is "the server's default". */
const floorValue = (own) => (own === null ? '' : String(own));

function floorLine(project, data, mayManage) {
  if (!data || !data.scoreFloor) return null;
  const q = state.queries;
  const { project: own, instance, effective } = data.scoreFloor;
  const source =
    instance <= 0
      ? 'SEARCH_SCORE_FLOOR is 0 on this server, which turns every project’s floor off, this one’s included'
      : own === null
        ? 'this server’s default'
        : `set for this project; the server’s default is ${instance}`;
  const hint = el('span', {
    class: 'field-hint',
    text: `Current relevance floor: ${effective === 0 ? 'off' : effective} (${source}). Below it an agent is told “no good match” instead of the hits.`,
  });
  if (!mayManage) return el('div', { class: 'token-foot' }, [hint]);
  const values = new Set(FLOOR_PRESETS);
  if (own !== null && own > 0) values.add(own);
  const shown = q.floorPending === undefined ? floorValue(own) : floorValue(q.floorPending);
  const options = [
    el('option', { value: '', selected: shown === '' || undefined, text: `Server default (${instance})` }),
    ...[...values].sort((a, b) => b - a).map((v) => el('option', { value: String(v), selected: shown === String(v) || undefined, text: String(v) })),
    el('option', { value: '0', selected: shown === '0' || undefined, text: 'Off (0)' }),
  ];
  return el('div', { class: 'floor-change' }, [
    el('div', { class: 'token-foot' }, [
      el(
        'select',
        {
          'aria-label': `Relevance floor for ${project.name}`,
          onchange: (event) => {
            const floor = event.target.value === '' ? null : Number(event.target.value);
            if (floor === own) cancelFloor();
            else void previewFloor(project, floor);
          },
        },
        options,
      ),
      hint,
    ]),
    q.floorPending === undefined ? null : floorPrice(project, q.floorPending),
  ]);
}

/** What the chosen floor would have done to this window, and the only way to apply it. */
function floorPrice(project, floor) {
  const q = state.queries;
  const preview = q.floorPreview;
  const target = floor === null ? 'the server’s default' : floor === 0 ? 'off' : String(floor);
  const loading = !preview || preview.status === 'loading';
  const failed = preview?.status === 'error';
  const p = preview?.data;

  const parts = [];
  if (loading) parts.push(el('p', { class: 'field-hint', text: 'Reading what this floor would have done to the searches in this window…' }));
  else if (failed) parts.push(el('p', { class: 'field-hint warn', text: `The price could not be read: ${preview.error}` }));
  else {
    const change = (n) => `${fmt(n)} search${n === 1 ? '' : 'es'}`;
    parts.push(
      el('p', {
        class: 'field-hint',
        text:
          `Of the ${change(p.searches)} on this project that returned anything in the last ${p.window.days} day${p.window.days === 1 ? '' : 's'} ` +
          `(${p.configuration.embeddingModel}, generation ${p.configuration.liveGeneration}), a floor of ${p.proposed.effective === 0 ? 'off' : p.proposed.effective} ` +
          `instead of ${p.current.effective === 0 ? 'off' : p.current.effective} would have answered at most ${change(p.gained)} ` +
          `that were refused, and refused at most ${change(p.lost)} that were answered.`,
      }),
    );
    if (p.instanceOff) {
      parts.push(
        el('p', {
          class: 'field-hint warn',
          text: 'SEARCH_SCORE_FLOOR is 0 on this server, so every project’s floor is off: saving this changes nothing until the server’s floor is switched on.',
        }),
      );
    }
    parts.push(samples('Answered instead of refused', p.gainedSamples), samples('Refused instead of answered', p.lostSamples));
    parts.push(
      el('p', {
        class: 'field-hint',
        text:
          'Each count is an upper bound. The log keeps a search’s best score but not whether an identifier in it matched word for word, ' +
          'and such a search is answered whatever its score — so some searches counted here as refused were in fact answered.',
      }),
    );
  }
  return el('div', { class: 'floor-preview' }, [
    ...parts,
    el('div', { class: 'token-foot' }, [
      el('button', {
        type: 'button',
        class: 'primary small',
        text: failed ? `Set the floor to ${target} without a price` : `Set the floor to ${target}`,
        disabled: loading || undefined,
        onclick: () => void setFloor(project, floor),
      }),
      el('button', { type: 'button', class: 'ghost small', text: 'Cancel', onclick: cancelFloor }),
    ]),
  ]);
}

function samples(title, rows) {
  if (!rows || rows.length === 0) return null;
  return el('div', { class: 'floor-samples' }, [
    el('span', { class: 'field-hint', text: title }),
    el(
      'ul',
      {},
      rows.map((row) =>
        el('li', {}, [
          el('span', { text: row.query }),
          el('span', { class: 'mono field-hint', text: ` ×${fmt(row.asked)} · best ${score(row.topScore)}` }),
        ]),
      ),
    ),
  ]);
}

// ---------- actions ----------

function askPurge() {
  state.queries.confirmPurge = true;
  emit('render');
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => {
    state.queries.confirmPurge = false;
    emit('render');
  }, 4000);
}

async function setRecording(project, enabled) {
  try {
    await api(`/api/projects/${project.id}/query-log`, { method: 'PATCH', body: { enabled } });
    toast(enabled ? `${project.name} is recording searches again` : `${project.name} stopped recording searches`);
    await loadQuerySummary(true);
  } catch (err) {
    toast(err.message);
  }
}

/** Prices a floor against the window on screen; the newest choice wins a race between two. */
async function previewFloor(project, floor) {
  const q = state.queries;
  const search = new URLSearchParams({ floor: floor === null ? 'instance' : String(floor), days: String(q.days), actor: q.actor });
  const key = `${project.id}|${search}`;
  q.floorPending = floor;
  q.floorPreview = { key, status: 'loading', data: null, error: '' };
  emit('render');
  try {
    const data = await api(`/api/projects/${project.id}/score-floor/preview?${search}`);
    if (q.floorPreview?.key !== key) return; // chose again, or moved on, meanwhile
    q.floorPreview = { key, status: 'done', data, error: '' };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (q.floorPreview?.key !== key) return;
    q.floorPreview = { key, status: 'error', data: null, error: err.message };
  }
  emit('render');
}

function cancelFloor() {
  state.queries.floorPending = undefined;
  state.queries.floorPreview = null;
  emit('render');
}

async function setFloor(project, floor) {
  try {
    await api(`/api/projects/${project.id}/score-floor`, { method: 'PATCH', body: { floor } });
    state.queries.floorPending = undefined;
    state.queries.floorPreview = null;
    toast(floor === null ? `${project.name} uses the server’s relevance floor again` : `${project.name}’s relevance floor is now ${floor}`);
    await loadQuerySummary(true);
  } catch (err) {
    toast(err.message);
  }
}

async function purge(project) {
  state.queries.confirmPurge = false;
  try {
    const { deleted } = await api(`/api/projects/${project.id}/query-log`, { method: 'DELETE' });
    toast(`Deleted ${fmt(deleted)} logged search${deleted === 1 ? '' : 'es'} — dumps already taken still hold them`);
    await loadQuerySummary(true);
  } catch (err) {
    toast(err.message);
  }
}
