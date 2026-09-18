CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"mcp_token_id" uuid,
	"query" text NOT NULL,
	"query_norm" text NOT NULL,
	"result_limit" integer NOT NULL,
	"filter_source" text,
	"filter_path_prefix" text,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"top_score" double precision,
	"below_floor" boolean DEFAULT false NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"embedding_model" text NOT NULL,
	"live_generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "search_queries_actor_check" CHECK ("search_queries"."actor" in ('mcp', 'dashboard'))
);
--> statement-breakpoint
CREATE TABLE "search_query_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"relative_path" text NOT NULL,
	"heading_path" text DEFAULT '' NOT NULL,
	"chunk_index" integer NOT NULL,
	"score" double precision NOT NULL,
	CONSTRAINT "search_query_hits_query_rank_uq" UNIQUE("query_id","rank")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "query_log_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_mcp_token_id_fkey" FOREIGN KEY ("mcp_token_id") REFERENCES "public"."mcp_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_query_hits" ADD CONSTRAINT "search_query_hits_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "public"."search_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_queries_project_created_idx" ON "search_queries" USING btree ("project_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "search_queries_created_idx" ON "search_queries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_queries_project_norm_idx" ON "search_queries" USING btree ("project_id","query_norm");--> statement-breakpoint
CREATE INDEX "search_query_hits_path_idx" ON "search_query_hits" USING btree ("relative_path");