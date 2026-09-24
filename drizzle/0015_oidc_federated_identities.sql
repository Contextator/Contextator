CREATE TABLE "user_federated_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "user_federated_identities_issuer_subject_key" UNIQUE("issuer","subject")
);
--> statement-breakpoint
ALTER TABLE "user_federated_identities" ADD CONSTRAINT "user_federated_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_federated_identities_user_idx" ON "user_federated_identities" USING btree ("user_id");