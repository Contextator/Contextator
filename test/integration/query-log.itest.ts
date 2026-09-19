import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, mcpTokens, projects, searchQueries, searchQueryHits } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { QueryLog, sweepQueryLog } from '../../src/services/query-log.js';
import { searchProject } from '../../src/services/search.js';
import { type NewChunk, replaceDocument, storedDocumentContent } from '../../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  execInPostgresOrThrow,
  silentLogger,
  TEST_EMBEDDING_DIMENSIONS,
  type TestDatabase,
} from './support/postgres.js';

/**
 * The write side of the query log ([ADR-0047](../../../.ssot/ADR.md#adr-0047)), against a real
 * PostgreSQL and through the real `search_docs` tool.
 *
 * Five claims, and each of them is a claim the unit suite cannot make:
 *
 * - a search through the MCP tool writes a row **and its hits**, carrying the token it came through,
 *   the encoder that answered and the generation it answered from;
 * - the same search with the project's switch off writes nothing;
 * - `searchProject` with no sink — which is how `npm run eval` calls it — writes nothing;
 * - retention deletes what is past the window **and nothing else**;
 * - a `pg_dump` / `pg_restore` round trip carries the log, which is the honest way to show that the
 *   privacy consequence the page now states is real rather than theoretical.
 *
 * The bounded buffer's own behaviour under saturation is `test/query-log.test.ts`: a real database that
 * is fast enough to keep up is a test that never reaches the case it exists for.
 */

const baseUrl = inject('postgresBaseUrl');
const containerId = inject('postgresContainerId');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const LIVE = 0;

/** The database the round trip at the bottom dumps, drops and restores. */
const SUBJECT = 'query_log';
const DUMP_PATH = '/tmp/contextator-query-log.dump';

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

const GUIDE = `# Delivery guide

Introduction to the delivery pipeline and what it is for.

## Install

Install the package from the registry before anything else.

### Docker

Run the published image with the compose file in the repository, mounting the documentation read-only.

## Tuning

Set DISPATCH_WORKERS to the number of cores the host can spare for delivery.
`;

let database: TestDatabase;
let db: Db;
let projectId: string;
let quietProjectId: string;
/** A project whose documents carry a release label, so the third filter has something to be about. */
let releasedProjectId: string;
let tokenId: string;
const config = loadConfig({ DATABASE_URL: 'postgres://unused/unused', SEARCH_SCORE_FLOOR: '0' });

/** One project, one source, one document, indexed through the product's own write path. */
async function seedProject(name: string, version = ''): Promise<string> {
  const [project] = await db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook', config: version ? { version } : {} })
    .returning({ id: documentSources.id });

  const relativePath = 'handbook/delivery.md';
  const { title, chunks } = chunkMarkdown(GUIDE, relativePath, { maxTokens: 96, overlapTokens: 24, countTokens: estimateTokens });
  const rows: NewChunk[] = chunks.map((c) => ({
    chunkIndex: c.index,
    headingPath: c.headingPath,
    content: c.content,
    tokenCount: c.tokenCount,
    embedding: stubVector(embeddingText(c)),
  }));
  await replaceDocument(
    db,
    {
      projectId: project.id,
      sourceId: source.id,
      relativePath,
      title,
      contentHash: `hash-${name}`,
      sizeBytes: Buffer.byteLength(GUIDE),
      indexGeneration: LIVE,
      version,
      ...storedDocumentContent(GUIDE, 1024 * 1024),
    },
    rows,
  );
  await db
    .update(projects)
    .set({ chunkCount: rows.length, documentCount: 1, embeddingModel: MODEL_ID, lastIndexedAt: new Date() })
    .where(eq(projects.id, project.id));
  return project.id;
}

/** `search_docs` as an agent reaches it: a real client, a real `McpServer`, over an in-memory pipe. */
async function askThroughMcp(queryLog: QueryLog | undefined, id: string, query: string, mcpTokenId: string | null): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0-test' });
  const ctx = { db, embeddings, config, log: silentLogger, queryLog } as unknown as ToolContext;
  registerTools(server, ctx, project, mcpTokenId);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: 'search_docs', arguments: { query, limit: 3 } });
  } finally {
    await client.close();
    await server.close();
  }
}

