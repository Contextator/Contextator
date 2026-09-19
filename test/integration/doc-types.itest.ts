import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, documents, projects, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A directory of the file types [ADR-0056](../../.ssot/ADR.md#adr-0056) added, taken through the real
 * indexer and then asked for through the real MCP tools.
 *
 * **The unit tests prove what each transform produces; this proves that the product carries it.** The
 * two claims are different, and the second one has more places to fail: the scanner's extension
 * filter, the read that now hands bytes rather than a string, the hash that still has to be over the
 * raw file, the chunker's title, the `documents.content` write, the search path, and — the one that is
 * only observable from here — a file no extractor can read arriving as a reason on its source rather
 * than as an empty document nobody notices.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'doc-types');

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
  const database = await createTestDatabase(baseUrl, 'doc_types');
  await applySchema(database, DIMS);

  const root = await mkdtemp(path.join(tmpdir(), 'contextator-doc-types-'));
  // Every fixture, including the one that has to be refused: the corpus a company actually has.
  for (const name of await readdir(FIXTURES)) {
    if (name.endsWith('.ts')) continue;
    await copyFile(path.join(FIXTURES, name), path.join(root, name));
  }

  const [project] = await database.db.insert(projects).values({ name: 'mixed-corpus' }).returning();
  const [source] = await database.db
    .insert(documentSources)
    .values({
      projectId: project.id,
      type: 'local',
      name: 'handbook',
      config: { path: root, extensions: ['md', 'txt', 'html', 'htm', 'csv', 'docx', 'pdf'] },
    })
    .returning();

  const indexer = new Indexer({
    db: database.db,
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
      MAX_PDF_PAGES: 2000,
      MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
    },
    log: silentLogger,
    locks: new KeyedMutex(),
  });

  const job = await settle(database.db, indexer.enqueue(project.id));
  expect(job.phase).toBe('done');

  const config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: path.dirname(root),
    DATA_DIR: path.join(root, '.data'),
    SECRET_KEY: '0'.repeat(64),
    // The floor is calibrated against `multilingual-e5-small` ([ADR-0042](../../.ssot/ADR.md#adr-0042));
    // the bag-of-words stub above scores a paraphrase at a third of it, and no wording of the question
    // would change that. What is under test here is that a `.pdf` becomes a document the search path
    // can return at all — the retrieval quality of the real model is `npm run eval`'s subject, and
    // this file deliberately does not restate it.
    SEARCH_SCORE_FLOOR: '0',
  });
  const reread = (await getProjectById(database.db, project.id)) ?? project;
  fx = { database, project: reread as ProjectRow, sourceId: source.id, root, ctx: { db: database.db, embeddings, config, log: silentLogger } };
}, 180_000);

afterAll(async () => {
  await rm(fx.root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, fx.database);
});

