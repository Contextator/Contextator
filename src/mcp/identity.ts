import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Principal } from '../auth/types.js';
import { resolveProjectAccess } from '../services/auth/memberships.js';
import { verifyMcpToken } from '../services/auth/mcp-tokens.js';
import type { McpCredential } from './access.js';

/**
 * Turns the `Authorization` header of an MCP request into the thing `mcpAccessDecision` judges
 * ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
 *
 * Every database read the decision needs happens here and nowhere else, which is what keeps the rule
 * itself a pure function with a unit test. There are at most three reads and the common cases are
 * cheaper: no header is none, a static token is one, and only an account-backed credential pays for
 * the account row and the membership.
 *
 * **The account is re-read on every request rather than frozen into the credential**, for the reason
 * `findSessionUser` re-reads a session's role: disabling an account, demoting it, or removing its
 * membership has to take effect on the next request and not at the next sign-in. An OAuth access token
 * lives for an hour; an hour is far too long for "we removed their access" to mean nothing.
 */
export async function resolveMcpCredential(
  db: Db,
  projectId: string,
  bearer: string,
): Promise<{ credential: McpCredential; tokenId: string | null }> {
  if (!bearer) return { credential: { kind: 'anonymous' }, tokenId: null };

  const token = await verifyMcpToken(db, projectId, bearer);
  if (!token) return { credential: { kind: 'unknown' }, tokenId: null };
  if (!token.userId) return { credential: { kind: 'bearer' }, tokenId: token.id };

  const [account] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, token.userId))
    .limit(1);
  // A credential whose account is gone or switched off is not a lesser credential, it is no credential:
  // falling back to `bearer` here would turn "we disabled that person" into "their agent keeps reading".
  //
  // A password reset suspends it too, and that is the same rule the dashboard applies rather than a new
  // one: `mustChangePassword` is set by an administrator who has just handed somebody a temporary
  // password, and an hour-long access token that outlived that moment would be the one credential of
  // that account the reset did not reach.
  if (!account?.isActive || account.mustChangePassword) return { credential: { kind: 'unknown' }, tokenId: token.id };

  const principal: Principal = {
    kind: 'session',
    role: account.role,
    userId: account.id,
    username: account.username,
    // This is not a dashboard session and holds none of a session's rights; the field exists because
    // `Principal` is the shape `resolveProjectAccess` reads, and the id is the credential's own.
    sessionId: token.id,
    mustChangePassword: false,
  };
  const access = await resolveProjectAccess(db, principal, projectId);
  return { credential: { kind: 'account', access }, tokenId: token.id };
}
