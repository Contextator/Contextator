import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mcpTokens, projects, type McpAuthMode, type McpTokenRow } from '../../db/schema.js';
import { NotFoundError } from '../projects.js';

/**
 * Bearer tokens for one project's MCP endpoint.
 *
 * Same shape as a dashboard session: 256 bits of randomness in the client's hands, only a sha256 in
 * the database. A token is therefore unrecoverable — it is shown once, at the moment it is minted,
 * and a lost one is replaced rather than looked up.
 */

const TOKEN_PREFIX = 'ctxm_'; // greppable by secret scanners, and tells it apart from a session cookie
const PREFIX_SHOWN = 8; // characters of the token kept in the clear so a list can tell two apart

export const hashMcpToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

export const newMcpToken = (): string => TOKEN_PREFIX + randomBytes(32).toString('hex');

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

export async function listMcpTokens(db: Db, projectId: string): Promise<McpTokenView[]> {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.projectId, projectId), isNull(mcpTokens.revokedAt)))
    .orderBy(asc(mcpTokens.createdAt));
  return rows.map(toMcpTokenView);
}

export async function createMcpToken(db: Db, projectId: string, name: string, createdBy: string | null): Promise<{ token: string; view: McpTokenView }> {
  const token = newMcpToken();
  const [row] = await db
    .insert(mcpTokens)
    .values({
      projectId,
      name: name.trim(),
      tokenHash: hashMcpToken(token),
      prefix: `${token.slice(0, TOKEN_PREFIX.length + PREFIX_SHOWN)}…`,
      createdBy,
    })
    .returning();
  return { token, view: toMcpTokenView(row) };
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
 * True when `raw` is a live token for this project. The comparison is a lookup on the hash's unique
 * index rather than a scan, so it stays one indexed read per MCP request.
 */
export async function verifyMcpToken(db: Db, projectId: string, raw: string): Promise<boolean> {
  if (!raw.startsWith(TOKEN_PREFIX)) return false;
  const rows = await db
    .select({ id: mcpTokens.id })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hashMcpToken(raw)), eq(mcpTokens.projectId, projectId), isNull(mcpTokens.revokedAt)))
    .limit(1);
  if (rows.length === 0) return false;

  // An agent polls; a write per request would be a write per poll. A minute of granularity is
  // plenty for "when was this token last used", and it stays off the response path.
  void db
    .update(mcpTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(mcpTokens.id, rows[0].id), sql`(${mcpTokens.lastUsedAt} is null or ${mcpTokens.lastUsedAt} < now() - interval '60 seconds')`))
    .catch(() => undefined);
  return true;
}

export async function countMcpTokens(db: Db, projectId: string): Promise<number> {
  return (await listMcpTokens(db, projectId)).length;
}

export async function setProjectMcpAuth(db: Db, projectId: string, mode: McpAuthMode): Promise<McpAuthMode> {
  const result = await db.update(projects).set({ mcpAuth: mode }).where(eq(projects.id, projectId)).returning({ mcpAuth: projects.mcpAuth });
  if (result.length === 0) throw new NotFoundError('Project not found');
  return result[0].mcpAuth;
}
