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

  it('keeps the auth pages free of dashboard ids, since they load a different script', async () => {
    const authPage = await readFile(new URL('auth-page.js', PUBLIC), 'utf8');
    const bodies = await Promise.all(
      ['login', 'setup', 'change-password'].map((slug) => readFile(new URL(`pages/${slug}.html`, PUBLIC), 'utf8')),
    );
    const ids = idsIn(bodies.join('\n'));
    for (const id of selectorsIn(authPage)) expect(ids).toContain(id);
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
