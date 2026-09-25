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

/**
 * What `users.password_hash` holds for an account that has **no local password** — one minted by SSO
 * auto-provisioning ([ADR-0081](../../.ssot/ADR.md#adr-0081) §2, FR-602). It is not in the
 * `VERSION.N.R.P.salt.hash` wire format, so `verifyPassword` can never match it; an account has a local
 * password exactly when its hash is anything else. An admin setting a password replaces it.
 */
export const SSO_ONLY_PASSWORD_HASH = '!sso-only';

export async function createUser(db: Db, input: CreateUserInput): Promise<UserRow> {
  return insertUser(db, input, await hashPassword(input.password));
}

/** Creates an account that has no local password (`SSO_ONLY_PASSWORD_HASH`) — auto-provisioning only. */
export async function createSsoOnlyUser(db: Db, input: Omit<CreateUserInput, 'password'>): Promise<UserRow> {
  return insertUser(db, input, SSO_ONLY_PASSWORD_HASH);
}

async function insertUser(db: Db, input: Omit<CreateUserInput, 'password'>, passwordHash: string): Promise<UserRow> {
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
        passwordHash,
        mustChangePassword: input.mustChangePassword ?? false,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row;
  } catch (err) {
    if (uniqueViolationConstraint(err) !== undefined) throw new ConflictError(`A user named "${username}" already exists`);
    throw err;
  }
}

/**
 * The name of the unique constraint a Postgres `23505` error violated (`''` when the driver did not
 * say which), or `undefined` when `err` is not a unique violation at all. Drizzle wraps the driver's
 * error in its own, so this looks at `err` and at `err.cause`.
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  for (const e of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (typeof e !== 'object' || e === null) continue;
    const pg = e as { code?: string; constraint?: string };
    if (pg.code === '23505') return pg.constraint ?? '';
  }
  return undefined;
}

/**
 * **Lock order — the one rule every writer in this file follows** ([T7-MINOR-1], Faz 15b): the
 * active-root set first, in `id` order, and only then the single account row `withUserRowLock` takes.
 * A caller never asks for the root set while it already holds an account row lock.
 *
 * Both locks are plain `FOR UPDATE` row locks on `users`, so the rule is about *which rows a
 * transaction may still wait for once it holds some*. A transaction that holds one account row and
 * then asks for every active root can wait on a second demotion that holds *its* account row and asks
 * for the same set — Postgres aborts one with `40P01` and the caller used to get a `500`. Taking the
 * root set first (sorted, so two root-set takers queue on the same first row) and the account row
 * second leaves no cycle: a root-set holder waits only for single-row holders, and a single-row holder
 * (an SSO callback, an unlink, a token mint, a promotion) never waits for another user row at all.
 *
 * Callers that may *remove* a root — a demotion, a disable, a delete — cannot know that until the
 * fresh read under the row lock, so they take the root set whenever the request *could* remove one,
 * and decide under both locks whether it does. That costs a demotion of an ordinary account a lock on
 * the handful of root rows; it is the price of never taking that lock second.
 */
async function lockActiveRoots(tx: Db): Promise<void> {
  await tx.execute(sql`SELECT id FROM users WHERE role = 'root' AND is_active = true ORDER BY id FOR UPDATE`);
}

/**
 * The one invariant that keeps an instance reachable: there is always at least one root account
 * that can sign in. Must run inside a transaction that already holds `lockActiveRoots` — the count is
 * only worth anything while no other remover can change the set under it, so two administrators cannot
 * each remove "the other" root at the same moment.
 */
async function assertAnotherActiveRoot(tx: Db, targetId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, 'root'), eq(users.isActive, true), ne(users.id, targetId)));
  if (Number(row?.n ?? 0) === 0) {
    throw new ConflictError('The last active root account cannot be removed, demoted or disabled');
  }
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
 * result rather than the stale state it started with. Called on an already-open transaction it issues
 * a `SAVEPOINT` rather than a fresh transaction (`node-postgres/session.cjs`), so the lock is taken on
 * — and held until the end of — the caller's transaction.
 *
 * **Lock order.** This is the *second* lock in `lockActiveRoots`'s rule: a caller that also needs the
 * active-root set takes it before calling this, never inside `run`. Asking for the root set while this
 * row is held is the order that let two concurrent root demotions deadlock ([T7-MINOR-1]).
 *
 * Every write inside `run` must go through the `tx` handle it is given, never the outer `db` closed
 * over from the caller ([L-h], tur 7 review of [T7-MAJOR-1]): `db` opens its own connection and its
 * own transaction, which then waits for the very row `FOR UPDATE` above already holds on *this*
 * connection. Postgres cannot see that wait — one side of it is this process, not a lock — so it is
 * never reported as a deadlock: the request hangs until the pool or the client gives up (`src` sets no
 * `statement_timeout`). Nothing catches this at the type level; it is a convention, and the only guard
 * against it is this comment and review.
 */
