// Contextator admin dashboard — plain ES module, no build step.
// Master/detail layout: project list on the left, the selected project on the right.
// Shared helpers live in core.js; accounts in auth.js, users.js and members.js.

import {
  $,
  ApiError,
  api,
  capitalize,
  clearLegacyToken,
  closeDialog,
  copyText,
  el,
  fmt,
  formatBytes,
  formatDuration,
  icon,
  onBus,
  openDialog,
  postForm,
  relativeTime,
  shortError,
  stat,
  state,
  toast,
} from './core.js';
import { captureAuditFocus, loadAudit, renderAuditView } from './audit.js';
import { canCreateProject, canDeleteProject, canEdit, initAuthUi, loadMe, renderUserMenu } from './auth.js';
import { authHeaderFor, initMcpUi, loadMcpTokens, renderMcpAccess, showMcpSecret } from './mcp.js';
import { initMembersUi, loadMembers, renderMembers } from './members.js';
import { loadQuerySummary, renderQueries } from './queries.js';
import { captureSearchFocus, renderSearch } from './search.js';
import { initUsersUi, renderUsersView } from './users.js';

const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 15000;
/** While the search box has focus. See schedule(). */
const POLL_TYPING_MS = 30000;
const ACTIVE_PHASES = new Set(['queued', 'scanning', 'embedding', 'finalizing']);

const TOOLS = [
  {
    name: 'search_docs',
    text: 'Hybrid search — meaning and exact wording, fused. Ranked excerpts with path, breadcrumb, score and the passage around them; optional source and path_prefix filters, and an honest "no good match".',
  },
  { name: 'list_topics', text: 'Indexed documents grouped by directory, with title and chunk count; paged with a cursor.' },
  { name: 'read_document', text: 'Markdown of one indexed file from the database — a whole page, or one section by its heading.' },
];

const SOURCE_GLYPH = { local: 'DIR', git: 'GIT', upload: 'UP', notion: 'NTN', confluence: 'CNF', web: 'WEB' };
const SOURCE_TITLE = {
  local: 'Local directory',
  git: 'Git repository',
  upload: 'Uploaded files',
  notion: 'Notion workspace',
  confluence: 'Confluence site',
  web: 'Documentation site',
};

/**
 * Dialog tabs ("kinds") are not server-side types: an Obsidian vault is an upload source that carries
 * the `obsidian` flavor, so the tab picks both.
 */
const SOURCE_KINDS = {
  local: { type: 'local', title: 'Local directory', subtitle: 'A folder mounted on the server, scanned in place. Nothing is copied.' },
  git: {
    type: 'git',
    title: 'Git repository',
    subtitle: 'Cloned on the server and fetched at the start of every index run. A push webhook can trigger one.',
  },
  upload: { type: 'upload', title: 'Upload files', subtitle: 'Files, folders and archives are unpacked on the server and kept for this source.' },
  obsidian: {
    type: 'upload',
    flavor: 'obsidian',
    title: 'Obsidian vault',
    subtitle: 'An uploaded vault; [[wikilinks]] are rewritten to Markdown links.',
  },
  notion: { type: 'notion', title: 'Notion', subtitle: 'Pages shared with an internal integration are rendered to Markdown on every sync.' },
  confluence: {
    type: 'confluence',
    title: 'Confluence',
    subtitle: 'Confluence Cloud. Pages in the chosen spaces are rendered to Markdown, nested the way they are in the wiki.',
  },
  web: {
    type: 'web',
    title: 'Documentation site',
    subtitle: 'A published site, read from its sitemap.xml, its llms.txt or a crawl. Public pages only — there is no login.',
  },
};

/**
 * The file types a kind is *for*, checked when an operator picks its tab on a new source.
 *
 * Same trap `syncFlavorFields` guards, from the other direction: the form opens with `.md` and `.mdx`
 * checked, a documentation site serves `.html`, and a web source saved with the defaults would fetch
 * every page and then drop all of them at the indexer's extension filter — reporting a successful run
 * over an empty index.
 */
const KIND_EXTENSIONS = { web: ['html', 'md', 'txt'] };

/**
 * The source types that hold a credential, and the form field each one's token is typed into.
 *
 * One set rather than a chain of `||`: the Test button, the "remove the stored token" checkbox and
 * the patch below all mean the same thing by it, and a new type that was added to two of the three is
 * exactly the bug this shape removes.
 */
const SECRET_FIELD = { git: 'secret', notion: 'notionSecret', confluence: 'confluenceSecret' };
const CREDENTIALLED = new Set(Object.keys(SECRET_FIELD));

/**
 * Types whose driver has a `test()`, which is what the Test button actually calls.
 *
 * It used to be spelled `CREDENTIALLED`, because until the web source every testable type was one
 * holding a token and the two sets were the same set. They are not any more: a documentation site has
 * no credential and is the type where "does this entry point hold anything?" is the most worth asking
 * *before* a run walks somebody else's server. Asking the same question two ways is how the button
 * ends up offered on a type that has nothing to answer it.
 */
const TESTABLE = new Set([...Object.keys(SECRET_FIELD), 'web']);
const CLEAR_SECRET_ROWS = () => ({
  git: $('#git-clear-secret-row'),
  notion: $('#notion-clear-secret-row'),
  confluence: $('#confluence-clear-secret-row'),
});
const clearSecretRow = (type) => CLEAR_SECRET_ROWS()[type];

// ---------- helpers ----------

