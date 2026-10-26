import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import { bootstrapDatabase } from '../../src/db/bootstrap.js';
import type { Db } from '../../src/db/client.js';
import { documentChanges, documentSources, documents, indexRuns, projects } from '../../src/db/schema.js';
import {
  ensureTrackingSince,
  isModified,
  listDocumentChanges,
  readTrackingSince,
  recordRebuildChanges,
  sweepDocumentChanges,
  type ListedChange,
} from '../../src/services/document-changes.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { deleteSource, invalidateSourceDocuments } from '../../src/services/sources.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * `whats_new`'s record ([ADR-0123](../../.ssot/ADR.md#adr-0123)): what the indexer writes into
 * `document_changes` at its two write points and at `deleteSource`, what a rebuild's swap publishes, and
 * what the sweep forgets. The tool's own answers are held by `mcp-golden.itest.ts`.
 *
 * The indexer is the real one over a stub embedding provider, as in `index-generations.itest.ts`, so a
 * "run" is a run: a file written to a directory, an `enqueue`, and a settled job. The provider carries the
 * same gate, so a rebuild can be stopped between two documents and looked at from outside.
 *
 * **`since` comes from the database's clock, with a pause on both sides.** `changed_at` is `now()` of the
 * transaction that wrote it, and a container's clock is not the host's. A mark taken from the database,
 * a few milliseconds clear of the previous write and of the next one, is a boundary no run can straddle.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';

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

/** Parks a run at the start of its `n`-th `embedPassages` call until the test lets it through. */
class EmbedGate {
  private calls = 0;
  private armedAt: number | null = null;
  private announce: (() => void) | null = null;
  private open: ((value: 'go') => void) | null = null;
  private held: Promise<'go'> | null = null;

  armAt(call: number): Promise<void> {
    this.calls = 0;
    this.armedAt = call;
    this.held = new Promise<'go'>((resolve) => {
      this.open = resolve;
    });
    return new Promise<void>((resolve) => {
      this.announce = resolve;
    });
  }

  disarm(): void {
    this.armedAt = null;
    this.open?.('go');
  }

  async pass(): Promise<void> {
    this.calls++;
    if (this.armedAt === null || this.calls !== this.armedAt) return;
    this.announce?.();
    await this.held;
  }
}

const gate = new EmbedGate();

const embeddings: EmbeddingProvider = {
  id: MODEL_ID,
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: (text) => Math.ceil(text.length / 4),
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => {
    await gate.pass();
    return texts.map(stubVector);
  },
  embedQuery: async (text: string) => stubVector(text),
};

const indexerConfig = {
  ...WEB_LIMIT_DEFAULTS,
  ALLOWED_DOC_ROOTS: [] as string[],
  IGNORE_GLOBS: [] as string[],
  CHUNK_MAX_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 64,
  EMBEDDING_BATCH_SIZE: 64,
  DATA_DIR: '',
  SECRET_KEY: '0'.repeat(64),
  MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
  MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
  MAX_SPEC_FILE_BYTES: 8 * 1024 * 1024,
  MAX_PDF_PAGES: 2000,
  MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
  CONVERSION_TIMEOUT_MS: 120_000,
  CONVERSION_IDLE_MS: 60_000,
  PROJECT_MAX_DOCUMENTS: 0,
  PROJECT_MAX_CHUNKS: 0,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The job object the indexer mutates; waits for it to settle, and then for the project row to stop saying `indexing`. */
async function settle(db: Db, job: JobState): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await sleep(5);
  }
  for (;;) {
    const project = await getProjectById(db, job.projectId);
    if (project?.status !== 'indexing') return job;
    if (Date.now() > deadline) throw new Error(`project row still says "indexing" after the job settled as ${job.phase}`);
    await sleep(5);
  }
}

/** A boundary taken from the database's clock, clear of what came before it and of what comes after. */
async function mark(db: Db): Promise<Date> {
  await sleep(30);
  const result = await db.execute(sql`SELECT (extract(epoch FROM now()) * 1000)::bigint AS ms`);
  const at = new Date(Number((result.rows[0] as { ms: string }).ms));
  await sleep(30);
  return at;
}

const EPOCH = new Date(0);

