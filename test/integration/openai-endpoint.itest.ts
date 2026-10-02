import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import { createEmbeddingProvider, type EmbeddingProvider } from '../../src/services/embeddings/index.js';
import { searchProject } from '../../src/services/search.js';
import { type NewChunk, replaceDocument, storedDocumentContent } from '../../src/services/vector-store.js';
import { type OpenAIStub, startOpenAIStub } from '../support/openai-stub.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * A self-hosted OpenAI-compatible endpoint, end to end: configuration → provider → HTTP → PostgreSQL →
 * search. The provider is built by `createEmbeddingProvider` from a parsed environment, exactly as the
 * server builds it, so the precedence of `EMBEDDING_BASE_URL` and the prefixes are exercised on the path
 * production takes.
 *
 * The second half is the re-index guard (ADR-0007): the same model name served from another host is a
 * different id, and a project indexed against the first endpoint refuses a search from the second
 * instead of comparing vectors that were never in the same space.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

const GUIDE = `# Delivery guide

Introduction to the delivery pipeline and what it is for.

## Install

Install the package from the registry before anything else.

## Tuning

Set the worker count to the number of cores the host can spare for delivery.
`;

const QUERY = 'how many cores can the host spare for the delivery workers';

let database: TestDatabase;
let db: Db;
let stub: OpenAIStub;
let otherStub: OpenAIStub;
let embeddings: EmbeddingProvider;
let projectId: string;

/** The environment an operator running Ollama (or vLLM, TEI, LM Studio) would write. */
const providerFor = (endpoint: string, extra: Record<string, string> = {}) =>
  createEmbeddingProvider(
    loadConfig({
      DATABASE_URL: database.url,
      SECRET_KEY: '0'.repeat(64),
      EMBEDDING_PROVIDER: 'openai',
      OPENAI_EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_DIMENSIONS: String(DIMS),
      EMBEDDING_BASE_URL: endpoint,
      EMBEDDING_QUERY_PREFIX: 'search_query: ',
      EMBEDDING_PASSAGE_PREFIX: 'search_document: ',
      ...extra,
    }),
    silentLogger,
  );

/** Indexes `GUIDE` through `provider` — the vectors come back over HTTP — and stamps its id on the project. */
async function seedProject(name: string, provider: EmbeddingProvider): Promise<string> {
  const [project] = await db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  const relativePath = 'handbook/delivery.md';
  const { title, chunks } = chunkMarkdown(GUIDE, relativePath, { maxTokens: 96, overlapTokens: 24, countTokens: estimateTokens });
  const vectors = await provider.embedPassages(chunks.map((c) => embeddingText(c)));
  const rows: NewChunk[] = chunks.map((c, i) => ({
    chunkIndex: c.index,
    headingPath: c.headingPath,
    content: c.content,
    tokenCount: c.tokenCount,
    embedding: vectors[i],
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
      indexGeneration: 0,
      version: '',
      ...storedDocumentContent(GUIDE, 1024 * 1024),
    },
    rows,
  );
  await db
    .update(projects)
    .set({ chunkCount: rows.length, documentCount: 1, embeddingModel: provider.id, lastIndexedAt: new Date() })
    .where(eq(projects.id, project.id));
  return project.id;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'openai_endpoint');
  await applySchema(database, DIMS);
  db = database.db;
  stub = await startOpenAIStub({ dims: DIMS });
  otherStub = await startOpenAIStub({ dims: DIMS });
  embeddings = providerFor(stub.baseURL);
  projectId = await seedProject('handbook', embeddings);
}, 180_000);

afterAll(async () => {
  await stub?.close();
  await otherStub?.close();
  if (database) await dropTestDatabase(baseUrl, database);
});

