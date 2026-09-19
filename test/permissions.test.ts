import { describe, expect, it } from 'vitest';
import {
  PASSWORD_CHANGE_ALLOWED,
  PUBLIC_ROUTES,
  accessFromMembership,
  canActOnRole,
  canManageUsers,
  isProjectScoped,
  requiredProjectAccess,
  requiredRole,
  roleAtLeast,
  satisfies,
} from '../src/auth/policy.js';
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

describe('the allowlists', () => {
  it('opens exactly the routes that must work before anyone is signed in', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual(['/api/auth/login', '/api/health', '/api/setup', '/api/setup/status']);
  });

  it('leaves only the password-change loop reachable while a temporary password stands', () => {
    expect([...PASSWORD_CHANGE_ALLOWED].sort()).toEqual(['/api/auth/logout', '/api/auth/me', '/api/auth/password', '/api/health']);
    expect(PASSWORD_CHANGE_ALLOWED.has('/api/projects')).toBe(false);
  });
});
