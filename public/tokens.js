// An account's own bearer API tokens at #/~tokens — self-service, gated by nothing but a session
// (ADR-0076): the server accepts these from any signed-in account, because a token can never carry
// more than the account minting it already has. That is also why this view lists only your own
// tokens and offers no way to look at anyone else's.

import { $, ApiError, api, closeDialog, copyText, el, emit, fmt, icon, openDialog, relativeTime, state, toast } from './core.js';

/**
 * Where a linking flow started from this page comes back to. `safeNext` (src/auth/safe-next.ts)
 * requires a leading `/`; a bare `#...` fragment fails that check and collapses to `/`, silently losing
 * the return-to-tokens-page destination ([T3-MINOR-2], tur 3 review). Exported and named so
 * `test/integration/oidc.itest.ts` reads this exact value instead of repeating it ([T4-MINOR-3]).
 */
export const TOKENS_RETURN_PATH = '/#/~tokens';

/**
 * The server's explanation of the last refused unlink ([ADR-0081](../.ssot/ADR.md#adr-0081) §3), kept
 * so the SSO panel can show it under the link that is still there. Cleared once a link is gone.
 */
let unlinkRefusal = null;

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
  } else {
    wrap.append(el('section', { class: 'panel' }, [el('div', { class: 'panel-body' }, tokens.map(tokenRow))]));
  }

  // Rendered whether or not this account has any tokens: the SSO panel is not about tokens, and an
  // early return above used to hide it from every account that had none.
  const sso = renderSsoPanel();
  if (sso) wrap.append(sso);

  return wrap;
}

/**
 * Self-service link/unlink for the account's single sign-on identity ([MAJOR-2], tur 3 review of
 * [ADR-0077](../.ssot/ADR.md#adr-0077)) — same panel/row/confirm-before-destroy shapes as the API
 * tokens list above. `null` when this instance has no OIDC provider configured, or before the first
 * `/api/auth/me` poll has resolved (`state.me` starts out `null` — see core.js), so the caller can
 * skip appending it rather than rendering an empty panel.
 */
function renderSsoPanel() {
  const me = state.me;
  if (!me?.oidc?.enabled) return null;

  const label = me.oidc.buttonLabel || 'your identity provider';
  const body = [];

  const providers = [...new Set(me.federatedProviders)];
  if (providers.length === 0) unlinkRefusal = null;

  if (providers.length > 0) {
    // Offered to root too ([T4-MINOR-2]): an account promoted after it linked keeps a dormant link it
    // cannot sign in with, and the server lets it remove that link — so the page must as well.
    const confirming = state.confirmUnlinkOidc;
    const sub = !me.canLinkOidc
      ? 'Linked before this account became root. Root signs in with its password only, so this link is unused — remove it to tidy up.'
      : 'Connected — you can also sign in with this identity provider. Remove disconnects every identity linked to this account.';
    body.push(
      el('div', { class: 'user-row token-row' }, [
        el('span', { class: 'source-glyph token', 'aria-hidden': 'true', text: 'SSO' }),
        el('span', { class: 'source-cell' }, [el('span', { text: `Linked: ${providers.join(', ')}` }), el('span', { class: 'sub', text: sub })]),
        el('span', { class: 'source-actions' }, [
          el('button', {
            type: 'button',
            class: `danger small${confirming ? ' confirm' : ''}`,
            text: confirming ? 'Confirm' : 'Remove',
            onclick: () => (confirming ? unlinkOidc() : askUnlinkOidc()),
          }),
        ]),
      ]),
    );
    if (unlinkRefusal) body.push(el('p', { class: 'users-lead', role: 'alert', text: unlinkRefusal }));
  } else if (!me.canLinkOidc) {
    // The root account stays local — ADR-0077 and the server both refuse this, so the UI never even
    // offers the control ([MAJOR-4], tur 3 review).
    body.push(el('p', { class: 'users-lead', text: 'The root account stays local and cannot connect single sign-on.' }));
  } else {
    body.push(
      el('p', { class: 'users-lead', text: `Connect your account to ${label} to sign in without a password.` }),
      el('button', { type: 'button', class: 'primary', text: `Connect ${label}`, onclick: () => linkOidc() }),
    );
  }

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: 'Single sign-on' }),
      el('p', { text: "Link this account to your organization's identity provider, or remove an existing link." }),
    ]),
    el('div', { class: 'panel-body' }, body),
  ]);
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

/**
 * Starts the link flow: `POST /api/auth/oidc/link` (a state-changing request, not `GET` — [MAJOR-1],
 * tur 3 review) returns `{ url }` rather than a redirect precisely so this can navigate the whole tab
 * itself; `api()`'s `fetch` would otherwise just follow a 302 in the background and the browser would
 * never actually reach the provider.
 */
async function linkOidc() {
  try {
    const { url } = await api('/api/auth/oidc/link', { method: 'POST', body: { next: TOKENS_RETURN_PATH } });
    location.href = url;
  } catch (err) {
    toast(err.message);
  }
}

function askUnlinkOidc() {
  state.confirmUnlinkOidc = true;
  emit('render');
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => {
    if (state.confirmUnlinkOidc) {
      state.confirmUnlinkOidc = false;
      emit('render');
    }
  }, 6000);
}

async function unlinkOidc() {
  state.confirmUnlinkOidc = false;
  try {
    await api('/api/auth/oidc/link', { method: 'DELETE' });
    unlinkRefusal = null;
    toast('Single sign-on disconnected');
    emit('refresh'); // refetches /api/auth/me so state.me.federatedProviders drops the removed identity
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body?.error === 'last_sign_in_method') {
      // ADR-0081 §3: not a bare error. Nothing was removed and this session is still live, so the page
      // stays where it is and says why, and what would make the removal possible.
      unlinkRefusal =
        'This account has no password of its own, so removing single sign-on would leave it with no way to sign in. Ask an admin to set a password for it; after that you can remove the link here.';
      toast('Single sign-on was not removed');
    } else {
      toast(err.message);
    }
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
