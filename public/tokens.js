// An account's own bearer API tokens at #/~tokens — self-service, gated by nothing but a session
// (ADR-0076): the server accepts these from any signed-in account, because a token can never carry
// more than the account minting it already has. That is also why this view lists only your own
// tokens and offers no way to look at anyone else's.

import { $, ApiError, api, closeDialog, copyText, el, emit, fmt, icon, openDialog, relativeTime, state, toast } from './core.js';

export async function loadApiTokens(force = false) {
  if (!force && state.apiTokensLoaded) return;
  try {
    const tokens = await api('/api/tokens');
    state.apiTokens = tokens;
    state.apiTokensLoaded = true;
    emit('render');
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
  }
}

function tokenStatus(t) {
  if (t.revokedAt) return { text: 'revoked', tone: 'error' };
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return { text: 'expired', tone: 'error' };
  return { text: 'active', tone: 'account' };
}

function projectName(id) {
  if (!id) return 'any project you can reach';
  return state.projects.find((p) => p.id === id)?.name ?? '(deleted project)';
}

export function renderTokensView() {
  const tokens = state.apiTokens;
  const wrap = el('div', {});

  wrap.append(
    el('a', { class: 'back-link', href: '#/', text: '← Projects' }),
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-title' }, [
        el('div', { class: 'title-row' }, [
          el('h1', { text: 'API tokens' }),
          el('span', { class: 'pill idle', text: `${fmt(tokens.length)} token${tokens.length === 1 ? '' : 's'}` }),
        ]),
        el('p', {
          class: 'users-lead',
          text: 'Your own bearer credentials for the admin API — named, revocable, and never wider than your account. Each one narrows to the routes and, optionally, the single project you pick below; a token scoped to only "POST /api/projects/:id/reindex" on one project can do that and nothing else. ADMIN_TOKEN still works for whole-instance automation, but a scoped token here is the recommended way to hand a script or a CI job its own credential.',
        }),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', { type: 'button', class: 'primary', onclick: () => openTokenDialog() }, [icon('plus'), 'New token']),
      ]),
    ]),
  );

  if (!state.apiTokensLoaded) {
    wrap.append(el('p', { class: 'users-empty', text: 'Loading tokens…' }));
    return wrap;
  }

  if (tokens.length === 0) {
    wrap.append(el('p', { class: 'users-empty', text: 'No tokens yet — create one to give a script or CI job its own scoped credential.' }));
    return wrap;
  }

  wrap.append(el('section', { class: 'panel' }, [el('div', { class: 'panel-body' }, tokens.map(tokenRow))]));
  return wrap;
}

function tokenRow(t) {
  const status = tokenStatus(t);
  const revocable = !t.revokedAt;
  const confirming = state.confirmDeleteApiToken === t.id;

  return el('div', { class: 'user-row token-row' }, [
    el('span', { class: 'source-glyph token', 'aria-hidden': 'true', text: 'KEY' }),
    el('span', { class: 'source-cell' }, [el('code', { text: t.prefix }), el('span', { class: 'sub', text: t.name || 'unnamed' })]),
    el('span', { class: 'sub', text: t.scope.join(', '), title: t.scope.join('\n') }),
    el('span', { class: 'sub', text: projectName(t.projectId) }),
    el('span', { class: `pill small ${status.tone}`, text: status.text }),
    el('span', {
      class: 'sub',
      text: t.expiresAt ? `expires ${relativeTime(t.expiresAt)}` : 'no expiry',
      title: t.expiresAt ? new Date(t.expiresAt).toLocaleString() : 'never expires',
    }),
    el(
      'span',
      { class: 'source-actions' },
      revocable
        ? [
            el('button', {
              type: 'button',
              class: `danger small${confirming ? ' confirm' : ''}`,
              text: confirming ? 'Confirm' : 'Revoke',
              onclick: () => (confirming ? revoke(t) : askRevoke(t)),
            }),
          ]
        : [],
    ),
  ]);
}

// ---------- actions ----------

function askRevoke(t) {
  state.confirmDeleteApiToken = t.id;
  emit('render');
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => {
    if (state.confirmDeleteApiToken === t.id) {
      state.confirmDeleteApiToken = null;
      emit('render');
    }
  }, 6000);
}

async function revoke(t) {
  state.confirmDeleteApiToken = null;
  try {
    await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
    toast(`Revoked ${t.name || t.prefix}`);
    await loadApiTokens(true);
  } catch (err) {
    toast(err.message);
    emit('render');
  }
}

// ---------- dialogs ----------

function openTokenDialog() {
  const form = $('#api-token-form');
  form.reset();
  $('#api-token-error').hidden = true;
  const select = form.elements.projectId;
  select.replaceChildren(
    el('option', { value: '', text: 'No restriction — every project you can reach' }),
    ...state.projects.map((p) => el('option', { value: p.id, text: p.name })),
  );
  openDialog($('#api-token-dialog'));
  form.elements.scope.focus();
}

function showTokenSecret(secret) {
  $('#api-token-secret-value').textContent = secret;
  $('#api-token-secret-copy').onclick = () => copyText(secret);
  openDialog($('#api-token-secret-dialog'));
}

export function initTokensUi() {
  const dialog = $('#api-token-dialog');
  const form = $('#api-token-form');
  const errorNode = $('#api-token-error');

  $('#api-token-cancel').addEventListener('click', () => closeDialog(dialog));
  $('#api-token-secret-close').addEventListener('click', () => closeDialog($('#api-token-secret-dialog')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const scope = String(data.get('scope') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (scope.length === 0) {
      errorNode.textContent = 'Enter at least one scope line, like "POST /api/projects/:id/reindex".';
      errorNode.hidden = false;
      return;
    }
    const expiresRaw = String(data.get('expiresAt') || '').trim();
    const submit = $('#api-token-submit');
    submit.disabled = true;
    try {
      const { secret } = await api('/api/tokens', {
        method: 'POST',
        body: {
          name: String(data.get('name') || '').trim(),
          scope,
          projectId: String(data.get('projectId') || '') || null,
          expiresAt: expiresRaw ? new Date(`${expiresRaw}T23:59:59`).toISOString() : null,
        },
      });
      closeDialog(dialog);
      showTokenSecret(secret);
      await loadApiTokens(true);
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}