async function changesSince(db: Db, projectId: string, since: Date, extra: Partial<Parameters<typeof listDocumentChanges>[1]> = {}) {
  const project = await getProjectById(db, projectId);
  return listDocumentChanges(db, { projectId, liveGeneration: project?.liveGeneration ?? 0, since, limit: 200, ...extra });
}

const keysOf = (changes: ListedChange[]): string[] => changes.map((c) => `${c.change}:${c.path}`).sort();

const body = (marker: string, name: string): string =>
  `# ${name}\n\nThe ${marker} handbook explains how to rotate the ${name} secret from the source panel.\n`;
const NAMES = ['alpha', 'bravo', 'charlie', 'delta'];

interface Fixture {
  database: TestDatabase;
  indexer: Indexer;
  /** The project lock the indexer takes, which is also the one the admin API takes around `deleteSource`. */
  locks: KeyedMutex;
  root: string;
  projectId: string;
  sourceId: string;
}

/** A project with one local source `handbook` over a directory of four files. */
async function buildFixture(name: string): Promise<Fixture> {
  const database = await createTestDatabase(baseUrl, name);
  await applySchema(database, DIMS);
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  for (const n of NAMES) await writeFile(path.join(root, `${n}.md`), body('original', n), 'utf8');
  const [project] = await database.db
    .insert(projects)
    .values({ name: name.replace(/_/g, '-') })
    .returning({ id: projects.id });
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } })
    .returning({ id: documentSources.id });
  const locks = new KeyedMutex();
  const indexer = new Indexer({
    db: database.db,
    embeddings,
    config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
    log: silentLogger,
    locks,
  });
  return { database, indexer, locks, root, projectId: project.id, sourceId: source.id };
}

async function run(fx: Fixture, options: { force?: boolean } = {}): Promise<JobState> {
  const job = await settle(fx.database.db, fx.indexer.enqueue(fx.projectId, options));
  fx.indexer.forget(fx.projectId);
  expect(job.error).toBeUndefined();
  expect(job.phase).toBe('done');
  return job;
}

async function dispose(fx: Fixture): Promise<void> {
  await rm(fx.root, { recursive: true, force: true });
  await dropTestDatabase(baseUrl, fx.database);
}

