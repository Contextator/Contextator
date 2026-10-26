import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import cookie from '@fastify/cookie';
import { count, desc, eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { type Config, loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { auditEvents, documents, goldenQuestions, projects, searchQueries } from '../../src/db/schema.js';
import { PROJECT_VECTOR_INDEX_PREFIX, createProjectVectorIndex } from '../../src/db/vector-indexes.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { AuditWriter } from '../../src/services/audit.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { createUser } from '../../src/services/auth/users.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { GoldenRowSchema, listGoldenQuestions, replaceGoldenQuestions, toGoldenRow } from '../../src/services/golden-questions.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { createProject } from '../../src/services/projects.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { UploadService } from '../../src/services/uploads.js';
import { ImportRefusedError } from '../../src/services/transfer/manifest.js';
import { exportProject } from '../../src/services/transfer/export.js';
import { importProject } from '../../src/services/transfer/import.js';
import { aggregate, type NegativeResult, NO_FLOORS, parseGoldenSet, parseNegativeSet, type RowResult } from '../../src/services/eval-scoring.js';
import { askQuestions, assembleReport, corpusFiles, evalTextSearchConfigs, indexCorpus, makeAsk, measureProject } from '../../scripts/eval.js';
import { seedProject, STUB_MODEL_ID, stubEmbeddings } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A user's own question set (Faz 09 of 0.4.0, FR-347), end to end over a real database:
 *
 * - **the item's "done when"**: the repository's own `eval/golden.jsonl`, loaded into the table, is
 *   scored by the project path (`measureProject`, what `npm run eval -- --project` runs) exactly as the
 *   corpus path scores the file — row for row and figure for figure. Same scoring module, same `ask`,
 *   so any difference is a difference the table or the conversion introduced.
 * - the admin API's CRUD, roles and audit trail;
 * - the refusals `measureProject` makes instead of printing a meaningless number;
 * - the question set travelling in a project export (ADR-0051).
 *
 * The encoder is the deterministic bag of words the other integration files use: the figures are not
 * the retrieval quality of any model, only the claim that two paths agree.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const ADMIN = { authorization: 'Bearer a-token-for-a-test' };
// A cookie session's writes must look like the dashboard's (ADR-0055).
const SAME_SITE = { 'sec-fetch-site': 'same-origin' };

const CORPUS_DIR = 'eval/corpus';
const GOLDEN_PATH = 'eval/golden.jsonl';
const NEGATIVE_PATH = 'eval/negative.jsonl';
// A floor on the stub embeddings' cosine scale that refuses some questions and lets others through.
const REFUSING_FLOOR = 0.5;

let database: TestDatabase;
let dataDir: string;
let config: Config;
let app: FastifyInstance;
let audit: AuditWriter;
let corpusProjectId: string;

function envFor(url: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: url,
    SECRET_KEY: '0'.repeat(64),
    SEARCH_SCORE_FLOOR: '0',
    ALLOWED_DOC_ROOTS: '/docs',
    DATA_DIR: dataDir,
    AUTH_COOKIE_SECURE: '0',
    ...extra,
  };
}

async function buildApi(db: Db): Promise<{ app: FastifyInstance; audit: AuditWriter }> {
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
  const writer = new AuditWriter(db, silentLogger);
  const ctx = {
    config: apiConfig,
    db,
    log: silentLogger,
    embeddings: {
      id: STUB_MODEL_ID,
      provider: 'local',
      model: 'stub',
      dimensions: DIMS,
      ready: true,
      maxInputTokens: 128,
      truncatesAtTokens: 512,
      windowSource: 'known-model',
    },
    chunkBudget: { checked: true },
    indexer: {
      stats: () => ({ interactive: 0, scheduled: 0, running: 0 }),
      isBusy: () => false,
      getJob: () => undefined,
      queueInfo: () => undefined,
      enqueue: (projectId: string) => ({ projectId, phase: 'queued' }),
    },
    locks: new KeyedMutex(),
    uploads: new UploadService(apiConfig as ConstructorParameters<typeof UploadService>[0]),
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    metrics: new MetricsRegistry(),
    audit: writer,
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  return { app: instance, audit: writer };
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'golden_questions');
  await applySchema(database, DIMS);
  dataDir = await fs.mkdtemp(path.join(tmpdir(), 'golden-questions-'));
  config = loadConfig(envFor(database.url));
  ({ app, audit } = await buildApi(database.db));

  // The corpus project exactly as `runCorpus` builds it: the row, the index `createProject` would have
  // built, the corpus through the harness's own indexer, then the four columns `searchProject` reads.
  const db = database.db;
  const [project] = await db.insert(projects).values({ name: 'halyard' }).returning({ id: projects.id, liveGeneration: projects.liveGeneration });
  await createProjectVectorIndex(db, project.id);
  const files = await corpusFiles(CORPUS_DIR);
  const indexed = await indexCorpus(db, stubEmbeddings, config, project.id, project.liveGeneration, files, evalTextSearchConfigs(), CORPUS_DIR);
  await db
    .update(projects)
    .set({ chunkCount: indexed.chunks, documentCount: indexed.documents, embeddingModel: stubEmbeddings.id, lastIndexedAt: new Date() })
    .where(eq(projects.id, project.id));
  corpusProjectId = project.id;
});

