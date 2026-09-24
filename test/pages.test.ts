import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AUTH_PAGES, authPageRoutes, safeNext } from '../src/admin/auth-pages.js';
import { SESSION_COOKIE } from '../src/auth/cookies.js';
import { PAGES, footerNav, pageRoutes, renderPage } from '../src/admin/pages.js';
import type { AppContext } from '../src/context.js';
import { SetupGate } from '../src/services/auth/setup.js';

describe('renderPage', () => {
  it('substitutes every placeholder in one pass', () => {
    const html = renderPage('<h1>{{title}}</h1>{{content}}<p>v{{version}} · {{year}}</p>{{missing}}', {
      title: 'License',
      content: '<p>body</p>',
      version: '1.2.3',
      year: '2026',
    });
    expect(html).toBe('<h1>License</h1><p>body</p><p>v1.2.3 · 2026</p>');
  });

  it('leaves a placeholder that arrived inside a substituted value alone', () => {
    expect(renderPage('{{content}}', { content: '{{version}}', version: 'nope' })).toBe('{{version}}');
  });
});

describe('footerNav', () => {
  it('links every page and marks the current one', () => {
    const nav = footerNav('cookies');
    for (const page of PAGES) expect(nav).toContain(`href="/${page.slug}"`);
    expect(nav).toContain('href="/cookies" aria-current="page"');
    expect(nav.match(/aria-current/g)).toHaveLength(1);
  });

  it('carries the product and legal pages only — /login and /setup never belong in a footer', () => {
    expect(footerNav().match(/<a /g)).toHaveLength(PAGES.length);
    for (const page of AUTH_PAGES) expect(footerNav()).not.toContain(`href="/${page.slug}"`);
  });
});