const isActive = (p) => Boolean(p.job && ACTIVE_PHASES.has(p.job.phase)) || p.status === 'indexing';
const displayStatus = (p) => (p.job && p.job.phase === 'queued' ? 'queued' : isActive(p) ? 'indexing' : p.status);

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

function snippetsFor(project) {
  const url = project.mcpUrl;
  const id = `${project.name}-docs`;
  // A token is shown once, when it is minted, so the snippets here carry a placeholder instead.
  const locked = project.mcpAuth === 'token';
  const header = authHeaderFor(null);
  const tokenHint = locked ? ' Replace <your token> with one from the MCP access panel above.' : '';
  return [
    {
      tab: 'Claude Code',
      hint: locked ? `This project requires a token.${tokenHint}` : undefined,
      code: locked ? `claude mcp add --transport http ${id} ${url} \\\n  --header "${header}"` : `claude mcp add --transport http ${id} ${url}`,
    },
    {
      tab: 'Cursor',
      hint: `~/.cursor/mcp.json (global) or .cursor/mcp.json in the repo.${tokenHint}`,
      code: JSON.stringify({ mcpServers: { [id]: locked ? { url, headers: { Authorization: 'Bearer <your token>' } } : { url } } }, null, 2),
    },
    {
      tab: 'Claude Desktop',
      hint: `claude_desktop_config.json — via the mcp-remote stdio bridge.${tokenHint}`,
      code: JSON.stringify(
        { mcpServers: { [id]: { command: 'npx', args: locked ? ['-y', 'mcp-remote', url, '--header', header] : ['-y', 'mcp-remote', url] } } },
        null,
        2,
      ),
    },
    {
      tab: 'Legacy SSE',
      hint: locked
        ? 'GET opens the SSE stream; both it and the messages channel need the Authorization header, which a browser EventSource cannot send.'
        : 'GET opens the SSE stream; the server answers with the messages endpoint.',
      code: `${url}\n→ POST ${url}/messages?sessionId=…`,
    },
  ];
}

/**
 * Hash routing. Project names are `^[a-z0-9][a-z0-9_-]*`, so a leading `~` can never collide
 * with one: `#/~users` is the account list, `#/~audit` the audit log, anything else is a project.
 */
function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (raw === '~users') return { view: 'users', selected: null };
  if (raw === '~audit') return { view: 'audit', selected: null };
  return { view: 'projects', selected: raw || null };
}

function applyHash() {
  const { view, selected } = parseHash();
  const changed = view !== state.view;
  state.view = view;
  if (view === 'projects' && selected) state.selectedId = selected;
  // Both instance views are full-width: neither is about the project in the list beside them.
  document.body.classList.toggle('no-sidebar', view === 'users' || view === 'audit');
  if (view === 'users') void loadUsers();
  if (view === 'audit') void loadAudit();
  if (changed || view === 'users') renderAll();
}

function renderAll() {
  renderList();
  renderDetail();
}

async function loadUsers() {
  try {
    state.users = await api('/api/users');
    state.usersLoaded = true;
    if (state.view === 'users') renderDetail();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
  }
}

function selectedProject() {
  return state.projects.find((p) => p.id === state.selectedId) ?? null;
}

function select(id) {
  state.view = 'projects';
  document.body.classList.remove('no-sidebar');
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
  void loadMembers();
  void loadMcpTokens();
  void loadQuerySummary();
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
  // No body at all means nothing answered. A body that says the database is down did answer, and
  // saying "server unreachable" to that would point at the wrong thing to go and fix.
  if (!h) {
    node.append(el('span', { class: 'pill error', text: 'server unreachable' }));
    return;
  }
  const model = h.embeddings;
  node.append(el('span', { class: `pill ${h.db === 'up' ? 'idle' : 'error'}`, text: h.db === 'up' ? 'Database up' : 'Database down' }));
  // While the database is unreachable the server cannot resolve the session cookie either, so what
  // comes back is the anonymous shape: a version, and the bad news. There is no model to report.
  if (model) {
    node.append(
      el('span', { class: `pill ${model.ready ? 'idle' : 'loading'}`, text: model.ready ? 'Model ready' : 'Model loading' }),
      el('span', {
        class: 'chip mono',
        title: 'embedding provider · model · dimensions',
        text: `${model.provider} · ${model.model} · ${model.dimensions}d`,
      }),
      el('span', { class: 'chip', title: 'open MCP sessions', text: `${h.sessions.total} open session${h.sessions.total === 1 ? '' : 's'}` }),
    );
  }
  node.append(el('span', { class: 'version', text: `v${h.version}` }));
  $('#version').textContent = `v${h.version}`;
  // Left alone in the reduced shape: an empty list here would blank the New-project directory
  // prefix for as long as the outage lasts, and the roots have not changed.
  if (!model) return;
  $('#allowed-roots').textContent = (h.allowedDocRoots || []).join(', ');
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
  // Creating a project opens a new unauthenticated /mcp/<name> surface, so it is an admin's call.
  $('#new-btn').hidden = !canCreateProject();
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
          el('span', {
            text: job.filesTotal
              ? `${job.phase} · ${job.filesDone}/${job.filesTotal} files · ${fmt(job.chunksDone)} chunks embedded`
              : `${job.phase}…`,
          }),
        ]),
      );
    }
    container.append(row);
  }
}