afterAll(async () => {
  await app?.close();
  if (database) await dropTestDatabase(baseUrl, database);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

async function goldenFromFile() {
  const files = await corpusFiles(CORPUS_DIR);
  return parseGoldenSet(await fs.readFile(GOLDEN_PATH, 'utf8'), new Set(files));
}

async function negativeFromFile() {
  return parseNegativeSet(await fs.readFile(NEGATIVE_PATH, 'utf8'));
}

/** The golden file's rows as the API takes them: `id` is `key`. */
function asInputs(rows: Awaited<ReturnType<typeof goldenFromFile>>) {
  return rows.map((row) => ({
    key: row.id,
    lang: row.lang,
    query: row.query,
    expectFile: row.expectFile,
    expectHeading: row.expectHeading ?? null,
    tags: row.tags,
    note: row.note ?? null,
  }));
}

const REPORT_CONTEXT = {
  commit: 'test',
  providerId: stubEmbeddings.id,
  embeddingModel: stubEmbeddings.model,
  embeddingDtype: 'fp32',
  dimensions: DIMS,
  chunkMaxTokens: 400,
  chunkOverlapTokens: 0,
  searchLimit: 10,
  hnswScan: 'test',
  startedAt: '2026-01-01T00:00:00.000Z',
} as unknown as Parameters<typeof assembleReport>[2];

/**
 * The repository file asked in file order, and the same rows out of the table asked in key order, both
 * at one relevance floor — and the two reports side by side, as `--json` would print them.
 */
async function bothWays(floor: number) {
  const golden = await goldenFromFile();
  const negative = await negativeFromFile();
  expect(golden.length).toBeGreaterThan(50);
  const floored = loadConfig(envFor(database.url, { SEARCH_SCORE_FLOOR: String(floor) }));

  // The corpus path: the file, asked in file order.
  const ask = makeAsk({
    db: database.db,
    embeddings: stubEmbeddings,
    config: floored,
    reranker: null,
    projectId: corpusProjectId,
    refusalFloor: floor,
  });
  const viaFile = await askQuestions(ask, golden, negative);

  // The project path: the same rows out of the table, asked in key order.
  await replaceGoldenQuestions(database.db, corpusProjectId, asInputs(golden));
  const measured = await measureProject(database.db, floored, stubEmbeddings, null, 'halyard', negative);
  expect(measured.refusalFloor).toBe(floor);
  expect(measured.results).toHaveLength(golden.length);

  const reportOf = (r: { results: RowResult[]; negativeResults: NegativeResult[] }, refusalFloor: number) =>
    assembleReport(r.results, r.negativeResults, REPORT_CONTEXT, NO_FLOORS, refusalFloor, true);
  return { golden, viaFile, measured, fileReport: reportOf(viaFile, floor), tableReport: reportOf(measured, measured.refusalFloor) };
}

describe('a project question set scores like the repository file (diff 0)', () => {
  it('gives the same rows, the same report and the same refusal figures', async () => {
    const { viaFile, measured, fileReport, tableReport } = await bothWays(0);

    const byId = <T extends { row: { id: string } }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.row.id < b.row.id ? -1 : 1));
    expect(byId(measured.results)).toEqual(byId(viaFile.results));
    expect(byId(measured.negativeResults)).toEqual(byId(viaFile.negativeResults));

    // The whole report, to the last digit of every mean: the order the questions were asked in does not show.
    expect(tableReport).toEqual(fileReport);
    expect(JSON.stringify(tableReport, null, 2)).toBe(JSON.stringify(fileReport, null, 2));
  });

  // At floor 0 nothing is ever refused, so the test above cannot tell a floor applied correctly from one
  // never applied. Here the floor is high enough to refuse some golden and some negative questions.
  it('refuses the same questions on both paths at a floor that refuses some (ADR-0083)', async () => {
    const { viaFile, measured, fileReport, tableReport } = await bothWays(REFUSING_FLOOR);

    const refusedIds = (rows: readonly { row: { id: string }; refused?: boolean; belowFloor?: boolean }[], key: 'refused' | 'belowFloor') =>
      rows
        .filter((r) => r[key])
        .map((r) => r.row.id)
        .sort();
    expect(refusedIds(measured.results, 'belowFloor')).toEqual(refusedIds(viaFile.results, 'belowFloor'));
    expect(refusedIds(measured.negativeResults, 'refused')).toEqual(refusedIds(viaFile.negativeResults, 'refused'));

    expect(fileReport.refusals?.floor).toBe(REFUSING_FLOOR);
    expect(fileReport.refusals?.falseRefusal.refused).toBeGreaterThan(0);
    expect((fileReport.refusals?.absentFeature.refused ?? 0) + (fileReport.refusals?.offDomain.refused ?? 0)).toBeGreaterThan(0);
    expect(tableReport).toEqual(fileReport);
    expect(JSON.stringify(tableReport, null, 2)).toBe(JSON.stringify(fileReport, null, 2));
  });

  it('keeps the negative questions out of the table and out of the golden denominator (ADR-0045)', async () => {
    const negative = await negativeFromFile();
    expect(negative.length).toBeGreaterThan(0);
    const stored = new Set((await listGoldenQuestions(database.db, corpusProjectId)).map((r) => r.key));
    for (const row of negative) expect(stored.has(row.id)).toBe(false);

    const withNegatives = await measureProject(database.db, config, stubEmbeddings, null, 'halyard', negative);
    const without = await measureProject(database.db, config, stubEmbeddings, null, 'halyard', []);
    expect(withNegatives.results).toHaveLength(stored.size);
    expect(withNegatives.negativeResults).toHaveLength(negative.length);
    expect(without.negativeResults).toHaveLength(0);
    expect(aggregate(withNegatives.results)).toEqual(aggregate(without.results));
  });

  it('records no query of its own (ADR-0047)', async () => {
    const [{ rows }] = await database.db.select({ rows: count() }).from(searchQueries);
    expect(rows).toBe(0);
  });

  it('decides refusal against the instance floor, or the project own when it holds one (ADR-0083)', async () => {
    const withFloor = loadConfig(envFor(database.url, { SEARCH_SCORE_FLOOR: '0.5' }));
    const measure = () => measureProject(database.db, withFloor, stubEmbeddings, null, 'halyard', []);
    try {
      expect((await measure()).refusalFloor).toBe(0.5);
      await database.db.update(projects).set({ scoreFloor: 0.7 }).where(eq(projects.id, corpusProjectId));
      expect((await measure()).refusalFloor).toBe(0.7);
      // An instance floor of 0 is off for everyone, a project's own value included.
      expect((await measureProject(database.db, config, stubEmbeddings, null, 'halyard', [])).refusalFloor).toBe(0);
    } finally {
      await database.db.update(projects).set({ scoreFloor: null }).where(eq(projects.id, corpusProjectId));
    }
  });
});

