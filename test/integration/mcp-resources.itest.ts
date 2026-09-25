import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { documentSources, projects, type ProjectRow } from '../../src/db/schema.js';
import { RESOURCE_LIST_PAGE_SIZE, RESOURCE_NOT_FOUND, documentUri, parseDocumentUri, registerResources } from '../../src/mcp/resources.js';
import { getDocument, listDocumentsForProject, replaceDocument } from '../../src/services/vector-store.js';
import { seedDocument, seedProject, startMcpInstance, stubVector, type LiveInstance } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, type TestDatabase } from './support/postgres.js';

/**
 * The project's documents as MCP resources, against a real PostgreSQL, through a real client.
 *
 * **The negative rows are the point of this file.** A resource is a second way to read a document, and
 * the first way — `read_document` — is fenced in by [ADR-0019](../../.ssot/ADR.md#adr-0019): indexed
 * paths only, of the project the session is bound to, of its live generation. Everything below that
 * expects a refusal names a way the resource surface could have been wider than that: a file that is on
 * disk but was never indexed, a document of a generation that is not live, another project's document at
 * the same path, a path spelled so that it resolves somewhere else, a suffix `read_document` would have
 * guessed. Each of them must come back as the same "not found" a path that never existed gets.
 */

const baseUrl = inject('postgresBaseUrl');

/** Small enough that a project of a few dozen documents needs several pages. */
const PAGE = 7;

const GUIDE = `# Delivery guide

Install the package from the registry before anything else.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

const OTHER_GUIDE = `# Beta guide

