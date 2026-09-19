import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, documents, projects, type DocumentSourceRow, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { runSyncTick, type SchedulerIndexer, type SyncTickResult } from '../../src/services/scheduler.js';
import { ConfluenceDriver } from '../../src/services/sources/confluence.js';
import { registerDriver } from '../../src/services/sources/driver.js';
import { PROBE_TOKEN_KEY, storedProbeToken } from '../../src/services/sources.js';
import { CAMPAIGN, HANDBOOK, OTHER_SPACE, ROTATION, SPACE, StubConfluence, type StubPage } from '../support/confluence-stub.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A Confluence source, end to end ([ADR-0059](../../.ssot/ADR.md#adr-0059)): the driver renders a page
 * tree, the indexer turns it into documents, `search_docs` finds one and `read_document` reads it —
 * and then the scheduler decides, twice, whether any of that needs doing again.
 *
 * **No request leaves this process.** The driver's REST client is a constructor parameter, and the
 * factory registered below hands it the stub from `test/support/confluence-stub.ts`. That registration
 * is also the only seam there is: `runSyncTick` builds its driver through `driverFor`, which is the
 * point — the scheduler is exercised exactly as it ships, with nothing about it changed for a test.
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
  embedPassages: async (texts: string[]) => texts.map(stubVector),
  embedQuery: async (text: string) => stubVector(text),
};

/**
 * The page tree every case below starts from, and the handle a case uses to change it.
 *
 * One mutable holder rather than a new stub per run: the factory is registered once, at import time,
 * and a driver is built fresh for every sync and every probe — so what a test changes has to be the
 * thing the *next* driver will read, not an object one particular driver is holding.
 */
const wiki: { pages: StubPage[]; stub: StubConfluence } = { pages: [], stub: new StubConfluence([]) };

function setPages(pages: StubPage[]): void {
  wiki.pages = pages;
  wiki.stub = new StubConfluence(pages);
}

registerDriver('confluence', (source, ctx) => new ConfluenceDriver(source, ctx, wiki.stub));

let database: TestDatabase;
let project: ProjectRow;
let source: DocumentSourceRow;
let indexer: Indexer;
let ctx: ToolContext;
let dataDir: string;
let schedulerConfig: Parameters<typeof runSyncTick>[0]['config'];

