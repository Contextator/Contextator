-- A per-project relevance floor (Faz 17, branch 17-score-floor; ADR-0042's floor, overridable per
-- project). Nullable with no default: every row that predates this migration reads as NULL, which
-- `searchProject` resolves to SEARCH_SCORE_FLOOR — so an untouched project behaves exactly as before.
--
-- Down path: DROP CONSTRAINT then DROP COLUMN; the only data lost is the operators' overrides, which
-- nothing else derives from.
--
--   ALTER TABLE projects DROP CONSTRAINT projects_score_floor_check;
--   ALTER TABLE projects DROP COLUMN score_floor;

ALTER TABLE "projects" ADD COLUMN "score_floor" double precision;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_score_floor_check" CHECK ("projects"."score_floor" is null or ("projects"."score_floor" >= 0 and "projects"."score_floor" <= 1));