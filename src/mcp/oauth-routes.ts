import fs from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { footerNav, renderPage } from '../admin/pages.js';
import { readSessionCookie } from '../auth/cookies.js';
import { isSameSiteRequest } from '../auth/csrf.js';
import { PROJECT_NAME_RE } from '../config.js';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { getProjectById, getProjectByName } from '../services/projects.js';
import { findSessionUser } from '../services/auth/sessions.js';
import { issueMcpCredential, revokeMcpCredentialByToken, revokeMcpTokenById, verifyRefreshToken } from '../services/auth/mcp-tokens.js';
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
  const codes = new AuthorizationCodeStore();

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
        scope: params.scope ?? '',
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
    const issuePair = async (grant: { projectId: string; userId: string; clientId: string }, projectName: string) => {
      const access = await issueMcpCredential(db, { ...grant, kind: 'access', name: `oauth ${projectName}`, ttlMs: accessTtlMs });
      const refresh = await issueMcpCredential(db, { ...grant, kind: 'refresh', name: `oauth ${projectName}`, ttlMs: refreshTtlMs });
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
      const project = await getProjectById(db, redeemed.projectId);
      if (!project) {
        return reply.code(400).send(oauthError('invalid_grant', 'The project this code was issued for no longer exists'));
      }
      const tokens = await issuePair({ projectId: redeemed.projectId, userId: redeemed.userId, clientId: redeemed.clientId }, project.name);
      log.info({ project: project.name, clientId: redeemed.clientId }, 'exchanged an authorization code for an mcp credential');
      return tokens;
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return reply.code(400).send(oauthError('invalid_request', 'refresh_token is required'));
      const grant = await verifyRefreshToken(db, body.refresh_token);
      if (!grant) return reply.code(400).send(oauthError('invalid_grant', 'That refresh token is unknown, expired or revoked'));
      if (body.client_id && body.client_id !== grant.clientId) {
        return reply.code(400).send(oauthError('invalid_grant', 'That refresh token was issued to another client'));
      }
      const project = await getProjectById(db, grant.projectId);
      if (!project) return reply.code(400).send(oauthError('invalid_grant', 'The project this grant was for no longer exists'));
      // Rotation, and the old one is revoked before the new pair is handed over: a refresh token that
      // stayed valid after use is a refresh token a thief can keep using beside its owner.
      await revokeMcpTokenById(db, grant.id);
      return issuePair({ projectId: grant.projectId, userId: grant.userId, clientId: grant.clientId }, project.name);
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
    // Only an OAuth credential is revocable here; a static `ctxm_…` is the operator's and is revoked
    // from the dashboard, never by whatever holds it.
    await revokeMcpCredentialByToken(db, parsed.data.token);
    return reply.code(200).send();
  });
};
