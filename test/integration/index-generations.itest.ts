import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { chunks, documentSources, documents, indexRuns, projects } from '../../src/db/schema.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { searchProject } from '../../src/services/search.js';
import { recountSources } from '../../src/services/sources.js';
import { recountProject, searchChunks, sweepGenerations } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * [ADR-0039](../../.ssot/ADR.md#adr-0039), which is a claim about what a client sees **while** a
 * forced re-index is running. That is not observable from outside the run, so the run is stopped from
 * the inside: the embedding provider below is a stub with a gate in it, and the test holds the gate.
 *
 * **Why this is deterministic and not a race that usually wins.** Nothing here sleeps and nothing
 * polls for the interesting moment. `embedPassages` counts its calls; on the armed call it resolves
 * `reached` and then awaits a promise only the test can settle. So the indexer is provably parked
 * between two documents — one of them already written into the new generation — for exactly as long
 * as the assertions take, and it cannot advance until the test says so. The searches run on other
 * connections of the same pool (`max: 10`), and the parked run holds no transaction: the gate is
 * awaited before `replaceDocument`, never inside it.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';

/** Word-hash bag of words, L2-normalised — the same deterministic stand-in `search.itest.ts` uses. */
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

/**
 * The gate. `armAt(n)` parks the run at the start of its `n`-th `embedPassages` call of the *current*
 * arming and hands back the promise that resolves when it gets there, plus the two ways out: let it
 * through, or make that call throw so the run fails exactly where it stands.
 */
class EmbedGate {
  private calls = 0;
  private armedAt: number | null = null;
  private announce: (() => void) | null = null;
  private open: ((value: 'go') => void) | null = null;
  private fail: ((error: Error) => void) | null = null;
  private held: Promise<'go'> | null = null;

  armAt(call: number): Promise<void> {
    this.calls = 0;
    this.armedAt = call;
    this.held = new Promise<'go'>((resolve, reject) => {
      this.open = resolve;
      this.fail = reject;
    });
    return new Promise<void>((resolve) => {
      this.announce = resolve;
    });
  }

  /** Let every call through from here on — the shape of a run with nothing to prove. */
  disarm(): void {
    this.armedAt = null;
    this.open?.('go');
  }

  breakRun(message: string): void {
    this.armedAt = null;
    this.fail?.(new Error(message));
  }

  /** Called by the stub provider on every batch. Returns immediately unless this is the armed call. */
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
  // Deliberately not routed through `embedPassages`: a warmup that consumed a gate count would make
  // "the second document of the run" mean something different on the first run and on the second.
  warmup: async () => {},
  embedPassages: async (texts: string[]) => {
    await gate.pass();
    return texts.map(stubVector);
  },
  embedQuery: async (text: string) => stubVector(text),
};

/** Each file is one chunk at these settings, so one `embedPassages` call is one document. */
const indexerConfig = {
  ALLOWED_DOC_ROOTS: [] as string[],
  IGNORE_GLOBS: [] as string[],
  CHUNK_MAX_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 64,
  EMBEDDING_BATCH_SIZE: 64,
  DATA_DIR: '',
  SECRET_KEY: '0'.repeat(64),
  MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
  MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
  MAX_PDF_PAGES: 2000,
  MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
};

/** The four documents of the corpus, in the order `walkMarkdown` sorts them. */
const FILES = ['alpha.md', 'bravo.md', 'charlie.md', 'delta.md'];

function body(marker: string, name: string): string {
  return `# ${name}\n\nThe ${marker} handbook explains how to rotate the ${name} secret from the source panel.\n`;
}

const QUERY = 'rotate the alpha secret';

/**
 * The job object the indexer mutates in place; this waits for it to leave the active phases, and then
 * for the project row to stop saying `indexing`.
 *
 * **The second wait is not belt and braces.** On the failure path the indexer marks the job `error`
 * first and writes `projects.status` afterwards — deliberately, so that a run whose *status write*
 * fails still leaves a settled job rather than one parked in an active phase forever. A test that reads
 * the row the instant the job settles is therefore reading it one statement early, and on a database
 * that a dozen test files are sharing that statement is long enough to lose.
 */
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

async function generationsOf(db: Db, projectId: string): Promise<number[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT index_generation AS g FROM documents WHERE project_id = ${projectId} ORDER BY g`);
  return rows.rows.map((r) => (r as { g: number }).g);
}

interface Fixture {
  database: TestDatabase;
  indexer: Indexer;
  root: string;
  projectId: string;
  sourceId: string;
}

async function buildFixture(name: string, marker: string): Promise<Fixture> {
  const database = await createTestDatabase(baseUrl, name);
  await applySchema(database, DIMS);

  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  for (const file of FILES) await writeFile(path.join(root, file), body(marker, file.replace('.md', '')), 'utf8');

  const [project] = await database.db
    .insert(projects)
    .values({ name: name.replace(/_/g, '-') })
    .returning({ id: projects.id });
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } })
    .returning({ id: documentSources.id });

  const indexer = new Indexer({
    db: database.db,
    embeddings,
    // The allowed root is the temp directory's parent, so `resolveProjectRoot` resolves the real path
    // on both sides — macOS puts `/var/folders/...` behind a `/private` symlink.
    config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
    log: silentLogger,
    locks: new KeyedMutex(),
  });

  return { database, indexer, root, projectId: project.id, sourceId: source.id };
}

describe('a forced re-index while a client is searching', () => {
  let fx: Fixture;
  let baseline: Awaited<ReturnType<typeof searchChunks>>;
  let baselineCounts: { chunkCount: number; documentCount: number };

  beforeAll(async () => {
    fx = await buildFixture('generations_rebuild', 'original');

    const first = await settle(fx.database.db, fx.indexer.enqueue(fx.projectId));
    expect(first.phase).toBe('done');
    fx.indexer.forget(fx.projectId);

    const project = await getProjectById(fx.database.db, fx.projectId);
    expect(project?.liveGeneration).toBe(0);
    expect(project?.documentCount).toBe(FILES.length);
    expect(project?.chunkCount).toBeGreaterThan(0);
    baselineCounts = { chunkCount: project?.chunkCount ?? 0, documentCount: project?.documentCount ?? 0 };

    baseline = await searchChunks(fx.database.db, {
      projectId: fx.projectId,
      generation: 0,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline.every((hit) => hit.content.includes('original'))).toBe(true);
  });

  afterAll(async () => {
    await rm(fx.root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, fx.database);
  });

  it('serves the previous index, unchanged, from inside the rebuild', async () => {
    // New bytes on disk, so "the old index is still being served" is a claim about content and not
    // only about row counts: every chunk the rebuild writes says `replacement`.
    for (const file of FILES) await writeFile(path.join(fx.root, file), body('replacement', file.replace('.md', '')), 'utf8');

    const reached = gate.armAt(2); // parked on the second document, with the first already written
    const job = fx.indexer.enqueue(fx.projectId, { force: true });
    await reached;

    // Both generations are in the table at the same time. That is the mechanism, seen directly.
    expect(await generationsOf(fx.database.db, fx.projectId)).toEqual([0, 1]);

    // And the project still points at the old one, with the counters that describe it.
    const mid = await getProjectById(fx.database.db, fx.projectId);
    expect(mid?.liveGeneration).toBe(0);
    expect(mid?.chunkCount).toBe(baselineCounts.chunkCount);
    expect(mid?.documentCount).toBe(baselineCounts.documentCount);
    expect(mid?.chunkCount).toBeGreaterThan(0);

    // The product's own read path, which is what an agent is on: not a refusal, and the old text.
    const outcome = await searchProject({ db: fx.database.db, embeddings }, { projectId: fx.projectId, query: QUERY, limit: 5 });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.hits.map((hit) => `${hit.file}|${hit.content}`)).toEqual(baseline.map((hit) => `${hit.file}|${hit.content}`));
    expect(outcome.hits.some((hit) => hit.content.includes('replacement'))).toBe(false);

    // The counters, recomputed from the live generation while the other one exists. Without the
    // generation predicate both of these would be roughly double and look entirely plausible.
    expect(await recountProject(fx.database.db, fx.projectId, 0)).toEqual(baselineCounts);
    await recountSources(fx.database.db, fx.projectId, 0);
    const [source] = await fx.database.db.select().from(documentSources).where(eq(documentSources.id, fx.sourceId));
    expect(source.documentCount).toBe(FILES.length);

    // Fail it where it stands, and the previous generation must still be the live one.
    gate.breakRun('embedding provider exploded mid-rebuild');
    await settle(fx.database.db, job);
    expect(job.phase).toBe('error');

    const after = await getProjectById(fx.database.db, fx.projectId);
    expect(after?.liveGeneration).toBe(0);
    expect(after?.status).toBe('error');
    expect(after?.chunkCount).toBe(baselineCounts.chunkCount);
    expect(after?.lastError).toMatch(/exploded mid-rebuild/);

    const stillThere = await searchChunks(fx.database.db, {
      projectId: fx.projectId,
      generation: 0,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(stillThere.map((hit) => hit.content)).toEqual(baseline.map((hit) => hit.content));

    // The failed run dropped what it had built, on its way out.
    expect(await generationsOf(fx.database.db, fx.projectId)).toEqual([0]);
    fx.indexer.forget(fx.projectId);
  });

  it('collects a generation no run was alive to clean up', async () => {
    // What a `docker kill` in the middle of a rebuild leaves behind: rows in a generation that was
    // never made live, and no process that remembers them. Written by hand because the only other
    // way to produce it is to kill the process running the test.
    const [orphan] = await fx.database.db
      .insert(documents)
      .values({
        projectId: fx.projectId,
        sourceId: fx.sourceId,
        relativePath: 'handbook/alpha.md',
        title: 'Alpha',
        contentHash: 'abandoned',
        sizeBytes: 10,
        chunkCount: 1,
        indexGeneration: 7,
      })
      .returning({ id: documents.id });
    await fx.database.db.insert(chunks).values({
      projectId: fx.projectId,
      documentId: orphan.id,
      chunkIndex: 0,
      headingPath: 'Alpha',
      content: 'abandoned content nobody should ever be served',
      tokenCount: 8,
      embedding: await embeddings.embedQuery(QUERY),
      indexGeneration: 7,
    });

    // It is an exact match for the query and it still does not appear: the generation predicate is
    // doing the work, not the distance.
    const hits = await searchChunks(fx.database.db, {
      projectId: fx.projectId,
      generation: 0,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(hits.some((hit) => hit.content.includes('abandoned'))).toBe(false);
    expect(await recountProject(fx.database.db, fx.projectId, 0)).toEqual(baselineCounts);

    expect(await sweepGenerations(fx.database.db, fx.projectId, 0)).toBe(1);
    expect(await generationsOf(fx.database.db, fx.projectId)).toEqual([0]);
    const [{ n }] = await fx.database.db.select({ n: sql<number>`count(*)::int` }).from(chunks).where(eq(chunks.documentId, orphan.id));
    expect(n).toBe(0); // the chunks went with it, by cascade
    expect(await sweepGenerations(fx.database.db, fx.projectId, 0)).toBe(0); // idempotent
  });

  it('publishes the next attempt, and reclaims the generation it replaced', async () => {
    gate.disarm(); // nothing parked: the run goes straight through
    const job = await settle(fx.database.db, fx.indexer.enqueue(fx.projectId, { force: true }));
    expect(job.phase).toBe('done');

    const project = await getProjectById(fx.database.db, fx.projectId);
    expect(project?.liveGeneration).toBe(1);
    expect(project?.status).toBe('idle');
    expect(project?.documentCount).toBe(FILES.length);

    // The new text is what is served now, and the old generation is gone rather than merely unread.
    const hits = await searchChunks(fx.database.db, {
      projectId: fx.projectId,
      generation: 1,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.content.includes('replacement'))).toBe(true);
    expect(await generationsOf(fx.database.db, fx.projectId)).toEqual([1]);

    // `index_runs.generation` answers "which run produced the index being served" without a search:
    // the rebuilds carry a number, the first incremental run carries NULL.
    const runs = await fx.database.db.select().from(indexRuns).where(eq(indexRuns.projectId, fx.projectId));
    expect(runs.filter((run) => run.mode === 'incremental').map((run) => run.generation)).toEqual([null]);
    expect(runs.filter((run) => run.mode === 'force' && run.status === 'done').map((run) => run.generation)).toEqual([1]);
    fx.indexer.forget(fx.projectId);
  });
});

describe('a rebuild whose source cannot be read at all', () => {
  let fx: Fixture;
  let baseline: Awaited<ReturnType<typeof searchChunks>>;

  beforeAll(async () => {
    fx = await buildFixture('generations_unreadable', 'original');
    const first = await settle(fx.database.db, fx.indexer.enqueue(fx.projectId));
    expect(first.phase).toBe('done');
    fx.indexer.forget(fx.projectId);
    baseline = await searchChunks(fx.database.db, {
      projectId: fx.projectId,
      generation: 0,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(baseline.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await rm(fx.root, { recursive: true, force: true }).catch(() => undefined);
    await rm(`${fx.root}-moved`, { recursive: true, force: true }).catch(() => undefined);
    await dropTestDatabase(baseUrl, fx.database);
  });

  it('abandons the swap rather than publishing a generation with a source missing from it', async () => {
    // The directory is gone, so `docRoot()` throws and the source contributes no scan at all — the
    // one condition ADR-0010 calls "protected" and ADR-0039 makes fatal to a rebuild.
    await rename(fx.root, `${fx.root}-moved`);

    const job = await settle(fx.database.db, fx.indexer.enqueue(fx.projectId, { force: true }));
    expect(job.phase).toBe('error');
    expect(job.error).toMatch(/Full re-index abandoned/);
    expect(job.error).toMatch(/previous index is still being served/);

    const project = await getProjectById(fx.database.db, fx.projectId);
    expect(project?.liveGeneration).toBe(0);
    expect(project?.status).toBe('error');
    expect(project?.documentCount).toBe(FILES.length);

    // Nothing was written into a new generation, and nothing was taken out of the live one.
    expect(await generationsOf(fx.database.db, fx.projectId)).toEqual([0]);
    const hits = await searchChunks(fx.database.db, {
      projectId: fx.projectId,
      generation: 0,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(hits.map((hit) => hit.content)).toEqual(baseline.map((hit) => hit.content));
    fx.indexer.forget(fx.projectId);
  });

  it('still protects the same documents on an incremental run, exactly as ADR-0010 says', async () => {
    const job = await settle(fx.database.db, fx.indexer.enqueue(fx.projectId));
    expect(job.phase).toBe('error'); // the source failed; the project says so
    expect(job.filesRemoved).toBe(0); // and not one document was deleted for it

    const project = await getProjectById(fx.database.db, fx.projectId);
    expect(project?.liveGeneration).toBe(0);
    expect(project?.documentCount).toBe(FILES.length);
    fx.indexer.forget(fx.projectId);
  });
});
