-- The Notion webhook (ADR-0049): a secret that arrives inbound, a window in which it may be stored,
-- and a claim a delivery leaves for the scheduler's existing tick.
--
-- **Three nullable columns with no default, so this migration switches nothing on and starts nothing.**
-- Every source that already exists carries NULL in all three: no verification window is open, no
-- delivery has claimed anything, and `webhook_min_interval_minutes` NULL means the instance's
-- `WEBHOOK_MIN_INTERVAL_MINUTES`. `ADD COLUMN` with no default is catalogue-only on PostgreSQL 11+, so
-- nothing rewrites a table. Note that NULL means something different here than it does one column
-- along: `sync_interval_minutes` NULL is *never scheduled*, while `webhook_min_interval_minutes` NULL
-- is *whatever the instance currently says* — a schedule is per source, a debounce is instance policy.
--
-- `webhook_secret` is reused rather than joined by a second column: it already means "the shared secret
-- a delivery to this source is signed with", which is exactly what Notion's `verification_token` is.
-- What differs is who generated it, and that is a fact about the flow rather than about the column.
--
-- `document_sources_webhook_due_idx` is the second half of the scheduler's only query. Since ADR-0049
-- the tick takes sources that are due **for either reason**, so the `WHERE` is an OR across two partial
-- indexes; this one matches nothing on an installation with no Notion webhook, exactly as
-- `document_sources_due_idx` matches nothing on one that schedules nothing.
--
-- **Rolling back is dropping the index and the three columns, and nothing else.** No row is rewritten
-- and a previous build ignores columns it does not select:
--
--   DROP INDEX document_sources_webhook_due_idx;
--   ALTER TABLE document_sources DROP COLUMN webhook_min_interval_minutes;
--   ALTER TABLE document_sources DROP COLUMN webhook_due_at;
--   ALTER TABLE document_sources DROP COLUMN webhook_verification_expires_at;
--
-- A captured Notion token stays behind in `webhook_secret`, where an older build reads it only for git
-- sources and therefore never uses it.

ALTER TABLE "document_sources" ADD COLUMN "webhook_verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "webhook_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "webhook_min_interval_minutes" integer;--> statement-breakpoint
CREATE INDEX "document_sources_webhook_due_idx" ON "document_sources" USING btree ("webhook_due_at") WHERE webhook_due_at is not null;