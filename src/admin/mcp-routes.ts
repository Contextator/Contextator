import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requirePrincipal } from '../auth/plugin.js';
import { createMcpToken, listMcpTokens, revokeMcpToken, setProjectMcpAuth } from '../services/auth/mcp-tokens.js';

const ProjectParams = z.object({ id: z.uuid() });
const TokenParams = ProjectParams.extend({ tokenId: z.uuid() });
const CreateBody = z.object({ name: z.string().max(100).default('') });

/**
 * `/api/projects/:id/mcp-tokens/*`. The project guard in src/auth/plugin.ts has already decided
 * whether this principal reaches the project: reading the list is a viewer's, minting and revoking
 * an editor's. Turning the requirement on and off is a manager's, and lives on the project itself.
 */
export const mcpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, sessions } = ctx;

  app.get('/api/projects/:id/mcp-tokens', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    return listMcpTokens(db, id);
  });

  app.post('/api/projects/:id/mcp-tokens', async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = ProjectParams.parse(req.params);
    const { name } = CreateBody.parse(req.body ?? {});
    const { token, view } = await createMcpToken(db, id, name, principal.userId);
    // Returned once and never again: the database holds only its hash.
    return reply.code(201).send({ token: view, secret: token });
  });

  app.delete('/api/projects/:id/mcp-tokens/:tokenId', async (req, reply) => {
    const { id, tokenId } = TokenParams.parse(req.params);
    await revokeMcpToken(db, id, tokenId);
    // An open MCP session was authenticated once; close it so the revocation is immediate rather
    // than "on their next request".
    await sessions.closeForProject(id);
    return reply.code(204).send();
  });

  app.patch('/api/projects/:id/mcp-auth', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const { mode } = z.object({ mode: z.enum(['open', 'token']) }).parse(req.body);
    const mcpAuth = await setProjectMcpAuth(db, id, mode);
    // Closing on the way in as well as out: a session opened while the endpoint was public should
    // not outlive the moment it stopped being public.
    if (mode === 'token') await sessions.closeForProject(id);
    return { mcpAuth };
  });
};
