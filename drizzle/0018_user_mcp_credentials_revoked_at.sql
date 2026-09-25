-- When an account's MCP OAuth credentials were last revoked (unlink, a password change, an
-- administrator's reset; ADR-0090 / FR-616). `revokeMcpCredentialsOfUser` stamps it under the
-- account row's `FOR UPDATE`, and `POST /oauth/token` refuses an authorization code issued at or
-- before it: a code is held in memory, not in `mcp_tokens`, so the revoke's `UPDATE` cannot reach one
-- that is still in flight. Nullable with no default: every account that predates this migration reads
-- as NULL, "never revoked", so no outstanding code is refused by the upgrade itself.
--
-- Down path: DROP COLUMN; the only data lost is the stamp, and codes live 60 seconds, so rolling back
-- reopens the window only for codes issued in the minute before the rollback.
--
--   ALTER TABLE users DROP COLUMN mcp_credentials_revoked_at;

ALTER TABLE "users" ADD COLUMN "mcp_credentials_revoked_at" timestamp with time zone;
