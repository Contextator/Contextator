CREATE TABLE "oidc_group_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_group_mappings_group_project_key" UNIQUE("group_name","project_id"),
	CONSTRAINT "oidc_group_mappings_role_check" CHECK ("oidc_group_mappings"."role" in ('viewer', 'editor')),
	CONSTRAINT "oidc_group_mappings_group_name_check" CHECK (char_length("oidc_group_mappings"."group_name") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "oidc_groups" text[];--> statement-breakpoint
ALTER TABLE "oidc_group_mappings" ADD CONSTRAINT "oidc_group_mappings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_group_mappings" ADD CONSTRAINT "oidc_group_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oidc_group_mappings_project_idx" ON "oidc_group_mappings" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_origin_check" CHECK (("project_members"."origin" = 'manual' and "project_members"."oidc_groups" is null) or ("project_members"."origin" = 'oidc_group' and cardinality("project_members"."oidc_groups") > 0));