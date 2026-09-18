import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { chunks, documentSources, documents, projects } from '../../src/db/schema.js';
import { type NewChunk, replaceDocument, searchChunks } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The two things in `services/vector-store.ts` that a mocked client cannot observe (ADR-0031): a
 * transaction that has to roll all the way back, and a distance query that has to stay inside one
 * project.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

/**
 * A unit vector in the plane spanned by the first two coordinates. Every embedding in this file is
 * built by this function, so the expected cosine distance of a hit is `1 - cos(theta)` — arithmetic a
 * reviewer can redo, rather than an embedding model's opinion that would have to be trusted.
 */
function unitVector(theta: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

/** Every `message` from an error and its `cause` chain, because Drizzle wraps what the driver threw. */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message);
  return parts.join(' | ');
}

/** A vector literal in pgvector's text input format, for the raw-distance cross-check below. */
function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

async function freshSchema(name: string): Promise<TestDatabase> {
  const database = await createTestDatabase(baseUrl, name);
  await applySchema(database, DIMS);
  return database;
}

async function seedProject(database: TestDatabase, name: string): Promise<{ projectId: string; sourceId: string }> {
  const [project] = await database.db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  return { projectId: project.id, sourceId: source.id };
}

describe('replaceDocument when an insert slice fails', () => {
  // INSERT_BATCH in services/vector-store.ts is 200, so 250 chunks are written as two slices and a
  // chunk at index 210 lands in the second one — after the delete and the first insert have already
  // happened inside the transaction. That is the failure this case exists for.
  const CHUNK_COUNT = 250;
  let database: TestDatabase;
  let projectId: string;
  let sourceId: string;

  beforeAll(async () => {
    database = await freshSchema('vector_store_rollback');
    ({ projectId, sourceId } = await seedProject(database, 'rollback-project'));
  });

  afterAll(async () => {
    await dropTestDatabase(baseUrl, database);
  });

  function buildChunks(label: string, breakAt?: number): NewChunk[] {
    return Array.from({ length: CHUNK_COUNT }, (_, i) => ({
      chunkIndex: i,
      headingPath: 'Guide',
      content: `${label} chunk ${i}`,
      tokenCount: 10,
      // One number short of the column's dimension. pgvector rejects it; nothing here does.
      embedding: i === breakAt ? unitVector(0.1).slice(0, DIMS - 1) : unitVector(i / 100),
    }));
  }

  it('leaves the document and every one of its chunks exactly as they were', async () => {
    const original = {
      projectId,
      sourceId,
      relativePath: 'handbook/big.md',
      title: 'Big',
      contentHash: 'hash-original',
      sizeBytes: 4096,
    };
    const documentId = await replaceDocument(database.db, original, buildChunks('original'));

    const [before] = await database.db.select().from(documents).where(eq(documents.id, documentId));
    expect(before.chunkCount).toBe(CHUNK_COUNT);

    // The second slice raises. The first slice, and the delete before it, must not survive it.
    const failure = await replaceDocument(
      database.db,
      { ...original, contentHash: 'hash-replacement', sizeBytes: 8192, title: 'Replaced' },
      buildChunks('replacement', 210),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // Drizzle wraps the driver's error in a `Failed query: …` of its own and keeps the real one as
    // `cause`, so the assertion has to walk the chain rather than read `.message`.
    expect(messageChain(failure)).toMatch(/expected 384 dimensions, not 383/);

    const [after] = await database.db.select().from(documents).where(eq(documents.id, documentId));
    expect(after.chunkCount).toBe(CHUNK_COUNT);
    expect(after.indexedAt.getTime()).toBe(before.indexedAt.getTime());
    expect(after.contentHash).toBe('hash-original');
    expect(after.title).toBe('Big');
    expect(after.sizeBytes).toBe(4096);

    const [{ n }] = await database.db.select({ n: sql<number>`count(*)::int` }).from(chunks).where(eq(chunks.documentId, documentId));
    expect(n).toBe(CHUNK_COUNT);

    // Content, not just cardinality: the first slice of the failed attempt did reach the table.
    const rows = await database.db
      .select({ chunkIndex: chunks.chunkIndex, content: chunks.content })
      .from(chunks)
      .where(eq(chunks.documentId, documentId))
      .orderBy(chunks.chunkIndex);
    expect(rows).toHaveLength(CHUNK_COUNT);
    expect(rows[0]).toEqual({ chunkIndex: 0, content: 'original chunk 0' });
    expect(rows[199]).toEqual({ chunkIndex: 199, content: 'original chunk 199' });
    expect(rows[210]).toEqual({ chunkIndex: 210, content: 'original chunk 210' });
    expect(rows.every((r) => r.content.startsWith('original chunk '))).toBe(true);
  });
});

describe('searchChunks across two projects', () => {
  /** Chunk index -> angle. Deliberately not monotonic, so "ordered by distance" cannot be satisfied
   *  by accidentally returning rows in insertion or chunk_index order. */
  const ANGLES = [0.6, 1.0, 0.2, 0.8, 0.4];
  /** Ascending distance is ascending angle: 0.2, 0.4, 0.6, 0.8, 1.0. */
  const EXPECTED_ORDER = [2, 4, 0, 3, 1];
  const QUERY = unitVector(0);

  let database: TestDatabase;
  let alpha: string;
  let beta: string;

  beforeAll(async () => {
    database = await freshSchema('vector_store_search');

    // Byte-identical documents in both projects: same path, same title, same hash, same chunk text.
    // Only the embeddings differ, so nothing but the project scope can separate the two result sets.
    const sharedDocument = { relativePath: 'handbook/guide.md', title: 'Guide', contentHash: 'hash-shared', sizeBytes: 2048 };
    const sharedChunk = (chunkIndex: number, embedding: number[]): NewChunk => ({
      chunkIndex,
      headingPath: 'Guide > Install',
      content: `section ${chunkIndex}`,
      tokenCount: 12,
      embedding,
    });

    const a = await seedProject(database, 'alpha');
    alpha = a.projectId;
    await replaceDocument(
      database.db,
      { ...sharedDocument, projectId: a.projectId, sourceId: a.sourceId },
      ANGLES.map((theta, i) => sharedChunk(i, unitVector(theta))),
    );

    // Every chunk in beta is an exact match for the query. If a single one of them leaked into
    // alpha's results it would arrive first, with a score of 1.
    const b = await seedProject(database, 'beta');
    beta = b.projectId;
    await replaceDocument(
      database.db,
      { ...sharedDocument, projectId: b.projectId, sourceId: b.sourceId },
      ANGLES.map((_, i) => sharedChunk(i, unitVector(0))),
    );
  });

  afterAll(async () => {
    await dropTestDatabase(baseUrl, database);
  });

  it('returns only the queried project, ordered by ascending distance', async () => {
    const hits = await searchChunks(database.db, alpha, QUERY, 10);

    expect(hits).toHaveLength(ANGLES.length);
    expect(hits.map((h) => h.chunkIndex)).toEqual(EXPECTED_ORDER);
    expect(hits.map((h) => h.file)).toEqual(Array(ANGLES.length).fill('handbook/guide.md'));
    expect(hits.map((h) => h.title)).toEqual(Array(ANGLES.length).fill('Guide'));
    expect(hits.map((h) => h.content)).toEqual(EXPECTED_ORDER.map((i) => `section ${i}`));

    // cos(0.2) = 0.98007 is the best alpha can do; beta's rows all score 1. Nothing near 1 came back.
    for (const [rank, hit] of hits.entries()) {
      expect(hit.score).toBeCloseTo(Math.cos(ANGLES[hit.chunkIndex]), 5);
      if (rank > 0) expect(hit.score).toBeLessThan(hits[rank - 1].score);
    }
    expect(Math.max(...hits.map((h) => h.score))).toBeLessThan(0.99);
  });

  it('reports a score that is exactly 1 - the cosine distance PostgreSQL computed', async () => {
    const hits = await searchChunks(database.db, alpha, QUERY, 10);

    const raw = await database.db.execute(sql`
      SELECT chunk_index, (embedding <=> ${vectorLiteral(QUERY)}::vector)::float8 AS distance
      FROM chunks WHERE project_id = ${alpha}`);
    const distances = new Map(raw.rows.map((r) => [(r as { chunk_index: number }).chunk_index, (r as { distance: number }).distance]));

    for (const hit of hits) {
      const distance = distances.get(hit.chunkIndex);
      expect(distance).toBeDefined();
      expect(hit.score).toBeCloseTo(1 - (distance ?? Number.NaN), 12);
    }
  });

  it('honours the limit', async () => {
    const hits = await searchChunks(database.db, alpha, QUERY, 3);
    expect(hits.map((h) => h.chunkIndex)).toEqual(EXPECTED_ORDER.slice(0, 3));
  });

  it('gives the other project its own rows, which are the ones that would have been noticed', async () => {
    const hits = await searchChunks(database.db, beta, QUERY, 10);
    expect(hits).toHaveLength(ANGLES.length);
    for (const hit of hits) expect(hit.score).toBeCloseTo(1, 6);
  });
});
