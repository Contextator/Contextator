import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { userFederatedIdentities, users, type UserRow } from '../../db/schema.js';
import { ConflictError } from '../projects.js';
import { createUser, normalizeUsername, USERNAME_RE } from './users.js';

export interface FederatedIdentityLookup {
  issuer: string;
  subject: string;
}

/**
 * The provider name(s) currently linked to this account — for `GET /api/auth/me`'s self-service
 * link/unlink panel ([MAJOR-2], tur 3 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)). At most one
 * row in practice today (see `unlinkFederatedIdentity`'s note on the single-provider phase), but this
 * reads every row rather than assuming that, so a later multi-provider instance is not quietly wrong.
 */
export async function listFederatedIdentitiesOfUser(db: Db, userId: string): Promise<{ provider: string }[]> {
  return db.select({ provider: userFederatedIdentities.provider }).from(userFederatedIdentities).where(eq(userFederatedIdentities.userId, userId));
}

/** Finds the local account already linked to this `(issuer, subject)` pair, if any. */
export async function findUserByFederatedIdentity(db: Db, lookup: FederatedIdentityLookup): Promise<UserRow | undefined> {
  const [row] = await db
    .select({ user: users })
    .from(userFederatedIdentities)
    .innerJoin(users, eq(users.id, userFederatedIdentities.userId))
    .where(and(eq(userFederatedIdentities.issuer, lookup.issuer), eq(userFederatedIdentities.subject, lookup.subject)))
    .limit(1);
  return row?.user;
}

export async function touchFederatedIdentityLogin(db: Db, lookup: FederatedIdentityLookup): Promise<void> {
  await db
    .update(userFederatedIdentities)
    .set({ lastLoginAt: new Date() })
    .where(and(eq(userFederatedIdentities.issuer, lookup.issuer), eq(userFederatedIdentities.subject, lookup.subject)));
}

/** Derives a candidate username from whatever the provider handed back, sanitized to `USERNAME_RE`. */
export function deriveUsername(claims: { preferredUsername?: string; email?: string }): string {
  const candidates = [claims.preferredUsername, claims.email?.split('@')[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeUsername(candidate)
      .replace(/[^a-z0-9._-]/g, '-')
      .slice(0, 63);
    if (USERNAME_RE.test(normalized)) return normalized;
  }
  return `sso-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ProvisionFederatedUserInput {
  provider: string;
  issuer: string;
  subject: string;
  role: 'admin' | 'member';
  preferredUsername?: string;
  email?: string;
  displayName?: string;
}

/**
 * Creates a brand-new local account for a federated identity that has never signed in before, and
 * links it via `(issuer, subject)`. Retries the username once with a random suffix on a collision
 * ([ADR-0077](../../.ssot/ADR.md#adr-0077)) — the same pattern `createUser` callers elsewhere in this
 * codebase use for auto-generated names, since two providers (or two humans) can plausibly agree on
 * the same `preferred_username`.
 */
export async function provisionFederatedUser(db: Db, input: ProvisionFederatedUserInput): Promise<UserRow> {
  const baseUsername = deriveUsername({ preferredUsername: input.preferredUsername, email: input.email });
  const attempt = async (username: string): Promise<UserRow> => {
    // The password is a throwaway: a federated account never authenticates with it, but every row in
    // `users` needs a hash, and a random one keeps password sign-in from ever working for this account.
    const throwawayPassword = randomUUID() + randomUUID();
    const user = await createUser(db, {
      username,
      password: throwawayPassword,
      role: input.role,
      displayName: input.displayName ?? username,
      email: input.email ?? null,
      mustChangePassword: false,
    });
    await db.insert(userFederatedIdentities).values({
      userId: user.id,
      provider: input.provider,
      issuer: input.issuer,
      subject: input.subject,
    });
    return user;
  };

  try {
    return await attempt(baseUsername);
  } catch (err) {
    if (err instanceof ConflictError) return attempt(`${baseUsername.slice(0, 55)}-${Math.random().toString(36).slice(2, 8)}`);
    throw err;
  }
}

export interface LinkFederatedIdentityInput {
  userId: string;
  provider: string;
  issuer: string;
  subject: string;
}

/**
 * Attaches an already-signed-in account to a federated identity it just proved ownership of at the
 * provider — the self-service "connect my SSO identity" flow ([MAJOR-1], tur 2 review of
 * [ADR-0077](../../.ssot/ADR.md#adr-0077)). `userId` must come from the caller's own live session,
 * never from anything the flow cookie says, since that cookie is unsigned by design.
 *
 * A no-op when this exact `(issuer, subject)` is already linked to this same account (re-linking is
 * harmless); refuses with `ConflictError` when it is linked to a *different* account — the unique
 * index on `(issuer, subject)` would refuse the insert anyway, but this turns that into a clear error
 * instead of a raw constraint violation surfacing out of the route.
 */
export async function linkFederatedIdentity(db: Db, input: LinkFederatedIdentityInput): Promise<void> {
  const existing = await findUserByFederatedIdentity(db, { issuer: input.issuer, subject: input.subject });
  if (existing) {
    if (existing.id === input.userId) return;
    throw new ConflictError('That SSO identity is already linked to a different account');
  }
  await db.insert(userFederatedIdentities).values({
    userId: input.userId,
    provider: input.provider,
    issuer: input.issuer,
    subject: input.subject,
  });
}

/**
 * Removes every federated identity linked to this account — self-service unlink, the `DELETE` side of
 * [linkFederatedIdentity](#linkfederatedidentity). This phase supports a single configured OIDC
 * provider, so in practice there is at most one row to remove; deleting by `userId` alone rather than
 * by a specific `(issuer, subject)` keeps the API from needing to name one. Returns how many rows were
 * removed, so a caller can tell a real unlink from a no-op.
 */
export async function unlinkFederatedIdentity(db: Db, userId: string): Promise<number> {
  const removed = await db
    .delete(userFederatedIdentities)
    .where(eq(userFederatedIdentities.userId, userId))
    .returning({ id: userFederatedIdentities.id });
  return removed.length;
}
