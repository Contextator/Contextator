# Accounts and permissions

The dashboard and the admin API are behind a personal account, created at `/setup` with a one-time
`SETUP_CODE` you set, or the code the server logs itself when none is set. Three instance roles
(`root`, `admin`, `member`) plus a per-project `editor`/`viewer` membership govern everything from
re-indexing to managing other accounts; the last active root account can never be deleted, demoted or
disabled, and an admin can never touch a root account. `ADMIN_TOKEN` still works with root permissions
for scripts and CI; a per-account **API token**, scoped to one project and a set of routes, is the
recommended credential for anything new.

Setting `OIDC_ISSUER_URL` adds federated sign-in beside the password form — matched to an account by the
provider's `sub` claim, never its e-mail, and `root` can never be reached through it: linking,
auto-provisioning and promotion are all blocked from ever producing an SSO-reachable root account. See
[Configuration](../README.md#configuration) for the full variable list.

Full role matrix, the temporary-password flow, `ADMIN_TOKEN` and API-token mechanics: [Accounts and Permissions](https://contextator.com/en/docs/accounts-and-permissions/). Full SSO setup, linking and unlinking, and every guardrail around `root`: [Single Sign-On](https://contextator.com/en/docs/sso/).

Accounts govern the dashboard and the admin API. The MCP endpoints have their own door — see
[MCP access](mcp-access.md).