function renderDetail() {
  const main = $('#detail');
  // Before the wipe, not after: emptying #detail takes the search box's focus with it, and nothing
  // downstream can then tell whether the operator was typing. search.js restores what this records.
  captureSearchFocus();
  captureAuditFocus();
  main.replaceChildren();

  if (state.view === 'users') {
    main.append(renderUsersView());
    return;
  }

  if (state.view === 'audit') {
    main.append(renderAuditView());
    return;
  }

  const p = selectedProject();

  if (!p) {
    const mayCreate = canCreateProject();
    main.append(
      el('div', { class: 'empty-state' }, [
        el('h1', { text: state.projects.length ? 'Select a project' : 'No projects yet' }),
        el('p', {
          text: state.projects.length
            ? 'Pick a project on the left to see its status and connection snippets.'
            : mayCreate
              ? 'Point Contextator at a folder of Markdown files. Every project becomes its own MCP endpoint that agents can search.'
              : 'No project has been shared with your account yet. Ask an administrator to add you to one.',
        }),
        state.projects.length || !mayCreate
          ? null
          : el('button', { type: 'button', class: 'primary', onclick: openCreate }, [icon('plus'), 'New project']),
      ]),
    );
    return;
  }

  const status = displayStatus(p);
  const busy = isActive(p);
  const job = p.job;
  const confirming = state.confirmDelete === p.id;
  const mayEdit = canEdit(p);
  const readOnly = mayEdit ? undefined : 'Your role on this project is viewer — re-indexing is done by an editor';
  // `embeddingModel` on a project is the provider-qualified id (e.g. `local:<model>:fp32`), compared with health's `id`.
  const modelMismatch = Boolean(p.embeddingModel && state.health?.embeddings?.id && p.embeddingModel !== state.health.embeddings.id);

  // Header
  main.append(
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-title' }, [
        el('div', { class: 'title-row' }, [el('h1', { text: p.name }), el('span', { class: `pill ${status}`, text: status })]),
        el('div', { class: 'url-row' }, [
          el('code', { class: 'url', text: p.mcpUrl }),
          el(
            'button',
            { type: 'button', class: 'icon', 'aria-label': 'Copy MCP URL', title: 'Copy MCP URL', onclick: () => copyText(p.mcpUrl) },
            icon('copy'),
          ),
          el('code', { class: 'path', text: sourceSummary(p), title: sourceSummary(p) }),
        ]),
      ]),
      el('div', { class: 'detail-actions' }, [
        // Disabled rather than hidden: a viewer should see that re-indexing exists, and who to ask.
        el('button', { type: 'button', class: 'primary', disabled: busy || !mayEdit, title: readOnly, onclick: () => reindex(p, false) }, [
          icon('refresh'),
          busy ? 'Indexing…' : 'Re-index',
        ]),
        el('button', {
          type: 'button',
          class: 'ghost',
          disabled: busy || !mayEdit,
          title: readOnly ?? 'Drop and rebuild every chunk',
          onclick: () => reindex(p, true),
          text: 'Force re-index',
        }),
        canDeleteProject()
          ? el(
              'button',
              {
                type: 'button',
                class: `danger${confirming ? ' confirm' : ''}`,
                disabled: busy,
                onclick: () => (confirming ? remove(p) : askDelete(p)),
              },
              confirming ? ['Confirm delete'] : [icon('trash'), 'Delete'],
            )
          : null,
      ]),
    ]),
  );

  // Live job / error callouts
  if (busy && job) {
    const pct = job.filesTotal ? Math.round((job.filesDone / job.filesTotal) * 100) : null;
    main.append(
      el('div', { class: 'callout warn' }, [
        el('span', {
          class: 'callout-title',
          text: job.phase === 'queued' ? 'Queued — waiting for the indexer' : `${capitalize(job.phase)}${job.force ? ' (full re-index)' : ''}`,
        }),
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
    main.append(
      el('div', { class: 'callout error' }, [
        el('span', { class: 'callout-title', text: 'Last index run failed' }),
        el('pre', { text: p.lastError || job.error }),
      ]),
    );
  }
  // A mismatch is the one state the server will not resolve on its own: search is refused for this
  // project and stays refused until somebody presses a button, which is why the button is in the
  // callout rather than only in the header above it (ADR-0037).
  if (modelMismatch) {
    main.append(
      el('div', { class: 'callout warn' }, [
        el('span', { class: 'callout-title', text: 'Indexed with a different embedding model' }),
        el('span', {
          text:
            `Chunks were embedded with ${p.embeddingModel}; the server now runs ${state.health.embeddings.id}. ` +
            'Vectors from two models cannot be compared, so search and `search_docs` refuse this project until it is ' +
            're-indexed — and nothing re-indexes it by itself.',
        }),
        el('div', { class: 'callout-action' }, [
          el(
            'button',
            {
              type: 'button',
              class: 'primary',
              disabled: busy || !mayEdit,
              // A plain run is enough: the indexer sees the stored id differ and makes it a full one.
              title: readOnly ?? 'Drops every chunk and rebuilds it with the model the server now runs',
              onclick: () => reindex(p, false),
            },
            [icon('refresh'), busy ? 'Indexing…' : 'Re-index now'],
          ),
        ]),
      ]),
    );
  }
  // The chunk budget against what the model actually reads. Sticky for the life of the server process,
  // and shown here because a line in the startup log is not where anyone looks (ADR-0035).
  const budget = state.health?.chunkBudget;
  if (budget?.checked && !budget.ok) {
    const w = state.health.embeddings;
    const truncation =
      typeof w?.truncatesAtTokens === 'number' && w.truncatesAtTokens > w.maxInputTokens
        ? ` The tokenizer only truncates at ${w.truncatesAtTokens}, so the rest is read — by weights that were never trained to represent it.`
        : '';
    main.append(
      el('div', { class: 'callout warn' }, [
        el('span', { class: 'callout-title', text: 'Chunks are larger than the model reads' }),
        el('span', {
          text:
            `CHUNK_MAX_TOKENS is ${budget.chunkMaxTokens}, but ${w?.model ?? 'the model'} represents only the first ` +
            `${w?.maxInputTokens} tokens.${truncation} Set CHUNK_MAX_TOKENS=${budget.suggestedChunkMaxTokens} and re-index.`,
        }),
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
      stat(
        'Last indexed',
        relativeTime(p.lastIndexedAt),
        lastRun || (p.lastIndexedAt ? new Date(p.lastIndexedAt).toLocaleString() : 'never indexed'),
        p.lastIndexedAt,
      ),
      stat('Embedding model', model, modelSub, null, true, modelMismatch),
    ]),
  );

  // Next to the counts it is read against: the stats say how much is indexed, this says what comes back.
  main.append(renderSearch(p));
  // Under the panel that asks one question, the panel that reads back every question the agents asked
  // ([ADR-0050](../.ssot/ADR.md#adr-0050)): one is what this corpus answers now, the other what it has
  // been failing to answer for a week.
  main.append(renderQueries(p));
  main.append(renderSources(p, busy));
  main.append(renderMembers(p));
  main.append(renderMcpAccess(p));

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
            el('button', { type: 'button', class: 'copy', 'aria-label': `Copy ${current.tab} snippet`, onclick: () => copyText(current.code) }, [
              icon('copy'),
              'Copy',
            ]),
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
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'Index runs' }),
        el('p', { text: 'Incremental: unchanged files are skipped by sha256.' }),
      ]),
      el('div', { class: 'panel-body' }, [
        runs.length === 0
          ? el('p', { class: 'runs-empty', text: busy ? 'The first run is in progress.' : 'No runs yet. Press Re-index to build the index.' })
          : el('div', { class: 'run-grid head' }, [
              el('span', { text: 'When' }),
              el('span', { text: 'Mode' }),
              el('span', { text: 'Result' }),
              el('span', { class: 'right', text: 'Duration' }),
            ]),
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
  const mayEdit = canEdit(project);
  const rows = sources.map((s) => {
    const confirming = state.confirmDeleteSource === s.id;
    const failed = s.status === 'error';
    // A source can carry a complaint without having failed: since ADR-0056 a file the indexer could
    // not convert — a scanned PDF, a file over the conversion limit — writes its reason here while the
    // source itself synced perfectly and everything else in it indexed. Showing `lastError` only when
    // `status === 'error'` hid exactly that case, which made the refusal a silent failure of its own.
    const warned = !failed && Boolean(s.lastError);
    const actions = [
      mayEdit && TESTABLE.has(s.type)
        ? el('button', {
            type: 'button',
            class: 'ghost small',
            title: 'Check the connection without indexing',
            text: 'Test',
            onclick: () => testSource(project, s),
          })
        : null,
      mayEdit
        ? el('button', {
            type: 'button',
            class: 'ghost small',
            disabled: busy,
            title: 'Sync this source and re-index the project',
            text: 'Sync',
            onclick: () => syncSource(project, s),
          })
        : null,
      el('button', {
        type: 'button',
        class: 'ghost small',
        text: mayEdit ? (s.type === 'upload' ? 'Files' : 'Edit') : 'View',
        onclick: () => openSourceDialog(project, s),
      }),
      mayEdit
        ? el('button', {
            type: 'button',
            class: `danger small${confirming ? ' confirm' : ''}`,
            disabled: busy,
            text: confirming ? 'Confirm' : 'Delete',
            onclick: () => (confirming ? removeSource(project, s) : askDeleteSource(s)),
          })
        : null,
    ];
    return el('div', { class: 'source-row' }, [
      el('span', { class: `source-glyph ${failed ? 'error' : warned ? 'warn' : s.type}`, text: SOURCE_GLYPH[s.type] ?? '?' }),
      el('span', { class: 'source-cell' }, [
        el('code', { text: s.name }),
        el('span', { class: 'sub', text: s.label || SOURCE_TITLE[s.type] || s.type }),
      ]),
      el('span', { class: 'source-cell' }, [
        el('code', { text: sourceOrigin(s), title: sourceOrigin(s) }),
        el('span', {
          class: `sub${failed ? ' err' : warned ? ' warn' : ''}`,
          text: failed || warned ? shortError(s.lastError, 80) : sourceDetail(s),
          title: failed || warned ? s.lastError || '' : '',
        }),
      ]),
      el('span', { class: 'sub', text: s.flavor === 'plain' ? '—' : s.flavor, title: 'Content type' }),
      el('span', { class: 'sub', text: `${fmt(s.documentCount)} docs` }),
      el('span', {
        class: 'sub',
        text: relativeTime(s.lastSyncedAt),
        title: s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'never synced',
      }),
      el('span', { class: 'source-actions' }, actions),
    ]);
  });

  return el('section', { class: 'panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Document sources' }),
        el('p', {
          text: 'Every source is mounted under its own name; a document\u2019s path is <source>/<path inside it>. All of them are synced at the start of an index run.',
        }),
      ]),
      mayEdit
        ? el('button', { type: 'button', class: 'primary small', onclick: () => openSourceDialog(project, null) }, [icon('plus'), 'Add source'])
        : null,
    ]),
    rows.length
      ? el('div', {}, rows)
      : el('p', {
          class: 'sources-empty',
          text: mayEdit
            ? 'No sources yet. Add a local directory, a git repository, an upload, a Notion workspace or a Confluence site to give this project something to index.'
            : 'No sources yet. An editor on this project can add one.',
        }),
  ]);
}

