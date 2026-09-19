import { and, asc, count, eq, gt, gte, inArray, lte, ne, sql } from 'drizzle-orm';
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

/**
 * How the fused list is turned into an answer ([ADR-0042](../../.ssot/ADR.md#adr-0042)) — the two
 * settings that change which candidates a caller is handed rather than which ones exist. A plain
 * structure and not a `Config`, for `HnswScan`'s reason.
 */
export interface ResultSelection {
  /** Excerpts one document may contribute to one answer, applied after fusion and refilled from below. */
  maxPerDocument: number;
  /** Chunks either side of a hit, fetched as context *around* it rather than as further results. */
  neighborContext: number;
}

/** The schema's own defaults, restated for a caller that holds no environment; the tests assert they agree. */
export const DEFAULT_RESULT_SELECTION: ResultSelection = { maxPerDocument: 2, neighborContext: 1 };

/** The configured selection, for the callers that hold a `Config`. */
export function selectionFrom(config: Pick<Config, 'SEARCH_MAX_PER_DOCUMENT' | 'SEARCH_NEIGHBOR_CONTEXT'>): ResultSelection {
  return { maxPerDocument: config.SEARCH_MAX_PER_DOCUMENT, neighborContext: config.SEARCH_NEIGHBOR_CONTEXT };
}

