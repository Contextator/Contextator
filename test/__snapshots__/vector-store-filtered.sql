
      with 
      filtered_documents as materialized (
        -- The filters, resolved to document ids **once**, so each candidate CTE below carries one
        -- hash semi-join rather than its own copy of three predicates. Served by
        -- documents_project_generation_idx.
        select id from documents
        where project_id = $1 and index_generation = $2
          and source_id = $3
          and relative_path like $4 escape '\'
          -- Equality, and no ordering (ADR-0058). A version is a label rather than a number, and the
          -- column is NOT NULL with the empty string standing for "unversioned" — so this is a plain
          -- equals with no third state for a predicate to remember.
          and version = $5
      ),
      corpus as (
        -- **One row per text search configuration this project's index actually holds**
        -- ([ADR-0064](../../.ssot/ADR.md#adr-0064)), and for each of them how many chunks the question
        -- is being asked of — which is what "this word is everywhere" means for that half of the
        -- corpus. Served by chunks_project_generation_idx as an index-only scan, which is the reason
        -- text_search_config was appended to it: this CTE already counted the project's chunks
        -- through that index and now groups the same scan instead.
        --
        -- **Deliberately the whole project, filters or not** (ADR-0042). How much a term says about
        -- which chunk is a property of the corpus, not of the slice somebody asked about; counting it
        -- over a filtered subset would make the same question mean different things under different
        -- filters, and a filter narrow enough to matter would fall under the floor below and drop
        -- nothing at all.
        --
        -- **A configuration is such a slice, so the threshold stays the project's and only the probe
        -- below is split** ([ADR-0064](../../.ssot/ADR.md#adr-0064)). The probe has no choice: a lexeme
        -- produced by turkish is a different string from the one simple produces and can only ever
        -- match chunks written by turkish, so it has to be counted against those. The threshold does
        -- have a choice, and it is a close one rather than an obvious one, so what decided it is
        -- written down. Dividing the threshold by configuration judges each half of a corpus against
        -- half the denominator it used to have, and that moves 17 of the 92 eval questions — not a
        -- rounding. It wins at rank 1 (recall@1 58 → 60, heading@1 57 → 59) and it is level at both
        -- gated metrics (recall@5 66, heading@5 64). What it loses is elsewhere and is the reason it
        -- is not taken: gatedWithAnswer goes 0 → 1, because x-en-tr-03 drops from the first result
        -- to the second and under the relevance floor with it, so the product would answer "no good
        -- match" to a question whose answer it had in hand. ADR-0045 reports that number and never
        -- gates on it, which is exactly why a statement must not trade against it quietly. The second
        -- reason is that LEXICAL_TERM_MAX_DOCUMENT_FREQUENCY was swept against a project's total chunk
        -- count; halving its denominator re-tunes a measured constant without re-measuring it.
        -- sum(count(*)) over () is the project's total off this one grouped scan.
        --
        -- What that leaves open is a term that is in every chunk of one small stemmed source inside a
        -- large project: it is under the project's threshold and survives. That is the same tolerance
        -- LEXICAL_TERM_MIN_DOCUMENT_FLOOR already grants a small project, not a new hole, and it will
        -- be a measurement rather than an argument the day a corpus shows it.
        select
          c.text_search_config as config,
          greatest(
            ceil(sum(count(*)) over () * $6::float8),
            $7::float8
          )::int as common_at
        from chunks c where c.project_id = $8 and c.index_generation = $9
        group by c.text_search_config
      ),
      question as materialized (
        -- The question's lexemes, quoted as tsquery literals and OR-ed — minus the ones that are in so
        -- many of this project's chunks that they say nothing about which chunk. quote_literal is what
        -- makes this safe as well as correct: tsquery's quoting rule for a lexeme is SQL's, so a term
        -- carrying an apostrophe survives instead of ending the literal.
        --
        -- **One question per configuration, parsed the way that configuration's chunks were written.**
        -- The same sentence becomes different lexemes in each — "anahtarını" is 'anahtar' under
        -- turkish and 'anahtarını' under simple — and each of those only ever meets the chunks
        -- that speak it, because the config travels with the row into the join below. The cast is of
        -- a *column* to regconfig, which is a catalogue lookup and not string interpolation; the
        -- values come from chunks.text_search_config, which only replaceDocument writes and only
        -- from a TextSearchConfig.
        --
        -- A configuration all of whose lexemes were dropped as too common produces **no row** here
        -- rather than a NULL one, and a configuration for which the question has no lexemes at all —
        -- pure punctuation — does the same. Either way that half contributes no lexical candidates,
        -- which is what the single string_agg over nothing used to achieve by returning NULL.
        --
        -- The count is capped by the LIMIT: this asks "are there at least common_at of them", not "how
        -- many are there", so a word that is genuinely everywhere costs the same as one that is not.
        select corpus.config, string_agg(quote_literal(t.lexeme), ' | ')::tsquery as q
        from corpus, unnest(to_tsvector(corpus.config::regconfig, $10)) t
        where (
          select count(*) from (
            select 1 from chunks c
            where c.project_id = $11 and c.index_generation = $12
              and c.text_search_config = corpus.config
              and c.content_tsv @@ quote_literal(t.lexeme)::tsquery
            limit corpus.common_at
          ) probe
        ) < corpus.common_at
        group by corpus.config
      ),
      dense_candidates as materialized (
        -- c.chunk_index is carried for the tie-break below and for nothing else. It is a column of the
        -- projection, not of the ORDER BY, which is the distinction the comment below is about.
        select c.id, (c.embedding <=> $13::vector) as distance, c.chunk_index
        from chunks c
        -- The project predicate also picks the project's own partial HNSW index (src/db/vector-indexes.ts):
        -- it must stay a plain equality on the bound id, or the planner cannot prove that index applies.
        where c.project_id = $14 and c.index_generation = $15 and c.document_id in (select id from filtered_documents)
        -- One sort key, and no tie-break. A second ORDER BY column here is not free: the HNSW index
        -- can only satisfy an ordering it produces itself, so adding c.id makes the whole clause
        -- unsatisfiable by the index and PostgreSQL falls back to reading the project's rows and
        -- sorting them exactly. That is correct, which is what makes it dangerous — it looks like a
        -- tidying change and it quietly turns the vector index off. The ranks are made deterministic
        -- in the dense CTE below instead, where the sort is over fifty rows and costs nothing.
        order by c.embedding <=> $16::vector
        limit $17
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
        --
        -- **LEXICAL_CANDIDATES per configuration, taken inside a lateral, and not one list of fifty
        -- cut by ts_rank_cd** ([ADR-0064](../../.ssot/ADR.md#adr-0064)). ts_rank_cd divides by term
        -- frequencies of the configuration it was computed in, so a turkish 0.09 and a simple 0.09
        -- are not the same evidence and neither is larger than the other. Sorting the two together and
        -- keeping the top fifty would silently let whichever configuration happens to score higher on
        -- this corpus evict the other's best chunks before anything downstream could see them.
        -- Truncating each configuration's own list is the one cut that needs no comparison between
        -- them. With a single configuration present — which is every installation that has set no
        -- source language — this is one lateral over one row and the same fifty rows in the same
        -- order the statement has always produced.
        select l.id, l.config, l.rank_score, l.content_length, l.chunk_index
        from question q
        join lateral (
          select
            c.id,
            q.config as config,
            ts_rank_cd(c.content_tsv, q.q, 1) as rank_score,
            length(c.content) as content_length,
            c.chunk_index
          from chunks c
          where c.project_id = $18 and c.index_generation = $19 and c.document_id in (select id from filtered_documents)
            and c.text_search_config = q.config
            and c.content_tsv @@ q.q
          -- What is left of the ties is broken by properties of the corpus rather than of the database:
          -- the shorter chunk first, then the earlier one in its document. c.id stays as a backstop so
          -- the ordering is total, and it should now almost never be reached.
          order by ts_rank_cd(c.content_tsv, q.q, 1) desc, length(c.content) asc, c.chunk_index asc, c.id
          limit $20
        ) l on true
      ),
      lexical as (
        -- **A rank within its own configuration**, for the reason the candidate list is cut per
        -- configuration: the number this produces is what RRF consumes, and RRF is positional, so a
        -- rank is comparable across configurations exactly where the score it was derived from is not.
        -- Each configuration present is therefore its own ranked list in the fusion below — which is
        -- what reciprocal rank fusion is defined over — rather than an attempt to reduce incomparable
        -- scores to one ordering.
        --
        -- A chunk carries exactly one configuration, so it appears in exactly one partition: no chunk
        -- can collect two lexical contributions, and fused_score stays in the range and the shape
        -- ADR-0041 measured. With one configuration present the partition is the whole list and this
        -- is the window it has always been.
        select
          id,
          row_number() over (partition by config order by rank_score desc, content_length asc, chunk_index asc, id) as rank
        from lexical_candidates
      ),
      fused as (
        select
          coalesce(d.id, l.id) as id,
          d.rank as dense_rank,
          l.rank as lexical_rank,
          coalesce(1.0 / ($21 + d.rank), 0) + coalesce(1.0 / ($22 + l.rank), 0) as fused_score
        from dense d full outer join lexical l on l.id = d.id
      ),
      capped as (
        -- The per-document cap (ADR-0042), as a window over the fused ordering rather than as a pass
        -- in Node: refilling from the candidates below a capped excerpt is what row_number() <= n
        -- does for free, over a pool that is already here. The partition's ORDER BY is the fused
        -- ordering itself, so the excerpts a document keeps are its best ones and not an arbitrary two.
        --
        -- The join to documents is ADR-0067's, and it costs nothing here: this runs over the fused
        -- pool -- fifty dense candidates plus fifty for each configuration the project holds, so a
        -- hundred rows with one and a hundred and fifty with two -- and it is a lookup on the primary
        -- key. relative_path and the content length are carried out of it so that the page below and
        -- the select list that renders the page can order on the same corpus properties this window
        -- does.
        select
          f.id,
          f.dense_rank,
          f.lexical_rank,
          f.fused_score,
          c.document_id,
          c.chunk_index,
          length(c.content) as content_length,
          doc.relative_path as relative_path,
          row_number() over (partition by c.document_id order by f.fused_score desc, f.dense_rank asc nulls last, length(c.content) asc, doc.relative_path asc, c.chunk_index asc, f.id asc) as per_document
        from fused f
        join chunks c on c.id = f.id
        join documents doc on doc.id = c.document_id
      ),
      page as materialized (
        -- Materialised so that the limit happens *before* the two neighbour lookups in the select
        -- list below. Inlined, PostgreSQL would project them over every fused candidate and then
        -- discard all but a page of the work.
        select * from capped
        where per_document <= $23
        order by fused_score desc, dense_rank asc nulls last, content_length asc, relative_path asc, chunk_index asc, id asc
        limit $24
      )
      select
        (1 - (c.embedding <=> $25::vector))::float8 as score,
        p.fused_score::float8 as fused_score,
        p.dense_rank::int as dense_rank,
        p.lexical_rank::int as lexical_rank,
        doc.relative_path as file,
        doc.title as title,
        c.heading_path as heading_path,
        c.content as content,
        c.chunk_index as chunk_index,
        (select string_agg(n.content, $26 order by n.chunk_index)
             from chunks n
             where n.document_id = p.document_id and n.index_generation = $27
               and n.chunk_index between p.chunk_index - $28
                                     and p.chunk_index - 1) as context_before,
        (select string_agg(n.content, $29 order by n.chunk_index)
             from chunks n
             where n.document_id = p.document_id and n.index_generation = $30
               and n.chunk_index between p.chunk_index + 1
                                     and p.chunk_index + $31) as context_after,
        doc.source_url as source_url,
        doc.source_modified_at as source_modified_at
      from page p
      join chunks c on c.id = p.id
      join documents doc on doc.id = c.document_id
      order by p.fused_score desc, p.dense_rank asc nulls last, p.content_length asc, p.relative_path asc, p.chunk_index asc, p.id asc