BETA-ONLY-MARKER: this text belongs to another project and must never be served to this one.
`;

const SECRET = 'ON-DISK-SECRET-MARKER: this file sits beside an indexed one and was never indexed.';

let database: TestDatabase;
let root: string;
let alpha: ProjectRow;
let beta: ProjectRow;
let generations: ProjectRow;
/** Every path of alpha's live generation, sorted as the database sorts them. */
let alphaLive: string[];

const ENCODED_PATH = 'handbook/Getting started/über #1 100%.md';

/**
 * A path well inside what `read_document` takes (under two hundred characters) whose URI is over a
 * thousand: every CJK character percent-encodes to nine. A bound on the raw URI sized for ASCII paths
 * refused the URI the list had just issued.
 */
const CJK_PATH = `handbook/${Array.from({ length: 5 }, (_, i) => `${'文档说明'.repeat(7)}${i}`).join('/')}.md`;

/** A client and a server joined in memory, with the resource handlers exactly as the factory registers them. */
async function connect(project: ProjectRow, pageSize?: number): Promise<Client> {
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0' });
  registerResources(server, { db: database.db, log: silentLogger }, project, pageSize === undefined ? {} : { pageSize });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'resources-itest', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Every page of `resources/list`, with the size of each. */
async function listAll(client: Client): Promise<{ uris: string[]; pages: number[]; cursors: number }> {
  const uris: string[] = [];
  const pages: number[] = [];
  let cursor: string | undefined;
  let cursors = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await client.listResources(cursor === undefined ? {} : { cursor });
    uris.push(...page.resources.map((r) => r.uri));
    pages.push(page.resources.length);
    if (page.nextCursor === undefined) return { uris, pages, cursors };
    cursors++;
    cursor = page.nextCursor;
  }
  throw new Error('resources/list never ended');
}

/** What a refused read comes back as: the JSON-RPC error, never a result. */
async function refusal(client: Client, uri: string): Promise<{ code: number; message: string }> {
  try {
    const result = await client.readResource({ uri });
    throw new Error(`expected a refusal for ${uri}, got ${JSON.stringify(result).slice(0, 200)}`);
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    return { code: err.code, message: err.message };
  }
}

async function textOf(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  expect(result.contents).toHaveLength(1);
  const [content] = result.contents;
  expect(content.uri).toBe(uri);
  expect(content.mimeType).toBe('text/markdown');
  if (!('text' in content)) throw new Error('expected a text resource');
  return content.text;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'mcp_resources');
  await applySchema(database);
  const { db } = database;

  // A real directory with an indexed file and one beside it that was never indexed, so "not indexed"
  // is a file that exists and could be read, not a path that leads nowhere.
  root = await mkdtemp(path.join(tmpdir(), 'contextator-mcp-resources-'));
  await mkdir(path.join(root, 'disk'), { recursive: true });
  await writeFile(path.join(root, 'disk', 'indexed.md'), '# Indexed\n\nThis one was indexed.\n');
  await writeFile(path.join(root, 'disk', 'secret.md'), `# Secret\n\n${SECRET}\n`);

  alpha = await seedProject(db, 'alpha', { path: 'handbook/guide.md', body: GUIDE });
  const [handbook] = await db.select().from(documentSources).where(eq(documentSources.projectId, alpha.id));
  const [disk] = await db
    .insert(documentSources)
    .values({ projectId: alpha.id, type: 'local', name: 'disk', config: { path: path.join(root, 'disk'), extensions: ['md'] } })
    .returning();
  await seedDocument(db, alpha.id, disk.id, 'disk/indexed.md', '# Indexed\n\nThis one was indexed.\n');
  await seedDocument(db, alpha.id, handbook.id, ENCODED_PATH, '# Getting started\n\nA path with spaces, an umlaut, a hash and a percent sign.\n');
  await seedDocument(db, alpha.id, handbook.id, CJK_PATH, '# 文档\n\nCJK-PATH-MARKER: a path whose URI is several times its length.\n');
  // More than one default page, so "a large project is not answered at once" is a claim about the
  // default and not only about the small page the other cases use.
  for (let i = 0; i < RESOURCE_LIST_PAGE_SIZE + 3; i++) {
    await seedDocument(db, alpha.id, handbook.id, `handbook/pages/page-${String(i).padStart(3, '0')}.md`, `# Page ${i}\n\nShort page number ${i}.\n`);
  }
  // A row written before the document text was stored (ADR-0043): indexed, and nothing to serve.
  await replaceDocument(
    db,
    {
      projectId: alpha.id,
      sourceId: handbook.id,
      relativePath: 'handbook/legacy.md',
      title: 'Legacy',
      contentHash: 'hash-legacy',
      sizeBytes: 20,
      indexGeneration: 0,
      version: '',
      content: null,
      contentTruncated: false,
    },
    [{ chunkIndex: 0, headingPath: 'Legacy', content: 'Legacy text.', tokenCount: 3, embedding: stubVector('Legacy text.') }],
  );
  // A generation being built beside the live one: indexed, but not yet what the project serves.
  await replaceDocument(
    db,
    {
      projectId: alpha.id,
      sourceId: handbook.id,
      relativePath: 'handbook/next-generation.md',
      title: 'Next generation',
      contentHash: 'hash-next',
      sizeBytes: 30,
      indexGeneration: 1,
      version: '',
      content: '# Next generation\n\nNEXT-GENERATION-MARKER\n',
      contentTruncated: false,
    },
    [{ chunkIndex: 0, headingPath: 'Next generation', content: 'NEXT-GENERATION-MARKER', tokenCount: 3, embedding: stubVector('next') }],
  );
  alphaLive = (await listDocumentsForProject(db, alpha.id, 0, { limit: 10_000 })).map((d) => d.relativePath);

  // Another project, holding a document at the same path as alpha's and one alpha does not have.
  beta = await seedProject(db, 'beta', { path: 'handbook/guide.md', body: OTHER_GUIDE });
  const [betaSource] = await db.select().from(documentSources).where(eq(documentSources.projectId, beta.id));
  await seedDocument(db, beta.id, betaSource.id, 'handbook/beta-only.md', OTHER_GUIDE);

  // A project whose live generation is flipped mid-session.
  generations = await seedProject(db, 'generations', { path: 'handbook/old.md', body: '# Old\n\nOLD-GENERATION-MARKER\n' });
  const [genSource] = await db.select().from(documentSources).where(eq(documentSources.projectId, generations.id));
  await replaceDocument(
    db,
    {
      projectId: generations.id,
      sourceId: genSource.id,
      relativePath: 'handbook/new.md',
      title: 'New',
      contentHash: 'hash-new',
      sizeBytes: 30,
      indexGeneration: 1,
      version: '',
      content: '# New\n\nNEW-GENERATION-MARKER\n',
      contentTruncated: false,
    },
    [{ chunkIndex: 0, headingPath: 'New', content: 'NEW-GENERATION-MARKER', tokenCount: 3, embedding: stubVector('new') }],
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, database);
});

