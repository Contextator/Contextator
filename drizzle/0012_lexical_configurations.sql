-- One lexical configuration per chunk (ADR-0064), which is what makes a project able to hold a
-- Turkish source and an English one and have a single search reach both.
--
-- `content_tsv` does not remember the configuration it was built with, so until now the only way to
-- keep the query side matching it was for the whole instance to parse every question with one
-- configuration — `simple` — and that is what kept every stemmed source out of the lexical half.
-- With the configuration recorded per row, the search statement can ask the project which
-- configurations it holds and build one `@@` for each.
--
-- **Nothing is rewritten here.** `ADD COLUMN` with a constant default is catalogue-only since
-- PostgreSQL 11, so every existing chunk reads `simple` at no cost — which is what every chunk of a
-- default installation genuinely is. The rows of a source that *names* a language are moved to that
-- language afterwards, in batches and outside this transaction, by `reconcileTextSearchConfigs` in
-- `src/db/bootstrap.ts`; it rewrites `content_tsv` with them, because the two describe each other
-- and only the column can be read back. That is a loop over rows and therefore not something
-- `drizzle-kit generate` can emit. Until it has run, such a chunk is indexed in its language and
-- labelled `simple`, so it is asked the `simple` question — exactly the behaviour it had before this
-- migration, which is the property that makes the interval between the two steps uninteresting.
--
-- **The index is dropped and rebuilt rather than added beside.** `chunks_project_generation_idx` is
-- what the search's `corpus` CTE already counts a project's chunks through; with
-- `text_search_config` appended, that same index-only scan also yields the per-configuration counts
-- the commonness threshold needs, and no second index has to be maintained on every insert. Every
-- existing user of it reads the two-column prefix and is unaffected. It costs one index build over
-- `chunks` at upgrade, which is the one expensive statement in this file and is the reason it is not
-- three.
--
-- Rolling back is the three statements below, reversed:
--
--   DROP INDEX chunks_project_generation_idx;
--   ALTER TABLE chunks DROP COLUMN text_search_config;
--   CREATE INDEX chunks_project_generation_idx ON chunks USING btree (project_id, index_generation);

DROP INDEX "chunks_project_generation_idx";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "text_search_config" text DEFAULT 'simple' NOT NULL;--> statement-breakpoint
CREATE INDEX "chunks_project_generation_idx" ON "chunks" USING btree ("project_id","index_generation","text_search_config");
