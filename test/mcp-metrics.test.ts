import { describe, expect, it } from 'vitest';

import { countMcpMessages } from '../src/mcp/router.js';
import type { McpServer } from '@modelcontextprotocol/server';

import type { ProjectRow } from '../src/db/schema.js';
import { MCP_TOOL_NAMES, registerTools, type ToolContext, toolLabel } from '../src/mcp/tools.js';
import {
  KNOWN_MCP_METHODS,
  type McpRequestEra,
  MetricsRegistry,
  type MetricsSnapshot,
  OTHER_LABEL,
  renderPrometheus,
} from '../src/services/metrics.js';

/**
 * The two MCP families: `contextator_mcp_requests_total{method,tool,era}` and
 * `contextator_mcp_tool_duration_seconds{tool}`. Pure — the registry, the label folding and the text —
 * because what matters is that a label value can only come from a closed list: a client that sends
 * made-up method or tool names must not be able to grow the series count.
 */

const BASE: MetricsSnapshot = {
  version: '0.3.0-test',
  uptimeSeconds: 1,
  embeddingId: 'local:stub:fp32',
  embeddingReady: true,
  dbUp: true,
  pool: null,
  queue: { interactive: 0, scheduled: 0, running: 0 },
  lastIndexRun: null,
  searches: { mcp: 0, dashboard: 0 },
  audit: { written: 0, failed: 0 },
};

const scrape = (registry: MetricsRegistry): string =>
  renderPrometheus({ ...BASE, mcpRequests: registry.mcpRequests(), histograms: registry.histograms() });

const series = (method: string, tool: string, era: McpRequestEra) => `contextator_mcp_requests_total{method="${method}",tool="${tool}",era="${era}"}`;

describe('toolLabel', () => {
  it('keeps a registered tool name and folds everything else into `other`', () => {
    for (const name of MCP_TOOL_NAMES) expect(toolLabel(name)).toBe(name);
    expect(toolLabel('drop_tables')).toBe(OTHER_LABEL);
    expect(toolLabel('')).toBe(OTHER_LABEL);
    expect(toolLabel(undefined)).toBe(OTHER_LABEL);
    expect(toolLabel(42)).toBe(OTHER_LABEL);
  });
});

describe('MCP_TOOL_NAMES', () => {
  it('is exactly the set of tools registerTools registers, in both eras', () => {
    for (const era of ['modern', 'legacy'] as const) {
      const names: string[] = [];
      // No low-level `server`: the legacy unknown-tool wrapper has nothing to wrap and steps aside.
      const server = {
        registerTool: (name: string) => {
          names.push(name);
        },
      };
      const ctx = { config: { MCP_STRUCTURED_OUTPUT: false } } as unknown as ToolContext;
      registerTools(server as unknown as McpServer, ctx, { name: 'handbook' } as ProjectRow, null, era);
      expect([...names].sort()).toEqual([...MCP_TOOL_NAMES].sort());
    }
  });
});

describe('MetricsRegistry.countMcpRequest', () => {
  it('counts per (method, tool, era) and folds an unknown method into `other`', () => {
    const registry = new MetricsRegistry();
    registry.countMcpRequest('tools/call', 'search_docs', 'modern');
    registry.countMcpRequest('tools/call', 'search_docs', 'modern');
    registry.countMcpRequest('tools/call', 'search_docs', 'legacy');
    registry.countMcpRequest('x/made-up', '', 'modern');
    registry.countMcpRequest('y/also-made-up', '', 'modern');

    const samples = registry.mcpRequests();
    expect(samples).toContainEqual({ method: 'tools/call', tool: 'search_docs', era: 'modern', count: 2 });
    expect(samples).toContainEqual({ method: 'tools/call', tool: 'search_docs', era: 'legacy', count: 1 });
    expect(samples).toContainEqual({ method: OTHER_LABEL, tool: '', era: 'modern', count: 2 });
    expect(samples).toHaveLength(3);
  });

  it('knows the methods the server answers in both eras', () => {
    for (const method of ['initialize', 'tools/list', 'tools/call', 'resources/read', 'prompts/list', 'prompts/get', 'server/discover']) {
      expect(KNOWN_MCP_METHODS.has(method)).toBe(true);
    }
  });
});

describe('countMcpMessages', () => {
  it('counts every request and notification of a batch, labels the tool of a call, and skips responses', () => {
    const registry = new MetricsRegistry();
    countMcpMessages(
      registry,
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_document', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not_a_tool' } },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 9, result: {} },
      ],
      'legacy',
    );
    expect(registry.mcpRequests()).toEqual(
      expect.arrayContaining([
        { method: 'tools/call', tool: 'read_document', era: 'legacy', count: 1 },
        { method: 'tools/call', tool: OTHER_LABEL, era: 'legacy', count: 1 },
        { method: 'tools/list', tool: '', era: 'legacy', count: 1 },
        { method: 'notifications/initialized', tool: '', era: 'legacy', count: 1 },
      ]),
    );
    expect(registry.mcpRequests()).toHaveLength(4);
  });

  it('ignores a body that is not a JSON-RPC message', () => {
    const registry = new MetricsRegistry();
    for (const body of [undefined, null, 'tools/call', 42, {}, { method: 7 }]) countMcpMessages(registry, body, 'modern');
    expect(registry.mcpRequests()).toEqual([]);
  });
});

describe('the exposition', () => {
  it('renders the request counter with its three labels, and the tool histogram', () => {
    const registry = new MetricsRegistry();
    registry.countMcpRequest('tools/call', 'search_docs', 'modern');
    registry.countMcpRequest('tools/call', 'search_docs', 'legacy');
    registry.observeToolDuration('search_docs', 0.2);
    const text = scrape(registry);

    expect(text).toContain('# TYPE contextator_mcp_requests_total counter');
    expect(text).toContain(`${series('tools/call', 'search_docs', 'modern')} 1`);
    expect(text).toContain(`${series('tools/call', 'search_docs', 'legacy')} 1`);
    expect(text).toContain('# TYPE contextator_mcp_tool_duration_seconds histogram');
    expect(text).toContain('contextator_mcp_tool_duration_seconds_count{tool="search_docs"} 1');
    expect(text).toContain('contextator_mcp_tool_duration_seconds_bucket{tool="search_docs",le="+Inf"} 1');
  });

  it('writes the counter family header even before the first request, and leaves it out of an older snapshot', () => {
    expect(scrape(new MetricsRegistry())).toContain('# TYPE contextator_mcp_requests_total counter');
    expect(renderPrometheus(BASE)).not.toContain('contextator_mcp_requests_total');
  });
});