describe('measureProject refuses what it cannot measure honestly', () => {
  it('a project with nothing indexed', async () => {
    const [empty] = await database.db.insert(projects).values({ name: 'eval-empty' }).returning();
    await expect(measureProject(database.db, config, stubEmbeddings, null, empty.name, [])).rejects.toThrow(/has nothing indexed/);
  });

  it('a project with no questions', async () => {
    const seeded = await seedProject(database.db, 'eval-no-questions', { path: 'a.md', body: '# A\n\nSome text about alpha.' });
    await expect(measureProject(database.db, config, stubEmbeddings, null, seeded.name, [])).rejects.toThrow(/has no golden questions/);
  });

  it('a project indexed with another model', async () => {
    const seeded = await seedProject(database.db, 'eval-other-model', { path: 'a.md', body: '# A\n\nSome text about alpha.' });
    const other = { ...stubEmbeddings, id: 'local:some-other-model:fp32' } as EmbeddingProvider;
    await expect(measureProject(database.db, config, other, null, seeded.name, [])).rejects.toThrow(/was indexed with local:stub-bag-of-words:fp32/);
  });

  it("questions that expect a file the live index does not hold, under --strict (0.4.0's refusal, ADR-0124)", async () => {
    const seeded = await seedProject(database.db, 'eval-missing-file', { path: 'a.md', body: '# A\n\nSome text about alpha.' });
    await replaceGoldenQuestions(database.db, seeded.id, [
      { key: 'present', lang: 'en', query: 'alpha', expectFile: 'a.md', tags: [] },
      { key: 'absent', lang: 'en', query: 'beta', expectFile: 'gone.md', tags: [] },
    ]);
    await expect(measureProject(database.db, config, stubEmbeddings, null, seeded.name, [], { strict: true })).rejects.toThrow(
      /1 of 2 questions expect a file the project's live index does not hold:\n {2}absent: gone\.md/,
    );
  });

  it('skips such a question and scores the rest, by default (ADR-0124)', async () => {
    const seeded = await seedProject(database.db, 'eval-skips-file', { path: 'a.md', body: '# A\n\nSome text about alpha.' });
    await replaceGoldenQuestions(database.db, seeded.id, [
      { key: 'present', lang: 'en', query: 'alpha', expectFile: 'a.md', tags: [] },
      { key: 'absent', lang: 'en', query: 'beta', expectFile: 'gone.md', tags: [] },
    ]);
    const measured = await measureProject(database.db, config, stubEmbeddings, null, seeded.name, []);
    expect(measured.skipped.map((r) => r.id)).toEqual(['absent']);
    expect(measured.golden.map((r) => r.id)).toEqual(['present']);
    // The denominator is the questions asked: the skipped one is in neither the count nor the mean.
    expect(measured.results).toHaveLength(1);
    expect(aggregate(measured.results).questions).toBe(1);
  });

  it('refuses when nothing is left to ask', async () => {
    const seeded = await seedProject(database.db, 'eval-all-skipped', { path: 'a.md', body: '# A\n\nSome text about alpha.' });
    await replaceGoldenQuestions(database.db, seeded.id, [{ key: 'absent', lang: 'en', query: 'beta', expectFile: 'gone.md', tags: [] }]);
    await expect(measureProject(database.db, config, stubEmbeddings, null, seeded.name, [])).rejects.toThrow(/has no question that can be asked/);
  });

  it('a project that does not exist', async () => {
    await expect(measureProject(database.db, config, stubEmbeddings, null, 'no-such-project', [])).rejects.toThrow();
  });
});

