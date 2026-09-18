-- Index generations (ADR-0039): a rebuild writes beside the live index and the project is switched
-- over in one row update, so a forced run is invisible to the clients connected to the project.
--
-- The four columns are additive and default to 0, which is every existing project's live generation,
-- so an installation is migrated by the defaults and no row is rewritten. `ADD COLUMN … DEFAULT 0 NOT
-- NULL` is catalogue-only on PostgreSQL 11+, so this costs no table rewrite either.
--
-- **Rolling back needs a down path, and it is not just dropping these columns.** The old
-- `replaceDocument` upserts on `(project_id, relative_path)`, so restoring that constraint is what a
-- previous build actually needs — and it cannot be restored while two generations of a document exist.
-- In this order:
--
--   DELETE FROM documents d USING projects p
--     WHERE d.project_id = p.id AND d.index_generation <> p.live_generation;  -- chunks cascade
--   ALTER TABLE documents DROP CONSTRAINT documents_project_generation_path_uq;
--   ALTER TABLE documents ADD CONSTRAINT documents_project_path_uq UNIQUE (project_id, relative_path);
--   DROP INDEX documents_project_generation_idx;
--   DROP INDEX chunks_project_generation_idx;
--   ALTER TABLE projects DROP COLUMN live_generation;
--   ALTER TABLE index_runs DROP COLUMN generation;
--   ALTER TABLE documents DROP COLUMN index_generation;
--   ALTER TABLE chunks DROP COLUMN index_generation;

ALTER TABLE "documents" DROP CONSTRAINT "documents_project_path_uq";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "index_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "index_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_runs" ADD COLUMN "generation" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "live_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "chunks_project_generation_idx" ON "chunks" USING btree ("project_id","index_generation");--> statement-breakpoint
CREATE INDEX "documents_project_generation_idx" ON "documents" USING btree ("project_id","index_generation");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_generation_path_uq" UNIQUE("project_id","index_generation","relative_path");