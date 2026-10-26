import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import cookie from '@fastify/cookie';
import { count, desc, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { assembleReport, corpusFiles, evalTextSearchConfigs, indexCorpus, measureProject } from '../../scripts/eval.js';
import { adminRoutes } from '../../src/admin/routes.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { type Config, loadConfig, WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { auditEvents, documentSources, documents, evalRuns, projects, searchQueries } from '../../src/db/schema.js';
import { createProjectVectorIndex } from '../../src/db/vector-indexes.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { AuditWriter } from '../../src/services/audit.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { createUser } from '../../src/services/auth/users.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { NO_FLOORS, parseGoldenSet } from '../../src/services/eval-scoring.js';
import { EvalRunner, getEvalRun, listEvalRuns, MAX_KEPT_EVAL_RUNS } from '../../src/services/eval-runs.js';
import { replaceGoldenQuestions } from '../../src/services/golden-questions.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { createProject, getProjectById } from '../../src/services/projects.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { UploadService } from '../../src/services/uploads.js';
import { scanFrom, selectionFrom } from '../../src/services/vector-store.js';
import { seedDocument, seedProject, STUB_MODEL_ID, stubEmbeddings, stubVector } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The server's own golden-set runs ([ADR-0124](../../.ssot/ADR.md#adr-0124)), over a real database.
 *
 * Three claims carry the phase, each with a test of its own below:
 *
 * 1. **The server's figure is the CLI's.** The repository's own golden set, asked through the runner and
 *    through `measureProject` (what `npm run eval -- --project` runs), gives the same recall@5 and MRR to the
 *    last digit.
 * 2. **A lost question is a regression.** A real indexer, a real source directory: the answer file is replaced
 *    by an unrelated text while five or more other pages stay about the question, the incremental run triggers
 *    a run, and that run reports the question lost. The run before it found the question.
 * 3. **A failing run is a row, and nothing else.** The encoder is made to fail; the run records `error`, and
 *    search and indexing go on as before.
 *
 * The rest holds the decisions around them: the skip rule, the comparison base, the triggers, the debounce,
 * the one-running-one-waiting coalescing, the single server slot, the hundred-run cap, the roles and the
 * audit. The encoder is the deterministic bag of words the other integration files use, so the figures say
 * only that two paths agree, not how good any model is.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const ADMIN = { authorization: 'Bearer a-token-for-a-test' };
const SAME_SITE = { 'sec-fetch-site': 'same-origin' };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `vi.waitFor` gives up after a second; a run behind a loaded container can take longer. */
async function until(condition: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Parks a query embedding until the test opens the gate, so a run can be looked at while it is running. */
class QueryGate {
  private parked: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private reached: (() => void) | null = null;

  /** Arms the gate; resolves when a query has reached it. */
  arm(): Promise<void> {
    this.parked = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    return new Promise<void>((resolve) => {
      this.reached = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.parked = null;
  }

  async pass(): Promise<void> {
    const parked = this.parked;
    if (parked === null) return;
    this.reached?.();
    this.reached = null;
    await parked;
  }
}

const gate = new QueryGate();

/** The stub encoder with a gate on the query side only: indexing is not held, a run is. */
const gatedEmbeddings: EmbeddingProvider = {
  ...stubEmbeddings,
  embedQuery: async (text: string) => {
    await gate.pass();
    return stubVector(text);
  },
};

let database: TestDatabase;
let db: Db;
let dataDir: string;
let config: Config;
let app: FastifyInstance;
let audit: AuditWriter;
let runner: EvalRunner;
let metrics: MetricsRegistry;
let sequence = 0;

function envFor(url: string): Record<string, string> {
  return {
    DATABASE_URL: url,
    SECRET_KEY: '0'.repeat(64),
    SEARCH_SCORE_FLOOR: '0',
    ALLOWED_DOC_ROOTS: '/docs',
    DATA_DIR: dataDir,
    AUTH_COOKIE_SECURE: '0',
  };
}

function newRunner(embeddings: EmbeddingProvider, observer: MetricsRegistry | undefined = undefined, goldenSetDebounceMs = 30): EvalRunner {
  return new EvalRunner({
    db,
    embeddings,
    scan: scanFrom(config),
    selection: selectionFrom(config),
    log: silentLogger,
    ...(observer ? { metrics: observer } : {}),
    goldenSetDebounceMs,
  });
}

async function buildApi(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie);
  const apiConfig = {
    ALLOWED_ORIGINS: [],
    ALLOWED_DOC_ROOTS: ['/docs'],
    CHUNK_MAX_TOKENS: 400,
    AUTH_SESSION_IDLE_MS: 60_000,
    AUTH_COOKIE_SECURE: '0',
    DATA_DIR: dataDir,
    DATA_DIR_MIN_FREE_BYTES: 0,
    EMBEDDING_DTYPE: 'fp32',
    SECRET_KEY: undefined,
    UPLOAD_MAX_FILE_BYTES: 1024 * 1024,
    UPLOAD_MAX_FILES_PER_REQUEST: 10,
    UPLOAD_MAX_ARCHIVE_BYTES: 1024 * 1024,
    ARCHIVE_MAX_ENTRIES: 100,
    ARCHIVE_MAX_TOTAL_BYTES: 1024 * 1024,
    PROJECT_MAX_DOCUMENTS: 0,
    PROJECT_MAX_CHUNKS: 0,
    PROJECT_MAX_UPLOAD_BYTES: 0,
    ADMIN_TOKEN: 'a-token-for-a-test',
    METRICS_TOKEN: 'a-scrape-token-long-enough',
    METRICS_PUBLIC: false,
  };
  const ctx = {
    config: apiConfig,
    db,
    log: silentLogger,
    embeddings: gatedEmbeddings,
    chunkBudget: { checked: true },
    indexer: {
      stats: () => ({ interactive: 0, scheduled: 0, running: 0 }),
      isBusy: () => false,
      getJob: () => undefined,
      queueInfo: () => undefined,
      enqueue: (projectId: string) => ({ projectId, phase: 'queued' }),
    },
    evalRuns: runner,
    locks: new KeyedMutex(),
    uploads: new UploadService(apiConfig as ConstructorParameters<typeof UploadService>[0]),
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    metrics,
    audit,
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  return instance;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'eval_runs');
  await applySchema(database, DIMS);
  db = database.db;
  dataDir = await fs.mkdtemp(path.join(tmpdir(), 'eval-runs-'));
  config = loadConfig(envFor(database.url));
  metrics = new MetricsRegistry();
  audit = new AuditWriter(db, silentLogger);
  runner = newRunner(gatedEmbeddings, metrics);
  app = await buildApi();
});

afterAll(async () => {
  gate.release();
  await runner?.stop();
  await app?.close();
  if (database) await dropTestDatabase(baseUrl, database);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

/** A project with two pages, `a.md` about alpha and `b.md` about beta, and a source named `handbook`. */
async function seedTwoPages(prefix: string): Promise<{ id: string; name: string; sourceId: string }> {
  const name = `${prefix}-${sequence++}`;
  const project = await seedProject(db, name, { path: 'a.md', body: '# Alpha\n\nAlpha is the first letter, and the alpha stage runs first.' });
  const [source] = await db.select({ id: documentSources.id }).from(documentSources).where(eq(documentSources.projectId, project.id));
  await seedDocument(db, project.id, source.id, 'b.md', '# Beta\n\nBeta is the second letter, and the beta stage runs second.');
  return { id: project.id, name, sourceId: source.id };
}

const TWO_QUESTIONS = [
  { key: 'q-a', lang: 'en' as const, query: 'what does the alpha stage do', expectFile: 'a.md', tags: [] },
  { key: 'q-b', lang: 'en' as const, query: 'what does the beta stage do', expectFile: 'b.md', tags: [] },
];

/** Asks the manual way and waits for the row that run writes. */
async function runNow(r: EvalRunner, projectId: string) {
  const outcome = await r.requestManual(projectId);
  expect(outcome.status).toBe('started');
  if (outcome.status !== 'started') throw new Error('unreachable');
  await r.settled();
  return getEvalRun(db, projectId, outcome.runId);
}

const rowsOf = (projectId: string) =>
  db.select().from(evalRuns).where(eq(evalRuns.projectId, projectId)).orderBy(desc(evalRuns.startedAt), desc(evalRuns.id));

describe('the server scores like the CLI path (diff 0)', () => {
  const CORPUS_DIR = 'eval/corpus';
  let corpusProjectId: string;
  let corpusProjectName: string;

  beforeAll(async () => {
    const [project] = await db.insert(projects).values({ name: 'halyard' }).returning({ id: projects.id, liveGeneration: projects.liveGeneration });
    await createProjectVectorIndex(db, project.id);
    const files = await corpusFiles(CORPUS_DIR);
    const indexed = await indexCorpus(db, stubEmbeddings, config, project.id, project.liveGeneration, files, evalTextSearchConfigs(), CORPUS_DIR);
    await db
      .update(projects)
      .set({ chunkCount: indexed.chunks, documentCount: indexed.documents, embeddingModel: stubEmbeddings.id, lastIndexedAt: new Date() })
      .where(eq(projects.id, project.id));
    corpusProjectId = project.id;
    corpusProjectName = 'halyard';
    const golden = parseGoldenSet(await fs.readFile('eval/golden.jsonl', 'utf8'), new Set(files));
    await replaceGoldenQuestions(
      db,
      project.id,
      golden.map((row) => ({
        key: row.id,
        lang: row.lang,
        query: row.query,
        expectFile: row.expectFile,
        expectHeading: row.expectHeading ?? null,
        tags: row.tags,
        note: row.note ?? null,
      })),
    );
  });

  it('gives the same recall@5 and MRR as `npm run eval -- --project`, to the last digit', async () => {
    const run = await runNow(runner, corpusProjectId);
    expect(run.status, run.error ?? '').toBe('ok');

    const measured = await measureProject(db, config, stubEmbeddings, null, corpusProjectName, []);
    const report = assembleReport(measured.results, [], {} as Parameters<typeof assembleReport>[2], NO_FLOORS, 0, false);
    expect(run.scoredCount).toBe(measured.golden.length);
    expect(run.questionCount).toBe(measured.golden.length + measured.skipped.length);
    expect(report.overall.recall5).toBeGreaterThan(0);
    expect(run.recall5).toBe(report.overall.recall5);
    expect(run.mrr).toBe(report.overall.mrr);
    // The per-question ranks are the CLI's too, not just their means.
    const cliRanks = new Map(measured.results.map((r) => [r.row.id, r.rank]));
    expect(run.results).toHaveLength(measured.results.length);
    for (const result of run.results ?? []) expect(result.rank, result.key).toBe(cliRanks.get(result.key));
    expect(run).toMatchObject({ trigger: 'manual', regressed: false, comparedTo: null, lostKeys: [], skippedKeys: [], newlySkippedKeys: [] });
  });

  it('keeps question text out of the row and records no query of its own (ADR-0047)', async () => {
    const [latest] = await rowsOf(corpusProjectId);
    const serialised = JSON.stringify(latest);
    const measured = await measureProject(db, config, stubEmbeddings, null, corpusProjectName, []);
    for (const row of measured.golden.slice(0, 10)) expect(serialised).not.toContain(row.query);
    const [{ rows }] = await db.select({ rows: count() }).from(searchQueries);
    expect(rows).toBe(0);
  });

  it('compares the next run with this one and finds nothing lost in an unchanged index', async () => {
    const [first] = await rowsOf(corpusProjectId);
    const second = await runNow(runner, corpusProjectId);
    expect(second).toMatchObject({ status: 'ok', comparedTo: first.id, regressed: false, lostKeys: [] });
    expect(second.recall5).toBe(first.recall5);
    expect(second.mrr).toBe(first.mrr);
  });
});

describe('a question about a page that is not in the index', () => {
  it('is skipped, listed, kept out of the figures, and warned about only once it was asked before (ADR-0124 rule 5)', async () => {
    const project = await seedTwoPages('skip');
    await replaceGoldenQuestions(db, project.id, [
      ...TWO_QUESTIONS,
      { key: 'q-gone', lang: 'en', query: 'what does gamma do', expectFile: 'gone.md', tags: [] },
    ]);

    const first = await runNow(runner, project.id);
    expect(first).toMatchObject({ status: 'ok', questionCount: 3, scoredCount: 2, skippedKeys: ['q-gone'], newlySkippedKeys: [], regressed: false });
    expect(first.recall5).toBe(1);

    // A page goes away. The question that was asked is now skipped and named as newly so; nothing is lost.
    await db.delete(documents).where(eq(documents.relativePath, 'b.md'));
    const second = await runNow(runner, project.id);
    expect(second).toMatchObject({
      status: 'ok',
      scoredCount: 1,
      skippedKeys: ['q-b', 'q-gone'],
      newlySkippedKeys: ['q-b'],
      lostKeys: [],
      regressed: false,
    });

    // Nothing left to ask is an error, and says which questions it could not ask.
    await db.delete(documents).where(eq(documents.relativePath, 'a.md'));
    const third = await runNow(runner, project.id);
    expect(third).toMatchObject({
      status: 'error',
      scoredCount: 0,
      recall5: null,
      mrr: null,
      skippedKeys: ['q-a', 'q-b', 'q-gone'],
      regressed: false,
    });
    expect(third.error).toMatch(/No question can be scored/);
  });

  it('compares against the last good run, not against an error in between', async () => {
    const project = await seedTwoPages('base');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const good = await runNow(runner, project.id);
    const broken = newRunner({ ...stubEmbeddings, embedQuery: async () => Promise.reject(new Error('encoder offline')) });
    const failed = await runNow(broken, project.id);
    expect(failed.status).toBe('error');
    const next = await runNow(runner, project.id);
    expect(next).toMatchObject({ status: 'ok', comparedTo: good.id });
  });
});

describe('a run that cannot finish', () => {
  it('records an error and leaves search and indexing as they were (ADR-0124)', async () => {
    const project = await seedTwoPages('failing');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const before = await getProjectById(db, project.id);
    const observer = new MetricsRegistry();
    const broken = newRunner({ ...stubEmbeddings, embedQuery: async () => Promise.reject(new Error('encoder offline')) }, observer);

    const run = await runNow(broken, project.id);
    expect(run).toMatchObject({ status: 'error', recall5: null, mrr: null, regressed: false, results: [] });
    expect(run.error).toContain('encoder offline');
    expect(observer.evalRuns()).toEqual({ runs: 1, errors: 1, regressions: 0 });

    // The project row is untouched, the documents are all there, and the same search through a working
    // encoder answers as it did.
    const after = await getProjectById(db, project.id);
    expect(after).toEqual(before);
    expect((await db.select({ rows: count() }).from(documents).where(eq(documents.projectId, project.id)))[0]?.rows).toBe(2);
    const ok = await runNow(runner, project.id);
    expect(ok).toMatchObject({ status: 'ok', recall5: 1 });
  });

  it('says so when the project was indexed with another encoder', async () => {
    const project = await seedTwoPages('other-model');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const other = newRunner({ ...stubEmbeddings, id: 'local:another-encoder:fp32' });
    const run = await runNow(other, project.id);
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/was indexed with local:stub-bag-of-words:fp32 and this server embeds with local:another-encoder:fp32/);
    expect(run.embeddingModel).toBe(STUB_MODEL_ID);
  });

  it('records an error for a project with nothing indexed', async () => {
    const created = await createProject(db, { name: `empty-${sequence++}` }, []);
    await replaceGoldenQuestions(db, created.id, TWO_QUESTIONS);
    const run = await runNow(runner, created.id);
    expect(run).toMatchObject({ status: 'error', scoredCount: 0 });
    expect(run.error).toMatch(/nothing indexed/);
  });

  it('records an error when the index changed under it, and the swap has queued its own run', async () => {
    const project = await seedTwoPages('moved');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const reached = gate.arm();
    const outcome = await runner.requestManual(project.id);
    expect(outcome.status).toBe('started');
    await reached;
    await db.update(projects).set({ liveGeneration: 1 }).where(eq(projects.id, project.id));
    gate.release();
    await runner.settled();
    const [row] = await rowsOf(project.id);
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/The index changed during the run \(generation 0 to 1\)/);
    expect(row.generation).toBe(0);
  });

  it('writes no row for a run that shutdown cut short', async () => {
    const project = await seedTwoPages('stopped');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const stoppable = newRunner(gatedEmbeddings);
    const reached = gate.arm();
    expect((await stoppable.requestManual(project.id)).status).toBe('started');
    await reached;
    const stopping = stoppable.stop();
    gate.release();
    await stopping;
    expect(await rowsOf(project.id)).toHaveLength(0);
    // And a stopped runner starts nothing more.
    stoppable.request(project.id, 'index_rebuild');
    await stoppable.settled();
    expect(await rowsOf(project.id)).toHaveLength(0);
  });
});

describe('concurrency (ADR-0124 decision 3)', () => {
  it('coalesces triggers to one running run and one waiting, which keeps the strongest trigger', async () => {
    const project = await seedTwoPages('coalesce');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const reached = gate.arm();
    runner.request(project.id, 'index_incremental');
    await reached;
    // Five more while the first is parked: one waits, the rest are covered by it.
    runner.request(project.id, 'golden_set');
    runner.request(project.id, 'index_incremental');
    runner.request(project.id, 'index_rebuild');
    runner.request(project.id, 'index_incremental');
    runner.request(project.id, 'golden_set');
    gate.release();
    await until(async () => (await rowsOf(project.id)).length >= 2, 'both runs');
    await runner.settled();
    const rows = await rowsOf(project.id);
    expect(rows.map((r) => r.trigger)).toEqual(['index_rebuild', 'index_incremental']);
  });

  it('refuses a manual request while the project is running or waiting, with 409 over the API', async () => {
    const project = await seedTwoPages('busy');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const reached = gate.arm();
    const first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/eval-runs`, headers: ADMIN });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json().runId).toMatch(/^[0-9a-f-]{36}$/);
    await reached;

    const again = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/eval-runs`, headers: ADMIN });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().message).toMatch(/already going or waiting/);

    // A trigger waiting behind it counts as busy too.
    runner.request(project.id, 'golden_set');
    expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/eval-runs`, headers: ADMIN })).statusCode).toBe(409);

    // Another project is refused for the one server slot, not for itself.
    const other = await seedTwoPages('busy-other');
    await replaceGoldenQuestions(db, other.id, TWO_QUESTIONS);
    const elsewhere = await app.inject({ method: 'POST', url: `/api/projects/${other.id}/eval-runs`, headers: ADMIN });
    expect(elsewhere.statusCode, elsewhere.body).toBe(409);
    expect(elsewhere.json().message).toMatch(/another project/);

    gate.release();
    await until(async () => (await rowsOf(project.id)).length >= 2, 'the held run and the waiting one');
    await runner.settled();
    expect(await rowsOf(other.id)).toHaveLength(0);
  });

  it('runs one project at a time across the server: a second project waits for the slot', async () => {
    const one = await seedTwoPages('slot-one');
    const two = await seedTwoPages('slot-two');
    await replaceGoldenQuestions(db, one.id, TWO_QUESTIONS);
    await replaceGoldenQuestions(db, two.id, TWO_QUESTIONS);
    const reached = gate.arm();
    runner.request(one.id, 'index_rebuild');
    await reached;
    runner.request(two.id, 'index_rebuild');
    await sleep(100);
    expect(await rowsOf(two.id)).toHaveLength(0);
    gate.release();
    await until(async () => (await rowsOf(two.id)).length === 1 && (await rowsOf(one.id)).length === 1, 'both projects');
    await runner.settled();
    const [a] = await rowsOf(one.id);
    const [b] = await rowsOf(two.id);
    // The second started after the first finished.
    expect(b.startedAt.getTime()).toBeGreaterThanOrEqual(a.finishedAt.getTime());
  });

  it('folds triggers that arrive while a run still waits for the slot into that run, not into a second one', async () => {
    const one = await seedTwoPages('queued-one');
    const two = await seedTwoPages('queued-two');
    await replaceGoldenQuestions(db, one.id, TWO_QUESTIONS);
    await replaceGoldenQuestions(db, two.id, TWO_QUESTIONS);
    const reached = gate.arm();
    runner.request(one.id, 'index_rebuild');
    await reached;
    // Two has not started: it has the slot to wait for and has read nothing. Everything that arrives is its run.
    runner.request(two.id, 'golden_set');
    runner.request(two.id, 'index_incremental');
    runner.request(two.id, 'golden_set');
    runner.request(two.id, 'index_rebuild');
    gate.release();
    await until(async () => (await rowsOf(two.id)).length >= 1, 'the queued run');
    await sleep(150);
    await runner.settled();
    const rows = await rowsOf(two.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('index_rebuild');
  });

  it('does nothing for a project with no golden questions, and a manual request says why', async () => {
    const project = await seedTwoPages('no-questions');
    runner.request(project.id, 'index_rebuild');
    await runner.settled();
    expect(await rowsOf(project.id)).toHaveLength(0);
    const refused = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/eval-runs`, headers: ADMIN });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().message).toMatch(/no golden questions/);
  });
});

