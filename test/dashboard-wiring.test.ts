import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The dashboard has no build step, so nothing links its JavaScript to its HTML: a renamed id or a
 * dialog that was never added fails silently in the browser, at the moment someone clicks. These
 * tests are that missing link.
 */

const PUBLIC = new URL('../public/', import.meta.url);

const idsIn = (html: string): Set<string> => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const selectorsIn = (js: string): string[] => [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);

async function dashboardModules(): Promise<string[]> {
  const files = await readdir(PUBLIC);
  // auth-page.js belongs to /login, /setup and /change-password, which have their own markup.
  return files.filter((f) => f.endsWith('.js') && f !== 'auth-page.js');
}

describe('the dashboard markup and its modules agree', () => {
  it('has an element for every id the modules look up', async () => {
    const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
    const ids = idsIn(html);

    const missing: string[] = [];
    for (const file of await dashboardModules()) {
      const js = await readFile(new URL(file, PUBLIC), 'utf8');
      for (const id of selectorsIn(js)) if (!ids.has(id)) missing.push(`${file}: #${id}`);
    }
    expect(missing).toEqual([]);
  });

  it('wires up the MCP token dialogs the access panel opens', async () => {
    const ids = idsIn(await readFile(new URL('index.html', PUBLIC), 'utf8'));
    for (const id of ['token-dialog', 'token-form', 'token-cancel', 'token-submit', 'token-error']) expect(ids).toContain(id);
    // The secret is shown once; every part of that dialog has to exist or the token is lost.
    for (const id of ['token-secret-dialog', 'token-secret-value', 'token-secret-copy', 'token-secret-close']) expect(ids).toContain(id);
    for (const id of ['token-snippet-cli', 'token-snippet-cli-copy', 'token-snippet-json', 'token-snippet-json-copy']) expect(ids).toContain(id);
  });

  /**
   * A source can carry a complaint without having failed ([ADR-0056](../.ssot/ADR.md#adr-0056)): a
   * scanned PDF, or a file over the conversion limit, writes its reason to `last_error` while the
   * source itself synced and everything else in it indexed. The panel used to render `lastError` only
   * when `status === 'error'`, so that reason reached the column and never reached a person — which
   * made the refusal a silent failure of exactly the kind the entry exists to prevent.
   *
   * This is a source-text check, like the id wiring above it, because the dashboard has no build step
   * and no DOM to assert against. It is worth having anyway: it fails the moment the branch goes back.
   */
  /**
   * **The trap this closes.** A content type that shows a `.yaml` checkbox but leaves it unchecked is
   * worse than one that shows nothing: the operator picks "OpenAPI / Swagger", uploads a
   * specification, and the source's own extension filter drops it on the way in — silently, with a
   * green source, indexing whatever Markdown came with it. Picking the content type therefore checks
   * what that content type is for; loading an existing source does not, or a stored configuration
   * would be overwritten by opening its dialog ([ADR-0057](../.ssot/ADR.md#adr-0057)).
   */
  it("checks a content type's own file types when the operator picks it, and not when a source is loaded", async () => {
    const js = await readFile(new URL('app.js', PUBLIC), 'utf8');
    const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
    // The boxes exist and are declared as belonging to the content type.
    for (const ext of ['yaml', 'yml', 'json']) {
      expect(html).toContain(`<label class="flavor-only" data-flavor="openapi"><input type="checkbox" name="ext" value="${ext}" />`);
    }
    expect(js).toMatch(/srcForm\.elements\.flavor\.addEventListener\('change', \(\) => \{\s*syncFlavorFields\(\{ check: true \}\);/);
    expect(js).toMatch(/for \(const input of box\.querySelectorAll\('input'\)\) input\.checked = mine \? check \|\| input\.checked : false;/);
    // The two callers that must NOT check: `setKind` and `fillSourceForm`.
    expect(js.match(/syncFlavorFields\(\);/g) ?? []).toHaveLength(2);
  });

  it('shows a source its last error even when the source did not fail', async () => {
    const js = await readFile(new URL('app.js', PUBLIC), 'utf8');
    expect(js).toMatch(/const warned = !failed && Boolean\(s\.lastError\);/);
    // Both the glyph and the detail line have to react to it, or the reason is only in a tooltip.
    expect(js).toMatch(/failed \? 'error' : warned \? 'warn' : s\.type/);
    expect(js).toMatch(/text: failed \|\| warned \? shortError\(s\.lastError, 80\) : sourceDetail\(s\)/);
  });

  it('lets the dropzone name the file types this source actually takes', async () => {
    const js = await readFile(new URL('app.js', PUBLIC), 'utf8');
    const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
    // The list is rendered from the checkboxes, not written into the markup: a new upload source
    // defaults to .md and .mdx, and a fixed list under the dropzone contradicted that.
    expect(js).toContain('function renderDropzoneTypes()');
    expect(html).not.toMatch(/\.md, \.mdx, \.txt, \.html/);
  });

  it('keeps the auth pages free of dashboard ids, since they load a different script', async () => {
    const authPage = await readFile(new URL('auth-page.js', PUBLIC), 'utf8');
    const bodies = await Promise.all(['login', 'setup', 'change-password'].map((slug) => readFile(new URL(`pages/${slug}.html`, PUBLIC), 'utf8')));
    const ids = idsIn(bodies.join('\n'));
    for (const id of selectorsIn(authPage)) expect(ids).toContain(id);
  });

  /**
   * The audit panel holds no state of its own ([ADR-0055](../.ssot/ADR.md#adr-0055)'s panel, and
   * ADR-0050's rule about what a poll may not destroy). `renderDetail()` replaces `#detail` wholesale
   * every two seconds, so a chosen filter or the page somebody paged to has to live in `core.js`'s
   * shared `state` — and a key the panel reads that nothing declares there is `undefined` in the
   * browser and an error nowhere, which is exactly the class of failure this file exists for.
   */
  it('keeps the audit panel’s transient state in core.js, where a poll cannot wipe it', async () => {
    const core = await readFile(new URL('core.js', PUBLIC), 'utf8');
    const audit = await readFile(new URL('audit.js', PUBLIC), 'utf8');

    const block = core.match(/\n {2}audit: \{([\s\S]*?)\n {2}\},/);
    expect(block, 'core.js declares a state.audit block').not.toBeNull();
    const declared = new Set([...(block?.[1] ?? '').matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));

    const used = new Set([...audit.matchAll(/state\.audit\.(\w+)/g)].map((m) => m[1]));
    // Guards the assertion below against passing because the panel stopped reading state at all —
    // an alias (`const a = state.audit`) would empty this set and prove nothing.
    expect(used.size).toBeGreaterThan(8);
    for (const key of used) expect([...declared]).toContain(key);
  });

  /**
   * **Focus is captured before `#detail` is emptied, never after.**
   *
   * `search.js` learned this the hard way and says so in its own comment: Chrome fires `blur` when a
   * focused node is removed, and it does so while the node still looks connected, so nothing
   * downstream can tell "the operator left the field" from "the poll wiped the panel". The only
   * moment `document.activeElement` still means anything is *before* `replaceChildren()`. Moving
   * either capture below that line breaks focus restore in both panels and breaks no test but this
   * one — the browser simply stops giving the caret back, twice a second, to whoever was typing.
   */
  it('asks which control had focus before it empties the panel that holds it', async () => {
    const app = await readFile(new URL('app.js', PUBLIC), 'utf8');
    const wipe = app.indexOf('main.replaceChildren()');
    expect(wipe).toBeGreaterThan(-1);
    for (const capture of ['captureSearchFocus()', 'captureAuditFocus()']) {
      const at = app.indexOf(capture);
      expect(at, `${capture} is not called in renderDetail()`).toBeGreaterThan(-1);
      expect(at, `${capture} runs after #detail has been emptied`).toBeLessThan(wipe);
    }
  });

  /**
   * The two instance views are reachable only from the account menu, and a hash nothing routes is a
   * menu item that quietly lands on the project list.
   */
  it('routes every hash the account menu links to', async () => {
    const menu = await readFile(new URL('auth.js', PUBLIC), 'utf8');
    const app = await readFile(new URL('app.js', PUBLIC), 'utf8');
    const linked = [...menu.matchAll(/href: '#\/(~[a-z]+)'/g)].map((m) => m[1]);
    expect(linked).toEqual(expect.arrayContaining(['~users', '~audit']));
    for (const hash of linked) expect(app).toContain(`raw === '${hash}'`);
  });

  it('loads every module index.html needs through the one entry point', async () => {
    const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    // One module graph, not a pile of script tags: app.js imports the rest.
    expect(scripts).toEqual(['/app.js?v={{version}}']);

    const app = await readFile(new URL('app.js', PUBLIC), 'utf8');
    const imported = new Set([...app.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => `${m[1]}.js`));
    for (const file of await dashboardModules()) {
      if (file === 'app.js') continue;
      expect(imported.has(file) || file === 'core.js').toBe(true);
    }
  });
});
