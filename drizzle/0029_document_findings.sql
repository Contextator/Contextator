CREATE TABLE "document_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"line" integer NOT NULL,
	"col" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"length" integer NOT NULL,
	"preview" text NOT NULL,
	"value_hmac" text,
	"hmac_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_findings_rule_check" CHECK ("document_findings"."rule" in ('aws_access_key', 'github_token', 'private_key', 'jwt', 'tckn', 'iban'))
);
--> statement-breakpoint
CREATE TABLE "document_scans" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"ruleset" smallint NOT NULL,
	"content_hash" text NOT NULL,
	"hmac_key_id" text,
	"finding_count" integer NOT NULL,
	"capped" boolean NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_scans_status_check" CHECK ("document_scans"."status" in ('scanned', 'no_content'))
);
--> statement-breakpoint
ALTER TABLE "document_findings" ADD CONSTRAINT "document_findings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_findings" ADD CONSTRAINT "document_findings_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_scans" ADD CONSTRAINT "document_scans_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_scans" ADD CONSTRAINT "document_scans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_findings_project_rule_idx" ON "document_findings" USING btree ("project_id","rule");--> statement-breakpoint
CREATE INDEX "document_findings_document_idx" ON "document_findings" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_findings_project_hmac_idx" ON "document_findings" USING btree ("project_id","value_hmac") WHERE value_hmac is not null;--> statement-breakpoint
CREATE INDEX "document_scans_project_idx" ON "document_scans" USING btree ("project_id");