export async function withUserRowLock<T>(db: Db, userId: string, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
    return run(tx as unknown as Db);
  });
}

/**
 * Takes the account row `FOR SHARE` inside the caller's transaction and holds it until that
 * transaction ends ([F06-MINOR-1], faz 06 review of [ADR-0090](../../../.ssot/ADR.md#adr-0090)).
 *
 * This is the reader's half of `withUserRowLock`: a `FOR SHARE` does not conflict with another
 * `FOR SHARE`, so any number of these run side by side, but it does conflict with the `FOR UPDATE`
 * every per-account revoke takes (`withUserRowLock`, and `revokeMcpCredentialsOfUser` through it).
 * A refresh-token rotation takes it before it claims and mints, which puts the two in one order: a
 * revoke that got the row first has committed before the rotation's claim runs, so the claim finds
 * its refresh token revoked; a rotation that got the row first has committed its new pair before the
 * revoke's `UPDATE` takes its snapshot, so the pair is in what comes down. Without it a revoke landing
 * between the claim and the insert fails one of two ways: a bare `UPDATE` waits on the claimed refresh
 * row, re-checks only that row once the rotation commits, and never sees the pair inserted beside it;
 * one holding the account row `FOR UPDATE` deadlocks against that insert, whose `user_id` foreign key
 * asks the same row for `FOR KEY SHARE`.
 *
 * Same rule as `withUserRowLock` about the handle: `tx` must be the transaction the rest of the work
 * runs in, or the lock guards nothing.
 */
export async function shareUserRowLock(tx: Db, userId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR SHARE`);
}

/**
 * `shareUserRowLock`, returning the row: what `POST /oauth/token` re-checks before it turns an
 * authorization code into a pair. Same lock, same rule about `tx`, and the same ordering against
 * `revokeMcpCredentialsOfUser` — the stamp it writes is either committed before this reads it or
 * written after this transaction has committed the pair it minted, which the revoke then takes down.
 */
export async function shareUserRowForGrant(tx: Db, userId: string) {
  const [row] = await tx
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      mcpCredentialsRevokedAt: users.mcpCredentialsRevokedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('share');
  return row;
}

/**
 * Instrumentation for deterministic integration tests only — no route or process passes anything but
 * `onBeforeLock` (and that only from `ctx.testHooks`). `onRowLocked` is awaited right after the
 * account row lock is held, the window a second remover needs to be in for the lock order to matter.
 */
export interface UserWriteHooks {
  onBeforeLock?: () => Promise<void>;
  onRowLocked?: () => Promise<void>;
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

export async function updateUser(db: Db, id: string, input: UpdateUserInput, hooks?: UserWriteHooks): Promise<UserRow> {
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
  //
  // `mayLoseRoot` is known from the request alone, before any read: whether the target *is* root is
  // only decided under the row lock, but the active-root set has to be locked before that row
  // (`lockActiveRoots`'s order rule, [T7-MINOR-1]), so every request that could remove a root takes it.
  const mayLoseRoot = (input.role !== undefined && input.role !== 'root') || input.isActive === false;
  await hooks?.onBeforeLock?.();
  const underRowLock = (outer: Db): Promise<UserRow> =>
    withUserRowLock(outer, id, async (tx) => {
      await hooks?.onRowLocked?.();
      const fresh = await getUserById(tx, id);
      if (!fresh) throw new NotFoundError('User not found');
      const promotesToRoot = fresh.role !== 'root' && input.role === 'root';
      const losesRoot = fresh.role === 'root' && mayLoseRoot;
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
      if (losesRoot) await assertAnotherActiveRoot(tx, id);
      return apply(tx);
    });
  if (!mayLoseRoot) return underRowLock(db);
  return db.transaction(async (tx) => {
    await lockActiveRoots(tx as unknown as Db);
    return underRowLock(tx as unknown as Db);
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

/**
 * Takes the same two locks as a demotion, in the same order (`lockActiveRoots`, then the account row),
 * and decides from a read taken under both whether this is a root the instance cannot lose.
 */
export async function deleteUser(db: Db, id: string, hooks?: Pick<UserWriteHooks, 'onRowLocked'>): Promise<UserRow> {
  return db.transaction(async (outer) => {
    await lockActiveRoots(outer as unknown as Db);
    return withUserRowLock(outer as unknown as Db, id, async (tx) => {
      await hooks?.onRowLocked?.();
      const row = await getUserById(tx, id);
      if (!row) throw new NotFoundError('User not found');
      if (row.role === 'root' && row.isActive) await assertAnotherActiveRoot(tx, id);
      await tx.delete(users).where(eq(users.id, id));
      return row;
    });
  });
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