describe('a change to the golden set (debounced)', () => {
  it('asks the set once after the last of several edits', async () => {
    const project = await seedTwoPages('debounce');
    const base = `/api/projects/${project.id}/golden-questions`;
    for (const question of TWO_QUESTIONS) {
      const created = await app.inject({ method: 'POST', url: base, headers: ADMIN, payload: question });
      expect(created.statusCode, created.body).toBe(201);
    }
    await until(async () => (await rowsOf(project.id)).length >= 1, 'the golden_set run');
    await sleep(150);
    await runner.settled();
    const rows = await rowsOf(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'golden_set', status: 'ok', scoredCount: 2 });

    // Editing a question is a change too; deleting the whole set is a change that has nothing to ask.
    const [created] = (await app.inject({ method: 'GET', url: base, headers: ADMIN })).json().questions;
    expect((await app.inject({ method: 'PATCH', url: `${base}/${created.id}`, headers: ADMIN, payload: { note: 'edited' } })).statusCode).toBe(200);
    await until(async () => (await rowsOf(project.id)).length >= 2, 'the run after the edit');
    expect((await app.inject({ method: 'PUT', url: base, headers: ADMIN, payload: { questions: [] } })).statusCode).toBe(200);
    await sleep(150);
    await runner.settled();
    expect(await rowsOf(project.id)).toHaveLength(2);
  });

  it('does not read a rewritten question as a regression, because its fingerprint changed (rule 6)', async () => {
    const project = await seedTwoPages('rewrite');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const first = await runNow(runner, project.id);
    expect(first.recall5).toBe(1);
    // Same key, a different question about a page that does not answer it any more.
    await replaceGoldenQuestions(db, project.id, [{ ...TWO_QUESTIONS[0], query: 'zzz unrelated words that match nothing here' }, TWO_QUESTIONS[1]]);
    const second = await runNow(runner, project.id);
    expect(second).toMatchObject({ status: 'ok', comparedTo: first.id, lostKeys: [], regressed: false });
  });
});

