import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, lt, not, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mcpTokens, projects, type McpAuthMode, type McpTokenKind, type McpTokenRow } from '../../db/schema.js';
import { NotFoundError } from '../projects.js';

/**
 * Bearer credentials for one project's MCP endpoint.
 *
 * Same shape as a dashboard session: 256 bits of randomness in the client's hands, only a sha256 in
 * the database. A token is therefore unrecoverable — it is shown once, at the moment it is minted,
 * and a lost one is replaced rather than looked up.
 *
 * Since [ADR-0054](../../../.ssot/ADR.md#adr-0054) three kinds of credential live here. `static` is
 * the `ctxm_…` an operator mints in the dashboard and pastes into a CLI client; `access` and
 * `refresh` are the pair an OAuth exchange issues, and those carry a `userId`, a `clientId` and an
 * expiry. Everything below that does not say otherwise is about all three.
 */

/** One prefix per kind, so a secret scanner, a log filter and a reviewer can all tell them apart. */
const PREFIXES: Record<McpTokenKind, string> = { static: 'ctxm_', access: 'ctxa_', refresh: 'ctxr_' };
const PREFIX_SHOWN = 8; // characters of the token kept in the clear so a list can tell two apart

export const hashMcpToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

export const newMcpToken = (kind: McpTokenKind = 'static'): string => PREFIXES[kind] + randomBytes(32).toString('hex');

/** `ctxm_9f3a…` — enough to recognise, not enough to use. */
const displayPrefix = (token: string): string => `${token.slice(0, token.indexOf('_') + 1 + PREFIX_SHOWN)}…`;

/** Whether a presented string is shaped like one of ours at all, before a hash is computed of it. */
const looksLikeOneOfOurs = (raw: string): boolean => Object.values(PREFIXES).some((p) => raw.startsWith(p));

export interface McpTokenView {
  id: string;
  name: string;
  /** `ctxm_9f3a…` — enough to recognise, not enough to use. */
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export const toMcpTokenView = (row: McpTokenRow): McpTokenView => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

/**
 * The project's **static** tokens — what the dashboard's MCP access panel lists and what an operator
 * revokes one of. OAuth credentials are deliberately not in it: they are not something anybody minted
 * for a purpose they can name, they expire on their own, and a list mixing a year-old `ctxm_` with a
 * ten-minute `ctxa_` would make the one button on that panel mean two different things.
 */
export async function listMcpTokens(db: Db, projectId: string): Promise<McpTokenView[]> {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.projectId, projectId), eq(mcpTokens.kind, 'static'), isNull(mcpTokens.revokedAt)))
    .orderBy(asc(mcpTokens.createdAt));
  return rows.map(toMcpTokenView);
}

export async function createMcpToken(
  db: Db,
  projectId: string,
  name: string,
  createdBy: string | null,
): Promise<{ token: string; view: McpTokenView }> {
  const token = newMcpToken('static');
  const [row] = await db
    .insert(mcpTokens)
    .values({
      projectId,
      name: name.trim(),
      tokenHash: hashMcpToken(token),
      prefix: displayPrefix(token),
      createdBy,
      kind: 'static',
    })
    .returning();
  return { token, view: toMcpTokenView(row) };
}

/**
 * Writes one OAuth credential. Separate from `createMcpToken` because the two have nothing in common
 * beyond the table: this one is issued by a protocol to a client on behalf of an account, carries an
 * expiry, and is never displayed to anybody.
 */
export async function issueMcpCredential(
  db: Db,
  input: { projectId: string; userId: string; clientId: string; kind: 'access' | 'refresh'; name: string; ttlMs: number },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = newMcpToken(input.kind);
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const [row] = await db
    .insert(mcpTokens)
    .values({
      projectId: input.projectId,
      name: input.name.slice(0, 100),
      tokenHash: hashMcpToken(token),
      prefix: displayPrefix(token),
      kind: input.kind,
      userId: input.userId,
      clientId: input.clientId,
      expiresAt,
    })
    .returning({ id: mcpTokens.id });
  return { token, id: row.id, expiresAt };
}