describe('an incremental run', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_incremental');
    await run(fx);
  });
  afterAll(() => dispose(fx));

  it('records the first run as additions, each with the title it was indexed under', async () => {
    const { changes, truncated } = await changesSince(fx.database.db, fx.projectId, EPOCH);
    expect(keysOf(changes)).toEqual(NAMES.map((n) => `added:handbook/${n}.md`).sort());
    expect(changes.find((c) => c.path === 'handbook/alpha.md')?.title).toBe('alpha');
    expect(truncated).toBe(false);
  });

  it('answers newest first and says when it cut the list', async () => {
    const { changes, truncated } = await changesSince(fx.database.db, fx.projectId, EPOCH, { limit: 2 });
    expect(changes).toHaveLength(2);
    expect(truncated).toBe(true);
    const times = changes.map((c) => c.changedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await changesSince(fx.database.db, fx.projectId, EPOCH, { limit: 4 })).truncated).toBe(false);
  });

  it('filters by source (a prefix that ends at the slash) and by version', async () => {
    const db = fx.database.db;
    expect((await changesSince(db, fx.projectId, EPOCH, { source: 'handbook' })).changes).toHaveLength(4);
    expect((await changesSince(db, fx.projectId, EPOCH, { source: 'hand' })).changes).toHaveLength(0);
    expect((await changesSince(db, fx.projectId, EPOCH, { source: 'elsewhere' })).changes).toHaveLength(0);
    expect((await changesSince(db, fx.projectId, EPOCH, { version: '' })).changes).toHaveLength(4);
    expect((await changesSince(db, fx.projectId, EPOCH, { version: 'v1' })).changes).toHaveLength(0);
  });

  it('lists what a run added, modified and removed, and nothing it left alone', async () => {
    const since = await mark(fx.database.db);
    await writeFile(path.join(fx.root, 'bravo.md'), body('replacement', 'bravo'), 'utf8');
    await unlink(path.join(fx.root, 'charlie.md'));
    await writeFile(path.join(fx.root, 'echo.md'), body('original', 'echo'), 'utf8');
    await run(fx);

    const { changes } = await changesSince(fx.database.db, fx.projectId, since);
    expect(keysOf(changes)).toEqual(['added:handbook/echo.md', 'modified:handbook/bravo.md', 'removed:handbook/charlie.md']);
    // A removed document is known by its path and the title it had, and by nothing else.
    const removed = changes.find((c) => c.change === 'removed');
    expect(removed).toMatchObject({ path: 'handbook/charlie.md', title: 'charlie', sourceUrl: null, sourceModifiedAt: null });
    // And the documents it left alone do not appear: alpha and delta were skipped as unchanged.
    expect(changes.some((c) => c.path === 'handbook/alpha.md' || c.path === 'handbook/delta.md')).toBe(false);
  });

  it('stamps every change with the id the run recorded itself under', async () => {
    await writeFile(path.join(fx.root, 'delta.md'), body('replacement', 'delta'), 'utf8');
    await run(fx);
    const [latest] = await fx.database.db
      .select({ id: indexRuns.id })
      .from(indexRuns)
      .where(eq(indexRuns.projectId, fx.projectId))
      .orderBy(desc(indexRuns.startedAt))
      .limit(1);
    const [row] = await fx.database.db.select().from(documentChanges).where(eq(documentChanges.relativePath, 'handbook/delta.md'));
    expect(row.change).toBe('modified');
    expect(row.runId).toBe(latest.id);
  });

  it('records nothing for a language change, which blanks every hash and rewrites every document', async () => {
    const since = await mark(fx.database.db);
    await invalidateSourceDocuments(fx.database.db, fx.sourceId);
    const job = await run(fx);
    // The run did rewrite the documents (the hashes were blank, so none was current) ...
    expect(job.chunksDone).toBeGreaterThan(0);
    // ... and, the text being what it was, none of that is a change.
    expect((await changesSince(fx.database.db, fx.projectId, since)).changes).toEqual([]);
  });

  it('leaves out a path that was added and removed again inside the window, and reports it added when it comes back', async () => {
    const since = await mark(fx.database.db);
    const file = path.join(fx.root, 'scratch.md');
    await writeFile(file, body('original', 'scratch'), 'utf8');
    await run(fx);
    expect(keysOf((await changesSince(fx.database.db, fx.projectId, since)).changes)).toEqual(['added:handbook/scratch.md']);

    await unlink(file);
    await run(fx);
    // Came and went inside the window: the agent was never told of it, and is not told now.
    expect((await changesSince(fx.database.db, fx.projectId, since)).changes).toEqual([]);

    const afterRemoval = await mark(fx.database.db);
    await writeFile(file, body('original', 'scratch'), 'utf8');
    await run(fx);
    expect(keysOf((await changesSince(fx.database.db, fx.projectId, afterRemoval)).changes)).toEqual(['added:handbook/scratch.md']);
  });

  it('reports a document older than the record as modified and never as added', async () => {
    // What an installation looks like the moment it upgrades: documents, and no record of them.
    await fx.database.db.delete(documentChanges).where(eq(documentChanges.projectId, fx.projectId));
    const since = await mark(fx.database.db);
    await writeFile(path.join(fx.root, 'alpha.md'), body('replacement', 'alpha'), 'utf8');
    await run(fx);

    expect(keysOf((await changesSince(fx.database.db, fx.projectId, since)).changes)).toEqual(['modified:handbook/alpha.md']);
    const [row] = await fx.database.db.select().from(documentChanges).where(eq(documentChanges.relativePath, 'handbook/alpha.md'));
    expect(row.addedAt).toBeNull();
    // Asked about from before any record, it is still modified: when it was added is not known.
    expect(keysOf((await changesSince(fx.database.db, fx.projectId, EPOCH)).changes)).toEqual(['modified:handbook/alpha.md']);
  });
});

