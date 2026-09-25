-- How many times an account's MCP OAuth credentials have been revoked (unlink, a password change, an
-- administrator's reset; ADR-0090 / FR-616). `revokeMcpCredentialsOfUser` increments it under the
-- account row's `FOR UPDATE`; the consent step copies it into the authorization code under the row's
-- `FOR SHARE`, and `POST /oauth/token` refuses a code whose copy no longer matches: a code is held in
-- memory, not in `mcp_tokens`, so the revoke's `UPDATE` cannot reach one that is still in flight. A
-- counter rather than a timestamp, so the comparison follows the order the row lock established and
-- not the wall clock, which can step backwards. NOT NULL DEFAULT 0 is catalogue-only on PostgreSQL 11+
-- (no table rewrite), and every account that predates this migration reads as 0; codes issued by the
-- previous release carry no epoch and do not survive the restart that deploys this one (the code
-- store is in memory), so no outstanding code is refused by the upgrade itself.
--
-- Down path: DROP COLUMN; the only data lost is the counter, and codes live 60 seconds, so rolling
-- back reopens the window only for codes issued in the minute before the rollback.
--
--   ALTER TABLE users DROP COLUMN mcp_credentials_epoch;

ALTER TABLE "users" ADD COLUMN "mcp_credentials_epoch" integer DEFAULT 0 NOT NULL;
