CREATE TABLE "floor_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"embedding_model" text NOT NULL,
	"live_generation" integer NOT NULL,
	"suggested_floor" double precision NOT NULL,
	"previous_floor" double precision,
	"basis" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "floor_suggestions_trigger_check" CHECK ("floor_suggestions"."trigger" in ('model_change', 'operator')),
	CONSTRAINT "floor_suggestions_floor_check" CHECK ("floor_suggestions"."suggested_floor" > 0 and "floor_suggestions"."suggested_floor" <= 1)
);
--> statement-breakpoint
ALTER TABLE "floor_suggestions" ADD CONSTRAINT "floor_suggestions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "floor_suggestions_project_created_idx" ON "floor_suggestions" USING btree ("project_id","created_at" DESC NULLS FIRST);