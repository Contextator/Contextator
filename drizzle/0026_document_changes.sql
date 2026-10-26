CREATE TABLE "document_changes" (
	"project_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"change" text NOT NULL,
	"title" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"added_at" timestamp with time zone,
	"changed_at" timestamp with time zone NOT NULL,
	"run_id" uuid,
	CONSTRAINT "document_changes_pkey" PRIMARY KEY("project_id","relative_path"),
	CONSTRAINT "document_changes_change_check" CHECK ("document_changes"."change" in ('added', 'modified', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "document_changes" ADD CONSTRAINT "document_changes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_changes_project_changed_idx" ON "document_changes" USING btree ("project_id","changed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "document_changes_changed_at_idx" ON "document_changes" USING btree ("changed_at");