/** Revoked rather than deleted, so "which token was this agent using" survives the revocation. */
export async function revokeMcpToken(db: Db, projectId: string, tokenId: string): Promise<void> {
  const result = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.projectId, projectId), isNull(mcpTokens.revokedAt)))
    .returning({ id: mcpTokens.id });
  if (result.length === 0) throw new NotFoundError('Token not found');
}

/**
 * Marks one row revoked by id, and says whether **this** call is the one that did it.
 *
 * **The boolean is the whole point and is load-bearing** for the refresh rotation
 * ([ADR-0054](../../../.ssot/ADR.md#adr-0054)): `revoked_at IS NULL` is in the `WHERE`, so two
 * concurrent exchanges of the same refresh token race on one row and exactly one of them comes back
 * `true`. The loser learns that the credential it verified a moment ago has already been spent, which
 * is indistinguishable from a stolen copy being redeemed — and is treated as one. A version that threw
 * the row count away issued two valid families and told nobody.
 */
export async function revokeMcpTokenById(db: Db, tokenId: string): Promise<boolean> {
  const revoked = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), isNull(mcpTokens.revokedAt)))
    .returning({ id: mcpTokens.id });
  return revoked.length > 0;
}

/** The three columns that identify one grant: this client, acting as this account, on this project. */
export interface McpGrant {
  clientId: string;
  userId: string;
  projectId: string;
}

/**
 * Revokes **every live OAuth credential of one grant** — the access tokens and the refresh tokens
 * alike ([ADR-0054](../../../.ssot/ADR.md#adr-0054)).
 *
 * It is the unit three different things operate on, and each of them is wrong at any smaller
 * granularity. A client that says *disconnect* (RFC 7009) means the grant and not the one string it
 * happened to hand back, or it holds a refresh token that mints a new pair seconds later. A refresh
 * token presented twice is OAuth 2.1's reuse signal, and §4.3.1's answer is to revoke the descendants
 * rather than the one row. And a person who takes an approval back expects it gone.
 *
 * Static tokens are untouched: they belong to no grant and to no client.
 */
export async function revokeMcpCredentialsOfGrant(db: Db, grant: McpGrant): Promise<number> {
  const revoked = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.clientId, grant.clientId),
        eq(mcpTokens.userId, grant.userId),
        eq(mcpTokens.projectId, grant.projectId),
        isNull(mcpTokens.revokedAt),
      ),
    )
    .returning({ id: mcpTokens.id });
  return revoked.length;
}

/**
 * Revokes every OAuth credential of one account, across every project and every client.
 *
 * **This is what a password change has to reach**, and until it existed it did not: changing a
 * password ends every other *session* of the account (FR-148), which is the whole of what "somebody
 * else knows my password" used to be able to affect. An account-backed MCP credential is that account's
 * access by another door, it lives far longer than a sign-in, and a refresh token renews itself — so a
 * password change that left it running would leave running the one credential of that account the
 * change did not reach, which is exactly the credential somebody with the old password could have taken.
 *
 * `mcp_tokens_user_idx` is the index this reads through, and this is its first caller.
 */
export async function revokeMcpCredentialsOfUser(db: Db, userId: string): Promise<number> {
  const revoked = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.userId, userId), sql`${mcpTokens.kind} <> 'static'`, isNull(mcpTokens.revokedAt)))
    .returning({ id: mcpTokens.id });
  return revoked.length;
}

/**
 * Revokes the **grant** behind the credential a client presents at `/oauth/revoke` (RFC 7009), found
 * by its hash across every project — the caller has no way to say which project it is for, and does
 * not need to, because the hash is unique and names exactly one row.
 *
 * **The grant and not the row**, which is RFC 7009 §2.1: a client handing back an access token means
 * *disconnect*, and revoking only the string it handed over leaves it holding a refresh token that
 * mints a fresh pair seconds later. The credential is found whatever state it is in, so a client that
 * hands back an already-expired token still gets its grant taken down.
 *
 * **A `static` token is deliberately not revocable this way.** It belongs to the operator who minted
 * it, and whoever merely *holds* it must not be able to cut off every other client configured with it;
 * the dashboard is where that decision is made. Answering `200` regardless is RFC 7009 §2.2 and is
 * what keeps this endpoint from being an oracle for guessing tokens.
 */
