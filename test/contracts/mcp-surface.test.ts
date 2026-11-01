import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { ProjectRow } from '../../src/db/schema.js';
import type { McpEra } from '../../src/mcp/era.js';
import { registerPrompts } from '../../src/mcp/prompts.js';
import { registerResources } from '../../src/mcp/resources.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';

/**
 * **The MCP surface as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 1): what a client is
 * told by `tools/list` (names, input schemas, annotations, and in the modern era the `outputSchema`),
 * `prompts/list` and `resources/templates/list`. An added, removed or renamed tool, argument, schema field
 * or annotation changes a snapshot under `__snapshots__/`; wording does not.
 *
 * **Tier 3 is stripped.** Every `title` and `description` is dropped, recursively, including the field
 * descriptions inside the schemas: how a tool is worded is what gets tuned for agents, and no client breaks
 * on it. Only a string-valued `title`/`description` is dropped, so an argument that is itself called
 * `title` or `description` stays. The project name is a fixture's, so nothing below depends on a real one.
 *
 * Normalised so a diff is a real difference: object keys sorted, two-space indent, the three lists sorted by
 * name, and `required` sorted (the order a schema lists them in carries no meaning). Nothing else is touched.
 *
 * Two `tools/list` snapshots, because the two protocol eras differ: `legacy` with `MCP_STRUCTURED_OUTPUT`
 * off (its default, [ADR-0100](../../.ssot/ADR.md#adr-0100)) has no `outputSchema`, `modern` always has one.
 * Prompts and resource templates are the same in both eras. `report_gap` is registered only while the query
 * log is on ([ADR-0125](../../.ssot/ADR.md#adr-0125)), so the fixture turns it on and it is in the contract.
 *
 * The registrations are read through a real `McpServer` and an in-memory transport with a hollow context:
 * registering touches neither the database nor the embedding model, only a call would. The MCP integration
 * golden (`test/integration/__golden__/mcp-tools`) keeps holding the *answers*; this holds the *definitions*,
 * and costs no container.
 *
 * Re-record after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * Outside CI a missing snapshot file is written silently; run with `CI=1` to check rather than extend.
 */

const SNAPSHOTS = path.join(import.meta.dirname, '__snapshots__');

const project = { id: '00000000-0000-4000-8000-000000000001', name: 'fixture-project', queryLogEnabled: true } as unknown as ProjectRow;

const tmp = tmpdir();
const config = loadConfig({
  DATABASE_URL: 'postgres://contract:contract@localhost:5432/contract',
  ALLOWED_DOC_ROOTS: tmp,
  DATA_DIR: path.join(tmp, 'contextator-contract'),
  SECRET_KEY: '0'.repeat(64),
});

const toolContext = {
  db: {},
  embeddings: {},
  config,
  log: { warn() {}, info() {}, error() {}, debug() {} },
  // Only its presence matters: it is what registers `report_gap`.
  queryLog: {},
} as unknown as ToolContext;

type Listing = Record<string, unknown>;