describe('a specification', () => {
  let fx: Fixture;
  const SPEC = (widgetsSummary: string): string => `openapi: 3.0.3
info:
  title: Widgets
  version: 1.0.0
paths:
  /widgets:
    get:
      operationId: listWidgets
      summary: ${widgetsSummary}
      responses:
        '200':
          description: The widgets.
  /gadgets:
    get:
      operationId: listGadgets
      summary: List gadgets
      responses:
        '200':
          description: The gadgets.
`;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_spec');
    // The fixture's markdown files are not the subject here: a source of its own, over a specification.
    await fx.database.db.delete(documentSources).where(eq(documentSources.id, fx.sourceId));
    await rm(fx.root, { recursive: true, force: true });
    fx.root = await mkdtemp(path.join(tmpdir(), 'whats_new_spec_files-'));
    await writeFile(path.join(fx.root, 'spec.yaml'), SPEC('List widgets'), 'utf8');
    const [source] = await fx.database.db
      .insert(documentSources)
      .values({ projectId: fx.projectId, type: 'local', name: 'api', flavor: 'openapi', config: { path: fx.root, extensions: ['md', 'yaml'] } })
      .returning({ id: documentSources.id });
    fx.sourceId = source.id;
    fx.indexer = new Indexer({
      db: fx.database.db,
      embeddings,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(fx.root)], DATA_DIR: path.join(fx.root, '.data') },
      log: silentLogger,
      locks: fx.locks,
    });
    await run(fx);
  });
  afterAll(() => dispose(fx));

  it('records one operation changing as one document modified, though the file hash moved every document', async () => {
    const since = await mark(fx.database.db);
    await writeFile(path.join(fx.root, 'spec.yaml'), SPEC('List every widget'), 'utf8');
    const job = await run(fx);
    // Both operations were rewritten, since the file's hash is the hash of both ...
    expect(job.chunksDone).toBeGreaterThanOrEqual(2);
    // ... and one of them changed.
    expect(keysOf((await changesSince(fx.database.db, fx.projectId, since)).changes)).toEqual(['modified:api/spec.yaml/get-widgets']);
  });
});

describe('a rebuild', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_rebuild');
    await run(fx);
  });
  afterAll(() => dispose(fx));

  it('records nothing for a forced rebuild of content that did not change', async () => {
    const since = await mark(fx.database.db);
    await run(fx, { force: true });
    // The swap happened: the project is on the next generation ...
    expect((await getProjectById(fx.database.db, fx.projectId))?.liveGeneration).toBe(1);
    // ... and nothing was recorded, whatever the rebuild rewrote.
    expect((await changesSince(fx.database.db, fx.projectId, since)).changes).toEqual([]);
  });

  it('records nothing while it is running, and what it changed arrives with the swap', async () => {
    for (const n of NAMES) await writeFile(path.join(fx.root, `${n}.md`), body('original', n), 'utf8');
    await writeFile(path.join(fx.root, 'bravo.md'), body('replacement', 'bravo'), 'utf8');
    await unlink(path.join(fx.root, 'charlie.md'));
    await writeFile(path.join(fx.root, 'echo.md'), body('original', 'echo'), 'utf8');

    const since = await mark(fx.database.db);
    const reached = gate.armAt(2); // parked on the second document, the first already written into the new generation
    const job = fx.indexer.enqueue(fx.projectId, { force: true });
    await reached;

    // Both generations are in the table; the new one is not live and its documents are nobody's change yet.
    const generations = await fx.database.db.execute(
      sql`SELECT DISTINCT index_generation AS g FROM documents WHERE project_id = ${fx.projectId} ORDER BY g`,
    );
    expect(generations.rows.map((r) => (r as { g: number }).g)).toEqual([1, 2]);
    expect((await changesSince(fx.database.db, fx.projectId, since)).changes).toEqual([]);

    gate.disarm();
    await settle(fx.database.db, job);
    fx.indexer.forget(fx.projectId);
    expect(job.phase).toBe('done');

    const { changes } = await changesSince(fx.database.db, fx.projectId, since);
    expect(keysOf(changes)).toEqual(['added:handbook/echo.md', 'modified:handbook/bravo.md', 'removed:handbook/charlie.md']);
    expect(changes.find((c) => c.change === 'removed')?.title).toBe('charlie');
    // One run made all three, and it is the run the history shows: the forced one, written as the last row.
    const [latest] = await fx.database.db
      .select({ id: indexRuns.id, mode: indexRuns.mode })
      .from(indexRuns)
      .where(eq(indexRuns.projectId, fx.projectId))
      .orderBy(desc(indexRuns.startedAt))
      .limit(1);
    expect(latest.mode).toBe('force');
    const rows = await fx.database.db
      .select({ runId: documentChanges.runId })
      .from(documentChanges)
      .where(sql`${documentChanges.projectId} = ${fx.projectId} AND ${documentChanges.changedAt} > ${since}`);
    expect(rows.map((r) => r.runId)).toEqual([latest.id, latest.id, latest.id]);
  });
});

