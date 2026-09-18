import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requirePrincipal } from '../auth/plugin.js';
import { listMembers, removeMember, setMemberRole } from '../services/auth/memberships.js';

const ProjectParams = z.object({ id: z.uuid() });
const MemberParams = ProjectParams.extend({ userId: z.uuid() });
const RoleBody = z.object({ role: z.enum(['viewer', 'editor']) });

/**
 * `/api/projects/:id/members/*`. Registered inside adminRoutes, so the project guard in
 * src/auth/plugin.ts has already decided whether this principal reaches the project at all:
 * `viewer` to read the list, `manager` (root/admin) to change it.
 */
export const memberRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;

  app.get('/api/projects/:id/members', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    return listMembers(db, id);
  });

  app.put('/api/projects/:id/members/:userId', async (req) => {
    const principal = requirePrincipal(req);
    const { id, userId } = MemberParams.parse(req.params);
    const { role } = RoleBody.parse(req.body);
    return setMemberRole(db, id, userId, role, principal.userId);
  });

  app.delete('/api/projects/:id/members/:userId', async (req, reply) => {
    const { id, userId } = MemberParams.parse(req.params);
    await removeMember(db, id, userId);
    return reply.code(204).send();
  });
};
