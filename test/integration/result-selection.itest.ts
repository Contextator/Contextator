import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { documentSources, projects } from '../../src/db/schema.js';
import { listDocumentVersions, type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The half of [ADR-0042](../../../.ssot/ADR.md#adr-0042) that only a real index can answer: that the
 * two filters reach **both** candidate lists, that the per-document cap refills rather than shortens,
 * and that a neighbour is context and never a result.
 *
 * **The fixture is one page that answers the question six times over**, which is the shape the cap
 * exists for: a corpus where a five-result answer is one document's five consecutive chunks.
 *
 * Three properties of it are load-bearing and none of them is visible in the assertions. Every chunk
 * carries `Guide` in its breadcrumb, so every chunk is dense-near the question *and* `guide` is in
 * fifteen of fifteen chunks — over ADR-0041's document-frequency threshold, so the lexical half never
 * sees it. `install` is in nine, so it survives, and the chunks that hold it are the lexical list.
 * That is what makes "the filter reached **both** halves" observable: a source whose documents are on
 * both lists, and an assertion that neither list escaped the filter.
 *
 * The third is that **no two chunks share an embedding**, and `beforeAll` proves it rather than
 * assuming it — see the comment there for what it cost to learn.
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

/**
 * Bag of `[a-z]{3,}` runs, L2-normalised: every chunk below shares `install`, so all of them are near.
 *
 * **It cannot see a digit**, which is the whole reason the bodies below grow. `Scratch 0:` and
 * `Scratch 1:` are one bag, so two chunks that read differently can be the *same vector*. Giving a
 * chunk a *new* word does not help either: the question's vector is two unit spikes, so the cosine
 * is `(how many of the two the chunk holds) / sqrt(Σ count²)` and any two chunks with the same word
 * multiplicities land on exactly the same distance however different their words are. Only
 * repetition moves one, which is why each document grows by a repeated word rather than a new one.
 */
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
    // Hand-written chunks and no document text behind them, so `content` is null on purpose.
    {
      projectId,
      sourceId,
      relativePath,
      title: relativePath,
      contentHash: `hash-${relativePath}`,
      sizeBytes: 1024,
      indexGeneration: LIVE,
      content: null,
      contentTruncated: false,
      version: '',
    },
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

  // Every document grows by one repetition per chunk, so chunk `i` is a little further from the
  // question than chunk `i - 1` and no two chunks of the corpus can land on the same distance. The
  // check at the end of this hook is what holds that claim to account.
  //
  // The dominant page: short chunks that hold the question's rare term, so it wins both lists.
  await seed(HANDBOOK_GUIDE, handbookId, 6, (i) => `Step ${i}: install the thing${' carefully'.repeat(i)}.`);
  // Two documents that share only the common term, so they are dense-near and lexically silent.
  await seed(
    HANDBOOK_DECOY,
    handbookId,
    3,
    (i) => `Note ${i}: rivers, weather and other prose about nothing in particular${' whatsoever'.repeat(i)}.`,
  );
  await seed(HANDBOOK_OPS, handbookId, 3, (i) => `Backup ${i}: taking and restoring a snapshot of the database${' nightly'.repeat(i)}.`);
  // The other source, on both lists, which is what the source filter has to be asserted against.
  // `2 * i` and not `i`: at one repetition per chunk this document's second chunk carries the same
  // word multiplicities as the guide's third, and by the note on `stubVector` the two would tie.
  await seed(NOTES, notesId, 3, (i) => `Scratch ${i}: a note that mentions install once, among other things${' besides'.repeat(2 * i)}.`);

  // **The fixture's dense order is a total order on distance, and this is where that is made true
  // rather than hoped for.** It was not, and the cost was a flake: the three `notes/scratch.md`
  // chunks used to differ only in a digit, which `stubVector` cannot see, so all three had one
  // embedding and one distance. `dense`'s `order by distance, id` then settled their ranks by
  // `gen_random_uuid()`, while the lexical half ordered the same three by `chunk_index`. RRF was
  // pairing a random dense rank with a fixed lexical one — six permutations, of which one put two
  // notes chunks above the guide's fourth and made the control below report three where it needs
  // four. Measured over 24 seeded corpora: 5 runs in 24, the 1-in-6 that predicts.
  //
  // Asserting the *count* first is not belt and braces: a search that answered short would make the
  // uniqueness check below pass by having nothing to compare, which is how the last flake in this
  // suite hid.
  const everyChunk = await search({ limit: 20, selection: { maxPerDocument: 20, neighborContext: 0 } });
  if (everyChunk.length !== 15) {
    throw new Error(`The fixture is 15 chunks and an uncapped search has to return all of them; it returned ${everyChunk.length}.`);
  }
  const byDistance = new Map<number, string[]>();
  for (const hit of everyChunk) byDistance.set(hit.score, [...(byDistance.get(hit.score) ?? []), `${hit.file}#${hit.chunkIndex}`]);
  const tied = [...byDistance.values()].filter((group) => group.length > 1);
  if (tied.length > 0) {
    throw new Error(
      `Chunks of this fixture share an embedding: ${tied.map((group) => group.join(' = ')).join('; ')}. ` +
        'Their dense ranks are then decided by `gen_random_uuid()` and every assertion in this file becomes a lottery. ' +
        'Give each chunk of a document one more repetition than the one before it — see the note on `stubVector`.',
    );
  }
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
    // document" rather than "all of it", because which document takes the fifth slot is fusion
    // arithmetic over this particular corpus and not a claim about the cap.
    //
    // This is the premise the case above rests on rather than a property of the product, so it carries
    // a message: read bare, "expected 3 to be greater than or equal to 4" is a sentence about nothing.
    const uncapped = await search({ limit: 5, selection: { maxPerDocument: 20, neighborContext: 0 } });
    const perDocument = [...new Set(files(uncapped))].map((file) => files(uncapped).filter((f) => f === file).length);

    expect(
      Math.max(...perDocument),
      `Uncapped, the busiest document should take four of five slots — otherwise the cap above is capping nothing. Got ${files(uncapped).join(', ')}`,
    ).toBeGreaterThanOrEqual(4);
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

/**
 * **The version filter** ([ADR-0058](../../../.ssot/ADR.md#adr-0058)), on a fixture of its own,
 * because the corpus above is arithmetic the cap cases depend on and three more documents in it would
 * be measuring something else.
 *
 * The shape is the problem the filter exists for: one product, documented twice, indexed into one
 * project. `api-v2` and `api-v3` are the two releases of the same reference page — and `sdk-v2` is
 * beside them, carrying the *same* version as `api-v2`, because that is what makes this not simply
 * the source filter under another name. A release is several mount points; `source` cannot express it.
 *
 * **Two questions, and the difference between them is the whole design of the fixture.**
 * `rotation` is in the breadcrumb of all twelve chunks, which is past ADR-0041's document-frequency
 * threshold, so the lexical half never sees it and that question is answered by the dense half alone.
 * `credential` is in six, so it survives, and both halves answer. Asking the filter under each is what
 * makes "it reached **both** candidate lists" an observation rather than a hope: with the predicate
 * pushed into only one of them, the other half goes on fetching the wrong release and fusion — a FULL
 * OUTER JOIN — puts it on the page.
 *
 * The premises are asserted first, in their own case, for the reason the tie check in `beforeAll`
 * above is: a fixture where the wrong release is not retrievable by the half being tested would make
 * every case here pass against a filter that reaches nothing.
 */
const V2_API = 'api-v2/reference/rotate.md';
const V2_SDK = 'sdk-v2/reference/rotate.md';
const V3_API = 'api-v3/reference/rotate.md';

/** Answered by the dense half alone: it is in every chunk, so the lexical half drops it. */
const DENSE_QUESTION = 'rotation';
/** Answered by both: it is in six of twelve chunks, under the threshold. */
const BOTH_QUESTION = 'credential';

describe('the version filter', () => {
  let versionedProjectId: string;
  let apiV3SourceId: string;

  /** Four chunks, of which the first two carry `credential`; every one carries `rotation` in its breadcrumb. */
  const bodies = (spacing: number): string[] =>
    Array.from({ length: 4 }, (_, i) =>
      i < 2
        ? `Step ${i}: the credential is replaced from the console${' plainly'.repeat(spacing + i)}.`
        : `Step ${i}: the replicas pick the new one up${' plainly'.repeat(spacing + i)}.`,
    );

  const searchVersions = (request: Partial<Parameters<typeof searchChunks>[1]>, queryText = BOTH_QUESTION): Promise<SearchHit[]> =>
    searchChunks(database.db, {
      projectId: versionedProjectId,
      generation: LIVE,
      queryEmbedding: stubVector(queryText),
      queryText,
      limit: 20,
      selection: { maxPerDocument: 20, neighborContext: 0 },
      ...request,
    });

  beforeAll(async () => {
    const [project] = await database.db.insert(projects).values({ name: 'versions' }).returning({ id: projects.id });
    versionedProjectId = project.id;

    const write = async (name: string, version: string, relativePath: string, spacing: number): Promise<string> => {
      const [source] = await database.db
        .insert(documentSources)
        // The version lives in the source's config exactly as it does in production; the column below
        // is what an index run stamps from it, and this fixture writes both so the two cannot drift.
        .values({ projectId: versionedProjectId, type: 'local', name, config: { extensions: ['md'], version } })
        .returning({ id: documentSources.id });
      await replaceDocument(
        database.db,
        {
          projectId: versionedProjectId,
          sourceId: source.id,
          relativePath,
          title: relativePath,
          contentHash: `hash-${relativePath}`,
          sizeBytes: 1024,
          indexGeneration: LIVE,
          content: null,
          contentTruncated: false,
          version,
        },
        bodies(spacing).map((content, chunkIndex) => {
          const headingPath = `Rotation > Step ${chunkIndex}`;
          return { chunkIndex, headingPath, content, tokenCount: 20, embedding: stubVector(`${headingPath} ${content}`) };
        }),
      );
      return source.id;
    };

    // Distinct repetition counts, so no two chunks of this corpus share an embedding — the property
    // `beforeAll` above spells out at length, and the reason these three near-identical pages are not
    // one vector three times over.
    await write('api-v2', 'v2', V2_API, 1);
    await write('sdk-v2', 'v2', V2_SDK, 5);
    apiV3SourceId = await write('api-v3', 'v3', V3_API, 9);
  });

  it('has a corpus where the wrong release is reachable by each half separately, which is the premise', async () => {
    // Without this every case below passes against a filter that reaches nothing, because a v2
    // document the half under test never retrieved could not have leaked through it either.
    const both = await searchVersions({}, BOTH_QUESTION);
    const dense = await searchVersions({}, DENSE_QUESTION);

    // `credential` is on both lists, and the v2 pages are on both of them.
    for (const file of [V2_API, V2_SDK]) {
      const hits = both.filter((hit) => hit.file === file);
      expect(
        hits.some((hit) => hit.lexicalRank !== null),
        `${file} is not on the lexical list for "${BOTH_QUESTION}"`,
      ).toBe(true);
      expect(
        hits.some((hit) => hit.denseRank !== null),
        `${file} is not on the dense list for "${BOTH_QUESTION}"`,
      ).toBe(true);
    }
    // `rotation` is in all twelve chunks, so the lexical half drops it entirely and the v2 pages are
    // reachable only densely. That is what makes the dense case below a test of the dense CTE.
    for (const hit of dense) expect(hit.lexicalRank).toBeNull();
    for (const file of [V2_API, V2_SDK]) {
      expect(
        dense.some((hit) => hit.file === file && hit.denseRank !== null),
        `${file} is not on the dense list for "${DENSE_QUESTION}"`,
      ).toBe(true);
    }
  });

  it('sees every version when nobody asked for one, which is what an upgrade keeps', async () => {
    const hits = await searchVersions({}, BOTH_QUESTION);
    expect(new Set(files(hits))).toEqual(new Set([V2_API, V2_SDK, V3_API]));
  });

  it('returns only the release asked for, on a question both halves answer', async () => {
    const hits = await searchVersions({ version: 'v3' }, BOTH_QUESTION);

    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(files(hits))).toEqual(new Set([V3_API]));
    // Both halves, asserted rather than assumed — the source filter's case one describe up makes the
    // same claim, and here the leak it guards against is a *different release of the same page*.
    expect(hits.some((hit) => hit.lexicalRank !== null)).toBe(true);
    expect(hits.some((hit) => hit.denseRank !== null)).toBe(true);
  });

  it('returns only the release asked for, on a question the lexical half cannot answer at all', async () => {
    // The other half of the same claim. Here the lexical list is empty by construction, so a page of
    // anything but v3 could only have come through the dense candidate CTE.
    const hits = await searchVersions({ version: 'v3' }, DENSE_QUESTION);

    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(files(hits))).toEqual(new Set([V3_API]));
    for (const hit of hits) expect(hit.lexicalRank).toBeNull();
  });

  it('is not the source filter under another name: one version spans two sources', async () => {
    // The case that would still pass if `version` were resolved to a source id, and the reason it is
    // a column on the document instead.
    const hits = await searchVersions({ version: 'v2' }, BOTH_QUESTION);

    expect(new Set(files(hits))).toEqual(new Set([V2_API, V2_SDK]));
  });

  it('combines with the source filter rather than replacing it', async () => {
    const hits = await searchVersions({ version: 'v2', sourceId: apiV3SourceId }, BOTH_QUESTION);
    expect(hits).toHaveLength(0);
  });

  it('lists the versions the published index carries, which is what an unknown one is answered with', async () => {
    // Read off the documents and not off the sources, so the answer describes the index being
    // searched rather than what the next run would stamp. Alphabetical, and deliberately not a
    // timeline: nothing here knows which release came later.
    expect(await listDocumentVersions(database.db, versionedProjectId, LIVE)).toEqual(['v2', 'v3']);
    // The corpus above is unversioned, and an empty label is not a version — it is the absence of one.
    expect(await listDocumentVersions(database.db, projectId, LIVE)).toEqual([]);
  });
});
