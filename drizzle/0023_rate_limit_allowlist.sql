CREATE TABLE "mcp_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "allowed_cidrs" "cidr"[];--> statement-breakpoint
CREATE INDEX "mcp_rate_limits_window_idx" ON "mcp_rate_limits" USING btree ("window_start");