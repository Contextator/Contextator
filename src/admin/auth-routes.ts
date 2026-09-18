import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import { requireSession } from '../auth/plugin.js';
import { ConflictError } from '../services/projects.js';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '../services/errors.js';
import { assertPasswordAcceptable, burnPasswordTime, hashPassword, needsRehash, verifyPassword } from '../services/passwords.js';
import { createSession, listSessionsOfUser, revokeSession, revokeSessionsOfUser } from '../services/auth/sessions.js';
import { membershipMap } from '../services/auth/memberships.js';
import {
  countUsers,
  createUser,
  getUserById,
  getUserByUsername,
  lockRemainingSec,
  recordLoginFailure,
  recordLoginSuccess,
  setPassword,
  toUserView,
} from '../services/auth/users.js';

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) });
const PasswordBody = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) });
const SetupBody = z.object({
  code: z.string().min(4).max(64),
  username: z.string().min(2).max(63),
  displayName: z.string().max(100).optional(),
  email: z.string().max(200).nullable().optional(),
  password: z.string().min(1).max(1024),
});
const SessionsQuery = z.object({ scope: z.enum(['others', 'all']).default('others') });

const ADVISORY_LOCK_SETUP = 7213002;

/** Authentication and first-run setup. Registered inside adminRoutes, so it shares the error handler. */
export const authRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db, log } = ctx;

  const clientIp = (req: FastifyRequest): string => req.ip || 'unknown';

  /** One budget per host for both sign-in and setup; a success clears it. */
  const spendAttempt = (req: FastifyRequest): void => {
    const retryAfter = ctx.loginLimiter.hit(clientIp(req));
    if (retryAfter > 0) throw new RateLimitedError(retryAfter);
  };

  const signIn = async (reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> => {
    const { token } = await createSession(db, userId, config.AUTH_SESSION_TTL_DAYS, {
      userAgent: String(req.headers['user-agent'] ?? ''),
      ip: clientIp(req),
    });
    setSessionCookie(reply, req, config, token);
    ctx.loginLimiter.reset(clientIp(req));
  };

  // ---------- setup ----------

  app.get('/api/setup/status', async () => ({ needsSetup: ctx.setup.needsSetup }));

  app.post('/api/setup', async (req, reply) => {
    if (!ctx.setup.needsSetup) throw new ConflictError('Setup is already complete; sign in instead');
    spendAttempt(req);
    const body = SetupBody.parse(req.body);
    // Consumed synchronously, before any await, so two requests cannot both pass on the same code.
    if (!ctx.setup.verify(body.code)) {
      log.warn({ ip: clientIp(req) }, 'setup code rejected');
      throw new ForbiddenError('invalid_setup_code', 'That setup code is not the one in the server log');
    }
    assertPasswordAcceptable(body.password, { minLength: config.PASSWORD_MIN_LENGTH, username: body.username });

    // Two concurrent setups could both have seen an empty table; the advisory lock settles it and
    // the unique username is the backstop.
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_SETUP})`));
      if ((await countUsers(tx as unknown as typeof db)) > 0) throw new ConflictError('Setup is already complete; sign in instead');
      return createUser(tx as unknown as typeof db, {
        username: body.username,
        password: body.password,
        role: 'root',
        displayName: body.displayName,
        email: body.email ?? null,
        mustChangePassword: false, // they chose this password themselves
      });
    });

    ctx.setup.complete();
    log.warn({ username: created.username }, 'first root account created; setup is closed');
    await signIn(reply, req, created.id);
    return reply.code(201).send({ user: toUserView(created) });
  });

  // ---------- sign in / out ----------

  app.post('/api/auth/login', async (req, reply) => {
    spendAttempt(req);
    const body = LoginBody.parse(req.body);
    const user = await getUserByUsername(db, body.username);

    if (!user) {
      // Same work, same answer: the form must not tell anyone which usernames exist.
      await burnPasswordTime(body.password);
      throw new UnauthorizedError('invalid_credentials', 'Wrong username or password');
    }

    const lockedFor = lockRemainingSec(user);
    if (lockedFor > 0) throw new RateLimitedError(lockedFor, 'Too many failed attempts; this account is locked for a while');

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      await recordLoginFailure(db, user, config.AUTH_LOGIN_MAX_ATTEMPTS, config.AUTH_LOGIN_WINDOW_MIN);
      log.warn({ username: user.username, ip: clientIp(req) }, 'failed sign-in');
      throw new UnauthorizedError('invalid_credentials', 'Wrong username or password');
    }
    if (!user.isActive) throw new ForbiddenError('account_disabled', 'This account is disabled');

    // Parameters may have been raised since this hash was made; quietly bring it up to date.
    const rehashed = needsRehash(user.passwordHash) ? await hashPassword(body.password) : undefined;
    await recordLoginSuccess(db, user.id, rehashed);
    await signIn(reply, req, user.id);
    return { user: toUserView(user), mustChangePassword: user.mustChangePassword };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.principal?.kind === 'session') await revokeSession(db, req.principal.sessionId);
    clearSessionCookie(reply, req, config);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    const principal = req.principal;
    if (!principal) throw new UnauthorizedError();
    if (principal.kind === 'token') {
      return {
        id: null,
        username: 'ADMIN_TOKEN',
        displayName: 'Machine access',
        email: null,
        role: 'root' as const,
        mustChangePassword: false,
        authKind: 'token' as const,
        projects: {},
      };
    }
    const user = await getUserById(db, principal.userId);
    if (!user) throw new UnauthorizedError();
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      authKind: 'session' as const,
      // Only a member needs the map; for root and admin every project reads as editor anyway.
      projects: user.role === 'member' ? await membershipMap(db, user.id) : {},
    };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const principal = requireSession(req);
    const body = PasswordBody.parse(req.body);
    const user = await getUserById(db, principal.userId);
    if (!user) throw new UnauthorizedError();

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw new UnauthorizedError('invalid_credentials', 'That is not your current password');
    }
    assertPasswordAcceptable(body.newPassword, {
      minLength: config.PASSWORD_MIN_LENGTH,
      username: user.username,
      current: body.currentPassword,
    });

    await setPassword(db, user.id, body.newPassword, false);
    // Whoever else knew the old password (an administrator who set a temporary one) loses their grip.
    await revokeSessionsOfUser(db, user.id, principal.sessionId);
    return reply.code(204).send();
  });

  app.get('/api/auth/sessions', async (req) => {
    const principal = requireSession(req);
    return { sessions: await listSessionsOfUser(db, principal.userId, principal.sessionId, config.AUTH_SESSION_IDLE_MS) };
  });

  app.delete('/api/auth/sessions', async (req, reply) => {
    const principal = requireSession(req);
    const { scope } = SessionsQuery.parse(req.query);
    await revokeSessionsOfUser(db, principal.userId, scope === 'all' ? undefined : principal.sessionId);
    if (scope === 'all') clearSessionCookie(reply, req, config);
    return reply.code(204).send();
  });
};
