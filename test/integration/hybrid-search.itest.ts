import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { DENSE_CANDIDATES, MAX_SEARCH_LIMIT } from '../../src/config.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { fuseRankLists } from '../../src/services/rrf.js';
import { type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * Hybrid retrieval against a real PostgreSQL ([ADR-0041](../../.ssot/ADR.md#adr-0041)): the lexical
 * column, the fused statement, and what a project that has been migrated but not yet backfilled
 * actually experiences.
 *
 * **The embedding stub here is blind to identifiers and fluent in synonyms, and that is the fixture's
 * whole design.** It hashes runs of three letters or more, ignores everything else, and folds
 * `meaning` onto `mean` before hashing. That is the difference between the two halves of retrieval
 * stated as code: the dense side reaches a paragraph that never uses the question's words, and cannot
 * reach a string it has no token for. A stub without either property would let this file pass against
 * a dense-only implementation, which is the one outcome it must not have.
 *
 * So the filler chunks are dense-near the question and share no lexeme with it, and the one chunk that
 * answers it is the other way round. The corpus is sized past `DENSE_CANDIDATES` so that the answering
 * chunk is genuinely off the dense candidate list rather than merely low on it.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const LIVE = 0;

/** Comfortably past the dense cut, so the identifier chunk cannot be on the dense list at all. */
const FILLER_CHUNKS = DENSE_CANDIDATES + 12;

const ERROR_CODES = 'handbook/error-codes.md';
const FILLER = 'handbook/filler.md';

/** The one thing this stub knows that PostgreSQL's `simple` configuration does not. */
const SYNONYMS: Record<string, string> = { meaning: 'mean', means: 'mean', signifies: 'mean' };

/**
 * Bag of words over `[a-z]{3,}` runs, synonym-folded and L2-normalised. Digits, hyphens and
 * two-letter tokens never reach the hash, so `ZX-4417` contributes nothing at all to a vector.
 */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const raw of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    const token = SYNONYMS[raw] ?? raw;
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  // pgvector's cosine distance is undefined for a zero vector, and a chunk of pure identifiers would
  // produce one. `v[0] = 1` puts it somewhere definite rather than somewhere NaN.
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

/**
 * `mean` reaches every filler chunk through `meaning`, so they are all dense-near it; `what` and
 * `does` reach none of them, and `ZX-4417` reaches only the chunk that answers it.
 */
const QUESTION = 'What does ZX-4417 mean?';

/** The one chunk that answers it, and the shape of the passage a dense retriever cannot reach. */
const ANSWER = 'ZX-4417 — the receiver answered a permanent status, so the delivery was abandoned with its budget unspent.';

let database: TestDatabase;
let projectId: string;

const identify = (hit: SearchHit): string => `${hit.file}#${hit.chunkIndex}`;

/**
 * Retrieval, not selection. Every assertion in this file is about which rows come back and in what
 * order, over a fixture that is one document — so ADR-0042's per-document cap, which is on by
 * default, would hold every page here to two rows and the file would be measuring the cap instead.
 * Stated explicitly rather than left to the default, for the same reason the scan settings are.
 */
const WHOLE_PAGE = { maxPerDocument: MAX_SEARCH_LIMIT, neighborContext: 0 };

const search = (queryText: string, limit = 5): Promise<SearchHit[]> =>
  searchChunks(database.db, { projectId, generation: LIVE, queryEmbedding: stubVector(queryText), queryText, limit, selection: WHOLE_PAGE });

/**
 * The dense half alone, asked of the database directly — the ordering this change has to beat, and the
 * one it has to fall back to. No tie-break, because the fused statement has none either and the
 * fixture is built so that no two chunks are the same distance from anything asked of it.
 */
async function denseOnly(queryText: string, limit = 5): Promise<string[]> {
  const result = await database.db.execute(sql`
    select doc.relative_path || '#' || c.chunk_index as ident
    from chunks c join documents doc on doc.id = c.document_id
    where c.project_id = ${projectId} and c.index_generation = ${LIVE}
    order by c.embedding <=> ${JSON.stringify(stubVector(queryText))}::vector
    limit ${limit}`);
  return result.rows.map((row) => (row as { ident: string }).ident);
}

async function candidateIds(queryText: string): Promise<{ dense: string[]; lexical: string[] }> {
  const dense = await database.db.execute(sql`
    select c.id::text as id from chunks c
    where c.project_id = ${projectId} and c.index_generation = ${LIVE}
    order by c.embedding <=> ${JSON.stringify(stubVector(queryText))}::vector
    limit ${DENSE_CANDIDATES}`);
  const lexical = await database.db.execute(sql`
    with question as (
      select string_agg(quote_literal(lexeme), ' | ')::tsquery as q from unnest(to_tsvector('simple', ${queryText}))
    )
    select c.id::text as id from chunks c, question
    where c.project_id = ${projectId} and c.index_generation = ${LIVE} and c.content_tsv @@ question.q
    order by ts_rank_cd(c.content_tsv, question.q) desc, c.id
    limit ${DENSE_CANDIDATES}`);
  return {
    dense: dense.rows.map((row) => (row as { id: string }).id),
    lexical: lexical.rows.map((row) => (row as { id: string }).id),
  };
}

async function identsById(ids: readonly string[]): Promise<string[]> {
  const result = await database.db.execute(sql`
    select c.id::text as id, doc.relative_path || '#' || c.chunk_index as ident
    from chunks c join documents doc on doc.id = c.document_id
    where c.project_id = ${projectId}`);
  const byId = new Map(result.rows.map((row) => [(row as { id: string }).id, (row as { ident: string }).ident]));
  return ids.map((id) => byId.get(id) ?? id);
}

async function nullTsvCount(): Promise<number> {
  const result = await database.db.execute(sql`select count(*)::int as n from chunks where project_id = ${projectId} and content_tsv is null`);
  return (result.rows[0] as { n: number }).n;
}

/** Puts the project back into the state `beforeAll` left it in; three cases below move it. */
async function refillTsv(): Promise<void> {
  await database.db.execute(sql`
    update chunks set content_tsv = to_tsvector('simple', heading_path || ' ' || content) where project_id = ${projectId}`);
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'hybrid_search');
  await applySchema(database, DIMS);

  const [project] = await database.db.insert(projects).values({ name: 'hybrid' }).returning({ id: projects.id });
  projectId = project.id;
  const [source] = await database.db
    .insert(documentSources)
    .values({ projectId, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });

  const chunk = (chunkIndex: number, headingPath: string, content: string): NewChunk => ({
    chunkIndex,
    headingPath,
    content,
    tokenCount: 24,
    embedding: stubVector(`${headingPath} ${content}`),
  });

  // Two properties, both deliberate. `meaning` is what makes these dense-near the question and
  // lexically invisible to it. The repeated `delivery` is what makes every filler vector a different
  // length, so no two chunks sit at an identical distance from any query — without it all sixty-two
  // are the same vector, the dense candidate list is cut at fifty arbitrarily, and this file asserts
  // an ordering the database never promised.
  const filler = Array.from({ length: FILLER_CHUNKS }, (_, i) =>
    chunk(i, `Filler > Section ${i}`, `Paragraph about${' delivery'.repeat(i + 1)}, and a reader may reasonably wonder about its meaning.`),
  );

  await replaceDocument(
    database.db,
    {
      projectId,
      sourceId: source.id,
      relativePath: FILLER,
      title: 'Filler',
      contentHash: 'hash-filler',
      sizeBytes: 4096,
      indexGeneration: LIVE,
    },
    filler,
  );
  await replaceDocument(
    database.db,
    {
      projectId,
      sourceId: source.id,
      relativePath: ERROR_CODES,
      title: 'Error codes',
      contentHash: 'hash-codes',
      sizeBytes: 256,
      indexGeneration: LIVE,
    },
    [chunk(0, 'Error codes > 4xxx', ANSWER)],
  );
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('the identifier query dense-only gets wrong', () => {
  it('is wrong dense-only, and not merely ranked low, which is what everything below rests on', async () => {
    // Without this the file passes against any implementation that looks correct, the previous one
    // included. The identifier is not a word the stub has, and the answering chunk holds none of the
    // question's other words — so it is not in the dense candidate list at all.
    const { dense } = await candidateIds(QUESTION);
    const idents = await identsById(dense);

    expect(dense).toHaveLength(DENSE_CANDIDATES);
    expect(idents).not.toContain(`${ERROR_CODES}#0`);
  });

  it('is on the first page of the fused search, put there by the half that can see a string', async () => {
    const hits = await search(QUESTION);
    const answer = hits.find((hit) => identify(hit) === `${ERROR_CODES}#0`);

    expect(answer).toBeDefined();
    expect(answer?.lexicalRank).toBe(1);
    expect(answer?.denseRank).toBeNull();
    expect(answer?.content).toContain('ZX-4417');
  });

  it('arrives at rank 2, which is the arithmetic and worth stating rather than discovering', async () => {
    // A chunk that is first on one list and absent from the other scores exactly what the *other*
    // list's first place scores — 1/61 each — and the tie goes to the dense half. So the best a
    // lexical-only answer can do is second, and RRF is doing what it promises rather than what a
    // weighted sum would have been tuned into doing.
    const hits = await search(QUESTION);

    expect(identify(hits[1])).toBe(`${ERROR_CODES}#0`);
    expect(hits[0].denseRank).toBe(1);
    expect(hits[0].fusedScore).toBeCloseTo(hits[1].fusedScore, 12);
  });

  it('says which half found each hit, so the ordering can be explained rather than trusted', async () => {
    const hits = await search(QUESTION);

    for (const hit of hits) {
      // A chunk on neither list cannot be in the fused result at all.
      expect(hit.denseRank === null && hit.lexicalRank === null).toBe(false);
      expect(hit.fusedScore).toBeGreaterThan(0);
    }
    expect(hits.map((hit) => hit.fusedScore)).toEqual([...hits.map((hit) => hit.fusedScore)].sort((a, b) => b - a));
  });

  it('still reports a cosine similarity for a chunk only the lexical half returned', async () => {
    const hits = await search(QUESTION);
    const lexicalOnly = hits.filter((hit) => hit.denseRank === null);

    expect(lexicalOnly.length).toBeGreaterThan(0);
    for (const hit of lexicalOnly) {
      // Display, not ordering. It has to be a real number rather than the null that `formatHits` and
      // the dashboard would both then have to learn about (API.md §1).
      expect(Number.isFinite(hit.score)).toBe(true);
      expect(hit.score).toBeGreaterThanOrEqual(-1);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('the ordering PostgreSQL produces', () => {
  it('is the one `fuseRankLists` specifies for the same two lists', async () => {
    // The SQL and the reference implementation are two statements of one rule, and this is what keeps
    // them equal. The candidate lists are read out of the database the way the fused statement builds
    // them, fused in TypeScript, and compared with what the fused statement returned.
    const { dense, lexical } = await candidateIds(QUESTION);
    const expected = fuseRankLists(dense, lexical).slice(0, 5);
    const hits = await search(QUESTION, 5);

    expect(hits.map(identify)).toEqual(await identsById(expected.map((row) => row.id)));
    expect(hits.map((hit) => hit.denseRank)).toEqual(expected.map((row) => row.denseRank));
    expect(hits.map((hit) => hit.lexicalRank)).toEqual(expected.map((row) => row.lexicalRank));
    for (const [i, hit] of hits.entries()) expect(hit.fusedScore).toBeCloseTo(expected[i].fusedScore, 12);
  });

  it('falls back to the dense ordering for a question with no lexeme in common', async () => {
    // `mean` is a word the stub understands and a lexeme no chunk holds — the filler says `meaning`,
    // which `simple` does not stem. So the dense half answers in full and the lexical half not at all.
    const query = 'mean';
    const hits = await search(query);

    expect(hits.map(identify)).toEqual(await denseOnly(query, 5));
    for (const hit of hits) expect(hit.lexicalRank).toBeNull();
  });

  it('asks the lexical half nothing at all when the question has no lexemes', async () => {
    // `string_agg` over nothing is NULL and `content_tsv @@ NULL` is not true, so this is an empty
    // lexical list rather than the error a bare `''::tsquery` cast would have been.
    const hits = await search('?!.');

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.lexicalRank).toBeNull();
  });
});

describe('a project that has been migrated but not re-indexed', () => {
  afterAll(refillTsv);

  it('is dense-only for as long as nothing has rewritten its chunks', async () => {
    // What `ALTER TABLE … ADD COLUMN` leaves behind, reproduced exactly: NULL in every row written
    // before the column existed.
    await database.db.execute(sql`update chunks set content_tsv = null where project_id = ${projectId}`);
    const hits = await search(QUESTION);

    expect(hits.map(identify)).toEqual(await denseOnly(QUESTION, 5));
    for (const hit of hits) expect(hit.lexicalRank).toBeNull();
  });

  it('is never worse than dense-only while it is half filled', async () => {
    // The state a project is actually in mid-upgrade: one document re-indexed, the rest not. The claim
    // asserted is the weak one and the honest one — everything the dense half would have returned is
    // still on the page, and the re-indexed document can only add to it.
    await database.db.execute(sql`
      update chunks c set content_tsv = to_tsvector('simple', c.heading_path || ' ' || c.content)
      from documents doc where doc.id = c.document_id and doc.relative_path = ${ERROR_CODES}`);

    const hits = await search(QUESTION, 5);
    const dense = await denseOnly(QUESTION, 4);

    for (const ident of dense) expect(hits.map(identify)).toContain(ident);
    expect(identify(hits[1])).toBe(`${ERROR_CODES}#0`);
    expect(hits[1].lexicalRank).toBe(1);
  });

  it('is filled in by the next start, because an incremental run would skip every unchanged file', async () => {
    // `bootstrapDatabase` runs the batched backfill, which is why an upgrade is not followed by a
    // forced re-index — and a forced re-index would re-embed a whole corpus to produce a column that
    // is a pure function of text the database already holds.
    await database.db.execute(sql`update chunks set content_tsv = null where project_id = ${projectId}`);
    expect(await nullTsvCount()).toBe(FILLER_CHUNKS + 1);

    await applySchema(database, DIMS);

    expect(await nullTsvCount()).toBe(0);
    expect(identify((await search(QUESTION))[1])).toBe(`${ERROR_CODES}#0`);
  });

  it('runs that backfill at every start without rewriting a row', async () => {
    const version = async (): Promise<string> => {
      const result = await database.db.execute(sql`select max(xmin::text::bigint) as v from chunks where project_id = ${projectId}`);
      return String((result.rows[0] as { v: string | number }).v);
    };

    const before = await version();
    await applySchema(database, DIMS);

    // The `IS NULL` guard is what makes the steady-state cost one query that matches nothing. Without
    // it every start would rewrite every chunk on the instance, and this row version would move.
    expect(await version()).toBe(before);
  });
});
