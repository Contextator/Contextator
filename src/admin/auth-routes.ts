import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRole } from '../auth/types.js';
import type { SessionAuthMethod, UserRow } from '../db/schema.js';
import {
  clearOidcFlowCookie,
  clearSessionCookie,
  type OidcFlowState,
  readOidcFlowCookie,
  setOidcFlowCookie,
  setSessionCookie,
} from '../auth/cookies.js';
import { requireSession } from '../auth/plugin.js';
import { safeNext } from '../auth/safe-next.js';
import { buildAuthorizationRedirect, completeAuthorizationCodeGrant, isOidcEnabled, providerName, resolveRedirectUri } from '../auth/oidc/client.js';
import { ConflictError, NotFoundError } from '../services/projects.js';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '../services/errors.js';
import { assertPasswordAcceptable, burnPasswordTime, hashPassword, needsRehash, verifyPassword } from '../services/passwords.js';
import { createSession, listSessionsOfUser, revokeSession, revokeSessionsOfUser } from '../services/auth/sessions.js';
import { revokeApiTokensOfUser } from '../services/auth/api-tokens.js';
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
  withUserRowLock,
} from '../services/auth/users.js';
import {
  findUserByFederatedIdentity,
  linkFederatedIdentity,
  listFederatedIdentitiesOfUser,
  provisionFederatedUser,
  touchFederatedIdentityLogin,
  unlinkFederatedIdentity,
} from '../services/auth/federated-identities.js';
import { revokeMcpCredentialsOfUser } from '../services/auth/mcp-tokens.js';

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

  /**
   * Opens the session, sets the cookie — and names the person this request turned out to be
   * ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
   *
   * Sign-in and first-run setup are the two requests in this product that *create* the identity they
   * act as: `installAuth`'s identity hook ran before either had one, so `req.principal` is null and the
   * audit hook would find nobody to name. `req.auditActor` is that answer, filled where it becomes
   * true. It is not an audit call — the writing stays in one place — and nothing else reads it.
   *
   * Without this the log would hold **logouts and no sign-ins**, and the compensating record it would
   * be pointing at, `users.last_login_at`, is one column that is overwritten every time: the last
   * sign-in, never a history of them.
   */
  const signIn = async (
    reply: FastifyReply,
    req: FastifyRequest,
    user: { id: string; username: string; role: UserRole },
    authMethod: SessionAuthMethod = 'password',
    // Accepts the caller's own transaction ([T6-MAJOR-1], tur 6 review) so the SSO login callback can
    // create the session inside the same `withUserRowLock` that re-checked the link is still live:
    // defaulting to the outer `db` keeps every other call site (password login, setup) unchanged.
    dbOrTx: typeof db = db,
  ): Promise<void> => {
    const { token, sessionId } = await createSession(
      dbOrTx,
      user.id,
      config.AUTH_SESSION_TTL_DAYS,
      {
        userAgent: String(req.headers['user-agent'] ?? ''),
        ip: clientIp(req),
      },
      authMethod,
    );
    setSessionCookie(reply, req, config, token);
    ctx.loginLimiter.reset(clientIp(req));
    req.auditActor = { kind: 'session', role: user.role, userId: user.id, username: user.username, sessionId, mustChangePassword: false };
  };

  // ---------- setup ----------

  app.get('/api/setup/status', async () => ({
    needsSetup: ctx.setup.needsSetup,
    oidc: isOidcEnabled(config) ? { enabled: true as const, buttonLabel: config.OIDC_BUTTON_LABEL } : { enabled: false as const },
  }));

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
    await signIn(reply, req, created);
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
    await signIn(reply, req, user);
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
    // Whether the dashboard's own account page should offer a "connect SSO" control at all, and what
    // to call it — the same `isOidcEnabled`/`OIDC_BUTTON_LABEL` pair `/api/setup/status` exposes to the
    // logged-out login page ([MAJOR-2], tur 3 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)). Root
    // never gets `canLink: true`: it stays local by design (see `POST /api/auth/oidc/link` below), so
    // the account page has nothing to base a link control's visibility on other than this flag.
    const oidc = { enabled: isOidcEnabled(config), buttonLabel: config.OIDC_BUTTON_LABEL };
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
        oidc,
        canLinkOidc: false,
        federatedProviders: [] as string[],
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
      oidc,
      canLinkOidc: user.role !== 'root',
      federatedProviders: (await listFederatedIdentitiesOfUser(db, user.id)).map((r) => r.provider),
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
    // And the same grip held through an MCP client ([ADR-0054](../../.ssot/ADR.md#adr-0054)). Sessions
    // alone were the whole of "somebody else knows my password" until an account could also be behind
    // a `ctxa_\u2026`; that credential outlives a sign-in by weeks and renews itself, so leaving it
    // running would leave running the one credential of this account the password change did not
    // reach \u2014 which is exactly the credential somebody with the old password could have taken. The
    // connector asks its person again, which is what the browser is being told to do too.
    const cutCredentials = await revokeMcpCredentialsOfUser(db, user.id);
    if (cutCredentials > 0) {
      req.log.info({ username: user.username, credentials: cutCredentials }, 'password change revoked this account\u2019s mcp credentials');
    }
    return reply.code(204).send();
  });

  // ---------- OIDC sign-in (ADR-0077) ----------

  /**
   * Starts the redirect to the identity provider. Public ([auth/policy.ts](../auth/policy.ts)'s
   * `PUBLIC_ROUTES`): the browser has no Contextator session yet, that is the point of the request.
   */
  app.get('/api/auth/oidc/login', async (req, reply) => {
    if (!isOidcEnabled(config)) throw new NotFoundError('Single sign-on is not configured on this instance');
    const next = safeNext((req.query as Record<string, unknown> | undefined)?.next);
    const { url, flow } = await buildAuthorizationRedirect(config, req, next, 'login');
    setOidcFlowCookie(reply, req, config, flow);
    return reply.header('cache-control', 'no-store').redirect(url, 302);
  });

  /**
   * Starts the same redirect, but for an account that is already signed in and wants to connect its
   * SSO identity rather than start a session with one ([MAJOR-1], tur 2 review of
   * [ADR-0077](../../.ssot/ADR.md#adr-0077)). Session-only — `requireSession` refuses `ADMIN_TOKEN`
   * and API tokens, the same as `/api/tokens` — because linking is something a signed-in human does to
   * their own account, not a machine-credential operation.
   *
   * `POST`, not `GET` ([MAJOR-1], tur 3 review): a state-changing action reachable by simple navigation
   * — an `<img>`, a link, an auto-submitting form on another site — is a CSRF target by construction,
   * since the browser attaches this instance's session cookie to it regardless of what page asked for
   * the request. `authorize.ts`'s same-site check already refuses any state-changing session request
   * that did not originate from this dashboard; it only had no effect here because it skips every
   * `SAFE_METHODS` request, `GET` included. Returns `{ url }` rather than a redirect because this route
   * is called through `api()` like every other POST in this app (`public/tokens.js`'s pattern); the
   * caller navigates the actual tab itself (`public/tokens.js`'s SSO panel).
   *
   * Root is refused here ([MAJOR-4], tur 3 review of ADR-0077 and its "root stays local" nüshas): root
   * signs in with its local password only, and an account that could attach an external identity to
   * root would let whoever controls that identity provider account sign in as root — exactly what
   * ADR-0077 rules out. Checked again in the callback's `link` branch below, since that is the step
   * that would actually create the row.
   *
   * The flow cookie the callback reads back is tagged `intent: 'link'` and carries `linkSessionId`,
   * this session's id: that tag only ever picks which branch the callback takes, and `linkSessionId`
   * is the only thing that lets the callback tell *this* session's linking flow apart from one a forged
   * cookie could claim to be ([BLOCKER], tur 2 review — see `cookies.ts`'s `OidcFlowState`).
   */
  app.post('/api/auth/oidc/link', async (req, reply) => {
    const principal = requireSession(req);
    if (!isOidcEnabled(config)) throw new NotFoundError('Single sign-on is not configured on this instance');
    if (principal.role === 'root') throw new ForbiddenError('root_local_only', 'The root account stays local and cannot link single sign-on');
    const next = safeNext((req.body as Record<string, unknown> | undefined)?.next);
    const { url, flow } = await buildAuthorizationRedirect(config, req, next, 'link');
    setOidcFlowCookie(reply, req, config, { ...flow, linkSessionId: principal.sessionId });
    return reply.header('cache-control', 'no-store').send({ url });
  });

  /**
   * Removes every federated identity linked to the caller's own account. Self-service and
   * session-only, matching `DELETE /api/tokens/:tokenId`: there is no admin surface to unlink somebody
   * else's identity here on purpose (an operator who needs that has account management instead). The
   * automatic audit hook covers this route (`DELETE`, `/api/auth/*` is not exempt) the same way it
   * covers `DELETE /api/auth/sessions`, so no manual `ctx.audit.record` call is needed here.
   *
   * A real unlink also revokes every session and API token this account holds ([ADR-0077], tur 6
   * addendum): unlinking is what clears the way for a later promotion to root
   * (`services/auth/users.ts`'s guard checks the identity table, not this account's history), so
   * whatever this account opened while still linked must not outlive the link — including the
   * session making this very call, which is why there is no `exceptSessionId` here. A no-op unlink
   * (nothing was linked) revokes nothing.
   *
   * Runs inside `withUserRowLock` ([T6-MAJOR-1], tur 6 review): an SSO login callback in flight for
   * this same account re-checks the link and writes its session under the same lock, so this either
   * finishes first — and the callback's re-check then sees no link and refuses — or waits for the
   * callback's transaction to commit and then revokes exactly the session it just created.
   */
  app.delete('/api/auth/oidc/link', async (req, reply) => {
    const principal = requireSession(req);
    await withUserRowLock(db, principal.userId, async (tx) => {
      const removed = await unlinkFederatedIdentity(tx, principal.userId);
      if (removed > 0) {
        await revokeSessionsOfUser(tx, principal.userId);
        await revokeApiTokensOfUser(tx, principal.userId);
      }
    });
    return reply.code(204).send();
  });

  /** The identity provider's redirect back, with a code — or an error the provider itself reports. */
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const refuse = (code: string): FastifyReply => {
      clearOidcFlowCookie(reply, req, config);
      return reply.header('cache-control', 'no-store').redirect(`/login?oidc_error=${encodeURIComponent(code)}`, 302);
    };

    if (!isOidcEnabled(config)) return refuse('not_configured');
    const flow: OidcFlowState | undefined = readOidcFlowCookie(req);
    if (!flow) return refuse('flow_expired');

    const query = req.query as Record<string, unknown>;
    if (typeof query.error === 'string') {
      log.warn({ error: query.error }, 'oidc provider returned an error');
      return refuse('provider_denied');
    }

    let claims: Awaited<ReturnType<typeof completeAuthorizationCodeGrant>>;
    try {
      const currentUrl = new URL(req.url, resolveRedirectUri(config, req));
      claims = await completeAuthorizationCodeGrant(config, currentUrl, flow);
    } catch (err) {
      log.warn({ err }, 'oidc code exchange failed');
      return refuse('exchange_failed');
    }

    const issuer = claims.iss;
    const subject = claims.sub;
    const provider = providerName(config);

    if (flow.intent === 'link') {
      // The flow cookie is unsigned by design ([cookies.ts](../auth/cookies.ts)) — it says *that* this
      // is a linking flow, never on its own *whose* account it is for. What pins it to one account is
      // `linkSessionId`, set to the initiating session's id when the flow started: the live session
      // read fresh right here must be that exact same session, not merely *some* signed-in session
      // ([BLOCKER], tur 2 review). Without this comparison, a cookie planted in a victim's browser
      // (forgeable, since it is unsigned) with a forged `intent: 'link'` would let an attacker complete
      // their own provider login and have the callback link their external identity to whichever
      // account happened to hold the live session — the victim's, root included.
      const principal = req.principal;
      if (!principal || principal.kind !== 'session' || !flow.linkSessionId || principal.sessionId !== flow.linkSessionId) {
        return refuse('link_requires_session');
      }
      // Defense in depth alongside the `POST /api/auth/oidc/link` check above ([MAJOR-4], tur 3
      // review): root cannot start a link flow, but a role can in principle change between start and
      // this callback (e.g. a promotion mid-flow), so the invariant is re-checked at the step that
      // actually writes the row — against a fresh read taken under the same row lock `updateUser`'s
      // promotion path takes, not the `principal.role` captured at `onRequest` time before the
      // provider round trip above ([T6-MINOR-1], tur 6 review: that capture is stale by the time this
      // runs, and a promotion racing this callback needs to serialize against it, not just be
      // rechecked against equally stale data).
      type LinkOutcome = { ok: true } | { ok: false; code: 'root_local_only' | 'link_conflict' };
      const outcome = await withUserRowLock(db, principal.userId, async (tx): Promise<LinkOutcome> => {
        const fresh = await getUserById(tx, principal.userId);
        if (!fresh) throw new NotFoundError('User not found');
        if (fresh.role === 'root') return { ok: false, code: 'root_local_only' };
        try {
          await linkFederatedIdentity(tx, { userId: principal.userId, provider, issuer, subject });
        } catch (err) {
          if (err instanceof ConflictError) return { ok: false, code: 'link_conflict' };
          throw err;
        }
        return { ok: true };
      });
      if (!outcome.ok) return refuse(outcome.code);
      clearOidcFlowCookie(reply, req, config);
      // The automatic audit hook never runs for this route: it is a GET, and `auditSubject` only
      // records state-changing methods — the same reason the login branch below writes its own event.
      ctx.audit.record(
        {
          action: 'GET /api/auth/oidc/callback',
          projectId: null,
          targetType: 'user',
          targetId: principal.userId,
          detail: { provider, linked: true },
        },
        { principal, ip: clientIp(req), statusCode: 200 },
      );
      return reply.header('cache-control', 'no-store').redirect(safeNext(flow.next), 302);
    }

    const emailClaim = typeof claims.email === 'string' ? claims.email : undefined;
    const preferredUsernameClaim = typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined;
    const nameClaim = typeof claims.name === 'string' ? claims.name : undefined;

    let user = await findUserByFederatedIdentity(db, { issuer, subject });
    let isNewAccount = false;
    if (user) {
      await touchFederatedIdentityLogin(db, { issuer, subject });
    } else {
      if (!config.OIDC_AUTO_PROVISION) return refuse('no_account');
      try {
        user = await provisionFederatedUser(db, {
          provider,
          issuer,
          subject,
          role: config.OIDC_DEFAULT_ROLE,
          preferredUsername: preferredUsernameClaim,
          email: emailClaim,
          displayName: nameClaim,
        });
        isNewAccount = true;
      } catch (err) {
        log.error({ err }, 'oidc auto-provisioning failed');
        return refuse('provision_failed');
      }
    }

    // Everything from here re-reads and writes this account under its row lock ([T6-MAJOR-1], tur 6
    // review): an unlink or a promotion racing this sign-in serializes against the exact same lock
    // `DELETE /api/auth/oidc/link` and `updateUser`'s promotion path take, so whichever of them commits
    // first is what this callback sees — never a session issued for a link that was already gone by
    // the time this runs, and never a login that outraces a promotion into holding a session over a
    // now-root account. `user`/`isNewAccount` above are only the *lookup* that picked which account
    // this flow is even about; everything that decides whether to actually sign in happens on a fresh
    // read taken after the lock is held.
    type LoginOutcome =
      | { ok: true; user: UserRow }
      | { ok: false; code: 'no_account' | 'account_disabled' }
      | { ok: false; code: 'root_local_only'; user: UserRow };
    const outcome = await withUserRowLock(db, user.id, async (tx): Promise<LoginOutcome> => {
      // Re-confirms the identity resolved above is still linked to this account: a concurrent unlink
      // that already committed — whether it landed before this lock was requested or is what this
      // callback was queued behind — must not let this callback go on to open a session for an account
      // it no longer has any claim on. Reuses `no_account`: from this callback's point of view, an
      // identity that was just unlinked is indistinguishable from one that was never linked.
      const stillLinked = await findUserByFederatedIdentity(tx, { issuer, subject });
      if (!stillLinked || stillLinked.id !== user.id) return { ok: false, code: 'no_account' };
      if (!stillLinked.isActive) return { ok: false, code: 'account_disabled' };

      // Root stays local ([ADR-0077]): the two role checks that guard *linking* an identity
      // (`POST /api/auth/oidc/link` above and the callback's `link` branch) never stopped an account
      // that links first and is promoted to root afterwards from signing in here — nothing rechecked
      // the role at sign-in time ([T3-MAJOR-1], tur 3 review). `stillLinked.role` is read fresh, under
      // the same lock `updateUser`'s promotion path takes, not a value captured before the provider
      // round trip above — so a promotion racing this very callback is caught too, not just one that
      // finished earlier ([T6-MAJOR-1], tur 6 review). The federated identity row itself is left alone:
      // whether it may currently be used to sign in is not the same question as whether it exists, and
      // it becomes usable again the moment the account is demoted — no separate cleanup or re-link is
      // needed either way.
      if (stillLinked.role === 'root') return { ok: false, code: 'root_local_only', user: stillLinked };

      // Deterministic pause point for the race test ([T6-MAJOR-1], tur 7): everything above has
      // already re-read its own fresh state under the lock, so this is equivalent to pausing anywhere
      // between "still linked" and "session written" — and it is the last point before the write. A
      // no-op outside `test/integration/oidc.itest.ts`.
      await ctx.testHooks?.onOidcLoginBeforeSignIn?.();

      await signIn(reply, req, stillLinked, 'sso', tx);
      return { ok: true, user: stillLinked };
    });

    if (!outcome.ok) {
      if (outcome.code === 'root_local_only') {
        ctx.audit.record(
          {
            action: 'GET /api/auth/oidc/callback',
            projectId: null,
            targetType: 'user',
            targetId: outcome.user.id,
            detail: { provider, refused: 'root_local_only' },
          },
          {
            principal: {
              kind: 'federated',
              role: outcome.user.role,
              userId: outcome.user.id,
              username: `${outcome.user.username} · sso:${provider}`,
              // No session is created for a refused sign-in, so there is no real id to put here;
              // `buildAuditRow` reads `principal.kind`/`userId`/`username` only, never `sessionId`.
              sessionId: '',
              mustChangePassword: false,
              provider,
            },
            ip: clientIp(req),
            statusCode: 403,
          },
        );
      }
      return refuse(outcome.code);
    }

    clearOidcFlowCookie(reply, req, config);
    // The automatic audit hook never runs for this route: it is a GET, and `auditSubject` only
    // records state-changing methods. This is the one write the callback must do itself — who signed
    // in, through which provider, straight after `signIn()` filled `req.auditActor` for it.
    ctx.audit.record(
      {
        action: 'GET /api/auth/oidc/callback',
        projectId: null,
        targetType: 'user',
        targetId: outcome.user.id,
        detail: { provider, newAccount: isNewAccount },
      },
      {
        principal: {
          kind: 'federated',
          role: outcome.user.role,
          userId: outcome.user.id,
          username: `${outcome.user.username} · sso:${provider}`,
          sessionId: (req.auditActor as Extract<typeof req.auditActor, { kind: 'session' }>).sessionId,
          mustChangePassword: false,
          provider,
        },
        ip: clientIp(req),
        statusCode: 200,
      },
    );
    return reply.header('cache-control', 'no-store').redirect(safeNext(flow.next), 302);
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
