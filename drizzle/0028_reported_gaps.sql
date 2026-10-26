CREATE TABLE "reported_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mcp_token_id" uuid,
	"rate_key" text NOT NULL,
	"query" text NOT NULL,
	"query_norm" text NOT NULL,
	"note" text,
	"live_generation" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reported_gaps" ADD CONSTRAINT "reported_gaps_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_gaps" ADD CONSTRAINT "reported_gaps_mcp_token_id_fkey" FOREIGN KEY ("mcp_token_id") REFERENCES "public"."mcp_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reported_gaps_project_created_idx" ON "reported_gaps" USING btree ("project_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "reported_gaps_project_key_created_idx" ON "reported_gaps" USING btree ("project_id","rate_key","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "reported_gaps_created_idx" ON "reported_gaps" USING btree ("created_at");