const loggedQueries = (id?: string) =>
  db
    .select()
    .from(searchQueries)
    .where(id ? eq(searchQueries.projectId, id) : sql`true`)
    .orderBy(asc(searchQueries.createdAt));

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, SUBJECT);
  await applySchema(database, DIMS);
  db = database.db;

  projectId = await seedProject('handbook');
  quietProjectId = await seedProject('handbook-quiet');
  releasedProjectId = await seedProject('handbook-v4', 'v4');
  // The project that does not want to be recorded. The switch is a column, so this is how an operator
  // setting it will look to the search path.
  await db.update(projects).set({ queryLogEnabled: false }).where(eq(projects.id, quietProjectId));

  const [token] = await db
    .insert(mcpTokens)
    .values({ projectId, name: 'Cursor on my laptop', tokenHash: 'not-a-real-hash', prefix: 'ctxm_1234…' })
    .returning({ id: mcpTokens.id });
  tokenId = token.id;
}, 180_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('a search through the MCP tool', () => {
  it('writes one row carrying the token, the encoder and the generation, and one row per excerpt', async () => {
    const queryLog = new QueryLog(db, silentLogger);
    await askThroughMcp(queryLog, projectId, 'How do I run this with Docker?', tokenId);
    await queryLog.flush();

    const rows = await loggedQueries(projectId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actor).toBe('mcp');
    expect(row.mcpTokenId).toBe(tokenId);
    expect(row.query).toBe('How do I run this with Docker?');
    expect(row.queryNorm).toBe('how do i run this with docker?');
    expect(row.resultLimit).toBe(3);
    expect(row.filterSource).toBeNull();
    expect(row.filterPathPrefix).toBeNull();
    // The two columns the whole table is comparable because of: which encoder answered, and which
    // index generation it answered from (ADR-0047).
    expect(row.embeddingModel).toBe(MODEL_ID);
    expect(row.liveGeneration).toBe(LIVE);
    expect(row.hitCount).toBeGreaterThan(0);
    expect(row.topScore).not.toBeNull();
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(queryLog.stats()).toMatchObject({ dropped: 0, failed: 0, written: 1 });

    const hits = await db.select().from(searchQueryHits).where(eq(searchQueryHits.queryId, row.id)).orderBy(asc(searchQueryHits.rank));
    expect(hits).toHaveLength(row.hitCount);
    expect(hits.map((h) => h.rank)).toEqual(hits.map((_, i) => i + 1));
    // The path and not a document id, because ADR-0039's sweeper deletes documents and would take the
    // log with it (ADR-0047).
    for (const hit of hits) expect(hit.relativePath).toBe('handbook/delivery.md');
    expect(hits[0].score).toBeCloseTo(row.topScore ?? -1, 10);
    // Ranked as the agent saw them, best first.
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
  });

  it('records the filters it was narrowed with, so a report can say what was already scoped', async () => {
    const queryLog = new QueryLog(db, silentLogger);
    const outcome = await searchProject(
      { db, embeddings, queryLog: queryLog.for('dashboard') },
      // Deliberately spelled the way a form would send it — `./handbook`, which is the same prefix.
      { projectId, query: 'DISPATCH_WORKERS', limit: 2, source: 'handbook', pathPrefix: './handbook' },
    );
    expect(outcome.status).toBe('ok');
    await queryLog.flush();

    // Found by its text rather than by position: two rows written in the same millisecond have no
    // order between them, and a test that depended on one would fail on a fast machine and not a slow.
    const row = (await loggedQueries(projectId)).find((r) => r.query === 'DISPATCH_WORKERS');
    expect(row).toBeDefined();
    expect(row?.actor).toBe('dashboard');
    expect(row?.mcpTokenId).toBeNull();
    expect(row?.filterSource).toBe('handbook');
    // The *normalised* prefix, not what was typed, so two spellings of one filter are one filter in
    // the log as they are in the query.
    expect(row?.filterPathPrefix).toBe('handbook');
    // The third filter was not one of them, and NULL is how the row says so rather than by omission.
    expect(row?.filterVersion).toBeNull();
    expect(row?.resultLimit).toBe(2);
  });

  it('records the version a search was scoped to, so all three filters are on the row or none is', async () => {
    // [ADR-0058](../../.ssot/ADR.md#adr-0058)'s column, and the reason it exists rather than being
    // left out: the three filters together are what decide *which corpus* a question was asked of, so
    // a log that carried two of them would describe a search nobody ran — and the first thing an
    // analysis of a bad answer needs is what the agent had already narrowed away.
    const queryLog = new QueryLog(db, silentLogger);
    const outcome = await searchProject(
      { db, embeddings, queryLog: queryLog.for('mcp') },
      // Spelled with the padding a client might send, so the *resolved* label is what lands, the way
      // `filterPathPrefix` above is the normalised prefix rather than what was typed.
      { projectId: releasedProjectId, query: 'DISPATCH_WORKERS in v4', limit: 2, version: '  v4  ' },
    );
    expect(outcome.status).toBe('ok');
    await queryLog.flush();

    const row = (await loggedQueries(releasedProjectId)).find((r) => r.query === 'DISPATCH_WORKERS in v4');
    expect(row).toBeDefined();
    expect(row?.filterVersion).toBe('v4');
    expect(row?.filterSource).toBeNull();
    expect(row?.filterPathPrefix).toBeNull();
  });

  it('leaves the version column null for a search over every version of the same project', async () => {
    // The negative half, on the *same* project, so "it wrote v4" cannot be a property of the fixture.
    const queryLog = new QueryLog(db, silentLogger);
    const outcome = await searchProject(
      { db, embeddings, queryLog: queryLog.for('mcp') },
      { projectId: releasedProjectId, query: 'DISPATCH_WORKERS unscoped', limit: 2 },
    );
    expect(outcome.status).toBe('ok');
    await queryLog.flush();

    const row = (await loggedQueries(releasedProjectId)).find((r) => r.query === 'DISPATCH_WORKERS unscoped');
    expect(row).toBeDefined();
    expect(row?.filterVersion).toBeNull();
  });

  it('never records a version the index does not carry, because that search never ran', async () => {
    // An unknown version is refused before anything is embedded, and the five outcomes that never
    // reach the index are configuration states rather than questions ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
    // Without this, a refused filter would be indistinguishable from one that returned nothing.
    const queryLog = new QueryLog(db, silentLogger);
    const outcome = await searchProject(
      { db, embeddings, queryLog: queryLog.for('mcp') },
      { projectId: releasedProjectId, query: 'DISPATCH_WORKERS in v9', limit: 2, version: 'v9' },
    );
    expect(outcome.status).toBe('unknown_version');
    await queryLog.flush();

    expect((await loggedQueries(releasedProjectId)).find((r) => r.query === 'DISPATCH_WORKERS in v9')).toBeUndefined();
  });
});

