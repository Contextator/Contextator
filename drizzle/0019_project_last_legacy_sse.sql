-- When a legacy HTTP+SSE client last reached each project (Faz 05 of 0.2.1; ADR-0096). Nullable with
-- no default: every project that predates this migration reads as NULL, "no legacy client seen", which
-- is what the dashboard shows until one connects. Nothing is backfilled and no existing value changes.
--
-- Down path: DROP COLUMN; the only data lost is the advisory timestamp, which nothing derives from and
-- the next legacy SSE request writes again.
--
--   ALTER TABLE projects DROP COLUMN last_legacy_sse_at;

ALTER TABLE "projects" ADD COLUMN "last_legacy_sse_at" timestamp with time zone;