async function settle(db: Db, job: JobState): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (;;) {
    const row = await getProjectById(db, job.projectId);
    if (row?.status !== 'indexing') return job;
    if (Date.now() > deadline) throw new Error(`project row still says "indexing" after the job settled as ${job.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function indexNow(): Promise<JobState> {
  const job = await settle(database.db, indexer.enqueue(project.id, { trigger: 'manual' }));
  indexer.forget(project.id);
  return job;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0' });
  const live = (await getProjectById(database.db, project.id)) ?? project;
  registerTools(server, ctx, live);
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

const sourceRow = async (): Promise<DocumentSourceRow> => {
  const [row] = await database.db.select().from(documentSources).where(eq(documentSources.id, source.id));
  return row;
};

/** Switches the source on and makes it due right now, which is where each scheduler case starts. */
async function makeDue(): Promise<void> {
  await database.db
    .update(documentSources)
    .set({ syncIntervalMinutes: 15, nextSyncAt: new Date(Date.now() - 60_000) })
    .where(eq(documentSources.id, source.id));
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'confluence_source');
  await applySchema(database, DIMS);
  dataDir = await mkdtemp(path.join(tmpdir(), 'contextator-confluence-itest-'));

  [project] = await database.db.insert(projects).values({ name: 'wiki-project', embeddingModel: MODEL_ID }).returning();
  [source] = await database.db
    .insert(documentSources)
    .values({
      projectId: project.id,
      type: 'confluence',
      name: 'wiki',
      config: {
        baseUrl: 'https://acme.atlassian.net/wiki',
        email: 'docs@example.com',
        spaceKeys: [SPACE],
        extensions: ['md'],
      },
    })
    .returning();

  const config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: dataDir,
    DATA_DIR: path.join(dataDir, '.data'),
    SECRET_KEY: '0'.repeat(64),
    CHUNK_MAX_TOKENS: '96',
    CHUNK_OVERLAP_TOKENS: '24',
    // The instance floor is calibrated against the real embedding model; the bag-of-words stub above
    // scores on a different scale entirely, and leaving the production floor here would make every
    // search in this file answer "no good match" whatever the connector did.
    SEARCH_SCORE_FLOOR: '0.2',
  });
  indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  ctx = { db: database.db, embeddings, config, log: silentLogger };
  schedulerConfig = { ...config, SYNC_PROBES_PER_TICK: 10 };

  setPages([HANDBOOK, ROTATION, CAMPAIGN]);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  await dropTestDatabase(baseUrl, database);
});

describe('a Confluence source, indexed and then asked about', () => {
  it('indexes the page tree under <source>/<space>/<parent>/<page>.md', async () => {
    const job = await indexNow();
    expect(job.phase).toBe('done');

    const rows = await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, project.id));
    expect(rows.map((r) => r.p).sort()).toEqual([
      'wiki/eng/engineering-handbook--100001.md',
      'wiki/eng/engineering-handbook--100001/kurulum-rehberi--100002.md',
    ]);
    // The space this source does not name contributed nothing, at either end of the pipeline.
    expect(rows.some((r) => r.p.includes(OTHER_SPACE.toLowerCase()))).toBe(false);
    expect((await sourceRow()).status).toBe('idle');
  });

  it('lets search_docs find a page and read_document read it', async () => {
    const found = await call('search_docs', { query: 'kurulum yapin' });
    expect(found.isError).toBe(false);
    expect(found.text).toContain('wiki/eng/engineering-handbook--100001/kurulum-rehberi--100002.md');

    const read = await call('read_document', { path: 'wiki/eng/engineering-handbook--100001/kurulum-rehberi--100002.md' });
    expect(read.isError).toBe(false);
    expect(read.text).toContain('Title: Kurulum Rehberi');
    // The body came through the shared HTML transform, code macro and all — the one thing an HTML
    // parser handed raw storage format would have dropped on the floor.
    expect(read.text).toContain('npm ci && npm run build');
    expect(read.text).toContain('```bash');
  });
});

/**
 * **What the probe is worth, measured against the scheduler rather than asserted about the driver.**
 *
 * Criterion 3 of this phase and the same pair the Notion connector's own tests make: an unchanged
 * workspace must queue nothing, and one edited page must queue a run. Both go through `runSyncTick`
 * with a recorder in place of the queue, so the decision is the scheduler's own.
 */
