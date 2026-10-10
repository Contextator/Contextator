import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022): no build
// step and no declarations. Imported anyway, because the copy under a member list is the one place
// the dashboard tells an operator whether membership reaches the MCP endpoint, and a wrong sentence
// there is a security misunderstanding nobody sees until they read it in a browser.
import { renderMembers } from '../public/members.js';
// @ts-expect-error - see above.
import { ACCOUNT_MODE_NOTE } from '../public/mcp.js';
// @ts-expect-error - see above.
import { state } from '../public/core.js';

/**
 * **The Members panel's MCP note follows the project's `mcpAuth` mode, all three of them.**
 *
 * `account` once fell into the same branch as `open` and told an operator that anyone who can reach
 * the endpoint can read the project — the opposite of what the mode does. There is no DOM library in
 * this suite, so `document` is a minimal stand-in: just enough tree to read the rendered text back.
 */

class FakeNode {
  className = '';
  children: Array<FakeNode | string> = [];
  attrs: Record<string, string> = {};
  constructor(readonly tag: string) {}
  set textContent(value: string) {
    this.children = [value];
  }
  set innerHTML(_value: string) {}
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener() {}
  append(...nodes: Array<FakeNode | string>) {
    this.children.push(...nodes);
  }
  get text(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.text)).join('');
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined {
    if (predicate(this)) return this;
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      const hit = c.find(predicate);
      if (hit) return hit;
    }
    return undefined;
  }
}

const MCP_URL = 'https://docs.example/mcp/p/demo';

/** The note under the member list, as `{ text, className }`. */
function noteFor(mcpAuth: string | undefined) {
  const panel: FakeNode = renderMembers({ id: 'p1', name: 'demo', mcpUrl: MCP_URL, mcpAuth });
  const note = panel.find((n) => n.className.split(' ').includes('members-note'));
  if (!note) throw new Error('the Members panel rendered no MCP note');
  return { text: note.text, className: note.className };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeNode(tag) });
  state.members = [];
  state.membersFor = 'p1';
  state.me = { id: 'u1', role: 'admin' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Members panel note, per MCP access mode', () => {
  it('says the endpoint is open to anyone who can reach it in `open` mode', () => {
    const { text, className } = noteFor('open');
    expect(text).toContain('Membership governs the dashboard, not the MCP endpoint.');
    expect(text).toContain('Anyone who can reach');
    expect(text).toContain(MCP_URL);
    expect(className).not.toContain('ok');
  });

  it('says the endpoint is behind a token in `token` mode', () => {
    const { text, className } = noteFor('token');
    expect(text).toContain('The MCP endpoint is behind a token.');
    expect(text).toContain('holding one of this project’s tokens');
    expect(text).not.toContain('Anyone who can reach');
    expect(className).toContain('ok');
  });

  it('says membership is the access in `account` mode, and never calls the endpoint public', () => {
    const { text, className } = noteFor('account');
    expect(text).toContain(ACCOUNT_MODE_NOTE.lead);
    expect(text).toContain(ACCOUNT_MODE_NOTE.body);
    expect(text).toContain('Only accounts listed in Members — and administrators — can reach this endpoint.');
    expect(text).not.toContain('not the MCP endpoint');
    expect(text).not.toContain('Anyone who can reach');
    expect(className).toContain('ok');
  });

  it('falls back to the open note for a mode it does not know', () => {
    expect(noteFor(undefined).text).toContain('Anyone who can reach');
  });
});
