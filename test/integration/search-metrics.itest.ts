import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig, WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import { documentSources, projects } from '../../src/db/schema.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { type HistogramSnapshot, MetricsRegistry, renderPrometheus } from '../../src/services/metrics.js';
import type { Reranker } from '../../src/services/reranker.js';
import { searchProject } from '../../src/services/search.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The search and indexer histograms, observed by the real code paths against a real index: one index
 * run (queue wait, embedding batches) and then searches through `searchProject` with and without a
 * reranker. What is asserted is the count per series — that each phase is observed once per answered
 * search, that `rerank` is observed only when a reranker ran, and that the `indexing` label follows
 * the probe the composition root installs. The durations themselves are whatever this machine took.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

/** Word-hash bag of words, L2-normalised: enough for a query to find the excerpt that shares its words. */
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
  id: 'local:stub-bag-of-words:fp32',
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
};

const FILES: Record<string, string> = {
  'webhooks.md':
    '# Webhooks\n\n## Rotating the secret\n\nRotate the webhook secret from the source panel. The old secret stops verifying push payloads immediately.\n',
  'uploads.md':
    '# Uploads\n\n## Archives\n\nAn uploaded archive is unpacked on the server into a staging directory and swapped in when the upload is committed.\n',
  'notion.md':
    '# Notion\n\n## Sharing pages\n\nPages shared with an internal integration are pulled on every sync and rendered to Markdown before chunking.\n',
};

const QUERY = 'rotate the webhook secret';

/** The config `search_docs` reads its scan and selection settings from; nothing here connects to it. */
const toolConfig = loadConfig({ DATABASE_URL: 'postgres://unused/unused', SEARCH_SCORE_FLOOR: '0' });

async function settled(job: JobState): Promise<JobState> {
  const deadline = Date.now() + 30_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return job;
}

/** The observation count of one series, `0` when the series has never been observed. */
function countOf(metrics: MetricsRegistry, name: string, labels: Record<string, string> = {}): number {
  const family = metrics.histograms().find((h: HistogramSnapshot) => h.name === name);
  if (!family) throw new Error(`no histogram ${name}`);
  const series = family.series.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v));
  return series?.count ?? 0;
}

const phase = (p: string, indexing = 'false') => ({ phase: p, indexing });

