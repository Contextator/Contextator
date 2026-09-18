import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  DENSE_CANDIDATES,
  LEXICAL_CANDIDATES,
  LEXICAL_TERM_MAX_DOCUMENT_FREQUENCY,
  LEXICAL_TERM_MIN_DOCUMENT_FLOOR,
  type Config,
} from '../config.js';
import type { Db } from '../db/client.js';
import { chunks, documents, type DocumentRow } from '../db/schema.js';
import { RRF_K } from './rrf.js';
import { DEFAULT_TEXT_SEARCH_CONFIG, QUERY_TEXT_SEARCH_CONFIG, type TextSearchConfig } from './text-search.js';

/**
 * Every query in this file is scoped by a **project and a generation**
 * ([ADR-0039](../../.ssot/ADR.md#adr-0039)). A project's `live_generation` is the published index;
 * a rebuild writes the next generation beside it and is switched over in one row update, so the two
 * exist at once and a query that named only the project would see both.
 *
 * The generation is a value the caller passes, never a sub-select on `projects`: every read path
 * already holds the project row it re-read for its own guards, and a sub-select would put a join
 * between pgvector and the predicate the search below depends on.
 */

/**
 * The three pgvector scan settings one search runs under ([ADR-0040](../../.ssot/ADR.md#adr-0040)).
 * A plain structure rather than a `Config`, so a caller that is not the server — the evaluation
 * harness, a test — can say what it wants without assembling an environment.
 */
export interface HnswScan {
  /** Candidates the index yields *before* the project and generation predicates post-filter them. */
  efSearch: number;
  /** `off` is pgvector's default: answer short rather than keep scanning. */
  iterativeScan: 'off' | 'relaxed_order' | 'strict_order';
  /** Index tuples one query may visit under iterative scan before it answers with what it has. */
  maxScanTuples: number;
}

/**
 * What a caller with no configuration in hand gets. It is the schema's own defaults, restated here
 * only because `config.ts` describes an environment and this file must not require one; `scanFrom`
 * below is what the server uses, and the tests assert the two agree.
 */
export const DEFAULT_HNSW_SCAN: HnswScan = { efSearch: 100, iterativeScan: 'relaxed_order', maxScanTuples: 20_000 };

/** The configured scan, for the three callers that hold a `Config`. */
export function scanFrom(config: Pick<Config, 'HNSW_EF_SEARCH' | 'HNSW_ITERATIVE_SCAN' | 'HNSW_MAX_SCAN_TUPLES'>): HnswScan {
  return {
    efSearch: config.HNSW_EF_SEARCH,
    iterativeScan: config.HNSW_ITERATIVE_SCAN,
    maxScanTuples: config.HNSW_MAX_SCAN_TUPLES,
  };
}

export interface SearchHit {
  /**
   * Cosine similarity in [-1, 1], higher better — **for display, and no longer for ordering**
   * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). It is computed for every fused candidate, including
   * the ones only the lexical half found, because the query vector and the chunk embeddings are both
   * in hand at that point and one more `<=>` over at most a hundred rows costs nothing.
   *
   * It is kept because `formatHits` renders it into every MCP result and
   * [API.md](../../.ssot/API.md) §1 freezes the shape of that line. It is **not** a number to
   * threshold on: under `multilingual-e5-small` a correct hit averages 0.890 and a wrong one 0.853
   * ([ADR-0037](../../.ssot/ADR.md#adr-0037)), a gap of 0.02. Item 7's relevance floor has to be
   * built on this deliberately rather than inherit it.
   */
  score: number;
  /** What actually ordered the list: `Σ 1/(RRF_K + rank)` over the two halves. */
  fusedScore: number;
  /** 1-based rank in the dense candidate list, or `null` when only the lexical half returned it. */
  denseRank: number | null;
  /** 1-based rank in the lexical candidate list, or `null` when only the dense half returned it. */
  lexicalRank: number | null;
  file: string;
  title: string;
  headingPath: string;
  content: string;
  chunkIndex: number;
}

