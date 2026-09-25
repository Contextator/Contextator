import fs from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { footerNav, renderPage } from '../admin/pages.js';
import { readSessionCookie } from '../auth/cookies.js';
import { isSameSiteRequest } from '../auth/csrf.js';
import { OAUTH_REGISTER_MAX_PER_HOST, OAUTH_REGISTER_WINDOW_MS, PROJECT_NAME_RE } from '../config.js';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { getProjectById, getProjectByName } from '../services/projects.js';
import { findSessionUser, isSessionLive } from '../services/auth/sessions.js';
import { resolveProjectAccess } from '../services/auth/memberships.js';
import { shareUserRowForGrant, shareUserRowLock } from '../services/auth/users.js';
import { MCP_READ_ACCESS, satisfies } from '../auth/policy.js';
import type { Principal } from '../auth/types.js';
import type { Db } from '../db/client.js';
import {
  findSpentRefreshToken,
  issueMcpCredential,
  revokeMcpCredentialByToken,
  revokeMcpCredentialsOfGrant,
  revokeMcpTokenById,
  verifyRefreshToken,
  withRotationTransaction,
} from '../services/auth/mcp-tokens.js';
import { installAuditLog } from '../auth/plugin.js';
import { SlidingWindow } from '../services/rate-limit.js';
import {
  AuthorizationCodeStore,
  ClientLimitError,
  getOauthClient,
  redirectUriRegistered,
  registerOauthClient,
  touchOauthClient,
} from '../services/auth/oauth.js';

/**
 * Contextator as an OAuth 2.1 authorization server for its own MCP endpoints
 * ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
 *
 * A static `ctxm_…` bearer works with Claude Code and Cursor because those clients can be configured
 * with a header. A browser-based connector cannot: it has nowhere to put one, and the MCP
 * authorization specification says what it does instead — RFC 9728 protected resource metadata, RFC
 * 8414 authorization server metadata, RFC 7591 dynamic registration, and an authorization code flow
 * with PKCE. This file is those four, and **nothing here replaces the static bearer**: the two arrive
 * at the same `onRequest` hook in `router.ts` and are told apart by their prefix.
 *
 * The six routes, and what each of them will and will not do:
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp/:project]  which authorization server to ask
 *   GET  /.well-known/oauth-authorization-server               where its endpoints are
 *   POST /oauth/register                                       a client says who it is — grants nothing
 *   GET  /oauth/authorize                                      a person is asked, in a browser
 *   POST /oauth/authorize                                      that person's answer
 *   POST /oauth/token                                          the code, or a refresh, for a credential
 *   POST /oauth/revoke                                         a client hands one back
 *
 * The first two are public by design: RFC 9728 and RFC 8414 exist to be fetched by a client that has
 * no credential yet, and both documents say only where this instance's endpoints are.
 */

const PAGES_DIR = new URL('../../public/pages/', import.meta.url);

const RegisterBody = OAuthClientMetadataSchema;

const AuthorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.string(),
  // An empty hidden input is what a browser sends for a parameter the client never supplied, so it is
  // read as absent — otherwise the redirect back would carry `state=` and the client would compare it
  // against the nothing it stored.
  state: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  /**
   * **Parsed only so it can be refused.** This product has no scopes: what an account-backed
   * credential reaches is the membership, which is one rule rather than a second grammar beside it
   * ([ADR-0054](../../.ssot/ADR.md#adr-0054)) — and `scopes_supported` is deliberately absent from the
   * authorization server metadata, so there is nothing here a client can legitimately ask for.
   *
   * Swallowing it silently was the alternative and it is the worse one: a client that asks for
   * `scope=admin`, sees no complaint and receives a token has been told it got what it asked for. An
   * `invalid_scope` back at the redirect URI (RFC 6749 §4.1.2.1) is the answer that is true.
   */
  scope: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  resource: z.string().min(1).max(2048),
});

const DecisionBody = AuthorizeQuery.extend({ decision: z.enum(['approve', 'deny']) });

const TokenBody = z.object({
  grant_type: z.string(),
  client_id: z.string().max(200).optional(),
  code: z.string().max(2048).optional(),
  code_verifier: z.string().max(256).optional(),
  redirect_uri: z.string().max(2048).optional(),
  refresh_token: z.string().max(2048).optional(),
  resource: z.string().max(2048).optional(),
});

const RevokeBody = z.object({ token: z.string().min(1).max(2048), token_type_hint: z.string().max(64).optional() });