/** The identifying string of a source: path, repository URL, or the mount prefix. */
function sourceOrigin(s) {
  const c = s.config || {};
  if (s.type === 'local') return c.path || '—';
  if (s.type === 'git') return c.url || '—';
  if (s.type === 'notion') return (c.rootIds || []).length ? `${c.rootIds.length} root page(s)` : 'everything shared with the integration';
  if (s.type === 'confluence') return c.baseUrl || '—';
  if (s.type === 'web') return c.entryUrl || '—';
  return `${s.name}/`;
}

/** A minute count as an operator would say it: "30 min", "6 h", "2 d". */
function everyLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/**
 * The scheduled-sync state of a source in one phrase ([ADR-0048](../.ssot/ADR.md#adr-0048)).
 *
 * `relativeTime` is deliberately not reused: `next_sync_at` is in the *future*, and that helper
 * renders a future instant as "-42 min ago".
 */
function syncScheduleLabel(s) {
  if (s.syncIntervalMinutes === null || s.syncIntervalMinutes === undefined) return 'manual only';
  const every = `every ${everyLabel(s.syncIntervalMinutes)}`;
  if (!s.nextSyncAt) return `${every} \u00b7 due at the next tick`;
  const minutes = Math.round((new Date(s.nextSyncAt).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return `${every} \u00b7 due now`;
  return `${every} \u00b7 next in ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`;
}

/** The second line: branch/subdir for git, extensions otherwise, plus the schedule. */
function sourceDetail(s) {
  const c = s.config || {};
  const ext = (c.extensions || []).map((e) => `.${e}`).join(' ');
  const schedule = s.syncIntervalMinutes ? ` \u00b7 every ${everyLabel(s.syncIntervalMinutes)}` : '';
  if (s.type === 'git') {
    const at = c.lastCommit ? ` @ ${String(c.lastCommit).slice(0, 7)}` : '';
    return `${c.branch || 'main'}${c.subdir ? `/${c.subdir}` : ''}${at}${ext ? ` \u00b7 ${ext}` : ''}${schedule}`;
  }
  return `${ext || '—'}${schedule}`;
}

// ---------- actions ----------

/**
 * `/api/health` answers 503 with its usual body while the database is down, and api() turns every
 * non-2xx into a throw. The body is the whole point of that 503, so read it back off the error
 * rather than losing it and rendering "server unreachable" at a server that answered.
 */
function healthBody(err) {
  return err instanceof ApiError && typeof err.body?.db === 'string' ? err.body : null;
}

async function refresh() {
  // `me` rides along so a role change on the server reaches the UI without a reload.
  const [healthRes, projectsRes, meRes] = await Promise.allSettled([api('/api/health'), api('/api/projects'), api('/api/auth/me')]);
  state.health = healthRes.status === 'fulfilled' ? healthRes.value : healthBody(healthRes.reason);
  if (meRes.status === 'fulfilled') state.me = meRes.value;
  renderHealth();
  renderUserMenu();

  if (projectsRes.status === 'fulfilled') {
    state.projects = projectsRes.value;
    if (!state.projects.some((p) => p.id === state.selectedId)) {
      // A hash may carry the project *name* on first load; otherwise fall back to the first project.
      const byName = state.projects.find((p) => p.name === state.selectedId);
      state.selectedId = byName?.id ?? state.projects[0]?.id ?? null;
      const p = selectedProject();
      // Only while the projects view is the one on screen — otherwise this would rewrite #/~users.
      if (p && state.view === 'projects') history.replaceState(null, '', `#/${encodeURIComponent(p.name)}`);
    }
    renderList();
    renderDetail();
    void loadRuns();
    void loadSources();
    void loadMembers(); // no-op unless the selection moved; the dialog forces its own reload
    void loadMcpTokens();
    // Also a no-op unless the selection, the window, the actor or the configuration moved: four
    // aggregate queries every two seconds against the table the searches are writing into is not a
    // panel, it is a load generator. The panel carries its own Refresh.
    void loadQuerySummary();
  }
  // The account list is not part of a project poll; refresh it only while it is on screen.
  if (state.view === 'users') void loadUsers();
  // A no-op unless a filter or the page moved, for ADR-0050's reason one table along: the audit log
  // is append-only and a filtered scan of it twice a second buys nothing. The panel carries Refresh.
  if (state.view === 'audit') void loadAudit();
  schedule();
}

function schedule() {
  clearTimeout(state.timer);
  const active = state.projects.some(isActive);
  const modelLoading = state.health?.embeddings && !state.health.embeddings.ready;
  // A poll calls renderDetail(), which replaces #detail wholesale — including the search box
  // somebody is typing into. search.js restores the caret for the renders it cannot avoid; this
  // keeps the avoidable ones out of the way, at the cost of a staler job phase while the box is
  // focused. It is the cheapest fix for the whole class of "my typing vanished".
  // …and the audit panel's filter bar is the same class of thing: a half-typed date, or a dropdown
  // the operator has open, does not survive #detail being replaced underneath it.
  const typing = state.search.focused || state.audit.focusKey !== null;
  state.timer = setTimeout(refresh, typing ? POLL_TYPING_MS : active || modelLoading ? POLL_ACTIVE_MS : POLL_IDLE_MS);
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
  openDialog(dialog);
  createForm.elements.name.focus();
}

function closeCreate() {
  closeDialog(dialog);
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
    // A project is born requiring a token (ADR-0065) and the server minted its first one with it.
    // This is the only moment that string exists outside the database, so it goes on screen before
    // anything else does.
    if (created.mcpToken) showMcpSecret(created, created.mcpToken.secret);
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

const srcUi = { kind: 'local', project: null, editing: null, queue: [], existingFiles: [], busy: false, readOnly: false };

const kindOfSource = (s) => (s.type === 'upload' && s.flavor === 'obsidian' ? 'obsidian' : s.type);
const isUploadKind = (kind) => SOURCE_KINDS[kind].type === 'upload';
const uploadMode = () => srcForm.elements.mode.value;
const allowedRoots = () => state.health?.allowedDocRoots || [];

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

/**
 * Shows only the file types the selected content type can read.
 *
 * `.yaml`, `.yml` and `.json` belong to the OpenAPI content type alone — it is the only reader that
 * knows what to do with a structured file — and the API refuses them on any other, so offering them
 * everywhere would offer a save that cannot succeed. A box that goes away is also unchecked, or an
 * operator who tried OpenAPI and changed their mind would carry an invisible `.yaml` into the save.
 */
function syncFlavorFields({ check = false } = {}) {
  const flavor = srcForm.elements.flavor.value;
  for (const box of srcForm.querySelectorAll('.flavor-only')) {
    const mine = box.dataset.flavor.split(' ').includes(flavor);
    box.hidden = !mine;
    // **A type that appears unchecked is a trap.** Choosing "OpenAPI / Swagger" and then uploading a
    // specification without noticing the new `.yaml` box would pass the source's extension filter with
    // nothing in it: the file is dropped on the way in, quietly, and the source indexes the README it
    // came with. So picking the content type checks what that content type is *for*. Only on a change
    // the operator just made — loading an existing source keeps whatever it has stored.
    for (const input of box.querySelectorAll('input')) input.checked = mine ? check || input.checked : false;
  }
}

srcForm.elements.flavor.addEventListener('change', () => {
  syncFlavorFields({ check: true });
  renderQueue();
});

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
  syncFlavorFields();
  $('#upload-mode-row').hidden = !(isUploadKind(kind) && editing);
  $('#index-label').textContent = isUploadKind(kind) ? 'Index after upload' : 'Index now';
  $('#source-test').hidden = !(editing && TESTABLE.has(meta.type));
  // Clearing a token is only offered where one is actually stored.
  for (const type of CREDENTIALLED) {
    const row = clearSecretRow(type);
    row.hidden = !(editing?.hasSecret && meta.type === type);
    if (row.hidden) row.querySelector('input').checked = false;
  }
  // A viewer may read a source's settings but not its secrets, its files or the save button.
  $('#webhook-box').hidden = !(editing && meta.type === 'git') || srcUi.readOnly;
  // The Notion box is the same affordance with the secret coming the other way: Notion generates the
  // token, the product captures it inside a window, and the operator carries it back into Notion.
  $('#notion-webhook-box').hidden = !(editing && meta.type === 'notion') || srcUi.readOnly;
  $('#dropzone').hidden = srcUi.readOnly;
  $('#upload-mode-row').hidden = $('#upload-mode-row').hidden || srcUi.readOnly;
  $('#source-submit').hidden = srcUi.readOnly;
  $('#source-test').hidden = $('#source-test').hidden || srcUi.readOnly;
  $('#source-submit').textContent = editing ? 'Save changes' : 'Add source';
  $('#source-cancel').textContent = srcUi.readOnly ? 'Close' : 'Cancel';
  renderQueue();
}

function openSourceDialog(project, source) {
  srcUi.project = project;
  srcUi.editing = source;
  srcUi.queue = [];
  srcUi.existingFiles = [];
  srcUi.busy = false;
  srcUi.readOnly = !canEdit(project);
  $('#source-error').hidden = true;
  srcForm.reset();
  srcForm.elements.secret.placeholder = 'leave empty for public repositories';
  srcForm.elements.notionSecret.placeholder = 'ntn_… / secret_…';
  srcForm.elements.confluenceSecret.placeholder = 'ATATT…';
  $('#secret-hint').innerHTML = SECRET_HINT_HTML; // static markup restored, never user data
  renderSrcRootPrefix();

  // Type and name are the mount prefix of every document path, so neither can change after creation.
  for (const tab of srcTabs) tab.disabled = Boolean(source) || srcUi.readOnly;
  srcForm.elements.name.disabled = Boolean(source);
  srcForm.elements.index.checked = true;
  // A new source starts on the instance's default rather than on "never": the point of the feature is
  // that adding a source is enough. An existing one is filled from its own row, below.
  setSyncIntervalField(source ? null : (state.health?.sync?.defaultIntervalMinutes ?? null));
  $('#src-next-sync').textContent = '—';
  if (source) fillSourceForm(source);
  setKind(source ? kindOfSource(source) : 'local');
  if (srcUi.readOnly) {
    for (const field of srcForm.querySelectorAll('input, select, textarea')) field.disabled = true;
    for (const type of CREDENTIALLED) srcForm.elements[SECRET_FIELD[type]].value = '';
  }

  openDialog(srcDialog);
  (source ? srcForm.elements.label : srcForm.elements.name).focus();

  if (source?.type === 'git' && !srcUi.readOnly) renderWebhook(project, source);
  if (source?.type === 'notion' && !srcUi.readOnly) renderNotionWebhook(project, source);
  if (source?.type === 'upload' && !srcUi.readOnly) void loadSourceFiles(project, source);
}

function closeSourceDialog() {
  closeDialog(srcDialog);
}

function fillSourceForm(s) {
  const c = s.config || {};
  srcForm.elements.name.value = s.name;
  srcForm.elements.label.value = s.label || '';
  srcForm.elements.flavor.value = s.flavor || 'plain';
  syncFlavorFields();
  srcForm.elements.language.value = c.language || '';
  srcForm.elements.version.value = c.version || '';
  setSyncIntervalField(s.syncIntervalMinutes);
  $('#src-next-sync').textContent = syncScheduleLabel(s);
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
  if (s.type === 'web') {
    srcForm.elements.entryUrl.value = c.entryUrl || '';
    srcForm.elements.entryKind.value = c.entryKind || 'auto';
  }
  if (s.type === 'confluence') {
    srcForm.elements.confluenceUrl.value = c.baseUrl || '';
    srcForm.elements.confluenceEmail.value = c.email || '';
    srcForm.elements.spaceKeys.value = (c.spaceKeys || []).join('\n');
    if (s.hasSecret) srcForm.elements.confluenceSecret.placeholder = 'unchanged — type to replace';
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

/**
 * The Notion webhook box. It exists because Notion's verification does not end at the endpoint: the
 * token it POSTs has to be read *here* and pasted back into Notion's own modal, or the subscription
 * stays "pending verification" and nothing is ever delivered. A capture the operator never sees is a
 * source that looks configured and receives nothing.
 */
function renderNotionWebhook(project, source) {
  const url = `${location.origin}/api/webhooks/notion/${source.id}`;
  $('#notion-webhook-url').textContent = url;
  $('#notion-webhook-copy-url').onclick = () => copyText(url);
  $('#notion-webhook-copy-token').onclick = () =>
    source.webhookSecret ? copyText(source.webhookSecret) : toast('No verification token has been captured yet');
  $('#notion-webhook-token-row').hidden = !source.webhookSecret;
  $('#notion-webhook-token').textContent = source.webhookSecret || '';
  $('#notion-webhook-status').textContent = notionWebhookStatus(source);
  $('#notion-webhook-open').onclick = async () => {
    try {
      const opened = await api(`/api/projects/${project.id}/sources/${source.id}/webhook-verification`, { method: 'POST' });
      const minutes = Math.max(1, Math.round((new Date(opened.webhookVerificationExpiresAt).getTime() - Date.now()) / 60_000));
      toast(`Window open for ${minutes} min \u2014 create the subscription in Notion now, then reopen this dialog for the token`);
      srcUi.editing = { ...source, webhookVerificationExpiresAt: opened.webhookVerificationExpiresAt };
      renderNotionWebhook(project, srcUi.editing);
      await loadSources(true);
    } catch (err) {
      toast(err.message);
    }
  };
}

/** Three states, and "expired without a token" is not one of the broken ones. */
function notionWebhookStatus(source) {
  const open = source.webhookVerificationExpiresAt && new Date(source.webhookVerificationExpiresAt).getTime() > Date.now();
  if (open) {
    const minutes = Math.max(1, Math.round((new Date(source.webhookVerificationExpiresAt).getTime() - Date.now()) / 60_000));
    return `Window open for about ${minutes} min. Create the subscription in Notion with the URL above; the token it sends appears here, and you paste it back into Notion and press Verify subscription.`;
  }
  if (source.webhookSecret || source.hasWebhookSecret) {
    return 'A verification token is stored. Paste it into Notion\u2019s Webhooks tab and press Verify subscription \u2014 until that is done, Notion delivers nothing. Pressing Resend token in Notion needs a new window here first.';
  }
  return 'Not verified. This source syncs on its interval, which is not an error \u2014 open a window when you are ready to create the subscription in Notion.';
}

const extensionsFromForm = () => [...srcForm.querySelectorAll('input[name="ext"]:checked')].map((b) => b.value);

/**
 * The scheduled sync interval, as the API takes it: minutes, or `null` for "never".
 *
 * The select offers a fixed ladder rather than a number box, because the server enforces a band
 * (5 minutes to 30 days) and a free-text field is a way to discover that band by being refused.
 */
const syncIntervalFromForm = () => {
  const raw = srcForm.elements.syncInterval.value;
  return raw === '' ? null : Number(raw);
};

/**
 * An interval the ladder does not offer — set through the API, or the instance default — is added to
 * it rather than silently rounded to a neighbour, which would change it the moment somebody saved an
 * unrelated field.
 */
function setSyncIntervalField(minutes) {
  const select = $('#src-sync-interval');
  const value = minutes === null || minutes === undefined ? '' : String(minutes);
  if (value !== '' && ![...select.options].some((o) => o.value === value)) {
    select.append(el('option', { value, text: `${minutes} minutes` }));
  }
  select.value = value;
}

const NOTION_ID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/** Space keys, one per line; the server rejects anything outside `[A-Za-z0-9~_-]`. */
function parseSpaceKeys(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
}

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
  // `language` and `version` are both always sent, empty string included (ADR-0058, ADR-0064): the
  // form offers both, and because the PATCH merges over the stored config, a cleared field that was
  // simply omitted would leave the old value on the source with nothing on screen to say so. The
  // server normalises `''` to unset for each of them.
  //
  // `language` was deliberately absent until ADR-0064, because ADR-0041 left the query side speaking
  // one configuration for the whole instance and setting this only made a source worse. The query
  // side now reads every configuration the index holds, so the field is a control an operator can
  // use rather than a way to quietly lose the lexical half of one source.
  const common = { extensions, language: srcForm.elements.language.value, version: srcForm.elements.version.value.trim() };
  if (type === 'local') {
    const rest = $('#src-path')
      .value.trim()
      .replace(/^[\\/]+/, '');
    const root = srcSelectedRoot();
    const path = root ? `${root}/${rest}` : rest;
    if (!path) throw new Error('A directory is required');
    return { path, ...common };
  }
  if (type === 'git') {
    const url = srcForm.elements.url.value.trim();
    if (!url) throw new Error('A repository URL is required');
    return {
      url,
      branch: srcForm.elements.branch.value.trim() || 'main',
      subdir: srcForm.elements.subdir.value.trim().replace(/^[\\/]+|[\\/]+$/g, ''),
      username: srcForm.elements.username.value.trim(),
      ...common,
    };
  }
  if (type === 'notion') {
    const ids = parseNotionIds(srcForm.elements.rootIds.value);
    return { rootIds: ids, ...common };
  }
  if (type === 'web') {
    const entryUrl = srcForm.elements.entryUrl.value.trim();
    if (!entryUrl) throw new Error('An entry point URL is required');
    return { entryUrl, entryKind: srcForm.elements.entryKind.value, ...common };
  }
  if (type === 'confluence') {
    const baseUrl = srcForm.elements.confluenceUrl.value.trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('A Confluence site URL is required');
    return { baseUrl, email: srcForm.elements.confluenceEmail.value.trim(), spaceKeys: parseSpaceKeys(srcForm.elements.spaceKeys.value), ...common };
  }
  return { ...common };
}

/** `{}` keeps the stored token, `{ secret }` replaces it, `{ secret: null }` removes it. */
function secretPatchForKind(kind) {
  const { type } = SOURCE_KINDS[kind];
  if (!CREDENTIALLED.has(type)) return {};
  const row = clearSecretRow(type);
  if (!row.hidden && row.querySelector('input').checked) return { secret: null };
  const value = srcForm.elements[SECRET_FIELD[type]].value.trim();
  return value ? { secret: value } : {};
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

/**
 * The dropzone says which extensions *this source* takes, read off the File types checkboxes above it.
 *
 * It used to be a fixed list in the markup, and a fixed list is wrong whichever list it is: a new
 * upload source defaults to `.md` and `.mdx`, so an operator who read "…, .docx, .pdf" and dropped a
 * PDF was told "unsupported file type" by the line directly under the sentence that invited it.
 */
function renderDropzoneTypes() {
  const types = extensionsFromForm();
  const hint = $('#dropzone-types');
  if (!hint) return;
  hint.textContent =
    (types.length ? `${types.map((e) => `.${e}`).join(', ')} · ` : 'tick a file type above · ') +
    'folders keep their structure · .zip, .tar.gz and .rar are unpacked on the server';
}

function renderQueue(note) {
  renderDropzoneTypes();
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
    ...srcUi.queue.map((i) =>
      el('div', {}, [
        el('span', { text: i.path, title: i.path }),
        el('span', { class: i.status === 'queued' ? '' : i.status, text: QUEUE_LABEL[i.status] }),
      ]),
    ),
    ...srcUi.existingFiles.map((f) =>
      el('div', {}, [el('span', { text: f.path, title: f.path }), el('span', { class: 'ok', text: formatBytes(f.sizeBytes) })]),
    ),
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

for (const tab of srcTabs)
  tab.addEventListener('click', () => {
    setKind(tab.dataset.kind);
    // Only on a tab the operator just pressed, and only while adding: an existing source is filled
    // from its own stored extensions and must keep them.
    const wanted = KIND_EXTENSIONS[tab.dataset.kind];
    if (wanted && !srcUi.editing) for (const box of srcForm.querySelectorAll('input[name="ext"]')) box.checked = wanted.includes(box.value);
  });
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
    const secretPatch = secretPatchForKind(kind);
    const flavor = meta.flavor ?? srcForm.elements.flavor.value;
    const label = srcForm.elements.label.value.trim();
    const pending = srcUi.queue.filter((i) => i.status === 'queued').length;
    let source;

    if (editing) {
      source = await api(`/api/projects/${project.id}/sources/${editing.id}`, {
        method: 'PATCH',
        body: { label, flavor, config, syncIntervalMinutes: syncIntervalFromForm(), ...secretPatch },
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
          syncIntervalMinutes: syncIntervalFromForm(),
          ...(typeof secretPatch.secret === 'string' ? secretPatch : {}), // a new source has nothing to clear
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

// ---------- filter, shortcuts and boot ----------

$('#filter').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
});

document.addEventListener('keydown', (event) => {
  if (
    event.key === 'n' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !dialog.open &&
    !srcDialog.open &&
    state.view === 'projects' &&
    canCreateProject()
  ) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    openCreate();
  }
});

window.addEventListener('hashchange', applyHash);

// A feature module changed something the dashboard shows; it cannot import refresh() back (cycle).
onBus('refresh', () => void refresh());
onBus('render', () => renderAll());

// The footer's version arrives with the first health poll; the year does not have to wait for it.
$('#footer-year').textContent = String(new Date().getFullYear());

/**
 * The server only serves this page to a signed-in account, so `me` is there before the first paint.
 * `booting` keeps the chrome hidden until it is, so no frame shows an empty user menu.
 */
async function boot() {
  clearLegacyToken(); // the Cookie Policy promises this
  initAuthUi();
  initUsersUi();
  initMembersUi();
  initMcpUi();
  await loadMe();
  applyHash();
  document.body.classList.remove('booting');
  await refresh();
}

void boot();
