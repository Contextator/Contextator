import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/config.js';
import type { ProjectRow } from '../src/db/schema.js';
import { reportGapOutput } from '../src/mcp/output-schemas.js';
import { registerTools, type ToolContext } from '../src/mcp/tools.js';
import { MetricsRegistry, renderPrometheus } from '../src/services/metrics.js';
import {
  ANONYMOUS_RATE_KEY,
  rateKeyFor,
  REPORT_GAP_NOTE_MAX_CHARS,
  REPORT_GAP_PROJECT_ROW_CAP,
  REPORT_GAP_QUERY_MAX_CHARS,
} from '../src/services/report-gap.js';

/**
 * `report_gap` ([ADR-0125](../.ssot/ADR.md#adr-0125)) with no database behind it: what it declares to a
 * client, which bucket a call lands in, and the two facts about the process that no integration test can see
 * from outside — where the sweep sits in the reaper, and what `/metrics` says. `test/integration/report-gap.itest.ts`
 * asserts what PostgreSQL does with a call.
 */

interface Registration {
  name: string;
  config: {
    title?: string;
    description?: string;
    annotations?: Record<string, boolean>;
    inputSchema?: Record<string, unknown>;
    outputSchema?: unknown;
  };
}

function registrations(structured: boolean): Registration[] {
  const seen: Registration[] = [];
  const server = { registerTool: (name: string, config: Registration['config']) => void seen.push({ name, config }) };
  const ctx = { config: { MCP_STRUCTURED_OUTPUT: structured }, queryLog: {} } as unknown as ToolContext;
  registerTools(server as unknown as McpServer, ctx, { name: 'handbook', queryLogEnabled: true } as ProjectRow, null, 'legacy');
  return seen;
}

describe('the report_gap registration', () => {
  const tool = (structured = false) => {
    const found = registrations(structured).find((r) => r.name === 'report_gap');
    if (!found) throw new Error('report_gap was not registered');
    return found.config;
  };

  it('is annotated as a tool that writes, destroys nothing and is not idempotent', () => {
    expect(tool().annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  });

  it('does not say the hourly limit exists when MCP_REPORT_GAP_PER_HOUR=0 could have switched it off', () => {
    expect(tool().description).toMatch(/may be limited/);
    expect(tool().description).not.toMatch(/is limited/);
  });

  it('leaves every other tool read-only', () => {
    for (const { name, config } of registrations(false)) {
      if (name !== 'report_gap') expect(config.annotations, name).toMatchObject({ readOnlyHint: true });
    }
  });

  it('tells the agent to use it only after searching and reading found nothing', () => {
    expect(tool().description).toMatch(/only after you have searched with search_docs and read what turned up with read_document/);
    expect(tool().description).toMatch(/Do not call it after every search/);
  });

  it('takes a query of 1 to 2000 characters and a note of at most 1000', () => {
    const input = tool().inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(Object.keys(input)).toEqual(['query', 'note']);
    expect(input.query.safeParse('').success).toBe(false);
    // Only whitespace is empty too: it would spend a slot of the bucket on a row with nothing in it.
    expect(input.query.safeParse('   \n\t ').success).toBe(false);
    expect(input.query.safeParse('x'.repeat(REPORT_GAP_QUERY_MAX_CHARS)).success).toBe(true);
    expect(input.query.safeParse('x'.repeat(REPORT_GAP_QUERY_MAX_CHARS + 1)).success).toBe(false);
    expect(input.note.safeParse(undefined).success).toBe(true);
    expect(input.note.safeParse('x'.repeat(REPORT_GAP_NOTE_MAX_CHARS)).success).toBe(true);
    expect(input.note.safeParse('x'.repeat(REPORT_GAP_NOTE_MAX_CHARS + 1)).success).toBe(false);
  });

  it('declares an output schema that says "received" and nothing else, only when answers are structured', () => {
    expect(tool(false).outputSchema).toBeUndefined();
    expect(tool(true).outputSchema).toBe(reportGapOutput);
    expect(reportGapOutput.safeParse({ status: 'received' }).success).toBe(true);
    expect(reportGapOutput.safeParse({ status: 'recorded' }).success).toBe(false);
    // A strict reading: nothing about another report, a count or an identity can ride along (T16).
    expect(Object.keys(reportGapOutput.shape)).toEqual(['status']);
  });
});

describe('which bucket a call counts against', () => {
  it('is the token for a call that presented one and one shared bucket for every anonymous caller', () => {
    expect(rateKeyFor('3f6d3b9e-6a58-4a3e-9d2b-5a1f0a9a2b11')).toBe('tok:3f6d3b9e-6a58-4a3e-9d2b-5a1f0a9a2b11');
    expect(rateKeyFor(null)).toBe(ANONYMOUS_RATE_KEY);
    expect(ANONYMOUS_RATE_KEY).toBe('anon');
  });
});

describe('MCP_REPORT_GAP_PER_HOUR', () => {
  const ENV = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ALLOWED_DOC_ROOTS: '/docs' };
  const parse = (overrides: Record<string, string> = {}) => EnvSchema.safeParse({ ...ENV, ...overrides });

  it('is 20 by default and 0 switches the limit off', () => {
    const read = (overrides: Record<string, string> = {}) => {
      const parsed = parse(overrides);
      if (!parsed.success) throw new Error(parsed.error.message);
      return parsed.data.MCP_REPORT_GAP_PER_HOUR;
    };
    expect(read()).toBe(20);
    expect(read({ MCP_REPORT_GAP_PER_HOUR: '0' })).toBe(0);
    expect(read({ MCP_REPORT_GAP_PER_HOUR: '5' })).toBe(5);
  });

  it('refuses a negative or fractional number rather than reading it as a limit', () => {
    expect(parse({ MCP_REPORT_GAP_PER_HOUR: '-1' }).success).toBe(false);
    expect(parse({ MCP_REPORT_GAP_PER_HOUR: '1.5' }).success).toBe(false);
  });

  it('can also be given a per-minute tool limit, because report_gap is a tool the server knows', () => {
    const parsed = parse({ MCP_RATE_LIMIT_TOOLS: 'report_gap=30' });
    expect(parsed.success && parsed.data.MCP_RATE_LIMIT_TOOLS).toEqual({ report_gap: 30 });
  });
});