/** `initialize`, then each `method` once, over an in-memory pair, returning every reply's `result`. */
async function listings(era: McpEra, methods: string[]): Promise<Listing[]> {
  const server = new McpServer({ name: 'contextator-contract', version: '0.0.0' });
  registerTools(server, toolContext, project, null, era);
  registerResources(server, toolContext, project);
  registerPrompts(server, project);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (message: JSONRPCMessage) => void>();
  clientTransport.onmessage = (message) => {
    const id = (message as { id?: unknown }).id;
    if (typeof id === 'number') waiting.get(id)?.(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  let nextId = 0;
  const send = (method: string, params?: Record<string, unknown>): Promise<JSONRPCMessage> => {
    const id = nextId++;
    const reply = new Promise<JSONRPCMessage>((resolve) => waiting.set(id, resolve));
    void clientTransport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return reply;
  };
  try {
    await send('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'contract', version: '0.0.0' } });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const results: Listing[] = [];
    for (const method of methods) {
      const reply = (await send(method, {})) as { result?: Listing; error?: unknown };
      if (!reply.result) throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
      results.push(reply.result);
    }
    return results;
  } finally {
    await clientTransport.close();
    await server.close();
  }
}

/** Tier 3 out, order out: see the header. Pure, so a mutation of the input is never the cause of a diff. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = (value as Record<string, unknown>)[key];
    if ((key === 'title' || key === 'description') && typeof inner === 'string') continue;
    out[key] = key === 'required' && Array.isArray(inner) ? [...(inner as string[])].sort() : normalise(inner);
  }
  return out;
}

/** By code unit, not `localeCompare`: the order must not depend on the locale of whoever records the snapshot. */
const keyOf = (item: { name?: string; uriTemplate?: string }): string => item.name ?? item.uriTemplate ?? '';
const byName = (items: unknown): unknown[] =>
  [...(items as Array<{ name?: string; uriTemplate?: string }>)].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));

/**
 * Two-space JSON in the shape Biome's formatter keeps (`npm run lint` checks these files too): objects
 * always one key per line, an array of scalars on one line while it fits, anything else one item per line.
 */
function render(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => item === null || typeof item !== 'object')) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (inline.length + close.length + 2 <= 140) return inline;
    }
    return `[\n${value.map((item) => `${pad}${render(item, depth + 1)}`).join(',\n')}\n${close}]`;
  }
  // What JSON would drop (`undefined`) is dropped here too, as `JSON.stringify` always did.
  const entries = Object.entries(value).filter(([, inner]) => inner !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([key, inner]) => `${pad}${JSON.stringify(key)}: ${render(inner, depth + 1)}`).join(',\n')}\n${close}}`;
}

const record = (items: unknown): string => `${render(normalise(byName(items)))}\n`;

describe('the MCP surface is a contract', () => {
  it('records the tools the legacy era is told about, without structured output', async () => {
    expect(config.MCP_STRUCTURED_OUTPUT).toBe(false);
    const [tools] = await listings('legacy', ['tools/list']);
    const names = (tools.tools as Array<{ name: string; outputSchema?: unknown }>).map((t) => t.name);
    // Guard the listing itself: an empty or partial one would record itself as the contract.
    expect(names.sort()).toEqual(['list_topics', 'read_document', 'report_gap', 'search_docs', 'whats_new']);
    expect((tools.tools as Array<{ outputSchema?: unknown }>).some((t) => t.outputSchema !== undefined)).toBe(false);
    await expect(record(tools.tools)).toMatchFileSnapshot(path.join(SNAPSHOTS, 'mcp-tools-legacy.json'));
  });

  it('records the tools the modern era is told about, with their outputSchema', async () => {
    const [tools] = await listings('modern', ['tools/list']);
    expect((tools.tools as Array<{ outputSchema?: unknown }>).every((t) => t.outputSchema !== undefined)).toBe(true);
    await expect(record(tools.tools)).toMatchFileSnapshot(path.join(SNAPSHOTS, 'mcp-tools-modern.json'));
  });

  it('records the prompts and their arguments', async () => {
    const [prompts] = await listings('legacy', ['prompts/list']);
    expect((prompts.prompts as unknown[]).length).toBeGreaterThan(0);
    await expect(record(prompts.prompts)).toMatchFileSnapshot(path.join(SNAPSHOTS, 'mcp-prompts.json'));
  });

  it('records the resource URI template', async () => {
    const [templates] = await listings('legacy', ['resources/templates/list']);
    expect((templates.resourceTemplates as unknown[]).length).toBe(1);
    await expect(record(templates.resourceTemplates)).toMatchFileSnapshot(path.join(SNAPSHOTS, 'mcp-resource-templates.json'));
  });

  it('strips the wording and only the wording', () => {
    const stripped = normalise({
      name: 'x',
      title: 'T',
      description: 'D',
      inputSchema: { properties: { title: { type: 'string', description: 'field text' }, b: { type: 'string' } }, required: ['b', 'title'] },
    });
    expect(stripped).toEqual({
      inputSchema: { properties: { b: { type: 'string' }, title: { type: 'string' } }, required: ['b', 'title'] },
      name: 'x',
    });
  });
});
