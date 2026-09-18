import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { generateTempPassword, hashPassword } from '../src/services/passwords.js';
import { revokeSessionsOfUser } from '../src/services/auth/sessions.js';
import { normalizeUsername } from '../src/services/auth/users.js';

/**
 * Last resort when nobody can sign in any more: `npm run reset-password -- <username>`.
 *
 * It talks to the database directly, so it needs no session and no ADMIN_TOKEN — which is exactly
 * why it is a shell command on the server rather than an endpoint. The new password is printed
 * once, the account is marked as needing a change, and every session it had is revoked.
 */
async function main(): Promise<void> {
  const username = normalizeUsername(process.argv[2] ?? '');
  if (!username) {
    console.error('Usage: npm run reset-password -- <username>');
    process.exit(2);
  }

  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) {
      console.error(`No account named "${username}".`);
      const all = await db.select({ username: users.username, role: users.role, isActive: users.isActive }).from(users);
      if (all.length === 0) console.error('This instance has no accounts at all — restart the server and open /setup.');
      else console.error('Known accounts: ' + all.map((u) => `${u.username} (${u.role}${u.isActive ? '' : ', disabled'})`).join(', '));
      process.exit(1);
    }

    const password = generateTempPassword();
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        isActive: true, // a locked-out operator resetting their own password expects to get back in
        failedLoginCount: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    await revokeSessionsOfUser(db, user.id);

    console.log('');
    console.log(`  Account:   ${user.username} (${user.role})`);
    console.log(`  Password:  ${password}`);
    console.log('');
    console.log('  Shown once. Sign in with it; the dashboard will ask for a new one straight away.');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