/** `&`, `<`, `>`, `"` and `'` — the consent page renders a client name somebody else chose. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** An OAuth error response, in the shape RFC 6749 §5.2 gives it. */
const oauthError = (error: string, description: string) => ({ error, error_description: description });

export const oauthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db, log } = ctx;
  // The audit log's hooks, on this instance too ([ADR-0055](../../.ssot/ADR.md#adr-0055)). Approving a
  // connector is a person granting a client lasting read access to one project — the
  // `PATCH /api/projects/:id/mcp-auth` class of decision — and these routes are registered on the root
  // app, where the admin plugin's hooks do not reach. One writer, two surfaces.
  installAuditLog(app, ctx);
  const codes = new AuthorizationCodeStore();
  /**
   * Per-host budget for the one unauthenticated write this plugin has
   * ([ADR-0054](../../.ssot/ADR.md#adr-0054)). Its own instance rather than `ctx.loginLimiter`,
   * because a burst of registrations must not spend a host's sign-in budget.
   *
   * **What it is and is not worth.** A "host" here is whatever `req.ip` resolves to, and that is
   * `TRUST_PROXY`'s answer ([ADR-0060](../../.ssot/ADR.md#adr-0060)): the socket's peer address by
   * default, and the left-most `X-Forwarded-For` — which the client writes — on an instance set to
   * `1`. Set to `1` on a directly reachable port, a single script rotating that header is a different
   * "host" on every request and walks straight past this. That is a property of the instance's proxy
   * configuration and it is not this plugin's to fix — `ctx.loginLimiter` rests on the same `req.ip`.
   * Even configured correctly this is a limit on *ordinary* traffic, since an office behind one
   * address is one host. The thing that actually bounds the damage is the sweep: a client that
   * registers and never connects is dropped within a day, whatever address it claimed.
   *
   * It is also bounded in itself. Nothing external sweeps it — `ctx.loginLimiter` rides the session
   * reaper and this instance is not reachable from `server.ts` — and its keys are chosen by the
   * caller, so an unbounded map behind a header is the same denial of service one layer in. It is swept
   * when it grows, and if sweeping does not bring it back under the bound then this endpoint is closed
   * until it does: refusing registrations is a far smaller failure than exhausting the process.
   */
  const registerLimiter = new SlidingWindow(OAUTH_REGISTER_MAX_PER_HOST, OAUTH_REGISTER_WINDOW_MS);
  /** Live buckets this limiter may hold. Each is at most `OAUTH_REGISTER_MAX_PER_HOST` timestamps. */
  const REGISTER_LIMITER_MAX_KEYS = 5_000;

  const shell = await fs.readFile(new URL('_auth-shell.html', PAGES_DIR), 'utf8');
  const consentBody = await fs.readFile(new URL('authorize.html', PAGES_DIR), 'utf8');
  const nav = footerNav();

  /**
   * The token endpoint is `application/x-www-form-urlencoded` by RFC 6749, and Fastify parses JSON and
   * text only. A parser rather than a dependency: `URLSearchParams` is the whole of it, and it is
   * registered on this plugin's own instance, so no other route's body parsing changes.
   */
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const baseUrl = (req: FastifyRequest): string => (config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');

  /**
   * The project a `resource` parameter names, or null. RFC 8707: the resource indicator is what makes
   * a credential issued for one project useless on another's URL, and that is the whole isolation
   * story of [ADR-0001](../../.ssot/ADR.md#adr-0001) expressed in this protocol.
   */
  function projectNameFromResource(base: string, resource: string): string | null {
    const trimmed = resource.replace(/\/+$/, '');
    const prefix = `${base}/mcp/`;
    if (!trimmed.startsWith(prefix)) return null;
    const name = trimmed.slice(prefix.length);
    return PROJECT_NAME_RE.test(name) ? name : null;
  }

  const protectedResourceMetadata = (base: string, resource: string) => ({
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_name: 'Contextator',
    resource_documentation: `${base}/about`,
  });

  // ---- RFC 9728: which authorization server guards this resource ----
  //
  // Both spellings, because a client builds the path-inserted one from the MCP URL and falls back to
  // the bare one. The path-inserted form is the one that matters here: the resource is *a project*,
  // not the instance, so an answer that named only the origin would describe the wrong thing.
  app.get<{ Params: { project: string } }>('/.well-known/oauth-protected-resource/mcp/:project', async (req, reply) => {
    const base = baseUrl(req);
    const name = req.params.project;
    // Deliberately not a database lookup and deliberately not a 404 for an unknown project: this
    // document is fetched by a client that holds nothing, and answering differently for a project that
    // exists would turn a public metadata endpoint into a project-name oracle.
    if (!PROJECT_NAME_RE.test(name)) return reply.code(404).send(oauthError('not_found', 'Not a usable project name'));
    reply.header('cache-control', 'public, max-age=300');
    return protectedResourceMetadata(base, `${base}/mcp/${name}`);
  });

  app.get('/.well-known/oauth-protected-resource', async (req, reply) => {
    const base = baseUrl(req);
    reply.header('cache-control', 'public, max-age=300');
    return protectedResourceMetadata(base, `${base}/mcp`);
  });

  // ---- RFC 8414: where this authorization server's endpoints are ----
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const base = baseUrl(req);
    reply.header('cache-control', 'public, max-age=300');
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // `none`, because every client here is public: a connector running in a browser cannot hold a
      // secret, so PKCE is the proof and a client secret would be a secret in a page's source.
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      // S256 only. OAuth 2.1 drops `plain`, and `plain` proves nothing anyone watching cannot replay.
      code_challenge_methods_supported: ['S256'],
      service_documentation: `${base}/about`,
    };
  });

  // ---- RFC 7591: dynamic client registration ----
  app.post('/oauth/register', async (req, reply) => {
    if (registerLimiter.size >= REGISTER_LIMITER_MAX_KEYS) registerLimiter.sweep();
    if (registerLimiter.size >= REGISTER_LIMITER_MAX_KEYS) {
      log.warn({ keys: registerLimiter.size }, 'oauth client registration is closed: the rate limiter is at its key bound');
      return reply
        .code(429)
        .header('retry-after', '3600')
        .send(oauthError('temporarily_unavailable', 'Client registration is busy; try again later'));
    }
    const retryAfter = registerLimiter.hit(req.ip || 'unknown');
    if (retryAfter > 0) {
      log.warn({ ip: req.ip }, 'rate limited an oauth client registration');
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send(oauthError('temporarily_unavailable', `Too many client registrations from this host; try again in ${retryAfter} s`));
    }
    const parsed = RegisterBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(oauthError('invalid_client_metadata', z.prettifyError(parsed.error)));
    }
    const metadata = parsed.data;
    // `http://` only for loopback, which is where a desktop connector's callback lives. Anything else
    // has to be TLS: an authorization code travelling in the clear is the code being handed away.
    const usable = metadata.redirect_uris.filter((uri) => {
      try {
        const url = new URL(uri);
        return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
      } catch {
        return false;
      }
    });
    if (usable.length === 0) {
      return reply
        .code(400)
        .send(
          oauthError(
            'invalid_redirect_uri',
            'Every redirect_uri must be https, or http on localhost — an authorization code must not travel in the clear',
          ),
        );
    }
    try {
      const client = await registerOauthClient(db, {
        name: metadata.client_name ?? '',
        redirectUris: usable,
        maxClients: config.MCP_OAUTH_MAX_CLIENTS,
      });
      log.info({ clientId: client.clientId, name: client.name }, 'registered an oauth client');
      return reply.code(201).send({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    } catch (err) {
      if (err instanceof ClientLimitError) {
        log.warn('refused an oauth client registration: the instance is at its client ceiling');
        return reply.code(429).send(oauthError('temporarily_unavailable', err.message));
      }
      throw err;
    }
  });

  // ---- The authorization endpoint ----

  /** Whoever is signed into the dashboard in this browser, or null. */
  const whoIsThis = async (req: FastifyRequest) => {
    const raw = readSessionCookie(req);
    return raw ? findSessionUser(db, raw, config.AUTH_SESSION_IDLE_MS) : null;
  };

  /**
   * An error the client must **not** be redirected with. RFC 6749 §4.1.2.1: when the `client_id` or
   * the `redirect_uri` is the thing that is wrong, sending the browser to that URI is the attack, so
   * the error is shown here instead.
   */
  const refuseInPlace = (reply: FastifyReply, status: number, heading: string, detail: string) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return reply.code(status).send(
      renderPage(shell, {
        title: 'Authorization refused',
        description: 'This authorization request could not be completed.',
        content: `<div class="gate-card"><h1>${escapeHtml(heading)}</h1><p class="muted">${escapeHtml(detail)}</p></div>`,
        nav,
        version: ctx.version,
        year: String(new Date().getFullYear()),
      }),
    );
  };

  /** The redirect back to the client, with either the code or an error, and the state it sent. */
  const backToClient = (reply: FastifyReply, redirectUri: string, params: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    return reply.header('cache-control', 'no-store').redirect(url.toString(), 302);
  };

  /**
   * Everything both the `GET` and the `POST` have to establish before anything happens: a registered
   * client, a registered redirect URI, a resource that names a project this instance has, and the
   * flow parameters OAuth 2.1 still allows.
   */
  async function validateRequest(
    req: FastifyRequest,
    reply: FastifyReply,
    params: z.infer<typeof AuthorizeQuery>,
  ): Promise<{ ok: true; project: ProjectRow; clientName: string } | { ok: false }> {
    const refused = { ok: false as const };
    const client = await getOauthClient(db, params.client_id);
    if (!client) {
      await refuseInPlace(reply, 400, 'Unknown client', 'No client is registered here under that client_id.');
      return refused;
    }
    if (!redirectUriRegistered(client, params.redirect_uri)) {
      await refuseInPlace(
        reply,
        400,
        'Unregistered redirect URI',
        'That redirect_uri is not one this client registered. It is compared as a whole string, never as a prefix.',
      );
      return refused;
    }
    // From here on the client and its URI are known good, so a refusal may travel back to it.
    if (params.scope !== undefined) {
      // Loud, because the person on the other end of this sees a raw `invalid_scope` in a connector's
      // error box and has nothing to act on. An operator reading the log does.
      log.warn(
        { clientId: params.client_id, scope: params.scope },
        'refused an authorization request that asked for a scope; this server issues none',
      );
      await backToClient(reply, params.redirect_uri, {
        error: 'invalid_scope',
        error_description: 'This server issues no scopes; an account-backed credential reaches exactly what its account may read',
        state: params.state,
      });
      return refused;
    }
    if (params.response_type !== 'code') {
      await backToClient(reply, params.redirect_uri, { error: 'unsupported_response_type', state: params.state });
      return refused;
    }
    if (params.code_challenge_method !== 'S256') {
      await backToClient(reply, params.redirect_uri, {
        error: 'invalid_request',
        error_description: 'code_challenge_method must be S256',
        state: params.state,
      });
      return refused;
    }
    const name = projectNameFromResource(baseUrl(req), params.resource);
    const project = name ? await getProjectByName(db, name) : undefined;
    if (!project) {
      await backToClient(reply, params.redirect_uri, {
        error: 'invalid_target',
        error_description: 'The resource parameter must name an MCP endpoint of this instance',
        state: params.state,
      });
      return refused;
    }
    touchOauthClient(db, client.clientId);
    return { ok: true, project, clientName: client.name || params.client_id };
  }

  app.get('/oauth/authorize', async (req, reply) => {
    const parsed = AuthorizeQuery.safeParse(req.query);
    if (!parsed.success) return refuseInPlace(reply, 400, 'Incomplete authorization request', z.prettifyError(parsed.error));
    const params = parsed.data;

    const checked = await validateRequest(req, reply, params);
    if (!checked.ok) return reply;

    // The person, not the client. An anonymous browser is sent to sign in and comes back here; one
    // owing a password change goes and changes it, for the reason the dashboard's own guard does.
    const session = await whoIsThis(req);
    if (!session) return reply.header('cache-control', 'no-store').redirect(`/login?next=${encodeURIComponent(req.url)}`, 302);
    if (session.mustChangePassword) return reply.header('cache-control', 'no-store').redirect('/change-password', 302);

    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    const content = renderPage(consentBody, {
      client: escapeHtml(checked.clientName),
      project: escapeHtml(checked.project.name),
      account: escapeHtml(session.username),
      // Round-tripped through the form so the POST re-derives everything rather than trusting a
      // server-side scratchpad keyed on a browser. Each one is re-validated there.
      fields: Object.entries({
        response_type: params.response_type,
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        state: params.state ?? '',
        resource: params.resource,
      })
        .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}" />`)
        .join('\n    '),
    });
    return renderPage(shell, {
      title: `Connect ${checked.project.name}`,
      description: 'Approve or refuse an MCP client asking to read one project.',
      content,
      nav,
      version: ctx.version,
      year: String(new Date().getFullYear()),
    });
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const parsed = DecisionBody.safeParse(req.body ?? {});
    if (!parsed.success) return refuseInPlace(reply, 400, 'Incomplete authorization request', z.prettifyError(parsed.error));
    const params = parsed.data;

    // A cookie is an ambient credential, so this POST gets the same same-site check every other
    // cookie-authenticated write in the product gets. Without it a foreign page could post the
    // approval on behalf of whoever is signed in.
    if (!isSameSiteRequest(req.headers, req.host, config.ALLOWED_ORIGINS)) {
      return refuseInPlace(
        reply,
        403,
        'That did not come from this page',
        'Open the authorization link again and approve it from the page this server served.',
      );
    }

    const session = await whoIsThis(req);
    if (!session || session.mustChangePassword) {
      return reply.header('cache-control', 'no-store').redirect(`/login?next=${encodeURIComponent('/oauth/authorize')}`, 302);
    }

    const checked = await validateRequest(req, reply, params);
    if (!checked.ok) return reply;

    // The instant this decision is made, read under the account row's `FOR SHARE` together with a
    // fresh look at the session ([ADR-0090](../../.ssot/ADR.md#adr-0090), FR-616). The session above
    // was resolved before any lock, so an unlink or a password change could have revoked it since and
    // stamped `mcp_credentials_revoked_at` *before* a `Date.now()` taken out here — a code the token
    // endpoint would then see as newer than the revoke. Under the lock the two are ordered: a revoke
    // that committed first has already ended this session if it was meant to (an unlink, an
    // administrator's reset, somebody else's password change; the one session a password change keeps
    // is the one that just proved the new password), and one that waits for this commit stamps an
    // instant at or after `issuedAt`, which the exchange refuses.
    const issuedAt = await withRotationTransaction(db, async (tx) => {
      await shareUserRowLock(tx, session.userId);
      return (await isSessionLive(tx, session.sessionId)) ? Date.now() : null;
    });
    if (issuedAt === null) {
      return reply.header('cache-control', 'no-store').redirect(`/login?next=${encodeURIComponent('/oauth/authorize')}`, 302);
    }

    // The audit row's actor and project, set **here** rather than where the session was resolved:
    // everything above this point is a request that was refused or redirected, and an event for one of
    // those would say a person decided something they never got to decide.
    req.auditActor = {
      kind: 'session',
      role: session.role,
      userId: session.userId,
      username: session.username,
      sessionId: session.sessionId,
      mustChangePassword: session.mustChangePassword,
    };
    req.auditProjectId = checked.project.id;

    if (params.decision === 'deny') {
      log.info({ project: checked.project.name, user: session.username }, 'an oauth authorization was refused by the person');
      return backToClient(reply, params.redirect_uri, { error: 'access_denied', state: params.state });
    }

    const code = codes.issue({
      clientId: params.client_id,
      projectId: checked.project.id,
      userId: session.userId,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      resource: params.resource.replace(/\/+$/, ''),
      issuedAt,
    });
    log.info({ project: checked.project.name, user: session.username, clientId: params.client_id }, 'issued an oauth authorization code');
    return backToClient(reply, params.redirect_uri, { code, state: params.state });
  });

  // ---- The token endpoint ----
  app.post('/oauth/token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = TokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(oauthError('invalid_request', z.prettifyError(parsed.error)));
    const body = parsed.data;

    const accessTtlMs = config.MCP_OAUTH_ACCESS_TTL_MIN * 60_000;
    const refreshTtlMs = config.MCP_OAUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

    /** The pair, and the only place either is minted. The refresh token is rotated on every use. */
    const issuePair = async (on: Db, grant: { projectId: string; userId: string; clientId: string }, projectName: string) => {
      const access = await issueMcpCredential(on, { ...grant, kind: 'access', name: `oauth ${projectName}`, ttlMs: accessTtlMs });
      const refresh = await issueMcpCredential(on, { ...grant, kind: 'refresh', name: `oauth ${projectName}`, ttlMs: refreshTtlMs });
      return {
        access_token: access.token,
        token_type: 'Bearer' as const,
        expires_in: Math.floor(accessTtlMs / 1000),
        refresh_token: refresh.token,
      };
    };

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.code_verifier) {
        return reply.code(400).send(oauthError('invalid_request', 'code and code_verifier are both required'));
      }
      const redeemed = codes.redeem(body.code, body.code_verifier);
      if ('error' in redeemed) return reply.code(400).send(oauthError('invalid_grant', redeemed.error));
      // The three things the code was bound to. A public client authenticates by holding the verifier,
      // so these are what keep a code from being usable by a different client or at a different URI.
      if (body.client_id && body.client_id !== redeemed.clientId) {
        return reply.code(400).send(oauthError('invalid_grant', 'That code was issued to another client'));
      }
      if (body.redirect_uri && body.redirect_uri !== redeemed.redirectUri) {
        return reply.code(400).send(oauthError('invalid_grant', 'redirect_uri does not match the one the code was issued for'));
      }
      if (body.resource && body.resource.replace(/\/+$/, '') !== redeemed.resource) {
        return reply.code(400).send(oauthError('invalid_target', 'resource does not match the one the code was issued for'));
      }
      // **The person behind the code, again** ([ADR-0090](../../.ssot/ADR.md#adr-0090), FR-616). A code
      // is a credential of the account that is not a row yet, so nothing that revokes the account's
      // credentials can reach it: without this an unlink, a password change or an administrator's
      // reset in the minute a code lives would be followed by a fresh pair minted from it. The checks,
      // and the two inserts, run in one transaction holding the account row `FOR SHARE` — the order
      // the refresh branch below uses — so a revoke either commits first and is seen here, or waits
      // for this commit and takes the new pair down with the rest.
      type Exchange =
        | { refused: string; reason: 'project_gone' | 'account_unusable' | 'revoked_after_issue' | 'no_project_access' }
        | { tokens: Awaited<ReturnType<typeof issuePair>>; projectName: string };
      const outcome = await withRotationTransaction(db, async (tx): Promise<Exchange> => {
        const project = await getProjectById(tx, redeemed.projectId);
        if (!project) return { refused: 'The project this code was issued for no longer exists', reason: 'project_gone' };

        const account = await shareUserRowForGrant(tx, redeemed.userId);
        if (!account?.isActive || account.mustChangePassword) {
          return { refused: 'The account this code was issued for can no longer be used', reason: 'account_unusable' };
        }
        // At or before, not only before: the revoke reads its instant after taking the row, so a code
        // approved in the same millisecond was approved before it.
        const revokedAt = account.mcpCredentialsRevokedAt?.getTime();
        if (revokedAt !== undefined && redeemed.issuedAt <= revokedAt) {
          return { refused: 'The account revoked its MCP credentials after this code was issued', reason: 'revoked_after_issue' };
        }
        // The rule the MCP endpoint applies on every request (`resolveMcpCredential`), applied once
        // before anything is minted: a pair the endpoint would refuse at its first use is not issued.
        const principal: Principal = {
          kind: 'session',
          role: account.role,
          userId: account.id,
          username: account.username,
          sessionId: account.id,
          mustChangePassword: false,
        };
        if (!satisfies(await resolveProjectAccess(tx, principal, redeemed.projectId), MCP_READ_ACCESS)) {
          return { refused: 'The account this code was issued for can no longer read that project', reason: 'no_project_access' };
        }

        await ctx.testHooks?.onCodeVerifiedBeforeIssue?.();
        const grant = { projectId: redeemed.projectId, userId: redeemed.userId, clientId: redeemed.clientId };
        return { tokens: await issuePair(tx, grant, project.name), projectName: project.name };
      });
      if ('refused' in outcome) {
        // A warning and not an audit event, the way the refresh branch's refusals are: this endpoint is
        // outside the audit log (`auth/policy.ts`), and a 4xx is never audited anyway.
        log.warn(
          { projectId: redeemed.projectId, clientId: redeemed.clientId, userId: redeemed.userId, reason: outcome.reason },
          'refused an authorization code exchange; the grant behind it no longer holds',
        );
        return reply.code(400).send(oauthError('invalid_grant', outcome.refused));
      }
      log.info({ project: outcome.projectName, clientId: redeemed.clientId }, 'exchanged an authorization code for an mcp credential');
      return outcome.tokens;
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return reply.code(400).send(oauthError('invalid_request', 'refresh_token is required'));

      // The read, the claim and the two inserts, in one transaction — which is the whole mechanism.
      //
      // Statement by statement, the loser's family revoke runs in the gap between the winner's claim
      // and the winner's inserts, and misses the pair the winner is about to write: the reuse is
      // detected and the credentials the detection exists to take down survive it. In one transaction
      // the loser's `UPDATE` waits on the winner's row lock until the winner **commits**, so by the
      // time it is answered `0 rows` and takes the reuse branch, the winner's pair is already visible
      // to it and comes down with the rest.
      const outcome = await withRotationTransaction(db, async (tx) => {
        const grant = await verifyRefreshToken(tx, body.refresh_token as string);
        if (!grant) {
          /**
           * **Reuse detection** (OAuth 2.1 §4.3.1). A refresh token this server issued and has already
           * spent, presented again, is the signal that two parties are holding the same credential — and
           * the server cannot tell which of them is the owner, so it takes the grant down and makes both
           * ask the person again. Without this the theft case is silent: the thief redeems first, the
           * owner's client is told only to re-authorize, does so, and the thief's family lives on beside
           * the new one.
           *
           * A token that was never issued here reaches the same `invalid_grant` and revokes nothing,
           * which is what keeps this from being a way to knock somebody's connector out by guessing.
           */
          const spent = await findSpentRefreshToken(tx, body.refresh_token as string);
          if (spent) {
            const revoked = await revokeMcpCredentialsOfGrant(tx, spent);
            log.warn({ clientId: spent.clientId, revoked }, 'a spent refresh token was presented again; revoked the whole grant');
          }
          return { error: oauthError('invalid_grant', 'That refresh token is unknown, expired or revoked') };
        }

        if (body.client_id && body.client_id !== grant.clientId) {
          return { error: oauthError('invalid_grant', 'That refresh token was issued to another client') };
        }
        const project = await getProjectById(tx, grant.projectId);
        if (!project) return { error: oauthError('invalid_grant', 'The project this grant was for no longer exists') };

        // The account row, `FOR SHARE`, before the claim and until the commit ([F06-MINOR-1], faz 06
        // review): an unlink or a password change revoking this account's credentials either commits
        // before the claim below runs — which then finds the token revoked and takes the raced branch —
        // or waits until this pair is committed and takes it down with the rest.
        await shareUserRowLock(tx, grant.userId);

        /**
         * Rotation, and **the revoke is the claim rather than a formality**. `revoked_at IS NULL` is in
         * its `WHERE`, so two concurrent exchanges of the same refresh token race on one row and exactly
         * one of them wins. The loser is holding a credential that was live when it was verified a
         * moment ago and is not any more, which is the same event as the reuse above and gets the same
         * answer — anything else hands out two valid families from one grant and tells nobody.
         */
        const claimed = await revokeMcpTokenById(tx, grant.id);
        if (!claimed) {
          const revoked = await revokeMcpCredentialsOfGrant(tx, grant);
          log.warn({ clientId: grant.clientId, revoked }, 'two exchanges raced for one refresh token; revoked the whole grant');
          return { error: oauthError('invalid_grant', 'That refresh token is unknown, expired or revoked') };
        }
        await ctx.testHooks?.onRefreshClaimedBeforeIssue?.();
        return { tokens: await issuePair(tx, { projectId: grant.projectId, userId: grant.userId, clientId: grant.clientId }, project.name) };
      });
      if ('error' in outcome) return reply.code(400).send(outcome.error);
      return outcome.tokens;
    }

    return reply.code(400).send(oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported'));
  });

  // ---- RFC 7009: a client hands a credential back ----
  app.post('/oauth/revoke', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = RevokeBody.safeParse(req.body ?? {});
    // RFC 7009 §2.2: an unknown token is a success. Saying "that one did not exist" would turn this
    // into an oracle for guessing tokens, and the client's goal — that token no longer works — holds.
    if (!parsed.success) return reply.code(200).send();
    // By hash and across every project, because RFC 7009 gives the caller no way to say which project
    // the credential is for — and does not need to: the hash is unique and names exactly one row.
    //
    // **What comes down is the grant, not the string** (RFC 7009 §2.1). A connector saying *disconnect*
    // hands back whichever credential it has, and revoking only that one leaves it holding a refresh
    // token that mints a fresh pair seconds later — a revocation that undoes itself. Only an OAuth
    // credential is revocable here; a static `ctxm_…` is the operator's and is revoked from the
    // dashboard, never by whatever happens to hold it.
    const revoked = await revokeMcpCredentialByToken(db, parsed.data.token);
    if (revoked > 0) log.info({ revoked }, 'a client handed its grant back');
    return reply.code(200).send();
  });
};
