import type { McpAuthMode } from '../db/schema.js';

export type McpAccess = 'ok' | 'token_missing' | 'token_invalid';

/** `Authorization: Bearer <token>` → the token, or '' for anything else. */
export function readMcpBearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return '';
  // The scheme is case-insensitive per RFC 7235; clients write "Bearer" and "bearer" both.
  const match = /^bearer[ \t]+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : '';
}

/**
 * The whole MCP access decision, with the database lookup passed in — so the rule is a unit test
 * and the router is only "look the token up, then do this".
 */
export function mcpAccessDecision(mode: McpAuthMode, bearer: string, tokenIsValid: boolean): McpAccess {
  if (mode !== 'token') return 'ok';
  if (!bearer) return 'token_missing';
  return tokenIsValid ? 'ok' : 'token_invalid';
}