/** What one search is: a project, a generation, both encodings of the question, and how far to look. */
export interface SearchRequest {
  projectId: string;
  /** The project's `live_generation`, passed as a value rather than sub-selected (ADR-0039). */
  generation: number;
  /** The question as the embedding model sees it. */
  queryEmbedding: number[];
  /**
   * The question as PostgreSQL's text search parser sees it — the raw string the caller was given,
   * with no prefix. The dense side reads `embedQuery`'s output and the lexical side reads this, and
   * handing the lexical side a `query: `-prefixed string would put a stop word nobody typed into
   * every `tsquery` (ADR-0038).
   */
  queryText: string;
  /** Excerpts to return after fusion. 1–`MAX_SEARCH_LIMIT`. */
  limit: number;
  scan?: HnswScan;
  /**
   * The text search configuration the query is parsed with. `simple` in this version, everywhere; it
   * is a parameter so that the evaluation harness can measure stemming against it without the product
   * growing a setting nobody has justified (ADR-0041).
   */
  textSearchConfig?: TextSearchConfig;
}

/** One row of the fused statement below, in PostgreSQL's spelling. */
interface HybridRow extends Record<string, unknown> {
  score: number;
  fused_score: number;
  dense_rank: number | null;
  lexical_rank: number | null;
  file: string;
  title: string;
  heading_path: string;
  content: string;
  chunk_index: number;
}

/**
 * **One search, two halves, fused** ([ADR-0041](../../.ssot/ADR.md#adr-0041)).
 *
 * The dense half is what this function used to be: `ef_search` candidates off the HNSW index, ordered
 * by `<=>`. The lexical half is a GIN scan of `content_tsv`. Each side contributes its own fifty
 * candidates, and reciprocal rank fusion — `Σ 1/(k + rank)`, `k` = 60 — decides the order; `limit` is
 * taken after that, not before.
 *
 * **The `tsquery` is the question's lexemes OR-ed, and it is not `plainto_tsquery`.** That was the
 * plan and it does not work: `plainto_tsquery` ANDs, so `HLY-4019 hatası ne anlama geliyor?` asks for
 * a chunk containing *every* one of those words, and the reference table that defines `HLY-4019`
 * contains none of the other four. Under AND the lexical half returns nothing for almost every
 * question in the golden set — including the identifier questions this whole change exists for. So
 * the query string is run through `to_tsvector` with the same configuration the column was built
 * with, and its lexemes are OR-ed: a chunk matches when it shares any term, and `ts_rank_cd` decides
 * how well. `string_agg` over no lexemes is NULL, and `content_tsv @@ NULL` is not true, so a query
 * of pure punctuation quietly contributes no lexical candidates instead of erroring.
 *
 * **It is one statement, and the reason is not elegance.** Fusion needs both rank lists, so doing it
 * in Node means shipping a hundred chunk texts across the wire to discard ninety of them. The two
 * candidate lists are CTEs, the fusion is a `FULL OUTER JOIN` — full, because a chunk may be on
 * either list alone and that is the whole point of running two — and `LIMIT` is applied to the fused
 * result. One round trip, in the transaction ADR-0040 already required.
 *
 * `AS MATERIALIZED` on the two candidate CTEs is load-bearing. Under `hnsw.iterative_scan =
 * relaxed_order` pgvector returns the right *set* of rows in the wrong order while still claiming the
 * ordering as a path key, so a `row_number()` reading straight from the index scan would number rows
 * that are not sorted. Materialising drops the claimed ordering, PostgreSQL inserts the sort it needs
 * for the window, and the ranks are true by construction. This is the same correction ADR-0040 made
 * in TypeScript, moved to where the ranks are now produced.
 *
 * **A chunk with no `content_tsv` is not a special case.** `NULL @@ query` is NULL, which is not
 * true, so it is absent from the lexical list and sits wherever the dense half put it. That is what
 * makes a project mid-upgrade — migrated, not yet backfilled, not yet re-indexed — behave as
 * dense-only rather than as broken.
 *
 * The three `hnsw.*` settings are still transaction-local `set_config(…, is_local => true)`, for
 * ADR-0040's reason: `createDb` pools connections and a session-level `SET` would follow one into an
 * index run's writes. `SET LOCAL` outside a transaction is a silent no-op.
 */
