import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { oidcGroupMappings, projectMembers, projects, type OidcGroupMappingRow, type ProjectMemberRole } from '../../db/schema.js';
import type { AuditDetail, AuditSubject } from '../../auth/policy.js';
import type { Principal } from '../../auth/types.js';
import { recordAuditEvent } from '../audit.js';
import { ConflictError, NotFoundError } from '../projects.js';
import { uniqueViolationConstraint } from './users.js';

/**
 * Provider groups to project memberships ([ADR-0134](../../../.ssot/ADR.md#adr-0134), amending
 * [ADR-0077](../../../.ssot/ADR.md#adr-0077); FR-702, FR-703).
 *
 * Three things live here: reading the ID token's group claim (pure), reconciling one account's
 * `oidc_group` memberships against it (the caller holds the account's row lock), and the paths that
 * keep a group-granted row from outliving its reason — a deleted mapping, an unlink, a password sign-in.
 * Reconciliation touches `origin = 'oidc_group'` rows only; a `manual` row for the same project wins
 * and is never read as anything but "already has access".
 */

/** More entries than this and the claim is not read: an IdP emitting this many has sent something else. */
export const MAX_GROUP_CLAIM_ENTRIES = 1000;
/** A longer group name cannot be one an administrator typed into a mapping (the column is bounded by the same number). */
export const MAX_GROUP_NAME_CHARS = 256;

export type GroupsUnavailableReason = 'overage' | 'not_a_list' | 'too_many' | 'entry_too_long';

/** What the sign-in could make of the claim: a set of group names (possibly empty), or "cannot be trusted as complete". */
export type GroupsRead = { ok: true; groups: string[] } | { ok: false; reason: GroupsUnavailableReason };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the configured claim off the ID token's claims (ADR-0134 decision 5). Pure.
 *
 * Providers say "no group" in three ways — the claim is omitted, it is `[]`, or (Keycloak) `{}` — and
 * all three, plus `null`, are the empty set. What is **not** the empty set is data this instance
 * knows to be incomplete or cannot interpret: Microsoft Entra ID omits `groups` for a person in more
 * than 200 groups and names it under `_claim_names` instead, so there an absent claim means the
 * opposite of "no group"; and a value that is not a list of strings, a list over the size bounds, or
 * an entry over the length bound is data nobody should remove or keep access on.
 */
export function readGroupsClaim(claims: Readonly<Record<string, unknown>>, claimName: string): GroupsRead {
  const names = claims._claim_names;
  // `groups` is Entra's own name for the marker; the configured name covers a provider that renamed it.
  if (isPlainObject(names) && (Object.hasOwn(names, 'groups') || Object.hasOwn(names, claimName))) return { ok: false, reason: 'overage' };

  const value = Object.hasOwn(claims, claimName) ? claims[claimName] : undefined;
  if (value === undefined || value === null) return { ok: true, groups: [] };
  if (isPlainObject(value)) return Object.keys(value).length === 0 ? { ok: true, groups: [] } : { ok: false, reason: 'not_a_list' };
  if (!Array.isArray(value)) return { ok: false, reason: 'not_a_list' };
  if (value.length > MAX_GROUP_CLAIM_ENTRIES) return { ok: false, reason: 'too_many' };

  const groups = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, reason: 'not_a_list' };
    if (entry.length > MAX_GROUP_NAME_CHARS) return { ok: false, reason: 'entry_too_long' };
    // An empty name matches no mapping (the column forbids one); it is dropped rather than refused.
    if (entry.length > 0) groups.add(entry);
  }
  return { ok: true, groups: [...groups].sort() };
}

const ROLE_RANK: Record<ProjectMemberRole, number> = { viewer: 1, editor: 2 };
const higherRole = (a: ProjectMemberRole, b: ProjectMemberRole): ProjectMemberRole => (ROLE_RANK[a] >= ROLE_RANK[b] ? a : b);

/**
 * Serialises mapping writes against sign-in reconciliation. A sign-in that read a mapping just before
 * it was deleted could otherwise insert a row for it just after the deletion recomputed the rows that
 * existed — a group-granted membership with no mapping behind it until the next sign-in. Sign-ins
 * share the lock (they never wait for each other); a mapping deletion takes it exclusively.
 */
// A literal number interpolated into raw SQL, as `ADVISORY_LOCK_SETUP` is in `src/admin/auth-routes.ts`; never a value from a request.
const ADVISORY_LOCK_GROUP_MAPPINGS = 7213011;

export type MembershipChange = 'added' | 'role_changed' | 'removed';

export interface ReconciledMembership {
  projectId: string;
  change: MembershipChange;
  role?: ProjectMemberRole;
  previousRole?: ProjectMemberRole;
  groups: string[];
}

