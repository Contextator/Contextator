import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { createProjectMcpServer } from './server-factory.js';

/**
 * The SDK's default, and the same value as Fastify's `bodyLimit` (src/http.ts): Fastify has already
 * refused anything larger before this handler sees it, so the two limits can never disagree.
 */
export const MODERN_MAX_REQUEST_BODY_SIZE = 4 * 1024 * 1024;

export interface ModernMcpHandler {
  /**
   * Serves one modern-era (2026-07-28) POST for `project`. `req.auth` — set by the router's
   * `onRequest` hook — is what the SDK hands each tool call as `ctx.http.authInfo`; `parsedBody` is
   * the body Fastify has already parsed, so nothing is read from the stream twice.
   */
  handle(project: ProjectRow, req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody: unknown): Promise<void>;
  /** Ends the handler's long-lived pieces (its notification bus and listen streams). */
  close(): Promise<void>;
}

/**
 * The modern half of [ADR-0098](../../.ssot/ADR.md#adr-0098): one strict (`legacy: 'reject'`) handler
 * per process. The router has already decided the request is modern (`era.ts`), so a 2025-era request
 * never reaches it; were one to, the SDK would refuse it rather than serve it statelessly.
 *
 * The SDK calls the factory once per request and serves it statelessly: nothing is added to the
 * `SessionRegistry`, and an `Mcp-Session-Id` header is ignored. The project the router resolved for
 * this request travels to the factory through an `AsyncLocalStorage` scope rather than through the
 * request's `AuthInfo`, which stays what it is — the credential.
 */
export function createModernMcpHandler(ctx: AppContext): ModernMcpHandler {
  const projectScope = new AsyncLocalStorage<ProjectRow>();

  const handler = createMcpHandler(
    ({ era, authInfo }) => {
      const project = projectScope.getStore();
      // Unreachable through the router, which always serves inside a scope; a guard, not a branch.
      if (!project) throw new Error('modern MCP request served outside a project scope');
      return createProjectMcpServer(ctx, { project, era, auth: authInfo });
    },
    {
      legacy: 'reject',
      maxRequestBodySize: MODERN_MAX_REQUEST_BODY_SIZE,
      onerror: (err) => ctx.log.error({ err }, 'mcp modern-era error'),
    },
  );

  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: MODERN_MAX_REQUEST_BODY_SIZE,
    onerror: (err) => ctx.log.error({ err }, 'mcp modern-era transport error'),
  });

  return {
    handle: (project, req, res, parsedBody) => projectScope.run(project, () => nodeHandler(req, res, parsedBody)),
    close: () => handler.close(),
  };
}