describe('the history', () => {
  it('keeps the last hundred runs of a project and drops the oldest', async () => {
    const project = await seedTwoPages('cap');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const old = new Date('2026-01-01T00:00:00Z');
    await db.insert(evalRuns).values(
      Array.from({ length: MAX_KEPT_EVAL_RUNS }, (_, i) => ({
        projectId: project.id,
        trigger: 'manual' as const,
        status: 'ok' as const,
        generation: 0,
        embeddingModel: STUB_MODEL_ID,
        questionCount: 2,
        scoredCount: 2,
        recall5: 1,
        mrr: 1,
        results: [],
        startedAt: new Date(old.getTime() + i * 1000),
        finishedAt: new Date(old.getTime() + i * 1000 + 1),
      })),
    );
    const fresh = await runNow(runner, project.id);
    const rows = await rowsOf(project.id);
    expect(rows).toHaveLength(MAX_KEPT_EVAL_RUNS);
    expect(rows[0].id).toBe(fresh.id);
    expect(rows.at(-1)?.startedAt.toISOString()).toBe(new Date(old.getTime() + 1000).toISOString());
  });

  it('is removed with its project', async () => {
    const project = await seedTwoPages('cascade');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    await runNow(runner, project.id);
    expect(await rowsOf(project.id)).toHaveLength(1);
    await db.delete(projects).where(eq(projects.id, project.id));
    expect(await rowsOf(project.id)).toHaveLength(0);
  });

  it('counts runs, errors and regressions without a project label', async () => {
    const observer = new MetricsRegistry();
    const counting = newRunner(gatedEmbeddings, observer);
    const project = await seedTwoPages('counters');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    await runNow(counting, project.id);
    await db.delete(documents).where(eq(documents.relativePath, 'a.md'));
    await db.delete(documents).where(eq(documents.relativePath, 'b.md'));
    await runNow(counting, project.id);
    expect(observer.evalRuns()).toEqual({ runs: 2, errors: 1, regressions: 0 });
    // The process-wide registry the app uses has been counting too.
    expect(metrics.evalRuns().runs).toBeGreaterThan(5);
  });
});