/**
 * Escapes the two characters `LIKE` reads as wildcards, for a pattern built from a string somebody
 * typed. Every caller pairs it with `ESCAPE '\'`, because the escape character is not the default.
 *
 * One function and not one per query: `path_prefix` searches for `_` in exactly the paths an operator
 * would write it in, and a second copy of this is a second place for one of the two characters to be
 * forgotten.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
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
  /**
   * The `neighborContext` chunks before this one in the same document, joined, or `null` when there
   * are none or the setting is `0` ([ADR-0042](../../.ssot/ADR.md#adr-0042)). It is context and not a
   * result: it carries no rank and no score, because it was not retrieved — it was fetched because
   * the chunk beside it was.
   */
  contextBefore: string | null;
  /** The same, after. */
  contextAfter: string | null;
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
  /**
   * Only documents of this source ([ADR-0042](../../.ssot/ADR.md#adr-0042)). The **id**, resolved by
   * the caller from the name an agent wrote — `documents.source_id` is the real key, and resolving it
   * first is what lets a caller answer "unknown source; the ones this project has are …" instead of
   * returning an empty page that looks like an honest miss.
   */
  sourceId?: string;
  /**
   * Only documents whose `relative_path` starts with this. Already normalised by the caller
   * (`normalizeRelativePath`), and escaped here, because the `_` in `docs/getting_started` is a `LIKE`
   * wildcard and an operator who typed it meant the character.
   */
  pathPrefix?: string;
  scan?: HnswScan;
  /** The per-document cap and the neighbour context. Unset is `DEFAULT_RESULT_SELECTION`. */
  selection?: ResultSelection;
  /**
   * The text search configuration the query is parsed with. `simple` in this version, everywhere; it
   * is a parameter so that the evaluation harness can measure stemming against it without the product
   * growing a setting nobody has justified (ADR-0041).
   */
  textSearchConfig?: TextSearchConfig;
  /**
   * A cross-encoder that reorders the fused pool before the cap and the limit are applied
   * ([ROADMAP.md](../../.ssot/ROADMAP.md) Item 12). Absent — which is the default and what the product
   * ships — and this function is exactly the one statement it has always been.
   *
   * It is a **function of strings**, not a model, for the reason `queryEmbedding` is a vector rather
   * than a provider: the model belongs at the edge, and the query path stays testable without one.
   * `services/reranker.ts` is what builds it.
   */
  rerank?: (query: string, passages: readonly string[]) => Promise<number[]>;
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
  context_before: string | null;
  context_after: string | null;
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
 * **Since [ADR-0042](../../.ssot/ADR.md#adr-0042) the statement also decides which of what it found a
 * caller is handed**, and all three parts of that are in the SQL for one reason: the pool is here.
 * `source` and `path_prefix` are resolved to a document-id CTE and pushed into *both* candidate lists;
 * the per-document cap is a `row_number()` over the fused ordering, so refilling from the candidates
 * below a capped excerpt costs nothing; and the neighbours of the page are fetched after `limit` has
 * been applied, as context rather than as results. The alternative — fusing fifty and fifty, shipping
 * them to Node and selecting there — is the trade ADR-0041 already refused.
 *
 * The three `hnsw.*` settings are still transaction-local `set_config(…, is_local => true)`, for
 * ADR-0040's reason: `createDb` pools connections and a session-level `SET` would follow one into an
 * index run's writes. `SET LOCAL` outside a transaction is a silent no-op.
 */
export async function searchChunks(db: Db, request: SearchRequest): Promise<SearchHit[]> {
  const { projectId, generation, queryEmbedding, queryText, limit, sourceId, pathPrefix, rerank } = request;
  const scan = request.scan ?? DEFAULT_HNSW_SCAN;
  const selection = request.selection ?? DEFAULT_RESULT_SELECTION;
  const textSearchConfig = request.textSearchConfig ?? QUERY_TEXT_SEARCH_CONFIG;

  // A filtered search is a different statement, not the same statement with a predicate that is
  // sometimes true: an unfiltered search must keep exactly the plan ADR-0040 and ADR-0041 measured,
  // and `and c.document_id in (select …)` over an unrestricted sub-select would not be free to the
  // planner even though it excludes nothing.
  const filtered = sourceId !== undefined || pathPrefix !== undefined;
  const documentScope = filtered
    ? sql`
      filtered_documents as materialized (
        -- The filters, resolved to document ids **once**, so each candidate CTE below carries one
        -- hash semi-join rather than its own copy of two predicates. Served by
        -- documents_project_generation_idx.
        select id from documents
        where project_id = ${projectId} and index_generation = ${generation}
          ${sourceId === undefined ? sql`` : sql`and source_id = ${sourceId}`}
          ${pathPrefix === undefined ? sql`` : sql`and relative_path like ${`${escapeLikePattern(pathPrefix)}%`} escape '\\'`}
      ),`
    : sql``;
  // The third and fourth predicates ADR-0040 said were coming. Both halves get them, because a filter
  // that applied to one of them would silently mean "this source, or anything the other retriever
  // liked".
  const withinScope = filtered ? sql`and c.document_id in (select id from filtered_documents)` : sql``;

  // Neighbour expansion, and it is deliberately outside the fused statement's own candidate CTEs: a
  // neighbour is not a candidate and must never be able to rank, displace one, or be counted by the
  // per-document cap. It is a point range on chunks_document_chunk_index_uq, for the page only.
  const neighbors = (offset: -1 | 1): ReturnType<typeof sql> =>
    selection.neighborContext === 0
      ? sql`null::text`
      : sql`(select string_agg(n.content, ${'\n\n'} order by n.chunk_index)
             from chunks n
             where n.document_id = p.document_id and n.index_generation = ${generation}
               and n.chunk_index between ${offset === -1 ? sql`p.chunk_index - ${selection.neighborContext}` : sql`p.chunk_index + 1`}
                                     and ${offset === -1 ? sql`p.chunk_index - 1` : sql`p.chunk_index + ${selection.neighborContext}`})`;

  // pgvector's own text form, bound as a parameter and cast, rather than interpolated: this is 384
  // floats and it appears twice, once to select the dense candidates and once to score every fused
  // one for display.
  const vector = sql`${JSON.stringify(queryEmbedding)}::vector`;

  // The page's ordering, and the *whole* of it. Under a rerank the model's score is prepended to these
  // three rather than replacing them: a cross-encoder returns equal logits often enough — two excerpts
  // of one section, a duplicated table — that a rerank with no tie-break underneath it would hand the
  // ordering back to the row order, which is the defect ADR-0041 spent a change removing.
  const fusedOrdering = sql`fused_score desc, dense_rank asc nulls last, id asc`;

  /**
   * Everything down to the fused list. It is shared by both paths verbatim, which is the property that
   * matters most about this whole change: with no reranker the statement below is assembled into
   * exactly the text it was before Item 12, so the gated `eval` job measures the plan ADR-0040 and
   * ADR-0041 measured and not a rearrangement of it.
   */
  const fusedCandidates = sql`
      with ${documentScope}
      corpus as (
        -- How many chunks the question is being asked of, and therefore what "this word is everywhere"
        -- means for this project. Served by chunks_project_generation_idx.
        --
        -- **Deliberately the whole project, filters or not** (ADR-0042). How much a term says about
        -- which chunk is a property of the corpus, not of the slice somebody asked about; counting it
        -- over a filtered subset would make the same question mean different things under different
        -- filters, and a filter narrow enough to matter would fall under the floor below and drop
        -- nothing at all.
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
        -- c.chunk_index is carried for the tie-break below and for nothing else. It is a column of the
        -- projection, not of the ORDER BY, which is the distinction the comment below is about.
        select c.id, (c.embedding <=> ${vector}) as distance, c.chunk_index
        from chunks c
        where c.project_id = ${projectId} and c.index_generation = ${generation} ${withinScope}
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
        -- The same shape as the lexical half below, and for the same reason. Equal cosine distance is
        -- not exotic — a duplicated chunk, a licence block, the same table on two pages — and with the
        -- uuid as the only tie-break the ranks of those chunks were settled by gen_random_uuid() and
        -- changed on every re-index. RRF is positional, so that moved the *fused* order of unrelated
        -- documents too: measured over 24 freshly seeded corpora, five came back with a different
        -- five-result page. Corpus first, then the uuid as a total-order backstop.
        select id, row_number() over (order by distance, chunk_index, id) as rank from dense_candidates
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
        where c.project_id = ${projectId} and c.index_generation = ${generation} ${withinScope}
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
      )`;

  /**
   * The tail that turns the fused list into a page, unchanged: the cap, the limit, the cosine score for
   * display and the two neighbour lookups. `orderedPage` is the `page` CTE, which is the only thing the
   * two paths disagree about.
   */
  const pageToHits = (orderedPage: ReturnType<typeof sql>, ordering: ReturnType<typeof sql>) => sql`${orderedPage}
      select
        (1 - (c.embedding <=> ${vector}))::float8 as score,
        p.fused_score::float8 as fused_score,
        p.dense_rank::int as dense_rank,
        p.lexical_rank::int as lexical_rank,
        doc.relative_path as file,
        doc.title as title,
        c.heading_path as heading_path,
        c.content as content,
        c.chunk_index as chunk_index,
        ${neighbors(-1)} as context_before,
        ${neighbors(1)} as context_after
      from page p
      join chunks c on c.id = p.id
      join documents doc on doc.id = c.document_id
      order by ${ordering}`;

  /** The shipped path: one statement, the cap and the limit in SQL, exactly as ADR-0042 left it. */
  const singleStatement = pageToHits(
    sql`${fusedCandidates},
      capped as (
        -- The per-document cap (ADR-0042), as a window over the fused ordering rather than as a pass
        -- in Node: refilling from the candidates below a capped excerpt is what row_number() <= n
        -- does for free, over a pool that is already here. The partition's ORDER BY is the fused
        -- ordering itself, so the excerpts a document keeps are its best ones and not an arbitrary two.
        select
          f.id,
          f.dense_rank,
          f.lexical_rank,
          f.fused_score,
          c.document_id,
          c.chunk_index,
          row_number() over (partition by c.document_id order by f.fused_score desc, f.dense_rank asc nulls last, f.id asc) as per_document
        from fused f
        join chunks c on c.id = f.id
      ),
      page as materialized (
        -- Materialised so that the limit happens *before* the two neighbour lookups in the select
        -- list below. Inlined, PostgreSQL would project them over every fused candidate and then
        -- discard all but a page of the work.
        select * from capped
        where per_document <= ${selection.maxPerDocument}
        order by ${fusedOrdering}
        limit ${limit}
      )`,
    sql`p.fused_score desc, p.dense_rank asc nulls last, p.id asc`,
  );

  const scanSettings = sql`select
      set_config('hnsw.ef_search', ${String(scan.efSearch)}, true),
      set_config('hnsw.iterative_scan', ${scan.iterativeScan}, true),
      set_config('hnsw.max_scan_tuples', ${String(scan.maxScanTuples)}, true)`;

  const result = rerank
    ? await rerankedPage(db, {
        scanSettings,
        fusedCandidates,
        pageToHits,
        rerank,
        queryText,
        limit,
        maxPerDocument: selection.maxPerDocument,
        generation,
      })
    : await db.transaction(async (tx) => {
        // One statement, so the whole of the setup costs a single round trip. The integers travel as
        // parameters — `set_config` takes text and pgvector parses it — rather than being interpolated,
        // which is the reason this is not three `SET LOCAL`s.
        await tx.execute(scanSettings);
        return tx.execute<HybridRow>(singleStatement);
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
    contextBefore: row.context_before,
    contextAfter: row.context_after,
  }));
}

