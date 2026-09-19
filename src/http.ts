import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

/**
 * The Fastify options that are a **product decision** rather than a property of one process, in one
 * place so that there is one place ([ADR-0060](../.ssot/ADR.md#adr-0060)).
 *
 * `src/server.ts` cannot export this itself — importing that module runs the server — and the thing
 * this exists to prevent is precisely a second opinion: the integration harness carried its own
 * `trustProxy: true` for months, so a test that spoofed a header was asserting against a copy of the
 * server rather than against the server. Logging is deliberately left out, because that is where the
 * two legitimately differ.
 */
export function httpServerOptions(config: Config): Pick<FastifyServerOptions, 'bodyLimit' | 'forceCloseConnections' | 'trustProxy'> {
  return {
    bodyLimit: 4 * 1024 * 1024, // matches the MCP SDK's own body limit
    forceCloseConnections: true, // hijacked SSE sockets must not block shutdown
    /**
     * What `req.ip` is allowed to be, and therefore what the sign-in budget, `/oauth/register`'s
     * per-host budget and an audit event's address are keyed on. Off unless the operator names what is
     * in front of this instance; `TRUST_PROXY`'s own comment in `config.ts` carries the argument.
     */
    trustProxy: config.TRUST_PROXY,
  };
}
