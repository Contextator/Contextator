import { copyFile, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig, WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, documents, projects, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { ConversionService } from '../../src/services/conversion/client.js';
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
const WORKERS = path.join(__dirname, '..', 'fixtures', 'conversion');

/**
 * What one `search_docs` call may take while the indexer is converting, end to end and including the
 * in-memory MCP transport this file talks through.
 *
 * Measured rather than guessed, all three numbers from the run below. On an idle machine the slowest of
 * a hundred calls is about 7 ms; with the rest of the integration suite running in parallel, which is
 * how this normally executes, it is about 48 ms. With the specification parsed on this thread instead,
 * the slowest is 1.5 seconds — the parse, entire, with nothing else able to run. The bound sits in the
 * gap: well clear of a loaded machine's noise and several times under the block it exists to catch.
 */
const CONVERSION_LATENCY_BOUND_MS = 250;

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

/** The product's defaults, over one scratch root. */
const indexerConfig = (root: string) => ({
  ...WEB_LIMIT_DEFAULTS,
  ALLOWED_DOC_ROOTS: [path.dirname(root)],
  IGNORE_GLOBS: [] as string[],
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
  CONVERSION_TIMEOUT_MS: 120_000,
  CONVERSION_IDLE_MS: 60_000,
});

/**
 * A specification whose weight is in a `components` section nothing points at — a schema catalogue
 * kept for clients that are gone. It is the cheapest honest way to write a file that is expensive to
 * *parse* and small to *index*, which is what separates the conversion cost from everything after it.
 */
function catalogueSpec(operations: number, schemas: number): string {
  const lines = ['openapi: 3.0.3', 'info:', '  title: Fleet API', '  version: "4.2"', 'paths:'];
  for (let i = 0; i < operations; i++) {
    lines.push(`  /fleet/vehicles/${i}:`);
    lines.push('    get:');
    lines.push(`      summary: Read vehicle ${i}`);
    lines.push(`      description: The ${i}th vehicle in the fleet, with its telemetry and its maintenance window.`);
    lines.push('      responses:');
    lines.push('        "200": { description: OK }');
  }
  lines.push('components:');
  lines.push('  schemas:');
  for (let i = 0; i < schemas; i++) {
    lines.push(`    Legacy${i}:`);
    lines.push('      type: object');
    lines.push('      properties:');
    for (let p = 0; p < 6; p++)
      lines.push(`        field${p}: { type: string, description: "A field kept for the 2019 client, number ${p} of ${i}" }`);
  }
  return lines.join('\n');
}

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

  const indexer = new Indexer({ db: database.db, embeddings, config: indexerConfig(root), log: silentLogger, locks: new KeyedMutex() });

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
    expect(source.lastError).toMatch(/4 of 11 file\(s\) could not be indexed/);
    expect(source.lastError).toContain('scanned-invoice.pdf');
    expect(source.lastError).toMatch(/no text layer/);
    expect(source.lastError).toMatch(/character recognition is out of scope/);
    // The two malformed files are reported the same way, each named — and the run still finished.
    expect(source.lastError).toContain('damaged-report.pdf');
    expect(source.lastError).toContain('notes-renamed.docx');
    expect(source.lastError).toContain('pictures-only.docx');
    // Every refusal says what to do about it, not only that it happened.
    expect(source.lastError).toMatch(/re-export it with its text/);
    // A refusal is not a failed sync: the source is still usable and the run still succeeded.
    expect(source.status).toBe('idle');

    for (const path of [
      'handbook/scanned-invoice.pdf',
      'handbook/damaged-report.pdf',
      'handbook/notes-renamed.docx',
      'handbook/pictures-only.docx',
    ]) {
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
  it('finished the run and left the project healthy, with four unreadable files in it', async () => {
    const project = await getProjectById(fx.database.db, fx.project.id);
    expect(project?.status).toBe('idle');
    expect(project?.lastError).toBeNull();
    expect(project?.documentCount).toBe(7);
  });

  /**
   * **The same blocker, one line above the conversion boundary**, and the cap that has to be applied
   * before the read rather than after it.
   *
   * Both files below are sparse: each declares 2 GiB + 1 and occupies no disk at all, which is what a
   * corrupt export or a disk image renamed to `.pdf` looks like to a scan. They are two different
   * halves of the same defect.
   *
   * The `.pdf` is a converted type, so the ceiling applies — against the size the **walk** recorded,
   * before `readAndHash` makes 2 GiB resident. A limit checked on the buffer that call returns is a
   * limit that has already been exceeded.
   *
   * The `.md` is decoded rather than parsed and is deliberately not capped, so the read is actually
   * attempted — and `fs.readFile` refuses a file this size outright with `ERR_FS_FILE_TOO_LARGE`.
   * That is not a `DocumentExtractionError`, so before the read moved inside the boundary it left the
   * file loop and failed the **run**, deterministically, on every run afterwards.
   */
  it('refuses a file too large to read without reading it, and without failing the run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'contextator-doc-types-huge-'));
    await copyFile(path.join(FIXTURES, 'support-handbook.pdf'), path.join(root, 'handbook.pdf'));
    for (const name of ['disk-image.pdf', 'notes-dump.md']) {
      await writeFile(path.join(root, name), '');
      await truncate(path.join(root, name), 2 * 1024 * 1024 * 1024 + 1);
    }

    const [project] = await fx.database.db.insert(projects).values({ name: 'huge-file' }).returning();
    const [source] = await fx.database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'manuals', config: { path: root, extensions: ['md', 'pdf'] } })
      .returning();

    const indexer = new Indexer({ db: fx.database.db, embeddings, config: indexerConfig(root), log: silentLogger, locks: new KeyedMutex() });
    const job = await settle(fx.database.db, indexer.enqueue(project.id));

    expect(job.phase).toBe('done');
    const after = await getProjectById(fx.database.db, project.id);
    expect(after?.status).toBe('idle');
    // The healthy file beside it indexed, which is the whole point of refusing one file rather than the run.
    expect(after?.documentCount).toBe(1);
    const [row] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, source.id));
    expect(row.status).toBe('idle');
    expect(row.lastError).toMatch(/2 of 3 file\(s\) could not be indexed/);
    // The converted type is refused on its size, without the read that would have made it resident…
    expect(row.lastError).toMatch(/"manuals\/disk-image\.pdf" is 2048\.0 MiB, over the 32\.0 MiB/);
    // …and the type that is only decoded, and therefore not capped, is refused by what the filesystem
    // said when the read was attempted — which is not an error type the indexer knows on its own.
    expect(row.lastError).toMatch(/"manuals\/notes-dump\.md" could not be read from disk/);
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  /**
   * **Some of a source's files refused is a complaint; all of them is a failure.** Once a read that the
   * filesystem refuses became a per-file refusal rather than a failed run, a folder unmounted between
   * the scan and the read would otherwise refuse every file one at a time and leave a green project
   * serving an index with nothing behind it. The escalation is on the count, not on the reason.
   */
  it('marks a source failed when nothing in it could be indexed, and says so on the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'contextator-doc-types-scans-'));
    await copyFile(path.join(FIXTURES, 'scanned-invoice.pdf'), path.join(root, 'invoice-2026-01.pdf'));
    await copyFile(path.join(FIXTURES, 'scanned-invoice.pdf'), path.join(root, 'invoice-2026-02.pdf'));

    const [project] = await fx.database.db.insert(projects).values({ name: 'scans-only' }).returning();
    const [source] = await fx.database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'invoices', config: { path: root, extensions: ['pdf'] } })
      .returning();

    const indexer = new Indexer({ db: fx.database.db, embeddings, config: indexerConfig(root), log: silentLogger, locks: new KeyedMutex() });
    const job = await settle(fx.database.db, indexer.enqueue(project.id));

    expect(job.phase).toBe('error');
    const [row] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, source.id));
    expect(row.status).toBe('error');
    expect(row.lastError).toMatch(/none of this source's 2 file\(s\) could be indexed/);
    const after = await getProjectById(fx.database.db, project.id);
    expect(after?.status).toBe('error');
    expect(after?.lastError).toMatch(/no file of invoices could be indexed/);
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  it('skips every file on a second run, because the hash is still over the raw bytes', async () => {
    const indexer = new Indexer({ db: fx.database.db, embeddings, config: indexerConfig(fx.root), log: silentLogger, locks: new KeyedMutex() });
    const job = await settle(fx.database.db, indexer.enqueue(fx.project.id));
    expect(job.phase).toBe('done');
    // Seven unchanged documents plus the four that are refused again.
    expect(job.filesSkipped).toBe(11);
    expect(job.chunksDone).toBe(0);
    expect(job.filesRemoved).toBe(0);
  }, 120_000);
});

