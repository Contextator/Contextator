import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { ForbiddenError, UnauthorizedError } from '../services/errors.js';
import { resolveProjectAccess } from '../services/auth/memberships.js';
import { findSessionUser, touchSession } from '../services/auth/sessions.js';
import { checkProjectAccess, checkRequest } from './authorize.js';
import { clearSessionCookie, readSessionCookie } from './cookies.js';
import type { Principal } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Constant-time comparison that does not leak the length either. */
export function timingSafeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const TOKEN_PRINCIPAL: Principal = { kind: 'token', role: 'root', userId: null, username: 'ADMIN_TOKEN', mustChangePassword: false };

const readBearer = (header: string | undefined): string =>
  header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

/**
 * Identity and authorization for everything under /api/*, in two hooks.
 *
 * Called directly on the adminRoutes instance rather than registered as a plugin: `register()`
 * encapsulates, and an encapsulated `addHook` would apply to that child alone — which holds no
 * routes. Installed on adminRoutes itself, the hooks reach every route it and its nested source,
 * upload, user and member plugins declare. `req.routeOptions.url` gives the full route template
 * even four plugins deep, which is why one policy table covers them all.
 */
export function installAuth(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;

  app.decorateRequest('principal', null); // must be a primitive: object defaults are shared between requests
  app.decorateRequest('projectAccess', null);

  // 1) Who is this? No enforcement here — /api/health and the login route need to run either way.
  app.addHook('onRequest', async (req, reply) => {
    const bearer = readBearer(req.headers.authorization);
    if (bearer && config.ADMIN_TOKEN && timingSafeCompare(bearer, config.ADMIN_TOKEN)) {
      req.principal = TOKEN_PRINCIPAL;
      return;
    }
    const raw = readSessionCookie(req);
    if (!raw) return;
    const session = await findSessionUser(db, raw, config.AUTH_SESSION_IDLE_MS);
    if (!session) {
      clearSessionCookie(reply, req, config);
      return;
    }
    req.principal = {
      kind: 'session',
      role: session.role,
      userId: session.userId,
      username: session.username,
      sessionId: session.sessionId,
      mustChangePassword: session.mustChangePassword,
    };
    // Sliding idle window, off the response path: touchSession only writes once a minute.
    void touchSession(db, session.sessionId).catch((err: unknown) => req.log.debug({ err }, 'session touch failed'));
  });

  // 2) May they do this? Every rule that does not need the database lives in authorize.ts.
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions.url ?? '';
    const verdict = checkRequest(
      { method: req.method, url, headers: req.headers, host: req.host, principal: req.principal },
      { allowedOrigins: config.ALLOWED_ORIGINS, needsSetup: ctx.setup.needsSetup, hasAdminToken: Boolean(config.ADMIN_TOKEN) },
    );
    if (verdict === 'ok') return;

    const id = (req.params as { id?: string }).id;
    if (!id || !UUID_RE.test(id)) return; // let the handler's zod parse answer 400
    const access = await resolveProjectAccess(db, req.principal!, id);
    checkProjectAccess(req.method, url, access);
    req.projectAccess = access;
  });
}

/** Handlers that need the principal but are registered where TypeScript cannot see the hook ran. */
export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}

export function requireSession(req: FastifyRequest): Extract<Principal, { kind: 'session' }> {
  const principal = requirePrincipal(req);
  if (principal.kind !== 'session') {
    throw new ForbiddenError('token_has_no_account', 'ADMIN_TOKEN is machine access; this needs a user account');
  }
  return principal;
}