describe('the project row cap', () => {
  it('is 2000, as ADR-0125 says', () => {
    expect(REPORT_GAP_PROJECT_ROW_CAP).toBe(2000);
  });
});

describe('contextator_mcp_gap_reports_total', () => {
  const SNAPSHOT = {
    version: '0.0.0',
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
  const lines = (text: string) => text.split('\n').filter((l) => l.startsWith('contextator_mcp_gap_reports_total'));

  it('counts each outcome, labelled by the four-value closed set and nothing else', () => {
    const registry = new MetricsRegistry();
    registry.countGapReport('accepted');
    registry.countGapReport('accepted');
    registry.countGapReport('limited');
    registry.countGapReport('disabled');
    const text = renderPrometheus({ ...SNAPSHOT, gapReports: registry.gapReports() });
    expect(lines(text)).toEqual([
      'contextator_mcp_gap_reports_total{outcome="accepted"} 2',
      'contextator_mcp_gap_reports_total{outcome="limited"} 1',
      'contextator_mcp_gap_reports_total{outcome="disabled"} 1',
      'contextator_mcp_gap_reports_total{outcome="failed"} 0',
    ]);
  });

  it('is not stated by a snapshot that carries none', () => {
    expect(renderPrometheus(SNAPSHOT)).not.toContain('contextator_mcp_gap_reports_total');
  });
});

describe('the reaper', () => {
  // The reaper's tick is a closure inside `server.ts`, so the order is held at the source (as ADR-0123's is).
  // ADR-0125, decision 3: switching the query log off must not stop the forgetting of what it collected.
  it('sweeps reported gaps before the query log returns early, and so also while the log is off', () => {
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const sweep = source.indexOf('sweepReportedGaps(db, config.SEARCH_QUERY_LOG_RETENTION_DAYS)');
    const earlyReturn = source.indexOf('if (!config.SEARCH_QUERY_LOG) return;');
    expect(sweep, 'the sweep is called from the reaper').toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(earlyReturn);
  });
});