export async function searchChunks(db: Db, request: SearchRequest): Promise<SearchHit[]> {
  const { projectId, generation, queryEmbedding, queryText, limit } = request;
  const scan = request.scan ?? DEFAULT_HNSW_SCAN;
  const textSearchConfig = request.textSearchConfig ?? QUERY_TEXT_SEARCH_CONFIG;

  // pgvector's own text form, bound as a parameter and cast, rather than interpolated: this is 384
  // floats and it appears twice, once to select the dense candidates and once to score every fused
  // one for display.
  const vector = sql`${JSON.stringify(queryEmbedding)}::vector`;

  const result = await db.transaction(async (tx) => {
    // One statement, so the whole of the setup costs a single round trip. The integers travel as
    // parameters — `set_config` takes text and pgvector parses it — rather than being interpolated,
    // which is the reason this is not three `SET LOCAL`s.
    await tx.execute(sql`select
      set_config('hnsw.ef_search', ${String(scan.efSearch)}, true),
      set_config('hnsw.iterative_scan', ${scan.iterativeScan}, true),
      set_config('hnsw.max_scan_tuples', ${String(scan.maxScanTuples)}, true)`);

    return tx.execute<HybridRow>(sql`
      with corpus as (
        -- How many chunks the question is being asked of, and therefore what "this word is everywhere"
        -- means for this project. Served by chunks_project_generation_idx.
        select greatest(
                 ceil(count(*) * ${LEXICAL_TERM_MAX_DOCUMENT_FREQUENCY}::float8),
                 ${LEXICAL_TERM_MIN_DOCUMENT_FLOOR}::float8
               )::int as common_at
        from chunks c where c.project_id = ${projectId} and c.index_generation = ${generation}
      ),
      question as materialized (
        -- The question's lexemes, quoted as tsquery literals and OR-ed — minus the ones that are in so
        -- many of this project's chunks that they say nothing about which chunk. quote_literal is what
        -- makes this safe as well as correct: tsquery's quoting rule for a lexeme is SQL's, so a term
        -- carrying an apostrophe survives instead of ending the literal.
        --
        -- The count is capped by the LIMIT: this asks "are there at least common_at of them", not "how
        -- many are there", so a word that is genuinely everywhere costs the same as one that is not.
        select string_agg(quote_literal(t.lexeme), ' | ')::tsquery as q
        from unnest(to_tsvector(${textSearchConfig}::regconfig, ${queryText})) t, corpus
        where (
          select count(*) from (
            select 1 from chunks c
            where c.project_id = ${projectId} and c.index_generation = ${generation}
              and c.content_tsv @@ quote_literal(t.lexeme)::tsquery
            limit corpus.common_at
          ) probe
        ) < corpus.common_at
      ),
      dense_candidates as materialized (
        select c.id, (c.embedding <=> ${vector}) as distance
        from chunks c
        where c.project_id = ${projectId} and c.index_generation = ${generation}
        -- One sort key, and no tie-break. A second ORDER BY column here is not free: the HNSW index
        -- can only satisfy an ordering it produces itself, so adding c.id makes the whole clause
        -- unsatisfiable by the index and PostgreSQL falls back to reading the project's rows and
        -- sorting them exactly. That is correct, which is what makes it dangerous — it looks like a
        -- tidying change and it quietly turns the vector index off. The ranks are made deterministic
        -- in the dense CTE below instead, where the sort is over fifty rows and costs nothing.
        order by c.embedding <=> ${vector}
        limit ${DENSE_CANDIDATES}
      ),
      dense as (
        select id, row_number() over (order by distance, id) as rank from dense_candidates
      ),
      lexical_candidates as materialized (
        -- Normalisation 1 is "divide by 1 + log(length)". Two reasons, and the second is the one that
        -- bites: a term in a short chunk is stronger evidence than the same term in a long one, and
        -- ts_rank_cd without it returns the *same* score for a great many chunks — at which point the
        -- ordering is decided by whatever the tie-break is, which was a random uuid. Measured: five
        -- runs of one configuration over the golden set spread recall@1 across nine points, because a
        -- fresh database mints fresh uuids and the lexical top-twenty came out in a different order.
        select
          c.id,
          ts_rank_cd(c.content_tsv, question.q, 1) as rank_score,
          length(c.content) as content_length,
          c.chunk_index
        from chunks c, question
        where c.project_id = ${projectId} and c.index_generation = ${generation}
          and c.content_tsv @@ question.q
        -- What is left of the ties is broken by properties of the corpus rather than of the database:
        -- the shorter chunk first, then the earlier one in its document. c.id stays as a backstop so
        -- the ordering is total, and it should now almost never be reached.
        order by ts_rank_cd(c.content_tsv, question.q, 1) desc, length(c.content) asc, c.chunk_index asc, c.id
        limit ${LEXICAL_CANDIDATES}
      ),
      lexical as (
        select
          id,
          row_number() over (order by rank_score desc, content_length asc, chunk_index asc, id) as rank
        from lexical_candidates
      ),
      fused as (
        select
          coalesce(d.id, l.id) as id,
          d.rank as dense_rank,
          l.rank as lexical_rank,
          coalesce(1.0 / (${RRF_K} + d.rank), 0) + coalesce(1.0 / (${RRF_K} + l.rank), 0) as fused_score
        from dense d full outer join lexical l on l.id = d.id
      )
      select
        (1 - (c.embedding <=> ${vector}))::float8 as score,
        f.fused_score::float8 as fused_score,
        f.dense_rank::int as dense_rank,
        f.lexical_rank::int as lexical_rank,
        doc.relative_path as file,
        doc.title as title,
        c.heading_path as heading_path,
        c.content as content,
        c.chunk_index as chunk_index
      from fused f
      join chunks c on c.id = f.id
      join documents doc on doc.id = c.document_id
      order by f.fused_score desc, f.dense_rank asc nulls last, f.id asc
      limit ${limit}`);
  });

  return result.rows.map((row) => ({
    score: row.score,
    fusedScore: row.fused_score,
    denseRank: row.dense_rank,
    lexicalRank: row.lexical_rank,
    file: row.file,
    title: row.title,
    headingPath: row.heading_path,
    content: row.content,
    chunkIndex: row.chunk_index,
  }));
}

