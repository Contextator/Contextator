-- Where each document lives at its origin and when the origin last changed it (0.4.0; ADR-0116).
-- Both nullable with no default: every document that predates this migration reads as NULL, "not known
-- yet", and the next run of its source fills them in without re-embedding anything. Nothing is
-- backfilled here and no existing value changes.
--
-- Down path: DROP COLUMN "source_url", DROP COLUMN "source_modified_at"; the only data lost is what the
-- next run would write again, because both are derived from the source and nothing derives from them.

ALTER TABLE "documents" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_modified_at" timestamp with time zone;
