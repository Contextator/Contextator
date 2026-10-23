-- Per-project quotas (0.4.0; ADR-0117): the project's own caps on documents, chunks and stored upload
-- bytes. NULL, the default for every existing row, means "use the instance value" (PROJECT_MAX_DOCUMENTS,
-- PROJECT_MAX_CHUNKS, PROJECT_MAX_UPLOAD_BYTES); 0 means unlimited. Nothing is backfilled and no existing
-- value changes, so an upgrade enforces nothing until an operator sets a number.
--
-- Down path: DROP CONSTRAINT the three *_check constraints, then DROP COLUMN "max_documents",
-- "max_chunks", "max_upload_bytes"; the only data lost is the caps themselves.

ALTER TABLE "projects" ADD COLUMN "max_documents" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "max_chunks" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "max_upload_bytes" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_max_documents_check" CHECK ("projects"."max_documents" is null or "projects"."max_documents" >= 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_max_chunks_check" CHECK ("projects"."max_chunks" is null or "projects"."max_chunks" >= 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_max_upload_bytes_check" CHECK ("projects"."max_upload_bytes" is null or "projects"."max_upload_bytes" >= 0);