export interface DocumentSummary {
  relativePath: string;
  title: string;
  chunkCount: number;
  sizeBytes: number;
  indexedAt: Date;
}

export async function listDocumentsForProject(db: Db, projectId: string, generation: number): Promise<DocumentSummary[]> {
  return db
    .select({
      relativePath: documents.relativePath,
      title: documents.title,
      chunkCount: documents.chunkCount,
      sizeBytes: documents.sizeBytes,
      indexedAt: documents.indexedAt,
    })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation)))
    .orderBy(asc(documents.relativePath));
}

export async function getDocument(db: Db, projectId: string, generation: number, relativePath: string): Promise<DocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), eq(documents.relativePath, relativePath)))
    .limit(1);
  return row;
}

/**
 * The paths a run writes into, with what is already there under them. A rebuild passes the generation
 * it is about to write — which holds nothing — so it gets an empty map and skips no file. "Force means
 * re-embed everything" is therefore a consequence of writing into a fresh generation rather than a
 * case anybody has to remember to special-case.
 */
export async function getExistingDocuments(
  db: Db,
  projectId: string,
  generation: number,
): Promise<Map<string, { id: string; contentHash: string; sourceId: string | null }>> {
  const rows = await db
    .select({ id: documents.id, relativePath: documents.relativePath, contentHash: documents.contentHash, sourceId: documents.sourceId })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation)));
  return new Map(rows.map((r) => [r.relativePath, { id: r.id, contentHash: r.contentHash, sourceId: r.sourceId }]));
}

