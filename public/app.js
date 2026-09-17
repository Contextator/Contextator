// Contextator admin dashboard — plain ES module, no build step.
// Master/detail layout: project list on the left, the selected project on the right.

const TOKEN_KEY = 'contextator_admin_token';
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 15000;
const ACTIVE_PHASES = new Set(['queued', 'scanning', 'embedding', 'finalizing']);

const TOOLS = [
  { name: 'search_docs', text: 'Cosine search over chunks. Returns ranked excerpts with path, heading breadcrumb and score.' },
  { name: 'list_topics', text: 'Every indexed document grouped by directory, with title and chunk count.' },
  { name: 'read_document', text: 'Full Markdown of one indexed file, capped at 512 KB.' },
];

const ICON = {
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>',
  refresh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
};

const SOURCE_GLYPH = { local: 'DIR', git: 'GIT', upload: 'UP', notion: 'NTN' };
const SOURCE_TITLE = { local: 'Local directory', git: 'Git repository', upload: 'Uploaded files', notion: 'Notion workspace' };

/**
 * Dialog tabs ("kinds") are not server-side types: an Obsidian vault is an upload source that carries
 * the `obsidian` flavor, so the tab picks both.
 */
const SOURCE_KINDS = {
  local: { type: 'local', title: 'Local directory', subtitle: 'A folder mounted on the server, scanned in place. Nothing is copied.' },
  git: { type: 'git', title: 'Git repository', subtitle: 'Cloned on the server and fetched at the start of every index run. A push webhook can trigger one.' },
  upload: { type: 'upload', title: 'Upload files', subtitle: 'Files, folders and archives are unpacked on the server and kept for this source.' },
  obsidian: { type: 'upload', flavor: 'obsidian', title: 'Obsidian vault', subtitle: 'An uploaded vault; [[wikilinks]] are rewritten to Markdown links.' },
  notion: { type: 'notion', title: 'Notion', subtitle: 'Pages shared with an internal integration are rendered to Markdown on every sync.' },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // static icon markup only, never user data
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
};
const icon = (name) => el('span', { class: 'icon-wrap', html: ICON[name], 'aria-hidden': 'true' });