describe('the golden questions admin API', () => {
  const QUESTION = {
    key: 'api-one',
    lang: 'en',
    query: 'How do I rotate a key?',
    expectFile: 'keys.md',
    expectHeading: 'Rotation',
    tags: ['keys'],
    note: 'seed',
  };

  async function newProject(name: string): Promise<string> {
    return (await createProject(database.db, { name }, [])).id;
  }

  it('round trips a question through create, read, patch and delete', async () => {
    const id = await newProject('api-crud');
    const base = `/api/projects/${id}/golden-questions`;

    expect((await app.inject({ method: 'GET', url: base, headers: ADMIN })).json()).toEqual({ questions: [] });

    const created = await app.inject({ method: 'POST', url: base, headers: ADMIN, payload: QUESTION });
    expect(created.statusCode, created.body).toBe(201);
    const view = created.json();
    expect(view).toMatchObject(QUESTION);
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);

    const listed = (await app.inject({ method: 'GET', url: base, headers: ADMIN })).json();
    expect(listed.questions).toHaveLength(1);
    expect(listed.questions[0]).toEqual(view);
    expect((await app.inject({ method: 'GET', url: `${base}/${view.id}`, headers: ADMIN })).json()).toEqual(view);

    const patched = await app.inject({
      method: 'PATCH',
      url: `${base}/${view.id}`,
      headers: ADMIN,
      payload: { query: 'How do I rotate keys safely?', note: null },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ key: 'api-one', query: 'How do I rotate keys safely?', note: null, expectFile: 'keys.md' });

    expect((await app.inject({ method: 'DELETE', url: `${base}/${view.id}`, headers: ADMIN })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `${base}/${view.id}`, headers: ADMIN })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${base}/${view.id}`, headers: ADMIN })).statusCode).toBe(404);
  });

  it('answers 404 for a project that is not there, on every route', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const base = `/api/projects/${missing}/golden-questions`;
    for (const [method, url, payload] of [
      ['GET', base, undefined],
      ['GET', `${base}/export`, undefined],
      ['POST', base, QUESTION],
      ['PUT', base, { questions: [] }],
    ] as const) {
      const res = await app.inject({ method, url, headers: ADMIN, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('refuses a duplicate key with 409, and bad input with 400', async () => {
    const id = await newProject('api-validation');
    const base = `/api/projects/${id}/golden-questions`;
    expect((await app.inject({ method: 'POST', url: base, headers: ADMIN, payload: QUESTION })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: base, headers: ADMIN, payload: QUESTION })).statusCode).toBe(409);

    for (const payload of [
      { ...QUESTION, key: 'Upper Case' },
      { ...QUESTION, key: 'k2', lang: 'de' },
      { ...QUESTION, key: 'k2', query: '   ' },
      { ...QUESTION, key: 'k2', unexpected: true },
    ]) {
      const res = await app.inject({ method: 'POST', url: base, headers: ADMIN, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const [row] = await listGoldenQuestions(database.db, id);
    const empty = await app.inject({ method: 'PATCH', url: `${base}/${row.id}`, headers: ADMIN, payload: {} });
    expect(empty.statusCode).toBe(400);
    // A key is the name a miss list cites; it is never renumbered.
    expect((await app.inject({ method: 'PATCH', url: `${base}/${row.id}`, headers: ADMIN, payload: { key: 'renamed' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}/not-a-uuid`, headers: ADMIN })).statusCode).toBe(400);
  });

  it('replaces the whole set at once, and a failed replace leaves the old set in place', async () => {
    const id = await newProject('api-replace');
    const base = `/api/projects/${id}/golden-questions`;
    const first = await app.inject({
      method: 'PUT',
      url: base,
      headers: ADMIN,
      payload: { questions: [QUESTION, { ...QUESTION, key: 'api-two', expectHeading: null }] },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().questions.map((q: { key: string }) => q.key)).toEqual(['api-one', 'api-two']);

    const duplicate = await app.inject({ method: 'PUT', url: base, headers: ADMIN, payload: { questions: [QUESTION, QUESTION] } });
    expect(duplicate.statusCode, duplicate.body).toBe(400);
    expect((await listGoldenQuestions(database.db, id)).map((r) => r.key)).toEqual(['api-one', 'api-two']);

    const cleared = await app.inject({ method: 'PUT', url: base, headers: ADMIN, payload: { questions: [] } });
    expect(cleared.json()).toEqual({ questions: [] });
  });

  it('exports the set in golden.jsonl shape, which the eval reads back', async () => {
    const id = await newProject('api-export');
    const base = `/api/projects/${id}/golden-questions`;
    await app.inject({
      method: 'PUT',
      url: base,
      headers: ADMIN,
      payload: { questions: [QUESTION, { ...QUESTION, key: 'api-two', expectHeading: null, note: null }] },
    });

    const res = await app.inject({ method: 'GET', url: `${base}/export`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('golden.jsonl');

    const rows = res.body
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => GoldenRowSchema.parse(JSON.parse(line)));
    expect(rows.map((r) => r.id)).toEqual(['api-one', 'api-two']);
    expect(rows[1]?.expectHeading).toBeUndefined();
    // Same file a person would hand `--golden`.
    expect(parseGoldenSet(res.body, new Set(['keys.md']))).toEqual(rows);
  });

  it('refuses a set past the per-project cap with 400', async () => {
    const id = await newProject('api-cap');
    const questions = Array.from({ length: 1001 }, (_, i) => ({ key: `q-${i}`, lang: 'en', query: `question ${i}`, expectFile: 'a.md', tags: [] }));
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${id}/golden-questions`, headers: ADMIN, payload: { questions } });
    expect(res.statusCode).toBe(400);
  });

  it('follows the project roles: a viewer reads, an editor writes, a stranger sees nothing', async () => {
    const id = await newProject('api-roles');
    const base = `/api/projects/${id}/golden-questions`;
    const user = await createUser(database.db, { username: 'golden-member', role: 'member', password: 'a-member-password-1!' });
    const cookies = { [SESSION_COOKIE]: (await createSession(database.db, user.id, 1, { userAgent: 'probe' })).token };

    // A member with no role on the project is told it does not exist, not that it is forbidden.
    expect((await app.inject({ method: 'GET', url: base, cookies })).statusCode).toBe(404);

    await setMemberRole(database.db, id, user.id, 'viewer', null);
    expect((await app.inject({ method: 'GET', url: base, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${base}/export`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: base, cookies, headers: SAME_SITE, payload: QUESTION })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: base, cookies, headers: SAME_SITE, payload: { questions: [] } })).statusCode).toBe(403);

    await setMemberRole(database.db, id, user.id, 'editor', null);
    expect((await app.inject({ method: 'POST', url: base, cookies, headers: SAME_SITE, payload: QUESTION })).statusCode).toBe(201);
  });

  it('audits a created question against the question', async () => {
    const id = await newProject('api-audit');
    const created = await app.inject({ method: 'POST', url: `/api/projects/${id}/golden-questions`, headers: ADMIN, payload: QUESTION });
    expect(created.statusCode, created.body).toBe(201);
    await audit.settled();

    const [event] = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'POST /api/projects/:id/golden-questions'))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    expect(event).toMatchObject({ actorKind: 'token', projectId: id, targetType: 'questionId', targetId: created.json().id, statusCode: 201 });
  });

  it('is removed with its project', async () => {
    const id = await newProject('api-cascade');
    await app.inject({ method: 'POST', url: `/api/projects/${id}/golden-questions`, headers: ADMIN, payload: QUESTION });
    expect((await database.db.select({ rows: count() }).from(goldenQuestions).where(eq(goldenQuestions.projectId, id)))[0]?.rows).toBe(1);
    await database.db.delete(projects).where(eq(projects.id, id));
    expect((await database.db.select({ rows: count() }).from(goldenQuestions).where(eq(goldenQuestions.projectId, id)))[0]?.rows).toBe(0);
  });
});