describe('the swap statement', () => {
  let fx: Fixture;
  const LIVE = 0;
  const NEXT = 1;

  interface Pair {
    path: string;
    live?: { hash: string; content: string | null; truncated?: boolean; title?: string; version?: string };
    next?: { hash: string; content: string | null; truncated?: boolean; title?: string; version?: string };
    expected: 'added' | 'modified' | 'removed' | null;
  }

  // Every row of the table `isModified` answers, as two generations. The SQL and the TypeScript are
  // two statements of one rule, and this is where they are made to agree.
  const PAIRS: Pair[] = [
    { path: 's/same.md', live: { hash: 'h1', content: 'x' }, next: { hash: 'h1', content: 'x' }, expected: null },
    { path: 's/hash-only.md', live: { hash: 'h1', content: 'x' }, next: { hash: 'h2', content: 'x' }, expected: null },
    { path: 's/text.md', live: { hash: 'h1', content: 'old' }, next: { hash: 'h2', content: 'new' }, expected: 'modified' },
    { path: 's/no-text.md', live: { hash: 'h1', content: null }, next: { hash: 'h2', content: 'new' }, expected: 'modified' },
    { path: 's/truncated.md', live: { hash: 'h1', content: 'x', truncated: true }, next: { hash: 'h2', content: 'x' }, expected: 'modified' },
    { path: 's/same-hash-new-text.md', live: { hash: 'h1', content: 'old' }, next: { hash: 'h1', content: 'new' }, expected: null },
    { path: 's/gone.md', live: { hash: 'h1', content: 'x', title: 'Gone', version: 'v1' }, expected: 'removed' },
    { path: 's/fresh.md', next: { hash: 'h1', content: 'x', title: 'Fresh', version: 'v2' }, expected: 'added' },
  ];

  beforeAll(async () => {
    fx = await buildFixture('whats_new_swap');
    await fx.database.db.delete(documentSources).where(eq(documentSources.id, fx.sourceId));
    const insert = (generation: number, pair: Pair, side: NonNullable<Pair['live']>) =>
      fx.database.db.insert(documents).values({
        projectId: fx.projectId,
        sourceId: null,
        relativePath: pair.path,
        title: side.title ?? pair.path,
        contentHash: side.hash,
        sizeBytes: 1,
        chunkCount: 0,
        indexGeneration: generation,
        content: side.content,
        contentTruncated: side.truncated ?? false,
        version: side.version ?? '',
      });
    for (const pair of PAIRS) {
      if (pair.live) await insert(LIVE, pair, pair.live);
      if (pair.next) await insert(NEXT, pair, pair.next);
    }
  });
  afterAll(() => dispose(fx));

  const count = async (): Promise<number> =>
    (await fx.database.db.select().from(documentChanges).where(eq(documentChanges.projectId, fx.projectId))).length;

  it('is rolled back with the transaction it is in, so a swap that fails publishes no change', async () => {
    await expect(
      fx.database.db.transaction(async (tx) => {
        expect(await recordRebuildChanges(tx, fx.projectId, LIVE, NEXT, null)).toBeGreaterThan(0);
        throw new Error('the swap failed');
      }),
    ).rejects.toThrow('the swap failed');
    expect(await count()).toBe(0);
  });

  it('writes added, modified and removed exactly where the text rule says, and nothing for the rest', async () => {
    const written = await fx.database.db.transaction((tx) => recordRebuildChanges(tx, fx.projectId, LIVE, NEXT, null));
    const rows = await fx.database.db.select().from(documentChanges).where(eq(documentChanges.projectId, fx.projectId));
    const expected = PAIRS.filter((p) => p.expected !== null);
    expect(written).toBe(expected.length);
    expect(rows.map((r) => `${r.change}:${r.relativePath}`).sort()).toEqual(expected.map((p) => `${p.expected}:${p.path}`).sort());

    // Whichever side a row's title and version come from: the new one, or for a removal the old.
    expect(rows.find((r) => r.relativePath === 's/gone.md')).toMatchObject({ title: 'Gone', version: 'v1', addedAt: null });
    expect(rows.find((r) => r.relativePath === 's/fresh.md')).toMatchObject({ title: 'Fresh', version: 'v2' });
    expect(rows.find((r) => r.relativePath === 's/fresh.md')?.addedAt).not.toBeNull();
    expect(rows.find((r) => r.relativePath === 's/text.md')?.addedAt).toBeNull();
  });

  it('answers what `isModified` answers', () => {
    for (const pair of PAIRS.filter((p) => p.live && p.next)) {
      const live = pair.live!;
      const next = pair.next!;
      const asText = (side: typeof live) => ({ contentHash: side.hash, content: side.content, contentTruncated: side.truncated ?? false });
      expect(isModified(asText(live), asText(next)), pair.path).toBe(pair.expected === 'modified');
    }
  });

  it('keeps the date a path was added when a later swap removes it, which is what hides it from a window that saw both', async () => {
    // `s/fresh.md` was added above. A swap onto a generation that holds nothing reads every live path as removed.
    const [before] = await fx.database.db.select().from(documentChanges).where(eq(documentChanges.relativePath, 's/fresh.md'));
    await fx.database.db.transaction((tx) => recordRebuildChanges(tx, fx.projectId, NEXT, NEXT + 1, null));
    const [after] = await fx.database.db.select().from(documentChanges).where(eq(documentChanges.relativePath, 's/fresh.md'));
    expect(after.change).toBe('removed');
    expect(after.addedAt?.getTime()).toBe(before.addedAt?.getTime());
  });
});

