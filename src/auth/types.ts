import type { UserRole } from '../db/schema.js';

export type { ProjectMemberRole, UserRole } from '../db/schema.js';

/** How far a principal reaches into one project. `manager` is the project's lifecycle, not its content. */
export type ProjectAccess = 'none' | 'viewer' | 'editor' | 'manager';

/**
 * Who is making the request. `token` is ADMIN_TOKEN — machine access with root permissions, kept
 * so scripts and CI that predate accounts keep working.
 */
export type Principal =
  | { kind: 'token'; role: 'root'; userId: null; username: string; mustChangePassword: false }
  | { kind: 'session'; role: UserRole; userId: string; username: string; sessionId: string; mustChangePassword: boolean };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    projectAccess: ProjectAccess | null;
  }
}
