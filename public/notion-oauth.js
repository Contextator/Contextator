// Notion OAuth in the source dialog (ADR-0129): "Connect with Notion" for a new source, the workspace
// and "Reconnect" for one that is connected, and which parts of the dialog an OAuth source does not have.
//
// Nothing here ever holds a token. The server answers `hasSecret` and, for an OAuth source, the
// workspace's name and ids (`config.oauth`); the tokens never leave `secret_enc`.

import { api, el, state, toast } from './core.js';

/**
 * Whether this instance offers the flow, asked of the server (`NOTION_OAUTH_CLIENT_ID`/`_SECRET` set), the
 * way the login page asks `oidc.enabled`. A failed read is "no": the pasted-token path is always there.
 */
export async function loadNotionOAuth(force = false) {
  if (!force && state.notionOAuth) return state.notionOAuth.enabled;
  let enabled = false;
  try {
    enabled = (await api('/api/sources/notion/oauth'))?.enabled === true;
  } catch {
    enabled = false;
  }
  state.notionOAuth = { enabled };
  return enabled;
}

export const notionOAuthEnabled = () => state.notionOAuth?.enabled === true;

/**
 * How a Notion source is connected. `connected` has the workspace it was authorised in; `reconnect` is a
 * source that says it is an OAuth one but holds no credential (a project import drops secrets), which
 * the same Reconnect flow repairs. `null` is an integration token, or a source of another type.
 */
export function notionConnection(source) {
  if (!source || source.type !== 'notion') return null;
  const oauth = source.config?.oauth;
  if (!oauth) return null;
  return {
    kind: source.hasSecret ? 'connected' : 'reconnect',
    workspace: oauth.workspaceName || oauth.workspaceId || 'unnamed workspace',
  };
}

/**
 * A public connection's webhook belongs to the connection and not to one source, so an OAuth source has
 * none in 0.6; it is kept fresh by the probe and the maximum age (ADR-0129 decision 6).
 */
export const showNotionWebhook = (source) => notionConnection(source) === null;

/**
 * The box above the token field. `onStart(sourceId?)` is called by the buttons; it is the dialog's to
 * decide what a click collects from the form. Returns `null` when there is nothing to show.
 */
export function renderNotionConnect({ source = null, enabled = notionOAuthEnabled(), readOnly = false, onStart }) {
  const connection = notionConnection(source);
  const button = (label, sourceId) => el('button', { type: 'button', class: 'ghost small', text: label, onclick: () => onStart(sourceId) });

  if (connection) {
    const status =
      connection.kind === 'connected'
        ? `Connected with Notion — workspace: ${connection.workspace}`
        : `This source was connected to the workspace “${connection.workspace}”, but holds no credential now (a project import drops them). Reconnect to authorise it again.`;
    const parts = [el('p', { class: 'field-hint notion-oauth-status', text: status })];
    if (enabled && !readOnly) parts.push(button('Reconnect', source.id));
    else if (!enabled)
      parts.push(
        el('p', { class: 'field-hint', text: 'Notion OAuth is not configured on this instance, so this source cannot be reconnected here.' }),
      );
    return el('div', { class: 'notion-oauth-box' }, parts);
  }
  // Only a new source is offered the flow: switching a source that already has a pasted token is a
  // decision for its owner, made by replacing the token or removing it.
  if (source || !enabled || readOnly) return null;
  return el('div', { class: 'notion-oauth-box' }, [
    button('Connect with Notion'),
    el('p', {
      class: 'field-hint',
      text: 'Authorise Contextator in Notion and pick the pages to share, instead of pasting an integration token. A source connected this way has no webhook; it is kept fresh by the schedule.',
    }),
  ]);
}

/** Asks the server to start the flow; resolves to the Notion URL the caller sends the browser to. */
export async function startNotionOAuth(projectId, body) {
  const result = await api(`/api/projects/${encodeURIComponent(projectId)}/sources/notion/oauth`, { method: 'POST', body });
  return result.url;
}

const OUTCOMES = {
  connected: 'Connected to Notion — the first sync is queued',
  reconnected: 'Reconnected to Notion — a sync is queued',
  denied: 'Notion connection cancelled — nothing was changed',
  failed: 'Notion refused the connection — nothing was changed. Try again',
  expired: 'The Notion connection took too long or did not start from this browser \u2014 nothing was changed. Start it again',
  forbidden: 'You can no longer connect Notion to that project from this session \u2014 nothing was changed',
  name_taken: 'A source with that name already exists — choose another name and connect again',
};

/** The sentence for the `?notion_oauth=` outcome the callback redirected back with, or `null`. */
export function notionOAuthOutcome(search) {
  const value = new URLSearchParams(search).get('notion_oauth');
  return value && Object.hasOwn(OUTCOMES, value) ? OUTCOMES[value] : null;
}

/** Says how the round trip ended and takes the outcome out of the address bar so a reload does not repeat it. */
export function announceNotionOAuthOutcome() {
  const message = notionOAuthOutcome(location.search);
  if (!new URLSearchParams(location.search).has('notion_oauth')) return;
  const params = new URLSearchParams(location.search);
  params.delete('notion_oauth');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  if (message) toast(message);
}
