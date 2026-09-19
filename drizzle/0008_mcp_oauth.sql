-- MCP OAuth 2.1 and token identity (ADR-0054): a credential that names a person, a third access mode
-- that insists on one, and the client table an OAuth flow needs before it can hand one out.
--
-- **Nothing here changes what any existing credential reaches.** `user_id` arrives NULL on every row
-- that already exists and NULL means what it has always meant — a bearer credential for the endpoint,
-- with no account behind it and the run of the project. A backfill that attached each token to the
-- account that happened to mint it would have changed what a working agent can read, on an upgrade
-- nobody asked for; `created_by` records who minted a token, which is a different fact from who it
-- acts as, and this migration deliberately declines to confuse the two (NFR-10).
--
-- `kind` defaults to `static` for the same reason: a default is a backfill nobody has to run, and
-- every row written before this column existed *is* a static token.
--
-- The `projects_mcp_auth_check` DROP/ADD is a widening and only a widening — `('open', 'token')`
-- becomes `('open', 'token', 'account')`. No row can violate the new constraint, so PostgreSQL's
-- validation scan over `projects` finds nothing to complain about; it is also the reason the rollback
-- below has an order it has to be done in.
--
-- `mcp_tokens_expires_idx` is partial on `expires_at IS NOT NULL`, so it is an empty index on an
-- installation that never issues an OAuth token — the shape `document_sources_due_idx` already uses.
--
-- **Rolling back is dropping what this added, in this order, and nothing else.** No existing row is
-- rewritten, and a previous build ignores columns it does not select:
--
--   ALTER TABLE projects DROP CONSTRAINT projects_mcp_auth_check;
--   UPDATE projects SET mcp_auth = 'token' WHERE mcp_auth = 'account';
--   ALTER TABLE projects ADD CONSTRAINT projects_mcp_auth_check CHECK (mcp_auth in ('open', 'token'));
--   ALTER TABLE mcp_tokens DROP CONSTRAINT mcp_tokens_kind_check;
--   DELETE FROM mcp_tokens WHERE kind <> 'static';
--   ALTER TABLE mcp_tokens DROP COLUMN expires_at, DROP COLUMN client_id, DROP COLUMN user_id, DROP COLUMN kind;
--   DROP TABLE oauth_clients;
--
-- The `UPDATE` and the `DELETE` are the two lines that are not mechanical, and they are the two an
-- operator has to decide about: a project left at `account` would fail the narrowed constraint, and
-- `token` is the mode that keeps it closed rather than opening it. The OAuth credentials go because
-- the build being rolled back to cannot verify one — leaving them would leave rows that authenticate
-- against a check that no longer knows they expire. `search_queries.mcp_token_id` is SET NULL, so the
-- query log keeps its rows and loses only the attribution of the searches those sessions made.

CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_mcp_auth_check";--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "kind" text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "oauth_clients_last_used_idx" ON "oauth_clients" USING btree ("last_used_at");--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tokens_user_idx" ON "mcp_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_expires_idx" ON "mcp_tokens" USING btree ("expires_at") WHERE expires_at is not null;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_kind_check" CHECK ("mcp_tokens"."kind" in ('static', 'access', 'refresh'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_mcp_auth_check" CHECK ("projects"."mcp_auth" in ('open', 'token', 'account'));