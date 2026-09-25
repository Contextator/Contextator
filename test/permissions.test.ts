import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXEMPT_ROUTES,
  MCP_READ_ACCESS,
  METRICS_ROUTE,
  PASSWORD_CHANGE_ALLOWED,
  PUBLIC_ROUTES,
  accessFromMembership,
  apiTokenAllowsRoute,
  auditCreatedTarget,
  auditReadsResponse,
  auditSubject,
  canActOnRole,
  canManageUsers,
  isProjectScoped,
  requiredProjectAccess,
  requiredRole,
  roleAtLeast,
  satisfies,
} from '../src/auth/policy.js';
import { checkRequest } from '../src/auth/authorize.js';
import { requireSession } from '../src/auth/plugin.js';
import { ForbiddenError } from '../src/services/errors.js';
import { mcpAccessDecision, mcpAccessStatus } from '../src/mcp/access.js';
import { DEFAULT_MCP_AUTH, type McpAuthMode } from '../src/db/schema.js';
import type { Principal, ProjectAccess } from '../src/auth/types.js';

const token: Principal = { kind: 'token', role: 'root', userId: null, username: 'ADMIN_TOKEN', mustChangePassword: false };
const as = (role: 'root' | 'admin' | 'member'): Principal => ({
  kind: 'session',
  role,
  userId: `id-${role}`,
  username: role,
  sessionId: 's',
  mustChangePassword: false,
});

/** An [ADR-0076](../.ssot/ADR.md#adr-0076) API token principal, defaulted to the brief's own scenario:
 * a `member`-role token scoped to reindex exactly one project. */
const asApiToken = (overrides: Partial<Extract<Principal, { kind: 'apiToken' }>> = {}): Principal => ({
  kind: 'apiToken',
  role: 'member',
  userId: 'id-apitoken-owner',
  username: 'ci reindexer · owner',
  tokenId: 't-1',
  scope: ['POST /api/projects/:id/reindex'],
  projectId: null,
  mustChangePassword: false,
  ...overrides,
});

