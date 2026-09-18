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