/** One fused candidate as the rerank sees it: enough to score it, to cap it and to find it again. */
interface CandidateRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  content: string;
  fused_score: number;
  dense_rank: number | null;
  lexical_rank: number | null;
}

interface RerankedPageArgs {
  scanSettings: ReturnType<typeof sql>;
  fusedCandidates: ReturnType<typeof sql>;
  pageToHits: (orderedPage: ReturnType<typeof sql>, ordering: ReturnType<typeof sql>) => ReturnType<typeof sql>;
  rerank: (query: string, passages: readonly string[]) => Promise<number[]>;
  queryText: string;
  limit: number;
  maxPerDocument: number;
  generation: number;
}

/**
 * The reranked path, and it is **two round trips rather than one**, which is the first thing it costs
 * and the reason `SEARCH_RERANK` defaults to `off`.
 *
 * ADR-0041 refused to ship a hundred chunk texts to Node and throw ninety away. A cross-encoder scores
 * the question against the passage *text*, so the refusal cannot hold here: the texts are exactly what
 * the model needs, and the only question is where the cap and the limit then happen. They happen in
 * Node, over the reranked ordering, because `row_number() <= n` cannot be computed in SQL over a score
 * SQL has not got.
 *
 * **The rerank is deliberately outside the transaction.** A forward pass over up to a hundred pairs is
 * hundreds of milliseconds at best; holding the search's transaction open across it would pin a pooled
 * connection for the duration on a server whose indexer is already competing for the same pool. So the
 * candidate statement commits, the model runs, and the page is fetched by id — which is safe here for
 * the same reason a generation is a value rather than a sub-select (ADR-0039): the ids belong to a
 * generation that is published and immutable until a swap replaces it wholesale.
 */
