import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'contextator_session';

/**
 * `auto` follows the request's scheme. Fastify's `trustProxy` is on, so behind a terminating proxy
 * that means X-Forwarded-Proto — which anyone can claim if the server is exposed directly. The only
 * thing at stake is whether the Secure flag is set, so the risk is small, but a deployment behind a
 * proxy should pin AUTH_COOKIE_SECURE=1 rather than rely on the header.
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