describe('the question set travels with the project (ADR-0051)', () => {
  const transferConfig = (dir: string): Config =>
    ({
      DATA_DIR: dir,
      PUBLIC_BASE_URL: undefined,
      EMBEDDING_DIMENSIONS: DIMS,
      ALLOWED_DOC_ROOTS: ['/docs'],
      ARCHIVE_MAX_ENTRIES: 20_000,
      ARCHIVE_MAX_TOTAL_BYTES: 1024 * 1024 * 1024,
      UPLOAD_MAX_FILE_BYTES: 50 * 1024 * 1024,
      MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
    }) as unknown as Config;

  let destination: TestDatabase;
  let destinationDir: string;
  let archive: string;
  let emptyArchive: string;
  const questions = [
    { key: 'move-one', lang: 'en' as const, query: 'what does alpha do', expectFile: 'a.md', expectHeading: 'A', tags: ['x', 'y'], note: 'kept' },
    { key: 'move-two', lang: 'tr' as const, query: 'alpha ne yapar', expectFile: 'a.md', tags: [] },
  ];

  async function exportTo(projectId: string, file: string): Promise<{ counts: unknown }> {
    const [row] = await database.db.select().from(projects).where(eq(projects.id, projectId));
    const result = await exportProject(
      { db: database.db, config: transferConfig(dataDir), product: { name: 'contextator', version: '0.0.0-test' } },
      row,
    );
    await pipeline(result.stream, createWriteStream(file));
    await result.cleanup();
    return { counts: result.manifest.counts };
  }

  async function census(db: Db): Promise<Record<string, unknown>> {
    const [projectRows, questionRows, documentRows, indexes] = await Promise.all([
      db.select({ name: projects.name }).from(projects),
      db.select({ id: goldenQuestions.id }).from(goldenQuestions),
      db.select({ id: documents.id }).from(documents),
      db.execute(sql`SELECT relname FROM pg_class WHERE relkind = 'i' AND starts_with(relname, ${PROJECT_VECTOR_INDEX_PREFIX}) ORDER BY relname`),
    ]);
    return {
      projects: projectRows.map((r) => r.name).sort(),
      questions: questionRows.length,
      documents: documentRows.length,
      indexes: indexes.rows.map((r) => r.relname),
    };
  }

  /** The origin archive with `golden-questions.ndjson` rewritten (or dropped, for `null`). */
  async function tamper(source: string, rewrite: string | null): Promise<string> {
    const stage = await fs.mkdtemp(path.join(tmpdir(), 'golden-tamper-'));
    const out = path.join(tmpdir(), `golden-tampered-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
    await tar.extract({ file: source, cwd: stage });
    const entry = path.join(stage, 'golden-questions.ndjson');
    if (rewrite === null) await fs.rm(entry, { force: true });
    else await fs.writeFile(entry, rewrite);
    await tar.create({ gzip: true, cwd: stage, file: out, portable: true }, await fs.readdir(stage));
    await fs.rm(stage, { recursive: true, force: true });
    return out;
  }

  beforeAll(async () => {
    destination = await createTestDatabase(baseUrl, 'golden_questions_destination');
    await applySchema(destination, DIMS);
    destinationDir = await fs.mkdtemp(path.join(tmpdir(), 'golden-destination-'));

    const withQuestions = await seedProject(database.db, 'move-with-questions', { path: 'a.md', body: '# A\n\nAlpha does a thing.' });
    await replaceGoldenQuestions(database.db, withQuestions.id, questions);
    archive = path.join(tmpdir(), `golden-with-${Date.now()}.tar.gz`);
    const exported = await exportTo(withQuestions.id, archive);
    expect(exported.counts).toMatchObject({ goldenQuestions: 2 });

    const without = await seedProject(database.db, 'move-without-questions', { path: 'a.md', body: '# A\n\nAlpha does a thing.' });
    emptyArchive = path.join(tmpdir(), `golden-without-${Date.now()}.tar.gz`);
    await exportTo(without.id, emptyArchive);
  });

  afterAll(async () => {
    if (destination) await dropTestDatabase(baseUrl, destination);
    await Promise.all([archive, emptyArchive].map((file) => (file ? fs.rm(file, { force: true }) : undefined)));
    if (destinationDir) await fs.rm(destinationDir, { recursive: true, force: true });
  });

  const here = () => ({ db: destination.db, config: transferConfig(destinationDir), embeddings: { id: STUB_MODEL_ID, dimensions: DIMS } });

  it('writes no entry for a project without questions, and imports it with none', async () => {
    const entries: string[] = [];
    await tar.list({ file: emptyArchive, onReadEntry: (entry) => entries.push(entry.path) });
    expect(entries.some((e) => e.endsWith('golden-questions.ndjson'))).toBe(false);

    const report = await importProject(here(), emptyArchive, 'imported-without');
    expect(report.goldenQuestions).toBe(0);
    expect(await listGoldenQuestions(destination.db, report.projectId)).toEqual([]);
  });

  it('refuses a malformed, duplicated or over-long entry and leaves nothing behind', async () => {
    const good = JSON.stringify({ id: 'x', lang: 'en', query: 'q', expectFile: 'a.md', tags: [] });
    // A line that is not JSON is refused by the reader every entry shares; the rest are this entry's own.
    const cases: Array<[string, string, RegExp, string]> = [
      ['an unreadable line', 'not json\n', /golden-questions\.ndjson:1/, 'bad_line'],
      [
        'an unknown language',
        `${JSON.stringify({ id: 'x', lang: 'de', query: 'q', expectFile: 'a.md' })}\n`,
        /golden-questions\.ndjson:1/,
        'bad_golden_question',
      ],
      ['a duplicate id', `${good}\n${good}\n`, /two questions with id "x"/, 'bad_golden_question'],
      [
        'more questions than a project keeps',
        `${Array.from({ length: 1001 }, (_, i) => JSON.stringify({ id: `q-${i}`, lang: 'en', query: 'q', expectFile: 'a.md', tags: [] })).join('\n')}\n`,
        /holds 1001 questions; a project keeps at most 1000/,
        'bad_golden_question',
      ],
    ];
    for (const [label, body, message, code] of cases) {
      const tampered = await tamper(archive, body);
      const before = await census(destination.db);
      const refusal = await importProject(here(), tampered, `refused-${label.replace(/\W+/g, '-')}`).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal, label).toBeInstanceOf(ImportRefusedError);
      expect((refusal as ImportRefusedError).code, label).toBe(code);
      expect((refusal as Error).message, label).toMatch(message);
      expect(await census(destination.db), label).toEqual(before);
      await fs.rm(tampered, { force: true });
    }
  });

  it('lands the questions on the other side, unchanged', async () => {
    const report = await importProject(here(), archive, 'imported-with');
    expect(report.goldenQuestions).toBe(2);
    expect((await listGoldenQuestions(destination.db, report.projectId)).map(toGoldenRow)).toEqual(
      questions.map((q) => ({
        id: q.key,
        lang: q.lang,
        query: q.query,
        expectFile: q.expectFile,
        ...('expectHeading' in q ? { expectHeading: q.expectHeading } : {}),
        tags: q.tags,
        ...('note' in q ? { note: q.note } : {}),
      })),
    );
  });

  it('imports an export from before the entry existed, as a project with no questions', async () => {
    const stripped = await tamper(archive, null);
    try {
      const report = await importProject(here(), stripped, 'imported-legacy');
      expect(report.goldenQuestions).toBe(0);
      expect(await listGoldenQuestions(destination.db, report.projectId)).toEqual([]);
    } finally {
      await fs.rm(stripped, { force: true });
    }
  });
});
