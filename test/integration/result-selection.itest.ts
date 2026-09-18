import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { documentSources, projects } from '../../src/db/schema.js';
import { type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The half of [ADR-0042](../../../.ssot/ADR.md#adr-0042) that only a real index can answer: that the
 * two filters reach **both** candidate lists, that the per-document cap refills rather than shortens,
 * and that a neighbour is context and never a result.
 *
 * **The fixture is one page that answers the question six times over**, which is the shape the cap
 * exists for: a corpus where a five-result answer is one document's five consecutive chunks.
 *
 * Two properties of it are load-bearing and neither is visible in the assertions. Every chunk carries
 * `Guide` in its breadcrumb, so every chunk is dense-near the question *and* `guide` is in fifteen of
 * fifteen chunks — over ADR-0041's document-frequency threshold, so the lexical half never sees it.
 * `install` is in nine, so it survives, and the chunks that hold it are the lexical list. That is what
 * makes "the filter reached **both** halves" observable: a source whose documents are on both lists,
 * and an assertion that neither list escaped the filter.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const LIVE = 0;

/** Deliberately spelled with an underscore: it is a `LIKE` wildcard, and an operator typing it means the character. */
const HANDBOOK_GUIDE = 'handbook/guides/getting_started.md';
/** The same path with the underscore standing for any character — what an unescaped pattern would also match. */
const HANDBOOK_DECOY = 'handbook/guides/gettingXstarted.md';
const HANDBOOK_OPS = 'handbook/operations/backup.md';
const NOTES = 'notes/scratch.md';

/** Bag of `[a-z]{3,}` runs, L2-normalised: every chunk below shares `install`, so all of them are near. */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
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

const QUESTION = 'guide install';

let database: TestDatabase;
let projectId: string;
let handbookId: string;
let notesId: string;

const search = (request: Partial<Parameters<typeof searchChunks>[1]> = {}): Promise<SearchHit[]> =>
  searchChunks(database.db, {
    projectId,
    generation: LIVE,
    queryEmbedding: stubVector(QUESTION),
    queryText: QUESTION,
    limit: 5,
    ...request,
  });

const files = (hits: readonly SearchHit[]): string[] => hits.map((hit) => hit.file);

async function seed(relativePath: string, sourceId: string, count: number, body: (i: number) => string): Promise<void> {
  const rows: NewChunk[] = Array.from({ length: count }, (_, i) => {
    const headingPath = `Guide > Step ${i}`;
    const content = body(i);
    return { chunkIndex: i, headingPath, content, tokenCount: 20, embedding: stubVector(`${headingPath} ${content}`) };
  });
  await replaceDocument(
    database.db,
    { projectId, sourceId, relativePath, title: relativePath, contentHash: `hash-${relativePath}`, sizeBytes: 1024, indexGeneration: LIVE },
    rows,
  );
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'result_selection');
  await applySchema(database, DIMS);

  const [project] = await database.db.insert(projects).values({ name: 'selection' }).returning({ id: projects.id });
  projectId = project.id;
  const [handbook] = await database.db
    .insert(documentSources)
    .values({ projectId, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });
  const [notes] = await database.db.insert(documentSources).values({ projectId, type: 'local', name: 'notes' }).returning({ id: documentSources.id });
  handbookId = handbook.id;
  notesId = notes.id;

  // The dominant page: short chunks that hold the question's rare term, so it wins both lists.
  await seed(HANDBOOK_GUIDE, handbookId, 6, (i) => `Step ${i}: install the thing${' carefully'.repeat(i)}.`);
  // Two documents that share only the common term, so they are dense-near and lexically silent.
  await seed(HANDBOOK_DECOY, handbookId, 3, (i) => `Note ${i}: rivers, weather and other prose about nothing in particular.`);
  await seed(HANDBOOK_OPS, handbookId, 3, (i) => `Backup ${i}: taking and restoring a snapshot of the database.`);
  // The other source, on both lists, which is what the source filter has to be asserted against.
  await seed(NOTES, notesId, 3, (i) => `Scratch ${i}: a note that mentions install once, among other things.`);
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('the per-document cap', () => {
  it('holds one document to its share and fills the page from the rest', async () => {
    // Not "returns fewer results": the cap refills from the candidates below what it displaced, so an
    // agent that asked for five still gets five — from more than one page.
    const hits = await search({ selection: { maxPerDocument: 2, neighborContext: 0 } });

    expect(hits).toHaveLength(5);
    for (const file of new Set(files(hits))) {
      expect(files(hits).filter((f) => f === file).length).toBeLessThanOrEqual(2);
    }
    expect(new Set(files(hits)).size).toBeGreaterThanOrEqual(3);
  });

  it('is what stands between five results and one page over and over', async () => {
    // The control, and the reason the cap is not a hypothetical: uncapped, this fixture spends four of
    // its five results on consecutive chunks of one document. Asserted as "most of the page is one
    // document" rather than "all of it", because which document takes the fifth slot is a property of
    // the fixture's tie-breaks and not of the cap.
    const uncapped = await search({ limit: 5, selection: { maxPerDocument: 20, neighborContext: 0 } });
    const perDocument = [...new Set(files(uncapped))].map((file) => files(uncapped).filter((f) => f === file).length);

    expect(Math.max(...perDocument)).toBeGreaterThanOrEqual(4);
  });

  it('keeps the best excerpts of each document rather than an arbitrary two', async () => {
    const capped = await search({ limit: 20, selection: { maxPerDocument: 2, neighborContext: 0 } });
    const uncapped = await search({ limit: 20, selection: { maxPerDocument: 20, neighborContext: 0 } });

    for (const file of new Set(files(capped))) {
      const kept = capped.filter((hit) => hit.file === file).map((hit) => hit.chunkIndex);
      const best = uncapped
        .filter((hit) => hit.file === file)
        .slice(0, kept.length)
        .map((hit) => hit.chunkIndex);
      expect(kept).toEqual(best);
    }
  });
});

describe('the source filter', () => {
  it('returns only that source, and it reaches both halves of retrieval', async () => {
    const hits = await search({ limit: 20, sourceId: notesId, selection: { maxPerDocument: 20, neighborContext: 0 } });

    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(files(hits))).toEqual(new Set([NOTES]));
    // Both halves, asserted rather than assumed: a filter applied to one list only would still look
    // like this for a chunk the other list also returned, so the claim is that *every* hit that the
    // lexical half contributed is inside the filter too.
    expect(hits.some((hit) => hit.lexicalRank !== null)).toBe(true);
    expect(hits.some((hit) => hit.denseRank !== null)).toBe(true);
  });

  it('is not the same thing as a path prefix, and a document with no source is not smuggled in', async () => {
    const hits = await search({ limit: 20, sourceId: handbookId, selection: { maxPerDocument: 20, neighborContext: 0 } });
    expect(files(hits)).not.toContain(NOTES);
  });
});

describe('the path prefix filter', () => {
  it('narrows a source to a directory inside it', async () => {
    const hits = await search({ limit: 20, pathPrefix: 'handbook/operations', selection: { maxPerDocument: 20, neighborContext: 0 } });

    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(files(hits))).toEqual(new Set([HANDBOOK_OPS]));
  });

  it('treats an underscore as a character and not as a wildcard', async () => {
    // The reason `escapeLikePattern` exists. Unescaped, `getting_started` also matches
    // `gettingXstarted`, and the operator who typed the real path would never find out.
    const hits = await search({ limit: 20, pathPrefix: 'handbook/guides/getting_started', selection: { maxPerDocument: 20, neighborContext: 0 } });

    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(files(hits))).toEqual(new Set([HANDBOOK_GUIDE]));
  });

  it('combines with the source filter rather than replacing it', async () => {
    const hits = await search({ limit: 20, sourceId: notesId, pathPrefix: 'handbook', selection: { maxPerDocument: 20, neighborContext: 0 } });
    expect(hits).toHaveLength(0);
  });

  it('answers nothing for a prefix no document has, which is an honest empty answer', async () => {
    const hits = await search({ limit: 20, pathPrefix: 'handbook/nothing-here' });
    expect(hits).toHaveLength(0);
  });
});

