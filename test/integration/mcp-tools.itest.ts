import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documents, documentSources, projects, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { replaceDocument, storedDocumentContent, type NewChunk } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The three MCP tools, driven through a real client over a real `McpServer`, against a real PostgreSQL
 * ([ADR-0043](../../.ssot/ADR.md#adr-0043), [ADR-0031](../../.ssot/ADR.md#adr-0031)).
 *
 * **Through the client and not by calling the handler.** What changed in this PR is a tool *contract* —
 * three new arguments with defaults and bounds, and a cursor an agent has to be able to hand back — and
 * every one of those is enforced by the SDK between the client and the handler. A test that reached
 * past it would assert that the code works and prove nothing about the tool.
 *
 * The embedding provider is a stub with a *deliberately expensive* token counter, so that a budget
 * measured in tokens can be told apart from one measured in characters.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const LIVE = 0;

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

/** Three times `estimateTokens`, so a cut that moved with characters instead of tokens is visible. */
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

/** Every log line the tools emit during one call, so "it logs that it did" is an assertion. */
interface Recorded {
  level: string;
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(sink: Recorded[]): ToolContext['log'] {
  const at =
    (level: string) =>
    (fields: unknown, message?: unknown): void => {
      if (typeof fields === 'object' && fields !== null)
        sink.push({ level, fields: fields as Record<string, unknown>, message: String(message ?? '') });
      else sink.push({ level, fields: {}, message: String(fields ?? '') });
    };
  const logger = {
    level: 'silent',
    silent: () => {},
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: () => logger,
  };
  return logger as unknown as ToolContext['log'];
}

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

interface Fixture {
  database: TestDatabase;
  project: ProjectRow;
  ctx: ToolContext;
  logs: Recorded[];
  root: string;
}

let fx: Fixture;

/** Chunks a document the way the indexer does, so the chunk indices and breadcrumbs are the product's. */
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

async function seed(db: Db, projectId: string, sourceId: string, relativePath: string, body: string, opts: { store: boolean }): Promise<void> {
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
      // `store: false` is a document written before ADR-0043 — the state every existing installation
      // is in until its next index run, and the only thing the filesystem fallback exists for.
      ...(opts.store ? storedDocumentContent(body, 1024 * 1024) : { content: null, contentTruncated: false }),
    },
    rows,
  );
}

/** A client and a server joined by an in-memory transport pair, closed by the caller. */
async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0' });
  registerTools(server, fx.ctx, fx.project);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'itest', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    return { text: content.find((c) => c.type === 'text')?.text ?? '', isError: result.isError === true };
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  const database = await createTestDatabase(baseUrl, 'mcp_tools');
  await applySchema(database, DIMS);
  const root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-tools-'));

  const [project] = await database.db.insert(projects).values({ name: 'handbook-project', embeddingModel: MODEL_ID }).returning();
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } })
    .returning();

  await seed(database.db, project.id, source.id, 'handbook/guide.md', GUIDE, { store: true });
  await seed(database.db, project.id, source.id, 'handbook/manual.md', MANUAL, { store: true });
  // Written before the column existed, and its file *is* on disk: the fallback's happy path.
  await seed(database.db, project.id, source.id, 'handbook/legacy.md', GUIDE, { store: false });
  // Its file is still on disk, and since [ADR-0051](../../.ssot/ADR.md#adr-0051) that makes no
  // difference at all — which is the assertion, not a leftover.
  await writeFile(path.join(root, 'legacy.md'), GUIDE, 'utf8');
  // The same row with no file beside it. Both answer the same sentence now.
  await seed(database.db, project.id, source.id, 'handbook/vanished.md', GUIDE, { store: false });

  for (let i = 0; i < 12; i++) {
    await seed(
      database.db,
      project.id,
      source.id,
      `handbook/pages/page-${String(i).padStart(2, '0')}.md`,
      `# Page ${i}\n\nShort page number ${i}.\n`,
      {
        store: true,
      },
    );
  }
  await database.db.update(projects).set({ documentCount: 16, chunkCount: 99 }).where(eq(projects.id, project.id));

  const logs: Recorded[] = [];
  const config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: path.dirname(root),
    DATA_DIR: path.join(root, '.data'),
    SECRET_KEY: '0'.repeat(64),
  });
  fx = { database, project, root, logs, ctx: { db: database.db, embeddings, config, log: recordingLogger(logs) } };
});

