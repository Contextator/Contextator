import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
import {
  loadNotionOAuth,
  notionConnection,
  notionOAuthOutcome,
  renderNotionConnect,
  showNotionWebhook,
  startNotionOAuth,
  // @ts-expect-error - see above.
} from '../public/notion-oauth.js';
import { actionLabels, descendants, fakeDocument, type FakeNode } from './helpers/fake-dom.js';

/**
 * **"Connect with Notion" is drawn only where the server says the flow is on, and what a connected
 * source shows is its workspace and a way back in — never a token** ([ADR-0129](../.ssot/ADR.md#adr-0129)).
 *
 * The panel asks the server (`GET /api/sources/notion/oauth`) the way the login page asks for
 * `oidc.enabled`, so these cases drive the render function from that answer and from the source the
 * admin API returns, with the smallest DOM `el()` needs.
 */

// The shape the admin API returns for each kind of Notion source (`toSourceView`): no secret, ever.
const ID = '00000000-0000-4000-8000-0000000000c1';
const oauthSource = {
  id: ID,
  type: 'notion',
  name: 'wiki',
  hasSecret: true,
  config: { rootIds: [], oauth: { workspaceId: 'ws-1', workspaceName: 'Acme Docs', botId: 'bot-1' } },
};
const tokenSource = { id: ID, type: 'notion', name: 'wiki', hasSecret: true, config: { rootIds: [] } };
const importedOauthSource = { ...oauthSource, hasSecret: false };

const text = (tree: FakeNode | null) =>
  tree
    ? descendants(tree)
        .map((n) => n.textContent)
        .join(' ')
    : '';

beforeEach(() => {
  vi.stubGlobal('document', fakeDocument());
  state.notionOAuth = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the button for a new source', () => {
  it('is absent when the instance has not configured Notion OAuth', () => {
    expect(renderNotionConnect({ source: null, enabled: false, onStart: () => {} })).toBeNull();
  });

  it('is present when it has, and starts a flow for a new source', () => {
    const onStart = vi.fn();
    const box = renderNotionConnect({ source: null, enabled: true, onStart }) as FakeNode;
    expect(actionLabels(box)).toEqual(['Connect with Notion']);
    const button = descendants(box).find((n) => n.tag === 'button')!;
    (button.listeners.get('click') as () => void)();
    // No source id: the dialog collects the name and root pages itself.
    expect(onStart).toHaveBeenCalledWith(undefined);
  });

  it('is not drawn for a viewer, who cannot create the source it would create', () => {
    expect(renderNotionConnect({ source: null, enabled: true, readOnly: true, onStart: () => {} })).toBeNull();
  });
});

describe('a source connected with OAuth', () => {
  it('shows its workspace and a Reconnect that starts the flow for this source', () => {
    const onStart = vi.fn();
    const box = renderNotionConnect({ source: oauthSource, enabled: true, onStart }) as FakeNode;
    expect(text(box)).toContain('workspace: Acme Docs');
    expect(actionLabels(box)).toEqual(['Reconnect']);
    (
      descendants(box)
        .find((n) => n.tag === 'button')!
        .listeners.get('click') as () => void
    )();
    expect(onStart).toHaveBeenCalledWith(ID);
  });

  it('has no webhook section; an integration-token source does', () => {
    expect(showNotionWebhook(oauthSource)).toBe(false);
    expect(showNotionWebhook(tokenSource)).toBe(true);
    expect(showNotionWebhook(importedOauthSource)).toBe(false);
  });

  it('keeps the workspace visible, and says why it cannot be reconnected, when the operator turned the flow off', () => {
    const box = renderNotionConnect({ source: oauthSource, enabled: false, onStart: () => {} }) as FakeNode;
    expect(text(box)).toContain('workspace: Acme Docs');
    expect(actionLabels(box)).toEqual([]);
    expect(text(box)).toContain('not configured');
  });

  it('does not offer Reconnect to a viewer', () => {
    const box = renderNotionConnect({ source: oauthSource, enabled: true, readOnly: true, onStart: () => {} }) as FakeNode;
    expect(actionLabels(box)).toEqual([]);
    expect(text(box)).toContain('workspace: Acme Docs');
  });

  it('asks an imported source, which lost its credential with the export, to reconnect', () => {
    expect(notionConnection(importedOauthSource)).toMatchObject({ kind: 'reconnect', workspace: 'Acme Docs' });
    const box = renderNotionConnect({ source: importedOauthSource, enabled: true, onStart: () => {} }) as FakeNode;
    expect(actionLabels(box)).toEqual(['Reconnect']);
    expect(text(box)).not.toContain('Connected with Notion');
  });

  it('never puts a token in what it renders', () => {
    // The admin API sends none, but the panel should not be the thing that would show one if it did.
    const leaky = { ...oauthSource, secret: 'ntn_not-a-real-token', accessToken: 'stub-access-1', refreshToken: 'stub-refresh-1' };
    const rendered = [
      renderNotionConnect({ source: leaky, enabled: true, onStart: () => {} }),
      renderNotionConnect({ source: null, enabled: true, onStart: () => {} }),
    ]
      .map((box) => text(box as FakeNode))
      .join(' ');
    for (const secret of ['ntn_not-a-real-token', 'stub-access-1', 'stub-refresh-1']) expect(rendered).not.toContain(secret);
  });
});

describe('a source with a pasted integration token', () => {
  it('shows no connection box: the token field is the whole of it', () => {
    expect(notionConnection(tokenSource)).toBeNull();
    expect(renderNotionConnect({ source: tokenSource, enabled: true, onStart: () => {} })).toBeNull();
    expect(renderNotionConnect({ source: tokenSource, enabled: false, onStart: () => {} })).toBeNull();
  });
});

describe('asking the server', () => {
  it('reads the enabled flag once and remembers it', async () => {
    const fetchSpy = vi.fn(async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => '{"enabled":true}' }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await loadNotionOAuth()).toBe(true);
    expect(await loadNotionOAuth()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.notionOAuth).toEqual({ enabled: true });
  });

  it('treats a failed read as "not offered"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadNotionOAuth()).toBe(false);
  });

  it('posts the new source’s fields, or the source to reconnect, and returns Notion’s URL', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return { status: 200, ok: true, headers: new Headers(), text: async () => '{"url":"https://api.notion.com/v1/oauth/authorize?x=1"}' };
      }),
    );
    expect(await startNotionOAuth('p1', { name: 'wiki', rootIds: [] })).toBe('https://api.notion.com/v1/oauth/authorize?x=1');
    await startNotionOAuth('p1', { sourceId: ID });
    expect(bodies).toEqual([{ name: 'wiki', rootIds: [] }, { sourceId: ID }]);
  });
});

describe('how the round trip is reported', () => {
  it('has a sentence for each outcome the callback sends, and none for anything else', () => {
    for (const outcome of ['connected', 'reconnected', 'denied', 'failed', 'expired', 'forbidden', 'name_taken']) {
      expect(notionOAuthOutcome(`?notion_oauth=${outcome}`), outcome).toEqual(expect.any(String));
    }
    expect(notionOAuthOutcome('?notion_oauth=<script>')).toBeNull();
    expect(notionOAuthOutcome('?notion_oauth=constructor')).toBeNull();
    expect(notionOAuthOutcome('')).toBeNull();
  });
});