describe('resources/list', () => {
  it('declares the resources capability, without list-changed notifications', async () => {
    const client = await connect(alpha, PAGE);
    try {
      expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: false });
    } finally {
      await client.close();
    }
  });

  it("lists exactly the live generation's indexed paths of this project, each once, across pages", async () => {
    const client = await connect(alpha, PAGE);
    try {
      const { uris, pages, cursors } = await listAll(client);
      const paths = uris.map((uri) => parseDocumentUri(uri));
      expect(paths.every((p) => p?.project === 'alpha')).toBe(true);
      expect(paths.map((p) => p?.relativePath)).toEqual(alphaLive);
      expect(new Set(uris).size).toBe(uris.length);

      // Neither the file beside an indexed one, nor the generation being built, nor beta.
      expect(alphaLive).toContain('disk/indexed.md');
      expect(alphaLive).not.toContain('disk/secret.md');
      expect(alphaLive).not.toContain('handbook/next-generation.md');
      expect(uris.some((uri) => uri.includes('beta'))).toBe(false);

      // Paged, every page but the last full, and the last one without a cursor.
      expect(pages.every((n) => n <= PAGE)).toBe(true);
      expect(pages.slice(0, -1).every((n) => n === PAGE)).toBe(true);
      expect(pages.length).toBe(Math.ceil(alphaLive.length / PAGE));
      expect(cursors).toBe(pages.length - 1);
    } finally {
      await client.close();
    }
  });

  it('answers a project larger than one page with one page at the default size', async () => {
    expect(alphaLive.length).toBeGreaterThan(RESOURCE_LIST_PAGE_SIZE);
    const client = await connect(alpha);
    try {
      const first = await client.listResources();
      expect(first.resources).toHaveLength(RESOURCE_LIST_PAGE_SIZE);
      expect(first.nextCursor).toBeTypeOf('string');
      const second = await client.listResources({ cursor: first.nextCursor });
      expect(second.resources).toHaveLength(alphaLive.length - RESOURCE_LIST_PAGE_SIZE);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('describes each document by its URI, its indexed path and its title', async () => {
    const client = await connect(alpha, PAGE);
    try {
      const { resources } = await client.listResources();
      expect(resources.length).toBeGreaterThan(0);
      for (const r of resources) {
        const parsed = parseDocumentUri(r.uri);
        expect(r.name).toBe(parsed?.relativePath);
        expect(r.mimeType).toBe('text/markdown');
        expect(typeof r.title).toBe('string');
      }
    } finally {
      await client.close();
    }
  });

  it('refuses a cursor it did not issue', async () => {
    const client = await connect(alpha, PAGE);
    try {
      await expect(client.listResources({ cursor: 'not-a-cursor!' })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await client.close();
    }
  });

  it("publishes one template, for this project's documents", async () => {
    const client = await connect(alpha, PAGE);
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates).toHaveLength(1);
      expect(resourceTemplates[0].uriTemplate).toBe('contextator://alpha/{+path}');
    } finally {
      await client.close();
    }
  });
});