afterAll(async () => {
  await rm(fx.root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, fx.database);
});

describe('read_document off the filesystem', () => {
  it('serves a document whose file has been deleted', async () => {
    // The file was never written for this path, which is the same thing as one deleted after indexing.
    const answer = await call('read_document', { path: 'handbook/guide.md' });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('File: handbook/guide.md');
    expect(answer.text).toContain('Title: Delivery guide');
    expect(answer.text).toContain('DISPATCH_WORKERS');
  });

  it('returns the transformed text the chunks were cut from, not a re-read of the file', async () => {
    // The file on disk under `legacy.md` holds GUIDE; `guide.md` has no file at all and answers anyway.
    const answer = await call('read_document', { path: 'handbook/guide.md', max_tokens: 20000 });
    expect(answer.text).toContain('Run the published image with the compose file');
  });
});

describe('read_document heading', () => {
  it('returns only that section and the subsections under it', async () => {
    const answer = await call('read_document', { path: 'handbook/guide.md', heading: 'Delivery guide > Install' });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('Section: Delivery guide > Install');
    expect(answer.text).toContain('Install the package from the registry');
    // The subsection under it is included...
    expect(answer.text).toContain('Run the published image');
    // ...and the sibling section is not.
    expect(answer.text).not.toContain('DISPATCH_WORKERS');
  });

  it('matches a breadcrumb whatever its capitalisation', async () => {
    const answer = await call('read_document', { path: 'handbook/guide.md', heading: 'delivery guide > tuning' });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('DISPATCH_WORKERS');
  });

  it('names the sections it does have when the heading matches none', async () => {
    const answer = await call('read_document', { path: 'handbook/guide.md', heading: 'Backup and restore' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('has no section matching "Backup and restore"');
    expect(answer.text).toContain('Delivery guide > Install');
  });

  it('reads a range of chunks', async () => {
    const answer = await call('read_document', { path: 'handbook/manual.md', from: 0, to: 0, max_tokens: 20000 });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('Chunks: 0-0 of');
    expect(answer.text).toContain('Paragraph 0 ');
    expect(answer.text).not.toContain('Paragraph 30 ');
  });

  it('refuses a range that is the wrong way round', async () => {
    const answer = await call('read_document', { path: 'handbook/manual.md', from: 5, to: 2 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('is before');
  });
});

describe('read_document max_tokens', () => {
  it('cuts a whole document at a real token count and says how to ask for the rest', async () => {
    const answer = await call('read_document', { path: 'handbook/manual.md', max_tokens: 300 });
    expect(answer.isError).toBe(false);
    const body = answer.text.split('\n---\n\n')[1];
    expect(countTokens(body.split('\n\n[')[0])).toBeLessThanOrEqual(300);
    expect(answer.text).toContain('…truncated at 300 tokens');
    expect(answer.text).toContain('heading:');
  });

  it('is a budget in tokens and not in characters', async () => {
    // The stub counts three tokens where `estimateTokens` counts one. A budget that was secretly a
    // character count would return three times this much text.
    const answer = await call('read_document', { path: 'handbook/manual.md', max_tokens: 300 });
    const body = answer.text.split('\n---\n\n')[1].split('\n\n[')[0];
    expect(body.length).toBeLessThan(300 * 4);
  });

  it('cuts a sectional read on a chunk boundary and points at the chunk to continue from', async () => {
    const answer = await call('read_document', { path: 'handbook/manual.md', from: 0, max_tokens: 300 });
    expect(answer.text).toMatch(/Call read_document again with from: \d+ for the rest/);
    const continuation = /from: (\d+) for the rest/.exec(answer.text)?.[1];
    expect(continuation).toBeDefined();
    const next = await call('read_document', { path: 'handbook/manual.md', from: Number(continuation), max_tokens: 300 });
    expect(next.isError).toBe(false);
    expect(next.text).toContain(`Chunks: ${continuation}-`);
  });

  it('defaults to a budget rather than to the whole file', async () => {
    const answer = await call('read_document', { path: 'handbook/manual.md' });
    const body = answer.text.split('\n---\n\n')[1].split('\n\n[')[0];
    expect(countTokens(body)).toBeLessThanOrEqual(4000);
  });
});

/**
 * **`content IS NULL` after the fallback was deleted** ([ADR-0051](../../.ssot/ADR.md#adr-0051),
 * on the schedule [ADR-0043](../../.ssot/ADR.md#adr-0043) set).
 *
 * These three cases are the same three the fallback had, and two of their answers changed. The one
 * that matters is the first: `handbook/legacy.md` has its file sitting on disk, readable, right where
 * the deleted code would have found it — and the tool does not read it. That is what makes this a test
 * of the deletion rather than of a missing file.
 */
describe('a document written before the text was stored', () => {
  it('does not read the file, even when the file is right there', async () => {
    fx.logs.length = 0;
    const answer = await call('read_document', { path: 'handbook/legacy.md', max_tokens: 20000 });
    // The file under `legacy.md` holds GUIDE, whose body contains this sentence. Nothing returns it.
    expect(answer.text).not.toContain('Run the published image with the compose file');
    expect(answer.text).toContain('was indexed before this version stored document text');
    expect(answer.text).toContain('Re-index');
    expect(fx.logs.some((l) => l.message.includes('served a document from the filesystem'))).toBe(false);
    const line = fx.logs.find((l) => l.message.includes('no stored text'));
    expect(line?.level).toBe('info');
    expect(line?.fields).toMatchObject({ tool: 'read_document', file: 'handbook/legacy.md' });
  });

  it('answers the same sentence when there is no file either', async () => {
    const answer = await call('read_document', { path: 'handbook/vanished.md' });
    expect(answer.text).toContain('was indexed before this version stored document text');
    // It points at the two ways out: a re-index, and the sectional read that works right now.
    expect(answer.text).toContain('Re-index');
    expect(answer.text).toContain('heading:');
  });

  it('serves a section out of the chunks even while the stored text is missing', async () => {
    // The whole point of resolving `heading` against `chunks.heading_path`: the chunks were always
    // there, so a sectional read needs no migration and never needed the filesystem.
    fx.logs.length = 0;
    const answer = await call('read_document', { path: 'handbook/vanished.md', heading: 'Delivery guide > Tuning' });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('DISPATCH_WORKERS');
    expect(fx.logs.some((l) => l.message.includes('filesystem'))).toBe(false);
  });
});

describe('list_topics pagination', () => {
  it('pages through a corpus larger than one page, and the pages do not overlap', async () => {
    const first = await call('list_topics', { limit: 5 });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('16 documents, 99 chunks');
    expect(first.text).toContain('Sources (the first path segment): handbook');
    const cursor = /next_cursor: (\S+)/.exec(first.text)?.[1];
    expect(cursor).toBeDefined();

    const seen: string[] = [];
    const paths = (text: string): string[] => [...text.matchAll(/^ {2}• (\S+) /gm)].map((m) => m[1]);
    seen.push(...paths(first.text));

    let next: string | undefined = cursor;
    for (let page = 0; page < 10 && next; page++) {
      const answer: { text: string; isError: boolean } = await call('list_topics', { limit: 5, cursor: next });
      expect(answer.isError).toBe(false);
      seen.push(...paths(answer.text));
      next = /next_cursor: (\S+)/.exec(answer.text)?.[1];
    }

    expect(seen).toHaveLength(16);
    expect(new Set(seen).size).toBe(16);
    expect([...seen].sort()).toEqual(seen);
    // The source list is on the first page only; continuation pages say where they resume instead.
    expect(await call('list_topics', { limit: 5, cursor }).then((a) => a.text)).toContain('Continuing after');
  });

  it('issues a stable cursor: the same one returns the same page', async () => {
    const first = await call('list_topics', { limit: 4 });
    const cursor = /next_cursor: (\S+)/.exec(first.text)?.[1];
    const a = await call('list_topics', { limit: 4, cursor });
    const b = await call('list_topics', { limit: 4, cursor });
    expect(a.text).toBe(b.text);
  });

  it('refuses a cursor it did not issue rather than starting somewhere arbitrary', async () => {
    const answer = await call('list_topics', { cursor: 'not a cursor!!' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('not one this tool issued');
  });

  it('returns every document in one call when the whole project fits', async () => {
    const answer = await call('list_topics', {});
    expect(answer.text).not.toContain('next_cursor');
    expect([...answer.text.matchAll(/^ {2}• /gm)]).toHaveLength(16);
  });
});

describe('the stored text', () => {
  it('is the text the chunks were cut from', async () => {
    const [row] = await fx.database.db.select().from(documents).where(eq(documents.relativePath, 'handbook/guide.md'));
    expect(row.content).toBe(GUIDE);
    expect(row.contentTruncated).toBe(false);
  });
});