describe('the per-project switch', () => {
  it('writes nothing at all for a project that has it off, with everything else the same', async () => {
    const queryLog = new QueryLog(db, silentLogger);
    await askThroughMcp(queryLog, quietProjectId, 'How do I run this with Docker?', null);
    await queryLog.flush();

    expect(await loggedQueries(quietProjectId)).toEqual([]);
    // Not dropped and not failed — never offered. The switch is read before the sink is touched.
    expect(queryLog.stats()).toMatchObject({ accepted: 0, written: 0, dropped: 0, failed: 0 });
  });

  it('is a column, so it survives everything an environment variable would not', async () => {
    const [quiet] = await db.select().from(projects).where(eq(projects.id, quietProjectId)).limit(1);
    const [loud] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    expect(quiet.queryLogEnabled).toBe(false);
    // And the default is on, which is what makes the log have anything in it a month from now.
    expect(loud.queryLogEnabled).toBe(true);
  });
});

describe('a caller that passes no sink', () => {
  it('records nothing — which is how `npm run eval` records nothing', async () => {
    const before = (await loggedQueries()).length;
    // Exactly the shape `scripts/eval.ts` calls it in: no `queryLog` key at all.
    const outcome = await searchProject({ db, embeddings, scoreFloor: 0 }, { projectId, query: 'the eval harness asks this', limit: 5 });
    expect(outcome.status).toBe('ok');
    expect((await loggedQueries()).length).toBe(before);
  });
});

