CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"generation" integer NOT NULL,
	"embedding_model" text NOT NULL,
	"question_count" integer NOT NULL,
	"scored_count" integer NOT NULL,
	"recall5" double precision,
	"mrr" double precision,
	"regressed" boolean DEFAULT false NOT NULL,
	"compared_to" uuid,
	"lost_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"skipped_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"newly_skipped_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"results" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "eval_runs_trigger_check" CHECK ("eval_runs"."trigger" in ('index_rebuild', 'index_incremental', 'golden_set', 'manual')),
	CONSTRAINT "eval_runs_status_check" CHECK ("eval_runs"."status" in ('ok', 'error')),
	CONSTRAINT "eval_runs_figures_check" CHECK (("eval_runs"."status" = 'ok' and "eval_runs"."recall5" is not null and "eval_runs"."mrr" is not null) or ("eval_runs"."status" = 'error' and "eval_runs"."error" is not null))
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_runs_project_started_idx" ON "eval_runs" USING btree ("project_id","started_at" DESC NULLS FIRST);