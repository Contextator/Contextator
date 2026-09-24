import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { apiTokens, users, type ApiTokenRow, type UserRole } from '../../db/schema.js';
import { NotFoundError } from '../projects.js';

/**
 * Bearer credentials for the admin API, scoped to one account ([ADR-0076](../../../.ssot/ADR.md#adr-0076)).
 *
 * Same shape as every other bearer credential in this codebase: 256 bits of randomness in the
 * operator's hands, only a sha256 in the database, shown once at mint and never again. Unlike
 * `ADMIN_TOKEN` (root, unnamed, unrevocable on its own) every row here names an account, a purpose
 * and a scope, and can be revoked without touching any other credential.
 */

const PREFIX = 'ctxk_'; // greppable by secret scanners; distinct from ctxs_/ctxm_/ctxc_/ctxo_/ctxa_/ctxr_
const PREFIX_SHOWN = 8; // characters of the token kept in the clear so a list can tell two apart

export const hashApiToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

export const newApiToken = (): string => PREFIX + randomBytes(32).toString('hex');

/** `ctxk_9f3a…` — enough to recognise, not enough to use. */
const displayPrefix = (token: string): string => `${token.slice(0, token.indexOf('_') + 1 + PREFIX_SHOWN)}…`;

/** Whether a presented string is shaped like one of ours at all, before a hash is computed of it. */
const looksLikeOneOfOurs = (raw: string): boolean => raw.startsWith(PREFIX);

export interface ApiTokenView {
  id: string;
  name: string;
  /** `ctxk_9f3a…` — enough to recognise, not enough to use. */
  prefix: string;
  scope: string[];
  projectId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export const toApiTokenView = (row: ApiTokenRow): ApiTokenView => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scope: row.scope,
  projectId: row.projectId,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
});

/** One account's own tokens, live and revoked alike — a revoked row stays so its history is visible. */
export async function listApiTokens(db: Db, userId: string): Promise<ApiTokenView[]> {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(asc(apiTokens.createdAt));
  return rows.map(toApiTokenView);
}

export interface CreateApiTokenInput {
  userId: string;
  name: string;
  /** Route templates from `src/auth/policy.ts`'s own key space, `<METHOD> <url>`. Never widened later. */
  scope: string[];
  /** Restricts the token to one project, or `null` for every project the owner already reaches. */
  projectId: string | null;
  expiresAt: Date | null;
  createdBy: string | null;
}

export async function createApiToken(db: Db, input: CreateApiTokenInput): Promise<{ token: string; view: ApiTokenView }> {
  const token = newApiToken();
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: input.userId,
      name: input.name.trim().slice(0, 100),
      tokenHash: hashApiToken(token),
      prefix: displayPrefix(token),
      scope: input.scope,
      projectId: input.projectId,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    })
    .returning();
  return { token, view: toApiTokenView(row) };
}

/** Revoked rather than deleted, so an audit row about this token keeps naming something. */
export async function revokeApiToken(db: Db, userId: string, tokenId: string): Promise<void> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (result.length === 0) throw new NotFoundError('Token not found');
}

/**
 * Every live token an account holds, revoked in one statement — the `revokeSessionsOfUser` of this
 * table ([ADR-0077], tur 6 addendum). Used when an SSO identity is unlinked: `verifyApiToken` already
 * reads the owner's role fresh on every call, so a token surviving an unlink would silently pick up
 * `root` the moment the account is later promoted, with nothing on the token itself to say it was
 * minted under a since-removed identity. Revoking here forces a fresh mint after such a change.
 */
export async function revokeApiTokensOfUser(db: Db, userId: string): Promise<void> {
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
}

/**
 * What a presented credential turned out to be, joined against the owner's **live** account row —
 * never the values at mint time. A demoted, deactivated or password-reset owner narrows or disables
 * every token they hold on their very next request, with nothing stored on the token itself to go stale.
 */
export interface ApiTokenIdentity {
  tokenId: string;
  userId: string;
  role: UserRole;
  /** `"<token name> · <owner's username>"`, so an audit row names both without a schema change. */
  username: string;
  scope: string[];
  projectId: string | null;
  mustChangePassword: boolean;
}

/**
 * The live token `raw` names, or `null` when it is unrecognised, revoked, expired, or its owner is no
 * longer active. The comparison is a lookup on the hash's unique index, so it stays one indexed read
 * per request.
 */
export async function verifyApiToken(db: Db, raw: string): Promise<ApiTokenIdentity | null> {
  if (!looksLikeOneOfOurs(raw)) return null;
  const rows = await db
    .select({
      tokenId: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      projectId: apiTokens.projectId,
      userId: users.id,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, hashApiToken(raw)),
        isNull(apiTokens.revokedAt),
        // Both deadlines compared in SQL against `now()`, like every other credential here, so a clock
        // skew between the application and the database cannot extend a token's life.
        or(isNull(apiTokens.expiresAt), sql`${apiTokens.expiresAt} > now()`),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return null;

  // Off the response path, and throttled the same as a session touch and an MCP token's: an agent
  // polling this every few seconds must not turn into a write per poll.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiTokens.id, row.tokenId), sql`(${apiTokens.lastUsedAt} is null or ${apiTokens.lastUsedAt} < now() - interval '60 seconds')`))
    .catch(() => undefined);

  return {
    tokenId: row.tokenId,
    userId: row.userId,
    role: row.role,
    username: `${row.name || 'API token'} · ${row.username}`,
    scope: row.scope,
    projectId: row.projectId,
    mustChangePassword: row.mustChangePassword,
  };
}
