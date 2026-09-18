-- Hybrid retrieval (ADR-0041): the lexical half of search, beside the dense one.
--
-- `content_tsv` is nullable and is written by `replaceDocument`, not by a `GENERATED ALWAYS AS …
-- STORED` expression. A generated column would have to name one text search configuration for the
-- whole table, and the configuration is the one thing that has to be able to vary per source.
--
-- **Nothing is rewritten here, and nothing is backfilled here.** `ADD COLUMN` with no default is
-- catalogue-only, and the GIN index is built over a column that is NULL in every existing row, so it
-- is empty and instant however large `chunks` is. The rows are filled afterwards, in batches and
-- outside this transaction, by `backfillContentTsv` in `src/db/bootstrap.ts` — which is a loop over
-- rows and therefore not something `drizzle-kit generate` can emit. Until it has run, a chunk's
-- `content_tsv @@ query` is NULL rather than true, so the row is absent from the lexical candidate
-- list and sits exactly where dense-only retrieval had it.
--
-- Rolling back is the two statements below, reversed, and costs nothing else: no other column, no
-- constraint and no code path outside `searchChunks` and `replaceDocument` depends on either.
--
--   DROP INDEX chunks_content_tsv_idx;
--   ALTER TABLE chunks DROP COLUMN content_tsv;

ALTER TABLE "chunks" ADD COLUMN "content_tsv" "tsvector";--> statement-breakpoint
CREATE INDEX "chunks_content_tsv_idx" ON "chunks" USING gin ("content_tsv");
