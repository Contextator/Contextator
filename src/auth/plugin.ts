import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { ForbiddenError, UnauthorizedError } from '../services/errors.js';
import { resolveProjectAccess } from '../services/auth/memberships.js';
import { verifyApiToken } from '../services/auth/api-tokens.js';
import { findSessionUser, touchSession } from '../services/auth/sessions.js';
import { checkProjectAccess, checkRequest } from './authorize.js';
import { auditCreatedTarget, auditReadsResponse, auditSubject, METRICS_ROUTE, PUBLIC_ROUTES } from './policy.js';
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

const readBearer = (header: string | undefined): string => (header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '');

/**
 * Identity and authorization for everything under /api/*, in three hooks.
 *
 * Called directly on the adminRoutes instance rather than registered as a plugin: `register()`
 * encapsulates, and an encapsulated `addHook` would apply to that child alone — which holds no
 * routes. Installed on adminRoutes itself, the hooks reach every route it and its nested source,
 * upload, user and member plugins declare. `req.routeOptions.url` gives the full route template
 * even four plugins deep, which is why one policy table covers them all.
 */
export function installAuth(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;
  /** Read once: it is the one credential in this file that is compared against a single route. */
  const scrapeToken = config.METRICS_TOKEN;

  app.decorateRequest('principal', null); // must be a primitive: object defaults are shared between requests
  app.decorateRequest('projectAccess', null);

  // 1) Who is this? No enforcement here — /api/health and the login route need to run either way.
  app.addHook('onRequest', async (req, reply) => {
    const bearer = readBearer(req.headers.authorization);
    if (bearer && config.ADMIN_TOKEN && timingSafeCompare(bearer, config.ADMIN_TOKEN)) {
      req.principal = TOKEN_PRINCIPAL;
      return;
    }
    // An [ADR-0076](../../.ssot/ADR.md#adr-0076) API token — its own account, its own scope, its own
    // expiry, revocable on its own. `verifyApiToken` reads the owner's role fresh on every call, so a
    // demotion or deactivation reaches every token that account holds without touching a row of theirs.
    if (bearer) {
      const identity = await verifyApiToken(db, bearer);
      if (identity) {
        req.principal = {
          kind: 'apiToken',
          role: identity.role,
          userId: identity.userId,
          username: identity.username,
          tokenId: identity.tokenId,
          scope: identity.scope,
          projectId: identity.projectId,
          mustChangePassword: identity.mustChangePassword,
        };
        return;
      }
    }
    const raw = readSessionCookie(req);
    if (!raw) return;
    let session: Awaited<ReturnType<typeof findSessionUser>>;
    try {
      session = await findSessionUser(db, raw, config.AUTH_SESSION_IDLE_MS);
    } catch (err) {
      // A session is a row, so an unreachable database cannot identify anybody. On a public route
      // that is not an error: /api/health has to be able to answer its 503 to the dashboard poll
      // that carries a cookie, and it answers the anonymous shape because that is all it knows
      // (ADR-0032). Everywhere else this stays the 500 it has always been — pretending the caller
      // is anonymous there would answer 401 and send a signed-in operator back to /login.
      // `/metrics` joins the public routes here and **only** here ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
      // A session is a row, so an unreachable database cannot confirm one — and this endpoint exists to
      // be readable precisely while the database is unreachable. Throwing would answer the operator's
      // own browser `500` on the one page that was supposed to tell them what is wrong. It opens
      // nothing: the request continues *anonymous*, and the rule below then answers `401` unless
      // `METRICS_PUBLIC` or a `METRICS_TOKEN` bearer says otherwise — which are exactly the two
      // credentials that can be checked without the database.
      const routeUrl = req.routeOptions.url ?? '';
      if (!PUBLIC_ROUTES.has(routeUrl) && routeUrl !== METRICS_ROUTE) throw err;
      req.log.warn({ err }, 'could not resolve the session cookie; answering this route anonymously');
      return;
    }
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
    // Read before `checkRequest` so an `apiToken`'s single-project restriction can be checked in the
    // same pass as every other rule, without a second round trip through the caller.
    const id = (req.params as { id?: string }).id;
    const verdict = checkRequest(
      {
        method: req.method,
        url,
        headers: req.headers,
        host: req.host,
        principal: req.principal,
        // Computed here because the comparison has to be constant-time and the policy layer holds no
        // secrets; `checkRequest` is handed the answer, not the credential. Only for the one route it
        // can open — two SHA-256 digests on every request to buy nothing would be a silly price.
        metricsTokenPresented:
          url === METRICS_ROUTE && scrapeToken !== undefined && timingSafeCompare(readBearer(req.headers.authorization), scrapeToken),
        projectIdParam: id,
      },
      {
        allowedOrigins: config.ALLOWED_ORIGINS,
        needsSetup: ctx.setup.needsSetup,
        hasAdminToken: Boolean(config.ADMIN_TOKEN),
        metricsPublic: config.METRICS_PUBLIC,
      },
    );
    if (verdict === 'ok') return;

    if (!id || !UUID_RE.test(id)) return; // let the handler's zod parse answer 400
    const access = await resolveProjectAccess(db, req.principal!, id);
    checkProjectAccess(req.method, url, access);
    req.projectAccess = access;
  });

  // 3) What did they just change? Installed here, and by `oauthRoutes` on its own instance.
  installAuditLog(app, ctx);
}

