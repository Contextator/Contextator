import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PAGES, footerNav, pageRoutes, renderPage } from '../src/admin/pages.js';

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
