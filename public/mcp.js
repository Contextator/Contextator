// Who may reach a project's MCP endpoint, and the tokens that let them.
//
// Two of the three modes are the ones where the dashboard's own permissions stop mattering: a static
// token is a bearer credential for the endpoint itself, so whoever holds it reads the project's
// documents whatever their role here — or without an account at all. `account` is the third
// (ADR-0054), and it is the one where a member's MCP access is their membership. The copy says which
// is which, because the difference is the whole decision this panel is asking the operator to make.

import { $, ApiError, api, closeDialog, copyText, el, emit, openDialog, relativeTime, serverNow, state, toast } from './core.js';
import { canEdit, isAdmin } from './auth.js';

export async function loadMcpTokens(force = false) {
  const project = state.projects.find((p) => p.id === state.selectedId);
  if (!project) {
    state.mcpTokens = [];
    state.mcpTokensFor = null;
    return;
  }
  if (!force && state.mcpTokensFor === project.id) return;
  state.mcpTokensFor = project.id;
  try {
    const tokens = await api(`/api/projects/${project.id}/mcp-tokens`);
    if (state.selectedId !== project.id) return; // selection moved on meanwhile
    state.mcpTokens = tokens;
    emit('render');
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
  }
}

/**
 * The three access modes, in the order they narrow: what the badge says, and what the copy explains.
 *
 * The badge is the same neutral pill for all three (ADR-0065): `open` is a mode an operator chose, not
 * a fault, so it gets no warning colour, icon or wording. `fact` is the badge's tooltip and says only
 * what a client has to present.
 */
const MODES = {
  open: {
    label: 'Open',
    fact: 'Any client that can reach this URL reads this project; no token or account is asked for.',
    blurb:
      'Anyone who can reach this URL can read every document indexed here — no account, no token. No project is created this way: it is a choice, for documentation nobody should have to be anybody to read.',
  },
  token: {
    label: 'Token required',
    fact: "A client has to send one of this project's MCP tokens.",
    blurb:
      'Only a client presenting one of the tokens below can read this project over MCP. A token carries no identity: whoever holds it reads everything indexed here, whatever their role in this dashboard. Revoking one cuts its client off immediately.',
  },
  account: {
    label: 'Account required',
    fact: 'A client has to sign in as an account that is a member of this project.',
    blurb:
      'A client has to sign in as somebody, and it then reads this project only if that account is a member of it. The tokens below stop working here — they name nobody. This is the mode where the memberships on this page reach the MCP endpoint.',
  },
};

const modeOf = (project) => (MODES[project.mcpAuth] ? project.mcpAuth : 'open');

/** The project's MCP access mode as a neutral pill — the project list, the detail header, this panel. */
export function authModeBadge(project, small = false) {
  const mode = modeOf(project);
  return el('span', { class: `pill auth-mode${small ? ' small' : ''}`, title: `MCP access: ${mode}. ${MODES[mode].fact}` }, [
    el('span', { class: 'sr-only', text: 'MCP access: ' }),
    mode,
  ]);
}

/** Lifetimes the API accepts for a static token, in days; an empty choice is a token that never expires. */
export const TOKEN_LIFETIMES = [30, 90, 365];

// By the server's clock, not the browser's: the server is the one that refuses the token.
const isExpired = (t) => Boolean(t.expiresAt) && new Date(t.expiresAt).getTime() <= serverNow();

/** "in 3 h", "in 12 d", or the date once it is further out than a fortnight. */
function timeUntil(iso) {
  const s = Math.round((new Date(iso).getTime() - serverNow()) / 1000);
  const m = Math.round(s / 60);
  if (m < 60) return `in ${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} h`;
  const d = Math.round(h / 24);
  if (d < 14) return `in ${d} d`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}

/** The token's lifetime cell: a pill once it has run out — it stays listed until revoked — a line before. */
function tokenExpiry(t) {
  if (!t.expiresAt) return el('span', { class: 'sub', text: 'no expiry', title: 'Works until it is revoked' });
  const when = new Date(t.expiresAt).toLocaleString();
  if (isExpired(t))
    return el('span', { class: 'pill small error', text: 'expired', title: `Expired ${when}; it is refused — revoke it and mint a new one` });
  return el('span', { class: 'sub', text: `expires ${timeUntil(t.expiresAt)}`, title: `Expires ${when}` });
}