const state = {
  token: safeStorage('get'),
  projects: [],
  health: null,
  selectedId: decodeURIComponent(location.hash.replace(/^#\/?/, '')) || null,
  runs: [], // index-run history of the selected project
  runsFor: null, // project id the runs belong to
  runsStamp: null, // finishedAt of the newest job seen; refetch when it changes
  sources: [], // document sources of the selected project
  sourcesFor: null,
  sourcesStamp: null,
  confirmDeleteSource: null,
  filter: '',
  connectTab: 0,
  confirmDelete: null,
  confirmTimer: null,
  timer: null,
  authFailed: false,
};

function safeStorage(op, value) {
  try {
    if (op === 'get') return localStorage.getItem(TOKEN_KEY) || '';
    if (op === 'set') localStorage.setItem(TOKEN_KEY, value);
    if (op === 'clear') localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode etc.) */
  }
  return '';
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    state.authFailed = Boolean(state.token);
    showAuth(true);
    throw new ApiError(401, { message: 'Admin token required' });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

// ---------- helpers ----------

const isActive = (p) => Boolean(p.job && ACTIVE_PHASES.has(p.job.phase)) || p.status === 'indexing';
const displayStatus = (p) => (p.job && p.job.phase === 'queued' ? 'queued' : isActive(p) ? 'indexing' : p.status);

function relativeTime(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

function jobDuration(job) {
  if (!job?.startedAt) return '';
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  return formatDuration(end - new Date(job.startedAt).getTime());
}

/** "126 unchanged · 2 updated · 0 removed · 41 chunks embedded" for a stored run. */
function runResult(run) {
  if (run.status === 'error') return `failed: ${run.error || 'unknown error'}`;
  return `${fmt(run.filesSkipped)} unchanged · ${fmt(run.filesUpdated)} updated · ${fmt(run.filesRemoved)} removed · ${fmt(run.chunksWritten)} chunks embedded`;
}

/** First line of an error, shortened for the project list. */
function shortError(message, max = 40) {
  const line = String(message || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const fmt = (n) => new Intl.NumberFormat().format(n ?? 0);

let toastTimer;
function toast(message) {
  let node = $('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Plain-http LAN origins have no navigator.clipboard.
      const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied');
  } catch {
    toast('Copy failed — select the text manually');
  }
}

function snippetsFor(project) {
  const url = project.mcpUrl;
  const id = `${project.name}-docs`;
  return [
    { tab: 'Claude Code', code: `claude mcp add --transport http ${id} ${url}` },
    { tab: 'Cursor', hint: '~/.cursor/mcp.json (global) or .cursor/mcp.json in the repo', code: JSON.stringify({ mcpServers: { [id]: { url } } }, null, 2) },
    {
      tab: 'Claude Desktop',
      hint: 'claude_desktop_config.json — via the mcp-remote stdio bridge',
      code: JSON.stringify({ mcpServers: { [id]: { command: 'npx', args: ['-y', 'mcp-remote', url] } } }, null, 2),
    },
    { tab: 'Legacy SSE', hint: 'GET opens the SSE stream; the server answers with the messages endpoint.', code: `${url}\n→ POST ${url}/messages?sessionId=…` },
  ];
}

function selectedProject() {
  return state.projects.find((p) => p.id === state.selectedId) ?? null;
}

function select(id) {
  state.selectedId = id;
  state.connectTab = 0;
  state.confirmDelete = null;
  state.confirmDeleteSource = null;
  const p = selectedProject();
  history.replaceState(null, '', p ? `#/${encodeURIComponent(p.name)}` : location.pathname);
  renderList();
  renderDetail();
  void loadRuns();
  void loadSources();
}

/** Fetches the selected project's run history when the selection or the newest job changes. */
async function loadRuns(force = false) {
  const p = selectedProject();
  if (!p) {
    state.runs = [];
    state.runsFor = null;
    return;
  }
  const stamp = p.job?.finishedAt ?? p.lastIndexedAt ?? null;
  if (!force && state.runsFor === p.id && state.runsStamp === stamp) return;
  state.runsFor = p.id;
  state.runsStamp = stamp;
  try {
    const { runs } = await api(`/api/projects/${p.id}/runs`);
    if (state.selectedId !== p.id) return; // selection moved on meanwhile
    state.runs = runs;
    renderDetail();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
  }
}

/** Fetches the selected project's sources; re-fetched while indexing so per-source status stays live. */
async function loadSources(force = false) {
  const p = selectedProject();
  if (!p) {
    state.sources = [];
    state.sourcesFor = null;
    return;
  }
  const stamp = `${p.sourceCount}:${p.lastIndexedAt ?? ''}:${p.job?.phase ?? ''}`;
  if (!force && state.sourcesFor === p.id && state.sourcesStamp === stamp) return;
  state.sourcesFor = p.id;
  state.sourcesStamp = stamp;
  try {
    const sources = await api(`/api/projects/${p.id}/sources`);
    if (state.selectedId !== p.id) return; // selection moved on meanwhile
    state.sources = sources;
    renderDetail();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
  }
}

// ---------- rendering ----------

function renderHealth() {
  const h = state.health;
  const node = $('#health');
  node.replaceChildren();
  if (!h) {
    node.append(el('span', { class: 'pill error', text: 'server unreachable' }));
    return;
  }
  const model = h.embeddings;
  node.append(
    el('span', { class: `pill ${h.db === 'up' ? 'idle' : 'error'}`, text: h.db === 'up' ? 'Database up' : 'Database down' }),
    el('span', { class: `pill ${model.ready ? 'idle' : 'loading'}`, text: model.ready ? 'Model ready' : 'Model loading' }),
    el('span', { class: 'chip mono', title: 'embedding provider · model · dimensions', text: `${model.provider} · ${model.model} · ${model.dimensions}d` }),
    el('span', { class: 'chip', title: 'open MCP sessions', text: `${h.sessions.total} open session${h.sessions.total === 1 ? '' : 's'}` }),
    el('span', { class: 'version', text: `v${h.version}` }),
  );
  $('#allowed-roots').textContent = (h.allowedDocRoots || []).join(', ');
  $('#version').textContent = `Contextator v${h.version}`;
  renderRootPrefix(h.allowedDocRoots || []);
}

/** The New-project directory field: a fixed prefix for one allowed root, a select for several. */
function renderRootPrefix(roots) {
  const prefix = $('#root-prefix');
  const select = $('#root-select');
  const current = select.value;
  select.replaceChildren(...roots.map((r) => el('option', { value: r, text: `${r.replace(/[\\/]+$/, '')}/` })));
  if (roots.includes(current)) select.value = current;
  if (roots.length > 1) {
    prefix.hidden = true;
    select.hidden = false;
  } else {
    prefix.hidden = false;
    select.hidden = true;
    prefix.textContent = roots[0] ? `${roots[0].replace(/[\\/]+$/, '')}/` : '/';
  }
}

function selectedRoot() {
  const roots = state.health?.allowedDocRoots || [];
  const root = roots.length > 1 ? $('#root-select').value : roots[0] || '';
  return root.replace(/[\\/]+$/, '');
}

function renderList() {
  const container = $('#project-list');
  container.replaceChildren();
  const active = state.projects.filter((p) => displayStatus(p) === 'indexing').length;
  $('#project-count').textContent = state.projects.length
    ? `${state.projects.length} project${state.projects.length === 1 ? '' : 's'}${active ? ` · ${active} indexing` : ''}`
    : '';

  const q = state.filter.trim().toLowerCase();
  const visible = q ? state.projects.filter((p) => p.name.includes(q) || (p.rootPath ?? '').toLowerCase().includes(q)) : state.projects;

  if (visible.length === 0) {
    container.append(el('p', { class: 'list-empty', text: state.projects.length ? 'No project matches the filter.' : 'No projects yet.' }));
    return;
  }

  for (const p of visible) {
    const status = displayStatus(p);
    const job = p.job;
    const meta =
      status === 'error'
        ? shortError(p.lastError || job?.error) || 'failed'
        : status === 'queued'
          ? job?.queue?.aheadProjectName
            ? `waiting for ${job.queue.aheadProjectName}`
            : 'next in queue'
          : status === 'indexing'
            ? `${fmt(p.documentCount)} docs`
            : `${fmt(p.documentCount)} docs · ${fmt(p.chunkCount)} chunks · ${relativeTime(p.lastIndexedAt)}`;
    const metaTitle = status === 'error' ? p.lastError || job?.error || '' : '';

    const row = el(
      'button',
      {
        type: 'button',
        class: `project-row${p.id === state.selectedId ? ' selected' : ''}`,
        'aria-current': p.id === state.selectedId ? 'true' : undefined,
        onclick: () => select(p.id),
      },
      [
        el('span', { class: 'row-top' }, [
          el('span', { class: `dot ${status}` }),
          el('span', { class: 'row-name', text: p.name }),
          el('span', { class: `pill small ${status}`, text: status }),
        ]),
        el('span', { class: 'row-bottom' }, [
          el('code', { text: `${fmt(p.sourceCount)} source${p.sourceCount === 1 ? '' : 's'}` }),
          el('span', { class: 'meta', text: meta, title: metaTitle || undefined }),
        ]),
      ],
    );

    if (status === 'indexing' && job) {
      const pct = job.filesTotal ? Math.round((job.filesDone / job.filesTotal) * 100) : null;
      row.append(
        el('span', { class: 'row-progress' }, [
          el('span', { class: `bar${pct === null ? ' indeterminate' : ''}` }, el('span', { style: pct === null ? '' : `width:${pct}%` })),
          el('span', { text: job.filesTotal ? `${job.phase} · ${job.filesDone}/${job.filesTotal} files · ${fmt(job.chunksDone)} chunks embedded` : `${job.phase}…` }),
        ]),
      );
    }
    container.append(row);
  }
}

function renderDetail() {
  const main = $('#detail');
  main.replaceChildren();
  const p = selectedProject();

  if (!p) {
    main.append(
      el('div', { class: 'empty-state' }, [
        el('h1', { text: state.projects.length ? 'Select a project' : 'No projects yet' }),
        el('p', {
          text: state.projects.length
            ? 'Pick a project on the left to see its status and connection snippets.'
            : 'Point Contextator at a folder of Markdown files. Every project becomes its own MCP endpoint that agents can search.',
        }),
        state.projects.length ? null : el('button', { type: 'button', class: 'primary', onclick: openCreate }, [icon('plus'), 'New project']),
      ]),
    );
    return;
  }

  const status = displayStatus(p);
  const busy = isActive(p);
  const job = p.job;
  const confirming = state.confirmDelete === p.id;
  // `embeddingModel` on a project is the provider-qualified id (e.g. `local:<model>:fp32`), compared with health's `id`.
  const modelMismatch = Boolean(p.embeddingModel && state.health?.embeddings.id && p.embeddingModel !== state.health.embeddings.id);

  // Header
  main.append(
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-title' }, [
        el('div', { class: 'title-row' }, [el('h1', { text: p.name }), el('span', { class: `pill ${status}`, text: status })]),
        el('div', { class: 'url-row' }, [
          el('code', { class: 'url', text: p.mcpUrl }),
          el('button', { type: 'button', class: 'icon', 'aria-label': 'Copy MCP URL', title: 'Copy MCP URL', onclick: () => copyText(p.mcpUrl) }, icon('copy')),
          el('code', { class: 'path', text: sourceSummary(p), title: sourceSummary(p) }),
        ]),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', { type: 'button', class: 'primary', disabled: busy, onclick: () => reindex(p, false) }, [icon('refresh'), busy ? 'Indexing…' : 'Re-index']),
        el('button', { type: 'button', class: 'ghost', disabled: busy, title: 'Drop and rebuild every chunk', onclick: () => reindex(p, true), text: 'Force re-index' }),
        el(
          'button',
          {
            type: 'button',
            class: `danger${confirming ? ' confirm' : ''}`,
            disabled: busy,
            onclick: () => (confirming ? remove(p) : askDelete(p)),
          },
          confirming ? ['Confirm delete'] : [icon('trash'), 'Delete'],
        ),
      ]),
    ]),
  );

  // Live job / error callouts
  if (busy && job) {
    const pct = job.filesTotal ? Math.round((job.filesDone / job.filesTotal) * 100) : null;
    main.append(
      el('div', { class: 'callout warn' }, [
        el('span', { class: 'callout-title', text: job.phase === 'queued' ? 'Queued — waiting for the indexer' : `${capitalize(job.phase)}${job.force ? ' (full re-index)' : ''}` }),
        el('span', { class: `bar${pct === null ? ' indeterminate' : ''}` }, el('span', { style: pct === null ? '' : `width:${pct}%` })),
        el('span', {
          text: job.filesTotal
            ? `${job.filesDone}/${job.filesTotal} files · ${job.filesSkipped} unchanged · ${fmt(job.chunksDone)} chunks embedded · ${jobDuration(job)}`
            : 'Scanning the directory…',
        }),
      ]),
    );
  }
  if (status === 'error' && (p.lastError || job?.error)) {
    main.append(el('div', { class: 'callout error' }, [el('span', { class: 'callout-title', text: 'Last index run failed' }), el('pre', { text: p.lastError || job.error })]));
  }
  if (modelMismatch) {
    main.append(
      el('div', { class: 'callout warn' }, [
        el('span', { class: 'callout-title', text: 'Indexed with a different embedding model' }),
        el('span', { text: `Chunks were embedded with ${p.embeddingModel}; the server now runs ${state.health.embeddings.id}. Re-index before searching.` }),
      ]),
    );
  }

  // Stat tiles
  const runs = state.runsFor === p.id ? state.runs : [];
  const lastDone = runs.find((r) => r.status === 'done');
  const lastRun = lastDone
    ? `${fmt(lastDone.filesSkipped)} unchanged · ${fmt(lastDone.filesUpdated)} updated${lastDone.filesRemoved ? ` · ${fmt(lastDone.filesRemoved)} removed` : ''}`
    : job && job.phase === 'done'
      ? `${job.filesSkipped} unchanged · ${job.filesTotal - job.filesSkipped} updated`
      : '';
  const emb = state.health?.embeddings;
  // Show the plain model name while the project matches the server; the raw stored id only on a mismatch.
  const model = !p.embeddingModel || !modelMismatch ? emb?.model || p.embeddingModel || '—' : p.embeddingModel;
  const modelSub = emb ? [emb.provider, emb.dtype, `${emb.dimensions} dimensions`].filter(Boolean).join(' · ') : '';
  main.append(
    el('div', { class: 'stats' }, [
      stat('Documents', fmt(p.documentCount), `across ${fmt(p.sourceCount)} source${p.sourceCount === 1 ? '' : 's'}`),
      stat('Chunks', fmt(p.chunkCount), 'embedded, HNSW cosine index'),
      stat('Last indexed', relativeTime(p.lastIndexedAt), lastRun || (p.lastIndexedAt ? new Date(p.lastIndexedAt).toLocaleString() : 'never indexed'), p.lastIndexedAt),
      stat('Embedding model', model, modelSub, null, true, modelMismatch),
    ]),
  );

  main.append(renderSources(p, busy));

  // Connect + tools
  const snippets = snippetsFor(p);
  const current = snippets[Math.min(state.connectTab, snippets.length - 1)];
  main.append(
    el('div', { class: 'two-col' }, [
      el('section', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('h3', { text: 'Connect an agent' }),
          el('p', { text: 'One URL serves both Streamable HTTP and legacy SSE. Newer clients pick Streamable HTTP automatically.' }),
        ]),
        el(
          'div',
          { class: 'tabs', role: 'tablist' },
          snippets.map((s, i) =>
            el('button', {
              type: 'button',
              class: 'tab',
              role: 'tab',
              'aria-selected': i === state.connectTab ? 'true' : 'false',
              text: s.tab,
              onclick: () => {
                state.connectTab = i;
                renderDetail();
              },
            }),
          ),
        ),
        el('div', { class: 'panel-body', role: 'tabpanel' }, [
          current.hint ? el('p', { class: 'hint', text: current.hint }) : null,
          el('div', { class: 'snippet' }, [
            el('pre', { text: current.code }),
            el('button', { type: 'button', class: 'copy', 'aria-label': `Copy ${current.tab} snippet`, onclick: () => copyText(current.code) }, [icon('copy'), 'Copy']),
          ]),
          el('p', { class: 'hint' }, [
            'Then ask the agent to search this project. It receives the MCP instructions describing ',
            el('code', { text: p.name }),
            ' and picks the right tool on its own.',
          ]),
        ]),
      ]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('h3', { text: 'Tools exposed to the agent' }),
          el('p', { text: 'Every project publishes the same three tools, scoped to its own chunks.' }),
        ]),
        el(
          'div',
          { class: 'panel-body' },
          el(
            'div',
            { class: 'tool-list' },
            TOOLS.map((t) => el('div', { class: 'tool' }, [el('code', { text: t.name }), el('span', { text: t.text })])),
          ),
        ),
      ]),
    ]),
  );

  // Index runs (persisted history, newest first)
  main.append(
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('h3', { text: 'Index runs' }), el('p', { text: 'Incremental: unchanged files are skipped by sha256.' })]),
      el('div', { class: 'panel-body' }, [
        runs.length === 0
          ? el('p', { class: 'runs-empty', text: busy ? 'The first run is in progress.' : 'No runs yet. Press Re-index to build the index.' })
          : el('div', { class: 'run-grid head' }, [el('span', { text: 'When' }), el('span', { text: 'Mode' }), el('span', { text: 'Result' }), el('span', { class: 'right', text: 'Duration' })]),
        ...runs.map((r) =>
          el('div', { class: 'run-grid' }, [
            el('span', { title: new Date(r.finishedAt).toLocaleString(), text: relativeTime(r.finishedAt) }),
            el('span', { text: r.mode }),
            el('span', { class: `result${r.status === 'error' ? ' err' : ''}`, text: runResult(r) }),
            el('span', { class: 'right', text: formatDuration(r.durationMs) }),
          ]),
        ),
      ]),
    ]),
  );
}

