import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../../src/admin/routes.js';
import { webhookRoutes } from '../../src/admin/webhooks.js';
import { oauthRoutes } from '../../src/mcp/oauth-routes.js';
import { mcpRoutes } from '../../src/mcp/router.js';
import type { AppContext } from '../../src/context.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { AuditWriter } from '../../src/services/audit.js';

/**
 * Reading a Fastify route table back, for the tests that hold the route set: `test/auth-coverage.test.ts`
 * (every route has a rule) and `test/contracts/http-routes.test.ts` (the set is a frozen contract,
 * [ADR-0137](../../.ssot/ADR.md#adr-0137)). One walker, so the two cannot disagree about what a route is.
 */

/**
 * Registering routes touches neither the database nor the embedding model — only a request would.
 * So the whole admin API can be built with a hollow context, purely to read its route table back.
 */
export async function buildApi() {
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
    // Hollow like everything else here: this file reads the route table back and sends no request,
    // so neither of these is ever reached.
    metrics: new MetricsRegistry(),
    audit: new AuditWriter({} as never, app.log),
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
export function routeTable(printed: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const stack: string[] = [];
  for (const line of printed.split('\n')) {
    const match = /^(?<indent>[\s│]*)(?:├──|└──)\s(?<path>\S*)(?:\s\((?<methods>[A-Z, ]+)\))?/.exec(line);
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

/** The OAuth surface, on its own instance, because that is how `src/server.ts` registers it. */
export async function buildOauthApi() {
  const app = Fastify();
  await app.register(cookie);
  const ctx = {
    config: { ALLOWED_ORIGINS: [], AUTH_SESSION_IDLE_MS: 1000, MCP_OAUTH_MAX_CLIENTS: 200 },
    db: {},
    log: app.log,
    // The audit hooks are installed on this instance too ([ADR-0055](../../.ssot/ADR.md#adr-0055)); no
    // test that uses this builder sends a request that reaches them.
    audit: new AuditWriter({} as never, app.log),
    version: '0.0.0-test',
  } as unknown as AppContext;
  await app.register(oauthRoutes, { ctx });
  await app.ready();
  return app;
}

/** The webhook endpoints, which `src/server.ts` registers as a plugin of their own beside `adminRoutes`. */
export async function buildWebhookApi() {
  const app = Fastify();
  await app.register(cookie);
  const ctx = { config: {}, db: {}, log: app.log, audit: new AuditWriter({} as never, app.log) } as unknown as AppContext;
  await app.register(webhookRoutes, { ctx });
  await app.ready();
  return app;
}

/** The `/mcp/:project` transport routes, registered as `src/server.ts` does and never requested. */
export async function buildMcpApi() {
  const app = Fastify();
  const ctx = { config: {}, db: {}, log: app.log, sessions: {}, metrics: new MetricsRegistry(), version: '0.0.0-test' } as unknown as AppContext;
  await app.register(mcpRoutes, { ctx });
  await app.ready();
  return app;
}
