import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { projectMembers, projects, users, type ProjectMemberOrigin, type ProjectMemberRole, type ProjectRow } from '../../db/schema.js';
import type { Principal, ProjectAccess } from '../../auth/types.js';
import { accessFromMembership } from '../../auth/policy.js';
import { NotFoundError, ValidationError } from '../projects.js';
import { withUserRowLock } from './users.js';

export interface MemberView {
  userId: string;
  username: string;
  displayName: string;
  role: ProjectMemberRole;
  createdAt: Date;
  /** `manual`, or `oidc_group` for a row an SSO sign-in reconciled from the provider's groups ([ADR-0134](../../../.ssot/ADR.md#adr-0134)). */
  origin: ProjectMemberOrigin;
  /** The provider groups behind an `oidc_group` row; empty for a `manual` one. */
  groups: string[];
}

/**
 * Thrown for a change to a group-granted membership while group mapping is on (ADR-0134 decision 3):
 * the next sign-in of that person would put it back, so editing it would only look like it worked.
 * The routes answer `409 membership_managed_by_group`; the emergency lever is disabling the account.
 */
export class MembershipManagedByGroupError extends Error {
  readonly code = 'membership_managed_by_group';
  constructor() {
    super('This membership comes from a single sign-on group; change the group mapping, or disable the account to cut access now');
    this.name = 'MembershipManagedByGroupError';
  }
}

/** Whether the members API must refuse to change a group-granted row — `OIDC_GROUPS_CLAIM` is set. */
export interface MembershipWriteOptions {
  groupsManaged: boolean;
}

export async function listMembers(db: Db, projectId: string): Promise<MemberView[]> {
  const rows = await db
    .select({
      userId: projectMembers.userId,
      username: users.username,
      displayName: users.displayName,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
      origin: projectMembers.origin,
      groups: projectMembers.oidcGroups,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.username));
  return rows.map((row) => ({ ...row, groups: row.groups ?? [] }));
}

/**
 * Grants or changes a **manual** membership. Runs under the account's row lock — the one an SSO
 * sign-in's reconciliation holds — so the two cannot interleave on the same row. A group-granted row is
 * refused while group mapping is on, and becomes `manual` (the administrator has taken it over) while
 * it is off (ADR-0134 decision 3).
 */
export async function setMemberRole(
  db: Db,
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
  createdBy: string | null,
  options: MembershipWriteOptions = { groupsManaged: false },
): Promise<MemberView> {
  await withUserRowLock(db, userId, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundError('User not found');
    // root and admin already reach every project; a membership row would say something untrue.
    if (user.role !== 'member') throw new ValidationError('Administrators already have access to every project');

    const [existing] = await tx
      .select({ origin: projectMembers.origin })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (existing?.origin === 'oidc_group') {
      if (options.groupsManaged) throw new MembershipManagedByGroupError();
      await tx
        .update(projectMembers)
        .set({ role, origin: 'manual', oidcGroups: null, createdBy })
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
      return;
    }
    await tx
      .insert(projectMembers)
      .values({ projectId, userId, role, createdBy })
      .onConflictDoUpdate({ target: [projectMembers.userId, projectMembers.projectId], set: { role } });
  });

  const members = await listMembers(db, projectId);
  return members.find((m) => m.userId === userId)!;
}

export async function removeMember(
  db: Db,
  projectId: string,
  userId: string,
  options: MembershipWriteOptions = { groupsManaged: false },
): Promise<void> {
  await withUserRowLock(db, userId, async (tx) => {
    const [existing] = await tx
      .select({ origin: projectMembers.origin })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (!existing) throw new NotFoundError('That account is not a member of this project');
    if (existing.origin === 'oidc_group' && options.groupsManaged) throw new MembershipManagedByGroupError();
    await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  });
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
  const rows = await db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
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
