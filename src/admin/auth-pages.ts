import fs from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { readSessionCookie } from '../auth/cookies.js';
import { findSessionUser } from '../services/auth/sessions.js';
import { footerNav, renderPage, type PageMeta } from './pages.js';

/**
 * The pages a visitor sees before the dashboard is theirs, plus the guard on `/` itself.
 *
 * They are separate documents rather than an overlay inside index.html for one reason: the answer
 * to "are you signed in?" is the server's, and it can redirect before a byte of the dashboard is
 * sent. An anonymous visitor gets a 3 KB form, never app.js, and there is no frame in which the
 * dashboard flashes behind a gate.
 */
export const AUTH_PAGES: readonly PageMeta[] = [
  { slug: 'login', nav: '', title: 'Sign in', description: 'Sign in to this Contextator instance.' },
  { slug: 'setup', nav: '', title: 'First-run setup', description: 'Create the first account of this Contextator instance.' },
  { slug: 'change-password', nav: '', title: 'Choose a new password', description: 'Replace the temporary password before using the dashboard.' },
];

const PAGES_DIR = new URL('../../public/pages/', import.meta.url);
const INDEX_FILE = new URL('../../public/index.html', import.meta.url);

/** Only a path on this server; `//host` and `/\host` are other origins to a browser. */
export function safeNext(raw: string | undefined): string {
  if (!raw) return '/';
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

export const authPageRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db, version } = ctx;
  const shell = await fs.readFile(new URL('_auth-shell.html', PAGES_DIR), 'utf8');
  const bodies = await Promise.all(AUTH_PAGES.map((page) => fs.readFile(new URL(`${page.slug}.html`, PAGES_DIR), 'utf8')));
  const indexHtml = await fs.readFile(INDEX_FILE, 'utf8');
  // The footer of these pages links the product and legal pages, never each other.
  const nav = footerNav();

  const whoIsThis = async (req: FastifyRequest) => {
    const raw = readSessionCookie(req);
    if (!raw) return null;
    return findSessionUser(db, raw, config.AUTH_SESSION_IDLE_MS);
  };

  const render = (page: PageMeta, content: string): string =>
    renderPage(shell, { title: page.title, description: page.description, content, nav, version, year: String(new Date().getFullYear()) });

  /**
   * `/` is an explicit route so it can be guarded; @fastify/static is registered with
   * `index: false` for exactly this reason. Explicit routes beat the static wildcard.
   */
  const serveDashboard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (ctx.setup.needsSetup) return reply.redirect('/setup', 302);
    const session = await whoIsThis(req);
    if (!session) {
      const next = encodeURIComponent(req.url === '/index.html' ? '/' : req.url);
      return reply.redirect(`/login?next=${next}`, 302);
    }
    if (session.mustChangePassword) return reply.redirect('/change-password', 302);
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    // Rendering the shell lets the module URLs carry the version, which is the only cache-busting
    // a build-step-free frontend gets.
    return renderPage(indexHtml, { version });
  };

  app.get('/', serveDashboard);
  app.get('/index.html', serveDashboard);

  AUTH_PAGES.forEach((page, i) => {
    const html = render(page, bodies[i]);
    app.get(`/${page.slug}`, async (req, reply) => {
      const session = await whoIsThis(req);

      if (page.slug === 'setup' && !ctx.setup.needsSetup) return reply.redirect('/login', 302);
      if (page.slug === 'login' && session && !session.mustChangePassword) return reply.redirect(safeNext(String((req.query as { next?: string }).next ?? '/')), 302);
      if (page.slug === 'change-password') {
        if (!session) return reply.redirect('/login?next=%2Fchange-password', 302);
        if (!session.mustChangePassword) return reply.redirect('/', 302);
      }

      // Never cached: whether this page is even the right answer depends on a cookie.
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
      return html;
    });
  });
};