describe('resources/read — what it serves', () => {
  it('serves an indexed document, the stored text read_document serves', async () => {
    const client = await connect(alpha, PAGE);
    try {
      const text = await textOf(client, documentUri('alpha', 'handbook/guide.md'));
      const row = await getDocument(database.db, alpha.id, 0, 'handbook/guide.md');
      expect(text).toBe(row?.content);
      expect(text).toBe(GUIDE);
    } finally {
      await client.close();
    }
  });

  it('serves a path that needed percent-encoding, by the URI the list issued', async () => {
    const client = await connect(alpha, PAGE);
    try {
      const { uris } = await listAll(client);
      const uri = uris.find((u) => parseDocumentUri(u)?.relativePath === ENCODED_PATH);
      expect(uri).toBe(documentUri('alpha', ENCODED_PATH));
      expect(await textOf(client, uri as string)).toContain('an umlaut, a hash and a percent sign');
    } finally {
      await client.close();
    }
  });

  it('serves a path whose URI percent-encoding made far longer than the path, by the URI the list issued', async () => {
    const client = await connect(alpha, PAGE);
    try {
      expect(CJK_PATH.length).toBeLessThan(200);
      const { uris } = await listAll(client);
      const uri = uris.find((u) => parseDocumentUri(u)?.relativePath === CJK_PATH);
      expect(uri).toBe(documentUri('alpha', CJK_PATH));
      expect((uri as string).length).toBeGreaterThan(1024 + 128);
      expect(await textOf(client, uri as string)).toContain('CJK-PATH-MARKER');
    } finally {
      await client.close();
    }
  });

  it('serves every URI the list issued', async () => {
    const client = await connect(alpha, PAGE);
    try {
      const { uris } = await listAll(client);
      const readable = uris.filter((u) => !u.endsWith('/legacy.md'));
      for (const uri of readable) expect((await textOf(client, uri)).length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

describe('resources/read — what it refuses', () => {
  const cases: Array<[string, () => string]> = [
    ['a file on disk beside an indexed one, never indexed', () => documentUri('alpha', 'disk/secret.md')],
    ['a document of a generation that is not live', () => documentUri('alpha', 'handbook/next-generation.md')],
    ["another project's document at a path this project also has", () => documentUri('beta', 'handbook/guide.md')],
    ["another project's document this project does not have", () => documentUri('beta', 'handbook/beta-only.md')],
    ['a project that does not exist', () => documentUri('nobody', 'handbook/guide.md')],
    ['a path that was never indexed anywhere', () => documentUri('alpha', 'handbook/missing.md')],
    ['a suffix read_document would have resolved', () => 'contextator://alpha/guide.md'],
    ['the source alone', () => 'contextator://alpha/handbook'],
    ['a dot-dot walk from an indexed path to the file beside it', () => 'contextator://alpha/handbook/../disk/secret.md'],
    ['an encoded dot-dot walk', () => 'contextator://alpha/handbook/%2E%2E/disk/secret.md'],
    ['an encoded slash', () => 'contextator://alpha/disk%2Fsecret.md'],
    ['an absolute path under another scheme', () => `file://${path.join(root, 'disk', 'secret.md')}`],
    ['the file path itself as the resource path', () => `contextator://alpha${path.join(root, 'disk', 'secret.md')}`],
    ['an indexed path with different case', () => documentUri('alpha', 'handbook/Guide.md')],
  ];

  it.each(cases)('%s', async (_label, uri) => {
    const client = await connect(alpha, PAGE);
    try {
      const refused = await refusal(client, uri());
      expect(refused.code).toBe(RESOURCE_NOT_FOUND);
      // The same answer a path that never existed gets, and nothing of what is behind it.
      expect(refused.message).toContain('Resource not found');
      for (const marker of ['ON-DISK-SECRET-MARKER', 'NEXT-GENERATION-MARKER', 'BETA-ONLY-MARKER']) expect(refused.message).not.toContain(marker);
    } finally {
      await client.close();
    }
  });

  it("answers another project's URI exactly as a path that never existed", async () => {
    const client = await connect(alpha, PAGE);
    try {
      const other = await refusal(client, documentUri('beta', 'handbook/guide.md'));
      const missing = await refusal(client, documentUri('nobody', 'handbook/guide.md'));
      expect(other.message.replace('beta', 'X')).toBe(missing.message.replace('nobody', 'X'));
    } finally {
      await client.close();
    }
  });

  it('refuses a document indexed before its text was stored, and says how to fix it', async () => {
    const client = await connect(alpha, PAGE);
    try {
      const refused = await refusal(client, documentUri('alpha', 'handbook/legacy.md'));
      expect(refused.code).toBe(RESOURCE_NOT_FOUND);
      expect(refused.message).toContain('re-index');
    } finally {
      await client.close();
    }
  });

  it('follows the live generation within one session, as the list does', async () => {
    const client = await connect(generations, PAGE);
    try {
      const oldUri = documentUri('generations', 'handbook/old.md');
      const newUri = documentUri('generations', 'handbook/new.md');
      expect(await textOf(client, oldUri)).toContain('OLD-GENERATION-MARKER');
      expect((await refusal(client, newUri)).code).toBe(RESOURCE_NOT_FOUND);

      await database.db.update(projects).set({ liveGeneration: 1 }).where(eq(projects.id, generations.id));
      expect(await textOf(client, newUri)).toContain('NEW-GENERATION-MARKER');
      expect((await refusal(client, oldUri)).code).toBe(RESOURCE_NOT_FOUND);
      expect((await listAll(client)).uris).toEqual([newUri]);
    } finally {
      await client.close();
    }
  });
});

describe('over the real endpoint', () => {
  let live: LiveInstance;

  beforeAll(async () => {
    live = await startMcpInstance(database, { dataDir: path.join(root, '.data'), docRoot: root });
  });

  afterAll(async () => {
    await live?.close();
  });

  async function httpClient(project: ProjectRow): Promise<Client> {
    const client = new Client({ name: 'resources-http-itest', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${live.origin}/mcp/${project.name}`)));
    return client;
  }

  it("lists, pages and reads this project's documents, and refuses another's, through the router", async () => {
    const client = await httpClient(alpha);
    try {
      expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: false });
      expect(client.getServerCapabilities()?.tools).toBeDefined();

      const first = await client.listResources();
      expect(first.resources).toHaveLength(RESOURCE_LIST_PAGE_SIZE);
      expect(first.nextCursor).toBeTypeOf('string');

      expect(await textOf(client, documentUri('alpha', 'handbook/guide.md'))).toBe(GUIDE);
      expect((await refusal(client, documentUri('beta', 'handbook/guide.md'))).code).toBe(RESOURCE_NOT_FOUND);
      expect((await refusal(client, documentUri('alpha', 'disk/secret.md'))).code).toBe(RESOURCE_NOT_FOUND);
    } finally {
      await client.close();
    }
  });

  it("serves beta's session beta's text at the same path", async () => {
    const client = await httpClient(beta);
    try {
      expect(await textOf(client, documentUri('beta', 'handbook/guide.md'))).toBe(OTHER_GUIDE);
      expect((await refusal(client, documentUri('alpha', 'handbook/guide.md'))).code).toBe(RESOURCE_NOT_FOUND);
    } finally {
      await client.close();
    }
  });
});
