import type { ProjectAccess } from '../auth/types.js';
import { MCP_READ_ACCESS, satisfies } from '../auth/policy.js';
import type { McpAuthMode } from '../db/schema.js';

export type McpAccess = 'ok' | 'token_missing' | 'token_invalid' | 'account_required' | 'not_a_member';

/** `Authorization: Bearer <token>` → the token, or '' for anything else. */
export function readMcpBearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return '';
  // The scheme is case-insensitive per RFC 7235; clients write "Bearer" and "bearer" both.
  const match = /^bearer[ \t]+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : '';
}

/**
 * What the request turned out to be carrying, once the database has been asked
 * ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
 *
 * `anonymous` is no bearer header at all; `unknown` is one that resolved to nothing live; `bearer` is
 * a static token, which names no account and therefore has exactly the reach [ADR-0027](../../.ssot/ADR.md#adr-0027)
 * gave it; `account` is a credential that names a user, and carries the access that user has been
 * resolved to hold on **this** project.
 */
export type McpCredential = { kind: 'anonymous' } | { kind: 'unknown' } | { kind: 'bearer' } | { kind: 'account'; access: ProjectAccess };

/**
 * The whole MCP access decision, with every database lookup already done — so the rule is a unit test
 * and the router is only "look the credential up, then do this".
 *
 * Three things are worth reading twice:
 *
 * - **A credential that names an account is checked against that account's membership in every mode,
 *   `open` included.** That is the second half of this decision and the reason it exists: leaving it
 *   out of `open` would mean a `member` the dashboard answers `404` for could still read the project
 *   by signing a browser connector into it, which is the hole [ADR-0028](../../.ssot/ADR.md#adr-0028)
 *   named and this entry closes.
 * - **An `open` project still answers an anonymous request, and still answers one carrying a bearer
 *   that means nothing.** Neither is a widening: `open` means "anyone who can reach the URL", so a
 *   caller with a broken token is no worse off than one with none, and refusing them would break the
 *   client that is mid-rotation for no gain in access.
 * - **`account` refuses a static token rather than accepting it as a lesser credential.** The mode
 *   exists to say "no anonymous credential reads this", and a `ctxm_…` is exactly that.
 */
export function mcpAccessDecision(mode: McpAuthMode, credential: McpCredential): McpAccess {
  if (credential.kind === 'account') {
    return satisfies(credential.access, MCP_READ_ACCESS) ? 'ok' : 'not_a_member';
  }
  if (mode === 'open') return 'ok';
  if (credential.kind === 'anonymous') return 'token_missing';
  if (credential.kind === 'unknown') return 'token_invalid';
  return mode === 'account' ? 'account_required' : 'ok';
}

/** Which HTTP status each verdict is answered with. `not_a_member` is the only one that is not 401. */
export const mcpAccessStatus = (verdict: Exclude<McpAccess, 'ok'>): 401 | 403 => (verdict === 'not_a_member' ? 403 : 401);

/** The sentence the client is given. Each names one thing to change, which is what a 401 usually does not. */
export function mcpAccessMessage(verdict: Exclude<McpAccess, 'ok'>, mode: McpAuthMode): string {
  switch (verdict) {
    case 'token_missing':
      return mode === 'account' ? 'This project requires an account-backed credential' : 'This project requires an MCP token';
    case 'token_invalid':
      return 'Unknown, expired or revoked MCP credential';
    case 'account_required':
      return 'This project requires an account-backed credential; a static token is not one';
    case 'not_a_member':
      return 'That account is not a member of this project';
  }
}
