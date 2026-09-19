import { describe, expect, it } from 'vitest';
import { mcpAccessDecision, mcpAccessMessage, mcpAccessStatus, readMcpBearer, type McpCredential } from '../src/mcp/access.js';
import { MCP_READ_ACCESS } from '../src/auth/policy.js';
import type { McpAuthMode } from '../src/db/schema.js';
import type { ProjectAccess } from '../src/auth/types.js';
import { hashMcpToken, newMcpToken } from '../src/services/auth/mcp-tokens.js';

describe('readMcpBearer', () => {
  it('reads the token out of an Authorization header whatever the case or spacing', () => {
    expect(readMcpBearer('Bearer ctxm_abc')).toBe('ctxm_abc');
    expect(readMcpBearer('bearer ctxm_abc')).toBe('ctxm_abc'); // RFC 7235: the scheme is case-insensitive
    expect(readMcpBearer('BEARER   ctxm_abc  ')).toBe('ctxm_abc');
    expect(readMcpBearer(['Bearer ctxm_abc', 'Bearer other'])).toBe('ctxm_abc');
  });

  it('gives nothing for anything that is not a bearer header', () => {
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic ctxm_abc', 'ctxm_abc', 'Bearerctxm_abc']) {
      expect(readMcpBearer(header)).toBe('');
    }
  });
});

const anonymous: McpCredential = { kind: 'anonymous' };
const unknown: McpCredential = { kind: 'unknown' };
const bearer: McpCredential = { kind: 'bearer' };
const account = (access: ProjectAccess): McpCredential => ({ kind: 'account', access });

describe('mcpAccessDecision', () => {
  it('lets an anonymous client through while the project is open — that is the historical behaviour', () => {
    expect(mcpAccessDecision('open', anonymous)).toBe('ok');
    expect(mcpAccessDecision('open', bearer)).toBe('ok');
    // A bearer that resolved to nothing is no worse off than no bearer at all on an open project, and
    // refusing it would break a client mid-rotation for no gain in access.
    expect(mcpAccessDecision('open', unknown)).toBe('ok');
  });

  it('tells a missing credential apart from a wrong one, so the client can say which', () => {
    expect(mcpAccessDecision('token', anonymous)).toBe('token_missing');
    expect(mcpAccessDecision('token', unknown)).toBe('token_invalid');
    expect(mcpAccessDecision('token', bearer)).toBe('ok');
  });

  /**
   * **The whole of [ADR-0054](../.ssot/ADR.md#adr-0054)'s second half is these two cases.** A
   * credential that names an account is judged by that account's membership *in every mode*, `open`
   * included — otherwise a `member` the dashboard answers `404` for could read the project by pointing
   * a signed-in connector at it, which is the gap ADR-0028's own consequences named.
   */
  describe('a credential that names an account', () => {
    it('is judged by the membership in every mode, the open one included', () => {
      for (const mode of ['open', 'token', 'account'] satisfies McpAuthMode[]) {
        expect(mcpAccessDecision(mode, account('viewer'))).toBe('ok');
        expect(mcpAccessDecision(mode, account('editor'))).toBe('ok');
        expect(mcpAccessDecision(mode, account('manager'))).toBe('ok');
        expect(mcpAccessDecision(mode, account('none'))).toBe('not_a_member');
      }
    });

    it('needs a viewer and not an editor, because every MCP request is a POST that reads', () => {
      expect(MCP_READ_ACCESS).toBe('viewer');
      // The negative half of the same claim: the surface is read-only, so a `viewer` must be enough —
      // a rule that asked for `editor` would lock every read-only member out of the reading surface.
      expect(mcpAccessDecision('account', account('viewer'))).toBe('ok');
      expect(mcpAccessDecision('account', account('none'))).toBe('not_a_member');
    });
  });

  describe('a project that requires an account', () => {
    it('refuses a static token rather than accepting it as a lesser credential', () => {
      expect(mcpAccessDecision('account', bearer)).toBe('account_required');
    });

    it('still tells no credential apart from a broken one', () => {
      expect(mcpAccessDecision('account', anonymous)).toBe('token_missing');
      expect(mcpAccessDecision('account', unknown)).toBe('token_invalid');
    });
  });

  it('answers 403 only for the refusal that is about the person, and 401 for the three about the credential', () => {
    expect(mcpAccessStatus('not_a_member')).toBe(403);
    for (const verdict of ['token_missing', 'token_invalid', 'account_required'] as const) {
      expect(mcpAccessStatus(verdict)).toBe(401);
    }
  });

  it('names one thing to change in every refusal, and a different thing per mode where the mode decides', () => {
    expect(mcpAccessMessage('token_missing', 'token')).toContain('MCP token');
    expect(mcpAccessMessage('token_missing', 'account')).toContain('account-backed');
    expect(mcpAccessMessage('account_required', 'account')).toContain('static token is not one');
    expect(mcpAccessMessage('not_a_member', 'account')).toContain('not a member');
  });
});

describe('MCP tokens', () => {
  it('are opaque, prefixed so a scanner can find them, and long enough to be unguessable', () => {
    const token = newMcpToken();
    expect(token).toMatch(/^ctxm_[0-9a-f]{64}$/); // 32 random bytes
    expect(new Set(Array.from({ length: 200 }, () => newMcpToken())).size).toBe(200);
  });

  it('carries a prefix per kind, so a log line or a scanner can tell the three apart', () => {
    expect(newMcpToken('static')).toMatch(/^ctxm_[0-9a-f]{64}$/);
    expect(newMcpToken('access')).toMatch(/^ctxa_[0-9a-f]{64}$/);
    expect(newMcpToken('refresh')).toMatch(/^ctxr_[0-9a-f]{64}$/);
    expect(new Set([newMcpToken('static'), newMcpToken('access'), newMcpToken('refresh')].map((t) => t.slice(0, 5))).size).toBe(3);
  });

  it('are stored only as a hash, deterministically, and never contain the token', () => {
    const token = newMcpToken();
    expect(hashMcpToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToken(token)).toBe(hashMcpToken(token));
    expect(hashMcpToken(token)).not.toContain(token.slice(5));
    expect(hashMcpToken(newMcpToken())).not.toBe(hashMcpToken(token));
  });

  it('do not collide with a session cookie token, which shares the shape but not the prefix', () => {
    expect(newMcpToken().startsWith('ctxs_')).toBe(false);
  });
});
