import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import { PUBLIC_ROUTES, isProjectScoped, requiredProjectAccess, requiredRole } from '../src/auth/policy.js';
import type { AppContext } from '../src/context.js';
import { SetupGate } from '../src/services/auth/setup.js';
import { SlidingWindow } from '../src/services/rate-limit.js';

/**
 * Registering routes touches neither the database nor the embedding model — only a request would.
 * So the whole admin API can be built with a hollow context, purely to read its route table back.
 */
async function buildApi() {
  const app = Fastify();
  await app.register(cookie);
  const ctx = {
    config: { ALLOWED_ORIGINS: [], ALLOWED_DOC_ROOTS: ['/docs'], AUTH_SESSION_IDLE_MS: 1000, SECRET_KEY: undefined },
    db: {},
    log: app.log,
    embeddings: {},
    indexer: {},
    locks: {},
    uploads: {},
    sessions: {},
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await app.register(adminRoutes, { ctx });
  await app.ready();
  return app;
}

/**
 * Fastify prints its routes as a radix tree of path *segments*, so a full URL is the concatenation
 * of a node and its ancestors. Walking it is what makes this test honest: it reads the routes the
 * server actually registered, not a list somebody remembered to update.
 */
function routeTable(printed: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const stack: string[] = [];
  for (const line of printed.split('\n')) {
    const match = /^(?<indent>[\s\u2502]*)(?:\u251c\u2500\u2500|\u2514\u2500\u2500)\s(?<path>\S*)(?:\s\((?<methods>[A-Z, ]+)\))?/.exec(line);
    if (!match?.groups) continue;
    const depth = Math.floor(match.groups.indent.length / 4);
    stack.length = depth;
    stack.push(match.groups.path);
    if (!match.groups.methods) continue;
    const url = stack.join('');
    for (const method of match.groups.methods.split(',').map((m) => m.trim())) out.push([method, url]);
  }
  return out;
}

describe('every /api route is covered by the policy', () => {
  it('registers nothing that is neither public nor governed by a rule', async () => {
    const app = await buildApi();
    const table = routeTable(app.printRoutes({ commonPrefix: false }));
    await app.close();

    const apiRoutes = table.filter(([method, url]) => url.startsWith('/api/') && method !== 'HEAD' && method !== 'OPTIONS');
    // Guard the parser itself: if it silently produced segments instead of full paths, the
    // coverage check below would pass for the wrong reason.
    expect(apiRoutes.length).toBeGreaterThan(20);
    const urls = new Set(apiRoutes.map(([, url]) => url));
    for (const url of [
      '/api/projects/:id/sources/:sid/uploads/:session/commit',
      '/api/projects/:id/members/:userId',
      '/api/users/:id/sessions',
      '/api/auth/me',
    ]) {
      expect(urls).toContain(url);
    }

    const uncovered = apiRoutes.filter(([method, url]) => {
      if (PUBLIC_ROUTES.has(url)) return false;
      if (isProjectScoped(url)) return requiredProjectAccess(method, url) === undefined;
      // Everything else is at least "signed in"; these are the ones that ask for more.
      return requiredRole(method, url) === null && !url.startsWith('/api/auth/') && url !== '/api/projects';
    });

    expect(uncovered).toEqual([]);
  });

  it('keeps the routes that must stay reachable without an account', async () => {
    const app = await buildApi();
    const urls = new Set(routeTable(app.printRoutes({ commonPrefix: false })).map(([, url]) => url));
    await app.close();
    for (const url of PUBLIC_ROUTES) expect(urls.has(url)).toBe(true);
  });

  /**
   * **The one `GET` that is not a viewer's is named here rather than allowed by a widened rule**
   * ([ADR-0051](../.ssot/ADR.md#adr-0051)). The shape of this assertion is the point: relaxing it to
   * "a GET needs viewer *or* manager" would have let the next read-everything route arrive unargued.
   */
  const MANAGER_READS = new Set(['/api/projects/:id/export']);

  it('requires an editor for every write under a project, and a viewer for every read', async () => {
    const app = await buildApi();
    const table = routeTable(app.printRoutes({ commonPrefix: false }));
    await app.close();

    for (const [method, url] of table.filter(([m, u]) => isProjectScoped(u) && m !== 'HEAD' && m !== 'OPTIONS')) {
      const need = requiredProjectAccess(method, url);
      if (method === 'GET') expect(need).toBe(MANAGER_READS.has(url) ? 'manager' : 'viewer');
      else expect(['editor', 'manager']).toContain(need);
    }
  });

  it('registers every route named in the manager-read exception list', async () => {
    const app = await buildApi();
    const urls = new Set(routeTable(app.printRoutes({ commonPrefix: false })).map(([, url]) => url));
    await app.close();
    // An exception for a route that does not exist is an exception that would silently outlive it.
    for (const url of MANAGER_READS) expect(urls.has(url)).toBe(true);
  });
});