describe('deleting a source', () => {
  let fx: Fixture;
  let notesRoot: string;
  let notesSourceId: string;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_delete_source');
    notesRoot = await mkdtemp(path.join(tmpdir(), 'whats_new_notes-'));
    await writeFile(path.join(notesRoot, 'standup.md'), body('original', 'standup'), 'utf8');
    await writeFile(path.join(notesRoot, 'retro.md'), body('original', 'retro'), 'utf8');
    const [notes] = await fx.database.db
      .insert(documentSources)
      .values({ projectId: fx.projectId, type: 'local', name: 'notes', config: { path: notesRoot, extensions: ['md'] } })
      .returning({ id: documentSources.id });
    notesSourceId = notes.id;
    await run(fx);
  });
  afterAll(async () => {
    await rm(notesRoot, { recursive: true, force: true });
    await dispose(fx);
  });

  it('records the source documents as removed, in the transaction that deletes them, and the filter still finds them', async () => {
    const db = fx.database.db;
    const since = await mark(db);
    await deleteSource(db, fx.projectId, notesSourceId);

    const remaining = await db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, fx.projectId));
    expect(remaining.some((r) => r.p.startsWith('notes/'))).toBe(false);

    const all = await changesSince(db, fx.projectId, since);
    expect(keysOf(all.changes)).toEqual(['removed:notes/retro.md', 'removed:notes/standup.md']);
    expect(all.changes.find((c) => c.path === 'notes/retro.md')?.title).toBe('retro');
    // The source is gone, and a filter by its name is still a filter by a path prefix.
    expect(keysOf((await changesSince(db, fx.projectId, since, { source: 'notes' })).changes)).toEqual([
      'removed:notes/retro.md',
      'removed:notes/standup.md',
    ]);
    expect((await changesSince(db, fx.projectId, since, { source: 'handbook' })).changes).toEqual([]);
  });
});

