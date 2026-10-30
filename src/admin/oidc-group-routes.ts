import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requirePrincipal } from '../auth/plugin.js';
import { createGroupMapping, deleteGroupMapping, listGroupMappings, MAX_GROUP_NAME_CHARS, MappingExistsError } from '../services/auth/oidc-groups.js';

const MappingParams = z.object({ id: z.uuid() });
const MappingBody = z.object({
  // Matched exactly and case-sensitively against the ID token, so it is stored exactly as typed; only a
  // name that is nothing but whitespace is refused, since no provider emits one.
  group: z
    .string()
    .min(1)
    .max(MAX_GROUP_NAME_CHARS)
    .refine((value) => value.trim().length > 0, 'must not be only whitespace'),
  projectId: z.uuid(),
  role: z.enum(['viewer', 'editor']),
});

/**
 * `/api/oidc/group-mappings` ([ADR-0134](../../.ssot/ADR.md#adr-0134), FR-702, FR-703): which provider
 * group grants which project, and how far. `admin` only (`requiredRole` in `src/auth/policy.ts`).
 *
 * Open whether or not `OIDC_GROUPS_CLAIM` is set, so mappings can be prepared before the feature is
 * switched on. There is no `PATCH`: a change of role is a delete and an add, and the delete recomputes
 * every membership that rested on the group, in the same request.
 */
export const oidcGroupRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;

  app.get('/api/oidc/group-mappings', async () => ({
    mappings: (await listGroupMappings(db)).map((m) => ({
      id: m.id,
      group: m.group,
      projectId: m.projectId,
      projectName: m.projectName,
      role: m.role,
      createdAt: m.createdAt,
    })),
  }));

  app.post('/api/oidc/group-mappings', async (req, reply) => {
    const principal = requirePrincipal(req);
    const body = MappingBody.parse(req.body);
    try {
      const row = await createGroupMapping(db, body, principal.userId);
      // The group name is typed text and stays out of the audit row (`AUDIT_DETAIL` only admits closed
      // sets); the project is a row id this handler has just checked exists.
      req.auditDetail = { projectId: row.projectId };
      return reply.code(201).send({ id: row.id, group: row.groupName, projectId: row.projectId, role: row.role, createdAt: row.createdAt });
    } catch (err) {
      if (err instanceof MappingExistsError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.delete('/api/oidc/group-mappings/:id', async (req, reply) => {
    const { id } = MappingParams.parse(req.params);
    const deletion = await deleteGroupMapping(db, id);
    req.auditDetail = { membershipsUpdated: deletion.membershipsUpdated, membershipsRemoved: deletion.membershipsRemoved };
    return reply.code(204).send();
  });
};