describe('search and indexer histograms', () => {
  let database: TestDatabase;
  let root: string;
  let projectId: string;
  let indexer: Indexer;
  const metrics = new MetricsRegistry();

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'search_metrics');
    await applySchema(database, DIMS);
    root = await mkdtemp(path.join(tmpdir(), 'search-metrics-'));
    for (const [file, body] of Object.entries(FILES)) await writeFile(path.join(root, file), body, 'utf8');

    const [project] = await database.db.insert(projects).values({ name: 'search-metrics' }).returning({ id: projects.id });
    projectId = project.id;
    await database.db.insert(documentSources).values({ projectId, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });

    indexer = new Indexer({
      db: database.db,
      embeddings,
      // The temp directory's parent, so `resolveProjectRoot` sees the real path on macOS too.
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
      metrics,
    });
  });

  afterAll(async () => {
    await indexer?.stop();
    await rm(root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  it('observes the queue wait once per run and every embedding batch the run made', async () => {
    const job = await settled(indexer.enqueue(projectId));
    expect(job.phase).toBe('done');

    expect(countOf(metrics, 'contextator_index_run_wait_seconds', { lane: 'interactive' })).toBe(1);
    expect(countOf(metrics, 'contextator_index_run_wait_seconds', { lane: 'scheduled' })).toBe(0);

    // One batch per document here (each is one chunk, far under EMBEDDING_BATCH_SIZE), and the size
    // histogram's sum is the number of passages embedded — the chunk count the run reported.
    const batches = countOf(metrics, 'contextator_embedding_batch_size');
    expect(batches).toBe(Object.keys(FILES).length);
    expect(countOf(metrics, 'contextator_embedding_batch_duration_seconds')).toBe(batches);
    const sizes = metrics.histograms().find((h) => h.name === 'contextator_embedding_batch_size');
    expect(sizes?.series[0].sum).toBe(job.chunksDone);
  });

  it('observes embed and retrieve once per answered search, and rerank not at all without a reranker', async () => {
    const before = {
      embed: countOf(metrics, 'contextator_search_duration_seconds', phase('embed')),
      retrieve: countOf(metrics, 'contextator_search_duration_seconds', phase('retrieve')),
      rerank: countOf(metrics, 'contextator_search_duration_seconds', phase('rerank')),
      total: countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' }),
    };

    const outcome = await searchProject({ db: database.db, embeddings, metrics }, { projectId, query: QUERY });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.hits[0].file).toMatch(/webhooks\.md$/);

    expect(countOf(metrics, 'contextator_search_duration_seconds', phase('embed'))).toBe(before.embed + 1);
    expect(countOf(metrics, 'contextator_search_duration_seconds', phase('retrieve'))).toBe(before.retrieve + 1);
    expect(countOf(metrics, 'contextator_search_duration_seconds', phase('rerank'))).toBe(before.rerank);
    expect(countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' })).toBe(before.total + 1);
  });

  it('observes rerank when a reranker ran, and the page is still the order the reranker gave', async () => {
    const calls: number[] = [];
    // Puts the uploads excerpt first, which the fused order never does for this query: if the page
    // still leads with webhooks.md, timing the reranker has dropped what it returned.
    const rerank: Reranker = {
      id: 'local-rerank:stub:fp32',
      score: async (_query, passages) => {
        calls.push(passages.length);
        return passages.map((text) => (/archive/i.test(text) ? 10 : 0));
      },
    };
    const before = countOf(metrics, 'contextator_search_duration_seconds', phase('rerank'));

    const outcome = await searchProject({ db: database.db, embeddings, metrics, rerank }, { projectId, query: QUERY });
    expect(outcome.status).toBe('ok');
    expect(calls).toHaveLength(1);
    if (outcome.status === 'ok') expect(outcome.hits[0].file).toMatch(/uploads\.md$/);
    expect(countOf(metrics, 'contextator_search_duration_seconds', phase('rerank'))).toBe(before + 1);
  });

  it('records nothing for a search that never reached the index', async () => {
    const before = countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' });
    const outcome = await searchProject(
      { db: database.db, embeddings, metrics },
      { projectId: '00000000-0000-0000-0000-000000000000', query: QUERY },
    );
    expect(outcome.status).toBe('project_gone');
    expect(countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' })).toBe(before);
  });

  it('counts an MCP search_docs call in the same search histograms', async () => {
    const before = countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' });
    const embedBefore = countOf(metrics, 'contextator_search_duration_seconds', phase('embed'));
    const [project] = await database.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    const server = new McpServer({ name: 'contextator-test', version: '0.0.0-test' });
    const ctx = { db: database.db, embeddings, config: toolConfig, log: silentLogger, metrics } as unknown as ToolContext;
    registerTools(server, ctx, project, null);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'search_docs', arguments: { query: QUERY, limit: 3 } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
    expect(countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' })).toBe(before + 1);
    expect(countOf(metrics, 'contextator_search_duration_seconds', phase('embed'))).toBe(embedBefore + 1);
  });

  it('renders every observed series with its buckets, +Inf, _sum and _count', () => {
    const text = renderPrometheus({
      version: '0.0.0-test',
      uptimeSeconds: 1,
      embeddingId: embeddings.id,
      embeddingReady: true,
      dbUp: true,
      pool: null,
      queue: indexer.stats(),
      lastIndexRun: null,
      searches: { mcp: 0, dashboard: 0 },
      audit: { written: 0, failed: 0 },
      histograms: metrics.histograms(),
    });
    expect(text).toContain('# TYPE contextator_search_duration_seconds histogram');
    expect(text).toMatch(/^contextator_search_duration_seconds_bucket\{phase="embed",indexing="false",le="0\.005"\} \d+$/m);
    expect(text).toMatch(/^contextator_search_duration_seconds_bucket\{phase="rerank",indexing="false",le="\+Inf"\} 1$/m);
    expect(text).toMatch(/^contextator_index_run_wait_seconds_count\{lane="interactive"\} 1$/m);
    expect(text).toMatch(/^contextator_embedding_batch_size_bucket\{le="256"\} 3$/m);
  });
});

/**
 * The `indexing` label and the lanes, driven by a real indexer rather than a hand-set probe: a run is
 * held inside `embedPassages` until the test lets it go, so "a search while a run is in progress" and
 * "a job that waited behind it" are states the queue actually reached.
 */
describe('the indexing label and the queue-wait lanes, from a real run', () => {
  let database: TestDatabase;
  let root: string;
  let indexer: Indexer;
  const ids: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
  const metrics = new MetricsRegistry();

  let release: () => void = () => {};
  let held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let embedding = 0;
  const gated: EmbeddingProvider = {
    ...embeddings,
    embedPassages: async (texts: string[]) => {
      embedding += 1;
      await held;
      return texts.map(stubVector);
    },
  };

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'search_metrics_lanes');
    await applySchema(database, DIMS);
    root = await mkdtemp(path.join(tmpdir(), 'search-metrics-lanes-'));
    for (const [file, body] of Object.entries(FILES)) await writeFile(path.join(root, file), body, 'utf8');
    for (const key of ['a', 'b', 'c'] as const) {
      const [project] = await database.db
        .insert(projects)
        .values({ name: `lanes-${key}` })
        .returning({ id: projects.id });
      ids[key] = project.id;
      await database.db
        .insert(documentSources)
        .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
    }
    indexer = new Indexer({
      db: database.db,
      embeddings: gated,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
      metrics,
    });
  });

  afterAll(async () => {
    release();
    await indexer?.stop();
    await rm(root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  it('labels a search indexing="true" while a run holds the worker, and splits waits by the lane a job left from', async () => {
    // Project "a" is indexed first, without the gate, so it has something to search.
    release();
    expect((await settled(indexer.enqueue(ids.a))).phase).toBe('done');
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    embedding = 0;

    // A rebuild of "a" that stops inside its first embedding batch: the worker is busy from here on.
    const running = indexer.enqueue(ids.a, { force: true });
    const deadline = Date.now() + 30_000;
    while (embedding === 0) {
      if (Date.now() > deadline) throw new Error('the gated run never reached embedPassages');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const busy = await searchProject({ db: database.db, embeddings, metrics }, { projectId: ids.a, query: QUERY });
    expect(busy.status).toBe('ok');
    expect(countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'true' })).toBe(1);
    expect(countOf(metrics, 'contextator_search_duration_seconds', phase('embed', 'true'))).toBe(1);

    // "b" waits in the scheduled lane; "c" is queued as scheduled and then promoted by a button press.
    const b = indexer.enqueue(ids.b, { trigger: 'scheduled' });
    indexer.enqueue(ids.c, { trigger: 'scheduled' });
    const c = indexer.enqueue(ids.c);
    expect(c.trigger).toBe('manual');

    release();
    await Promise.all([settled(running), settled(b), settled(c)]);

    // "a" twice (the first run and the rebuild) and the promoted "c": interactive. "b": scheduled.
    expect(countOf(metrics, 'contextator_index_run_wait_seconds', { lane: 'interactive' })).toBe(3);
    expect(countOf(metrics, 'contextator_index_run_wait_seconds', { lane: 'scheduled' })).toBe(1);

    // Idle again: the same search is labelled false.
    const idle = await searchProject({ db: database.db, embeddings, metrics }, { projectId: ids.a, query: QUERY });
    expect(idle.status).toBe('ok');
    expect(countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'false' })).toBe(1);
    expect(countOf(metrics, 'contextator_search_request_duration_seconds', { indexing: 'true' })).toBe(1);
  });
});
