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
  const p = selectedProject();
  history.replaceState(null, '', p ? `#/${encodeURIComponent(p.name)}` : location.pathname);
  renderList();
  renderDetail();
  void loadRuns();
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
  const visible = q ? state.projects.filter((p) => p.name.includes(q) || p.rootPath.toLowerCase().includes(q)) : state.projects;

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
        el('span', { class: 'row-bottom' }, [el('code', { text: p.rootPath, title: p.rootPath }), el('span', { class: 'meta', text: meta, title: metaTitle || undefined })]),
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
          el('code', { class: 'path', text: p.rootPath }),
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
      stat('Documents', fmt(p.documentCount), '.md / .mdx files under root'),
      stat('Chunks', fmt(p.chunkCount), 'embedded, HNSW cosine index'),
      stat('Last indexed', relativeTime(p.lastIndexedAt), lastRun || (p.lastIndexedAt ? new Date(p.lastIndexedAt).toLocaleString() : 'never indexed'), p.lastIndexedAt),
      stat('Embedding model', model, modelSub, null, true, modelMismatch),
    ]),
  );

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
  if (event.key === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey && !dialog.open && !$('#auth-gate').matches(':not([hidden])')) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    openCreate();
  }
});

refresh();
