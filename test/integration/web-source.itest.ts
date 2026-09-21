import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

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
import { storedProbeToken } from '../../src/services/sources.js';
import { WebDriver } from '../../src/services/sources/web.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A web source end to end ([ADR-0070](../../.ssot/ADR.md#adr-0070)): a small documentation site served
 * over HTTP on loopback, crawled through its `sitemap.xml`, indexed, found by `search_docs` and read
 * back as Markdown by `read_document` — and then the scheduler decides, twice, whether any of it needs
 * doing again.
 *
 * **The server is in this process and nothing leaves the machine.** That is deliberately *not* the
 * shape `test/web-driver.test.ts` uses: there the client is a stub, so the assertions can be about
 * requests that were never made. Here the real `HttpWebClient` runs against a real socket, because the
 * half a stub cannot prove is that this connector's output — HTML written to disk, converted by the
 * shared `doc-types/html.ts` transform, chunked, embedded and served — is a document a person can read.
 *
 * `requested` is the site's own request log, which is how the two refusals that matter are asserted:
 * a path `robots.txt` disallows is never **fetched**, and a probe answers without touching a page.
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

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>.x{color:red}</style></head>
<body><nav><a href="/">home</a></nav><h1>${title}</h1>${body}<script>console.log('nav')</script></body></html>`;
}

/**
 * The site, as a mutable object so a case can edit a page and move its `lastmod` — which is the event
 * the whole scheduled path exists to notice.
 */
const site = {
  lastmod: { '/guide/install.html': '2026-09-12T11:30:00.000Z', '/guide/overview.html': '2026-09-02T10:00:00.000Z' } as Record<string, string>,
  pages: {
    '/guide/install.html': html(
      'Kurulum Rehberi',
      '<p>Kurulum yapin: <code>npm ci &amp;&amp; npm run build</code>.</p><table><tr><td>Platform</td><td>Komut</td></tr><tr><td>linux</td><td>make</td></tr></table>',
    ),
    '/guide/overview.html': html('Overview', '<p>What this product is for, in one paragraph.</p>'),
    // Disallowed by robots.txt below. Fetching it at all is the failure this site is shaped to catch.
    '/internal/runbook.html': html('Runbook', '<p>On-call secrets that must never be indexed.</p>'),
    // A single-page app shell: everything a browser would render is in the bundle, so there is no text.
    '/guide/app.html': '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>boot()</script></body></html>',
  } as Record<string, string>,
};

function sitemapXml(origin: string): string {
  const paths = ['/guide/install.html', '/guide/overview.html', '/internal/runbook.html', '/guide/app.html'];
  const entries = paths.map((p) => `<url><loc>${origin}${p}</loc>${site.lastmod[p] ? `<lastmod>${site.lastmod[p]}</lastmod>` : ''}</url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

const ROBOTS = 'User-agent: *\nCrawl-delay: 0\nDisallow: /internal/\n';

let server: http.Server;
let origin: string;
/** Every path the site was asked for, in order. Cleared by a case that is about what was requested. */
let requested: string[] = [];

let database: TestDatabase;
let project: ProjectRow;
let source: DocumentSourceRow;
let indexer: Indexer;
let ctx: ToolContext;
let dataDir: string;
let config: ReturnType<typeof loadConfig>;
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

const documentPaths = async (): Promise<string[]> => {
  const rows = await database.db.select({ p: documents.relativePath }).from(documents).where(eq(documents.projectId, project.id));
  return rows.map((r) => r.p).sort();
};