/**
 * The audit log's two hooks ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
 *
 * **Here rather than in the routes**, and that is the whole of the design: a call added per handler is
 * as complete as the handler somebody forgot to add it to, while these hooks cover every route the
 * instance they are installed on declares — including ones written after them.
 *
 * Exported because there are **two** such instances. `adminRoutes` is one; `oauthRoutes` is the other,
 * and it has to be: approving a connector is a person granting a client lasting read access to one
 * project, which is the same class of act as switching a project's MCP mode, and those routes are
 * registered on the root app where `installAuth`'s hooks cannot reach them. One writer, two surfaces,
 * one rule — rather than a second mechanism for the second surface.
 *
 * The actor is `req.auditActor` when the handler settled the identity itself (the OAuth approval, and
 * the two routes that create the account they then act as), and `req.principal` otherwise.
 */
export function installAuditLog(app: FastifyInstance, ctx: AppContext): void {
  /**
   * The id of a created object, read back out of the response — the one thing the route template
   * cannot supply, because a creating route names nothing in its path.
   *
   * `auditReadsResponse` is asked first so that no other response is deserialised at all, and
   * `auditCreatedTarget` can only return a UUID found at a fixed path named in the policy table. A
   * response body can therefore contribute an id to this table and nothing else — the same closed
   * shape `AUDIT_DETAIL` gives the request body.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400 || typeof payload !== 'string') return payload;
    const url = req.routeOptions.url ?? '';
    if (!auditReadsResponse(req.method, url)) return payload;
    try {
      req.auditTarget = auditCreatedTarget(req.method, url, JSON.parse(payload));
    } catch {
      // A response that is not JSON is a response this table learns nothing from. Never an error: the
      // reply is already built and an audit detail must not be able to break one.
    }
    return payload;
  });

  /**
   * `onResponse`, so two things are true: the reply has already gone, so nothing is waiting on the
   * insert, and the status is known, so a request that was refused writes nothing. Only successes are
   * recorded — a refusal is the permission matrix working, and `4xx` on every probe would turn this
   * table into a scan log.
   *
   * `ctx.audit` owns the write and what happens when it fails; this hook decides *whether* there is
   * an event and hands over the actor.
   */
  app.addHook('onResponse', async (req, reply) => {
    const principal = req.auditActor ?? req.principal ?? null;
    if (!principal || reply.statusCode >= 400) return;
    const subject = auditSubject(req.method, req.routeOptions.url ?? '', (req.params ?? {}) as Record<string, unknown>, req.body);
    if (!subject) return;
    // The response-derived target only fills a gap; a route whose path names its target keeps it.
    const created = subject.targetId ? null : (req.auditTarget ?? null);
    ctx.audit.record(
      {
        ...subject,
        projectId: subject.projectId ?? req.auditProjectId ?? null,
        targetType: created?.type ?? subject.targetType,
        targetId: created?.id ?? subject.targetId,
      },
      { principal, ip: req.ip || null, statusCode: reply.statusCode },
    );
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
    throw new ForbiddenError('token_has_no_account', 'A bearer token is machine access; this needs a user account');
  }
  return principal;
}