describe('the admin API', () => {
  it('lists newest first without per-question ranks, reads one in full, and refuses what is not there', async () => {
    const project = await seedTwoPages('api');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const first = await runNow(runner, project.id);
    const second = await runNow(runner, project.id);
    const base = `/api/projects/${project.id}/eval-runs`;

    const listed = await app.inject({ method: 'GET', url: base, headers: ADMIN });
    expect(listed.statusCode, listed.body).toBe(200);
    const { runs } = listed.json();
    expect(runs.map((r: { id: string }) => r.id)).toEqual([second.id, first.id]);
    expect(runs[0]).toMatchObject({ trigger: 'manual', status: 'ok', recall5: 1, mrr: 1, regressed: false, comparedTo: first.id, lostKeys: [] });
    expect(runs[0]).not.toHaveProperty('results');

    const one = await app.inject({ method: 'GET', url: `${base}/${first.id}`, headers: ADMIN });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().results).toEqual([
      { key: 'q-a', fp: expect.stringMatching(/^[0-9a-f]{16}$/), rank: expect.any(Number) },
      { key: 'q-b', fp: expect.stringMatching(/^[0-9a-f]{16}$/), rank: expect.any(Number) },
    ]);

    expect((await app.inject({ method: 'GET', url: `${base}?limit=1`, headers: ADMIN })).json().runs).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `${base}?limit=0`, headers: ADMIN })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}?limit=101`, headers: ADMIN })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}/00000000-0000-4000-8000-000000000000`, headers: ADMIN })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${base}/not-a-uuid`, headers: ADMIN })).statusCode).toBe(400);
    // Another project's run id is not found under this one.
    const other = await seedTwoPages('api-other');
    expect((await app.inject({ method: 'GET', url: `/api/projects/${other.id}/eval-runs/${first.id}`, headers: ADMIN })).statusCode).toBe(404);

    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await app.inject({ method: 'GET', url: `/api/projects/${missing}/eval-runs`, headers: ADMIN })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${missing}/eval-runs`, headers: ADMIN })).statusCode).toBe(404);
    expect(await listEvalRuns(db, project.id, 500)).toHaveLength(2);
  });

  it('follows the project roles: a viewer reads, an editor still cannot ask, a manager can', async () => {
    const project = await seedTwoPages('roles');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    await runNow(runner, project.id);
    const base = `/api/projects/${project.id}/eval-runs`;
    const user = await createUser(db, { username: `eval-member-${sequence++}`, role: 'member', password: 'a-member-password-1!' });
    const cookies = { [SESSION_COOKIE]: (await createSession(db, user.id, 1, { userAgent: 'probe' })).token };

    expect((await app.inject({ method: 'GET', url: base, cookies })).statusCode).toBe(404);
    await setMemberRole(db, project.id, user.id, 'viewer', null);
    expect((await app.inject({ method: 'GET', url: base, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: base, cookies, headers: SAME_SITE })).statusCode).toBe(403);
    await setMemberRole(db, project.id, user.id, 'editor', null);
    expect((await app.inject({ method: 'POST', url: base, cookies, headers: SAME_SITE })).statusCode).toBe(403);
    expect(await rowsOf(project.id)).toHaveLength(1);
  });

  it('audits a request for a run', async () => {
    const project = await seedTwoPages('audit');
    await replaceGoldenQuestions(db, project.id, TWO_QUESTIONS);
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/eval-runs`, headers: ADMIN });
    expect(res.statusCode, res.body).toBe(202);
    await runner.settled();
    await audit.settled();
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'POST /api/projects/:id/eval-runs'))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    expect(event).toMatchObject({ projectId: project.id, statusCode: 202 });
  });
});

/**
 * Claim 2, and the triggers, with the real indexer: a local source directory, files rewritten on disk,
 * `enqueue` and a settled job, the indexer's own hook wired to a runner as `server.ts` wires it.
 */
describe('a run after the index changes, with the real indexer', () => {
  const RELATED = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const QUESTION = 'how do I rotate the signing secret';
  const answer = 'The signing secret rotation guide: to rotate the signing secret, open the panel and rotate the signing secret there.\n';
  const unrelated = 'Pancakes need flour, milk and eggs. Whisk the batter, rest it, then fry it in butter until golden.\n';

  let root: string;
  let projectId: string;
  let indexer: Indexer;
  let locks: KeyedMutex;
  let hooked: EvalRunner;
  let hookedMetrics: MetricsRegistry;
  let hookCalls: Array<'index_rebuild' | 'index_incremental'>;

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

  /** Indexes, then waits until the hook has had its say: the lock is released after the callback that fires it. */
  async function index(force = false): Promise<JobState> {
    const job = indexer.enqueue(projectId, { force });
    const deadline = Date.now() + 60_000;
    while (job.phase !== 'done' && job.phase !== 'error') {
      if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
      await sleep(5);
    }
    await locks.runExclusive(projectId, async () => {});
    await sleep(30);
    await hooked.settled();
    indexer.forget(projectId);
    expect(job.error).toBeUndefined();
    return job;
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'eval-runs-source-'));
    await fs.writeFile(path.join(root, 'target.md'), `# Signing secret rotation\n\n${answer}`, 'utf8');
    for (const name of RELATED) {
      await fs.writeFile(
        path.join(root, `${name}.md`),
        `# Notes on ${name}\n\nThe ${name} stage may rotate its secret when the signing step finishes.\n`,
        'utf8',
      );
    }
    // A document with nothing in it is read on every run and writes nothing: the case `files_updated` mistakes for a change.
    await fs.writeFile(path.join(root, 'empty.md'), '', 'utf8');

    const [project] = await db
      .insert(projects)
      .values({ name: `indexer-fixture-${sequence++}` })
      .returning({ id: projects.id });
    projectId = project.id;
    await db.insert(documentSources).values({ projectId, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
    await replaceGoldenQuestions(db, projectId, [{ key: 'rotate-secret', lang: 'en', query: QUESTION, expectFile: 'handbook/target.md', tags: [] }]);

    locks = new KeyedMutex();
    hookedMetrics = new MetricsRegistry();
    hooked = newRunner(stubEmbeddings, hookedMetrics);
    hookCalls = [];
    indexer = new Indexer({
      db,
      embeddings: stubEmbeddings,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks,
      onIndexChanged: (id, trigger) => {
        hookCalls.push(trigger);
        hooked.request(id, trigger);
      },
    });
  });

  afterAll(async () => {
    await hooked?.stop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('finds the question before the answer is broken', async () => {
    await index();
    const [first] = await rowsOf(projectId);
    expect(first).toMatchObject({ trigger: 'index_incremental', status: 'ok', scoredCount: 1, regressed: false, comparedTo: null });
    const result = first.results?.find((r) => r.key === 'rotate-secret');
    expect(result?.rank, 'the answer file is in the page of the run before it is broken').not.toBeNull();
    expect(result?.rank as number).toBeLessThan(5);
    expect(first.recall5).toBe(1);
  });

  it('does not run when nothing was written, an empty document included (chunks_written, not files_updated)', async () => {
    const before = (await rowsOf(projectId)).length;
    const calls = hookCalls.length;
    await index();
    expect(hookCalls).toHaveLength(calls);
    expect(await rowsOf(projectId)).toHaveLength(before);
  });

  it('reports the question lost when the answer file stops answering it while other pages still do (acceptance 2)', async () => {
    const [good] = await rowsOf(projectId);
    await fs.writeFile(path.join(root, 'target.md'), `# Signing secret rotation\n\n${unrelated}`, 'utf8');
    await index();

    const [broken] = await rowsOf(projectId);
    expect(broken.id).not.toBe(good.id);
    expect(broken).toMatchObject({ trigger: 'index_incremental', status: 'ok', regressed: true, comparedTo: good.id, lostKeys: ['rotate-secret'] });
    expect(broken.recall5).toBe(0);
    const rank = broken.results?.find((r) => r.key === 'rotate-secret')?.rank;
    expect(rank === null || (rank as number) >= 5).toBe(true);
    expect(hookedMetrics.evalRuns().regressions).toBe(1);
  });

  it('runs after a swap, always, and does not call a repeat of the same broken index a regression', async () => {
    const [broken] = await rowsOf(projectId);
    const calls = hookCalls.length;
    await index(true);
    expect(hookCalls.slice(calls)).toEqual(['index_rebuild']);
    const [rebuilt] = await rowsOf(projectId);
    expect(rebuilt).toMatchObject({ trigger: 'index_rebuild', status: 'ok', comparedTo: broken.id, regressed: false, lostKeys: [], recall5: 0 });
    expect(rebuilt.generation).toBe(broken.generation + 1);
  });

  it('runs again when the answer is restored, and the question comes back', async () => {
    await fs.writeFile(path.join(root, 'target.md'), `# Signing secret rotation\n\n${answer}`, 'utf8');
    await index();
    const [fixed] = await rowsOf(projectId);
    expect(fixed).toMatchObject({ trigger: 'index_incremental', status: 'ok', regressed: false, recall5: 1 });
  });

  it('runs after a file is removed, though no chunk was written', async () => {
    const before = (await rowsOf(projectId)).length;
    await fs.unlink(path.join(root, 'hotel.md'));
    await index();
    const rows = await rowsOf(projectId);
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ trigger: 'index_incremental', status: 'ok' });
  });
});