describe('indexing and searching through an OpenAI-compatible endpoint', () => {
  it('sends the passages to the configured endpoint, with the passage prefix and without `dimensions`', () => {
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      expect(request.path).toBe('/v1/embeddings');
      expect(request.headers.authorization).toBeUndefined();
      expect(request.body.dimensions).toBeUndefined();
      expect(request.body.encoding_format).toBe('float');
    }
    expect(stub.inputs().length).toBeGreaterThan(0);
    expect(stub.inputs().every((input) => input.startsWith('search_document: '))).toBe(true);
    expect(otherStub.requests).toHaveLength(0);
  });

  it('stamps an id that names the endpoint', async () => {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    expect(project.embeddingModel).toBe(`openai:nomic-embed-text:${DIMS}@127.0.0.1:${stub.port}:"search_query: "+"search_document: "`);
  });

  it('answers a search with hits, the query embedded with the query prefix', async () => {
    const before = stub.requests.length;
    const outcome = await searchProject({ db, embeddings }, { projectId, query: QUERY, limit: 5 });
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits[0].content).toContain('cores');
    const queryRequests = stub.requests.slice(before);
    expect(queryRequests).toHaveLength(1);
    expect(queryRequests[0].body.input).toEqual([`search_query: ${QUERY}`]);
  });

  it('sends `dimensions` when the operator asks for it', async () => {
    const before = stub.requests.length;
    await providerFor(stub.baseURL, { EMBEDDING_REQUEST_DIMENSIONS: 'always' }).embedQuery('x');
    expect(stub.requests[before].body.dimensions).toBe(DIMS);
  });

  it('prefers EMBEDDING_BASE_URL over the legacy OPENAI_BASE_URL', async () => {
    const before = { stub: stub.requests.length, other: otherStub.requests.length };
    await providerFor(stub.baseURL, { OPENAI_BASE_URL: otherStub.baseURL }).embedQuery('x');
    expect(stub.requests.length).toBe(before.stub + 1);
    expect(otherStub.requests.length).toBe(before.other);
  });
});

describe('the re-index guard when the endpoint changes', () => {
  it('refuses a search from another host serving the same model name, before embedding anything', async () => {
    const moved = providerFor(otherStub.baseURL);
    expect(moved.model).toBe(embeddings.model);
    expect(moved.dimensions).toBe(embeddings.dimensions);
    expect(moved.id).not.toBe(embeddings.id);

    const outcome = await searchProject({ db, embeddings: moved }, { projectId, query: QUERY, limit: 5 });
    expect(outcome.status).toBe('model_mismatch');
    if (outcome.status !== 'model_mismatch') return;
    expect(outcome.indexedWith).toBe(embeddings.id);
    expect(outcome.serverUses).toBe(moved.id);
    expect(otherStub.requests.filter((r) => JSON.stringify(r.body.input).includes(QUERY))).toHaveLength(0);
  });

  it('keeps the pre-0.2.1 id for an installation that reaches the endpoint through the legacy name', async () => {
    const legacy = createEmbeddingProvider(
      loadConfig({
        DATABASE_URL: database.url,
        SECRET_KEY: '0'.repeat(64),
        EMBEDDING_PROVIDER: 'openai',
        OPENAI_EMBEDDING_MODEL: 'nomic-embed-text',
        EMBEDDING_DIMENSIONS: String(DIMS),
        OPENAI_BASE_URL: stub.baseURL,
        EMBEDDING_QUERY_PREFIX: 'search_query: ',
        EMBEDDING_PASSAGE_PREFIX: 'search_document: ',
      }),
      silentLogger,
    );
    // No host: the id an installation that set OPENAI_BASE_URL before 0.2.1 already stamped on its projects.
    expect(legacy.id).toBe(`openai:nomic-embed-text:${DIMS}:"search_query: "+"search_document: "`);

    const legacyProjectId = await seedProject('legacy-handbook', legacy);
    const before = stub.requests.length;
    const outcome = await searchProject({ db, embeddings: legacy }, { projectId: legacyProjectId, query: QUERY, limit: 5 });
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(stub.requests.slice(before)).toHaveLength(1);

    // Moving the same URL to EMBEDDING_BASE_URL is the opt-in that changes the id: one re-index.
    const switched = await searchProject({ db, embeddings }, { projectId: legacyProjectId, query: QUERY, limit: 5 });
    expect(switched.status).toBe('model_mismatch');
    const unswitched = await searchProject({ db, embeddings: legacy }, { projectId, query: QUERY, limit: 5 });
    expect(unswitched.status).toBe('model_mismatch');
  });
});