/** "docs, handbook" for the detail header, falling back to the plain count. */
function sourceSummary(p) {
  const mine = state.sourcesFor === p.id ? state.sources : [];
  if (mine.length) return mine.map((s) => s.name).join(', ');
  return `${fmt(p.sourceCount)} source${p.sourceCount === 1 ? '' : 's'}`;
}

/** One line per source: where it comes from, how many documents it contributed, when it last synced. */
function renderSources(project, busy) {
  const sources = state.sourcesFor === project.id ? state.sources : [];
  const rows = sources.map((s) => {
    const confirming = state.confirmDeleteSource === s.id;
    const failed = s.status === 'error';
    const actions = [
      s.type === 'git' || s.type === 'notion'
        ? el('button', { type: 'button', class: 'ghost small', title: 'Check the connection without indexing', text: 'Test', onclick: () => testSource(project, s) })
        : null,
      el('button', { type: 'button', class: 'ghost small', disabled: busy, title: 'Sync this source and re-index the project', text: 'Sync', onclick: () => syncSource(project, s) }),
      el('button', { type: 'button', class: 'ghost small', text: s.type === 'upload' ? 'Files' : 'Edit', onclick: () => openSourceDialog(project, s) }),
      el('button', {
        type: 'button',
        class: `danger small${confirming ? ' confirm' : ''}`,
        disabled: busy,
        text: confirming ? 'Confirm' : 'Delete',
        onclick: () => (confirming ? removeSource(project, s) : askDeleteSource(s)),
      }),
    ];
    return el('div', { class: 'source-row' }, [
      el('span', { class: `source-glyph ${failed ? 'error' : s.type}`, text: SOURCE_GLYPH[s.type] ?? '?' }),
      el('span', { class: 'source-cell' }, [el('code', { text: s.name }), el('span', { class: 'sub', text: s.label || SOURCE_TITLE[s.type] || s.type })]),
      el('span', { class: 'source-cell' }, [
        el('code', { text: sourceOrigin(s), title: sourceOrigin(s) }),
        el('span', { class: `sub${failed ? ' err' : ''}`, text: failed ? shortError(s.lastError, 80) : sourceDetail(s), title: failed ? s.lastError || '' : '' }),
      ]),
      el('span', { class: 'sub', text: s.flavor === 'plain' ? '—' : s.flavor, title: 'Content type' }),
      el('span', { class: 'sub', text: `${fmt(s.documentCount)} docs` }),
      el('span', { class: 'sub', text: relativeTime(s.lastSyncedAt), title: s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'never synced' }),
      el('span', { class: 'source-actions' }, actions),
    ]);
  });

  return el('section', { class: 'panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Document sources' }),
        el('p', { text: 'Every source is mounted under its own name; a document\u2019s path is <source>/<path inside it>. All of them are synced at the start of an index run.' }),
      ]),
      el('button', { type: 'button', class: 'primary small', onclick: () => openSourceDialog(project, null) }, [icon('plus'), 'Add source']),
    ]),
    rows.length
      ? el('div', {}, rows)
      : el('p', { class: 'sources-empty', text: 'No sources yet. Add a local directory, a git repository, an upload or a Notion workspace to give this project something to index.' }),
  ]);
}

