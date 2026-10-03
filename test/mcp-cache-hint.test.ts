import { describe, expect, it } from 'vitest';

import type { ProjectRow } from '../src/db/schema.js';
import { MAX_CACHE_TTL_MS, projectCacheHint } from '../src/mcp/server-factory.js';
import { structuredOutputFor } from '../src/mcp/tools.js';

/**
 * The cache hint a 2026-07-28 client gets on `tools/list`, `resources/list` and `resources/read`
 * ([ADR-0100](../.ssot/ADR.md#adr-0100), 0.3-03): `public` only for an `open` project, and a lifetime
 * derived from the last index run — `0` whenever none can be derived.
 */

const NOW = new Date('2026-10-03T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

type HintInput = Pick<ProjectRow, 'mcpAuth' | 'lastIndexedAt' | 'status'>;
const project = (over: Partial<HintInput> = {}): HintInput => ({ mcpAuth: 'token', lastIndexedAt: minutesAgo(10), status: 'idle', ...over });

describe('projectCacheHint', () => {
  it('is public only for an open project', () => {
    expect(projectCacheHint(project({ mcpAuth: 'open' }), NOW).cacheScope).toBe('public');
    expect(projectCacheHint(project({ mcpAuth: 'token' }), NOW).cacheScope).toBe('private');
    expect(projectCacheHint(project({ mcpAuth: 'account' }), NOW).cacheScope).toBe('private');
  });

  it('lives a tenth of the time since the last index run', () => {
    expect(projectCacheHint(project({ lastIndexedAt: minutesAgo(10) }), NOW).ttlMs).toBe(60_000);
    expect(projectCacheHint(project({ lastIndexedAt: new Date(NOW.getTime() - 15) }), NOW).ttlMs).toBe(1);
  });

  it('is capped at an hour however old the index is', () => {
    expect(projectCacheHint(project({ lastIndexedAt: minutesAgo(60 * 24 * 30) }), NOW).ttlMs).toBe(MAX_CACHE_TTL_MS);
    expect(MAX_CACHE_TTL_MS).toBe(3_600_000);
  });

  it('is 0 when no lifetime can be derived, keeping the scope', () => {
    expect(projectCacheHint(project({ lastIndexedAt: null }), NOW)).toEqual({ ttlMs: 0, cacheScope: 'private' });
    expect(projectCacheHint(project({ mcpAuth: 'open', lastIndexedAt: null }), NOW)).toEqual({ ttlMs: 0, cacheScope: 'public' });
    expect(projectCacheHint(project({ lastIndexedAt: new Date(NOW.getTime() + 60_000) }), NOW).ttlMs).toBe(0);
    expect(projectCacheHint(project({ lastIndexedAt: NOW }), NOW).ttlMs).toBe(0);
    expect(projectCacheHint(project({ lastIndexedAt: new Date(Number.NaN) }), NOW).ttlMs).toBe(0);
    expect(projectCacheHint(project({ status: 'indexing' }), NOW).ttlMs).toBe(0);
    expect(projectCacheHint(project({ status: 'error' }), NOW).ttlMs).toBe(0);
  });

  it('is always a hint the SDK accepts: a non-negative safe integer', () => {
    for (const m of [0.001, 1, 7, 59, 600, 1e6]) {
      const { ttlMs } = projectCacheHint(project({ lastIndexedAt: minutesAgo(m) }), NOW);
      expect(Number.isSafeInteger(ttlMs)).toBe(true);
      expect(ttlMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('structuredOutputFor', () => {
  it('is always on for a modern client and follows the flag for a legacy one', () => {
    expect(structuredOutputFor('modern', { MCP_STRUCTURED_OUTPUT: false })).toBe(true);
    expect(structuredOutputFor('modern', { MCP_STRUCTURED_OUTPUT: true })).toBe(true);
    expect(structuredOutputFor('legacy', { MCP_STRUCTURED_OUTPUT: false })).toBe(false);
    expect(structuredOutputFor('legacy', { MCP_STRUCTURED_OUTPUT: true })).toBe(true);
  });
});