export interface NewChunk {
  chunkIndex: number;
  headingPath: string;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export interface DocumentInput {
  projectId: string;
  /**
   * Nullable because the column is: pre-v3 documents carried no source, and the evaluation harness
   * (`scripts/eval.ts`, ADR-0034) indexes a corpus that is already on disk in the repository and has
   * therefore no `document_sources` row to point at. The indexer always supplies one.
   */
  sourceId: string | null;
  relativePath: string;
  title: string;
  contentHash: string;
  sizeBytes: number;
  /** The generation this document belongs to; the run decides it, not this function. */
  indexGeneration: number;
}

/**
 * Fallback for clients that remember pre-v3 paths (without the source prefix): the document whose path
 * ends with `/<suffix>`, but only when exactly one matches — within the live generation, so a rebuild
 * in flight cannot turn one match into two and make the fallback stop resolving.
 */
export async function getDocumentBySuffix(db: Db, projectId: string, generation: number, suffix: string): Promise<DocumentRow | undefined> {
  const pattern = `%/${suffix.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), sql`${documents.relativePath} LIKE ${pattern} ESCAPE '\\'`),
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

const INSERT_BATCH = 200;

/**
 * Upserts the document row and atomically replaces all of its chunks. Returns the document id.
 *
 * `textSearchConfig` is the configuration this document's chunks are indexed *with*, which comes from
 * its source's optional `language` ([ADR-0041](../../.ssot/ADR.md#adr-0041)). It defaults to `simple`
 * because that is what an unset language means and what a caller with no source in hand — a test —
 * should get.
 */
export async function replaceDocument(
  db: Db,
  doc: DocumentInput,
  newChunks: NewChunk[],
  textSearchConfig: TextSearchConfig = DEFAULT_TEXT_SEARCH_CONFIG,
): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(documents)
      .values({ ...doc, chunkCount: newChunks.length, indexedAt: now })
      // Three columns since ADR-0039: the same path in two generations is two rows, and the
      // conflict target has to be the constraint that says so.
      .onConflictDoUpdate({
        target: [documents.projectId, documents.indexGeneration, documents.relativePath],
        set: {
          sourceId: doc.sourceId,
          title: doc.title,
          contentHash: doc.contentHash,
          sizeBytes: doc.sizeBytes,
          chunkCount: newChunks.length,
          indexedAt: now,
        },
      })
      .returning({ id: documents.id });

    await tx.delete(chunks).where(eq(chunks.documentId, row.id));
    for (let i = 0; i < newChunks.length; i += INSERT_BATCH) {
      await tx.insert(chunks).values(
        newChunks.slice(i, i + INSERT_BATCH).map((c) => ({
          projectId: doc.projectId,
          documentId: row.id,
          indexGeneration: doc.indexGeneration,
          ...c,
          // The breadcrumb and the content, in that order and separated by a space, because an
          // identifier lives in a heading (`### AUTH_COOKIE_SECURE`) as often as in prose and the
          // dense side already reads `embeddingText`, which prepends the same breadcrumb. Both
          // halves seeing the same text is the property; `embeddingText`'s blank line is not, so
          // this does not reach for it and pretend the two strings are one thing.
          contentTsv: sql`to_tsvector(${textSearchConfig}::regconfig, ${`${c.headingPath} ${c.content}`})`,
        })),
      );
    }
    return row.id;
  });
}

export async function deleteDocuments(db: Db, projectId: string, generation: number, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;
  await db
    .delete(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), inArray(documents.relativePath, relativePaths)));
}

export async function recountProject(db: Db, projectId: string, generation: number): Promise<{ chunkCount: number; documentCount: number }> {
  const [c] = await db
    .select({ n: count() })
    .from(chunks)
    .where(and(eq(chunks.projectId, projectId), eq(chunks.indexGeneration, generation)));
  const [d] = await db
    .select({ n: count() })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation)));
  return { chunkCount: c?.n ?? 0, documentCount: d?.n ?? 0 };
}

/** How many documents one `sweepGenerations` statement removes before coming up for air. */
const SWEEP_BATCH = 500;

/** Safety valve: a loop against a table something else is still writing must not be able to spin forever. */
const SWEEP_MAX_BATCHES = 10_000;

/**
 * Deletes every document of a project that does not belong to `liveGeneration`, and with them, by
 * cascade, their chunks. Both directions matter and both are the same statement:
 *
 * - `< live` is what a finished swap left behind — the generation that was being served until a
 *   moment ago.
 * - `> live` is an attempt that never went live: a rebuild that failed, or one whose process was
 *   killed between writing rows and swapping. Nothing else would ever collect those.
 *
 * That is what makes reclamation idempotent and crash-safe rather than a step a run has to survive
 * long enough to reach. It runs under the project's mutex, in batches, **outside** the swap's
 * transaction: one `DELETE` over a whole generation would hold locks for as long as it took and write
 * a write-ahead log the size of the index it is removing.
 *
 * Returns the number of documents removed.
 */
export async function sweepGenerations(db: Db, projectId: string, liveGeneration: number): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const doomed = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), ne(documents.indexGeneration, liveGeneration)))
      .limit(SWEEP_BATCH);
    if (doomed.length === 0) return removed;
    await db.delete(documents).where(
      inArray(
        documents.id,
        doomed.map((d) => d.id),
      ),
    );
    removed += doomed.length;
  }
  return removed;
}
