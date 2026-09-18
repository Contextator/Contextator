import fs from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';

export interface PageMeta {
  /** URL path and file name in public/pages/. */
  slug: string;
  /** Label in the footer navigation. */
  nav: string;
  /** <title> and the browser tab. */
  title: string;
  description: string;
}

/** Order is the footer order. */
export const PAGES: readonly PageMeta[] = [
  { slug: 'about', nav: 'About', title: 'About', description: 'What Contextator is, how it indexes documentation into an MCP endpoint, and who builds it.' },
  { slug: 'privacy', nav: 'Privacy', title: 'Privacy Policy', description: 'What a Contextator installation stores, what stays on your machine and when data leaves it.' },
  { slug: 'cookies', nav: 'Cookies', title: 'Cookie Policy', description: 'Contextator sets no cookies; the one value it keeps in the browser and how to remove it.' },
  { slug: 'terms', nav: 'Terms of Use', title: 'Terms of Use', description: 'Warranty disclaimer, limitation of liability and what running a Contextator instance makes you responsible for.' },
  { slug: 'license', nav: 'License', title: 'License', description: 'The GNU AGPL v3 of Contextator, the commercial alternative, and the licenses of its third-party components.' },
];

// Both resolve from src/ (tsx) and from dist/ (node): src/admin/ and dist/admin/ sit two levels below the package root.
const PAGES_DIR = new URL('../../public/pages/', import.meta.url);
const LICENSE_FILE = new URL('../../LICENSE', import.meta.url);

/** Footer links, with the page being rendered marked for the styling and for assistive technology. */
export function footerNav(current?: string): string {
  return PAGES.map((p) => `<a href="/${p.slug}"${p.slug === current ? ' aria-current="page"' : ''}>${p.nav}</a>`).join('\n        ');
}

/** One pass over the shell, so a `{{token}}` inside a page body is left alone. */
export function renderPage(shell: string, vars: Record<string, string>): string {
  return shell.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}

/**
 * Product and legal pages at /about, /privacy, /cookies, /terms and /license: a body from public/pages/
 * inside the shared shell, plus the verbatim AGPL text at /license.txt. They are public — the dashboard's
 * admin token never gates them, and the AGPL expects a network user to reach the license without one.
 */
export const pageRoutes: FastifyPluginAsync<{ version: string }> = async (app, { version }) => {
  const shell = await fs.readFile(new URL('_shell.html', PAGES_DIR), 'utf8');
  const bodies = await Promise.all(PAGES.map((page) => fs.readFile(new URL(`${page.slug}.html`, PAGES_DIR), 'utf8')));
  const licenseText = await fs.readFile(LICENSE_FILE, 'utf8');

  // The file the software ships with, served as-is: the license page links here instead of restating it.
  app.get('/license.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600');
    return licenseText;
  });

  PAGES.forEach((page, i) => {
    const content = bodies[i];
    const nav = footerNav(page.slug);
    app.get(`/${page.slug}`, async (_req, reply) => {
      reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300');
      // The year is read per request; a container that runs into January should not serve a stale copyright line.
      return renderPage(shell, { title: page.title, description: page.description, content, nav, version, year: String(new Date().getFullYear()) });
    });
  });
};