export async function revokeMcpCredentialByToken(db: Db, raw: string): Promise<number> {
  if (!raw.startsWith(PREFIXES.access) && !raw.startsWith(PREFIXES.refresh)) return 0;
  const [row] = await db
    .select({ clientId: mcpTokens.clientId, userId: mcpTokens.userId, projectId: mcpTokens.projectId })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hashMcpToken(raw)), sql`${mcpTokens.kind} <> 'static'`))
    .limit(1);
  if (!row?.clientId || !row.userId) return 0;
  return revokeMcpCredentialsOfGrant(db, { clientId: row.clientId, userId: row.userId, projectId: row.projectId });
}

/**
 * What a presented credential turned out to be. **The `userId` is the whole point of this shape**
 * ([ADR-0054](../../../.ssot/ADR.md#adr-0054)): the router can no longer decide from a boolean,
 * because a credential that names an account is judged by that account's membership and one that
 * names nobody is judged the way it always was.
 */
export interface McpTokenIdentity {
  id: string;
  kind: McpTokenKind;
  /** The account this credential acts as, or `null` for a static token that acts as nobody. */
  userId: string | null;
}

/**
 * The live credential `raw` names for this project, or `null`. The comparison is a lookup on the
 * hash's unique index rather than a scan, so it stays one indexed read per MCP request.
 *
 * **It returns the row rather than a boolean** since [ADR-0047](../../../.ssot/ADR.md#adr-0047): the
 * query log records which token a search came through, and the verification is the one place in the
 * request that already knows. Since [ADR-0054](../../../.ssot/ADR.md#adr-0054) it also returns the
 * account behind it. `mcpAccessDecision` still takes a *verdict* rather than a row — whether a request
 * is allowed is a different question from which credential allowed it, and only one of the two is a
 * security rule.
 *
 * A `refresh` credential is not accepted here and is not accepted at the MCP endpoint: it is a
 * credential for the token endpoint, and the two must not be interchangeable.
 */
export async function verifyMcpToken(db: Db, projectId: string, raw: string): Promise<McpTokenIdentity | null> {
  if (!looksLikeOneOfOurs(raw)) return null;
  const rows = await db
    .select({ id: mcpTokens.id, kind: mcpTokens.kind, userId: mcpTokens.userId })
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.tokenHash, hashMcpToken(raw)),
        eq(mcpTokens.projectId, projectId),
        isNull(mcpTokens.revokedAt),
        // Both deadlines in SQL against `now()`, like a dashboard session's, so a clock skew between
        // the application and the database cannot extend a credential's life.
        or(isNull(mcpTokens.expiresAt), sql`${mcpTokens.expiresAt} > now()`),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.kind === 'refresh') return null;

  // An agent polls; a write per request would be a write per poll. A minute of granularity is
  // plenty for "when was this token last used", and it stays off the response path.
  void db
    .update(mcpTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(mcpTokens.id, row.id), sql`(${mcpTokens.lastUsedAt} is null or ${mcpTokens.lastUsedAt} < now() - interval '60 seconds')`))
    .catch(() => undefined);
  return row;
}

/**
 * Serialises the exchanges of **one** refresh token ([ADR-0054](../../../.ssot/ADR.md#adr-0054)).
 *
 * The rotation is a read (is this live?), a write (claim it) and two inserts (the new pair), and the
 * row-count gate on the claim is what keeps two concurrent exchanges from both succeeding. It is not
 * enough on its own: the loser revokes the grant as it knew it a moment ago, and the winner can commit
 * its **new** pair after that — so the reuse is detected and the credentials it was supposed to take
 * down outlive the detection. Under this lock the loser cannot read the row until the winner's whole
 * transaction has committed, so what it revokes includes what the winner just minted.
 *
 * Keyed on the token's own hash rather than on the grant, because the token is the contended thing and
 * it is known before any lookup. Two different grants never wait for each other.
 */