describe('pageRoutes', () => {
  it('serves each page as HTML with the shell, the version and the footer links', async () => {
    const app = Fastify();
    await app.register(pageRoutes, { version: '9.9.9' });

    for (const page of PAGES) {
      const res = await app.inject({ method: 'GET', url: `/${page.slug}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain(`<title>${page.title} · Contextator</title>`);
      expect(res.body).toContain('v9.9.9 is a');
      expect(res.body).toContain(String(new Date().getFullYear()));
      expect(res.body).toContain(`href="/${page.slug}" aria-current="page"`);
      expect(res.body).not.toContain('{{');
    }

    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    await app.close();
  });

  it('serves the shipped AGPL text verbatim at /license.txt', async () => {
    const app = Fastify();
    await app.register(pageRoutes, { version: '9.9.9' });

    const res = await app.inject({ method: 'GET', url: '/license.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    // Section 13 is the reason this project is on the AGPL rather than the GPL; a truncated copy would lose it.
    expect(res.body).toContain('13. Remote Network Interaction');
    expect(res.body).toBe(await readFile(new URL('../LICENSE', import.meta.url), 'utf8'));
    await app.close();
  });

  it('wins over the static wildcard that serves the dashboard', async () => {
    const app = Fastify();
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL('../public', import.meta.url)),
      prefix: '/',
      index: ['index.html'],
    });
    await app.register(pageRoutes, { version: '0.1.0' });

    expect((await app.inject({ method: 'GET', url: '/about' })).body).toContain('<h1>About Contextator</h1>');
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('<div class="layout">');
    expect((await app.inject({ method: 'GET', url: '/style.css' })).statusCode).toBe(200);
    await app.close();
  });
});

/** No cookie is ever sent in these, so the plugin never reaches the database. */
async function buildAuthPages(needsSetup: boolean) {
  const app = Fastify();
  await app.register(cookie);
  const setup = new SetupGate();
  setup.arm(needsSetup ? 0 : 1);
  const ctx = { config: { AUTH_SESSION_IDLE_MS: 1000 }, db: {}, setup, version: '9.9.9' } as unknown as AppContext;
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/',
    index: false, // `/` must be the guarded route, not the static file
  });
  await app.register(authPageRoutes, { ctx });
  return app;
}

describe('safeNext', () => {
  it('accepts a path on this server and rejects anything that could be another origin', () => {
    expect(safeNext('/%23%2Fbilling')).toBe('/#/billing');
    expect(safeNext('/settings?tab=1')).toBe('/settings?tab=1');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('//evil.example/')).toBe('/');
    expect(safeNext('/\\evil.example/')).toBe('/');
    expect(safeNext('https://evil.example/')).toBe('/');
    expect(safeNext('%E0%A4%A')).toBe('/'); // malformed percent-encoding must not throw
  });

  it('rejects a tab (and other control characters) hidden ahead of a scheme-relative host, not just a leading "//"', () => {
    // A WHATWG URL parser strips ASCII tab/CR/LF before it looks at slashes, so a same-origin-looking
    // "/\t/evil.example" resolves to "//evil.example" once a browser actually parses it ([MAJOR-2], tur 2
    // review of [ADR-0077](../../.ssot/ADR.md#adr-0077)). `%09` is the wire form the reviewer asked for.
    expect(safeNext('/%09/evil.example')).toBe('/');
    expect(safeNext('/\t/evil.example')).toBe('/');
    expect(safeNext('/%0d/evil.example')).toBe('/'); // CR
    expect(safeNext('/%0a/evil.example')).toBe('/'); // LF
  });
});

describe('authPageRoutes', () => {
  it('serves the sign-in page without a trace of the dashboard', async () => {
    const app = await buildAuthPages(false);
    const res = await app.inject({ method: 'GET', url: '/login' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<title>Sign in · Contextator</title>');
    expect(res.body).not.toContain('{{');
    // The whole point of a separate page: an anonymous visitor never receives the dashboard.
    expect(res.body).not.toContain('<div class="layout">');
    expect(res.body).not.toContain('/app.js');
    await app.close();
  });

  it('sends an anonymous visitor from / to /login, remembering where they were', async () => {
    const app = await buildAuthPages(false);
    for (const url of ['/', '/index.html']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?next=%2F');
    }
    await app.close();
  });

  it('sends everyone to /setup while the instance has no account', async () => {
    const app = await buildAuthPages(true);
    expect((await app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/setup');
    expect((await app.inject({ method: 'GET', url: '/setup' })).statusCode).toBe(200);
    await app.close();
  });

  it('closes /setup for good once an account exists', async () => {
    const app = await buildAuthPages(false);
    const res = await app.inject({ method: 'GET', url: '/setup' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    await app.close();
  });

  it('keeps /change-password behind a session', async () => {
    const app = await buildAuthPages(false);
    const res = await app.inject({ method: 'GET', url: '/change-password' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?next=%2Fchange-password');
    await app.close();
  });

  it('wins over the static wildcard for / and index.html', async () => {
    const app = await buildAuthPages(false);
    // A stale `index: ['index.html']` on @fastify/static would serve the dashboard unguarded here.
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/style.css' })).statusCode).toBe(200);
    await app.close();
  });

  it('ignores a cookie name it does not set', async () => {
    const app = await buildAuthPages(false);
    const res = await app.inject({ method: 'GET', url: '/', headers: { cookie: 'unrelated=1' } });
    expect(res.statusCode).toBe(302);
    expect(SESSION_COOKIE).toBe('contextator_session');
    await app.close();
  });
});

/**
 * The Cookie and Privacy pages, the README and the dashboard itself make claims about this
 * software. They were true before accounts and before per-project MCP tokens existed and would be
 * lies afterwards, so the claims are pinned here: change the behaviour and these fail until the
 * prose is rewritten.
 */
describe('the shipped prose tells the truth about accounts and MCP', () => {
  it('names the session cookie and no longer claims there is none', async () => {
    const body = await readFile(new URL('../public/pages/cookies.html', import.meta.url), 'utf8');
    expect(body).toContain(SESSION_COOKIE);
    expect(body).not.toContain('sets no cookies');
    expect(body).not.toContain('they are not planned');
  });

  it('no longer claims the software has no accounts', async () => {
    const body = await readFile(new URL('../public/pages/privacy.html', import.meta.url), 'utf8');
    expect(body).not.toContain('has no accounts');
    expect(body).toContain(SESSION_COOKIE);
    expect(body).toContain('scrypt');
  });

  it('describes the MCP endpoint as closable rather than unauthenticated by design', async () => {
    const privacy = await readFile(new URL('../public/pages/privacy.html', import.meta.url), 'utf8');
    const terms = await readFile(new URL('../public/pages/terms.html', import.meta.url), 'utf8');
    // The old wording said the endpoint could not be protected at all. It can, per project.
    expect(privacy).not.toContain('unauthenticated by design');
    expect(terms).not.toContain('unauthenticated by design');
    // What replaced it has to survive too: the tokens are stored, so the policy has to say so.
    expect(privacy).toContain('MCP tokens');
    expect(privacy).toContain('bearer token');
    expect(terms).toContain('bearer token');
  });

  /**
   * FR-135 promises the legal pages state what the software stores "accurately enough that the
   * statement can be checked against the code", and [ADR-0047](../.ssot/ADR.md#adr-0047) is the first
   * change to make one of those statements *false* rather than merely incomplete: §7 said the server
   * records the token an agent presented "and nothing about the agent itself", and it now records
   * every question the agent asks.
   *
   * So the retired sentence is pinned as an absence, exactly as "unauthenticated by design" is above,
   * and the claims that replaced it are pinned as text. Bringing the behaviour back without the prose —
   * or deleting the prose without the behaviour — fails here.
   */
  it('no longer claims the server records nothing about a connected agent', async () => {
    const privacy = await readFile(new URL('../public/pages/privacy.html', import.meta.url), 'utf8');
    // The sentence this change made untrue. It must not come back while the table exists.
    expect(privacy).not.toContain('and nothing about the agent itself');
    // What replaced it: the table, what is in it, who can read it, and how long it lives.
    expect(privacy).toContain('Search queries');
    expect(privacy).toContain('SEARCH_QUERY_LOG_RETENTION_DAYS');
    // The two switches an operator has, named as the software names them.
    expect(privacy).toContain('SEARCH_QUERY_LOG');
    // The consequence that is easy to leave out of a privacy page: it is content, in the backups too.
    expect(privacy).toContain('backup');
  });

  it('says the same thing in the README and in the dashboard, where operators actually read it', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const dashboard = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    // Both once claimed the endpoint could not be protected at all. It can, per project.
    expect(readme).not.toContain('unauthenticated by design');
    expect(dashboard).not.toContain('unauthenticated by design');
    // And both have to state the door that replaced that claim.
    expect(readme).toContain('bearer token');
    expect(dashboard).toContain('bearer token');
  });
});
