// Shared building blocks of the Contextator dashboard — plain ES module, no build step.
// Everything here is used by more than one of app.js / auth.js / users.js / members.js.

const TOKEN_KEY = 'contextator_admin_token';

export const ICON = {
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
  trash:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
};

export const $ = (sel) => document.querySelector(sel);

export const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html')
      node.innerHTML = v; // static icon markup only, never user data
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
};

export const icon = (name) => el('span', { class: 'icon-wrap', html: ICON[name], 'aria-hidden': 'true' });

/**
 * One object shared by every module. Feature modules read and write their own keys;
 * `bus` below is how they ask app.js to re-render without importing it back (that would be a cycle).
 */
export const state = {
  me: null, // { id, username, displayName, role, mustChangePassword, projects: { <id>: 'viewer'|'editor' } }
  view: 'projects', // 'projects' | 'users' | 'audit' | 'tokens'
  projects: [],
  health: null,
  selectedId: null,
  runs: [], // index-run history of the selected project
  runsFor: null, // project id the runs belong to
  runsStamp: null, // finishedAt of the newest job seen; refetch when it changes
  sources: [], // document sources of the selected project
  sourcesFor: null,
  sourcesStamp: null,
  members: [], // project members of the selected project
  membersFor: null,
  mcpTokens: [], // MCP tokens of the selected project
  mcpTokensFor: null,
  users: [], // the account list, only while the users view is open
  usersLoaded: false,
  apiTokens: [], // the signed-in account's own bearer API tokens (ADR-0076), only while ~tokens is open
  apiTokensLoaded: false,
  confirmDeleteSource: null,
  confirmDeleteUser: null,
  confirmDeleteApiToken: null,
  filter: '',
  connectTab: 0,
  /**
   * The search panel (search.js), whole. app.js rebuilds #detail on every poll, so a query typed
   * into the DOM would be thrown away a second or two later — the caret and the focus flag are here
   * for the same reason, and `projectId` is what clears the hits when the selection moves.
   */
  search: {
    projectId: null,
    query: '',
    limit: 5,
    /**
     * The filters search_docs takes, so the panel asks what an agent can ask — the first two from
     * ADR-0042, `version` from ADR-0058.
     */
    source: '',
    pathPrefix: '',
    version: '',
    caret: 0,
    focused: false,
    status: 'idle', // 'idle' | 'searching' | 'done' | 'error'
    error: '',
    ranQuery: '', // the query the hits below actually answer
    hits: [],
    /** Whether the agent would have been told "no good match" instead of the hits below. */
    belowFloor: false,
    scoreFloor: 0,
  },
  /**
   * The query-log panel (queries.js), whole, and here for the same reason state.search is: app.js
   * rebuilds #detail on every poll, so a chosen tab, a window length or a picked retrieval
   * configuration held in the DOM would be thrown away a second or two later — while somebody is
   * reading the table it belongs to.
   */
  queries: {
    projectId: null,
    tab: 'questions', // 'questions' | 'documents' | 'chunks' | 'volume'
    days: 7,
    actor: 'mcp',
    /** `<model>@<generation>`, or null for whichever configuration the server picked. */
    configKey: null,
    /** The request the data in hand answers; a change of any part of it is what refetches. */
    loadedKey: null,
    loadedAt: null,
    status: 'idle', // 'idle' | 'loading' | 'done' | 'error'
    error: '',
    data: null,
    confirmPurge: false,
  },
  /**
   * The audit panel (audit.js), whole, and here for the reason state.search and state.queries are:
   * app.js rebuilds #detail on every poll, so a chosen filter, the page somebody has paged to, and
   * the control they are typing into would all be thrown away a second or two later.
   *
   * Every key the panel reads is declared here rather than assembled on the fly, and
   * test/dashboard-wiring.test.ts checks that the two files still agree — a `state.audit.actorName`
   * that nothing declares reads `undefined` in the browser and fails nowhere else.
   */
  audit: {
    /** The four filters, exactly as the endpoint takes them. `''` means "not filtering by this". */
    actor: '',
    project: '', // a project id, or 'none' for the events that belong to no project
    action: '',
    from: '', // YYYY-MM-DD, UTC — the panel says so beside the inputs
    to: '',
    /** The cursor of the page on screen, and the stack of the ones behind it, so Newer can go back. */
    cursor: null,
    back: [],
    nextCursor: null,
    /** The request the rows in hand answer; a change of any part of it is what refetches. */
    loadedKey: null,
    loadedAt: null,
    status: 'idle', // 'idle' | 'loading' | 'done' | 'error'
    error: '',
    events: [],
    /** The distinct actors, actions and projects the pickers offer; kept from the last unpaged load. */
    filters: null,
    retentionDays: null,
    /** Which control had focus when the last rebuild wiped the panel, and where its caret was. */
    focusKey: null,
    caret: 0,
  },
  confirmDelete: null,
  confirmTimer: null,
  timer: null,
  redirecting: false,
};

/** Feature modules `emit('refresh')`; app.js listens. Keeps the import graph a DAG. */
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const onBus = (type, fn) => bus.addEventListener(type, fn);

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Sends the browser to the sign-in page once, keeping where we were so it can come back.
 * Guarded because the poll timer and several in-flight requests can all see the same 401.
 */
export function gotoLogin() {
  if (state.redirecting) return;
  state.redirecting = true;
  clearTimeout(state.timer);
  toast('Session expired — signing in again');
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  setTimeout(() => location.replace(`/login?next=${next}`), 800);
}

/** The server locks every other endpoint until a temporary password has been replaced. */
export function gotoChangePassword() {
  if (state.redirecting) return;
  state.redirecting = true;
  clearTimeout(state.timer);
  location.replace('/change-password');
}

async function readBody(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Session lives in an HttpOnly cookie the browser attaches by itself; no header to add. */
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    gotoLogin();
    throw new ApiError(401, { message: 'Not signed in' });
  }
  if (res.status === 204) return null;
  const json = await readBody(res);
  if (res.status === 403 && json?.error === 'password_change_required') gotoChangePassword();
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

/** Multipart sibling of api(): FormData sets its own content-type boundary. */
export async function postForm(path, form) {
  const headers = { accept: 'application/json' };
  const res = await fetch(path, { method: 'POST', headers, body: form });
  if (res.status === 401) {
    gotoLogin();
    throw new ApiError(401, { message: 'Not signed in' });
  }
  const json = await readBody(res);
  if (res.status === 403 && json?.error === 'password_change_required') gotoChangePassword();
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

/** Older versions kept the admin token here; the Cookie Policy promises the dashboard clears it. */
export function clearLegacyToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode etc.) */
  }
}

// ---------- formatting ----------

export function relativeTime(iso) {
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

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** First line of an error, shortened for the project list. */
export function shortError(message, max = 40) {
  const line = String(message || '')
    .split('\n')[0]
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const fmt = (n) => new Intl.NumberFormat().format(n ?? 0);

export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Up to two letters for an avatar; falls back to the first character of whatever we have. */
export function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return letters.toUpperCase();
}

// ---------- shared widgets ----------

export function stat(label, value, sub, title, mono = false, warn = false) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'label', text: label }),
    el('span', { class: `value${mono ? ' mono' : ''}`, text: value, title: title || undefined }),
    sub ? el('span', { class: `sub${warn ? ' warn' : ''}`, text: sub }) : null,
  ]);
}

let toastTimer;
export function toast(message) {
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

export async function copyText(text) {
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

/** A dialog that works whether or not the browser implements showModal(). */
export function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

export function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}
