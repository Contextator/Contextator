import { describe, expect, it } from 'vitest';
import { checkProjectAccess, checkRequest, type AuthorizeEnv, type RequestFacts } from '../src/auth/authorize.js';
import { ForbiddenError, UnauthorizedError } from '../src/services/errors.js';
import { NotFoundError } from '../src/services/projects.js';
import type { Principal } from '../src/auth/types.js';

const HOST = 'docs.example.com';
const SAME_SITE = { 'sec-fetch-site': 'same-origin' };

const session = (over: Partial<Extract<Principal, { kind: 'session' }>> = {}): Principal => ({
  kind: 'session',
  role: 'admin',
  userId: 'u1',
  username: 'alice',
  sessionId: 's1',
  mustChangePassword: false,
  ...over,
});
const token: Principal = { kind: 'token', role: 'root', userId: null, username: 'ADMIN_TOKEN', mustChangePassword: false };

const env = (over: Partial<AuthorizeEnv> = {}): AuthorizeEnv => ({ allowedOrigins: [], needsSetup: false, hasAdminToken: false, ...over });
const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  method: 'GET',
  url: '/api/projects',
  headers: SAME_SITE,
  host: HOST,
  principal: session(),
  ...over,
});

describe('public routes', () => {
  it('let an anonymous request through', () => {
    for (const url of ['/api/health', '/api/auth/login', '/api/setup', '/api/setup/status']) {
      expect(checkRequest(facts({ url, principal: null, method: 'POST' }), env())).toBe('ok');
    }
  });
});

describe('an anonymous request to anything else', () => {
  it('is unauthorized once accounts exist', () => {
    expect(() => checkRequest(facts({ principal: null }), env())).toThrow(UnauthorizedError);
    try {
      checkRequest(facts({ principal: null }), env());
    } catch (err) {
      expect((err as UnauthorizedError).code).toBe('unauthorized');
    }
  });

  it('says setup_required instead while the instance has no account and no ADMIN_TOKEN', () => {
    try {
      checkRequest(facts({ principal: null }), env({ needsSetup: true }));
      expect.unreachable();
    } catch (err) {
      expect((err as UnauthorizedError).code).toBe('setup_required');
    }
  });

  it('keeps saying unauthorized when ADMIN_TOKEN is the way in', () => {
    try {
      checkRequest(facts({ principal: null }), env({ needsSetup: true, hasAdminToken: true }));
      expect.unreachable();
    } catch (err) {
      expect((err as UnauthorizedError).code).toBe('unauthorized');
    }
  });
});

describe('CSRF', () => {
  it('blocks a cross-site write that carries a session cookie', () => {
    const cross = facts({ method: 'POST', url: '/api/projects', headers: { 'sec-fetch-site': 'cross-site' }, principal: session({ role: 'root' }) });
    expect(() => checkRequest(cross, env())).toThrow(ForbiddenError);
    try {
      checkRequest(cross, env());
    } catch (err) {
      expect((err as ForbiddenError).code).toBe('csrf_blocked');
    }
  });

  it('lets the same request through with ADMIN_TOKEN, which carries no ambient credential', () => {
    expect(checkRequest(facts({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, principal: token }), env())).toBe('ok');
  });

  it('never blocks a read', () => {
    expect(checkRequest(facts({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }), env())).toBe('ok');
  });
});

describe('a temporary password', () => {
  const stale = session({ mustChangePassword: true });

  it('locks every endpoint but the ones needed to replace it', () => {
    for (const url of ['/api/health', '/api/auth/me', '/api/auth/password', '/api/auth/logout']) {
      expect(checkRequest(facts({ url, principal: stale, method: 'POST' }), env())).toBe('ok');
    }
    try {
      checkRequest(facts({ url: '/api/projects', principal: stale }), env());
      expect.unreachable();
    } catch (err) {
      expect((err as ForbiddenError).code).toBe('password_change_required');
    }
  });

  it('is checked after CSRF, so a cross-site write is refused for the right reason', () => {
    try {
      checkRequest(facts({ method: 'POST', url: '/api/users', headers: {}, principal: stale }), env());
      expect.unreachable();
    } catch (err) {
      expect((err as ForbiddenError).code).toBe('csrf_blocked');
    }
  });
});

describe('instance roles', () => {
  it('keep a member out of user management and project creation', () => {
    const member = session({ role: 'member' });
    expect(() => checkRequest(facts({ url: '/api/users', principal: member }), env())).toThrow(ForbiddenError);
    expect(() => checkRequest(facts({ method: 'POST', url: '/api/projects', principal: member }), env())).toThrow(ForbiddenError);
    // Listing projects is fine; the handler filters it down to the memberships.
    expect(checkRequest(facts({ url: '/api/projects', principal: member }), env())).toBe('ok');
  });
});

describe('project-scoped routes', () => {
  it('defer to the membership the caller still has to look up', () => {
    expect(checkRequest(facts({ url: '/api/projects/:id/sources' }), env())).toBe('needs-project-access');
    expect(checkRequest(facts({ url: '/api/projects/:id/sources/:sid/uploads/:session/files', method: 'POST' }), env())).toBe('needs-project-access');
  });

  it('answer 404 without access, so project ids cannot be probed', () => {
    expect(() => checkProjectAccess('GET', '/api/projects/:id/sources', 'none')).toThrow(NotFoundError);
  });

  it('answer 403 when the access is real but not enough', () => {
    expect(() => checkProjectAccess('POST', '/api/projects/:id/reindex', 'viewer')).toThrow(ForbiddenError);
    expect(() => checkProjectAccess('POST', '/api/projects/:id/reindex', 'editor')).not.toThrow();
    expect(() => checkProjectAccess('DELETE', '/api/projects/:id', 'editor')).toThrow(ForbiddenError);
    expect(() => checkProjectAccess('DELETE', '/api/projects/:id', 'manager')).not.toThrow();
    expect(() => checkProjectAccess('GET', '/api/projects/:id/sources', 'viewer')).not.toThrow();
  });
});
