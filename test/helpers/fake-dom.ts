/**
 * Just enough of a DOM for the panel's own `el()` to build a tree in a test that has no browser: elements
 * keep their tag, attributes and children, and a test can then ask what a role is shown. It is not a
 * DOM — no layout, no selectors, no events beyond the listeners it records — and that is the point: the
 * panel's render functions decide what to show from state alone, so state in, tree out is all they need.
 */

export class FakeNode {
  readonly tag: string;
  className = '';
  innerHTML = '';
  readonly attrs = new Map<string, string>();
  readonly children: Array<FakeNode | string> = [];
  readonly listeners = new Map<string, unknown>();
  private own = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  get textContent(): string {
    return this.own + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(value: string) {
    this.own = value;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, listener);
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) this.children.push(node);
  }
}

/** Installs `document.createElement` for the current test file; undo with `vi.unstubAllGlobals()`. */
export function fakeDocument(): { createElement: (tag: string) => FakeNode; querySelector: () => null } {
  return { createElement: (tag) => new FakeNode(tag), querySelector: () => null };
}

export function descendants(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  const visit = (node: FakeNode) => {
    out.push(node);
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  visit(root);
  return out;
}

/** The visible labels of every button and link under `root`, in document order. */
export function actionLabels(root: FakeNode): string[] {
  return descendants(root)
    .filter((n) => n.tag === 'button' || n.tag === 'a')
    .map((n) => n.textContent.trim());
}
