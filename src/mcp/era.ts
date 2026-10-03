import { toWebRequest } from '@modelcontextprotocol/node';
import { isLegacyRequest } from '@modelcontextprotocol/server';
import type { FastifyRequest } from 'fastify';

/**
 * Which protocol era a request to `/mcp/:project` belongs to
 * ([ADR-0098](../../.ssot/ADR.md#adr-0098)).
 *
 * - `legacy` — 2025-era traffic: the `initialize` handshake, a request on an `Mcp-Session-Id` session,
 *   any POST without the per-request `_meta` envelope, and the body-less GET/DELETE session
 *   operations. It is served by the sessionful transports in `router.ts`, exactly as before.
 * - `modern` — 2026-07-28 traffic: a POST whose body carries the envelope claim
 *   (`_meta` with `protocolVersion` and `clientCapabilities`). It is served statelessly by
 *   `modern-handler.ts` and never touches the session registry.
 */
export type McpEra = 'legacy' | 'modern';

/**
 * The SDK's own routing predicate, not a re-implementation: `isLegacyRequest` runs exactly the
 * classification `createMcpHandler` runs, so this router and the modern handler can never disagree
 * about a request. Fastify has already drained the Node stream, so the parsed body is handed over
 * both to build the probe request and as the predicate's pre-parsed value.
 *
 * A request that carries the envelope is modern even when it also carries an `Mcp-Session-Id`: the
 * modern path ignores the header, as the 2026-07-28 revision does.
 */
export async function detectEra(req: Pick<FastifyRequest, 'raw' | 'body'>): Promise<McpEra> {
  const probe = await toWebRequest(req.raw, req.body);
  return (await isLegacyRequest(probe, req.body)) ? 'legacy' : 'modern';
}
