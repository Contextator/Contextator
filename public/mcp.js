// Who may reach a project's MCP endpoint, and the tokens that let them.
//
// This is the one panel where the dashboard's own permissions stop mattering: a token is a bearer
// credential for the endpoint itself, so whoever holds it reads the project's documents whatever
// their role here — or without an account at all. The copy says so.

import { $, ApiError, api, closeDialog, copyText, el, emit, openDialog, relativeTime, state, toast } from './core.js';
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

export function renderMcpAccess(project) {
  const locked = project.mcpAuth === 'token';
  const tokens = state.mcpTokensFor === project.id ? state.mcpTokens : [];
  const mayToggle = isAdmin();
  const mayMint = canEdit(project);

  const rows = tokens.map((t) =>
    el('div', { class: 'user-row token-row' }, [
      el('span', { class: 'source-glyph token', 'aria-hidden': 'true', text: 'KEY' }),
      el('span', { class: 'source-cell' }, [el('code', { text: t.prefix }), el('span', { class: 'sub', text: t.name || 'unnamed' })]),
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
      el('div', {}, [
        el('h3', {}, ['MCP access ', el('span', { class: `pill small ${locked ? 'idle' : 'error'}`, text: locked ? 'token required' : 'open' })]),
        el('p', {
          text: locked
            ? 'Only a client presenting one of the tokens below can read this project over MCP. Revoking a token cuts its client off immediately.'
            : 'Anyone who can reach this URL can read every document indexed here — no account, no token. That is the historical behaviour; require a token to change it.',
        }),
      ]),
      mayToggle
        ? el('button', {
            type: 'button',
            class: locked ? 'ghost small' : 'primary small',
            text: locked ? 'Make open again' : 'Require a token',
            onclick: () => setMode(project, locked ? 'open' : 'token'),
          })
        : null,
    ]),

    // A locked project with no live token is unreachable; say so where the mistake is made.
    locked && rows.length === 0
      ? el('p', { class: 'members-note' }, [
          el('strong', { text: 'No token, no access. ' }),
          'This project requires a token and has none, so nothing can connect to it right now.',
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

async function setMode(project, mode) {
  try {
    await api(`/api/projects/${project.id}/mcp-auth`, { method: 'PATCH', body: { mode } });
    project.mcpAuth = mode; // optimistic: the poll would take up to 15 s to catch up
    toast(mode === 'token' ? `${project.name} now requires an MCP token` : `${project.name} is open again`);
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

/** The one moment the token exists outside the client's config, so hand over something pasteable. */
function showSecret(project, secret) {
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
      const { secret } = await api(`/api/projects/${dialogProject.id}/mcp-tokens`, {
        method: 'POST',
        body: { name: String(new FormData(form).get('name')).trim() },
      });
      closeDialog(dialog);
      showSecret(dialogProject, secret);
      await loadMcpTokens(true);
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}
