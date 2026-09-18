import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { resetPassword } from '../../scripts/reset-password.js';
import { ensureSchema } from '../../src/db/ensure-schema.js';
import { userSessions, users, type UserRow } from '../../src/db/schema.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { createUser } from '../../src/services/auth/users.js';
import { verifyPassword } from '../../src/services/passwords.js';
import { createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The recovery tool (ADR-0032). It is the one thing in the product that is only ever run on the worst
 * day of an instance's life, which is the worst possible moment to find out it does not work — and
 * every assertion below is about rows, so none of them can be made without a database.
 */

const baseUrl = inject('postgresBaseUrl');

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'reset_password');
  await ensureSchema(database.db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

/** Disabled, locked out, owing nothing, and holding two live sessions: the state to be rescued from. */
async function lockedOutRoot(username: string): Promise<UserRow> {
  const { db } = database;
  const user = await createUser(db, { username, role: 'root', password: 'the-forgotten-one-9!' });
  await createSession(db, user.id, 7, { userAgent: 'laptop' });
  await createSession(db, user.id, 7, { userAgent: 'phone' });
  await db
    .update(users)
    .set({ isActive: false, failedLoginCount: 11, lockedUntil: new Date(Date.now() + 60 * 60 * 1000) })
    .where(eq(users.id, user.id));
  const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return row;
}

describe('the last-resort password reset', () => {
  it('lets a disabled, locked-out account back in and closes every session it had', async () => {
    const { db } = database;
    const before = await lockedOutRoot('locked');
    expect(before.isActive).toBe(false);
    expect(await db.select().from(userSessions).where(eq(userSessions.userId, before.id))).toHaveLength(2);

    const result = await resetPassword(db, 'locked');
    if (!result.ok) throw new Error('the account exists; the reset should have found it');
    expect(result).toMatchObject({ username: 'locked', role: 'root' });
    expect(result.password.length).toBeGreaterThanOrEqual(16);

    const [after] = await db.select().from(users).where(eq(users.id, before.id)).limit(1);
    // The printed password is the one that now signs in, and the old one no longer does.
    expect(await verifyPassword(result.password, after.passwordHash)).toBe(true);
    expect(await verifyPassword('the-forgotten-one-9!', after.passwordHash)).toBe(false);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(true);
    expect(after.isActive).toBe(true);
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());

    const sessions = await db.select().from(userSessions).where(eq(userSessions.userId, before.id));
    expect(sessions).toHaveLength(2);
    // Revoked rather than deleted: the cookie a browser still holds stops working on its next request.
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('takes the username as typed, since it is typed under duress', async () => {
    const { db } = database;
    const user = await createUser(db, { username: 'shouty', role: 'admin', password: 'whatever-it-was-1!' });

    const result = await resetPassword(db, '  SHOUTY  ');
    if (!result.ok) throw new Error('normalisation should have found the account');
    expect(result.username).toBe('shouty');

    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(await verifyPassword(result.password, after.passwordHash)).toBe(true);
  });

  it('changes nothing and lists the accounts that do exist when the name is wrong', async () => {
    const { db } = database;
    const before = await db.select().from(users);
    expect(before.length).toBeGreaterThan(0);

    const result = await resetPassword(db, 'nobody-by-that-name');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.accounts.map((a) => a.username).sort()).toEqual(before.map((u) => u.username).sort());
    expect(result.accounts.some((a) => a.role === 'root')).toBe(true);

    const after = await db.select().from(users);
    expect(after.map((u) => u.passwordHash).sort()).toEqual(before.map((u) => u.passwordHash).sort());
  });
});
