import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';

import { adminRoutes } from '../../src/admin/routes.js';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, documents, projects, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById, ValidationError } from '../../src/services/projects.js';
import { createSource } from '../../src/services/sources.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A source of API specifications, taken through the real indexer and asked for through the real MCP
 * tools ([ADR-0057](../../.ssot/ADR.md#adr-0057)).
 *
 * **The unit tests prove what one specification expands into; this proves the incremental run can live
 * with it.** Everything below the expansion assumes one file is one document — the hash check, `seen`,
 * the deletion sweep, `documents_project_generation_path_uq` — and none of that is exercised by calling
 * `expandOpenApi` in isolation. What is only observable from here: a re-run skipping a file that is
 * forty documents, an operation deleted from a specification taking exactly its own document with it,
 * and the same specification written in another order producing no change at all.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'openapi');
/** The credential the source-editing route is driven with; nothing else in this file authenticates. */
const ADMIN_TOKEN = 'a-token-for-a-test';

/** The six operations of `petstore.yaml` and the two of `legacy-swagger.json`, plus the README. */
const PETSTORE_OPERATIONS = 6;
const SWAGGER_OPERATIONS = 2;
const DOCUMENTS = PETSTORE_OPERATIONS + SWAGGER_OPERATIONS + 1;

/** The deterministic stand-in the other indexing tests use: a hashed bag of words, L2-normalised. */
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

const embeddings: EmbeddingProvider = {
  id: MODEL_ID,
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: estimateTokens,
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => texts.map(stubVector),
  embedQuery: async (text: string) => stubVector(text),
};

interface Fixture {
  database: TestDatabase;
  project: ProjectRow;
  sourceId: string;
  root: string;
  ctx: ToolContext;
}

let fx: Fixture;

async function settle(db: Db, job: JobState): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (;;) {
    const project = await getProjectById(db, job.projectId);
    if (project?.status !== 'indexing') return job;
    if (Date.now() > deadline) throw new Error(`project row still says "indexing" after the job settled as ${job.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeIndexer(db: Db, root: string, overrides: { MAX_SPEC_FILE_BYTES?: number } = {}): Indexer {
  return new Indexer({
    db,
    embeddings,
    config: {
      ALLOWED_DOC_ROOTS: [path.dirname(root)],
      IGNORE_GLOBS: [],
      CHUNK_MAX_TOKENS: 256,
      CHUNK_OVERLAP_TOKENS: 32,
      EMBEDDING_BATCH_SIZE: 64,
      DATA_DIR: path.join(root, '.data'),
      SECRET_KEY: '0'.repeat(64),
      MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
      MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
      MAX_SPEC_FILE_BYTES: 8 * 1024 * 1024,
      MAX_PDF_PAGES: 2000,
      MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
      ...overrides,
    },
    log: silentLogger,
    locks: new KeyedMutex(),
  });
}

async function reindex(overrides: { MAX_SPEC_FILE_BYTES?: number } = {}): Promise<JobState> {
  const job = await settle(fx.database.db, makeIndexer(fx.database.db, fx.root, overrides).enqueue(fx.project.id));
  expect(job.error ?? null).toBeNull();
  expect(job.phase).toBe('done');
  return job;
}

/** Every stored document of the project: path → id, so a run that moved a row is visible. */
async function storedDocuments(): Promise<Map<string, { id: string; title: string; contentHash: string }>> {
  const rows = await fx.database.db
    .select({ id: documents.id, relativePath: documents.relativePath, title: documents.title, contentHash: documents.contentHash })
    .from(documents)
    .where(eq(documents.projectId, fx.project.id));
  return new Map(rows.map((r) => [r.relativePath, { id: r.id, title: r.title, contentHash: r.contentHash }]));
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0' });
  registerTools(server, fx.ctx, fx.project);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'itest', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    return { text: content.find((c) => c.type === 'text')?.text ?? '', isError: result.isError === true };
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  const database = await createTestDatabase(baseUrl, 'openapi');
  await applySchema(database, DIMS);

  const root = await mkdtemp(path.join(tmpdir(), 'contextator-openapi-'));
  // Four fixtures are the unit tests' subjects — what a renderer does with a cycle, with a hostile
  // example, with a path item that is a `$ref`, with an operation that asks for a hundred thousand
  // lines — and here they would only add documents to every count.
  const UNIT_ONLY = new Set(['cyclic.yaml', 'hostile.yaml', 'path-item-ref.yaml', 'render-bomb.yaml']);
  for (const name of await readdir(FIXTURES)) {
    if (UNIT_ONLY.has(name)) continue;
    await copyFile(path.join(FIXTURES, name), path.join(root, name));
  }

  const [project] = await database.db.insert(projects).values({ name: 'api-specs' }).returning();
  const [source] = await database.db
    .insert(documentSources)
    .values({
      projectId: project.id,
      type: 'local',
      name: 'api',
      flavor: 'openapi',
      config: { path: root, extensions: ['md', 'yaml', 'yml', 'json'] },
    })
    .returning();

  const job = await settle(database.db, makeIndexer(database.db, root).enqueue(project.id));
  expect(job.phase).toBe('done');

  const config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: path.dirname(root),
    DATA_DIR: path.join(root, '.data'),
    SECRET_KEY: '0'.repeat(64),
    // The floor is calibrated against `multilingual-e5-small` ([ADR-0042](../../.ssot/ADR.md#adr-0042));
    // the bag-of-words stub above scores a paraphrase at a third of it. What is under test here is which
    // *document* a query reaches, not how well the shipped model scores it.
    SEARCH_SCORE_FLOOR: '0',
  });
  const reread = (await getProjectById(database.db, project.id)) ?? project;
  fx = { database, project: reread as ProjectRow, sourceId: source.id, root, ctx: { db: database.db, embeddings, config, log: silentLogger } };
}, 180_000);

afterAll(async () => {
  await rm(fx.root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, fx.database);
});

describe('a source of API specifications', () => {
  /** Acceptance criterion 1, first half: N operations become N documents, and `N` is written here. */
  it('indexes one document per operation, and no document for the specification itself', async () => {
    const stored = await storedDocuments();
    expect([...stored.keys()].sort()).toEqual(
      [
        'api/README.md',
        'api/legacy-swagger.json/get-invoices',
        'api/legacy-swagger.json/post-invoices',
        'api/petstore.yaml/delete-pets-petId',
        'api/petstore.yaml/get-pets',
        'api/petstore.yaml/get-pets-petId',
        'api/petstore.yaml/get-pets-petId-photos',
        'api/petstore.yaml/post-stores-storeId-orders',
        'api/petstore.yaml/post-pets',
      ].sort(),
    );
    expect(stored.size).toBe(DOCUMENTS);
    // The container path is not a document, and the Markdown beside the specs still is exactly one.
    expect(stored.has('api/petstore.yaml')).toBe(false);
    expect(stored.get('api/petstore.yaml/delete-pets-petId')?.title).toBe('DELETE /pets/{petId}');
    expect(stored.get('api/README.md')?.title).toBe('Specification sources');
  });

  it('gives every document of one specification the same content hash — the file it came from', async () => {
    const stored = await storedDocuments();
    const hashes = new Set([...stored.entries()].filter(([p]) => p.startsWith('api/petstore.yaml/')).map(([, d]) => d.contentHash));
    expect(hashes.size).toBe(1);
    expect(stored.get('api/README.md')?.contentHash).not.toBe([...hashes][0]);
  });

  it('reports the YAML that is not a specification on its source, and finishes the run anyway', async () => {
    const [source] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, fx.sourceId));
    expect(source.lastError).toMatch(/1 of 4 file\(s\) could not be indexed/);
    expect(source.lastError).toContain('deploy-values.yaml');
    expect(source.lastError).toContain('is not an OpenAPI or Swagger document');
    expect(source.status).toBe('idle');
    const project = await getProjectById(fx.database.db, fx.project.id);
    expect(project?.status).toBe('idle');
    expect(project?.documentCount).toBe(DOCUMENTS);
  });

  /** Acceptance criterion 2: the endpoint's document comes back, not the whole specification. */
  it('answers a question about one endpoint with that endpoint', async () => {
    const cases: Array<[string, string]> = [
      ['list the photographs of one pet', 'api/petstore.yaml/get-pets-petId-photos'],
      ['place an order at one store', 'api/petstore.yaml/post-stores-storeId-orders'],
      ['issue a new invoice', 'api/legacy-swagger.json/post-invoices'],
    ];
    for (const [query, expected] of cases) {
      const answer = await call('search_docs', { query, limit: 10 });
      expect(answer.isError).toBe(false);
      expect(answer.text, `searching for "${query}"`).toContain(expected);
      // There is no such document as "the specification", so no hit can be one.
      expect(answer.text).not.toMatch(/\bapi\/petstore\.yaml\s/);
    }
  });

  it('reads one endpoint back through read_document, and has no document for the file', async () => {
    const del = await call('read_document', { path: 'api/petstore.yaml/delete-pets-petId', max_tokens: 20_000 });
    expect(del.isError).toBe(false);
    expect(del.text).toContain('# DELETE /pets/{petId}');
    expect(del.text).toContain('Deleting a pet cancels every order that has not shipped.');
    expect(del.text).not.toContain('Add a new pet to the store');

    expect((await call('read_document', { path: 'api/petstore.yaml' })).isError).toBe(true);
  });

  it('skips the whole expansion on a second run, because the hash is still over the raw bytes', async () => {
    const before = await storedDocuments();
    const job = await reindex();
    // Three files (two specs and the README) skipped, plus the one that is refused again.
    expect(job.filesSkipped).toBe(4);
    expect(job.chunksDone).toBe(0);
    expect(job.filesRemoved).toBe(0);
    expect(await storedDocuments()).toEqual(before);
  });

  it('refuses .yaml on a content type that cannot read it, rather than scanning nothing', async () => {
    const opts = { allowedRoots: [path.dirname(fx.root)], secretKey: '0'.repeat(64) };
    await expect(
      createSource(fx.database.db, fx.project.id, { type: 'local', name: 'plain-yaml', config: { path: fx.root, extensions: ['md', 'yaml'] } }, opts),
    ).rejects.toThrow(ValidationError);
    // The same extensions are accepted the moment the content type can do something with them.
    const created = await createSource(
      fx.database.db,
      fx.project.id,
      { type: 'local', name: 'more-specs', flavor: 'openapi', config: { path: fx.root, extensions: ['md', 'yaml'] } },
      opts,
    );
    expect(created.flavor).toBe('openapi');
    await fx.database.db.delete(documentSources).where(eq(documentSources.id, created.id));
  });

  /**
   * The ceiling is its own, and much lower than the conversion one, because a specification is parsed
   * whole into an object graph around sixty times its size. It is checked on the size the **scan**
   * recorded, so an oversized file is refused without ever being read.
   */
  it('refuses a specification over the parse ceiling, and keeps the documents it already had', async () => {
    const before = await storedDocuments();
    // Low enough to refuse both specifications; the README is not a specification and is unaffected.
    const job = await reindex({ MAX_SPEC_FILE_BYTES: 512 });
    expect(job.filesRemoved).toBe(0);
    expect(await storedDocuments()).toEqual(before);

    const [source] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, fx.sourceId));
    expect(source.lastError).toMatch(/over the .* a specification may be when it is parsed/);
    expect(source.lastError).toContain('MAX_SPEC_FILE_BYTES');
    // Put the source back, and prove the refusal left nothing behind.
    const restored = await reindex();
    expect(restored.filesRemoved).toBe(0);
    expect(await storedDocuments()).toEqual(before);
  }, 120_000);

  /**
   * **A file that has just been emptied is not an unchanged file.** `filesSkipped` is what
   * `index_runs` shows an operator as work not done, and counting "wrote nothing" as "nothing to do"
   * would report the deletion of a document as a quiet run.
   */
  it('does not report an emptied document as a file it skipped', async () => {
    const original = await readFile(path.join(fx.root, 'README.md'), 'utf8');
    try {
      await writeFile(path.join(fx.root, 'README.md'), '   \n');
      const job = await reindex();
      expect((await storedDocuments()).has('api/README.md')).toBe(false);
      // Three specifications' worth of unchanged files, and the one that is not a specification: the
      // emptied README is none of them.
      expect(job.filesSkipped).toBe(3);
    } finally {
      await writeFile(path.join(fx.root, 'README.md'), original);
      await reindex();
      expect((await storedDocuments()).has('api/README.md')).toBe(true);
    }
  }, 120_000);

  /**
   * **A run that died halfway through an expansion.** `replaceDocument` writes one document per
   * statement (ADR-0039 leaves that boundary alone), so a process killed in the middle of a forty
   * operation specification leaves some of its documents written and the rest missing — with the source
   * file's bytes unchanged. `unchanged` therefore asks about *every* path the file occupies, and a run
   * that finds one of them gone re-derives the whole file rather than declaring it up to date.
   */
  it('re-derives a specification whose documents are only partly there', async () => {
    const before = await storedDocuments();
    await fx.database.db.delete(documents).where(eq(documents.id, before.get('api/petstore.yaml/get-pets')?.id ?? ''));
    expect((await storedDocuments()).size).toBe(DOCUMENTS - 1);

    const job = await reindex();
    // The specification was re-read; the README and the other spec were still skipped.
    expect(job.chunksDone).toBeGreaterThan(0);
    expect(job.filesRemoved).toBe(0);
    const after = await storedDocuments();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    // Every other document kept its row: repairing one is not re-creating the file.
    for (const [storedPath, doc] of before) {
      if (storedPath === 'api/petstore.yaml/get-pets') continue;
      expect(after.get(storedPath)?.id, storedPath).toBe(doc.id);
    }
  }, 120_000);

  /**
   * Acceptance criterion 5, at the level that matters. Reordering the `paths` map changes the file's
   * bytes — so every document is re-derived and re-written — and must still land on exactly the same
   * paths. A derived path that depended on position would show up here as five deletions and five
   * insertions of documents nobody edited.
   */
  it('re-derives the same paths when the specification is written in another order', async () => {
    const before = await storedDocuments();
    const original = await readFile(path.join(fx.root, 'petstore.yaml'), 'utf8');
    try {
      await writeFile(path.join(fx.root, 'petstore.yaml'), reversePaths(original));
      const job = await reindex();
      expect(job.filesRemoved).toBe(0);
      expect(job.chunksDone).toBeGreaterThan(0);
      const after = await storedDocuments();
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      // Same row, not a new one: `replaceDocument` found the path it already had.
      for (const [storedPath, doc] of after) expect(doc.id).toBe(before.get(storedPath)?.id);
    } finally {
      await writeFile(path.join(fx.root, 'petstore.yaml'), original);
      await reindex();
    }
  }, 120_000);

  /**
   * Acceptance criterion 1, second half. One operation leaves the specification; its document has to
   * leave the index, and the other five have to stay exactly where they were — same path, same row.
   */
  it('loses exactly the document of an operation that was deleted, and moves nothing else', async () => {
    const before = await storedDocuments();
    const original = await readFile(path.join(fx.root, 'petstore.yaml'), 'utf8');
    try {
      await writeFile(path.join(fx.root, 'petstore.yaml'), withoutDeleteOperation(original));
      const job = await reindex();
      expect(job.filesRemoved).toBe(1);

      const after = await storedDocuments();
      expect(after.has('api/petstore.yaml/delete-pets-petId')).toBe(false);
      expect(after.size).toBe(DOCUMENTS - 1);
      for (const [storedPath, doc] of before) {
        if (storedPath === 'api/petstore.yaml/delete-pets-petId') continue;
        expect(after.get(storedPath)?.id, storedPath).toBe(doc.id);
      }
      // And the agent can no longer read it, which is the observable half of the deletion.
      expect((await call('read_document', { path: 'api/petstore.yaml/delete-pets-petId' })).isError).toBe(true);
      expect((await call('read_document', { path: 'api/petstore.yaml/get-pets-petId' })).isError).toBe(false);
    } finally {
      await writeFile(path.join(fx.root, 'petstore.yaml'), original);
      const job = await reindex();
      expect(job.filesRemoved).toBe(0);
      expect((await storedDocuments()).size).toBe(DOCUMENTS);
    }
  }, 120_000);
});

/** Rewrites the specification with its four path items in the opposite order. Bytes change; meaning does not. */
function reversePaths(source: string): string {
  const [head, rest] = splitAtPaths(source);
  const { items, tail } = pathItems(rest);
  return `${head}paths:\n${items.reverse().join('')}${tail}`;
}

/** Drops the `delete:` operation from the `/pets/{petId}` path item, leaving its `get:` in place. */
function withoutDeleteOperation(source: string): string {
  const lines = source.split('\n');
  const start = lines.indexOf('    delete:');
  if (start === -1) throw new Error('the fixture no longer has a `delete:` operation to remove');
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith('      ') || lines[end].trim() === '')) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

function splitAtPaths(source: string): [string, string] {
  const marker = '\npaths:\n';
  const at = source.indexOf(marker);
  if (at === -1) throw new Error('the fixture no longer has a `paths:` block');
  return [source.slice(0, at + 1), source.slice(at + marker.length)];
}

/** The `paths:` block split into one string per path item, plus whatever follows the block. */
function pathItems(rest: string): { items: string[]; tail: string } {
  const lines = rest.split('\n');
  const items: string[] = [];
  let current: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line !== '' && !line.startsWith(' ')) break; // `components:` and everything after it
    if (/^ {2}\S/.test(line)) {
      if (current.length) items.push(`${current.join('\n')}\n`);
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length) items.push(`${current.join('\n')}\n`);
  return { items, tail: lines.slice(i).join('\n') };
}

/**
 * **Where [ADR-0057](../../.ssot/ADR.md#adr-0057)'s document-level hash skip meets
 * [ADR-0058](../../.ssot/ADR.md#adr-0058)'s version stamp**, which is the one place the two can
 * disagree and the reason this block exists rather than being assumed.
 *
 * A specification is parsed on every run and the skipping moved down to the individual document: a
 * derived document whose stored hash still equals its file's is not rewritten. A version, meanwhile,
 * is stamped *by* `replaceDocument` — so a run that skips a document does not restamp it. Change a
 * source's version and nothing about the file's bytes moves, so on its own the skip would leave every
 * one of a specification's forty documents on the old release, silently and for ever.
 *
 * What stops it is the same mechanism a changed content type uses: the edit drops that source's stored
 * hashes, and the run the edit queues therefore rewrites all of them. **That is a rule that lives in
 * the PATCH route rather than in the indexer**, so this drives the route — not `updateSource`, which
 * is only half of it — and asserts the property at the far end: after the edit, *every* derived
 * document carries the new label.
 */
describe('a source whose version changes', () => {
  /** What the PATCH route asked to be re-indexed; a real `Indexer` here would race `reindex()`. */
  const enqueued: string[] = [];

  async function adminApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    const ctx = {
      config: loadConfig({
        DATABASE_URL: fx.database.url,
        ALLOWED_DOC_ROOTS: path.dirname(fx.root),
        DATA_DIR: path.join(fx.root, '.data'),
        SECRET_KEY: '0'.repeat(64),
        ADMIN_TOKEN,
      }),
      db: fx.database.db,
      log: silentLogger,
      embeddings,
      // Recorded rather than run: the assertion below is that the route *asks* for a run (FR-437),
      // and the run itself is driven explicitly afterwards so the two cannot interleave.
      indexer: {
        enqueue: (id: string) => {
          enqueued.push(id);
          return {};
        },
        isBusy: () => false,
        getJob: () => null,
        queueInfo: () => undefined,
      },
      locks: new KeyedMutex(),
      uploads: {},
      sessions: {},
      setup: new SetupGate(),
      loginLimiter: new SlidingWindow(10, 1000),
      version: '0.0.0-test',
      startedAt: Date.now(),
    } as unknown as AppContext;
    await app.register(adminRoutes, { ctx });
    await app.ready();
    return app;
  }

  /** Every document of the specification source, with the label it is carrying now. */
  async function versions(): Promise<Map<string, string>> {
    const rows = await fx.database.db
      .select({ relativePath: documents.relativePath, version: documents.version })
      .from(documents)
      .where(eq(documents.sourceId, fx.sourceId));
    return new Map(rows.map((r) => [r.relativePath, r.version]));
  }

  /** The source's config as it stands, so a patch extends it rather than replacing it. */
  async function setVersion(version: string): Promise<void> {
    const app = await adminApp();
    try {
      const [row] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, fx.sourceId));
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${fx.project.id}/sources/${fx.sourceId}`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { config: { ...(row.config as Record<string, unknown>), version } },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }

  it('stamps every document a specification expands into, not just the file', async () => {
    enqueued.length = 0;
    await setVersion('v2');
    // The route asked for a run rather than leaving the source silently stale (FR-437).
    expect(enqueued).toEqual([fx.project.id]);
    await reindex();

    const stamped = await versions();
    // Not vacuous: the whole corpus is here, and the count is the one the first case in this file
    // pins. An assertion over an empty map would pass against a filter that stamped nothing.
    expect(stamped.size).toBe(DOCUMENTS);
    expect([...stamped.values()].every((v) => v === 'v2')).toBe(true);
    // Named individually for the six that are one file's expansion, because they are the ones the
    // document-level skip decides about one at a time.
    for (const operation of ['get-pets', 'post-pets', 'get-pets-petId', 'delete-pets-petId']) {
      expect(stamped.get(`api/petstore.yaml/${operation}`)).toBe('v2');
    }
  });

  it('moves all of them to the new release when the label changes and nothing else does', async () => {
    // **The case the two mechanisms could have failed together.** The specification's bytes are
    // untouched, so every derived document's stored hash still matches the file — which is exactly
    // the state the document-level skip exists to short-circuit. If the edit did not drop the hashes,
    // all of these would still read `v2` and no run would ever move them.
    const before = await versions();
    expect([...before.values()].every((v) => v === 'v2')).toBe(true);

    enqueued.length = 0;
    await setVersion('v3');
    expect(enqueued).toEqual([fx.project.id]);
    await reindex();

    const after = await versions();
    expect(after.size).toBe(DOCUMENTS);
    const stale = [...after.entries()].filter(([, version]) => version !== 'v3');
    expect(stale, `these documents kept the old label: ${stale.map(([p, v]) => `${p}=${v}`).join(', ')}`).toEqual([]);
  });

  it('leaves them alone on a run that changes nothing, which is what the skip is for', async () => {
    // The other half, so the case above cannot be passing because the label is rewritten on every run
    // regardless: with no edit, the specification is skipped document by document and the labels stand.
    await reindex();
    const after = await versions();
    expect(after.size).toBe(DOCUMENTS);
    expect([...after.values()].every((v) => v === 'v3')).toBe(true);
  });
});
