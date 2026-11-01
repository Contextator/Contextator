import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRICS_ROUTE, PUBLIC_ROUTES, isProjectScoped, requiredProjectAccess, requiredRole } from '../../src/auth/policy.js';
import { buildApi, buildMcpApi, buildOauthApi, buildWebhookApi, routeTable } from '../support/route-table.js';

/**
 * **The HTTP route set as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 1): the admin API
 * routes and methods with the access each one asks for, the webhook endpoints, the MCP transport URLs, the
 * OAuth endpoints and discovery documents, and `/metrics`. Whoever adds, removes, renames or re-guards a
 * route changes this file's snapshot, and with it needs a `CHANGELOG.md` entry.
 *
 * Each line is `METHOD path  access`, sorted, read back from the routes the server really registers
 * (`test/support/route-table.ts`), not from a list somebody remembered to update. `access` is:
 *
 * - `public` — in `PUBLIC_ROUTES` (no principal needed), and the two RFC discovery documents;
 * - `role:<role>` — `requiredRole`, the instance role a route asks for;
 * - `project:<access>` — `requiredProjectAccess` for a route under `/api/projects/:id`; a route with both
 *   rules is written `role:<role>+project:<access>`;
 * - `session` — an `/api` route with no row in either table: any signed-in account;
 * - `webhook`, `mcp`, `oauth`, `metrics` — surfaces outside the policy table, each authenticated by its own
 *   mechanism (a signature, the project's MCP auth mode, the OAuth flow, `METRICS_*`).
 *
 * Normalisation: Fastify adds `HEAD` for every `GET` and `OPTIONS` is the CORS preflight; neither is a route
 * anyone wrote, so both are left out. Nothing else is dropped or rewritten.
 *
 * Re-record after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * Outside CI a missing snapshot file is written silently; run with `CI=1` to check rather than extend.
 */

const SNAPSHOT = path.join(import.meta.dirname, '__snapshots__', 'http-routes.txt');

type Surface = 'admin' | 'webhook' | 'mcp' | 'oauth';

function accessOf(surface: Surface, method: string, url: string): string {
  if (surface === 'webhook') return 'webhook';
  if (surface === 'mcp') return 'mcp';
  if (surface === 'oauth') return url.startsWith('/.well-known/') ? 'public' : 'oauth';
  if (url === METRICS_ROUTE) return 'metrics';
  if (PUBLIC_ROUTES.has(url)) return 'public';
  // `checkRequest` applies `requiredRole` to every route, a project's included, so both rules are written
  // when both exist: tightening either one is a change to the contract.
  const role = requiredRole(method, url);
  const rules = [...(role === null ? [] : [`role:${role}`]), ...(isProjectScoped(url) ? [`project:${requiredProjectAccess(method, url)}`] : [])];
  return rules.length === 0 ? 'session' : rules.join('+');
}

async function surface(name: Surface, build: () => ReturnType<typeof buildApi>): Promise<string[]> {
  const app = await build();
  const table = routeTable(app.printRoutes({ commonPrefix: false }));
  await app.close();
  return table
    .filter(([method]) => method !== 'HEAD' && method !== 'OPTIONS')
    .map(([method, url]) => `${method} ${url}  ${accessOf(name, method, url)}`);
}

describe('the HTTP route set is a contract', () => {
  it('matches the recorded routes and the access each one requires', async () => {
    const lines = [
      ...(await surface('admin', buildApi)),
      ...(await surface('webhook', buildWebhookApi)),
      ...(await surface('mcp', buildMcpApi)),
      ...(await surface('oauth', buildOauthApi)),
    ].sort();

    // Guard the walk itself: one that silently produced nothing would make the snapshot an empty file
    // that nobody could tell from a recorded one.
    expect(lines.length).toBeGreaterThan(80);
    expect(new Set(lines).size).toBe(lines.length);
    for (const expected of [
      'GET /api/health  public',
      'POST /api/projects/:id/reindex  project:editor',
      'GET /api/projects/:id/export  project:manager',
      'GET /api/users  role:admin',
      'POST /api/webhooks/git/:sourceId  webhook',
      'POST /mcp/:project  mcp',
      'POST /oauth/token  oauth',
      'GET /.well-known/oauth-authorization-server  public',
      'GET /metrics  metrics',
    ]) {
      expect(lines).toContain(expected);
    }

    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(SNAPSHOT);
  });
});
