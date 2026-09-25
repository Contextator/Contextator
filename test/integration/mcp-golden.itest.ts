import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, projects, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { replaceDocument, storedDocumentContent, type NewChunk } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * **The golden record of the MCP tool surface**: what a client is sent, whole, for `tools/list` and
 * for a representative call of every outcome each tool has — results, "nothing matched", "no good
 * match", every refusal, every budget cut — against a fixture that never changes.
 *
 * Whole means the JSON-RPC message as it crosses the transport, not `content[0].text`: the tool
 * definitions with their input schemas and annotations, and every key of every result. Anything the
 * server adds to a definition or to a result — an `outputSchema`, a `structuredContent`, a second
 * content block — changes the file it is compared against, which is the point. It was recorded on
 * `main` before structured output was merged ([ADR-0087](../../.ssot/ADR.md#adr-0087)), and with that
 * feature switched off by default this record has to hold byte for byte afterwards.
 *
 * The configuration is `loadConfig`'s defaults plus the four settings a test has to give, and nothing
 * else — so "off by default" is what is exercised, not a flag this file sets. The only deviations are
 * `SEARCH_MAX_RESULT_CHARS` on the cases that exist to hit the budget, named in the case.
 *
 * Nothing is normalised: the JSON-RPC ids are the ones this file sends, the project and source names
 * are fixed, no timestamp, uuid or duration reaches a tool answer, and the fixture is built so that no
 * two search candidates tie (a tie is broken by a random row id, which no record could hold).
 *
 * Raw JSON-RPC over an in-memory pair rather than the SDK `Client`, which would validate and reshape
 * what it received before a test could look at it.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const LIVE = 0;
const GOLDEN_DIR = path.join(import.meta.dirname, '__golden__', 'mcp-tools');

function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

const countTokens = (text: string): number => estimateTokens(text) * 3;

const embeddings: EmbeddingProvider = {
  id: MODEL_ID,
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens,
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => texts.map(stubVector),
  embedQuery: async (text: string) => stubVector(text),
};

const GUIDE = `# Delivery guide

Introduction to the delivery pipeline and what it is for.

## Install

Install the package from the registry before anything else.

### Docker

Run the published image with the compose file in the repository, mounting the documentation read-only.
The container listens on one port and needs a writable data directory beside it.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

/** Long, one section, many chunks: what a token budget has to be able to cut. */
const MANUAL = `# Operations manual

${Array.from({ length: 60 }, (_, i) => `Paragraph ${i} explains one more part of the operations procedure in a sentence of ordinary length.`).join('\n\n')}
`;

/** Stored before the text column existed: `read_document` has to say so rather than read a file. */
const LEGACY = `# Legacy notes

The archive rotation job ran nightly before the scheduler replaced it.
`;

interface Fixture {
  database: TestDatabase;
  root: string;
  handbook: ProjectRow;
  empty: ProjectRow;
  strict: ProjectRow;
  ctx: (maxChars?: number) => ToolContext;
}

let fx: Fixture;

function chunksOf(source: string, relativePath: string): { title: string; rows: NewChunk[] } {
  const { title, chunks } = chunkMarkdown(source, relativePath, { maxTokens: 96, overlapTokens: 24, countTokens });
  return {
    title,
    rows: chunks.map((c) => ({
      chunkIndex: c.index,
      headingPath: c.headingPath,
      content: c.content,
      tokenCount: c.tokenCount,
      embedding: stubVector(embeddingText(c)),
    })),
  };
}

async function seed(db: Db, projectId: string, sourceId: string, relativePath: string, body: string, store = true): Promise<void> {
  const { title, rows } = chunksOf(body, relativePath);
  await replaceDocument(
    db,
    {
      projectId,
      sourceId,
      relativePath,
      title,
      contentHash: `hash-${relativePath}`,
      sizeBytes: Buffer.byteLength(body),
      indexGeneration: LIVE,
      version: '',
      ...(store ? storedDocumentContent(body, 1024 * 1024) : { content: null, contentTruncated: false }),
    },
    rows,
  );
}

type Request = { method: string; params?: Record<string, unknown> };

/**
 * One session: `initialize` at the newest protocol version the SDK speaks, then each request in turn,
 * every reply returned exactly as it came off the transport.
 */
async function session(project: ProjectRow, ctx: ToolContext, requests: Request[]): Promise<JSONRPCMessage[]> {
  const server = new McpServer({ name: 'contextator-golden', version: '0.0.0' });
  registerTools(server, ctx, project);
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
    await send('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'golden', version: '0.0.0' } });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const replies: JSONRPCMessage[] = [];
    for (const request of requests) replies.push(await send(request.method, request.params));
    return replies;
  } finally {
    await clientTransport.close();
    await server.close();
  }
}

const golden = (message: JSONRPCMessage): string => `${JSON.stringify(message, null, 2)}\n`;

interface Case {
  slug: string;
  tool: string;
  args: Record<string, unknown>;
  project?: 'handbook' | 'empty' | 'strict';
  maxChars?: number;
}

const CASES: Case[] = [
  // search_docs — one per outcome.
  { slug: 'search-results', tool: 'search_docs', args: { query: 'Page 7 short page number 7', limit: 1 } },
  { slug: 'search-results-several', tool: 'search_docs', args: { query: 'Set DISPATCH_WORKERS to the number of cores', limit: 3 } },
  { slug: 'search-no-match-under-prefix', tool: 'search_docs', args: { query: 'install the package', path_prefix: 'handbook/nowhere' } },
  { slug: 'search-below-server-floor', tool: 'search_docs', args: { query: 'zebra quantum marmalade' } },
  { slug: 'search-below-project-floor', tool: 'search_docs', args: { query: 'Page 3 short page number 3', limit: 1 }, project: 'strict' },
  { slug: 'search-not-indexed', tool: 'search_docs', args: { query: 'install the package' }, project: 'empty' },
  { slug: 'search-error-unknown-source', tool: 'search_docs', args: { query: 'install the package', source: 'elsewhere' } },
  { slug: 'search-error-unknown-version', tool: 'search_docs', args: { query: 'install the package', version: 'v9' } },
  { slug: 'search-error-invalid-prefix', tool: 'search_docs', args: { query: 'install the package', path_prefix: '../outside' } },
  { slug: 'search-error-invalid-arguments', tool: 'search_docs', args: { query: '', limit: 0 } },
  // The budget, at the smallest SEARCH_MAX_RESULT_CHARS the config takes and one step above it.
  // Alone and over budget: the text cuts inside the excerpt.
  { slug: 'search-budget-cut', tool: 'search_docs', args: { query: 'Set DISPATCH_WORKERS to the number of cores', limit: 1 }, maxChars: 500 },
  // Over budget with hits behind it: those are dropped and the first is shown whole (decision C.14).
  { slug: 'search-budget-first-whole', tool: 'search_docs', args: { query: 'Set DISPATCH_WORKERS to the number of cores', limit: 3 }, maxChars: 500 },
  // The first fits and later ones do not: whole excerpts dropped from the end.
  { slug: 'search-budget-omitted', tool: 'search_docs', args: { query: 'Set DISPATCH_WORKERS to the number of cores', limit: 3 }, maxChars: 1000 },
  // list_topics
  { slug: 'list-whole-project', tool: 'list_topics', args: {} },
  { slug: 'list-first-page', tool: 'list_topics', args: { limit: 5 } },
  {
    slug: 'list-continuation',
    tool: 'list_topics',
    args: { limit: 5, cursor: Buffer.from('handbook/pages/page-02.md', 'utf8').toString('base64url') },
  },
  { slug: 'list-past-the-end', tool: 'list_topics', args: { limit: 5, cursor: Buffer.from('zzz', 'utf8').toString('base64url') } },
  { slug: 'list-empty-project', tool: 'list_topics', args: {}, project: 'empty' },
  { slug: 'list-error-foreign-cursor', tool: 'list_topics', args: { cursor: 'not a cursor' } },
  // read_document
  { slug: 'read-whole', tool: 'read_document', args: { path: 'handbook/guide.md' } },
  { slug: 'read-by-suffix', tool: 'read_document', args: { path: 'guide.md' } },
  { slug: 'read-cut-at-budget', tool: 'read_document', args: { path: 'handbook/manual.md', max_tokens: 300 } },
  { slug: 'read-section', tool: 'read_document', args: { path: 'handbook/guide.md', heading: 'Delivery guide > Install' } },
  { slug: 'read-range-cut', tool: 'read_document', args: { path: 'handbook/manual.md', from: 2, to: 30, max_tokens: 400 } },
  { slug: 'read-range-whole', tool: 'read_document', args: { path: 'handbook/manual.md', from: 0, to: 1 } },
  { slug: 'read-section-no-stored-text', tool: 'read_document', args: { path: 'handbook/legacy.md', heading: 'Legacy notes' } },
  { slug: 'read-error-no-stored-text', tool: 'read_document', args: { path: 'handbook/legacy.md' } },
  { slug: 'read-error-unknown-document', tool: 'read_document', args: { path: 'handbook/nope.md' } },
  { slug: 'read-error-no-such-heading', tool: 'read_document', args: { path: 'handbook/guide.md', heading: 'Backup and restore' } },
  { slug: 'read-error-reversed-range', tool: 'read_document', args: { path: 'handbook/manual.md', from: 5, to: 2 } },
  { slug: 'read-error-invalid-path', tool: 'read_document', args: { path: '../../etc/passwd' } },
  // No such tool: the protocol's answer, not a tool's.
  { slug: 'call-error-unknown-tool', tool: 'delete_everything', args: {} },
];

beforeAll(async () => {
  const database = await createTestDatabase(baseUrl, 'mcp_golden');
  await applySchema(database, DIMS);
  const root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-golden-'));
  const { db } = database;

  const source = async (project: ProjectRow): Promise<string> => {
    const [row] = await db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } })
      .returning();
    return row.id;
  };

  const [handbook] = await db.insert(projects).values({ name: 'handbook-project', embeddingModel: MODEL_ID }).returning();
  const handbookSource = await source(handbook);
  await seed(db, handbook.id, handbookSource, 'handbook/guide.md', GUIDE);
  await seed(db, handbook.id, handbookSource, 'handbook/manual.md', MANUAL);
  await seed(db, handbook.id, handbookSource, 'handbook/legacy.md', LEGACY, false);
  for (let i = 0; i < 12; i++) {
    const n = String(i).padStart(2, '0');
    await seed(db, handbook.id, handbookSource, `handbook/pages/page-${n}.md`, `# Page ${i}\n\nShort page number ${i}.\n`);
  }
  await db.update(projects).set({ documentCount: 15, chunkCount: 99 }).where(eq(projects.id, handbook.id));

  const [empty] = await db.insert(projects).values({ name: 'empty-project', embeddingModel: MODEL_ID }).returning();

  // A floor of its own, above anything the stub embedding scores: the refusal names the project's floor.
  const [strict] = await db.insert(projects).values({ name: 'strict-project', embeddingModel: MODEL_ID, scoreFloor: 0.99 }).returning();
  const strictSource = await source(strict);
  await seed(db, strict.id, strictSource, 'handbook/page-03.md', '# Page 3\n\nShort page number 3.\n');
  await db.update(projects).set({ documentCount: 1, chunkCount: 1 }).where(eq(projects.id, strict.id));

  const env = { DATABASE_URL: database.url, ALLOWED_DOC_ROOTS: path.dirname(root), DATA_DIR: path.join(root, '.data'), SECRET_KEY: '0'.repeat(64) };
  const ctx = (maxChars?: number): ToolContext => ({
    db,
    embeddings,
    config: loadConfig(maxChars === undefined ? env : { ...env, SEARCH_MAX_RESULT_CHARS: String(maxChars) }),
    log: silentLogger,
  });
  fx = { database, root, handbook, empty, strict, ctx };
});

afterAll(async () => {
  await rm(fx.root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, fx.database);
});

describe('the MCP tool surface, as recorded before structured output', () => {
  it('lists the same tools, with the same definitions', async () => {
    const [list] = await session(fx.handbook, fx.ctx(), [{ method: 'tools/list', params: {} }]);
    await expect(golden(list)).toMatchFileSnapshot(path.join(GOLDEN_DIR, 'tools-list.txt'));
  });

  it.each(CASES)('$slug', async ({ slug, tool, args, project = 'handbook', maxChars }) => {
    const [reply] = await session(fx[project], fx.ctx(maxChars), [{ method: 'tools/call', params: { name: tool, arguments: args } }]);
    await expect(golden(reply)).toMatchFileSnapshot(path.join(GOLDEN_DIR, `${slug}.txt`));
  });
});
