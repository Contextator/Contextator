import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { isOriginAllowed } from '../services/origin.js';
import { getProjectByName } from '../services/projects.js';
import { mcpAccessDecision, mcpAccessMessage, mcpAccessStatus, readMcpBearer } from './access.js';
import { resolveMcpCredential } from './identity.js';
import { createProjectMcpServer } from './server-factory.js';

/**
 * MCP endpoints, one URL per project: `/mcp/:project`.
 *
 * Both transports share the URL following the MCP backwards-compatibility rules:
 *   POST   /mcp/:project            Streamable HTTP (initialize → new session; `mcp-session-id` → existing session)
 *   GET    /mcp/:project            with `mcp-session-id` → Streamable HTTP server stream
 *                                   without it            → legacy HTTP+SSE stream (protocol 2024-11-05)
 *   POST   /mcp/:project/messages   legacy SSE inbound channel (`?sessionId=`)
 *   DELETE /mcp/:project            Streamable HTTP session termination
 *
 * Every handler hijacks the Fastify reply and hands the raw Node request/response to the SDK.
 * Fastify has already parsed the JSON body, so it is passed through as `parsedBody`.
 */

interface McpRoute {
  Params: { project: string };
  Querystring: { sessionId?: string };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved once in the onRequest hook, so the four handlers do not each look it up again. */
    mcpProject: ProjectRow | null;
    /**
     * Which of the project's MCP tokens this request presented, when it presented a live one. NULL for
     * an `open` project answered without one. Bound into the session's tool set at initialize
     * ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
     */
    mcpTokenId: string | null;
  }
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null });
const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export const mcpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, sessions, log } = ctx;
  const legacySsePingMs = 25_000;

  // Primitive defaults: an object default would be shared between requests.
  app.decorateRequest('mcpProject', null);
  app.decorateRequest('mcpTokenId', null);

  /**
   * Origin validation (DNS-rebinding protection), then the project and its MCP access rule.
   *
   * Doing this once, here, means every route — including the legacy `/messages` channel and session
   * termination — is covered, and a route added later inherits it rather than having to remember.
   * A project left `open` behaves exactly as it always has.
   */
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, req.host, config.ALLOWED_ORIGINS)) {
      return reply.code(403).send(rpcError(-32000, 'Forbidden origin'));
    }

    const name = (req.params as { project?: string }).project ?? '';
    const project = await getProjectByName(ctx.db, name);
    if (!project) return reply.code(404).send(rpcError(-32001, `Unknown project "${name}"`));
    req.mcpProject = project;

    const bearer = readMcpBearer(req.headers.authorization);
    // The credential and not only the verdict, for two reasons that used to be one. The token id is
    // what lets a search made through this session say which credential it came through
    // ([ADR-0047](../../.ssot/ADR.md#adr-0047)); the *account* behind it is what the decision now turns
    // on ([ADR-0054](../../.ssot/ADR.md#adr-0054)). An `open` project answered without a credential
    // still verifies nothing and still records nothing, which is what it means for it to be open.
    const { credential, tokenId } = await resolveMcpCredential(ctx.db, project.id, bearer);
    req.mcpTokenId = tokenId;
    const verdict = mcpAccessDecision(project.mcpAuth, credential);
    if (verdict === 'ok') return;

    if (verdict === 'token_invalid') log.warn({ project: project.name }, 'mcp request with an unknown, expired or revoked credential');
    if (verdict === 'not_a_member') log.warn({ project: project.name }, 'mcp request by an account with no membership of this project');

    // RFC 6750 says which scheme is expected; RFC 9728 says where to find out what would satisfy it,
    // and that pointer is what lets a browser-based connector start the OAuth flow from a 401 rather
    // than from a URL somebody had to paste. It is emitted whether or not this instance is an
    // authorization server: with `MCP_OAUTH=0` the document is simply not there to fetch, which is the
    // same answer a client gets from any resource server that does not do OAuth.
    const base = (config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
    const challenge = `Bearer realm="${project.name}", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/${project.name}"`;
    return reply
      .code(mcpAccessStatus(verdict))
      .header('www-authenticate', challenge)
      .send(rpcError(-32000, mcpAccessMessage(verdict, project.mcpAuth)));
  });

  /** The hook has already resolved it and answered 404 if it does not exist. */
  const requireProject = (req: FastifyRequest<McpRoute>): ProjectRow => req.mcpProject!;

  /** After `reply.hijack()` Fastify no longer answers for us, so transport failures are written by hand. */
  async function guarded(reply: FastifyReply, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.error({ err }, 'mcp transport error');
      const raw = reply.raw;
      if (!raw.headersSent) {
        raw.writeHead(500, { 'content-type': 'application/json' });
        raw.end(JSON.stringify(rpcError(-32603, 'Internal error')));
      } else if (!raw.writableEnded) {
        raw.end();
      }
    }
  }

  // ---- Streamable HTTP: client → server messages ----
  app.post<McpRoute>('/mcp/:project', async (req, reply) => {
    const project = requireProject(req);

    const sessionId = headerValue(req.headers['mcp-session-id']);
    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      const session = sessions.get(sessionId, 'streamable');
      if (!session) return reply.code(404).send(rpcError(-32001, 'Session not found'));
      if (session.projectId !== project.id) return reply.code(400).send(rpcError(-32000, 'Session belongs to a different project'));
      sessions.touch(sessionId);
      transport = session.transport;
    } else if (isInitializeRequest(req.body)) {
      // The token of the request that *opened* the session, not of each later one: an MCP session is a
      // credential's connection, and the SDK builds the tool set once per session.
      const server = createProjectMcpServer(ctx, project, req.mcpTokenId);
      const fresh = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.add({
            id,
            kind: 'streamable',
            projectId: project.id,
            projectName: project.name,
            transport: fresh,
            server,
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
          });
        },
        onsessionclosed: (id) => sessions.delete(id),
      });
      await server.connect(fresh);
      // connect() installs the protocol's own onclose; chain ours after it.
      const protocolOnClose = fresh.onclose;
      fresh.onclose = () => {
        protocolOnClose?.();
        if (fresh.sessionId) sessions.delete(fresh.sessionId);
      };
      transport = fresh;
    } else {
      return reply.code(400).send(rpcError(-32000, 'Bad Request: No valid session ID provided'));
    }

    reply.hijack();
    await guarded(reply, () => transport.handleRequest(req.raw, reply.raw, req.body));
  });

  // ---- GET: Streamable HTTP server stream, or legacy SSE when no session header is present ----
  app.get<McpRoute>('/mcp/:project', async (req, reply) => {
    const project = requireProject(req);

    const sessionId = headerValue(req.headers['mcp-session-id']);
    if (sessionId) {
      const session = sessions.get(sessionId, 'streamable');
      if (!session || session.projectId !== project.id) return reply.code(404).send(rpcError(-32001, 'Session not found'));
      sessions.touch(sessionId);
      reply.hijack();
      await guarded(reply, () => session.transport.handleRequest(req.raw, reply.raw));
      return;
    }

    // Legacy HTTP+SSE transport. hijack() must precede connect(): SSEServerTransport.start() writes the response head.
    const server = createProjectMcpServer(ctx, project, req.mcpTokenId);
    reply.hijack();
    const transport = new SSEServerTransport(`/mcp/${project.name}/messages`, reply.raw);
    const ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, legacySsePingMs);
    reply.raw.on('close', () => clearInterval(ping));

    sessions.add({
      id: transport.sessionId,
      kind: 'sse',
      projectId: project.id,
      projectName: project.name,
      transport,
      server,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    await guarded(reply, async () => {
      await server.connect(transport); // writes 200 + `event: endpoint`
      const protocolOnClose = transport.onclose;
      transport.onclose = () => {
        clearInterval(ping);
        protocolOnClose?.();
        sessions.delete(transport.sessionId);
      };
    });
  });

  // ---- Legacy SSE: client → server messages ----
  app.post<McpRoute>('/mcp/:project/messages', async (req, reply) => {
    const project = requireProject(req);

    const session = req.query.sessionId ? sessions.get(req.query.sessionId, 'sse') : undefined;
    if (!session || session.projectId !== project.id) return reply.code(404).send(rpcError(-32001, 'Session not found'));
    sessions.touch(session.id);

    reply.hijack();
    await guarded(reply, () => session.transport.handlePostMessage(req.raw, reply.raw, req.body));
  });

  // ---- Streamable HTTP: explicit session termination ----
  app.delete<McpRoute>('/mcp/:project', async (req, reply) => {
    const project = requireProject(req);

    const sessionId = headerValue(req.headers['mcp-session-id']);
    const session = sessionId ? sessions.get(sessionId, 'streamable') : undefined;
    if (!session || session.projectId !== project.id) return reply.code(404).send(rpcError(-32001, 'Session not found'));

    reply.hijack();
    await guarded(reply, () => session.transport.handleRequest(req.raw, reply.raw));
  });
};