async function rerankedPage(db: Db, args: RerankedPageArgs): Promise<{ rows: HybridRow[] }> {
  const { scanSettings, fusedCandidates, pageToHits, rerank, queryText, limit, maxPerDocument, generation } = args;

  const candidates = await db.transaction(async (tx) => {
    await tx.execute(scanSettings);
    return tx.execute<CandidateRow>(sql`${fusedCandidates}
      select
        f.id,
        f.dense_rank::int as dense_rank,
        f.lexical_rank::int as lexical_rank,
        f.fused_score::float8 as fused_score,
        c.document_id,
        c.content
      from fused f
      join chunks c on c.id = f.id
      order by f.fused_score desc, f.dense_rank asc nulls last, f.id asc`);
  });
  if (candidates.rows.length === 0) return { rows: [] };

  const scores = await rerank(
    queryText,
    candidates.rows.map((row) => row.content),
  );

  // The fused position is the tie-break, not the score: equal logits are common between two excerpts of
  // one section, and falling back to the order the rows arrived in would be falling back to the fused
  // order anyway — but by accident rather than by decision.
  const reordered = candidates.rows
    .map((row, fusedPosition) => ({ row, fusedPosition, score: scores[fusedPosition] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.score - a.score || a.fusedPosition - b.fusedPosition);

  // The per-document cap and the limit, exactly as the SQL does them: count per document over the new
  // ordering, skip what is over the cap, and stop at `limit`. Skipping rather than stopping is what
  // "refilled from below" means, and it is the whole behaviour ADR-0042 measured.
  const perDocument = new Map<string, number>();
  const chosen: typeof reordered = [];
  for (const candidate of reordered) {
    const seen = (perDocument.get(candidate.row.document_id) ?? 0) + 1;
    perDocument.set(candidate.row.document_id, seen);
    if (seen > maxPerDocument) continue;
    chosen.push(candidate);
    if (chosen.length === limit) break;
  }
  if (chosen.length === 0) return { rows: [] };

  const values = sql.join(
    chosen.map(
      (candidate, ordinal) =>
        sql`(${candidate.row.id}::uuid, ${ordinal}::int, ${candidate.row.fused_score}::float8, ${candidate.row.dense_rank}::int, ${candidate.row.lexical_rank}::int)`,
    ),
    sql`, `,
  );
  // `fused_score` and the two ranks travel back out rather than being recomputed: `SearchHit` promises
  // what the *fusion* thought, and a rerank changes the order of the page without changing what either
  // retriever said about a chunk. A caller reading `lexicalRank` is asking which half found this.
  const page = sql`with page as (
        select v.id, v.ord, v.fused_score, v.dense_rank, v.lexical_rank, c.document_id, c.chunk_index
        from (values ${values}) as v(id, ord, fused_score, dense_rank, lexical_rank)
        join chunks c on c.id = v.id and c.index_generation = ${generation}
      )`;
  return db.execute<HybridRow>(pageToHits(page, sql`p.ord asc`));
}

export interface DocumentSummary {
  relativePath: string;
  title: string;
  chunkCount: number;
  sizeBytes: number;
  indexedAt: Date;
}

/**
 * One page of a project's documents, in the order they have always been listed
 * ([ADR-0043](../../.ssot/ADR.md#adr-0043)).
 *
 * **Keyset and not `OFFSET`.** `after` is the last `relative_path` of the previous page, and
 * `UNIQUE (project_id, index_generation, relative_path)` is what makes that a key rather than a guess:
 * the predicate is a range scan over the ordering the query already had, so page two costs what page
 * one cost, and a document written between two calls cannot shift a row from one page onto both.
 *
 * `limit` is what the caller wants to *show*; it is the caller that asks for one more than it needs to
 * learn whether a next page exists, because only the caller knows what it does with the answer.
 */
export async function listDocumentsForProject(
  db: Db,
  projectId: string,
  generation: number,
  page: { limit?: number; after?: string } = {},
): Promise<DocumentSummary[]> {
  const where = and(
    eq(documents.projectId, projectId),
    eq(documents.indexGeneration, generation),
    page.after === undefined ? undefined : gt(documents.relativePath, page.after),
  );
  const query = db
    .select({
      relativePath: documents.relativePath,
      title: documents.title,
      chunkCount: documents.chunkCount,
      sizeBytes: documents.sizeBytes,
      indexedAt: documents.indexedAt,
    })
    .from(documents)
    .where(where)
    .orderBy(asc(documents.relativePath));
  return page.limit === undefined ? query : query.limit(page.limit);
}

/**
 * A document's chunks in document order, optionally narrowed to a heading breadcrumb or to a range of
 * chunk indices ([ADR-0043](../../.ssot/ADR.md#adr-0043)).
 *
 * **The heading is matched against `chunks.heading_path` rather than re-parsed out of the text.** The
 * chunker already walked the document and wrote the breadcrumb of every chunk, so "the section called
 * X" is `heading_path = 'X'` — plus `heading_path LIKE 'X > %'`, which is what makes naming a parent
 * return the subsections under it. Case is folded because an agent copies a breadcrumb out of a search
 * result and a human types one, and the two differ by capitalisation far more often than by content.
 *
 * No generation predicate: `document_id` belongs to exactly one document, which belongs to exactly one
 * generation, so its id already carries one.
 */
export async function getDocumentChunks(
  db: Db,
  documentId: string,
  filter: { heading?: string; from?: number; to?: number } = {},
): Promise<Array<{ chunkIndex: number; headingPath: string; content: string; tokenCount: number }>> {
  const heading = filter.heading?.trim();
  const breadcrumb = heading ? `${escapeLikePattern(heading.toLowerCase())} > %` : undefined;
  return db
    .select({
      chunkIndex: chunks.chunkIndex,
      headingPath: chunks.headingPath,
      content: chunks.content,
      tokenCount: chunks.tokenCount,
    })
    .from(chunks)
    .where(
      and(
        eq(chunks.documentId, documentId),
        filter.from === undefined ? undefined : gte(chunks.chunkIndex, filter.from),
        filter.to === undefined ? undefined : lte(chunks.chunkIndex, filter.to),
        heading === undefined || heading === ''
          ? undefined
          : sql`(lower(${chunks.headingPath}) = ${heading.toLowerCase()} OR lower(${chunks.headingPath}) LIKE ${breadcrumb} ESCAPE '\\')`,
      ),
    )
    .orderBy(asc(chunks.chunkIndex));
}

/** Every heading breadcrumb of a document, in document order and without repeats — what an unmatched `heading` is answered with. */
export async function listDocumentHeadings(db: Db, documentId: string): Promise<string[]> {
  const rows = await db
    .selectDistinctOn([chunks.headingPath], { headingPath: chunks.headingPath, chunkIndex: chunks.chunkIndex })
    .from(chunks)
    .where(eq(chunks.documentId, documentId))
    .orderBy(asc(chunks.headingPath), asc(chunks.chunkIndex));
  return rows.map((r) => r.headingPath).filter((h) => h !== '');
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
  /**
   * The document's text as `read_document` will serve it — **the flavor-transformed string the chunker
   * was given**, not the bytes `contentHash` was taken over ([ADR-0043](../../.ssot/ADR.md#adr-0043)).
   *
   * Required rather than optional, and required on both writers. A caller that could leave it out is a
   * caller that can write a document which reads from the filesystem forever, and the compiler is the
   * only thing that would ever notice. `null` says "there is no text to store" deliberately.
   */
  content: string | null;
  /** Set by `storedDocumentContent`; a caller does not decide this for itself. */
  contentTruncated: boolean;
}

/**
 * What of a document's text is kept, and whether anything was left behind
 * ([ADR-0043](../../.ssot/ADR.md#adr-0043)).
 *
 * The cut is on **bytes** because the column's cost is bytes — but it is walked back to a character
 * boundary first. A `Buffer.subarray` that lands in the middle of a UTF-8 sequence decodes to a
 * `�`, and an agent handed one at the end of every truncated Turkish document would read it as
 * corruption of the source file rather than as a cap this product applied. Continuation bytes are
 * `10xxxxxx`, so stepping back over them until a lead byte is found is the whole of it, bounded at
 * three steps because no UTF-8 sequence is longer than four bytes.
 */
export function storedDocumentContent(text: string, maxBytes: number): { content: string; contentTruncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { content: text, contentTruncated: false };
  let end = maxBytes;
  for (let back = 0; back < 4 && end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000; back++) end--;
  return { content: buf.subarray(0, end).toString('utf8'), contentTruncated: true };
}

/**
 * Fallback for clients that remember pre-v3 paths (without the source prefix): the document whose path
 * ends with `/<suffix>`, but only when exactly one matches — within the live generation, so a rebuild
 * in flight cannot turn one match into two and make the fallback stop resolving.
 */
export async function getDocumentBySuffix(db: Db, projectId: string, generation: number, suffix: string): Promise<DocumentRow | undefined> {
  const pattern = `%/${escapeLikePattern(suffix)}`;
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
          // In the `SET` and not only in the `VALUES`: an incremental run re-writing a changed file
          // has to replace the text as well as the chunks, or `read_document` would serve the previous
          // revision of a document `search_docs` has already re-indexed (ADR-0043).
          content: doc.content,
          contentTruncated: doc.contentTruncated,
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
