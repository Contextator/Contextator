import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { users, type UserRole } from '../src/db/schema.js';
import { generateTempPassword, hashPassword } from '../src/services/passwords.js';
import { revokeSessionsOfUser } from '../src/services/auth/sessions.js';
import { normalizeUsername } from '../src/services/auth/users.js';

/**
 * Last resort when nobody can sign in any more: `npm run reset-password -- <username>`.
 *
 * It talks to the database directly, so it needs no session and no ADMIN_TOKEN — which is exactly
 * why it is a shell command on the server rather than an endpoint. The new password is printed
 * once, the account is marked as needing a change, and every session it had is revoked.
 *
 * It runs inside the shipped container, because that is the only place it can: the container's
 * PostgreSQL listens on its own loopback interface and is published nowhere, so there is nothing
 * for a copy of this tool on the host to connect to. The image therefore carries `scripts/`, `src/`
 * and `tsx` (ADR-0032). The database work is exported on its own, because a recovery path that
 * nothing exercises is a recovery path that has quietly stopped working.
 */

export interface ResetPasswordDone {
  ok: true;
  username: string;
  role: UserRole;
  /** Plaintext, and the only time it exists: the caller prints it or loses it. */
  password: string;
}

export interface ResetPasswordNoSuchUser {
  ok: false;
  username: string;
  /** Everything that does exist, so the operator can see what they meant to type. */
  accounts: Array<{ username: string; role: UserRole; isActive: boolean }>;
}

export type ResetPasswordResult = ResetPasswordDone | ResetPasswordNoSuchUser;

/**
 * Gives one account a fresh temporary password and clears everything that could keep its owner out:
 * the account is re-activated if it was disabled (a locked-out operator resetting their own password
 * expects to get back in), the failed-attempt counter and the lock are zeroed, and every session it
 * holds is revoked.
 */
export async function resetPassword(db: Db, rawUsername: string): Promise<ResetPasswordResult> {
  const username = normalizeUsername(rawUsername);
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) {
    const accounts = await db.select({ username: users.username, role: users.role, isActive: users.isActive }).from(users);
    return { ok: false, username, accounts };
  }

  const password = generateTempPassword();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      passwordChangedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  await revokeSessionsOfUser(db, user.id);

  return { ok: true, username: user.username, role: user.role, password };
}

async function main(): Promise<void> {
  // Imported here rather than at the top: a test that imports `resetPassword` must not have this
  // file rewrite its environment on the way in.
  await import('dotenv/config');
  const username = normalizeUsername(process.argv[2] ?? '');
  if (!username) {
    console.error('Usage: npm run reset-password -- <username>');
    process.exit(2);
  }

  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const result = await resetPassword(db, username);
    if (!result.ok) {
      console.error(`No account named "${result.username}".`);
      if (result.accounts.length === 0) console.error('This instance has no accounts at all — restart the server and open /setup.');
      else console.error('Known accounts: ' + result.accounts.map((u) => `${u.username} (${u.role}${u.isActive ? '' : ', disabled'})`).join(', '));
      process.exit(1);
    }

    console.log('');
    console.log(`  Account:   ${result.username} (${result.role})`);
    console.log(`  Password:  ${result.password}`);
    console.log('');
    console.log('  Shown once. Sign in with it; the dashboard will ask for a new one straight away.');
    console.log('');
  } finally {
    await pool.end();
  }
}

/** Only when this file *is* the command; importing it from a test must not reset anything. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