describe('neighbour context', () => {
  it('carries the chunk before and the chunk after, from the same document', async () => {
    const hits = await search({ limit: 20, pathPrefix: HANDBOOK_GUIDE, selection: { maxPerDocument: 20, neighborContext: 1 } });
    const middle = hits.find((hit) => hit.chunkIndex === 3);

    expect(middle).toBeDefined();
    expect(middle?.contextBefore).toContain('Step 2:');
    expect(middle?.contextAfter).toContain('Step 4:');
  });

  it('has nothing before the first chunk and nothing after the last', async () => {
    const hits = await search({ limit: 20, pathPrefix: HANDBOOK_GUIDE, selection: { maxPerDocument: 20, neighborContext: 1 } });
    const first = hits.find((hit) => hit.chunkIndex === 0);
    const last = hits.find((hit) => hit.chunkIndex === 5);

    expect(first?.contextBefore).toBeNull();
    expect(first?.contextAfter).toContain('Step 1:');
    expect(last?.contextAfter).toBeNull();
  });

  it('is off at zero, and then costs the statement nothing to say so', async () => {
    const hits = await search({ selection: { maxPerDocument: 2, neighborContext: 0 } });
    for (const hit of hits) {
      expect(hit.contextBefore).toBeNull();
      expect(hit.contextAfter).toBeNull();
    }
  });

  it('is context and never a result: it changes no rank, no count and no ordering', async () => {
    // The property that keeps a neighbour from displacing a hit or being counted by the cap. Same
    // question, same page, twice — once with neighbours and once without.
    const withContext = await search({ selection: { maxPerDocument: 2, neighborContext: 1 } });
    const without = await search({ selection: { maxPerDocument: 2, neighborContext: 0 } });

    expect(withContext.map((hit) => `${hit.file}#${hit.chunkIndex}`)).toEqual(without.map((hit) => `${hit.file}#${hit.chunkIndex}`));
    expect(withContext.map((hit) => hit.fusedScore)).toEqual(without.map((hit) => hit.fusedScore));
  });

  it('reaches further when asked, and never past the document it belongs to', async () => {
    const hits = await search({ limit: 20, pathPrefix: HANDBOOK_OPS, selection: { maxPerDocument: 20, neighborContext: 3 } });
    const first = hits.find((hit) => hit.chunkIndex === 0);

    // The document has three chunks, so "three either side" is bounded by the document and not by a
    // count: no part of another page can arrive as this one's context.
    expect(first?.contextAfter).toContain('Backup 1:');
    expect(first?.contextAfter).toContain('Backup 2:');
    expect(first?.contextBefore).toBeNull();
  });
});
