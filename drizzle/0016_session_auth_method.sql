-- How a session was opened (ADR-0077): a session that came in over SSO is refused the moment the
-- role it resolves to is `root`, whenever the promotion happened relative to sign-in. Additive and
-- defaulted, so every row that predates this migration reads as `password` — which is what it was.
--
-- Down path: DROP CONSTRAINT then DROP COLUMN; no data to reconcile, since the column carries no
-- information anything else derives from.
--
--   ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_auth_method_check;
--   ALTER TABLE user_sessions DROP COLUMN auth_method;

ALTER TABLE "user_sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_auth_method_check" CHECK ("user_sessions"."auth_method" in ('password', 'sso'));