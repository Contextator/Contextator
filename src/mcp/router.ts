import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { getProjectByName } from '../services/projects.js';
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

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null });
const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const mcpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, sessions, log } = ctx;
  const legacySsePingMs = 25_000;

  /**
   * Origin validation (DNS-rebinding protection). Non-browser clients send no Origin and pass.
   * Browser origins pass when listed in ALLOWED_ORIGINS, when they are local, or when they match the request host.
   */
  function isOriginAllowed(origin: string, req: FastifyRequest): boolean {
    if (config.ALLOWED_ORIGINS.includes(origin)) return true;
    try {
      const url = new URL(origin);
      if (LOCAL_HOSTS.has(url.hostname)) return true;
      return url.host === req.host;
    } catch {
      return false;
    }
  }

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, req)) {
      return reply.code(403).send(rpcError(-32000, 'Forbidden origin'));
    }
  });

  async function requireProject(req: FastifyRequest<McpRoute>, reply: FastifyReply): Promise<ProjectRow | null> {
    const project = await getProjectByName(ctx.db, req.params.project);
    if (!project) {
      await reply.code(404).send(rpcError(-32001, `Unknown project "${req.params.project}"`));
      return null;
    }
    return project;
  }

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
    const project = await requireProject(req, reply);
    if (!project) return;

    const sessionId = headerValue(req.headers['mcp-session-id']);
    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      const session = sessions.get(sessionId, 'streamable');
      if (!session) return reply.code(404).send(rpcError(-32001, 'Session not found'));
      if (session.projectId !== project.id) return reply.code(400).send(rpcError(-32000, 'Session belongs to a different project'));
      sessions.touch(sessionId);
      transport = session.transport;
    } else if (isInitializeRequest(req.body)) {
      const server = createProjectMcpServer(ctx, project);
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
    const project = await requireProject(req, reply);
    if (!project) return;

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
    const server = createProjectMcpServer(ctx, project);
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
    const project = await requireProject(req, reply);
    if (!project) return;

    const session = req.query.sessionId ? sessions.get(req.query.sessionId, 'sse') : undefined;
    if (!session || session.projectId !== project.id) return reply.code(404).send(rpcError(-32001, 'Session not found'));
    sessions.touch(session.id);

    reply.hijack();
    await guarded(reply, () => session.transport.handlePostMessage(req.raw, reply.raw, req.body));
  });

  // ---- Streamable HTTP: explicit session termination ----
  app.delete<McpRoute>('/mcp/:project', async (req, reply) => {
    const project = await requireProject(req, reply);
    if (!project) return;

    const sessionId = headerValue(req.headers['mcp-session-id']);
    const session = sessionId ? sessions.get(sessionId, 'streamable') : undefined;
    if (!session || session.projectId !== project.id) return reply.code(404).send(rpcError(-32001, 'Session not found'));

    reply.hijack();
    await guarded(reply, () => session.transport.handleRequest(req.raw, reply.raw));
  });
};