describe('a project of mixed file types', () => {
  it('indexes one document per readable file, and none for the scan', async () => {
    const rows = await fx.database.db
      .select({ relativePath: documents.relativePath, title: documents.title })
      .from(documents)
      .where(eq(documents.projectId, fx.project.id));
    expect(rows.map((r) => r.relativePath).sort()).toEqual([
      'handbook/changelog.htm',
      'handbook/escalation-policy.txt',
      'handbook/onboarding-checklist.docx',
      'handbook/release-notes.html',
      'handbook/service-owners.csv',
      'handbook/support-handbook.pdf',
      'handbook/two-column-brief.pdf',
    ]);
    // The title came from the converted Markdown, so no document is called "Service-owners.csv".
    expect(rows.find((r) => r.relativePath.endsWith('.csv'))?.title).toBe('Service Owners');
    expect(rows.find((r) => r.relativePath.endsWith('.html'))?.title).toBe('Release 4.2');
  });

  it('finds each new type through search_docs', async () => {
    const cases: Array<[string, string]> = [
      ['which engineer does a level three wake', 'handbook/support-handbook.pdf'],
      ['what opens on the first morning of onboarding', 'handbook/onboarding-checklist.docx'],
      ['how long is the delivery timeout now', 'handbook/release-notes.html'],
      ['who owns the billing api runbook', 'handbook/service-owners.csv'],
    ];
    for (const [query, expected] of cases) {
      const answer = await call('search_docs', { query, limit: 10 });
      expect(answer.isError).toBe(false);
      expect(answer.text, `searching for "${query}"`).toContain(expected);
    }
  });

  it('reads each new type back through read_document, as the converted document', async () => {
    const pdf = await call('read_document', { path: 'handbook/support-handbook.pdf', max_tokens: 20_000 });
    expect(pdf.isError).toBe(false);
    expect(pdf.text).toContain('Title: Support Handbook');
    expect(pdf.text).toContain('| Level | First reply | Resolution |');
    expect(pdf.text).toContain('- Level three wakes the on-call engineer.');
    // The running head and foot are not in the index, so they are not in what an agent reads either.
    expect(pdf.text).not.toContain('Acme Support');

    const docx = await call('read_document', { path: 'handbook/onboarding-checklist.docx', max_tokens: 20_000 });
    expect(docx.text).toContain('## Accounts to open');
    expect(docx.text).toContain('| Production console | On-call lead | After review |');

    const csv = await call('read_document', { path: 'handbook/service-owners.csv', max_tokens: 20_000 });
    expect(csv.text).toContain('| Service | Owner | Escalation contact | Runbook |');

    const html = await call('read_document', { path: 'handbook/release-notes.html', max_tokens: 20_000 });
    expect(html.text).toContain('## Upgrading');
    expect(html.text).not.toContain('window.analytics');
  });

  it('writes every refusal onto the source, and indexes nothing for any of them', async () => {
    const [source] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, fx.sourceId));
    expect(source.lastError).toMatch(/3 file\(s\) could not be indexed/);
    expect(source.lastError).toContain('scanned-invoice.pdf');
    expect(source.lastError).toMatch(/no text layer/);
    expect(source.lastError).toMatch(/character recognition is out of scope/);
    // The two malformed files are reported the same way, each named — and the run still finished.
    expect(source.lastError).toContain('damaged-report.pdf');
    expect(source.lastError).toContain('notes-renamed.docx');
    // A refusal is not a failed sync: the source is still usable and the run still succeeded.
    expect(source.status).toBe('idle');

    for (const path of ['handbook/scanned-invoice.pdf', 'handbook/damaged-report.pdf', 'handbook/notes-renamed.docx']) {
      expect((await call('read_document', { path })).isError).toBe(true);
    }
  });

  /**
   * **The blocker this file exists for.** Before `extractDocument` grew its boundary, the damaged PDF
   * and the renamed zip each threw a library exception straight past the indexer's `instanceof` check
   * and into the catch outside the file loop. That marked the project `error`, and because both
   * failures are deterministic it would have done so on every run after this one — so the other seven
   * documents would never be updated again until somebody found the two files by hand.
   */
  it('finished the run and left the project healthy, with three unreadable files in it', async () => {
    const project = await getProjectById(fx.database.db, fx.project.id);
    expect(project?.status).toBe('idle');
    expect(project?.lastError).toBeNull();
    expect(project?.documentCount).toBe(7);
  });

  it('skips every file on a second run, because the hash is still over the raw bytes', async () => {
    const indexer = new Indexer({
      db: fx.database.db,
      embeddings,
      config: {
        ALLOWED_DOC_ROOTS: [path.dirname(fx.root)],
        IGNORE_GLOBS: [],
        CHUNK_MAX_TOKENS: 256,
        CHUNK_OVERLAP_TOKENS: 32,
        EMBEDDING_BATCH_SIZE: 64,
        DATA_DIR: path.join(fx.root, '.data'),
        SECRET_KEY: '0'.repeat(64),
        MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
        MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
        MAX_PDF_PAGES: 2000,
        MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
      },
      log: silentLogger,
      locks: new KeyedMutex(),
    });
    const job = await settle(fx.database.db, indexer.enqueue(fx.project.id));
    expect(job.phase).toBe('done');
    // Seven unchanged documents plus the three that are refused again.
    expect(job.filesSkipped).toBe(10);
    expect(job.chunksDone).toBe(0);
    expect(job.filesRemoved).toBe(0);
  }, 120_000);
});