/** The identifying string of a source: path, repository URL, or the mount prefix. */
function sourceOrigin(s) {
  const c = s.config || {};
  if (s.type === 'local') return c.path || '—';
  if (s.type === 'git') return c.url || '—';
  if (s.type === 'notion') return (c.rootIds || []).length ? `${c.rootIds.length} root page(s)` : 'everything shared with the integration';
  return `${s.name}/`;
}

/** The second line: branch/subdir for git, extensions otherwise. */
function sourceDetail(s) {
  const c = s.config || {};
  const ext = (c.extensions || []).map((e) => `.${e}`).join(' ');
  if (s.type === 'git') {
    const at = c.lastCommit ? ` @ ${String(c.lastCommit).slice(0, 7)}` : '';
    return `${c.branch || 'main'}${c.subdir ? `/${c.subdir}` : ''}${at}${ext ? ` \u00b7 ${ext}` : ''}`;
  }
  return ext || '—';
}

function stat(label, value, sub, title, mono = false, warn = false) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'label', text: label }),
    el('span', { class: `value${mono ? ' mono' : ''}`, text: value, title: title || undefined }),
    sub ? el('span', { class: `sub${warn ? ' warn' : ''}`, text: sub }) : null,
  ]);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function showAuth(show) {
  const gate = $('#auth-gate');
  gate.hidden = !show;
  if (show) {
    const err = $('#auth-error');
    err.hidden = !state.authFailed;
    err.textContent = state.authFailed ? 'That token was rejected. Check ADMIN_TOKEN on the server.' : '';
    $('#auth-token').focus();
  }
}