describe('deleting a source while a rebuild is running', () => {
  let fx: Fixture;
  let notesRoot: string;
  let notesSourceId: string;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_delete_race');
    notesRoot = await mkdtemp(path.join(tmpdir(), 'whats_new_race_notes-'));
    await writeFile(path.join(notesRoot, 'standup.md'), body('original', 'standup'), 'utf8');
    await writeFile(path.join(notesRoot, 'retro.md'), body('original', 'retro'), 'utf8');
    const [notes] = await fx.database.db
      .insert(documentSources)
      .values({ projectId: fx.projectId, type: 'local', name: 'notes', config: { path: notesRoot, extensions: ['md'] } })
      .returning({ id: documentSources.id });
    notesSourceId = notes.id;
    await run(fx);
  });
  afterAll(async () => {
    await rm(notesRoot, { recursive: true, force: true });
    await dispose(fx);
  });

  it('waits for the swap under the project lock, and then records the removal against the generation it published', async () => {
    const db = fx.database.db;
    // A note changes, so the swap would record it as modified: the removal has to be the last word on it.
    await writeFile(path.join(notesRoot, 'retro.md'), body('replacement', 'retro'), 'utf8');
    const since = await mark(db);
    const reached = gate.armAt(2);
    const job = fx.indexer.enqueue(fx.projectId, { force: true });
    await reached;

    // What `DELETE /api/projects/:id/sources/:sid` does: the deletion runs under the project's lock.
    let deleted = false;
    const deletion = fx.locks
      .runExclusive(fx.projectId, () => deleteSource(db, fx.projectId, notesSourceId))
      .then(() => {
        deleted = true;
      });
    await sleep(150);
    expect(deleted).toBe(false);
    expect((await getProjectById(db, fx.projectId))?.liveGeneration).toBe(0);

    gate.disarm();
    await settle(db, job);
    fx.indexer.forget(fx.projectId);
    await deletion;
    expect(deleted).toBe(true);
    expect((await getProjectById(db, fx.projectId))?.liveGeneration).toBe(1);

    // Both notes are removed, though one of them was rewritten by the rebuild that published just before.
    expect(keysOf((await changesSince(db, fx.projectId, since)).changes)).toEqual(['removed:notes/retro.md', 'removed:notes/standup.md']);
  });
});

describe('a RESET_VECTORS start', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_reset');
    await run(fx);
  });
  afterAll(() => dispose(fx));

  it('forgets the record and starts it again from now, in the transaction that deletes the documents', async () => {
    const db = fx.database.db;
    expect((await changesSince(db, fx.projectId, EPOCH)).changes).toHaveLength(4);
    await db.execute(sql`UPDATE settings SET value = '2020-01-01T00:00:00.000Z' WHERE key = 'document_changes_tracking_since'`);

    // A different dimension is what makes the bootstrap reset the vectors; the flag is what allows it.
    await bootstrapDatabase(db, { pool: fx.database.pool, dimensions: 1536, resetVectors: true, log: silentLogger });

    expect(await db.select().from(documents).where(eq(documents.projectId, fx.projectId))).toEqual([]);
    expect(await db.select().from(documentChanges)).toEqual([]);
    const started = await readTrackingSince(db);
    expect(started?.getTime()).toBeGreaterThan(Date.parse('2020-01-01'));
    expect(Date.now() - (started?.getTime() ?? 0)).toBeLessThan(10 * 60_000);
  });
});

describe("another project's changes", () => {
  let fx: Fixture;
  let otherRoot: string;
  let otherProjectId: string;
  let other: Indexer;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_isolation');
    otherRoot = await mkdtemp(path.join(tmpdir(), 'whats_new_other-'));
    for (const n of NAMES) await writeFile(path.join(otherRoot, `${n}.md`), body('original', n), 'utf8');
    const [project] = await fx.database.db.insert(projects).values({ name: 'whats-new-other' }).returning({ id: projects.id });
    otherProjectId = project.id;
    await fx.database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: otherRoot, extensions: ['md'] } });
    other = new Indexer({
      db: fx.database.db,
      embeddings,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(otherRoot)], DATA_DIR: path.join(otherRoot, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
    });
    await run(fx);
    await settle(fx.database.db, other.enqueue(otherProjectId));
  });
  afterAll(async () => {
    await rm(otherRoot, { recursive: true, force: true });
    await dispose(fx);
  });

  it('are not listed, though the paths are the same ones', async () => {
    const db = fx.database.db;
    const since = await mark(db);
    await writeFile(path.join(otherRoot, 'bravo.md'), body('replacement', 'bravo'), 'utf8');
    await settle(db, other.enqueue(otherProjectId));

    expect(keysOf((await changesSince(db, otherProjectId, since)).changes)).toEqual(['modified:handbook/bravo.md']);
    expect((await changesSince(db, fx.projectId, since)).changes).toEqual([]);
    // From the beginning, each sees its own four and no more.
    expect((await changesSince(db, fx.projectId, EPOCH)).changes).toHaveLength(4);
    expect((await changesSince(db, otherProjectId, EPOCH)).changes).toHaveLength(4);
  });
});

