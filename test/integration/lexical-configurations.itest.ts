import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { DENSE_CANDIDATES, MAX_SEARCH_LIMIT } from '../../src/config.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * **Two text search configurations in one project, and one search that reaches both**
 * ([ADR-0064](../../.ssot/ADR.md#adr-0064)).
 *
 * This is the case ADR-0041 could not answer and said so: the query side was the constant `simple`,
 * so a source that named a language was indexed in a configuration no question ever spoke and
 * contributed nothing to the lexical half at all. It is only observable against a real PostgreSQL,
 * because the thing being tested *is* PostgreSQL's Snowball stemmer.
 *
 * **The embedding stub is a surface bag of words, and that is the fixture's whole design.** It hashes
 * runs of three letters or more exactly as they are written, so "anahtarı" and "anahtarını" are two
 * unrelated tokens to it — which is precisely how `simple` sees them too. A stub that folded Turkish
 * morphology would let every case below pass against a dense-only implementation, which is the one
 * outcome this file must not have. The chunk that answers the Turkish question is therefore
 * unreachable by the dense half and by `simple`, and reachable only by the Turkish stemmer.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const LIVE = 0;

/** Comfortably past the dense cut, so neither answering chunk can be on the dense candidate list. */
const FILLER_CHUNKS = DENSE_CANDIDATES + 12;

const TR_MANUAL = 'elkitabi/kimlik-dogrulama.md';
const TR_FILLER = 'elkitabi/genel.md';
const EN_CODES = 'handbook/error-codes.md';

/**
 * Retrieval, not selection: the per-document cap of [ADR-0042](../../.ssot/ADR.md#adr-0042) would hold
 * every page here to two rows of each fixture document and the file would be measuring the cap.
 */
const WHOLE_PAGE = { maxPerDocument: MAX_SEARCH_LIMIT, neighborContext: 0 };

/**
 * Bag of words over runs of three or more letters, Turkish letters included, lower-cased and
 * L2-normalised. Nothing is stemmed and nothing is folded, so an inflected form and its root are two
 * different dimensions; digits and hyphens never reach the hash, so `ZX-4417` contributes nothing to
 * a vector at all.
 */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-zçğıöşü]{3,}/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  // pgvector's cosine distance is undefined for a zero vector; put a chunk of pure identifiers
  // somewhere definite rather than somewhere NaN.
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

/**
 * The Turkish question, in a different inflection from the page that answers it: the question says
 * "anahtarı", the manual says "anahtarını". `to_tsvector('turkish', …)` makes both `anahtar`;
 * `simple` leaves them as two strings that share nothing.
 */
const TR_QUESTION = 'API anahtarı nasıl iptal edilir?';

/** The chunk that answers it. No word of it is a word of the question, as the stub reads words. */
const TR_ANSWER = 'Bir yöneticinin anahtarını geri çekmesi, izleyen istekte geçerli olur ve yeniden başlatma beklemez.';

/** The English question, and the identifier that is the whole of why the lexical half exists. */
const EN_QUESTION = 'What does ZX-4417 mean?';
const EN_ANSWER = 'ZX-4417 — the receiver answered a permanent status, so the delivery was abandoned with its budget unspent.';

/** One question that asks both halves of the project at once, in two languages, as an agent would. */
const BOTH_QUESTION = 'ZX-4417 hatası ve API anahtarı';

let database: TestDatabase;
let projectId: string;

const identify = (hit: SearchHit): string => `${hit.file}#${hit.chunkIndex}`;

const search = (queryText: string, limit = 5): Promise<SearchHit[]> =>
  searchChunks(database.db, { projectId, generation: LIVE, queryEmbedding: stubVector(queryText), queryText, limit, selection: WHOLE_PAGE });

const chunkOf = (chunkIndex: number, headingPath: string, content: string): NewChunk => ({
  chunkIndex,
  headingPath,
  content,
  tokenCount: 24,
  embedding: stubVector(`${headingPath} ${content}`),
});

interface DocumentSeed {
  relativePath: string;
  sourceId: string;
  rows: NewChunk[];
  config: 'simple' | 'turkish';
}

async function seedDocument(db: TestDatabase['db'], seed: DocumentSeed): Promise<void> {
  await replaceDocument(
    db,
    {
      projectId,
      sourceId: seed.sourceId,
      relativePath: seed.relativePath,
      title: seed.relativePath,
      contentHash: `hash-${seed.relativePath}`,
      sizeBytes: 1024,
      indexGeneration: LIVE,
      content: null,
      contentTruncated: false,
      version: '',
    },
    seed.rows,
    seed.config,
  );
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'lexical_configurations');
  await applySchema(database, DIMS);

  const [project] = await database.db.insert(projects).values({ name: 'iki-dil' }).returning({ id: projects.id });
  projectId = project.id;

  // Two sources of one project, exactly as an operator would have them: the Turkish manual names its
  // language and the English handbook does not. `language` is stored on the source and spent by the
  // indexer; the fixture passes the configuration straight to `replaceDocument`, which is the same
  // value by the same route minus the indexer.
  const [turkish] = await database.db
    .insert(documentSources)
    .values({ projectId, type: 'local', name: 'elkitabi', config: { language: 'turkish' } })
    .returning({ id: documentSources.id });
  const [english] = await database.db
    .insert(documentSources)
    .values({ projectId, type: 'local', name: 'handbook' })
    .returning({ id: documentSources.id });

  // Dense-near the Turkish question and lexically worthless to it: every filler carries the
  // question's own ordinary words, so all of them are pruned by the commonness filter, and none
  // carries anything with the stem `anahtar`. The repeated word makes every vector a different
  // length, so no two chunks sit at an identical distance from anything asked here.
  const trFiller = Array.from({ length: FILLER_CHUNKS }, (_, i) =>
    chunkOf(i, `Genel > Bölüm ${i}`, `Bu bölüm bir işin nasıl${' yeniden'.repeat(i + 1)} yapılır olduğunu ve neyin iptal edilir olduğunu anlatır.`),
  );

  await seedDocument(database.db, { relativePath: TR_FILLER, sourceId: turkish.id, rows: trFiller, config: 'turkish' });
  await seedDocument(database.db, {
    relativePath: TR_MANUAL,
    sourceId: turkish.id,
    rows: [chunkOf(0, 'Kimlik doğrulama > Anahtarların geri çekilmesi', TR_ANSWER)],
    config: 'turkish',
  });
  await seedDocument(database.db, {
    relativePath: EN_CODES,
    sourceId: english.id,
    rows: [
      chunkOf(0, 'Error codes > 4xxx', EN_ANSWER),
      chunkOf(1, 'Error codes > About this table', 'What each code does and what it means is listed here in numerical order.'),
    ],
    config: 'simple',
  });
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('a project holding two text search configurations', () => {
  it('records on every chunk which configuration its tsvector was built with', async () => {
    const rows = await database.db.execute(sql`
      select c.text_search_config as config, count(*)::int as n
      from chunks c where c.project_id = ${projectId} group by c.text_search_config order by 1`);

    expect(rows.rows).toEqual([
      { config: 'simple', n: 2 },
      { config: 'turkish', n: FILLER_CHUNKS + 1 },
    ]);
  });

  it('answers a Turkish question whose word is in another inflection than the page that answers it', async () => {
    const page = await search(TR_QUESTION);

    expect(page.map(identify)).toContain(`${TR_MANUAL}#0`);
    // Lexical and only lexical: the stub cannot reach "anahtarını" from "anahtarı", and the chunk is
    // past the dense cut by twelve. A dense rank here would mean the fixture stopped testing this.
    const hit = page.find((h) => h.file === TR_MANUAL);
    expect(hit?.denseRank).toBeNull();
    expect(hit?.lexicalRank).toBe(1);
  });

  it('is the Turkish stemmer doing it, and nothing else — the premise, stated as a query', async () => {
    // The mutation this file exists to catch, written out: ask the same question in the one
    // configuration the product used to speak everywhere, and the manual is not reachable at all.
    const reachable = async (config: 'simple' | 'turkish'): Promise<number> => {
      const result = await database.db.execute(sql`
        with question as (
          select string_agg(quote_literal(lexeme), ' | ')::tsquery as q
          from unnest(to_tsvector(${config}::regconfig, ${TR_QUESTION}))
        )
        select count(*)::int as n
        from chunks c
        join documents d on d.id = c.document_id, question
        where c.project_id = ${projectId} and d.relative_path = ${TR_MANUAL} and c.content_tsv @@ question.q`);
      return (result.rows[0] as { n: number }).n;
    };

    expect(await reachable('simple')).toBe(0);
    expect(await reachable('turkish')).toBe(1);
  });

  it('still answers an identifier question in the simple half, which stemming must not have cost', async () => {
    const page = await search(EN_QUESTION);
    const hit = page.find((h) => h.file === EN_CODES && h.chunkIndex === 0);

    expect(hit).toBeDefined();
    // Not a position, because the sibling chunk of the same two-chunk document shares this question's
    // ordinary words and there are too few chunks here for the commonness filter to drop them. What
    // matters is that `ZX-4417` still reaches its row through the lexical half at all: the identifier
    // path ADR-0041 bought is the thing stemming is most obviously able to break.
    expect(hit?.lexicalRank).not.toBeNull();
  });

  it('reaches both configurations from one search, each ranked inside its own list', async () => {
    const page = await search(BOTH_QUESTION);
    const idents = page.map(identify);

    expect(idents).toContain(`${TR_MANUAL}#0`);
    expect(idents).toContain(`${EN_CODES}#0`);
    // **Two chunks at lexical rank 1, and that is the shape of the answer rather than a collision.**
    // Each configuration present is its own ranked list into the fusion, because `ts_rank_cd` scores
    // computed against different term frequencies are not comparable and RRF consumes positions.
    expect(page.find((h) => h.file === TR_MANUAL)?.lexicalRank).toBe(1);
    expect(page.find((h) => h.file === EN_CODES && h.chunkIndex === 0)?.lexicalRank).toBe(1);
  });
});

/**
 * The upgrade, end to end: a database whose Turkish source was indexed with `turkish` back when the
 * query side could not speak it, carrying the `simple` the new column defaults to. `bootstrapDatabase`
 * has to move it, and the search has to start working without anything being re-indexed or re-embedded.
 */
describe('a database that comes up holding a source whose language the column does not yet reflect', () => {
  let upgraded: TestDatabase;
  let upgradedProject: string;

  const configOf = async (): Promise<string[]> => {
    const rows = await upgraded.db.execute(sql`
      select distinct c.text_search_config as config from chunks c where c.project_id = ${upgradedProject}`);
    return rows.rows.map((row) => (row as { config: string }).config);
  };

  const find = async (): Promise<SearchHit[]> =>
    searchChunks(upgraded.db, {
      projectId: upgradedProject,
      generation: LIVE,
      queryEmbedding: stubVector(TR_QUESTION),
      queryText: TR_QUESTION,
      limit: 5,
      selection: WHOLE_PAGE,
    });

  beforeAll(async () => {
    upgraded = await createTestDatabase(baseUrl, 'lexical_configurations_upgrade');
    await applySchema(upgraded, DIMS);

    const [project] = await upgraded.db.insert(projects).values({ name: 'yukseltilen' }).returning({ id: projects.id });
    upgradedProject = project.id;
    const [source] = await upgraded.db
      .insert(documentSources)
      .values({ projectId: upgradedProject, type: 'local', name: 'elkitabi', config: { language: 'turkish' } })
      .returning({ id: documentSources.id });

    await replaceDocument(
      upgraded.db,
      {
        projectId: upgradedProject,
        sourceId: source.id,
        relativePath: TR_MANUAL,
        title: TR_MANUAL,
        contentHash: 'hash-upgrade',
        sizeBytes: 1024,
        indexGeneration: LIVE,
        content: null,
        contentTruncated: false,
        version: '',
      },
      [chunkOf(0, 'Kimlik doğrulama > Anahtarların geri çekilmesi', TR_ANSWER)],
      // `simple`, deliberately: this is what every row of every database looks like the moment
      // `0012` has added the column and nothing has reconciled it yet.
      'simple',
    );
  });

  afterAll(async () => {
    await dropTestDatabase(baseUrl, upgraded);
  });

  it('starts with the column the migration gave it, and a question the lexical half cannot answer', async () => {
    expect(await configOf()).toEqual(['simple']);
    // The dense half still answers — there is one chunk in this project and it is the nearest thing
    // to anything. A null lexical rank is what says the other half found nothing, which is the state
    // a Turkish source is in the moment `0012` has run and nothing has reconciled it yet.
    expect((await find())[0].lexicalRank).toBeNull();
  });

  it('moves the rows to the source language at the next start, and the question is answered', async () => {
    await applySchema(upgraded, DIMS);

    expect(await configOf()).toEqual(['turkish']);
    const page = await find();
    expect(page.map((hit) => hit.file)).toContain(TR_MANUAL);
    expect(page[0].lexicalRank).toBe(1);
  });

  it('does it again as nothing, so every start does not rewrite the table', async () => {
    // `xmin` is the transaction that last wrote the row, so it is the one fingerprint an UPDATE that
    // rewrote the same values would still move. `id` would not: it is untouched by the statement
    // under test, so a fingerprint built on it would pass whether or not this loop is idempotent —
    // which is the test quietly measuring nothing.
    const fingerprint = async (): Promise<unknown> =>
      (await upgraded.db.execute(sql`select array_agg(c.xmin::text order by c.id) as writers from chunks c`)).rows[0];

    const before = await fingerprint();
    await applySchema(upgraded, DIMS);

    expect(await fingerprint()).toEqual(before);
    expect(await configOf()).toEqual(['turkish']);
  });

  it('puts a chunk back to simple when the source stops naming a language', async () => {
    await upgraded.db.update(documentSources).set({ config: {} }).where(eq(documentSources.projectId, upgradedProject));
    await applySchema(upgraded, DIMS);

    expect(await configOf()).toEqual(['simple']);
    // And the tsvector went with it, which is the half that cannot be read back off the row: the
    // question stops matching, exactly as it did before the source ever named a language.
    expect((await find())[0].lexicalRank).toBeNull();
  });
});
