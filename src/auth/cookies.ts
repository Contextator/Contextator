import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'contextator_session';

/**
 * `auto` follows the request's scheme, and behind a terminating proxy that is X-Forwarded-Proto — but
 * only where `TRUST_PROXY` says the peer may speak for it ([ADR-0060](../../.ssot/ADR.md#adr-0060)).
 * Off, which is the default, `req.protocol` is the socket's own scheme and this quietly decides `http`
 * behind a proxy; set to `1` on a directly exposed instance, anyone can claim `https`. The only thing
 * at stake either way is whether the Secure flag is set, so the risk is small — but a deployment behind
 * a proxy should pin AUTH_COOKIE_SECURE=1 rather than rely on the header.
 */
export function cookieSecure(config: Config, req: FastifyRequest): boolean {
  if (config.AUTH_COOKIE_SECURE === '1') return true;
  if (config.AUTH_COOKIE_SECURE === '0') return false;
  if (config.PUBLIC_BASE_URL?.startsWith('https://')) return true;
  return req.protocol === 'https';
}

export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, config: Config, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: cookieSecure(config, req),
    maxAge: config.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, req: FastifyRequest, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', httpOnly: true, secure: cookieSecure(config, req) });
}

export const readSessionCookie = (req: FastifyRequest): string | undefined => req.cookies?.[SESSION_COOKIE];

export const OIDC_FLOW_COOKIE = 'contextator_oidc_flow';

/** How long a browser has to complete the round trip to the provider and back. Generous for a slow IdP login form, short enough that a stale cookie is not a standing risk. */
const OIDC_FLOW_TTL_SECONDS = 10 * 60;

/** The values `GET /api/auth/oidc/login` generates and `GET /api/auth/oidc/callback` must see echoed back — see `src/auth/oidc/client.ts`'s `OidcFlowState`. */
export interface OidcFlowState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  /**
   * `'login'` starts a session for whichever account the identity resolves to (auto-provisioning a
   * new one if none does yet); `'link'` instead attaches the identity to the account of whoever is
   * signed in when the callback runs ([MAJOR-1], tur 2 review of
   * [ADR-0077](../../.ssot/ADR.md#adr-0077)). This field only ever selects which branch the callback
   * takes — never which account it acts on, since the cookie itself is unsigned (see below) and must
   * not be trusted to name one.
   */
  intent: 'login' | 'link';
  /**
   * Set only for `intent: 'link'`, to the `sessionId` of whoever started the flow. The callback
   * compares this against the *live* session it sees when the provider redirects back and refuses on
   * any mismatch or absence ([BLOCKER], tur 2 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)):
   * without it, a cookie an attacker plants in a victim's browser (its fields need not be secret to
   * forge, only to guess — see below) can carry `intent: 'link'` while the attacker completes the
   * provider round trip as themselves, and the callback would otherwise link the attacker's external
   * identity to whichever account happens to hold the session that opens the link. `sessionId` is not
   * a secret — it is the session row's id, not its token (`services/auth/sessions.ts`) — so storing it
   * here plainly is not a new place a session's authority leaks.
   */
  linkSessionId?: string;
}

/**
 * Carries the flow state across the redirect to the provider and back. Not signed: `state`, `nonce`
 * and the PKCE verifier are the exchange's own CSRF/replay defenses, so a forged cookie cannot make
 * `completeAuthorizationCodeGrant` accept a code it did not itself request. For `intent: 'link'`,
 * `linkSessionId` is the additional defense that keeps a forged cookie from choosing *whose* account
 * a linking flow completes against — see the field's own doc above.
 */
export function setOidcFlowCookie(reply: FastifyReply, req: FastifyRequest, config: Config, flow: OidcFlowState): void {
  reply.setCookie(OIDC_FLOW_COOKIE, Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/auth/oidc',
    secure: cookieSecure(config, req),
    maxAge: OIDC_FLOW_TTL_SECONDS,
  });
}

export function readOidcFlowCookie(req: FastifyRequest): OidcFlowState | undefined {
  const raw = req.cookies?.[OIDC_FLOW_COOKIE];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as OidcFlowState).state === 'string' &&
      typeof (parsed as OidcFlowState).nonce === 'string' &&
      typeof (parsed as OidcFlowState).verifier === 'string' &&
      typeof (parsed as OidcFlowState).next === 'string' &&
      ((parsed as OidcFlowState).linkSessionId === undefined || typeof (parsed as OidcFlowState).linkSessionId === 'string')
    ) {
      const intent = (parsed as OidcFlowState).intent;
      // Older cookies set before this field existed carry no `intent` at all; treated as `'login'`,
      // which is everything they could ever have meant.
      return { ...(parsed as OidcFlowState), intent: intent === 'link' ? 'link' : 'login' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function clearOidcFlowCookie(reply: FastifyReply, req: FastifyRequest, config: Config): void {
  reply.clearCookie(OIDC_FLOW_COOKIE, { path: '/api/auth/oidc', sameSite: 'lax', httpOnly: true, secure: cookieSecure(config, req) });
}