/** Switches the source on and makes it due right now, which is where each scheduler case starts. */
async function makeDue(): Promise<void> {
  await database.db
    .update(documentSources)
    .set({ syncIntervalMinutes: 15, nextSyncAt: new Date(Date.now() - 60_000) })
    .where(eq(documentSources.id, source.id));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requested.push(url.pathname);
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(ROBOTS);
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' }).end(sitemapXml(origin));
      return;
    }
    const body = site.pages[url.pathname];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<html><body>not found</body></html>');
      return;
    }
    // A strong `ETag` derived from the body, so the conditional GET path is the real one rather than a
    // header this test invented: edit a page and the validator stops matching, by construction.
    const etag = `"${Buffer.from(body).length}-${body.length.toString(16)}-${url.pathname.length}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  database = await createTestDatabase(baseUrl, 'web_source');
  await applySchema(database, DIMS);
  dataDir = await mkdtemp(path.join(tmpdir(), 'contextator-web-itest-'));

  [project] = await database.db.insert(projects).values({ name: 'web-project', embeddingModel: MODEL_ID }).returning();
  [source] = await database.db
    .insert(documentSources)
    .values({
      projectId: project.id,
      type: 'web',
      name: 'docs',
      config: { entryUrl: `${origin}/sitemap.xml`, entryKind: 'sitemap', extensions: ['html', 'md', 'txt'] },
    })
    .returning();

  config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: dataDir,
    DATA_DIR: path.join(dataDir, '.data'),
    SECRET_KEY: '0'.repeat(64),
    CHUNK_MAX_TOKENS: '96',
    CHUNK_OVERLAP_TOKENS: '24',
    // The instance floor is calibrated against the real embedding model; the bag-of-words stub above
    // scores on a different scale entirely.
    SEARCH_SCORE_FLOOR: '0.2',
    // A local server needs no courtesy delay, and a test that waited 500 ms per page would take
    // longer than it is worth. Every other ceiling is left at its shipped default.
    WEB_REQUEST_DELAY_MS: '0',
  });
  indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  ctx = { db: database.db, embeddings, config, log: silentLogger };
  schedulerConfig = { ...config, SYNC_PROBES_PER_TICK: 10 };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  await dropTestDatabase(baseUrl, database);
});

describe('a web source, indexed and then asked about', () => {
  it('indexes the pages the sitemap named, under the paths the site itself uses', async () => {
    requested = [];
    const job = await indexNow();
    expect(job.phase).toBe('done');

    expect(await documentPaths()).toEqual(['docs/guide/install.html', 'docs/guide/overview.html']);
    expect((await sourceRow()).status).toBe('idle');
  });

  it('never fetched the path robots.txt disallows', async () => {
    // The assertion is about the request and not about the index: a crawler that fetched the page and
    // then declined to write it would still have taken it from a site that said not to.
    expect(requested).toContain('/robots.txt');
    expect(requested).not.toContain('/internal/runbook.html');
    expect(await documentPaths()).not.toContain('docs/internal/runbook.html');
  });

  it('refused the JavaScript-rendered page by name instead of indexing it blank', async () => {
    // The page was fetched — it is in the sitemap and robots.txt allows it — and then refused, rather
    // than becoming a document that exists, matches nothing and reads as blank.
    expect(requested).toContain('/guide/app.html');
    expect(await documentPaths()).not.toContain('docs/guide/app.html');
  });

  it('lets search_docs find a page and read_document read it as Markdown', async () => {
    const found = await call('search_docs', { query: 'kurulum yapin' });
    expect(found.isError).toBe(false);
    expect(found.text).toContain('docs/guide/install.html');

    const read = await call('read_document', { path: 'docs/guide/install.html' });
    expect(read.isError).toBe(false);
    expect(read.text).toContain('Title: Kurulum Rehberi');
    // Converted by the shared transform: the heading is a heading, the code is inline code, the table
    // is a table — and the `<style>`, the `<script>` and the raw tags are gone.
    expect(read.text).toContain('# Kurulum Rehberi');
    expect(read.text).toContain('`npm ci && npm run build`');
    expect(read.text).toContain('| Platform | Komut |');
    expect(read.text).not.toContain('<p>');
    expect(read.text).not.toContain('color:red');
  });
});

describe('what one web probe decides', () => {
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
    // Written by `collectSource` out of the sync's `configPatch`, which is the value the next tick
    // compares against. Without it the case below would pass for the wrong reason.
    expect(storedProbeToken((await sourceRow()).config)).toBe('pages=4;lastmod=2026-09-12T11:30:00.000Z');
  });

  it('enqueues nothing while the site has not moved, and reads only the sitemap to decide', async () => {
    await makeDue();
    enqueued.length = 0;
    requested = [];

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 1, enqueued: 0, failed: 0 });
    expect(enqueued).toEqual([]);
    // **The measurement, and the whole reason this source type is affordable on a schedule.** Two
    // requests decided that four pages need no fetching.
    expect(requested).toEqual(['/robots.txt', '/sitemap.xml']);
    expect((await sourceRow()).nextSyncAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('enqueues in the scheduled lane as soon as one page’s lastmod moves', async () => {
    site.lastmod['/guide/overview.html'] = '2026-09-25T08:00:00.000Z';
    await makeDue();
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 0, enqueued: 1, failed: 0 });
    expect(enqueued).toEqual([{ projectId: project.id, trigger: 'scheduled' }]);
  });
});

describe('the run the probe asked for', () => {
  it('re-fetches only the page that changed, and leaves the rest on a 304', async () => {
    site.pages['/guide/overview.html'] = html('Overview', '<p>Rewritten: what this product is for, in two paragraphs.</p><p>And the second.</p>');
    requested = [];

    const job = await indexNow();
    expect(job.phase).toBe('done');
    // `install.html` is asked for — a conditional GET is still a request — and answers 304, so its
    // bytes never cross the wire a second time. What proves it is the *document*, below.
    expect(requested.filter((p) => p === '/guide/install.html')).toHaveLength(1);

    const read = await call('read_document', { path: 'docs/guide/overview.html' });
    expect(read.text).toContain('Rewritten');
    expect(read.text).toContain('And the second.');

    const unchanged = await call('read_document', { path: 'docs/guide/install.html' });
    expect(unchanged.text).toContain('`npm ci && npm run build`');
  });

  it('drops the document of a page the site removed', async () => {
    const removed = site.pages['/guide/overview.html'];
    delete site.pages['/guide/overview.html'];
    try {
      const job = await indexNow();
      expect(job.phase).toBe('done');
      expect(await documentPaths()).toEqual(['docs/guide/install.html']);
      expect((await sourceRow()).lastError).toBeNull();
    } finally {
      site.pages['/guide/overview.html'] = removed;
    }
  });
});

describe('the page ceiling, against a site that has more pages than it', () => {
  it('stops at the ceiling and says on the run why it stopped', async () => {
    // A source of its own — so nothing here disturbs the one the cases above built — and the driver
    // directly, because `WEB_MAX_PAGES` is an instance-wide setting and the point of this case is the
    // ceiling rather than the plumbing everything above already exercises.
    const [narrow] = await database.db
      .insert(documentSources)
      .values({
        projectId: project.id,
        type: 'web',
        name: 'narrow',
        config: { entryUrl: `${origin}/sitemap.xml`, entryKind: 'sitemap', extensions: ['html'] },
      })
      .returning();

    const tight = new WebDriver(narrow, {
      db: database.db,
      log: silentLogger,
      config: { ...config, WEB_MAX_PAGES: 1, WEB_REQUEST_DELAY_MS: 0 },
    });

    const result = await tight.sync();
    expect(result.note).toContain('STOPPED AT THE 1-PAGE CEILING (WEB_MAX_PAGES)');
    expect(result.note).toContain('the rest are NOT indexed');
  });
});