/**
 * **What moving conversion onto its own thread has to keep true**
 * ([ADR-0071](../../.ssot/ADR.md#adr-0071)).
 *
 * The unit tests assert that the conversion produces the same bytes and that the client survives a
 * thread that dies or stops answering. Neither of them can say what the *product* does about it, and
 * that is the pair of claims here: an endpoint that keeps answering while a run converts, and a thread
 * that crashes leaving one refused file behind rather than a dead server.
 */
describe('conversion off the event loop', () => {
  /**
   * **Criterion two.** The specification below is 40 operations and about 6 MiB, most of it a
   * `components` section no operation references — the shape of a schema catalogue that outlived its
   * clients, and a perfectly ordinary file. Parsing it is about a second and a half of uninterruptible
   * work ([ADR-0057](../../.ssot/ADR.md#adr-0057): the graph is around fifty-five times the file), and
   * it is the single most expensive thing this product does to one file.
   *
   * Before this phase that was a second and a half in which `/mcp` answered nothing at all.
   *
   * It is deliberately a specification and not forty PDFs: a PDF parses in single-digit milliseconds,
   * so no bound a healthy run could meet would have caught conversion moving back onto this thread.
   */
  it('answers search_docs while the most expensive file this product parses is being parsed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'contextator-doc-types-busy-'));
    await writeFile(path.join(root, 'fleet.yaml'), catalogueSpec(40, 10_000));

    const [project] = await fx.database.db.insert(projects).values({ name: 'busy-conversion' }).returning();
    await fx.database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'api', flavor: 'openapi', config: { path: root, extensions: ['yaml'] } });

    const indexer = new Indexer({ db: fx.database.db, embeddings, config: indexerConfig(root), log: silentLogger, locks: new KeyedMutex() });
    const job = indexer.enqueue(project.id);

    // The searches go to the *other* project, which is already indexed: what is being measured is the
    // endpoint's availability, not any interaction between two runs.
    const latencies: number[] = [];
    while (job.phase !== 'done' && job.phase !== 'error') {
      const started = performance.now();
      const answer = await call('search_docs', { query: 'which engineer does a level three wake' });
      latencies.push(performance.now() - started);
      expect(answer.isError).toBe(false);
    }
    await settle(fx.database.db, job);

    expect(job.phase).toBe('done');
    // The run really did index the specification, so the parse really did happen inside this window.
    expect((await getProjectById(fx.database.db, project.id))?.documentCount).toBe(40);
    // Enough calls that the number means something, spread over the whole run rather than its tail.
    expect(latencies.length).toBeGreaterThan(15);
    expect(Math.max(...latencies)).toBeLessThan(CONVERSION_LATENCY_BOUND_MS);
    await rm(root, { recursive: true, force: true });
  }, 180_000);

  /**
   * **Criterion three.** The thread dies on every `.pdf` and answers normally for everything else. The
   * process stays up, the PDF is refused *by name* with the reason on its source, the Markdown beside
   * it indexes, and the run finishes — which is the same shape ADR-0056 gives an unreadable file, now
   * extended to a failure mode a function call did not have.
   */
  it('survives a conversion thread that dies, refusing the file rather than the run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'contextator-doc-types-crash-'));
    await copyFile(path.join(FIXTURES, 'support-handbook.pdf'), path.join(root, 'handbook.pdf'));
    await writeFile(path.join(root, 'runbook.md'), '# Runbook\n\nRestart the collector, then drain the queue.\n');

    const [project] = await fx.database.db.insert(projects).values({ name: 'crashing-conversion' }).returning();
    const [source] = await fx.database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'manuals', config: { path: root, extensions: ['md', 'pdf'] } })
      .returning();

    const conversion = new ConversionService({
      timeoutMs: 30_000,
      idleMs: 30_000,
      entry: new URL(`file://${path.join(WORKERS, 'pdf-crashing-worker.ts')}`),
    });
    const indexer = new Indexer({
      db: fx.database.db,
      embeddings,
      config: indexerConfig(root),
      log: silentLogger,
      locks: new KeyedMutex(),
      conversion,
    });
    const job = await settle(fx.database.db, indexer.enqueue(project.id));

    expect(job.phase).toBe('done');
    const after = await getProjectById(fx.database.db, project.id);
    expect(after?.status).toBe('idle');
    expect(after?.lastError).toBeNull();
    // The file beside it indexed on a thread that had just been replaced.
    expect(after?.documentCount).toBe(1);

    const [row] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, source.id));
    expect(row.status).toBe('idle');
    expect(row.lastError).toContain('manuals/handbook.pdf');
    expect(row.lastError).toContain('the conversion thread stopped before it answered');
    expect(row.lastError).toContain('exited with code 3');

    await conversion.stop();
    await rm(root, { recursive: true, force: true });
  }, 180_000);
});
