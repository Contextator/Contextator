import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { userSessions, users, type SessionAuthMethod, type UserRole } from '../../db/schema.js';
import type { Logger } from '../../context.js';

/**
 * A sign-in is a row, not a signed blob: the cookie holds a 256-bit random token and the database
 * holds only its sha256. That is what makes "sign out everywhere" and "disable this account now"
 * actually take effect, and why a leaked backup of the table cannot be replayed.
 */

const TOKEN_PREFIX = 'ctxs_'; // greppable by secret scanners

export const hashSessionToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

export const newSessionToken = (): string => TOKEN_PREFIX + randomBytes(32).toString('hex');

export interface SessionUser {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
  /** How this session was opened — read alongside the role on every request ([ADR-0077]). */
  authMethod: SessionAuthMethod;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export async function createSession(
  db: Db,
  userId: string,
  ttlDays: number,
  meta: SessionMeta,
  authMethod: SessionAuthMethod = 'password',
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  // The id comes back so that the caller can name the session it just opened without reading the row
  // again — `signIn` builds the request's `Principal` from it ([ADR-0055](../../../.ssot/ADR.md#adr-0055)).
  const [row] = await db
    .insert(userSessions)
    .values({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      userAgent: (meta.userAgent ?? '').slice(0, 200),
      ip: meta.ip ?? null,
      authMethod,
    })
    .returning({ id: userSessions.id });
  return { token, expiresAt, sessionId: row.id };
}

/**
 * Resolves the cookie to an account, or null. Both deadlines are compared in SQL against `now()`
 * so a clock skew between the app and the database cannot extend or shorten a session. The role
 * is read here on every request rather than frozen into the session, so a demotion takes effect
 * immediately instead of waiting for the next sign-in.
 */
export async function findSessionUser(db: Db, rawToken: string, idleMs: number): Promise<SessionUser | null> {
  const idleSec = Math.floor(idleMs / 1000);
  const rows = await db
    .select({
      sessionId: userSessions.id,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      authMethod: userSessions.authMethod,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.tokenHash, hashSessionToken(rawToken)),
        isNull(userSessions.revokedAt),
        sql`${userSessions.expiresAt} > now()`,
        sql`${userSessions.lastSeenAt} > now() - make_interval(secs => ${idleSec})`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return null;
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    authMethod: row.authMethod,
  };
}

/**
 * Whether a session row is still live — `revoked_at IS NULL` — read fresh rather than trusting the
 * request's `Principal`, which was built once at cookie resolution and does not see a revocation that
 * lands afterwards. Meant to be called with a `tx` inside `withUserRowLock` ([T7-MAJOR-1], tur 8 fix):
 * a session valid when the request started can be revoked — by an unlink, a sign-out-everywhere, a
 * disable — while this request is still queued behind the row lock, and re-checking under that same
 * lock is what stops a write from finishing on a session that had already lost the race.
 */
export async function isSessionLive(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The dashboard polls every two seconds; writing `last_seen_at` on every request would be a write
 * per poll per open tab. One minute of granularity is plenty for a 12-hour idle window.
 */
export async function touchSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(userSessions.id, sessionId), sql`${userSessions.lastSeenAt} < now() - interval '60 seconds'`));
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, sessionId));
}

/** Used by password changes, admin resets, deactivation and "sign out everywhere". */
export async function revokeSessionsOfUser(db: Db, userId: string, exceptSessionId?: string): Promise<void> {
  const clause = exceptSessionId
    ? and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), sql`${userSessions.id} <> ${exceptSessionId}`)
    : and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt));
  await db.update(userSessions).set({ revokedAt: new Date() }).where(clause);
}

export interface SessionView {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent: string;
  ip: string | null;
  current: boolean;
}

export async function listSessionsOfUser(db: Db, userId: string, currentSessionId: string, idleMs: number): Promise<SessionView[]> {
  const idleSec = Math.floor(idleMs / 1000);
  const rows = await db
    .select()
    .from(userSessions)
    .where(
      and(
        eq(userSessions.userId, userId),
        isNull(userSessions.revokedAt),
        sql`${userSessions.expiresAt} > now()`,
        sql`${userSessions.lastSeenAt} > now() - make_interval(secs => ${idleSec})`,
      ),
    );
  return rows
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      userAgent: r.userAgent,
      ip: r.ip,
      current: r.id === currentSessionId,
    }))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

export async function countActiveSessions(db: Db, userId: string, idleMs: number): Promise<number> {
  return (await listSessionsOfUser(db, userId, '', idleMs)).length;
}

/** Deletes rows nothing can use any more. Mirrors SessionRegistry.startReaper in src/mcp/sessions.ts. */
export function startSessionReaper(db: Db, log: Logger, idleMs: number, intervalMs = 15 * 60_000, onSweep?: () => void): () => void {
  const idleSec = Math.floor(idleMs / 1000);
  const timer = setInterval(() => {
    void db
      .delete(userSessions)
      .where(
        or(
          sql`${userSessions.expiresAt} < now()`,
          sql`${userSessions.lastSeenAt} < now() - make_interval(secs => ${idleSec})`,
          and(sql`${userSessions.revokedAt} is not null`, lt(userSessions.revokedAt, new Date(Date.now() - 24 * 60 * 60_000))),
        ),
      )
      .catch((err: unknown) => log.warn({ err }, 'session sweep failed'));
    onSweep?.();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
