import { describe, expect, it } from 'vitest';

import { EnvSchema } from '../src/config.js';
import { messageCost, rateLimitChecks, rateLimitMessage } from '../src/mcp/rate-limit.js';
import { MCP_TOOL_NAMES } from '../src/mcp/tool-names.js';
import { MetricsRegistry, type MetricsSnapshot, renderPrometheus } from '../src/services/metrics.js';

/** The pure halves of MCP rate limiting (ADR-0112): the settings, what a body costs, whose counter, the metrics. */

const ENV = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ALLOWED_DOC_ROOTS: '/docs' };
const parse = (overrides: Record<string, string> = {}) => EnvSchema.safeParse({ ...ENV, ...overrides });
const TOOL = MCP_TOOL_NAMES[0];
const call = (id: number, name: string = TOOL) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

describe('MCP_RATE_LIMIT_* settings', () => {
  it('defaults to no token limit, 60 per minute per anonymous address, no tool limit, fail-open', () => {
    const parsed = parse();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.MCP_RATE_LIMIT_PER_MINUTE).toBe(0);
    expect(parsed.data.MCP_RATE_LIMIT_ANON_PER_MINUTE).toBe(60);
    expect(parsed.data.MCP_RATE_LIMIT_TOOLS).toEqual({});
    expect(parsed.data.MCP_RATE_LIMIT_FAIL_OPEN).toBe(true);
  });

  it('reads name=n pairs for registered tools and the fail-closed switch', () => {
    const parsed = parse({ MCP_RATE_LIMIT_TOOLS: `${TOOL}=30`, MCP_RATE_LIMIT_FAIL_OPEN: '0', MCP_RATE_LIMIT_PER_MINUTE: '120' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.MCP_RATE_LIMIT_TOOLS).toEqual({ [TOOL]: 30 });
    expect(parsed.data.MCP_RATE_LIMIT_FAIL_OPEN).toBe(false);
    expect(parsed.data.MCP_RATE_LIMIT_PER_MINUTE).toBe(120);
  });

  it('refuses an unknown tool, a malformed pair, a duplicate and a zero or negative number', () => {
    for (const bad of ['drop_tables=5', `${TOOL}`, `${TOOL}=abc`, `${TOOL}=5,${TOOL}=6`, `${TOOL}=0`]) {
      expect(parse({ MCP_RATE_LIMIT_TOOLS: bad }).success, bad).toBe(false);
    }
    expect(parse({ MCP_RATE_LIMIT_PER_MINUTE: '-1' }).success).toBe(false);
  });
});

describe('messageCost', () => {
  it('counts a request once and a tool call under its tool', () => {
    const cost = messageCost(call(1));
    expect(cost.requests).toBe(1);
    expect(cost.tools.get(TOOL)).toBe(1);
  });

  it('does not count initialize, ping, notifications or posted responses', () => {
    const body = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 3, result: {} },
    ];
    expect(messageCost(body).requests).toBe(0);
  });

  it('counts each request of a batch, and the tool calls per tool', () => {
    const cost = messageCost([call(1), call(2), { jsonrpc: '2.0', id: 3, method: 'tools/list' }, call(4, MCP_TOOL_NAMES[1])]);
    expect(cost.requests).toBe(4);
    expect(cost.tools.get(TOOL)).toBe(2);
    expect(cost.tools.get(MCP_TOOL_NAMES[1])).toBe(1);
  });

  it('reads the tool from the body and ignores a name that is not one of ours', () => {
    const cost = messageCost(call(1, 'drop_tables'));
    expect(cost.requests).toBe(1);
    expect(cost.tools.size).toBe(0);
  });

  it('survives bodies that are not JSON-RPC at all', () => {
    for (const body of [null, undefined, 7, 'x', [], [null, 3], {}, { method: 5, id: 1 }]) expect(messageCost(body).requests).toBe(0);
  });
});

