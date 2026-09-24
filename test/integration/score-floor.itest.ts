import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { setProjectScoreFloor } from '../../src/services/projects.js';
import type { QueryLogEntry } from '../../src/services/query-log.js';
import { belowRelevanceFloor } from '../../src/services/relevance.js';
import { searchProject } from '../../src/services/search.js';
import { type NewChunk, replaceDocument, storedDocumentContent } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A project's own relevance floor (`projects.score_floor`) against the instance's `SEARCH_SCORE_FLOOR`.
 *
 * The claim that matters most is the first describe block: **a project whose column is `null` decides
 * exactly as it did before the column existed** — the same `belowFloor` `belowRelevanceFloor` gives
 * for the instance's floor, the same number cited. Everything else is what an override changes and
 * what it must not: it never turns a floor on for a caller that passed none (the evaluation harness),
 * and the database refuses a value that is not a cosine similarity.
 *
 * The floors are placed around the top score this fixture actually produces, read at the start, so
 * the assertions are about the decision and not about the stub encoder's numbers.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const LIVE = 0;

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

## Tuning

Set the worker count to the number of cores the host can spare for delivery.
`;

/** Plain words, so the identifier escape hatch cannot be what lets it past. */
const QUERY = 'how many cores can the host spare for the delivery workers';

let database: TestDatabase;
let db: Db;
let projectId: string;
/** The best hit's cosine for `QUERY` with no floor at all. */
let top: number;
/** Just above `top`: this floor refuses `QUERY`. */
let above: number;
/** Just below `top`: this floor answers it. */
let below: number;

async function seedProject(name: string): Promise<string> {
  const [project] = await db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
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
      version: '',
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

const search = (scoreFloor: number | undefined) => searchProject({ db, embeddings, scoreFloor }, { projectId, query: QUERY, limit: 5 });

async function okSearch(scoreFloor: number | undefined) {
  const outcome = await search(scoreFloor);
  if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
  return outcome;
}

/** `search_docs` as an agent reaches it, with the instance floor set to `instanceFloor`. */
async function askThroughMcp(instanceFloor: number): Promise<string> {
  const config = loadConfig({ DATABASE_URL: database.url, SECRET_KEY: '0'.repeat(64), SEARCH_SCORE_FLOOR: String(instanceFloor) });
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0-test' });
  const ctx: ToolContext = { db, embeddings, config, log: silentLogger };
  registerTools(server, ctx, project, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'search_docs', arguments: { query: QUERY, limit: 3 } });
    const content = result.content as Array<{ type: string; text: string }>;
    return content.map((c) => c.text).join('\n');
  } finally {
    await client.close();
    await server.close();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'score_floor');
  await applySchema(database, DIMS);
  db = database.db;
  projectId = await seedProject('handbook');

  const unfloored = await okSearch(undefined);
  top = unfloored.hits[0].score;
  above = Math.min(1, Number((top + 0.01).toFixed(3)));
  below = Math.max(0, Number((top - 0.01).toFixed(3)));
  // The fixture has to leave room on both sides of the top score, or half of this file asserts nothing.
  expect(top).toBeGreaterThan(0.02);
  expect(top).toBeLessThan(0.98);
}, 180_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

beforeEach(async () => {
  await setProjectScoreFloor(db, projectId, null);
});

describe('a project nobody has set a floor on', () => {
  it('starts with a null column', async () => {
    const [row] = await db.select({ scoreFloor: projects.scoreFloor }).from(projects).where(eq(projects.id, projectId));
    expect(row.scoreFloor).toBeNull();
  });

  it.each([
    ['refuses', () => above, true],
    ['answers', () => below, false],
  ])('%s exactly as belowRelevanceFloor does at the instance floor', async (_label, floor, refused) => {
    const outcome = await okSearch(floor());
    expect(outcome.belowFloor).toBe(refused);
    expect(outcome.belowFloor).toBe(belowRelevanceFloor(QUERY, outcome.hits, floor()));
    expect(outcome.scoreFloor).toBe(floor());
    expect(outcome.scoreFloorOverridden).toBe(false);
  });

  it('tells the agent the server’s floor, in the words it always has', async () => {
    const text = await askThroughMcp(above);
    expect(text).toContain(`below this server's floor of ${above}`);
  });
});

