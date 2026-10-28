import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requirePrincipal } from '../auth/plugin.js';
import { listMembers, MembershipManagedByGroupError, removeMember, setMemberRole } from '../services/auth/memberships.js';

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
  // ADR-0134: while group mapping is on, a group-granted row is the group's to change, not the members API's.
  const groupsManaged = (): boolean => ctx.config.OIDC_GROUPS_CLAIM !== undefined;
  const refuseManaged = (reply: FastifyReply, err: MembershipManagedByGroupError): FastifyReply =>
    reply.code(409).send({ error: err.code, message: err.message });

  app.get('/api/projects/:id/members', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    return listMembers(db, id);
  });

  app.put('/api/projects/:id/members/:userId', async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id, userId } = MemberParams.parse(req.params);
    const { role } = RoleBody.parse(req.body);
    try {
      return await setMemberRole(db, id, userId, role, principal.userId, { groupsManaged: groupsManaged() });
    } catch (err) {
      if (err instanceof MembershipManagedByGroupError) return refuseManaged(reply, err);
      throw err;
    }
  });

  app.delete('/api/projects/:id/members/:userId', async (req, reply) => {
    const { id, userId } = MemberParams.parse(req.params);
    try {
      await removeMember(db, id, userId, { groupsManaged: groupsManaged() });
    } catch (err) {
      if (err instanceof MembershipManagedByGroupError) return refuseManaged(reply, err);
      throw err;
    }
    return reply.code(204).send();
  });
};
