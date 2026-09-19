-- Scheduled sync (ADR-0048): the server decides when a source is due, probes it for a cheap revision
-- token, and enqueues a run only when that token moved.
--
-- **Every existing source is switched off by this migration, and that is the point.** All three
-- columns are nullable with no default, so `sync_interval_minutes` is NULL on every row that already
-- exists — and NULL means "never scheduled". An upgrade therefore starts no outbound traffic nobody
-- asked for (NFR-10); an operator switches sources on one at a time, and only a *newly created*
-- source is given `SYNC_DEFAULT_INTERVAL_MINUTES`. `ADD COLUMN` with no default is catalogue-only on
-- PostgreSQL 11+, so none of this rewrites a table.
--
-- `document_sources_due_idx` is the scheduler's only query — "which sources are due", once a minute.
-- Partial on `sync_interval_minutes IS NOT NULL`, because on an upgraded installation that predicate
-- matches nothing and the index then costs a catalogue row and no pages. `NULLS FIRST` is stated
-- because it is *not* PostgreSQL's default for an ascending column, and the tick orders that way: a
-- source whose interval was set by hand, with no due time yet, is the oldest claim there is.
--
-- `index_runs.trigger` is nullable on purpose rather than defaulted to 'manual': a run recorded
-- before this column existed was not necessarily manual (a git webhook could have queued it), and
-- `generation` set the precedent one column along — NULL means "recorded before the column existed"
-- and never a value the code chose. NULL passes the `IN` check, which is what lets those rows stay.
--
-- **Rolling back is dropping the three columns, and nothing else.** No row is rewritten, no
-- constraint is replaced, and a previous build ignores columns it does not select:
--
--   DROP INDEX document_sources_due_idx;
--   ALTER TABLE index_runs DROP CONSTRAINT index_runs_trigger_check;
--   ALTER TABLE index_runs DROP COLUMN trigger;
--   ALTER TABLE document_sources DROP COLUMN next_sync_at;
--   ALTER TABLE document_sources DROP COLUMN sync_interval_minutes;
--
-- The probe tokens the drivers wrote stay behind in `document_sources.config` as an unread key; the
-- zod schemas of an older build strip it on the next source edit.

ALTER TABLE "document_sources" ADD COLUMN "sync_interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "index_runs" ADD COLUMN "trigger" text;--> statement-breakpoint
CREATE INDEX "document_sources_due_idx" ON "document_sources" USING btree ("next_sync_at" NULLS FIRST) WHERE sync_interval_minutes is not null;--> statement-breakpoint
ALTER TABLE "index_runs" ADD CONSTRAINT "index_runs_trigger_check" CHECK ("index_runs"."trigger" in ('manual', 'webhook', 'scheduled'));