describe('a project with a floor of its own', () => {
  it('answers under a lower project floor what the instance floor would refuse', async () => {
    await setProjectScoreFloor(db, projectId, below);
    const outcome = await okSearch(above);
    expect(outcome.belowFloor).toBe(false);
    expect(outcome.scoreFloor).toBe(below);
    expect(outcome.scoreFloorOverridden).toBe(true);
  });

  it('refuses under a higher project floor what the instance floor would answer', async () => {
    await setProjectScoreFloor(db, projectId, above);
    const outcome = await okSearch(below);
    expect(outcome.belowFloor).toBe(true);
    expect(outcome.scoreFloor).toBe(above);
  });

  it('is switched off for this project alone by a floor of 0', async () => {
    await setProjectScoreFloor(db, projectId, 0);
    const outcome = await okSearch(above);
    expect(outcome.belowFloor).toBe(false);
    expect(outcome.scoreFloor).toBe(0);
    expect(outcome.scoreFloorOverridden).toBe(true);
  });

  it('never turns a floor on for a caller that passed none, which is how the harness measures', async () => {
    await setProjectScoreFloor(db, projectId, 1);
    const outcome = await okSearch(undefined);
    expect(outcome.belowFloor).toBe(false);
    expect(outcome.scoreFloor).toBe(0);
    expect(outcome.scoreFloorOverridden).toBe(false);
  });

  it('is handed back to the instance by null', async () => {
    await setProjectScoreFloor(db, projectId, below);
    await setProjectScoreFloor(db, projectId, null);
    const outcome = await okSearch(above);
    expect(outcome.belowFloor).toBe(true);
    expect(outcome.scoreFloorOverridden).toBe(false);
  });

  it('tells the agent the project’s floor, and says it is the project’s', async () => {
    await setProjectScoreFloor(db, projectId, above);
    const text = await askThroughMcp(below);
    expect(text).toContain(`below this project's floor of ${above}`);
  });
});

/**
 * The server's `SEARCH_SCORE_FLOOR=0` is what the startup warning and the troubleshooting advice tell
 * an operator to set when a model change makes every search answer "no good match". That advice has to
 * work without first finding which projects carry a floor of their own, so `0` turns theirs off too.
 */
describe('the server’s 0, which turns every floor off', () => {
  it.each([
    ['a floor above the top score', () => above],
    ['a floor of 1', () => 1],
  ])('answers a project with %s', async (_label, column) => {
    await setProjectScoreFloor(db, projectId, column());
    const outcome = await okSearch(0);
    expect(outcome.belowFloor).toBe(false);
    expect(outcome.scoreFloor).toBe(0);
    expect(outcome.scoreFloorOverridden).toBe(false);
  });

  it('decides exactly as the harness’s call without a floor does', async () => {
    await setProjectScoreFloor(db, projectId, above);
    const zero = await okSearch(0);
    const none = await okSearch(undefined);
    expect([zero.belowFloor, zero.scoreFloor, zero.scoreFloorOverridden]).toEqual([none.belowFloor, none.scoreFloor, none.scoreFloorOverridden]);
  });

  it('hands the agent the excerpts rather than the project’s refusal', async () => {
    await setProjectScoreFloor(db, projectId, above);
    const text = await askThroughMcp(0);
    expect(text).not.toContain('floor of');
    expect(text).toContain('handbook/delivery.md');
  });
});

describe('what the log records beside the verdict', () => {
  const logged = async (instanceFloor: number | undefined): Promise<QueryLogEntry> => {
    const entries: QueryLogEntry[] = [];
    const outcome = await searchProject(
      { db, embeddings, scoreFloor: instanceFloor, queryLog: { record: (entry) => entries.push(entry) } },
      { projectId, query: QUERY, limit: 5 },
    );
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    expect(entries).toHaveLength(1);
    return entries[0];
  };

  it('is the floor the search was decided against — the project’s, the server’s, or 0 for off', async () => {
    await setProjectScoreFloor(db, projectId, above);
    expect(await logged(below)).toMatchObject({ belowFloor: true, scoreFloor: above });
    await setProjectScoreFloor(db, projectId, null);
    expect(await logged(below)).toMatchObject({ belowFloor: false, scoreFloor: below });
    await setProjectScoreFloor(db, projectId, above);
    expect(await logged(0)).toMatchObject({ belowFloor: false, scoreFloor: 0 });
  });
});

describe('what the column accepts', () => {
  it.each([1.5, -0.1])('refuses %s, which is not a cosine similarity', async (value) => {
    await expect(db.update(projects).set({ scoreFloor: value }).where(eq(projects.id, projectId))).rejects.toThrow();
  });

  it('returns undefined for a project that does not exist', async () => {
    expect(await setProjectScoreFloor(db, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 0.8)).toBeUndefined();
  });
});