describe('what one Confluence probe decides', () => {
  const enqueued: Array<{ projectId: string; trigger: string | undefined }> = [];
  const recorder: SchedulerIndexer = {
    isBusy: () => false,
    enqueue: (projectId, opts = {}) => {
      enqueued.push({ projectId, trigger: opts.trigger });
      return {
        projectId,
        force: false,
        trigger: opts.trigger ?? 'manual',
        phase: 'queued',
        filesTotal: 0,
        filesDone: 0,
        filesSkipped: 0,
        filesRemoved: 0,
        chunksDone: 0,
        sources: [],
        queuedAt: new Date().toISOString(),
      };
    },
  };

  const tick = (): Promise<SyncTickResult> => runSyncTick({ db: database.db, indexer: recorder, log: silentLogger, config: schedulerConfig });

  it('stored a token on the run that already happened', async () => {
    // Not a restatement of the driver test: this is the token as it reached the *row*, written by
    // `collectSource` out of the sync's `configPatch`. Without it the two cases below would both
    // enqueue — and the first one would pass for the wrong reason.
    expect(storedProbeToken((await sourceRow()).config)).toBe('pages=2;modified=2026-09-02T10:00:00.000Z');
  });

  it('enqueues nothing while the wiki has not moved', async () => {
    await makeDue();
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 1, enqueued: 0, failed: 0 });
    expect(enqueued).toEqual([]);
    // And it still advanced, exactly as it does when it decides to run.
    expect((await sourceRow()).nextSyncAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('enqueues nothing when the only edit was in a space this source does not index', async () => {
    // The Faz-07 shape of failure, from the other side: a probe measuring more than the run does would
    // queue a full sync every time anybody in the company touched an unrelated wiki page.
    setPages([HANDBOOK, ROTATION, { ...CAMPAIGN, version: 9, lastModified: '2026-12-31T23:59:59.000Z' }]);
    await makeDue();
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 1, enqueued: 0, failed: 0 });
    expect(enqueued).toEqual([]);
  });

  it('enqueues in the scheduled lane as soon as one page in scope is edited', async () => {
    setPages([HANDBOOK, { ...ROTATION, version: 3, lastModified: '2026-09-20T09:00:00.000Z', storage: '<p>Guncellendi.</p>' }, CAMPAIGN]);
    await makeDue();
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 0, enqueued: 1, failed: 0 });
    expect(enqueued).toEqual([{ projectId: project.id, trigger: 'scheduled' }]);
  });

  it('enqueues when a page in scope is deleted, which the newest timestamp alone cannot see', async () => {
    // ROTATION is the newest page in scope; removing HANDBOOK leaves the maximum exactly where it is.
    // A token that were only a timestamp would answer "unchanged" and the deleted page would stay in
    // the index until something unrelated was edited.
    const rotation = { ...ROTATION, version: 3, lastModified: '2026-09-20T09:00:00.000Z', storage: '<p>Guncellendi.</p>' };
    setPages([HANDBOOK, rotation, CAMPAIGN]);
    await database.db
      .update(documentSources)
      .set({ config: { ...(await sourceRow()).config, [PROBE_TOKEN_KEY]: 'pages=2;modified=2026-09-20T09:00:00.000Z' } })
      .where(eq(documentSources.id, source.id));
    await makeDue();
    enqueued.length = 0;
    // The token above is exactly what the wiki answers right now, so the tick before the deletion is
    // quiet — which is what makes the tick after it a measurement rather than a coincidence.
    expect(await tick()).toMatchObject({ probed: 1, unchanged: 1, enqueued: 0 });

    setPages([rotation, CAMPAIGN]);
    await makeDue();
    enqueued.length = 0;
    expect(await tick()).toMatchObject({ probed: 1, unchanged: 0, enqueued: 1, failed: 0 });
  });

  it('enqueues when the probe throws, because a probe is never a veto', async () => {
    const failing = new StubConfluence([HANDBOOK, ROTATION]);
    failing.failWith = 'Current user not permitted to use Confluence';
    wiki.stub = failing;
    // A token that matches nothing would be the only thing that could make this pass vacuously, so the
    // one the row is carrying is left exactly as it is and only the API is broken.
    await makeDue();
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, failed: 1, unchanged: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId: project.id, trigger: 'scheduled' }]);
    setPages(wiki.pages);
  });
});

describe('the run the probe asked for', () => {
  it('re-indexes the edited page and drops the deleted one', async () => {
    setPages([{ ...ROTATION, version: 3, lastModified: '2026-09-20T09:00:00.000Z', storage: '<p>Guncellendi.</p>' }, CAMPAIGN]);
    const job = await indexNow();
    expect(job.phase).toBe('done');

    const rows = await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, project.id));
    expect(rows.map((r) => r.p)).toEqual(['wiki/eng/engineering-handbook--100001/kurulum-rehberi--100002.md']);

    const read = await call('read_document', { path: 'wiki/eng/engineering-handbook--100001/kurulum-rehberi--100002.md' });
    expect(read.text).toContain('Guncellendi.');
    expect(read.text).not.toContain('npm ci');
    // And the row carries the token this run minted, which is what the next tick will compare against.
    expect(storedProbeToken((await sourceRow()).config)).toBe('pages=1;modified=2026-09-20T09:00:00.000Z');
  });
});