/** The whole matrix in one table: actor × route × expected answer. */
const CASES: Array<{ method: string; url: string; actor: Principal; membership: 'viewer' | 'editor' | null; allowed: boolean }> = [
  // Project lifecycle is root/admin only.
  { method: 'POST', url: '/api/projects', actor: as('root'), membership: null, allowed: true },
  { method: 'POST', url: '/api/projects', actor: as('admin'), membership: null, allowed: true },
  { method: 'POST', url: '/api/projects', actor: as('member'), membership: null, allowed: false },
  { method: 'POST', url: '/api/projects', actor: token, membership: null, allowed: true },
  { method: 'DELETE', url: '/api/projects/:id', actor: as('admin'), membership: null, allowed: true },
  { method: 'DELETE', url: '/api/projects/:id', actor: as('member'), membership: 'editor', allowed: false },

  // Reading a project needs viewer; the default covers every source and upload route.
  { method: 'GET', url: '/api/projects/:id/sources', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'GET', url: '/api/projects/:id/sources', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/projects/:id/runs', actor: as('member'), membership: 'viewer', allowed: true },

  // Changing it needs editor.
  { method: 'POST', url: '/api/projects/:id/reindex', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'POST', url: '/api/projects/:id/reindex', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'POST', url: '/api/projects/:id/sources', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'PATCH', url: '/api/projects/:id/sources/:sid', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'DELETE', url: '/api/projects/:id/sources/:sid', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/uploads', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/uploads/:session/files', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'DELETE', url: '/api/projects/:id/sources/:sid/files', actor: as('member'), membership: 'viewer', allowed: false },
  // "Test connection" reaches the network with a stored token, so it is an editor's call.
  { method: 'POST', url: '/api/projects/:id/sources/:sid/test', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('member'), membership: 'editor', allowed: true },
  // Generating a Confluence webhook secret is what turns its delivery route on, and deleting it turns
  // the route off again — an editor's switch in both directions, never a viewer's.
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'DELETE', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'DELETE', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'DELETE', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('member'), membership: null, allowed: false },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('member'), membership: null, allowed: false },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: as('admin'), membership: null, allowed: true },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-secret', actor: token, membership: null, allowed: true },
  // Opening the Notion verification window is what authenticates the unauthenticated webhook route
  // ([ADR-0049](../.ssot/ADR.md#adr-0049)), so a viewer must not be able to open one.
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-verification', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'POST', url: '/api/projects/:id/sources/:sid/webhook-verification', actor: as('member'), membership: 'viewer', allowed: false },

  // The operator's search panel, which since [ADR-0058](../.ssot/ADR.md#adr-0058) takes a third
  // filter. A filter narrows what a search returns and can never widen it, so the route's rule does
  // not move — and that is the claim these rows carry: reading a project's documentation stays a
  // read, and somebody with no membership still cannot make it.
  { method: 'GET', url: '/api/projects/:id/search', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'GET', url: '/api/projects/:id/search', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'GET', url: '/api/projects/:id/search', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/projects/:id/search', actor: as('admin'), membership: null, allowed: true },
  { method: 'GET', url: '/api/projects/:id/search', actor: token, membership: null, allowed: true },

  // MCP tokens: reading the list is a viewer's, minting and revoking an editor's, and deciding
  // whether the endpoint is public at all is a manager's.
  { method: 'GET', url: '/api/projects/:id/mcp-tokens', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'POST', url: '/api/projects/:id/mcp-tokens', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'POST', url: '/api/projects/:id/mcp-tokens', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'DELETE', url: '/api/projects/:id/mcp-tokens/:tokenId', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'PATCH', url: '/api/projects/:id/mcp-auth', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'PATCH', url: '/api/projects/:id/mcp-auth', actor: as('admin'), membership: null, allowed: true },

  // The query log (ADR-0047). Reading what agents asked is the same access as running the search
  // panel that asks; deciding whether the project records it at all, and throwing away what it has
  // recorded, are a manager's — the `mcp-auth` class of decision rather than the editorial one.
  { method: 'GET', url: '/api/projects/:id/query-log', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'GET', url: '/api/projects/:id/query-log', actor: as('member'), membership: null, allowed: false },
  { method: 'PATCH', url: '/api/projects/:id/query-log', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'PATCH', url: '/api/projects/:id/query-log', actor: as('admin'), membership: null, allowed: true },
  { method: 'DELETE', url: '/api/projects/:id/query-log', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'DELETE', url: '/api/projects/:id/query-log', actor: as('admin'), membership: null, allowed: true },

  // The panel and the export ([ADR-0050](../.ssot/ADR.md#adr-0050)). Both are reads of the same rows
  // FR-309 already decided, so both are a `viewer`'s and neither needs a row of its own — but a rule
  // that is only ever a default is a rule nothing would notice losing, so every actor is stated.
  { method: 'GET', url: '/api/projects/:id/queries/summary', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'GET', url: '/api/projects/:id/queries/summary', actor: as('member'), membership: 'editor', allowed: true },
  { method: 'GET', url: '/api/projects/:id/queries/summary', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/projects/:id/queries/summary', actor: as('admin'), membership: null, allowed: true },
  { method: 'GET', url: '/api/projects/:id/queries/summary', actor: token, membership: null, allowed: true },
  // The export is the same rows in a file. A viewer who can read them on the page can save them.
  { method: 'GET', url: '/api/projects/:id/queries/export', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'GET', url: '/api/projects/:id/queries/export', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/projects/:id/queries/export', actor: as('admin'), membership: null, allowed: true },

  // The project's relevance floor ([ADR-0083](../.ssot/ADR.md#adr-0083)). Changing it decides which
  // searches the project refuses, the `query-log` class of decision, so it is a manager's. The preview
  // only re-reads the logged rows the panel already shows, so it is a viewer's like the summary.
  { method: 'PATCH', url: '/api/projects/:id/score-floor', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'PATCH', url: '/api/projects/:id/score-floor', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'PATCH', url: '/api/projects/:id/score-floor', actor: as('admin'), membership: null, allowed: true },
  { method: 'PATCH', url: '/api/projects/:id/score-floor', actor: token, membership: null, allowed: true },
  { method: 'GET', url: '/api/projects/:id/score-floor/preview', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'GET', url: '/api/projects/:id/score-floor/preview', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/projects/:id/score-floor/preview', actor: as('admin'), membership: null, allowed: true },

  // Export and import ([ADR-0051](../.ssot/ADR.md#adr-0051)). Neither is an editor's act.
  //
  // The export is a `GET` and a `manager`'s anyway: a viewer can read any one document through the
  // dashboard, and the whole corpus in one downloadable file is a different act from reading a page of
  // it. The negative rows are the ones that matter here, because `requiredProjectAccess` falls to
  // `viewer` on a GET by default and the row is the only thing standing between those two answers.
  { method: 'GET', url: '/api/projects/:id/export', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'GET', url: '/api/projects/:id/export', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'GET', url: '/api/projects/:id/export', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/projects/:id/export', actor: as('admin'), membership: null, allowed: true },
  { method: 'GET', url: '/api/projects/:id/export', actor: as('root'), membership: null, allowed: true },
  { method: 'GET', url: '/api/projects/:id/export', actor: token, membership: null, allowed: true },
  // The import has no project to be a member of, so it is an *instance* rule: the same `admin` that
  // creating a project has needed since ADR-0028, because that is what an import does.
  { method: 'POST', url: '/api/projects/import', actor: as('member'), membership: null, allowed: false },
  { method: 'POST', url: '/api/projects/import', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'POST', url: '/api/projects/import', actor: as('admin'), membership: null, allowed: true },
  { method: 'POST', url: '/api/projects/import', actor: as('root'), membership: null, allowed: true },
  { method: 'POST', url: '/api/projects/import', actor: token, membership: null, allowed: true },

  // `/metrics` ([ADR-0055](../.ssot/ADR.md#adr-0055)). It asks for no role and no membership — the
  // numbers describe the process, not a project — so an ordinary `member` reads it. The refusal that
  // matters is the one no row in this table can state, because it is about holding *no* credential at
  // all; it is asserted against `checkRequest` below.
  { method: 'GET', url: METRICS_ROUTE, actor: as('member'), membership: null, allowed: true },
  { method: 'GET', url: METRICS_ROUTE, actor: as('admin'), membership: null, allowed: true },
  { method: 'GET', url: METRICS_ROUTE, actor: token, membership: null, allowed: true },

  // Reading the audit log ([ADR-0055](../.ssot/ADR.md#adr-0055)). The same standing as user
  // management, and for the same reason: the rows are about the instance rather than about one
  // project. The `member`/`editor` row is the sharp one — a membership is standing on a project, and
  // it must not become standing to read who was given the root role or whose account was disabled.
  { method: 'GET', url: '/api/audit', actor: as('member'), membership: null, allowed: false },
  { method: 'GET', url: '/api/audit', actor: as('member'), membership: 'viewer', allowed: false },
  { method: 'GET', url: '/api/audit', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'GET', url: '/api/audit', actor: as('admin'), membership: null, allowed: true },
  { method: 'GET', url: '/api/audit', actor: as('root'), membership: null, allowed: true },
  { method: 'GET', url: '/api/audit', actor: token, membership: null, allowed: true },

  // Membership: anyone on the project sees who else is; only root/admin change it.
  { method: 'GET', url: '/api/projects/:id/members', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'PUT', url: '/api/projects/:id/members/:userId', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'PUT', url: '/api/projects/:id/members/:userId', actor: as('admin'), membership: null, allowed: true },
  { method: 'DELETE', url: '/api/projects/:id/members/:userId', actor: as('member'), membership: 'editor', allowed: false },

  // Unlinking SSO ([ADR-0081](../.ssot/ADR.md#adr-0081)): no role stands between an account and its
  // own unlink — root included, whose only link is a dormant one it may tidy away. Whether the unlink
  // happens or is refused `409 last_sign_in_method` is decided by the handler on the account's own
  // row, so the matrix must let every signed-in role reach it.
  { method: 'DELETE', url: '/api/auth/oidc/link', actor: as('member'), membership: null, allowed: true },
  { method: 'DELETE', url: '/api/auth/oidc/link', actor: as('root'), membership: null, allowed: true },
];

function allows(actor: Principal, membership: 'viewer' | 'editor' | null, method: string, url: string): boolean {
  const needRole = requiredRole(method, url);
  if (needRole && !roleAtLeast(actor.role, needRole)) return false;
  if (!isProjectScoped(url)) return true;
  const access = accessFromMembership(actor, membership);
  if (access === 'none') return false;
  return satisfies(access, requiredProjectAccess(method, url));
}

describe('the permission matrix', () => {
  for (const c of CASES) {
    const who = c.actor.kind === 'token' ? 'ADMIN_TOKEN' : `${c.actor.role}${c.membership ? `/${c.membership}` : ''}`;
    it(`${c.allowed ? 'allows' : 'refuses'} ${who} to ${c.method} ${c.url}`, () => {
      expect(allows(c.actor, c.membership, c.method, c.url)).toBe(c.allowed);
    });
  }

  it('gives root, admin and ADMIN_TOKEN every project without a membership row', () => {
    for (const actor of [as('root'), as('admin'), token]) expect(accessFromMembership(actor, null)).toBe('manager');
  });

  it('gives a member exactly what its membership says, and nothing without one', () => {
    expect(accessFromMembership(as('member'), 'viewer')).toBe('viewer');
    expect(accessFromMembership(as('member'), 'editor')).toBe('editor');
    expect(accessFromMembership(as('member'), null)).toBe('none');
  });
});

/**
 * [ADR-0076](../.ssot/ADR.md#adr-0076) — an account's own bearer API tokens.
 *
 * The `CASES`/`allows()` matrix above never sees an `apiToken` principal: it only replicates
 * `requiredRole` + `isProjectScoped` + `accessFromMembership` + `satisfies`, none of which is where a
 * token's scope or its single-project restriction is applied. Those live inside `checkRequest` itself
 * (`src/auth/authorize.ts`), and `/api/tokens/*`'s self-service-only gate lives in `requireSession`
 * (`src/auth/plugin.ts`) — so both are exercised directly here instead of through the matrix.
 */
describe('API tokens (ADR-0076)', () => {
  const env = { allowedOrigins: [], needsSetup: false, hasAdminToken: true, metricsPublic: false };
  const facts = (over: Partial<Parameters<typeof checkRequest>[0]>) => ({
    method: 'GET',
    url: '/api/health',
    headers: {},
    host: 'example.test',
    principal: null,
    ...over,
  });

  it('requireSession accepts a session and refuses ADMIN_TOKEN and an API token', () => {
    const session = as('member');
    expect(requireSession({ principal: session } as never)).toBe(session);
    expect(() => requireSession({ principal: token } as never)).toThrow(ForbiddenError);
    expect(() => requireSession({ principal: asApiToken() } as never)).toThrow(ForbiddenError);
  });

  it("apiTokenAllowsRoute matches only the token's own scope, the brief's reindex-only scenario", () => {
    const scope = ['POST /api/projects/:id/reindex'];
    expect(apiTokenAllowsRoute(scope, 'POST', '/api/projects/:id/reindex')).toBe(true);
    expect(apiTokenAllowsRoute(scope, 'GET', '/api/projects/:id/reindex')).toBe(false);
    expect(apiTokenAllowsRoute(scope, 'GET', '/api/projects/:id/sources')).toBe(false);
    expect(apiTokenAllowsRoute(scope, 'DELETE', '/api/projects/:id')).toBe(false);
    expect(apiTokenAllowsRoute([], 'POST', '/api/projects/:id/reindex')).toBe(false);
    // Nor can it switch a Confluence or git delivery route on by minting its webhook secret.
    expect(apiTokenAllowsRoute(scope, 'POST', '/api/projects/:id/sources/:sid/webhook-secret')).toBe(false);
  });

  it('checkRequest lets a reindex-scoped token reindex and refuses it everything else', () => {
    const principal = asApiToken();
    expect(checkRequest(facts({ method: 'POST', url: '/api/projects/:id/reindex', principal, projectIdParam: 'p-1' }), env)).toBe(
      'needs-project-access',
    );
    expect(() => checkRequest(facts({ method: 'DELETE', url: '/api/projects/:id/sources/:sid', principal, projectIdParam: 'p-1' }), env)).toThrow(
      ForbiddenError,
    );
    expect(() => checkRequest(facts({ method: 'POST', url: '/api/projects', principal }), env)).toThrow(ForbiddenError);
  });

  it("checkRequest narrows a token to its owner's live role, even when its scope names a route the role cannot reach", () => {
    // A member-role token whose scope nominally lists an admin-only route: the ordinary role check
    // inside checkRequest runs first and refuses it before the scope is ever consulted.
    const principal = asApiToken({ role: 'member', scope: ['POST /api/projects'] });
    expect(() => checkRequest(facts({ method: 'POST', url: '/api/projects', principal }), env)).toThrow(ForbiddenError);

    // The same scope entry works once the owner's own role can reach the route.
    const admin = asApiToken({ role: 'admin', scope: ['POST /api/projects'] });
    expect(checkRequest(facts({ method: 'POST', url: '/api/projects', principal: admin }), env)).toBe('ok');
  });

  it('checkRequest restricts a project-bound token to the one project it names', () => {
    const principal = asApiToken({ projectId: 'p-1' });
    expect(checkRequest(facts({ method: 'POST', url: '/api/projects/:id/reindex', principal, projectIdParam: 'p-1' }), env)).toBe(
      'needs-project-access',
    );
    expect(() => checkRequest(facts({ method: 'POST', url: '/api/projects/:id/reindex', principal, projectIdParam: 'p-2' }), env)).toThrow(
      ForbiddenError,
    );
  });

  it("checkRequest refuses a project-bound token on instance-level routes, even when an unrelated :id happens to read the same as the token's project", () => {
    const principal = asApiToken({ role: 'admin', projectId: 'p-1', scope: ['GET /api/projects', 'PATCH /api/users/:id'] });
    // `GET /api/projects` carries no `:id` at all — a project-bound token cannot be "about" a route
    // that names no project, no matter what its scope list says.
    expect(() => checkRequest(facts({ method: 'GET', url: '/api/projects', principal }), env)).toThrow(ForbiddenError);
    // `/api/users/:id` does carry a `:id`, but it names a user, not a project. A token restricted to
    // project `p-1` must not slip through just because the id in this unrelated URL happens to read
    // `p-1` too — this is what the explicit `!isProjectScoped(...)` guard in `authorize.ts` catches,
    // distinct from the plain id comparison next to it (which a coincidental match defeats on its own).
    expect(() => checkRequest(facts({ method: 'PATCH', url: '/api/users/:id', principal, projectIdParam: 'p-1' }), env)).toThrow(ForbiddenError);
  });

  it('checkRequest leaves an unscoped token free to reach any project its owner already can', () => {
    const principal = asApiToken({ projectId: null });
    expect(checkRequest(facts({ method: 'POST', url: '/api/projects/:id/reindex', principal, projectIdParam: 'p-9' }), env)).toBe(
      'needs-project-access',
    );
  });

  it('records the creation of a token, with the id read back out of the response', () => {
    const id = '9c2c6a2e-6a1a-4f2e-9d3a-6f1c2b6a9c11';
    expect(auditCreatedTarget('POST', '/api/tokens', { token: { id }, secret: 'ctxk_the-secret' })).toEqual({
      type: 'tokenId',
      id,
    });
    // The secret itself never lands anywhere this table could read — only the declared `token.id` path does.
    expect(auditCreatedTarget('POST', '/api/tokens', { secret: 'ctxk_the-secret' })).toBeNull();
    expect(auditReadsResponse('POST', '/api/tokens')).toBe(true);
  });
});

/**
 * The query log's rules were written with its columns, before either route exists
 * ([ADR-0047](../.ssot/ADR.md#adr-0047)) — this PR is the write side and nothing reads it yet. The
 * matrix above is the decision; these two assertions are what make it one, because a rule that only
 * applies to a route nobody has registered is a rule that could have said anything.
 */
describe('the query log and the panel over it', () => {
  it('asks for a viewer to read and a manager to switch or purge', () => {
    expect(requiredProjectAccess('GET', '/api/projects/:id/query-log')).toBe('viewer');
    expect(requiredProjectAccess('PATCH', '/api/projects/:id/query-log')).toBe('manager');
    expect(requiredProjectAccess('DELETE', '/api/projects/:id/query-log')).toBe('manager');
  });

  /**
   * The panel's two routes ([ADR-0050](../.ssot/ADR.md#adr-0050)) are reads and take the `GET`
   * default. That is the decision and not an oversight, so it is asserted where somebody adding a row
   * to `PROJECT_ROUTE_OVERRIDES` will see it — and the export is asserted to be no more privileged
   * than the panel, because a file of the same rows is the same disclosure.
   */
  it('reads the panel and the export at the same access as the log itself', () => {
    expect(requiredProjectAccess('GET', '/api/projects/:id/queries/summary')).toBe('viewer');
    expect(requiredProjectAccess('GET', '/api/projects/:id/queries/export')).toBe('viewer');
    expect(requiredProjectAccess('GET', '/api/projects/:id/queries/export')).toBe(requiredProjectAccess('GET', '/api/projects/:id/query-log'));
    // And they are project-scoped, which is what makes the membership check run at all.
    expect(isProjectScoped('/api/projects/:id/queries/summary')).toBe(true);
    expect(isProjectScoped('/api/projects/:id/queries/export')).toBe(true);
  });

  it('puts the switch in the same class as deciding whether the MCP endpoint is public at all', () => {
    expect(requiredProjectAccess('PATCH', '/api/projects/:id/query-log')).toBe(requiredProjectAccess('PATCH', '/api/projects/:id/mcp-auth'));
    // And not in the class the default would have put it in, which is the whole reason for the row.
    expect(requiredProjectAccess('PATCH', '/api/projects/:id/anything-else')).toBe('editor');
  });
});

/**
 * The two transfer routes ([ADR-0051](../.ssot/ADR.md#adr-0051)), asserted as rules rather than only
 * as rows, because each of them is a *departure* from a default that would otherwise have answered.
 */
describe('moving a project between instances', () => {
  it('reads the whole project at the same access that decides who may reach it at all', () => {
    expect(requiredProjectAccess('GET', '/api/projects/:id/export')).toBe('manager');
    expect(requiredProjectAccess('GET', '/api/projects/:id/export')).toBe(requiredProjectAccess('PATCH', '/api/projects/:id/mcp-auth'));
    // And not what the default would have said, which is the whole reason the row exists.
    expect(requiredProjectAccess('GET', '/api/projects/:id/anything-else')).toBe('viewer');
  });

  it('asks the instance, not a membership, for the right to create a project by importing one', () => {
    expect(requiredRole('POST', '/api/projects/import')).toBe('admin');
    expect(requiredRole('POST', '/api/projects/import')).toBe(requiredRole('POST', '/api/projects'));
    // It is not project-scoped, which is what makes the instance rule the only rule that runs: there
    // is no membership to resolve for a project that does not exist yet.
    expect(isProjectScoped('/api/projects/import')).toBe(false);
    // A GET of the same path is not a thing, and must not inherit the POST's rule.
    expect(requiredRole('GET', '/api/projects/import')).toBeNull();
  });
});

/**
 * `/mcp/:project`, which is the one surface in this product whose rule is **not** in the table above
 * ([ADR-0054](../.ssot/ADR.md#adr-0054)). It is not an `/api/*` route and has no route template to
 * key on, so it is stated rather than derived — and it is asserted here, beside the table, because a
 * rule that lives somewhere else is a rule the next person changing permissions will not find.
 *
 * Every row states an actor, a mode and an answer, and every case that is allowed has a refused twin:
 * the negative rows are the ones that carry the decision, since the positive ones are also what the
 * previous behaviour did.
 */
const MCP_CASES: Array<{
  mode: McpAuthMode;
  actor: Principal | 'nobody' | 'static token';
  membership: 'viewer' | 'editor' | null;
  allowed: boolean;
}> = [
  // An open project, unchanged: anyone who can reach the URL, with or without a credential.
  { mode: 'open', actor: 'nobody', membership: null, allowed: true },
  { mode: 'open', actor: 'static token', membership: null, allowed: true },
  // ...except for the one thing that *is* new. A credential naming an account is judged by that
  // account's membership even here, which is the whole point of the entry.
  { mode: 'open', actor: as('member'), membership: 'viewer', allowed: true },
  { mode: 'open', actor: as('member'), membership: null, allowed: false },

  // A token project, unchanged for the credential every CLI install in the field is configured with.
  { mode: 'token', actor: 'nobody', membership: null, allowed: false },
  { mode: 'token', actor: 'static token', membership: null, allowed: true },
  { mode: 'token', actor: as('member'), membership: 'viewer', allowed: true },
  { mode: 'token', actor: as('member'), membership: null, allowed: false },

  // An account project: the static token stops working, and only a membership opens it.
  { mode: 'account', actor: 'nobody', membership: null, allowed: false },
  { mode: 'account', actor: 'static token', membership: null, allowed: false },
  { mode: 'account', actor: as('member'), membership: 'viewer', allowed: true },
  { mode: 'account', actor: as('member'), membership: 'editor', allowed: true },
  { mode: 'account', actor: as('member'), membership: null, allowed: false },
  // An administrator reaches every project in the dashboard and reaches every project here, by the
  // same `accessFromMembership` that decides it there rather than by a second rule.
  { mode: 'account', actor: as('admin'), membership: null, allowed: true },
  { mode: 'account', actor: as('root'), membership: null, allowed: true },
];

describe('the MCP endpoint, which the table above does not cover', () => {
  for (const c of MCP_CASES) {
    const who = typeof c.actor === 'string' ? c.actor : `${c.actor.role}${c.membership ? `/${c.membership}` : ' with no membership'}`;
    it(`${c.allowed ? 'lets' : 'refuses'} ${who} read a ${c.mode} project`, () => {
      const credential =
        c.actor === 'nobody'
          ? ({ kind: 'anonymous' } as const)
          : c.actor === 'static token'
            ? ({ kind: 'bearer' } as const)
            : ({ kind: 'account', access: accessFromMembership(c.actor, c.membership) } as const);
      expect(mcpAccessDecision(c.mode, credential) === 'ok').toBe(c.allowed);
    });
  }

  it('asks for the access a project page asks for, and not the one the method would have implied', () => {
    expect(MCP_READ_ACCESS).toBe('viewer');
    // Every MCP request is a POST, so the route-derived default would have said `editor` — which is
    // the reason this is a constant and not a lookup. The comparison is the assertion.
    expect(requiredProjectAccess('POST', '/api/projects/:id/anything-else')).toBe('editor');
    expect(MCP_READ_ACCESS).not.toBe(requiredProjectAccess('POST', '/api/projects/:id/anything-else'));
    expect(MCP_READ_ACCESS).toBe(requiredProjectAccess('GET', '/api/projects/:id/sources'));
  });

  /**
   * The OAuth endpoints are **deliberately outside** the policy table and outside `/api/*`: three of
   * them have to answer a client that holds nothing at all (RFC 9728 and RFC 8414 exist to be fetched
   * anonymously, and RFC 7591 registration grants nothing), and the two that decide anything read the
   * dashboard's session cookie directly. Asserted here so that "it is not in the table" is a claim
   * somebody wrote down rather than a gap.
   */
  it('keeps the OAuth flow out of the policy table, and out of the surface the table governs', () => {
    for (const url of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/authorize',
      '/oauth/token',
      '/oauth/revoke',
    ]) {
      expect(url.startsWith('/api/')).toBe(false);
      expect(isProjectScoped(url)).toBe(false);
      expect(requiredRole('POST', url)).toBeNull();
      expect(PUBLIC_ROUTES.has(url)).toBe(false);
    }
  });
});

/**
 * **What a project is when nobody has decided anything about it yet**
 * ([ADR-0065](../.ssot/ADR.md#adr-0065), PRD.md FR-510).
 *
 * The rows above say what each mode does; these say which of them a project is *born* in, which is a
 * separate claim and the one that decides what an operator who reads no documentation ends up
 * running. It is asserted through `DEFAULT_MCP_AUTH` rather than against the literal `'token'`,
 * because the constant is what the column default and the creation path are both built from: move it
 * and these assertions move with it, which is exactly what makes them catch the move.
 *
 * Both directions, because only the pair means anything. The refusal alone would pass on a build that
 * refused everything, and the acceptance alone would pass on the previous default.
 */
describe('the mode a project is born in', () => {
  it('is not the mode that answers anybody who can reach the URL', () => {
    expect(DEFAULT_MCP_AUTH).not.toBe('open');
  });

  it('refuses a request that carries no credential, with a 401', () => {
    const verdict = mcpAccessDecision(DEFAULT_MCP_AUTH, { kind: 'anonymous' });
    expect(verdict).toBe('token_missing');
    expect(mcpAccessStatus(verdict as Exclude<typeof verdict, 'ok'>)).toBe(401);
  });

  it('refuses a bearer that resolves to nothing, with a 401', () => {
    const verdict = mcpAccessDecision(DEFAULT_MCP_AUTH, { kind: 'unknown' });
    expect(verdict).toBe('token_invalid');
    expect(mcpAccessStatus(verdict as Exclude<typeof verdict, 'ok'>)).toBe(401);
  });

  it('answers the first token minted with the project', () => {
    expect(mcpAccessDecision(DEFAULT_MCP_AUTH, { kind: 'bearer' })).toBe('ok');
  });

  it('answers an account that is a member of it', () => {
    expect(mcpAccessDecision(DEFAULT_MCP_AUTH, { kind: 'account', access: 'viewer' })).toBe('ok');
    expect(mcpAccessDecision(DEFAULT_MCP_AUTH, { kind: 'account', access: 'none' })).toBe('not_a_member');
  });
});

describe('access ordering', () => {
  it('ranks manager over editor over viewer over none', () => {
    const order: ProjectAccess[] = ['none', 'viewer', 'editor', 'manager'];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(satisfies(order[i], order[j])).toBe(i >= j);
      }
    }
  });
});

describe('user management', () => {
  it('is open to root and admin, closed to a member', () => {
    expect(canManageUsers(as('root'))).toBe(true);
    expect(canManageUsers(as('admin'))).toBe(true);
    expect(canManageUsers(as('member'))).toBe(false);
    expect(requiredRole('GET', '/api/users')).toBe('admin');
    expect(requiredRole('DELETE', '/api/users/:id/sessions')).toBe('admin');
  });

  it('lets only a root account create or change another root account', () => {
    expect(canActOnRole(as('root'), 'root')).toBe(true);
    expect(canActOnRole(as('admin'), 'root')).toBe(false);
    expect(canActOnRole(as('admin'), 'admin')).toBe(true);
    expect(canActOnRole(as('admin'), 'member')).toBe(true);
    expect(canActOnRole(token, 'root')).toBe(true);
  });
});

/**
 * The panel over the audit log ([ADR-0055](../.ssot/ADR.md#adr-0055)).
 *
 * Two claims the matrix above cannot make on its own. The first is that the rule is stated as a
 * *prefix* and so already covers a second audit route nobody has written — the same property
 * `/api/users` has, and the reason neither is a list. The second is that the log is **not** project
 * scoped: were it ever moved under `/api/projects/:id`, `requiredProjectAccess` would fall a `GET` to
 * `viewer` and every member of any project would read the whole instance's record.
 */
describe('reading the audit log', () => {
  it('asks for the standing user management asks for, on every route under it', () => {
    expect(requiredRole('GET', '/api/audit')).toBe('admin');
    expect(requiredRole('GET', '/api/audit/whatever-comes-next')).toBe('admin');
  });

  it('is not a project route, so no membership can open it', () => {
    expect(isProjectScoped('/api/audit')).toBe(false);
    expect(accessFromMembership(as('member'), 'editor')).toBe('editor');
    // Stated against the whole decision and not just the role lookup: a membership is irrelevant here.
    expect(allows(as('member'), 'editor', 'GET', '/api/audit')).toBe(false);
    expect(allows(as('admin'), null, 'GET', '/api/audit')).toBe(true);
  });

  it('is a read and nothing else — reading it is not itself an event', () => {
    expect(auditSubject('GET', '/api/audit', {}, undefined)).toBeNull();
  });
});

/**
 * `/metrics` ([ADR-0055](../.ssot/ADR.md#adr-0055)), which is the one route in this product whose rule
 * reads a *setting*. The decision it encodes is that a scrape is not public by default — the exposition
 * names the version, the model, the queue and the pool, which is a description of the instance — and
 * that closing it must not mean handing Prometheus an `ADMIN_TOKEN` that acts with root permissions.
 *
 * Every row here has its twin: each way in is asserted to open it, and asserted to be *needed*, because
 * a test that only proved the three positives would pass just as happily on a build that let everyone in.
 */
describe('the metrics endpoint', () => {
  const env = { allowedOrigins: [], needsSetup: false, hasAdminToken: true };
  const ask = (facts: { principal?: Principal | null; metricsTokenPresented?: boolean }, metricsPublic = false) =>
    checkRequest(
      {
        method: 'GET',
        url: METRICS_ROUTE,
        headers: {},
        host: 'localhost',
        principal: facts.principal ?? null,
        metricsTokenPresented: facts.metricsTokenPresented,
      },
      { ...env, metricsPublic },
    );

  it('refuses a caller holding nothing, which is the whole reason it is not in PUBLIC_ROUTES', () => {
    expect(PUBLIC_ROUTES.has(METRICS_ROUTE)).toBe(false);
    expect(() => ask({})).toThrow();
  });

  it('answers a scrape token, and only while one is configured', () => {
    expect(ask({ metricsTokenPresented: true })).toBe('ok');
    // The flag is computed from `METRICS_TOKEN` in src/auth/plugin.ts, so `false` here is both "no
    // token configured" and "the wrong one was presented". Both are the same refusal.
    expect(() => ask({ metricsTokenPresented: false })).toThrow();
  });

  it('answers anybody once METRICS_PUBLIC is on, and nobody until it is', () => {
    expect(ask({}, true)).toBe('ok');
    expect(() => ask({}, false)).toThrow();
  });

  it('answers an ordinary signed-in account with neither of those, and asks for no role', () => {
    expect(ask({ principal: as('member') })).toBe('ok');
    expect(ask({ principal: token })).toBe('ok');
    expect(requiredRole('GET', METRICS_ROUTE)).toBeNull();
    // Not project-scoped, so no membership is ever resolved for it.
    expect(isProjectScoped(METRICS_ROUTE)).toBe(false);
  });
});

/**
 * The audit log's rule ([ADR-0055](../.ssot/ADR.md#adr-0055)), which is **the permission table's shape
 * turned round**: auditing is the default and the exemptions are the list, so a route added next month
 * is recorded without anybody remembering to record it.
 *
 * The assertions that carry the decision are the ones about routes that do *not* exist. A table of
 * audited routes would pass a test listing the routes it contains; this one is asserted against a path
 * nobody has registered, because that is the property being claimed.
 */
describe('what the audit log records', () => {
  const subject = (method: string, url: string, params: Record<string, unknown> = {}, body?: unknown) => auditSubject(method, url, params, body);

  it('records an unsafe method on a route nobody has written yet, and no safe one', () => {
    expect(subject('POST', '/api/projects/:id/something-nobody-has-built')?.action).toBe('POST /api/projects/:id/something-nobody-has-built');
    expect(subject('DELETE', '/api/projects/:id/something-nobody-has-built')).not.toBeNull();
    // A read changes nothing, so there is nothing to attribute. This is what keeps the table from
    // becoming a traffic log — and `GET /api/projects/:id/export` is the case that proves it matters,
    // since that one is a `manager`'s and still records nothing here.
    expect(subject('GET', '/api/projects/:id/export')).toBeNull();
    expect(subject('HEAD', '/api/projects/:id')).toBeNull();
  });

  it('leaves alone what is not the admin API at all', () => {
    expect(subject('POST', '/mcp/:project')).toBeNull();
    expect(subject('POST', '/oauth/token')).toBeNull();
  });

  it('exempts exactly eight routes, and each of them for a reason written beside it', () => {
    expect([...AUDIT_EXEMPT_ROUTES].sort()).toEqual([
      '/api/projects/:id/sources/:sid/test',
      '/api/projects/:id/sources/:sid/uploads/:session/files',
      '/api/webhooks/confluence/:sourceId',
      '/api/webhooks/git/:sourceId',
      '/api/webhooks/notion/:sourceId',
      '/oauth/register',
      '/oauth/revoke',
      '/oauth/token',
    ]);
    for (const url of AUDIT_EXEMPT_ROUTES) expect(subject('POST', url)).toBeNull();
    // And the one they are exempted *against*: the commit is what changes the project, and it is
    // recorded, which is the reason recording each staged file would be noise rather than evidence.
    expect(subject('POST', '/api/projects/:id/sources/:sid/uploads/:session/commit')).not.toBeNull();
  });

  /**
   * **The OAuth surface is inside the rule, not beside it.** Approving a connector is a person granting
   * a client lasting read access to one project — the `PATCH /api/projects/:id/mcp-auth` class of act,
   * and the moment [ADR-0054](../.ssot/ADR.md#adr-0054)'s "credential that names a person" is created.
   * The three that are not recorded are named in the exemption list above with their reasons, which is
   * the difference between an exemption and a gap.
   */
  it('records the approval of a connector, and says why the rest of the flow is not recorded', () => {
    const approval = subject('POST', '/oauth/authorize', {}, { decision: 'approve' });
    expect(approval?.action).toBe('POST /oauth/authorize');
    // The substance: which way the person decided. The only closed-set field on this route.
    expect(approval?.detail).toEqual({ decision: 'approve' });
    expect(subject('POST', '/oauth/authorize', {}, { decision: 'deny' })?.detail).toEqual({ decision: 'deny' });
    // A value outside the set — including the redirect URI and the state the body also carries.
    expect(subject('POST', '/oauth/authorize', {}, { decision: 'maybe', redirect_uri: 'https://c.example/cb' })?.detail).toEqual({});
    // Reading the approval page changes nothing, so it is not an event.
    expect(subject('GET', '/oauth/authorize')).toBeNull();
    // And the three machine endpoints are silent *by name*, not by falling outside the rule.
    for (const url of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
      expect(AUDIT_EXEMPT_ROUTES.has(url)).toBe(true);
      expect(subject('POST', url)).toBeNull();
    }
  });

  /**
   * **Sign-in and first-run setup are recorded**, and that took removing them from the exemption list
   * rather than adding a call: both create the identity they act as, so the handler names the actor it
   * turned into and the one writer stays one writer. Without them the table would hold logouts and no
   * sign-ins, and the record it would have been deferring to — `users.last_login_at` — is one column
   * overwritten on every sign-in rather than a history of them.
   */
  it('records a sign-in and the creation of the first account', () => {
    expect(subject('POST', '/api/auth/login')?.action).toBe('POST /api/auth/login');
    expect(subject('POST', '/api/setup')?.action).toBe('POST /api/setup');
    expect(AUDIT_EXEMPT_ROUTES.has('/api/auth/login')).toBe(false);
    expect(AUDIT_EXEMPT_ROUTES.has('/api/setup')).toBe(false);
    // Neither may record anything of what was posted — both bodies carry a password.
    expect(subject('POST', '/api/auth/login', {}, { username: 'dana', password: 'a-real-password' })?.detail).toEqual({});
    expect(subject('POST', '/api/setup', {}, { code: 'SETUP-CODE', password: 'a-real-password' })?.detail).toEqual({});
  });

  /**
   * **A creating route names nothing in its path**, so the id of what it created is read back out of
   * the response — through a table of fixed paths, and only when the value found there is a UUID.
   * Those two together are why a response body can contribute an id to `audit_events` and nothing else.
   */
  it('takes the created id from the response, and only a UUID at a declared path', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(auditCreatedTarget('POST', '/api/projects/:id/mcp-tokens', { token: { id }, secret: 'ctxm_the-secret' })).toEqual({
      type: 'tokenId',
      id,
    });
    expect(auditCreatedTarget('POST', '/api/users', { user: { id }, temporaryPassword: 'a-temporary-password' })).toEqual({ type: 'userId', id });
    expect(auditCreatedTarget('POST', '/api/projects', { id, name: 'handbook' })).toEqual({ type: 'projectId', id });
    expect(auditCreatedTarget('POST', '/api/projects/:id/sources', { id, name: 'handbook' })).toEqual({ type: 'sid', id });
    expect(auditCreatedTarget('POST', '/api/projects/import', { projectId: id })).toEqual({ type: 'projectId', id });
    expect(auditCreatedTarget('POST', '/api/setup', { user: { id } })).toEqual({ type: 'userId', id });

    // A route nobody declared reads nothing, whatever its response holds.
    expect(auditCreatedTarget('POST', '/api/projects/:id/reindex', { id })).toBeNull();
    // The declared path and nothing else: the same value one key over is not found.
    expect(auditCreatedTarget('POST', '/api/users', { id })).toBeNull();
    // And it has to be a UUID, which is what stops a name or a secret from landing in `target_id`.
    expect(auditCreatedTarget('POST', '/api/projects', { id: 'handbook' })).toBeNull();
    expect(auditCreatedTarget('POST', '/api/projects/:id/mcp-tokens', { token: { id: 'ctxm_a-minted-secret' } })).toBeNull();
    expect(auditCreatedTarget('POST', '/api/projects', null)).toBeNull();
  });

  it('asks to read a response only for the routes that create something', () => {
    expect(auditReadsResponse('POST', '/api/projects/:id/mcp-tokens')).toBe(true);
    // Every other response is never deserialised at all, which is both the cost argument and the
    // reason nothing else can be extracted from one.
    expect(auditReadsResponse('POST', '/api/projects/:id/reindex')).toBe(false);
    expect(auditReadsResponse('GET', '/api/projects')).toBe(false);
    expect(auditReadsResponse('DELETE', '/api/projects/:id/sources/:sid')).toBe(false);
  });

  it('names the project from the path and the target from the route template, not from the body', () => {
    const event = subject('DELETE', '/api/projects/:id/sources/:sid', { id: 'p-1', sid: 's-9' });
    expect(event).toEqual({ action: 'DELETE /api/projects/:id/sources/:sid', projectId: 'p-1', targetType: 'sid', targetId: 's-9', detail: {} });
    // An instance route has no project, and its own `:id` is the target rather than a project id.
    expect(subject('DELETE', '/api/users/:id', { id: 'u-3' })).toEqual({
      action: 'DELETE /api/users/:id',
      projectId: null,
      targetType: 'id',
      targetId: 'u-3',
      detail: {},
    });
  });

  /**
   * **The assertion the privacy page rests on.** `search_queries` holds what people typed; this table
   * holds what an operator did, and the separation is only real if no request body can put text in it.
   * The allowlist is the mechanism, so it is tested as one: a named field with a value outside its set
   * is dropped, and a field nobody named is dropped whatever it holds.
   */
  it('cannot be made to store user content, whatever the body says', () => {
    const body = {
      mode: 'account',
      query: 'how do I rotate the signing key',
      secret: 'ctxm_lookslikeacredential',
      note: 'a paragraph somebody typed',
    };
    expect(subject('PATCH', '/api/projects/:id/mcp-auth', { id: 'p-1' }, body)?.detail).toEqual({ mode: 'account' });
    // A value outside the closed set is not a value this table can hold, even under a named field.
    expect(subject('PATCH', '/api/projects/:id/mcp-auth', { id: 'p-1' }, { mode: 'something-new' })?.detail).toEqual({});
    // And a route that names no fields at all records none, whatever it was sent.
    expect(subject('POST', '/api/projects/:id/reindex', { id: 'p-1' }, body)?.detail).toEqual({});
    expect(subject('POST', '/api/auth/password', {}, { password: 'a-real-password' })?.detail).toEqual({});
  });

  it('keeps the boolean of the query-log switch a boolean, and the roles a closed set', () => {
    expect(subject('PATCH', '/api/projects/:id/query-log', { id: 'p-1' }, { enabled: false })?.detail).toEqual({ enabled: false });
    expect(subject('PUT', '/api/projects/:id/members/:userId', { id: 'p-1', userId: 'u-2' }, { role: 'editor' })?.detail).toEqual({ role: 'editor' });
    // `manager` is a `ProjectAccess`, not a membership role, and must not be recordable as one.
    expect(subject('PUT', '/api/projects/:id/members/:userId', { id: 'p-1', userId: 'u-2' }, { role: 'manager' })?.detail).toEqual({});
  });

  it('records the three acts the log exists for, each with the project it happened on', () => {
    for (const [method, url] of [
      ['DELETE', '/api/projects/:id/sources/:sid'],
      ['POST', '/api/projects/:id/mcp-tokens'],
      ['PATCH', '/api/projects/:id/mcp-auth'],
    ] as const) {
      expect(subject(method, url, { id: 'p-1', sid: 's-9' })?.projectId).toBe('p-1');
    }
  });
});

describe('the allowlists', () => {
  it('opens exactly the routes that must work before anyone is signed in', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      '/api/auth/login',
      '/api/auth/oidc/callback',
      '/api/auth/oidc/login',
      '/api/health',
      '/api/setup',
      '/api/setup/status',
    ]);
  });

  it('leaves only the password-change loop reachable while a temporary password stands', () => {
    expect([...PASSWORD_CHANGE_ALLOWED].sort()).toEqual(['/api/auth/logout', '/api/auth/me', '/api/auth/password', '/api/health']);
    expect(PASSWORD_CHANGE_ALLOWED.has('/api/projects')).toBe(false);
  });
});
