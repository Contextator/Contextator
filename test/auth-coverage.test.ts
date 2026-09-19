import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import { oauthRoutes } from '../src/mcp/oauth-routes.js';
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
    config: { ALLOWED_ORIGINS: [], ALLOWED_DOC_ROOTS: ['/docs'], AUTH_SESSION_IDLE_MS: 1000, SECRET_KEY: undefined, MCP_OAUTH_MAX_CLIENTS: 200 },
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

/**
 * The OAuth flow ([ADR-0054](../.ssot/ADR.md#adr-0054)) is the one surface in this product that is
 * deliberately outside the policy table, and this is the test that makes "deliberately" mean
 * something. It is the same shape as the coverage test above and for the same reason: the route table
 * is read back from the server, so a seventh route added tomorrow fails this until somebody has said
 * out loud what authenticates it.
 */
describe('the OAuth surface is enumerated rather than assumed', () => {
  /**
   * Every route the plugin may register, and what stands in front of each.
   *
   * **The values are prose and nothing compares them** — only the key set is asserted below. That is
   * said out loud because the first cut of this file left "capped by `MCP_OAUTH_MAX_CLIENTS`" sitting
   * in one of these strings, which reads like a claim and is a comment: deleting the cap would have
   * turned nothing red. The cap, the sweep and the rate limit are checked where they can actually be
   * exercised, in `test/integration/mcp-oauth.itest.ts`.
   */
  const EXPECTED: Record<string, string> = {
    'GET /.well-known/oauth-protected-resource': 'public by RFC 9728 — a client with no credential has to be able to read it',
    'GET /.well-known/oauth-protected-resource/mcp/:project': 'public by RFC 9728, and deliberately answers without a database lookup',
    'GET /.well-known/oauth-authorization-server': 'public by RFC 8414 — it says only where this instance\u2019s endpoints are',
    'POST /oauth/register': 'unauthenticated by RFC 7591, grants nothing; the cap and the per-host budget are tested in the integration suite',
    'GET /oauth/authorize': 'the dashboard session cookie; an anonymous browser is redirected to /login',
    'POST /oauth/authorize': 'the dashboard session cookie, plus the same same-site check every cookie-authenticated write gets',
    'POST /oauth/token': 'the authorization code and its PKCE verifier, or a refresh token',
    'POST /oauth/revoke': 'the credential being revoked is the credential presented',
  };

  async function buildOauth() {
    const app = Fastify();
    await app.register(cookie);
    const ctx = {
      config: { ALLOWED_ORIGINS: [], AUTH_SESSION_IDLE_MS: 1000, MCP_OAUTH_MAX_CLIENTS: 200 },
      db: {},
      log: app.log,
      version: '0.0.0-test',
    } as unknown as AppContext;
    await app.register(oauthRoutes, { ctx });
    await app.ready();
    return app;
  }

  it('registers exactly the routes that have been argued for, and nothing under /api/', async () => {
    const app = await buildOauth();
    const table = routeTable(app.printRoutes({ commonPrefix: false }));
    await app.close();

    const registered = table
      .filter(([method]) => method !== 'HEAD' && method !== 'OPTIONS')
      .map(([method, url]) => `${method} ${url}`)
      .sort();
    expect(registered).toEqual(Object.keys(EXPECTED).sort());
    // None of them is under /api/*, which is what keeps the policy table's claim to cover that prefix
    // true: an OAuth route that drifted under it would be governed by a rule nobody wrote for it.
    for (const url of table.map(([, u]) => u)) expect(url.startsWith('/api/')).toBe(false);
  });

  it('refuses an incomplete authorization request before it reaches anything, and never with a consent page', async () => {
    const app = await buildOauth();
    // `db` is hollow here, so this can only be answered at all by a check that happens before the
    // first query — which is the claim: the parameters are validated before the client is looked up,
    // and a request that is missing them never becomes a page asking somebody to approve something.
    const res = await app.inject({ method: 'GET', url: '/oauth/authorize?response_type=code' });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Incomplete authorization request');
    expect(res.body).not.toContain('decision');
  });

  it('answers the two metadata documents to a client holding nothing at all', async () => {
    const app = await buildOauth();
    const prm = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp/handbook' });
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    await app.close();
    expect(prm.statusCode).toBe(200);
    expect(prm.json().resource).toMatch(/\/mcp\/handbook$/);
    expect(as.statusCode).toBe(200);
    // S256 only, and a public client: OAuth 2.1 drops `plain`, and a browser connector holds no secret.
    expect(as.json().code_challenge_methods_supported).toEqual(['S256']);
    expect(as.json().token_endpoint_auth_methods_supported).toEqual(['none']);
  });
});
