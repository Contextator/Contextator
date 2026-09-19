-- Audit log (ADR-0055): who changed this instance, and what they changed. One row per state-changing
-- admin request that succeeded, written by the policy layer that already resolved the actor.
--
-- **One new table and nothing else.** No column is added to an existing table, no row is rewritten,
-- and nothing already stored is read by this migration — so an installation that applies it and then
-- runs the previous build is the installation it was, carrying a table that build never selects from.
--
-- **The constraints are the feature.** `actor_label` NOT NULL and non-empty is what makes "there is
-- no anonymous event" a property of the database rather than a habit of one call site:
-- `actor_user_id` may end up NULL when an account is deleted (`ON DELETE SET NULL` — deleting a
-- person must not delete the record of what they did), and the label copied at the time is what keeps
-- the row attributed afterwards. `audit_events_actor_user_check` keeps `ADMIN_TOKEN`, which has no
-- account row, from ever carrying one.
--
-- **`project_id` deliberately has no foreign key.** Deleting a project is itself one of the events
-- this table records, so a key to `projects` would refuse that row or erase it — the reasoning that
-- already keeps `search_query_hits` on a path rather than a `document_id`.
--
-- **This is not the query log and must not become it.** `search_queries` holds what agents asked, in
-- the clear, under a thirty-day window because it is user content; this holds what an operator did,
-- under a longer one because it is accountability. No column here can carry a question, a document or
-- an excerpt: `detail` only ever receives values from a closed set named in `src/auth/policy.ts`.
--
-- **Rolling back is dropping the table, and nothing else:**
--
--   DROP TABLE audit_events;
--
-- Its three indexes and its foreign key go with it. Nothing outside it refers to it.

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"actor_ip" text,
	"project_id" uuid,
	"target_type" text,
	"target_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_code" integer NOT NULL,
	CONSTRAINT "audit_events_actor_kind_check" CHECK ("audit_events"."actor_kind" in ('user', 'token')),
	CONSTRAINT "audit_events_actor_label_check" CHECK (length(btrim("audit_events"."actor_label")) > 0),
	CONSTRAINT "audit_events_actor_user_check" CHECK ("audit_events"."actor_kind" = 'user' or "audit_events"."actor_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_project_created_idx" ON "audit_events" USING btree ("project_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_created_idx" ON "audit_events" USING btree ("actor_user_id","created_at" DESC NULLS FIRST);