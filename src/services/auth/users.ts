import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { projectMembers, userFederatedIdentities, users, type UserRole, type UserRow } from '../../db/schema.js';
import { PromotionRefusedError } from '../errors.js';
import { ConflictError, NotFoundError, ValidationError } from '../projects.js';
import { hashPassword } from '../passwords.js';

/** Usernames are typed at a sign-in prompt and shown in URLs of nothing, but keep them boring. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

/** Everything the API is allowed to say about an account. The password hash never leaves here. */
export interface UserView {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  projectCount: number;
}

export function toUserView(row: UserRow, projectCount = 0): UserView {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    projectCount,
  };
}

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return Number(row?.n ?? 0);
}

export async function getUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function getUserByUsername(db: Db, username: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.username, normalizeUsername(username)))
    .limit(1);
  return row;
}

export async function listUsers(db: Db): Promise<UserView[]> {
  const rows = await db.select().from(users).orderBy(asc(users.username));
  const counts = await db.select({ userId: projectMembers.userId, n: count() }).from(projectMembers).groupBy(projectMembers.userId);
  const byUser = new Map(counts.map((c) => [c.userId, Number(c.n)]));
  return rows.map((r) => toUserView(r, byUser.get(r.id) ?? 0));
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  displayName?: string;
  email?: string | null;
  mustChangePassword?: boolean;
  createdBy?: string | null;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<UserRow> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username)) {
    throw new ValidationError('Username must be 2-63 characters of lowercase letters, digits, ".", "-" or "_", and start with a letter or digit');
  }
  try {
    const [row] = await db
      .insert(users)
      .values({
        username,
        email: input.email?.trim() || null,
        displayName: input.displayName?.trim() ?? '',
        role: input.role,
        passwordHash: await hashPassword(input.password),
        mustChangePassword: input.mustChangePassword ?? false,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A user named "${username}" already exists`);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/**
 * The one invariant that keeps an instance reachable: there is always at least one root account
 * that can sign in. Counted and mutated inside the same transaction, with the surviving rows
 * locked, so two administrators cannot each remove "the other" root at the same moment.
 */
async function withLastRootGuard<T>(db: Db, targetId: string, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE role = 'root' AND is_active = true FOR UPDATE`);
    const [row] = await tx
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'root'), eq(users.isActive, true), ne(users.id, targetId)));
    if (Number(row?.n ?? 0) === 0) {
      throw new ConflictError('The last active root account cannot be removed, demoted or disabled');
    }
    return run(tx as unknown as Db);
  });
}

/**
 * Serializes every write that can race a promotion to root against this exact account
 * ([T6-MAJOR-1]/[T6-MINOR-1], tur 6 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)): an SSO login
 * callback writing a session, `DELETE /api/auth/oidc/link` revoking sessions and tokens, `updateUser`
 * granting root, and the SSO link callback inserting the identity row each read one fact about this
 * account — still linked? still root? — and then act on it, sometimes a network round trip to the
 * identity provider later. Without a shared lock, two of them can each read the "before" state and
 * both go ahead, which is exactly how a session survived an unlink in the tur 6 review's uninstrumented
 * run and, chained with a promotion, ended up holding root.
 *
 * `FOR UPDATE` on the account's own row closes that gap: whichever caller gets here first holds the
 * row until its transaction commits or rolls back, and every other caller queued behind it sees that
 * result rather than the stale state it started with. This locks a different, narrower set of rows
 * than `withLastRootGuard` above (one account vs. every active root, for a different invariant), so
 * nesting a `withLastRootGuard(tx, ...)` call inside this one's `run` is intentional and safe: calling
 * `db.transaction()` on an already-open drizzle transaction issues a `SAVEPOINT`, not a fresh
 * transaction (`node-postgres/session.cjs`), so it neither escapes this lock nor deadlocks against it.
 *
 * Every write inside `run` must go through the `tx` handle it is given, never the outer `db` closed
 * over from the caller ([L-h], tur 7 review of [T7-MAJOR-1]): `db` opens its own connection and its
 * own transaction, which then blocks on the very row `FOR UPDATE` above already holds open on *this*
 * connection — the request deadlocks against its own lock and only returns once Postgres's
 * `statement_timeout` or the caller gives up. There is nothing that catches this at the type level;
 * it is a convention, and the only guard against it is this comment and review.
 */
export async function withUserRowLock<T>(db: Db, userId: string, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
    return run(tx as unknown as Db);
  });
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

