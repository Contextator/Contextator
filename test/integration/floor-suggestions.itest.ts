import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { documentSources, floorSuggestions, projects } from '../../src/db/schema.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import {
  applyFloorSuggestion,
  CALIBRATION_SEARCH_LIMIT,
  calibrationQueries,
  generateFloorSuggestion,
  listFloorSuggestions,
  MAX_CONCURRENT_MEASUREMENTS,
  MAX_KEPT_SUGGESTIONS,
  MIN_CALIBRATION_PROBES,
} from '../../src/services/floor-calibration.js';
import { ConflictError, NotFoundError } from '../../src/services/projects.js';
import { belowRelevanceFloor } from '../../src/services/relevance.js';
import { searchProject } from '../../src/services/search.js';
import { type NewChunk, replaceDocument, storedDocumentContent } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * Floor suggestions ([ADR-0083](../../.ssot/ADR.md#adr-0083), 0.4-16): measured from the project's own
 * index, stored as advice, and adopted only by an explicit apply.
 *
 * The property the whole feature rests on is the one asserted last in the first block: **a suggestion
 * never touches `projects.score_floor`.** The rest is what makes the number worth offering — it is the
 * floor that answers every probe and the next grid step refuses one — and what keeps a stale one from
 * being adopted after a re-index.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
const OTHER_MODEL_ID = 'local:another-encoder:fp32';

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

const TOPICS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
  'uniform',
  'victor',
  'whiskey',
  'xray',
];

/** One short section per topic, so the closing words of its sentence are a question its own section answers. */
function guide(topics: readonly string[]): string {
  const sections = topics.map((t) => `## Topic ${t}\n\nOperators configure and run the pipeline stage called ${t}.\n`);
  return `# Pipeline guide\n\nWhat the pipeline does.\n\n${sections.join('\n')}`;
}

let database: TestDatabase;
let db: Db;
let sequence = 0;

async function seedProject(topics: readonly string[], opts: { model?: string } = {}): Promise<string> {
  const name = `project-${sequence++}`;
  const text = guide(topics);
  const [project] = await db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  const relativePath = 'handbook/pipeline.md';
  const { title, chunks } = chunkMarkdown(text, relativePath, { maxTokens: 96, overlapTokens: 24, countTokens: estimateTokens });
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
      sizeBytes: Buffer.byteLength(text),
      indexGeneration: 0,
      version: '',
      ...storedDocumentContent(text, 1024 * 1024),
    },
    rows,
  );
  await db
    .update(projects)
    .set({ chunkCount: rows.length, documentCount: 1, embeddingModel: opts.model ?? MODEL_ID, lastIndexedAt: new Date() })
    .where(eq(projects.id, project.id));
  return project.id;
}

const deps = () => ({ db, embeddings });