describe('rateLimitChecks', () => {
  const base = {
    config: { MCP_RATE_LIMIT_PER_MINUTE: 100, MCP_RATE_LIMIT_ANON_PER_MINUTE: 60, MCP_RATE_LIMIT_TOOLS: { [TOOL]: 10 } },
    projectId: 'p1',
    mcpAuth: 'token' as const,
    credential: { kind: 'bearer' } as const,
    tokenId: 't1',
    ip: '203.0.113.7',
    cost: messageCost([call(1), call(2)]),
  };

  it('holds a token to its own key, then to its tool', () => {
    expect(rateLimitChecks(base)).toEqual([
      { key: 'tok:t1', limit: 100, scope: 'token', cost: 2 },
      { key: `tok:t1:tool:${TOOL}`, limit: 10, scope: 'tool', cost: 2, tool: TOOL },
    ]);
  });

  it('skips the token check when the token limit is off but keeps the tool check', () => {
    const checks = rateLimitChecks({ ...base, config: { ...base.config, MCP_RATE_LIMIT_PER_MINUTE: 0 } });
    expect(checks.map((c) => c.scope)).toEqual(['tool']);
  });

  it('keys an anonymous request on an open project by project and address', () => {
    const checks = rateLimitChecks({ ...base, mcpAuth: 'open', credential: { kind: 'anonymous' }, tokenId: null });
    expect(checks[0]).toEqual({ key: 'ip:p1:203.0.113.7', limit: 60, scope: 'anonymous', cost: 2 });
    expect(checks[1].key).toBe(`ip:p1:203.0.113.7:tool:${TOOL}`);
  });

  it('counts a wrong Bearer on an open project in the anonymous bucket, not under a token of its own', () => {
    const checks = rateLimitChecks({ ...base, mcpAuth: 'open', credential: { kind: 'unknown' }, tokenId: null });
    expect(checks[0].key).toBe('ip:p1:203.0.113.7');
    expect(checks[0].scope).toBe('anonymous');
  });

  it('counts nothing for a project that is not open and a request without a live credential', () => {
    expect(rateLimitChecks({ ...base, credential: { kind: 'unknown' }, tokenId: null })).toEqual([]);
  });

  it('is empty when every limit is off or the body costs nothing', () => {
    expect(
      rateLimitChecks({ ...base, config: { MCP_RATE_LIMIT_PER_MINUTE: 0, MCP_RATE_LIMIT_ANON_PER_MINUTE: 0, MCP_RATE_LIMIT_TOOLS: {} } }),
    ).toEqual([]);
    expect(rateLimitChecks({ ...base, cost: messageCost({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).toEqual([]);
  });
});

describe('rateLimitMessage', () => {
  it('names whose limit it was and when to come back, naming neither a token nor an address', () => {
    expect(rateLimitMessage({ retryAfterSec: 12, scope: 'token', limit: 100 })).toBe(
      'Rate limit exceeded for this token: 100 requests per minute. Retry after 12 seconds.',
    );
    expect(rateLimitMessage({ retryAfterSec: 1, scope: 'anonymous', limit: 60 })).toContain('this address');
    expect(rateLimitMessage({ retryAfterSec: 1, scope: 'anonymous', limit: 60 })).toContain('1 second.');
    expect(rateLimitMessage({ retryAfterSec: 3, scope: 'tool', limit: 5, tool: TOOL })).toContain(`the tool "${TOOL}"`);
  });
});

describe('the guard metrics', () => {
  const BASE: MetricsSnapshot = {
    version: 't',
    uptimeSeconds: 1,
    embeddingId: 'x',
    embeddingReady: true,
    dbUp: true,
    pool: null,
    queue: { interactive: 0, scheduled: 0, running: 0 },
    lastIndexRun: null,
    searches: { mcp: 0, dashboard: 0 },
    audit: { written: 0, failed: 0 },
  };

  it('renders the three families from zero and counts into closed label sets', () => {
    const registry = new MetricsRegistry();
    const zero = renderPrometheus({ ...BASE, mcpGuard: registry.mcpGuard() });
    expect(zero).toContain('contextator_mcp_rate_limited_total{scope="token"} 0');
    expect(zero).toContain('contextator_mcp_rate_limit_errors_total 0');
    expect(zero).toContain('contextator_mcp_access_denied_total{reason="network"} 0');

    registry.countRateLimited('anonymous');
    registry.countRateLimited('anonymous');
    registry.countRateLimited('tool');
    registry.countRateLimitError();
    registry.countAccessDenied('network');
    const text = renderPrometheus({ ...BASE, mcpGuard: registry.mcpGuard() });
    expect(text).toContain('contextator_mcp_rate_limited_total{scope="anonymous"} 2');
    expect(text).toContain('contextator_mcp_rate_limited_total{scope="tool"} 1');
    expect(text).toContain('contextator_mcp_rate_limit_errors_total 1');
    expect(text).toContain('contextator_mcp_access_denied_total{reason="network"} 1');
  });
});