describe('retention', () => {
  it('deletes what is past the window and nothing else, and takes the hits with it', async () => {
    const queryLog = new QueryLog(db, silentLogger);
    await askThroughMcp(queryLog, projectId, 'a question from long ago', tokenId);
    await askThroughMcp(queryLog, projectId, 'a question from this morning', tokenId);
    await queryLog.flush();

    const rows = await loggedQueries(projectId);
    const old = rows.find((r) => r.query === 'a question from long ago');
    const recent = rows.find((r) => r.query === 'a question from this morning');
    expect(old && recent).toBeTruthy();
    // Backdated in the database rather than by faking a clock: the sweep compares against `now()` in
    // SQL, which is the property that makes the retention window immune to the process's clock.
    await db
      .update(searchQueries)
      .set({ createdAt: sql`now() - interval '31 days'` })
      .where(eq(searchQueries.id, old?.id ?? ''));
    const oldHits = await db
      .select()
      .from(searchQueryHits)
      .where(eq(searchQueryHits.queryId, old?.id ?? ''));
    expect(oldHits.length).toBeGreaterThan(0);

    const before = (await loggedQueries()).length;
    const deleted = await sweepQueryLog(db, 30);

    expect(deleted).toBe(1);
    const after = await loggedQueries();
    expect(after.length).toBe(before - 1);
    expect(after.map((r) => r.query)).not.toContain('a question from long ago');
    expect(after.map((r) => r.query)).toContain('a question from this morning');
    // The hits went with it, through the cascade rather than through a second statement.
    expect(
      await db
        .select()
        .from(searchQueryHits)
        .where(eq(searchQueryHits.queryId, old?.id ?? '')),
    ).toEqual([]);

    // A day short of the window deletes nothing: the boundary is a boundary and not a rounding.
    expect(await sweepQueryLog(db, 30)).toBe(0);
  });
});

describe('the per-project row cap', () => {
  it('keeps the most recent rows of that project and touches no other project', async () => {
    const cappedId = await seedProject('handbook-capped');
    const others = (await loggedQueries()).length;

    // Two rows kept, four written: the cap is pruned as rows land, the way the run history is.
    const queryLog = new QueryLog(db, silentLogger, { projectRowCap: 2 });
    for (const n of [1, 2, 3, 4]) {
      await searchProject({ db, embeddings, queryLog: queryLog.for('mcp', null) }, { projectId: cappedId, query: `capped ${n}`, limit: 1 });
      // One at a time, so the four rows have four distinct `created_at` values and "most recent" is a
      // claim with an answer. Batched, they would share a transaction timestamp and could not be cut.
      await queryLog.flush();
    }

    const kept = await loggedQueries(cappedId);
    expect(kept.map((r) => r.query)).toEqual(['capped 3', 'capped 4']);
    // Every other project's rows are exactly where they were: the cap is per project, not per table.
    expect((await loggedQueries()).length).toBe(others + 2);
  });
});

describe('a pg_dump / pg_restore round trip', () => {
  it('carries the query log, which is the privacy consequence the page now states', async () => {
    const before = await loggedQueries();
    expect(before.length).toBeGreaterThan(0);
    const hitsBefore = await db.select().from(searchQueryHits).orderBy(asc(searchQueryHits.queryId), asc(searchQueryHits.rank));
    expect(hitsBefore.length).toBeGreaterThan(0);

    // OPERATIONS.md §4, exactly: the tools run inside the container, next to the server they speak to.
    await execInPostgresOrThrow(containerId, ['sh', '-c', `pg_dump -U contextator -Fc -f ${DUMP_PATH} ${SUBJECT}`]);
    await dropTestDatabase(baseUrl, database);
    database = await createTestDatabase(baseUrl, SUBJECT);
    db = database.db;
    await execInPostgresOrThrow(containerId, ['sh', '-c', `pg_restore -U contextator -d ${SUBJECT} --clean --if-exists ${DUMP_PATH}`]);

    const after = await loggedQueries();
    // **The questions somebody asked this instance came back out of the archive, in the clear.** That
    // is what [ADR-0046](../../../.ssot/ADR.md#adr-0046)'s dump being a documented artefact now means,
    // and it is why the privacy page and SECURITY.md say a backup holds user content.
    expect(after).toEqual(before);
    expect(after.map((r) => r.query)).toContain('a question from this morning');
    expect(await db.select().from(searchQueryHits).orderBy(asc(searchQueryHits.queryId), asc(searchQueryHits.rank))).toEqual(hitsBefore);
    // Including the per-project switch, which is the whole reason it is a column and not a setting.
    const [quiet] = await db.select().from(projects).where(eq(projects.id, quietProjectId)).limit(1);
    expect(quiet.queryLogEnabled).toBe(false);
  }, 180_000);
});
