import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { projectMembers, projects, users, type ProjectMemberRole, type ProjectRow } from '../../db/schema.js';
import type { Principal, ProjectAccess } from '../../auth/types.js';
import { accessFromMembership } from '../../auth/policy.js';
import { NotFoundError, ValidationError } from '../projects.js';

export interface MemberView {
  userId: string;
  username: string;
  displayName: string;
  role: ProjectMemberRole;
  createdAt: Date;
}

export async function listMembers(db: Db, projectId: string): Promise<MemberView[]> {
  const rows = await db
    .select({
      userId: projectMembers.userId,
      username: users.username,
      displayName: users.displayName,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.username));
  return rows;
}

export async function setMemberRole(db: Db, projectId: string, userId: string, role: ProjectMemberRole, createdBy: string | null): Promise<MemberView> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User not found');
  // root and admin already reach every project; a membership row would say something untrue.
  if (user.role !== 'member') throw new ValidationError('Administrators already have access to every project');

  await db
    .insert(projectMembers)
    .values({ projectId, userId, role, createdBy })
    .onConflictDoUpdate({ target: [projectMembers.userId, projectMembers.projectId], set: { role } });

  const members = await listMembers(db, projectId);
  return members.find((m) => m.userId === userId)!;
}

export async function removeMember(db: Db, projectId: string, userId: string): Promise<void> {
  const result = await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .returning({ userId: projectMembers.userId });
  if (result.length === 0) throw new NotFoundError('That account is not a member of this project');
}

/** Every project a member account may open, in the same order as listProjects(). */
export async function listProjectsForUser(db: Db, userId: string): Promise<ProjectRow[]> {
  const rows = await db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .orderBy(asc(projects.name));
  return rows.map((r) => r.project);
}

/** `{ <projectId>: 'viewer' | 'editor' }` for the dashboard, so it can hide what it must. */
export async function membershipMap(db: Db, userId: string): Promise<Record<string, ProjectMemberRole>> {
  const rows = await db.select({ projectId: projectMembers.projectId, role: projectMembers.role }).from(projectMembers).where(eq(projectMembers.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.projectId, r.role]));
}

/**
 * How far this principal reaches into this project. `none` also covers "the project does not
 * exist", and the caller answers 404 either way so project ids cannot be enumerated.
 */
export async function resolveProjectAccess(db: Db, principal: Principal, projectId: string): Promise<ProjectAccess> {
  if (principal.kind === 'token' || principal.role !== 'member') {
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    return row ? accessFromMembership(principal, null) : 'none';
  }
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, principal.userId)))
    .limit(1);
  return accessFromMembership(principal, row?.role ?? null);
}
