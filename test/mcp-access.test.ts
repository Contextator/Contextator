import { describe, expect, it } from 'vitest';
import { mcpAccessDecision, readMcpBearer } from '../src/mcp/access.js';
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

describe('mcpAccessDecision', () => {
  it('lets everything through while the project is open — that is the historical behaviour', () => {
    expect(mcpAccessDecision('open', '', false)).toBe('ok');
    expect(mcpAccessDecision('open', 'ctxm_whatever', false)).toBe('ok');
  });

  it('tells a missing token apart from a wrong one, so the client can say which', () => {
    expect(mcpAccessDecision('token', '', false)).toBe('token_missing');
    expect(mcpAccessDecision('token', 'ctxm_wrong', false)).toBe('token_invalid');
    expect(mcpAccessDecision('token', 'ctxm_right', true)).toBe('ok');
  });

  it('never accepts an unverified token, however well-formed it looks', () => {
    expect(mcpAccessDecision('token', newMcpToken(), false)).toBe('token_invalid');
  });
});

describe('MCP tokens', () => {
  it('are opaque, prefixed so a scanner can find them, and long enough to be unguessable', () => {
    const token = newMcpToken();
    expect(token).toMatch(/^ctxm_[0-9a-f]{64}$/); // 32 random bytes
    expect(new Set(Array.from({ length: 200 }, newMcpToken)).size).toBe(200);
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