async function created(projectId: string, trigger: 'model_change' | 'operator' = 'operator') {
  const outcome = await generateFloorSuggestion(deps(), projectId, trigger);
  if (outcome.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(outcome)}`);
  return outcome.suggestion;
}

async function projectFloor(projectId: string): Promise<number | null> {
  const [row] = await db.select({ scoreFloor: projects.scoreFloor }).from(projects).where(eq(projects.id, projectId));
  return row.scoreFloor;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'floor_suggestions');
  await applySchema(database, DIMS);
  db = database.db;
}, 180_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('a suggestion for a project with enough sections', () => {
  it('is the highest grid floor that still answers every probe, and the next step refuses one', async () => {
    const projectId = await seedProject(TOPICS);
    const suggestion = await created(projectId, 'model_change');

    expect(suggestion.trigger).toBe('model_change');
    expect(suggestion.embeddingModel).toBe(MODEL_ID);
    expect(suggestion.basis.method).toBe('sentences');
    expect(suggestion.basis.probes).toBeGreaterThanOrEqual(MIN_CALIBRATION_PROBES);
    expect(suggestion.suggestedFloor).toBeGreaterThanOrEqual(0.6);
    expect(suggestion.suggestedFloor).toBeLessThanOrEqual(0.99);

    // Re-measure independently of the service: the suggested floor refuses none of the probes ...
    const queries = await calibrationQueries(db, projectId, 0);
    const samples = [];
    for (const query of queries) {
      const outcome = await searchProject({ db, embeddings }, { projectId, query, limit: CALIBRATION_SEARCH_LIMIT });
      if (outcome.status !== 'ok') throw new Error(outcome.status);
      samples.push({ query, hits: outcome.hits });
    }
    expect(samples.filter((s) => belowRelevanceFloor(s.query, s.hits, suggestion.suggestedFloor))).toHaveLength(0);
    // ... and one grid step higher refuses at least one (unless the grid ended).
    if (suggestion.suggestedFloor < 0.99) {
      const next = Number((suggestion.suggestedFloor + 0.001).toFixed(3));
      expect(samples.filter((s) => belowRelevanceFloor(s.query, s.hits, next)).length).toBeGreaterThan(0);
    }
    expect(suggestion.basis.topScores?.min).toBeGreaterThanOrEqual(suggestion.suggestedFloor);
  });

  it('is advice only: the project keeps the floor it had', async () => {
    const projectId = await seedProject(TOPICS);
    expect(await projectFloor(projectId)).toBeNull();
    const suggestion = await created(projectId);
    expect(await projectFloor(projectId)).toBeNull();
    expect(suggestion.appliedAt).toBeNull();
    expect(suggestion.previousFloor).toBeNull();

    await db.update(projects).set({ scoreFloor: 0.9 }).where(eq(projects.id, projectId));
    const second = await created(projectId);
    expect(second.previousFloor).toBe(0.9);
    expect(await projectFloor(projectId)).toBe(0.9);
  });

  it('is listed newest first, and only the newest few are kept', async () => {
    const projectId = await seedProject(TOPICS);
    const ids: string[] = [];
    for (let i = 0; i < MAX_KEPT_SUGGESTIONS + 2; i++) ids.push((await created(projectId)).id);
    const listed = await listFloorSuggestions(db, projectId);
    expect(listed).toHaveLength(MAX_KEPT_SUGGESTIONS);
    expect(listed[0].id).toBe(ids[ids.length - 1]);
    expect(listed.map((s) => s.id)).not.toContain(ids[0]);
  });

  it('is asked the same questions on every run over the same index', async () => {
    const projectId = await seedProject(TOPICS);
    expect(await calibrationQueries(db, projectId, 0)).toEqual(await calibrationQueries(db, projectId, 0));
  });

  it('is asked fragments of the text, never a section heading', async () => {
    const projectId = await seedProject(TOPICS);
    const queries = await calibrationQueries(db, projectId, 0);
    expect(queries.length).toBeGreaterThanOrEqual(MIN_CALIBRATION_PROBES);
    for (const query of queries) {
      expect(query).toMatch(/^configure and run the pipeline stage called [a-z]+\.$/);
      expect(query).not.toMatch(/Topic|Pipeline guide/);
    }
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('measurements that overlap', () => {
  it('runs one measurement per project at a time, and stores a single suggestion', async () => {
    const projectId = await seedProject(TOPICS);
    const outcomes = await Promise.all([
      generateFloorSuggestion(deps(), projectId, 'operator'),
      generateFloorSuggestion(deps(), projectId, 'operator'),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['busy', 'created']);
    expect(outcomes.find((o) => o.status === 'busy')).toEqual({ status: 'busy', reason: 'project' });
    expect(await listFloorSuggestions(db, projectId)).toHaveLength(1);

    // The guard is released: the next request is measured.
    expect((await generateFloorSuggestion(deps(), projectId, 'operator')).status).toBe('created');
  });

  it('measures only a few projects at once across the server', async () => {
    const ids = [];
    for (let i = 0; i < MAX_CONCURRENT_MEASUREMENTS + 1; i++) ids.push(await seedProject(TOPICS));
    const outcomes = await Promise.all(ids.map((id) => generateFloorSuggestion(deps(), id, 'operator')));
    expect(outcomes.filter((o) => o.status === 'created')).toHaveLength(MAX_CONCURRENT_MEASUREMENTS);
    expect(outcomes.filter((o) => o.status === 'busy')).toEqual([{ status: 'busy', reason: 'server' }]);
  });

  it('releases the project when the measurement fails', async () => {
    const projectId = await seedProject(TOPICS);
    const broken: EmbeddingProvider = {
      ...embeddings,
      embedQuery: async () => {
        throw new Error('encoder down');
      },
    };
    await expect(generateFloorSuggestion({ db, embeddings: broken }, projectId, 'operator')).rejects.toThrow('encoder down');
    expect((await generateFloorSuggestion(deps(), projectId, 'operator')).status).toBe('created');
  });
});

describe('a project that cannot be measured', () => {
  it('has too few passages to ask', async () => {
    const projectId = await seedProject(TOPICS.slice(0, 3));
    const outcome = await generateFloorSuggestion(deps(), projectId, 'operator');
    expect(outcome).toMatchObject({ status: 'insufficient_data', required: MIN_CALIBRATION_PROBES });
    expect(await listFloorSuggestions(db, projectId)).toHaveLength(0);
  });

  it('was indexed with another encoder, whose numbers mean nothing here', async () => {
    const projectId = await seedProject(TOPICS, { model: OTHER_MODEL_ID });
    expect(await generateFloorSuggestion(deps(), projectId, 'operator')).toEqual({
      status: 'model_mismatch',
      indexedWith: OTHER_MODEL_ID,
      serverUses: MODEL_ID,
    });
  });

  it('has not been indexed at all', async () => {
    const [empty] = await db
      .insert(projects)
      .values({ name: `empty-${sequence++}` })
      .returning({ id: projects.id });
    expect(await generateFloorSuggestion(deps(), empty.id, 'operator')).toEqual({ status: 'not_indexed' });
  });

  it('does not exist', async () => {
    expect(await generateFloorSuggestion(deps(), '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'operator')).toEqual({ status: 'project_gone' });
  });
});

describe('adopting a suggestion', () => {
  it('sets the project floor and marks the suggestion applied', async () => {
    const projectId = await seedProject(TOPICS);
    const suggestion = await created(projectId);
    const applied = await applyFloorSuggestion(db, projectId, suggestion.id);
    expect(applied.scoreFloor).toBe(suggestion.suggestedFloor);
    expect(applied.suggestion.appliedAt).not.toBeNull();
    expect(await projectFloor(projectId)).toBe(suggestion.suggestedFloor);
    expect((await listFloorSuggestions(db, projectId))[0].appliedAt).not.toBeNull();
  });

  it('answers every probe under the adopted floor', async () => {
    const projectId = await seedProject(TOPICS);
    const suggestion = await created(projectId);
    await applyFloorSuggestion(db, projectId, suggestion.id);
    for (const query of await calibrationQueries(db, projectId, 0)) {
      const outcome = await searchProject({ db, embeddings }, { projectId, query, limit: CALIBRATION_SEARCH_LIMIT });
      if (outcome.status !== 'ok') throw new Error(outcome.status);
      expect(belowRelevanceFloor(query, outcome.hits, suggestion.suggestedFloor)).toBe(false);
    }
  });

  it('refuses a suggestion that was already applied', async () => {
    const projectId = await seedProject(TOPICS);
    const suggestion = await created(projectId);
    await applyFloorSuggestion(db, projectId, suggestion.id);
    await expect(applyFloorSuggestion(db, projectId, suggestion.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a suggestion measured against an earlier encoder', async () => {
    const projectId = await seedProject(TOPICS);
    const suggestion = await created(projectId);
    await db.update(projects).set({ embeddingModel: OTHER_MODEL_ID }).where(eq(projects.id, projectId));
    await expect(applyFloorSuggestion(db, projectId, suggestion.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await projectFloor(projectId)).toBeNull();
  });

  it('refuses a suggestion measured against an earlier generation', async () => {
    const projectId = await seedProject(TOPICS);
    const suggestion = await created(projectId);
    await db.update(projects).set({ liveGeneration: 1 }).where(eq(projects.id, projectId));
    await expect(applyFloorSuggestion(db, projectId, suggestion.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await projectFloor(projectId)).toBeNull();
  });

  it('does not find another project’s suggestion', async () => {
    const mine = await seedProject(TOPICS);
    const theirs = await seedProject(TOPICS);
    const suggestion = await created(theirs);
    await expect(applyFloorSuggestion(db, mine, suggestion.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await projectFloor(mine)).toBeNull();
    expect(await projectFloor(theirs)).toBeNull();
  });

  it('is gone with the project', async () => {
    const projectId = await seedProject(TOPICS);
    await created(projectId);
    await db.delete(projects).where(eq(projects.id, projectId));
    expect(await db.select().from(floorSuggestions).where(eq(floorSuggestions.projectId, projectId))).toHaveLength(0);
  });
});
