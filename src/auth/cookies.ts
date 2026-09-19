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