const REFRESH_LOCK_CLASS = 7213003; // after the bootstrap's 7213001 and registration's 7213002

export async function withRefreshRotationLock<T>(db: Db, raw: string, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REFRESH_LOCK_CLASS}, hashtext(${hashMcpToken(raw)}))`);
    return run(tx as unknown as Db);
  });
}

/** A refresh credential resolved to its own row and to the grant it belongs to. */
export interface RefreshGrant extends McpGrant {
  id: string;
}

/**
 * The other half of the same lookup, for the token endpoint: a **live** `refresh` credential and
 * nothing else. It is a separate function rather than a flag because the two callers must not be able
 * to drift into accepting each other's credential.
 */
export async function verifyRefreshToken(db: Db, raw: string): Promise<RefreshGrant | null> {
  return findRefreshToken(db, raw, 'live');
}

/**
 * The same row when it is **not** live — already revoked, or expired. This is the reuse signal.
 *
 * OAuth 2.1 §4.3.1 asks an authorization server that rotates refresh tokens to detect one being
 * presented twice and to revoke the descendants of that grant, and this is the lookup that makes the
 * detection possible: a spent refresh token and a refresh token that never existed are the same
 * `invalid_grant` to the client, and two very different events to the server. Without it the theft
 * case runs silently — the thief redeems first, the owner's client redeems next, is told only to
 * re-authorize, does so, and the thief's family lives on beside the new one.
 */
export async function findSpentRefreshToken(db: Db, raw: string): Promise<RefreshGrant | null> {
  return findRefreshToken(db, raw, 'spent');
}

async function findRefreshToken(db: Db, raw: string, state: 'live' | 'spent'): Promise<RefreshGrant | null> {
  if (!raw.startsWith(PREFIXES.refresh)) return null;
  // One predicate, used as itself or negated, so "live" and "spent" cannot drift apart into two
  // definitions that between them accept or reject a row twice.
  const live = sql`(${mcpTokens.revokedAt} is null and (${mcpTokens.expiresAt} is null or ${mcpTokens.expiresAt} > now()))`;
  const rows = await db
    .select({ id: mcpTokens.id, projectId: mcpTokens.projectId, userId: mcpTokens.userId, clientId: mcpTokens.clientId })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hashMcpToken(raw)), eq(mcpTokens.kind, 'refresh'), state === 'live' ? live : not(live)))
    .limit(1);
  const row = rows[0];
  if (!row?.userId || !row.clientId) return null;
  return { id: row.id, projectId: row.projectId, userId: row.userId, clientId: row.clientId };
}

export async function countMcpTokens(db: Db, projectId: string): Promise<number> {
  return (await listMcpTokens(db, projectId)).length;
}

/**
 * Deletes OAuth credentials whose expiry passed more than `graceMs` ago. Rides the timer that already
 * sweeps expired sessions and the query log rather than starting a third one.
 *
 * A grace period rather than `now()`, because `search_queries.mcp_token_id` points here: deleting a
 * row the instant it expires would take the attribution of the searches that session made with it.
 * Static tokens are never swept — they have no expiry, and a revoked one is kept on purpose.
 */
export async function sweepExpiredMcpCredentials(db: Db, graceMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const deleted = await db
    .delete(mcpTokens)
    .where(and(sql`${mcpTokens.kind} <> 'static'`, lt(mcpTokens.expiresAt, cutoff)))
    .returning({ id: mcpTokens.id });
  return deleted.length;
}

export async function setProjectMcpAuth(db: Db, projectId: string, mode: McpAuthMode): Promise<McpAuthMode> {
  const result = await db.update(projects).set({ mcpAuth: mode }).where(eq(projects.id, projectId)).returning({ mcpAuth: projects.mcpAuth });
  if (result.length === 0) throw new NotFoundError('Project not found');
  return result[0].mcpAuth;
}
