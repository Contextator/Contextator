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

## Single sign-on groups

With `OIDC_GROUPS_CLAIM` set, the groups your identity provider puts in a person's ID token grant project
memberships. An administrator maps a group name to a project and a role (`viewer` or `editor`) under
**Users → SSO group mappings**, or through `GET`/`POST /api/oidc/group-mappings` and
`DELETE /api/oidc/group-mappings/:id`. The mappings are available before the setting is on, so they can be
prepared first; there is no edit, a role change is a delete and an add. Group names are matched exactly,
capitals included. A group never changes an instance role: nobody becomes `admin` or `root` through one.

What happens at each SSO sign-in of a `member` account:

- The account's group-granted memberships become exactly the projects its groups map to. Where two groups map
  the same project, the higher role applies.
- A membership added by hand for the same project wins and is never changed or removed by a group. Each
  membership says where it came from (`origin`: `manual` or `oidc_group`), and a group-granted one lists the
  groups behind it, in the project's member list and in `GET /api/projects/:id/members`.
- A person who has left the group loses the membership at their **next sign-in**, not before. A dashboard
  session lasts `AUTH_SESSION_TTL_DAYS` (30 by default), so to cut access at once, disable the account.
- `admin` and `root` accounts are skipped: they reach every project already.

While the setting is on, the members API refuses to change or remove a group-granted membership
(`409 membership_managed_by_group`): the next sign-in would put it back. Change the mapping, or disable the
account. With the setting off, such a row is an ordinary one — editing it makes it a manual membership,
removing it removes it.

How providers say "no group", and what happens:

| The ID token has | Result |
| --- | --- |
| no such claim, `null`, `[]` or `{}` | No groups: the account's group-granted memberships are removed and sign-in goes on. |
| Microsoft Entra's overage marker (`_claim_names.groups`; a person in more than 200 groups) | Sign-in is stopped with `groups_unavailable` and nothing changes. |
| anything but a list of strings, more than 1 000 entries, or a name over 256 characters | The same: stopped, nothing changes. |

For Entra, configure the application to emit only the groups assigned to it, so that no one goes over 200.

Group-granted memberships are also removed, in the same request, when:

- a mapping is deleted — the memberships that rested on its group are recomputed from the groups they have
  left, or removed;
- a person unlinks their SSO identity (`DELETE /api/auth/oidc/link`);
- a linked account **signs in with its password** — no claim arrives on that path, so the next SSO sign-in is
  what restores what the groups still grant. (Only while `OIDC_GROUPS_CLAIM` is set.)

Switching the setting off removes nothing: a typo in the environment must not take everybody's access. The
rows stay, marked as group-granted, until an administrator removes or takes them over. Every membership a
sign-in adds, changes or removes is one entry in the audit log, with the groups and roles involved; a mapping
deletion's entry counts the memberships it updated and removed.

Full role matrix, the temporary-password flow, `ADMIN_TOKEN` and API-token mechanics: [Accounts and Permissions](https://contextator.com/en/docs/accounts-and-permissions/). Full SSO setup, linking and unlinking, and every guardrail around `root`: [Single Sign-On](https://contextator.com/en/docs/sso/).

Accounts govern the dashboard and the admin API. The MCP endpoints have their own door — see
[MCP access](mcp-access.md).