interface Desired {
  role: ProjectMemberRole;
  groups: string[];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Makes one account's `oidc_group` memberships exactly the projects its groups map to, and returns
 * every change it made (ADR-0134 decision 4). Where groups disagree on a project, the higher role wins.
 *
 * The caller holds the account's row lock (`withUserRowLock`) and has already established that the
 * account is a `member`: `admin` and `root` reach every project, and a row for either would say
 * something untrue. `groups` is a sorted set from `readGroupsClaim`.
 */
export async function reconcileGroupMemberships(tx: Db, userId: string, groups: readonly string[]): Promise<ReconciledMembership[]> {
  await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock_shared(${ADVISORY_LOCK_GROUP_MAPPINGS})`));

  const desired = new Map<string, Desired>();
  if (groups.length > 0) {
    const mappings = await tx
      .select()
      .from(oidcGroupMappings)
      .where(inArray(oidcGroupMappings.groupName, [...groups]));
    for (const mapping of mappings) {
      const entry = desired.get(mapping.projectId);
      if (entry) {
        entry.role = higherRole(entry.role, mapping.role);
        entry.groups.push(mapping.groupName);
      } else {
        desired.set(mapping.projectId, { role: mapping.role, groups: [mapping.groupName] });
      }
    }
    for (const entry of desired.values()) entry.groups.sort();
  }

  const existing = new Map(
    (await tx.select().from(projectMembers).where(eq(projectMembers.userId, userId))).map((row) => [row.projectId, row] as const),
  );

  const changes: ReconciledMembership[] = [];

  for (const [projectId, want] of desired) {
    const have = existing.get(projectId);
    // A hand-made membership wins and is not touched: the administrator who made it meant it.
    if (have?.origin === 'manual') continue;
    if (!have) {
      await tx.insert(projectMembers).values({ userId, projectId, role: want.role, createdBy: null, origin: 'oidc_group', oidcGroups: want.groups });
      changes.push({ projectId, change: 'added', role: want.role, groups: want.groups });
      continue;
    }
    const haveGroups = [...(have.oidcGroups ?? [])].sort();
    if (have.role === want.role && sameList(haveGroups, want.groups)) continue;
    await tx
      .update(projectMembers)
      .set({ role: want.role, oidcGroups: want.groups })
      .where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)));
    // A change of which groups grant the same role moves no access, so it is not an event.
    if (have.role !== want.role) changes.push({ projectId, change: 'role_changed', role: want.role, previousRole: have.role, groups: want.groups });
  }

  for (const [projectId, have] of existing) {
    if (have.origin !== 'oidc_group' || desired.has(projectId)) continue;
    await tx.delete(projectMembers).where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)));
    changes.push({ projectId, change: 'removed', previousRole: have.role, groups: [...(have.oidcGroups ?? [])].sort() });
  }

  return changes.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/** Why a removal that is not a reconciliation happened; carried in the event's `detail.reason`. */
export type GroupRemovalReason = 'password_sign_in' | 'unlink';

/**
 * Removes every `oidc_group` row of one account and returns what it removed. For the paths that have
 * no claim to reconcile against — a password sign-in and an SSO unlink — where leaving the row would
 * leave access nothing vouches for any more (ADR-0134 decision 6). The caller holds the account's
 * row lock. `manual` rows are untouched.
 */
export async function removeGroupMemberships(tx: Db, userId: string): Promise<ReconciledMembership[]> {
  const removed = await tx
    .delete(projectMembers)
    .where(and(eq(projectMembers.userId, userId), eq(projectMembers.origin, 'oidc_group')))
    .returning({ projectId: projectMembers.projectId, role: projectMembers.role, groups: projectMembers.oidcGroups });
  return removed
    .map((row) => ({ projectId: row.projectId, change: 'removed' as const, previousRole: row.role, groups: [...(row.groups ?? [])].sort() }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/** The request an audit event of this kind is written for: the action, who acted, and the status the caller answers. */
export interface MembershipAuditContext {
  action: string;
  principal: Principal;
  ip: string | null;
  statusCode: number;
  provider: string;
  reason?: GroupRemovalReason;
}

/**
 * One event per change, written inside the transaction that made it (ADR-0134 decision 7): the log
 * cannot say a membership changed that did not, and cannot miss one that did. `groups` are names an
 * administrator typed into a mapping, not request content; `reason` comes from a closed set.
 */
export async function auditMembershipChanges(
  tx: Db,
  userId: string,
  changes: readonly ReconciledMembership[],
  context: MembershipAuditContext,
): Promise<void> {
  for (const change of changes) {
    const detail: AuditDetail = { provider: context.provider, change: change.change, groups: change.groups };
    if (change.role !== undefined) detail.role = change.role;
    if (change.previousRole !== undefined) detail.previousRole = change.previousRole;
    if (context.reason !== undefined) detail.reason = context.reason;
    const subject: AuditSubject = { action: context.action, projectId: change.projectId, targetType: 'membership', targetId: userId, detail };
    await recordAuditEvent(tx, subject, { principal: context.principal, ip: context.ip, statusCode: context.statusCode });
  }
}

// ---------------------------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------------------------

export interface GroupMappingView {
  id: string;
  group: string;
  projectId: string;
  projectName: string;
  role: ProjectMemberRole;
  createdAt: Date;
}

const MAPPING_UNIQUE = 'oidc_group_mappings_group_project_key';

export async function listGroupMappings(db: Db): Promise<GroupMappingView[]> {
  const rows = await db
    .select({
      id: oidcGroupMappings.id,
      group: oidcGroupMappings.groupName,
      projectId: oidcGroupMappings.projectId,
      projectName: projects.name,
      role: oidcGroupMappings.role,
      createdAt: oidcGroupMappings.createdAt,
    })
    .from(oidcGroupMappings)
    .innerJoin(projects, eq(projects.id, oidcGroupMappings.projectId))
    .orderBy(asc(oidcGroupMappings.groupName), asc(projects.name), asc(oidcGroupMappings.id));
  return rows;
}

/** Thrown for a second mapping of one group to one project; the route answers `409 mapping_exists`. */
export class MappingExistsError extends ConflictError {
  readonly code = 'mapping_exists';
  constructor() {
    super('That group is already mapped to that project; delete the mapping and add it again to change its role');
  }
}

export async function createGroupMapping(
  db: Db,
  input: { group: string; projectId: string; role: ProjectMemberRole },
  createdBy: string | null,
): Promise<OidcGroupMappingRow> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new NotFoundError('Project not found');
  try {
    const [row] = await db
      .insert(oidcGroupMappings)
      .values({ groupName: input.group, projectId: input.projectId, role: input.role, createdBy })
      .returning();
    return row!;
  } catch (err) {
    if (uniqueViolationConstraint(err) === MAPPING_UNIQUE) throw new MappingExistsError();
    throw err;
  }
}

export interface MappingDeletion {
  membershipsUpdated: number;
  membershipsRemoved: number;
}

/**
 * Deletes a mapping and, in the same transaction, recomputes every membership that listed its group
 * (ADR-0134 decision 6): the role from the groups it still has, or its removal when none are left.
 * Without it an administrator would delete a mapping believing the access gone while every person
 * already signed in kept it until their next sign-in.
 *
 * `membershipsUpdated` counts the rows kept but rewritten — a lower role, or only a shorter list of
 * groups behind the same role.
 */
export async function deleteGroupMapping(db: Db, mappingId: string): Promise<MappingDeletion> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_GROUP_MAPPINGS})`));
    const [mapping] = await tx.delete(oidcGroupMappings).where(eq(oidcGroupMappings.id, mappingId)).returning();
    if (!mapping) throw new NotFoundError('Mapping not found');

    const affected = await tx
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, mapping.projectId),
          eq(projectMembers.origin, 'oidc_group'),
          sql`${mapping.groupName} = ANY(${projectMembers.oidcGroups})`,
        ),
      )
      // Row locks: a password sign-in, an unlink or the members API changes these rows under the account's
      // row lock, not the advisory one. Waiting for them, and re-evaluating `origin` once they commit, is
      // what keeps a row that has meanwhile become `manual` (or vanished) out of what is rewritten below.
      .for('update');
    if (affected.length === 0) return { membershipsUpdated: 0, membershipsRemoved: 0 };

    const remaining = await tx.select().from(oidcGroupMappings).where(eq(oidcGroupMappings.projectId, mapping.projectId));
    const result: MappingDeletion = { membershipsUpdated: 0, membershipsRemoved: 0 };
    for (const row of affected) {
      const groups = (row.oidcGroups ?? []).filter((group) => group !== mapping.groupName).sort();
      const left = remaining.filter((candidate) => groups.includes(candidate.groupName));
      // `origin` again, the same pattern as `removeGroupMemberships`: this function writes only rows a group granted.
      const where = and(eq(projectMembers.userId, row.userId), eq(projectMembers.projectId, row.projectId), eq(projectMembers.origin, 'oidc_group'));
      if (left.length === 0) {
        await tx.delete(projectMembers).where(where);
        result.membershipsRemoved += 1;
        continue;
      }
      // Only the groups that still have a mapping stay on the row: one the row listed and nothing maps
      // any more would be a group that grants nothing.
      const stillMapped = [...new Set(left.map((candidate) => candidate.groupName))].sort();
      const role = left.map((candidate) => candidate.role).reduce(higherRole);
      await tx.update(projectMembers).set({ role, oidcGroups: stillMapped }).where(where);
      result.membershipsUpdated += 1;
    }
    return result;
  });
}
