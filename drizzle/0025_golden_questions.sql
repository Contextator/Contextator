CREATE TABLE "golden_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"lang" text NOT NULL,
	"query" text NOT NULL,
	"expect_file" text NOT NULL,
	"expect_heading" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "golden_questions_project_key_uq" UNIQUE("project_id","key"),
	CONSTRAINT "golden_questions_lang_check" CHECK ("golden_questions"."lang" in ('en', 'tr'))
);
--> statement-breakpoint
ALTER TABLE "golden_questions" ADD CONSTRAINT "golden_questions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;