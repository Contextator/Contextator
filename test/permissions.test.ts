import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXEMPT_ROUTES,
  MCP_READ_ACCESS,
  METRICS_ROUTE,
  PASSWORD_CHANGE_ALLOWED,
  PUBLIC_ROUTES,
  accessFromMembership,
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
import { mcpAccessDecision } from '../src/mcp/access.js';
import type { McpAuthMode } from '../src/db/schema.js';
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

  // Membership: anyone on the project sees who else is; only root/admin change it.
  { method: 'GET', url: '/api/projects/:id/members', actor: as('member'), membership: 'viewer', allowed: true },
  { method: 'PUT', url: '/api/projects/:id/members/:userId', actor: as('member'), membership: 'editor', allowed: false },
  { method: 'PUT', url: '/api/projects/:id/members/:userId', actor: as('admin'), membership: null, allowed: true },
  { method: 'DELETE', url: '/api/projects/:id/members/:userId', actor: as('member'), membership: 'editor', allowed: false },
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

  it('exempts exactly four routes that change something and two that have no actor', () => {
    expect([...AUDIT_EXEMPT_ROUTES].sort()).toEqual([
      '/api/auth/login',
      '/api/projects/:id/sources/:sid/test',
      '/api/projects/:id/sources/:sid/uploads/:session/files',
      '/api/setup',
      '/api/webhooks/git/:sourceId',
      '/api/webhooks/notion/:sourceId',
    ]);
    for (const url of AUDIT_EXEMPT_ROUTES) expect(subject('POST', url)).toBeNull();
    // And the one they are exempted *against*: the commit is what changes the project, and it is
    // recorded, which is the reason recording each staged file would be noise rather than evidence.
    expect(subject('POST', '/api/projects/:id/sources/:sid/uploads/:session/commit')).not.toBeNull();
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
    expect([...PUBLIC_ROUTES].sort()).toEqual(['/api/auth/login', '/api/health', '/api/setup', '/api/setup/status']);
  });

  it('leaves only the password-change loop reachable while a temporary password stands', () => {
    expect([...PASSWORD_CHANGE_ALLOWED].sort()).toEqual(['/api/auth/logout', '/api/auth/me', '/api/auth/password', '/api/health']);
    expect(PASSWORD_CHANGE_ALLOWED.has('/api/projects')).toBe(false);
  });
});
