CREATE TABLE "mcp_token_sources" (
	"token_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "mcp_token_sources_pkey" PRIMARY KEY("token_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "source_scoped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_token_sources" ADD CONSTRAINT "mcp_token_sources_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token_sources" ADD CONSTRAINT "mcp_token_sources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."document_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_token_sources_source_idx" ON "mcp_token_sources" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_source_scope_static_check" CHECK (NOT "mcp_tokens"."source_scoped" OR "mcp_tokens"."kind" = 'static');