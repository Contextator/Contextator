import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
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

/** Marks one row revoked by id, with no project scope. Used by the refresh rotation. */
export async function revokeMcpTokenById(db: Db, tokenId: string): Promise<void> {
  await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), isNull(mcpTokens.revokedAt)));
}

/**
 * Revokes the OAuth credential a client presents at `/oauth/revoke` (RFC 7009), found by its hash
 * across every project — the caller has no way to say which project it is for, and does not need to,
 * because the hash is unique and names exactly one row.
 *
 * **A `static` token is deliberately not revocable this way.** It belongs to the operator who minted
 * it, and whoever merely *holds* it must not be able to cut off every other client configured with it;
 * the dashboard is where that decision is made. Answering `200` regardless is RFC 7009 §2.2 and is
 * what keeps this endpoint from being an oracle for guessing tokens.
 */
export async function revokeMcpCredentialByToken(db: Db, raw: string): Promise<boolean> {
  if (!raw.startsWith(PREFIXES.access) && !raw.startsWith(PREFIXES.refresh)) return false;
  const revoked = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.tokenHash, hashMcpToken(raw)), sql`${mcpTokens.kind} <> 'static'`, isNull(mcpTokens.revokedAt)))
    .returning({ id: mcpTokens.id });
  return revoked.length > 0;
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
 * The other half of the same lookup, for the token endpoint: a `refresh` credential and nothing else.
 * It is a separate function rather than a flag because the two callers must not be able to drift into
 * accepting each other's credential.
 */
export async function verifyRefreshToken(db: Db, raw: string): Promise<{ id: string; projectId: string; userId: string; clientId: string } | null> {
  if (!raw.startsWith(PREFIXES.refresh)) return null;
  const rows = await db
    .select({ id: mcpTokens.id, projectId: mcpTokens.projectId, userId: mcpTokens.userId, clientId: mcpTokens.clientId })
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.tokenHash, hashMcpToken(raw)),
        eq(mcpTokens.kind, 'refresh'),
        isNull(mcpTokens.revokedAt),
        or(isNull(mcpTokens.expiresAt), sql`${mcpTokens.expiresAt} > now()`),
      ),
    )
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