describe('retention', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_retention');
  });
  afterAll(() => dispose(fx));

  it('sweeps what is older than ninety days, by the database clock, and keeps the rest', async () => {
    const db = fx.database.db;
    const insertAged = (relativePath: string, days: number) =>
      db.execute(sql`
        INSERT INTO document_changes (project_id, relative_path, change, title, version, added_at, changed_at, run_id)
        VALUES (${fx.projectId}, ${relativePath}, 'modified', ${relativePath}, '', NULL, now() - make_interval(days => ${days}), NULL)`);
    await insertAged('aged/ninety-one.md', 91);
    await insertAged('aged/two-hundred.md', 200);
    await insertAged('aged/eighty-nine.md', 89);
    await insertAged('aged/today.md', 0);

    expect(await sweepDocumentChanges(db)).toBe(2);
    const left = await db.select({ p: documentChanges.relativePath }).from(documentChanges).where(eq(documentChanges.projectId, fx.projectId));
    expect(left.map((r) => r.p).sort()).toEqual(['aged/eighty-nine.md', 'aged/today.md']);
    // Nothing more to forget the second time.
    expect(await sweepDocumentChanges(db)).toBe(0);
  });
});

describe('when recording began', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_tracking');
  });
  afterAll(() => dispose(fx));

  it('is written by the bootstrap, recently, and is not overwritten by a later start', async () => {
    const db = fx.database.db;
    const first = await readTrackingSince(db);
    expect(first).not.toBeNull();
    expect(Date.now() - (first?.getTime() ?? 0)).toBeLessThan(10 * 60_000);

    await ensureTrackingSince(db);
    expect((await readTrackingSince(db))?.getTime()).toBe(first?.getTime());
  });

  it('is unknown when the setting is missing or is not a date', async () => {
    const db = fx.database.db;
    await db.execute(sql`UPDATE settings SET value = 'not a date' WHERE key = 'document_changes_tracking_since'`);
    expect(await readTrackingSince(db)).toBeNull();
    await db.execute(sql`DELETE FROM settings WHERE key = 'document_changes_tracking_since'`);
    expect(await readTrackingSince(db)).toBeNull();
  });
});

/**
 * Not part of the suite until somebody asks for it: `WHATS_NEW_BENCH=1`. ADR-0123 decision 3 leaves
 * *where* a rebuild's diff is computed to a measurement: inside the swap transaction, or, if that takes
 * over a second on 50 000 documents, before it. This runs the statement on that many and prints how
 * long it took, so the choice is made on a number.
 */
describe.skipIf(!process.env.WHATS_NEW_BENCH)('the swap statement at 50 000 documents (measurement)', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('whats_new_bench');
    const populate = (generation: number, changedEvery: number) =>
      fx.database.db.execute(sql`
        INSERT INTO documents (project_id, source_id, relative_path, title, content_hash, size_bytes, chunk_count, index_generation, content, content_truncated, version)
        SELECT ${fx.projectId}::uuid, NULL, 'bench/doc-' || g || '.md', 'Doc ' || g,
               CASE WHEN g % ${changedEvery} = 0 THEN 'new-' || g ELSE 'h' || g END,
               2000, 0, ${generation}::int,
               repeat('lorem ipsum dolor sit amet ', 80) || CASE WHEN g % ${changedEvery} = 0 THEN 'changed ' || g ELSE '' END,
               false, ''
        FROM generate_series(1, 50000) g`);
    await populate(0, 1_000_000_000);
    await populate(1, 20);
  }, 300_000);
  afterAll(() => dispose(fx));

  it('takes this long, and writes one change in twenty', async () => {
    const started = performance.now();
    const written = await fx.database.db.transaction((tx) => recordRebuildChanges(tx, fx.projectId, 0, 1, null));
    const elapsed = performance.now() - started;
    console.info(`recordRebuildChanges over 50 000 documents: ${elapsed.toFixed(0)} ms for ${written} changes`);
    expect(written).toBe(2500);
  }, 300_000);
});