export function renderMcpAccess(project) {
  const mode = modeOf(project);
  const tokens = state.mcpTokensFor === project.id ? state.mcpTokens : [];
  const mayToggle = isAdmin();
  const mayMint = canEdit(project);

  const rows = tokens.map((t) =>
    el('div', { class: 'user-row token-row mcp-token-row' }, [
      el('span', { class: 'source-glyph token', 'aria-hidden': 'true', text: 'KEY' }),
      el('span', { class: 'source-cell' }, [el('code', { text: t.prefix }), el('span', { class: 'sub', text: t.name || 'unnamed' })]),
      // Third, so it is still on screen when a narrow layout drops the columns after it.
      tokenExpiry(t),
      el('span', { class: 'sub', text: `created ${relativeTime(t.createdAt)}` }),
      el('span', { class: 'sub', text: t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : 'never used' }),
      el(
        'span',
        { class: 'source-actions' },
        mayMint ? [el('button', { type: 'button', class: 'danger small', text: 'Revoke', onclick: () => revoke(project, t) })] : [],
      ),
    ]),
  );

  return el('section', { class: 'panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [el('h3', {}, ['MCP access ', authModeBadge(project, true)]), el('p', { text: MODES[mode].blurb })]),
      // Three modes, so this is a choice and no longer a toggle: a two-state button would have to
      // pick which of the other two it means, and an operator would find out by pressing it.
      mayToggle
        ? el(
            'div',
            { class: 'source-actions' },
            Object.entries(MODES)
              .filter(([key]) => key !== mode)
              .map(([key, meta]) => el('button', { type: 'button', class: 'ghost small', text: meta.label, onclick: () => setMode(project, key) })),
          )
        : null,
    ]),

    // A `token` project with no live token is unreachable; say so where the mistake is made. An expired
    // token is still listed, but it opens nothing.
    mode === 'token' && !tokens.some((t) => !isExpired(t))
      ? el('p', { class: 'members-note' }, [
          el('strong', { text: 'No token, no access. ' }),
          tokens.length
            ? 'This project requires a token and every token it has has expired, so nothing can connect to it right now.'
            : 'This project requires a token and has none, so nothing can connect to it right now.',
        ])
      : null,

    // The same mistake one mode along, and a different remedy: tokens do not help here.
    mode === 'account'
      ? el('p', { class: 'members-note' }, [
          el('strong', { text: 'Membership is the access. ' }),
          'Only accounts listed in Members — and administrators — can reach this endpoint. The tokens below do not open it.',
        ])
      : null,

    rows.length ? el('div', {}, rows) : null,

    mayMint
      ? el('div', { class: 'token-foot' }, [
          el('button', { type: 'button', class: 'ghost small', text: 'New token', onclick: () => openTokenDialog(project) }),
          el('span', { class: 'field-hint', text: 'Shown once when it is created; the server keeps only a hash.' }),
        ])
      : null,
  ]);
}

/** The header an MCP client has to send. Used by the connect snippets and the created-token dialog. */
export const authHeaderFor = (secret) => `Authorization: Bearer ${secret ?? '<your token>'}`;

// ---------- actions ----------

const MODE_TOAST = {
  open: (name) => `${name} is open again`,
  token: (name) => `${name} now requires an MCP token`,
  account: (name) => `${name} now requires an account that is a member of it`,
};

async function setMode(project, mode) {
  try {
    await api(`/api/projects/${project.id}/mcp-auth`, { method: 'PATCH', body: { mode } });
    project.mcpAuth = mode; // optimistic: the poll would take up to 15 s to catch up
    toast(MODE_TOAST[mode](project.name));
    await loadMcpTokens(true);
    emit('refresh');
  } catch (err) {
    toast(err.message);
  }
}

async function revoke(project, token) {
  try {
    await api(`/api/projects/${project.id}/mcp-tokens/${token.id}`, { method: 'DELETE' });
    toast(`Revoked ${token.name || token.prefix}`);
    await loadMcpTokens(true);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- dialogs ----------

let dialogProject = null;

function openTokenDialog(project) {
  dialogProject = project;
  const form = $('#token-form');
  form.reset();
  $('#token-error').hidden = true;
  openDialog($('#token-dialog'));
  form.elements.name.focus();
}

/**
 * The one moment the token exists outside the client's config, so hand over something pasteable.
 *
 * Exported because there are two such moments now: minting one from the panel below, and creating a
 * project — which since ADR-0065 is born requiring a token and is handed its first one with it.
 */
export function showMcpSecret(project, secret) {
  const id = `${project.name}-docs`;
  const url = project.mcpUrl;
  $('#token-secret-value').textContent = secret;
  $('#token-secret-copy').onclick = () => copyText(secret);

  const claudeCode = `claude mcp add --transport http ${id} ${url} \\\n  --header "${authHeaderFor(secret)}"`;
  const cursor = JSON.stringify({ mcpServers: { [id]: { url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
  $('#token-snippet-cli').textContent = claudeCode;
  $('#token-snippet-cli-copy').onclick = () => copyText(claudeCode);
  $('#token-snippet-json').textContent = cursor;
  $('#token-snippet-json-copy').onclick = () => copyText(cursor);

  openDialog($('#token-secret-dialog'));
}

export function initMcpUi() {
  const dialog = $('#token-dialog');
  const form = $('#token-form');
  const errorNode = $('#token-error');

  $('#token-cancel').addEventListener('click', () => closeDialog(dialog));
  $('#token-secret-close').addEventListener('click', () => closeDialog($('#token-secret-dialog')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    const submit = $('#token-submit');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const days = Number(data.get('expiresInDays'));
      const { secret } = await api(`/api/projects/${dialogProject.id}/mcp-tokens`, {
        method: 'POST',
        body: { name: String(data.get('name')).trim(), expiresInDays: TOKEN_LIFETIMES.includes(days) ? days : null },
      });
      closeDialog(dialog);
      showMcpSecret(dialogProject, secret);
      await loadMcpTokens(true);
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}