// ---------- actions ----------

async function refresh() {
  // Health is exempt from ADMIN_TOKEN, so the top bar stays live even while the token gate is shown.
  const [healthRes, projectsRes] = await Promise.allSettled([api('/api/health'), api('/api/projects')]);
  state.health = healthRes.status === 'fulfilled' ? healthRes.value : null;
  renderHealth();

  if (projectsRes.status === 'fulfilled') {
    state.projects = projectsRes.value;
    state.authFailed = false;
    showAuth(false);
    if (!state.projects.some((p) => p.id === state.selectedId)) {
      // A hash may carry the project *name* on first load; otherwise fall back to the first project.
      const byName = state.projects.find((p) => p.name === state.selectedId);
      state.selectedId = byName?.id ?? state.projects[0]?.id ?? null;
      const p = selectedProject();
      if (p) history.replaceState(null, '', `#/${encodeURIComponent(p.name)}`);
    }
    renderList();
    renderDetail();
    void loadRuns();
    void loadSources();
  }
  schedule();
}

function schedule() {
  clearTimeout(state.timer);
  const active = state.projects.some(isActive);
  const modelLoading = state.health && !state.health.embeddings.ready;
  state.timer = setTimeout(refresh, active || modelLoading ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

async function reindex(project, force) {
  try {
    await api(`/api/projects/${project.id}/reindex?force=${force}`, { method: 'POST' });
    toast(force ? `Full re-index queued for ${project.name}` : `Re-index queued for ${project.name}`);
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

function askDelete(project) {
  state.confirmDelete = project.id;
  renderDetail();
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => {
    if (state.confirmDelete === project.id) {
      state.confirmDelete = null;
      renderDetail();
    }
  }, 6000);
}

async function remove(project) {
  state.confirmDelete = null;
  try {
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    toast(`Deleted ${project.name}`);
    state.selectedId = null;
    await refresh();
  } catch (err) {
    toast(err.message);
    renderDetail();
  }
}

// ---------- create dialog ----------

const dialog = $('#create-dialog');
const createForm = $('#create-form');

function openCreate() {
  $('#create-error').hidden = true;
  createForm.reset();
  createForm.elements.index.checked = true;
  updateUrlPreview();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  createForm.elements.name.focus();
}

function closeCreate() {
  if (dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function updateUrlPreview() {
  const base = state.projects[0]?.mcpUrl.replace(/\/mcp\/.*$/, '') ?? location.origin;
  const name = createForm.elements.name.value.trim() || 'my-docs';
  $('#url-preview').textContent = `${base}/mcp/${name}`;
}

createForm.elements.name.addEventListener('input', updateUrlPreview);
$('#create-cancel').addEventListener('click', closeCreate);
$('#new-btn').addEventListener('click', openCreate);

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = $('#create-error');
  errorNode.hidden = true;
  if (!createForm.reportValidity()) return;
  const data = new FormData(createForm);
  const btn = $('#create-btn');
  btn.disabled = true;
  try {
    const relative = String(data.get('rootRelative'))
      .trim()
      .replace(/^[\\/]+/, '');
    const root = selectedRoot();
    const created = await api('/api/projects', {
      method: 'POST',
      body: { name: String(data.get('name')).trim(), rootPath: root ? `${root}/${relative}` : relative, index: data.get('index') === 'on' },
    });
    closeCreate();
    toast(`Project ${created.name} created`);
    state.selectedId = created.id;
    await refresh();
  } catch (err) {
    errorNode.textContent = err.message;
    errorNode.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- source actions ----------

function askDeleteSource(source) {
  state.confirmDeleteSource = source.id;
  renderDetail();
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => {
    if (state.confirmDeleteSource === source.id) {
      state.confirmDeleteSource = null;
      renderDetail();
    }
  }, 6000);
}

async function removeSource(project, source) {
  state.confirmDeleteSource = null;
  try {
    await api(`/api/projects/${project.id}/sources/${source.id}`, { method: 'DELETE' });
    toast(`Removed ${source.name}`);
    await refresh();
    await loadSources(true);
  } catch (err) {
    toast(err.message);
    renderDetail();
  }
}

async function syncSource(project, source) {
  try {
    await api(`/api/projects/${project.id}/sources/${source.id}/sync`, { method: 'POST' });
    toast(`Sync queued for ${source.name}`);
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

/** The server answers 200 with `{ ok, message }` either way, so both outcomes land in the same toast. */
async function testSource(project, source) {
  toast(`Testing ${source.name}…`);
  try {
    const result = await api(`/api/projects/${project.id}/sources/${source.id}/test`, { method: 'POST' });
    toast(result.message);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- source dialog ----------

const srcDialog = $('#source-dialog');
const srcForm = $('#source-form');
const srcTabs = [...$('#source-tabs').querySelectorAll('[data-kind]')];
const SECRET_HINT_HTML = $('#secret-hint').innerHTML;
const QUEUE_LABEL = { queued: 'queued', busy: 'uploading…', ok: 'uploaded', skip: 'skipped', fail: 'failed' };
const ARCHIVE_RE = /\.(zip|tar|tgz|tar\.gz|rar)$/i;

const srcUi = { kind: 'local', project: null, editing: null, queue: [], existingFiles: [], busy: false };

const kindOfSource = (s) => (s.type === 'upload' && s.flavor === 'obsidian' ? 'obsidian' : s.type);
const isUploadKind = (kind) => SOURCE_KINDS[kind].type === 'upload';
const uploadMode = () => srcForm.elements.mode.value;
const allowedRoots = () => state.health?.allowedDocRoots || [];

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Mirrors the New-project directory field: fixed prefix for one allowed root, a select for several. */
function renderSrcRootPrefix() {
  const roots = allowedRoots();
  const prefix = $('#src-root-prefix');
  const select = $('#src-root-select');
  const current = select.value;
  select.replaceChildren(...roots.map((r) => el('option', { value: r, text: `${r.replace(/[\\/]+$/, '')}/` })));
  if (roots.includes(current)) select.value = current;
  prefix.hidden = roots.length > 1;
  select.hidden = roots.length <= 1;
  if (roots.length <= 1) prefix.textContent = roots[0] ? `${roots[0].replace(/[\\/]+$/, '')}/` : '/';
}

function srcSelectedRoot() {
  const roots = allowedRoots();
  const root = roots.length > 1 ? $('#src-root-select').value : roots[0] || '';
  return root.replace(/[\\/]+$/, '');
}

/** Splits a stored absolute path back into (allowed root, remainder) so the prefixed field can show it. */
function splitRoot(absolute) {
  const full = String(absolute || '').replace(/\\/g, '/');
  for (const root of allowedRoots()) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (full === r) return { root, rest: '' };
    if (full.startsWith(`${r}/`)) return { root, rest: full.slice(r.length + 1) };
  }
  return { root: allowedRoots()[0] || '', rest: full };
}

function setKind(kind) {
  srcUi.kind = kind;
  const meta = SOURCE_KINDS[kind];
  const editing = srcUi.editing;
  for (const tab of srcTabs) tab.setAttribute('aria-selected', tab.dataset.kind === kind ? 'true' : 'false');
  for (const box of srcForm.querySelectorAll('.kind-only')) box.hidden = !box.dataset.kind.split(' ').includes(kind);
  $('#source-title').textContent = editing ? `${meta.title} — ${editing.name}` : `Add source — ${meta.title}`;
  $('#source-subtitle').textContent = meta.subtitle;
  if (meta.flavor) srcForm.elements.flavor.value = meta.flavor;
  srcForm.elements.flavor.disabled = Boolean(meta.flavor);
  $('#upload-mode-row').hidden = !(isUploadKind(kind) && editing);
  $('#index-label').textContent = isUploadKind(kind) ? 'Index after upload' : 'Index now';
  $('#source-test').hidden = !(editing && (meta.type === 'git' || meta.type === 'notion'));
  $('#webhook-box').hidden = !(editing && meta.type === 'git');
  $('#source-submit').textContent = editing ? 'Save changes' : 'Add source';
  renderQueue();
}

function openSourceDialog(project, source) {
  srcUi.project = project;
  srcUi.editing = source;
  srcUi.queue = [];
  srcUi.existingFiles = [];
  srcUi.busy = false;
  $('#source-error').hidden = true;
  srcForm.reset();
  srcForm.elements.secret.placeholder = 'leave empty for public repositories';
  srcForm.elements.notionSecret.placeholder = 'ntn_… / secret_…';
  $('#secret-hint').innerHTML = SECRET_HINT_HTML; // static markup restored, never user data
  renderSrcRootPrefix();

  // Type and name are the mount prefix of every document path, so neither can change after creation.
  for (const tab of srcTabs) tab.disabled = Boolean(source);
  srcForm.elements.name.disabled = Boolean(source);
  srcForm.elements.index.checked = true;
  if (source) fillSourceForm(source);
  setKind(source ? kindOfSource(source) : 'local');

  if (typeof srcDialog.showModal === 'function') srcDialog.showModal();
  else srcDialog.setAttribute('open', '');
  (source ? srcForm.elements.label : srcForm.elements.name).focus();

  if (source?.type === 'git') renderWebhook(project, source);
  if (source?.type === 'upload') void loadSourceFiles(project, source);
}

function closeSourceDialog() {
  if (srcDialog.open) srcDialog.close();
  else srcDialog.removeAttribute('open');
}

function fillSourceForm(s) {
  const c = s.config || {};
  srcForm.elements.name.value = s.name;
  srcForm.elements.label.value = s.label || '';
  srcForm.elements.flavor.value = s.flavor || 'plain';
  for (const box of srcForm.querySelectorAll('input[name="ext"]')) box.checked = (c.extensions || []).includes(box.value);
  if (s.type === 'local') {
    const { root, rest } = splitRoot(c.path);
    const select = $('#src-root-select');
    if ([...select.options].some((o) => o.value === root)) select.value = root;
    $('#src-path').value = rest;
  }
  if (s.type === 'git') {
    srcForm.elements.url.value = c.url || '';
    srcForm.elements.branch.value = c.branch || 'main';
    srcForm.elements.subdir.value = c.subdir || '';
    srcForm.elements.username.value = c.username || '';
    if (s.hasSecret) {
      srcForm.elements.secret.placeholder = 'unchanged — type to replace';
      $('#secret-hint').textContent = 'A token is stored for this source. Leave the field empty to keep it.';
    }
  }
  if (s.type === 'notion') {
    srcForm.elements.rootIds.value = (c.rootIds || []).join('\n');
    if (s.hasSecret) srcForm.elements.notionSecret.placeholder = 'unchanged — type to replace';
  }
  updateProviderHint();
}

function updateProviderHint() {
  const node = $('#git-provider');
  const url = srcForm.elements.url.value.trim();
  if (!url) {
    node.textContent = '';
    return;
  }
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    node.textContent = 'Not a valid URL yet.';
    return;
  }
  const provider = host.includes('github')
    ? 'GitHub'
    : host.includes('gitlab')
      ? 'GitLab'
      : host.includes('bitbucket')
        ? 'Bitbucket'
        : host.includes('gitea') || host.includes('codeberg') || host.includes('forgejo')
          ? 'Gitea/Forgejo'
          : 'a generic git server';
  node.textContent = `Detected: ${provider}.`;
}

function renderWebhook(project, source) {
  const url = `${location.origin}/api/webhooks/git/${source.id}`;
  $('#webhook-url').textContent = url;
  $('#webhook-copy-url').onclick = () => copyText(url);
  $('#webhook-copy-secret').onclick = () => (source.webhookSecret ? copyText(source.webhookSecret) : toast('This source has no webhook secret'));
  $('#webhook-regenerate').onclick = async () => {
    try {
      const updated = await api(`/api/projects/${project.id}/sources/${source.id}/webhook-secret`, { method: 'POST' });
      srcUi.editing = updated;
      renderWebhook(project, updated);
      toast('New secret generated — update it in the repository settings');
      await loadSources(true);
    } catch (err) {
      toast(err.message);
    }
  };
}

const extensionsFromForm = () => [...srcForm.querySelectorAll('input[name="ext"]:checked')].map((b) => b.value);

const NOTION_ID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/** Accepts ids or pasted page URLs, one per line. */
function parseNotionIds(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.match(NOTION_ID_RE) ?? [line])[0])
    .slice(0, 50);
}

function configForKind(kind) {
  const { type } = SOURCE_KINDS[kind];
  const extensions = extensionsFromForm();
  if (extensions.length === 0) throw new Error('Pick at least one file type');
  if (type === 'local') {
    const rest = $('#src-path').value.trim().replace(/^[\\/]+/, '');
    const root = srcSelectedRoot();
    const path = root ? `${root}/${rest}` : rest;
    if (!path) throw new Error('A directory is required');
    return { path, extensions };
  }
  if (type === 'git') {
    const url = srcForm.elements.url.value.trim();
    if (!url) throw new Error('A repository URL is required');
    return {
      url,
      branch: srcForm.elements.branch.value.trim() || 'main',
      subdir: srcForm.elements.subdir.value.trim().replace(/^[\\/]+|[\\/]+$/g, ''),
      username: srcForm.elements.username.value.trim(),
      extensions,
    };
  }
  if (type === 'notion') {
    const ids = parseNotionIds(srcForm.elements.rootIds.value);
    return { rootIds: ids, extensions };
  }
  return { extensions };
}

function secretForKind(kind) {
  const { type } = SOURCE_KINDS[kind];
  if (type === 'git') return srcForm.elements.secret.value.trim();
  if (type === 'notion') return srcForm.elements.notionSecret.value.trim();
  return '';
}

// ---------- upload queue ----------

function acceptedName(name) {
  if (ARCHIVE_RE.test(name)) return true;
  return extensionsFromForm().includes(name.split('.').pop().toLowerCase());
}

function addFiles(entries) {
  const seen = new Set(srcUi.queue.map((i) => i.path));
  for (const entry of entries) {
    const path = entry.path.replace(/^[\\/]+/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    srcUi.queue.push({ path, file: entry.file, status: acceptedName(path) ? 'queued' : 'skip' });
  }
  renderQueue();
}

/** Dropped folders arrive as directory entries; walk them so the tree keeps its structure. */
async function entriesFromDataTransfer(dt) {
  const roots = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (roots.length === 0) return [...dt.files].map((f) => ({ path: f.name, file: f }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ path: prefix + entry.name, file });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    } while (batch.length > 0);
  };
  for (const root of roots) await walk(root, '');
  return out;
}

function renderQueue(note) {
  const queued = srcUi.queue.filter((i) => i.status === 'queued').length;
  const settled = srcUi.queue.filter((i) => i.status === 'ok' || i.status === 'skip').length;
  const skipped = srcUi.queue.filter((i) => i.status === 'skip').length;
  const bytes = srcUi.queue.reduce((n, i) => n + (i.file?.size || 0), 0);

  $('#upload-queue').hidden = srcUi.queue.length === 0 && srcUi.existingFiles.length === 0;
  $('#upload-summary').textContent = srcUi.queue.length
    ? `${fmt(srcUi.queue.length)} file${srcUi.queue.length === 1 ? '' : 's'} selected · ${formatBytes(bytes)}`
    : `${fmt(srcUi.existingFiles.length)} file${srcUi.existingFiles.length === 1 ? '' : 's'} in this source`;
  $('#upload-detail').textContent = note ?? (skipped ? `${skipped} skipped — unsupported file type` : '');
  $('#upload-bar').style.width = `${srcUi.queue.length ? Math.round((settled / srcUi.queue.length) * 100) : 0}%`;
  $('#upload-list').replaceChildren(
    ...srcUi.queue.map((i) => el('div', {}, [el('span', { text: i.path, title: i.path }), el('span', { class: i.status === 'queued' ? '' : i.status, text: QUEUE_LABEL[i.status] })])),
    ...srcUi.existingFiles.map((f) => el('div', {}, [el('span', { text: f.path, title: f.path }), el('span', { class: 'ok', text: formatBytes(f.sizeBytes) })])),
  );

  // Committing an upload always queues an index run, so the checkbox cannot say otherwise.
  const forced = isUploadKind(srcUi.kind) && queued > 0;
  srcForm.elements.index.disabled = forced;
  if (forced) srcForm.elements.index.checked = true;
}

async function loadSourceFiles(project, source) {
  try {
    const { files } = await api(`/api/projects/${project.id}/sources/${source.id}/files`);
    if (srcUi.editing?.id !== source.id) return; // dialog moved on meanwhile
    srcUi.existingFiles = files;
    renderQueue();
  } catch {
    /* a source that was never committed has no directory yet */
  }
}

/** Multipart sibling of api(): FormData sets its own content-type boundary. */
async function postForm(path, form) {
  const headers = { accept: 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method: 'POST', headers, body: form });
  if (res.status === 401) {
    state.authFailed = Boolean(state.token);
    showAuth(true);
    throw new ApiError(401, { message: 'Admin token required' });
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

/**
 * Uploads the queue into a staging session and commits it. Files go up in batches so a folder of
 * thousands stays inside the server's per-request limits; archives large enough to matter go alone.
 * Returns the per-file failures the server reported; they do not fail the upload as a whole.
 */
async function runUpload(project, source, mode) {
  const items = srcUi.queue.filter((i) => i.status === 'queued');
  const total = items.length;
  const maxFiles = Math.max(1, Math.min(state.health?.uploads?.maxFilesPerRequest ?? 500, 40));
  const maxBytes = 16 * 1024 * 1024;
  const { session } = await api(`/api/projects/${project.id}/sources/${source.id}/uploads`, { method: 'POST' });
  const rejected = [];
  let done = 0;
  let batch = [];
  let bytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const form = new FormData();
    for (const item of batch) {
      item.status = 'busy';
      form.append('files', item.file, item.path); // preservePath: the server reads the path from `filename`
    }
    renderQueue(`Uploading ${done + batch.length}/${total}…`);
    let result;
    try {
      result = await postForm(`/api/projects/${project.id}/sources/${source.id}/uploads/${session}/files`, form);
    } catch (err) {
      for (const item of batch) item.status = 'fail';
      renderQueue();
      throw err;
    }
    // The server reports per-file failures (a corrupt archive, a rejected name) without failing the
    // request, so mark those rows instead of leaving them green behind a toast that scrolls past.
    const sent = batch;
    const failures = result?.errors ?? [];
    rejected.push(...failures);
    for (const item of sent) item.status = failures.some((line) => line.startsWith(`${item.path}: `)) ? 'fail' : 'ok';
    done += sent.length;
    batch = [];
    bytes = 0;
    renderQueue(failures.length ? `${done}/${total} · ${failures.length} failed` : `Uploaded ${done}/${total}`);
    for (const line of failures) toast(line);
  };

  try {
    for (const item of items) {
      const alone = item.file.size > maxBytes;
      if (batch.length >= maxFiles || bytes + item.file.size > maxBytes || (alone && batch.length > 0)) await flush();
      batch.push(item);
      bytes += item.file.size;
      if (alone) await flush();
    }
    await flush();
    const { files } = await api(`/api/projects/${project.id}/sources/${source.id}/uploads/${session}/commit?mode=${mode}`, { method: 'POST' });
    toast(`${fmt(files)} file${files === 1 ? '' : 's'} imported — indexing queued`);
    return rejected;
  } catch (err) {
    await api(`/api/projects/${project.id}/sources/${source.id}/uploads/${session}`, { method: 'DELETE' }).catch(() => undefined);
    throw err;
  }
}

// ---------- source dialog wiring ----------

for (const tab of srcTabs) tab.addEventListener('click', () => setKind(tab.dataset.kind));
srcForm.elements.url.addEventListener('input', updateProviderHint);
for (const box of srcForm.querySelectorAll('input[name="ext"]')) box.addEventListener('change', () => renderQueue());
$('#source-cancel').addEventListener('click', closeSourceDialog);
srcDialog.addEventListener('close', () => {
  srcUi.queue = [];
  srcUi.existingFiles = [];
});

$('#source-test').addEventListener('click', () => {
  if (srcUi.editing) void testSource(srcUi.project, srcUi.editing);
});

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('active');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('active'));
dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropzone.classList.remove('active');
  addFiles(await entriesFromDataTransfer(event.dataTransfer));
});
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('#file-files').click();
  }
});
$('#pick-folder').addEventListener('click', () => $('#file-folder').click());
$('#pick-files').addEventListener('click', () => $('#file-files').click());
for (const input of [$('#file-folder'), $('#file-files')]) {
  input.addEventListener('change', () => {
    addFiles([...input.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
    input.value = ''; // so picking the same folder twice fires `change` again
  });
}

srcForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (srcUi.busy) return;
  const errorNode = $('#source-error');
  const submit = $('#source-submit');
  const project = srcUi.project;
  const editing = srcUi.editing;
  const kind = srcUi.kind;
  const meta = SOURCE_KINDS[kind];
  errorNode.hidden = true;
  srcUi.busy = true;
  submit.disabled = true;
  try {
    const config = configForKind(kind);
    const secret = secretForKind(kind);
    const flavor = meta.flavor ?? srcForm.elements.flavor.value;
    const label = srcForm.elements.label.value.trim();
    const pending = srcUi.queue.filter((i) => i.status === 'queued').length;
    let source;

    if (editing) {
      source = await api(`/api/projects/${project.id}/sources/${editing.id}`, {
        method: 'PATCH',
        body: { label, flavor, config, ...(secret ? { secret } : {}) },
      });
    } else {
      const name = srcForm.elements.name.value.trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
        throw new Error('Source name must be 1-63 characters of lowercase letters, digits, "-" or "_", starting with a letter or digit');
      }
      source = await api(`/api/projects/${project.id}/sources`, {
        method: 'POST',
        body: {
          type: meta.type,
          name,
          label,
          flavor,
          config,
          ...(secret ? { secret } : {}),
          // An upload commits (and indexes) right after creation; don't queue a run over an empty source.
          index: pending === 0 && srcForm.elements.index.checked,
        },
      });
    }

    const rejected = pending > 0 ? await runUpload(project, source, editing ? uploadMode() : 'add') : [];
    if (rejected.length > 0) {
      // The source and the files that did go up are saved; keep the dialog open on the ones that did
      // not, in edit mode so a second submit patches the source instead of colliding with its name.
      srcUi.editing = source;
      srcUi.queue = srcUi.queue.filter((i) => i.status === 'fail');
      for (const tab of srcTabs) tab.disabled = true;
      srcForm.elements.name.disabled = true;
      setKind(kindOfSource(source));
      void loadSourceFiles(project, source);
      errorNode.textContent = `Saved, but ${rejected.length} file${rejected.length === 1 ? '' : 's'} could not be read — ${rejected.join(' · ')}`;
      errorNode.hidden = false;
      await refresh();
      await loadSources(true);
      return;
    }
    closeSourceDialog();
    toast(editing ? `Saved ${source.name}` : `Added ${source.name}`);
    await refresh();
    await loadSources(true);
  } catch (err) {
    errorNode.textContent = err.message;
    errorNode.hidden = false;
  } finally {
    srcUi.busy = false;
    submit.disabled = false;
  }
});

// ---------- auth + filter ----------

$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.token = $('#auth-token').value.trim();
  safeStorage('set', state.token);
  refresh();
});

$('#filter').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey && !dialog.open && !srcDialog.open && !$('#auth-gate').matches(':not([hidden])')) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    openCreate();
  }
});

refresh();