export async function updateUser(db: Db, id: string, input: UpdateUserInput, hooks?: { onBeforeLock?: () => Promise<void> }): Promise<UserRow> {
  const before = await getUserById(db, id);
  if (!before) throw new NotFoundError('User not found');

  const patch: Partial<UserRow> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName.trim();
  if (input.email !== undefined) patch.email = input.email?.trim() || null;
  if (input.role !== undefined) patch.role = input.role;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (Object.keys(patch).length === 0) return before;

  const apply = async (tx: Db): Promise<UserRow> => {
    const [row] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
    // An account that is no longer a member cannot keep a membership row, and a disabled or
    // demoted one must not keep browsing on a session it opened before the change.
    if (patch.role !== undefined && patch.role !== 'member') await tx.delete(projectMembers).where(eq(projectMembers.userId, id));
    return row;
  };

  // Root must stay a local account regardless of which route or process changes a role
  // ([ADR-0077], tur 6 addendum): an SSO identity is proof someone outside this database can already
  // act as this user, and root is exactly the one role that must never depend on that. `updateUser`
  // is the only place a role ever changes after creation (a fresh account cannot have linked an
  // identity yet, since linking is a self-service step taken after sign-in), so this is the only
  // place this needs checking, and every role-changing route goes through it.
  //
  // `promotesToRoot`/`losesRoot` are computed from a fresh read taken *inside* `withUserRowLock`, not
  // from `before` above ([T7-MINOR-2], tur 10 fix): `before` is only a pre-lock existence check and the
  // source for the empty-patch shortcut, both of which are safe to take unlocked because neither one
  // decides anything a concurrent writer could invalidate. Deciding `promotesToRoot`/`losesRoot` from
  // `before` instead let a PATCH that only looked like a no-op role change (the client always resends
  // the current `role`, [public/users.js]) skip the identity check entirely whenever the account was
  // already root at the time `before` was read, even if it had actually been demoted and relinked to
  // an SSO identity in the race window since — the exact race the row lock exists to close, just moved
  // one read earlier than the lock could see it. Computing both flags from a read taken under the lock
  // means an SSO login or link callback racing this promotion serializes against it right here
  // ([T6-MAJOR-1]/[T6-MINOR-1], tur 6 review; [T7-MINOR-2], tur 10 review), so whichever of them commits
  // first is what this sees, and a callback that started before this lock but has not yet committed
  // simply waits for it.
  await hooks?.onBeforeLock?.();
  return withUserRowLock(db, id, async (tx) => {
    const fresh = await getUserById(tx, id);
    if (!fresh) throw new NotFoundError('User not found');
    const promotesToRoot = fresh.role !== 'root' && input.role === 'root';
    const losesRoot = fresh.role === 'root' && ((input.role !== undefined && input.role !== 'root') || input.isActive === false);
    if (promotesToRoot) {
      const [identity] = await tx
        .select({ id: userFederatedIdentities.id })
        .from(userFederatedIdentities)
        .where(eq(userFederatedIdentities.userId, id))
        .limit(1);
      if (identity) {
        throw new PromotionRefusedError('root_requires_unlink', 'This account has a linked SSO identity; unlink it before granting the root role');
      }
    }
    return losesRoot ? withLastRootGuard(tx, id, apply) : apply(tx);
  });
}

export async function setPassword(db: Db, id: string, plain: string, mustChange: boolean): Promise<void> {
  const result = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(plain),
      mustChangePassword: mustChange,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  if (result.length === 0) throw new NotFoundError('User not found');
}

export async function deleteUser(db: Db, id: string): Promise<UserRow> {
  const row = await getUserById(db, id);
  if (!row) throw new NotFoundError('User not found');
  const run = async (tx: Db) => {
    await tx.delete(users).where(eq(users.id, id));
    return row;
  };
  return row.role === 'root' ? withLastRootGuard(db, id, run) : run(db);
}

// ---------- sign-in bookkeeping ----------

/** Seconds left on the lock, or 0. */
export function lockRemainingSec(row: UserRow, now = Date.now()): number {
  if (!row.lockedUntil) return 0;
  const left = row.lockedUntil.getTime() - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Backs off by doubling once the threshold is passed, capped at an hour — long enough to make
 * guessing pointless, short enough that a colleague who fat-fingered it is not locked out for the day.
 */
export function lockDurationMs(failedCount: number, maxAttempts: number, windowMin: number): number {
  const over = failedCount - maxAttempts;
  if (over < 0) return 0;
  return Math.min(windowMin * 60_000 * 2 ** over, 60 * 60_000);
}

export async function recordLoginFailure(db: Db, row: UserRow, maxAttempts: number, windowMin: number): Promise<void> {
  const failed = row.failedLoginCount + 1;
  const lockMs = lockDurationMs(failed, maxAttempts, windowMin);
  await db
    .update(users)
    .set({ failedLoginCount: failed, lockedUntil: lockMs > 0 ? new Date(Date.now() + lockMs) : row.lockedUntil })
    .where(eq(users.id, row.id));
}

export async function recordLoginSuccess(db: Db, id: string, rehashed?: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), ...(rehashed ? { passwordHash: rehashed } : {}) })
    .where(eq(users.id, id));
}
