# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.1.0` (unreleased, `main`) | Yes — it is the only thing there is |

Contextator has not been released yet. `0.1.0` is the version in `package.json` and on `main`, no tag has
been published, and there is no older version to maintain. Fixes land on `main`; upgrading is pulling and
rebuilding.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** An issue is readable by everybody the moment
it is filed, including by whoever would use it.

The intended route is GitHub's **private vulnerability reporting** on this repository: the **Security** tab
→ *Report a vulnerability*. It opens a private thread between you and the maintainer, it is free, and it
needs no e-mail address from either side.

> **It is not switched on yet.** As of 2026-09-18 private vulnerability reporting is disabled in this
> repository's settings and only the repository owner can enable it (Settings → Security → Private
> vulnerability reporting). Until the Security tab offers *Report a vulnerability*, **contact the
> repository owner privately instead** — through [tunedness.com](https://tunedness.com), or any private
> channel you already have with them.
>
> <!-- OWNER: once private vulnerability reporting is enabled, delete this block. If you would rather
>      publish a security contact address, put it here instead — no address is published anywhere in
>      this project today, so none was invented for this file. -->

Whichever route you use, the useful report says: what an attacker can do, the smallest sequence of steps
that shows it, the version or commit you tested, and how the instance was deployed. A patch is welcome and
never required.

There is **no bug bounty**. You will get an acknowledgement, a fix or an explanation of why the behaviour
is intended, and credit in the release notes if you want it.

## What is not a vulnerability

Some of what this product does looks like a finding and is documented behaviour. These are not
vulnerabilities, and a report about one of them will be closed with a link back to this section.

- **A project whose MCP endpoint is `open` is readable by anyone who can reach its URL.** `open` is the
  default, on purpose: it is how Contextator has always behaved, and making `token` the default would
  break every configured agent on an upgrade. Dashboard accounts and memberships do not reach `/mcp/*` at
  all — a `member` who is answered `404` for a project in the dashboard can still read that project
  through its endpoint while it is open. Close it per project under **MCP access**, and read the
  *MCP access* section of the [README](README.md#mcp-access) for what that does and does not do.
- **An MCP token grants the whole project.** It is a bearer credential for one endpoint, not an account.
  It carries no identity, records no actor beyond "last used at", and cannot be narrowed to a subset of
  the documents. A holder reads everything indexed in that project. A token that reaches the wrong person
  is revoked and replaced — it cannot be reduced.
- **A token-protected project answers `401` where an unknown project answers `404`**, so project *names*
  remain discoverable by anyone who can reach the server. Hiding that would mean answering `404` to a
  client holding a wrong token, which is worse to debug than the disclosure is worth.
- **Every search of a project is recorded, in the clear, and every viewer of that project can read it.**
  The query log stores the question as it was typed — not a hash, because the feature is being able to read
  back what people asked — with the excerpts it returned and the MCP token the agent presented, if any. It is
  an ordinary table, so it is in every `pg_dump` as well. That is the feature and not a leak: without it this
  product cannot tell an operator which questions their documentation fails to answer. What it is *not* is a
  place for secrets, and an instance whose users type confidential things into a search box should shorten
  `SEARCH_QUERY_LOG_RETENTION_DAYS`, switch the log off per project, or set `SEARCH_QUERY_LOG=0`. The
  [Privacy Policy](public/pages/privacy.html) §4 states all of it. A query log readable by somebody with *no*
  access to the project would be a vulnerability; one readable by that project's viewers is the design.
- **A source with a sync interval makes outbound requests on a timer, to an address an editor chose.**
  The server contacts that source's git host or Notion on its schedule — the cheapest request each one
  has, `git ls-remote` or a single search — using the credential that was already supplied for the
  manual sync. It adds a clock, not a reach: there is no address the scheduler can contact that a
  *Sync now* could not. It is off for every source that predates the feature, it is off unless
  somebody sets an interval, and `SYNC_DEFAULT_INTERVAL_MINUTES=0` keeps it off for new sources too.
  Anyone who can add a source can already point the server at a host; that is what the `editor` rule
  and the deployment assumption are for. A way to make the server contact an address **without** an
  editor's source would be a vulnerability.
- **`/metrics` needs a credential, and `METRICS_PUBLIC=1` removes it.** The default is closed on purpose:
  the exposition names this instance's version, its embedding model, how many projects are queued and how
  deep its database pool is, which is a description of the machine to anyone who can reach the port. It
  answers a signed-in account of any role, `ADMIN_TOKEN`, or a `METRICS_TOKEN` bearer — a dedicated scrape
  credential that reaches this one path and nothing else, so scraping never means handing Prometheus a
  token with root permissions. Opening it with `METRICS_PUBLIC=1` for a private network or behind a proxy
  that already guards the path is a deployment's decision to make; a way to read `/metrics` **without**
  one of those four is a vulnerability. No metric names a project, a document or a query.
- **`/metrics` is not rate-limited and `METRICS_TOKEN` has no lockout**, exactly as `/mcp/*` and
  `ADMIN_TOKEN` are not. `min(16)` on that setting is a length floor and not an entropy requirement, so
  generate it the way you would any other secret (`openssl rand -hex 32`); what bounds guessing is the
  credential's own entropy and the network boundary, and the comparison is constant-time. With
  `METRICS_PUBLIC=1` each anonymous scrape additionally costs two database round trips, which is a thing
  to know before exposing the port rather than a defect in the endpoint.
- **A request that changed something and then answered `5xx` leaves no audit row.** The row is written
  only for a response under 400, because the alternative — recording a request whose outcome the server
  itself could not determine — would put "this may or may not have happened" in a table whose value is
  that it is not that. No handler in this API currently commits and can then fail (the one that looked
  like it, `DELETE /api/projects/:id`, closes MCP sessions through a registry that swallows and logs per
  session), so the gap is a property of the design rather than a live case. A handler that does become
  shaped that way is a bug to fix in the handler.
- **The IP recorded beside an audit event is not evidence of who acted.** Every state-changing admin
  request that succeeds is recorded in `audit_events` with the account that made it, and `actor_ip`
  is stored next to that account. Fastify runs with `trustProxy: true`, so the value is the left-most
  `X-Forwarded-For` — **which the client writes whenever the server is reachable directly**, exactly as
  the sign-in rate limit's key is (see the threat table in `.ssot/SECURITY.md`, T7). The actor is the
  account the policy layer resolved from a session cookie or a bearer credential; the address is a hint
  beside it. Pinning `trustProxy` to the proxy in front of this instance is not something this product
  currently exposes, and that is a known limit rather than scheduled work.
- **`/mcp/*` is not rate-limited**, and `ADMIN_TOKEN` has no lockout. Both rely on the entropy of the
  credential and on the network boundary. Sign-in to the dashboard *is* limited, per account and per IP.
- **`ADMIN_TOKEN` acts with root permissions and bypasses every membership.** That is what it is for —
  scripts and CI. Treat it as a root password; an operator who only uses the dashboard should leave it
  unset.
- **An operator can widen `ALLOWED_DOC_ROOTS` to `/` and index anything the process can read.** It is
  their machine and their configuration. What is *not* acceptable is a way to escape the roots they did
  configure — that is a vulnerability, and reports of it are very welcome.
- **Indexed documentation can carry instructions that an agent then acts on.** Prompt injection is a
  property of the corpus, not of this server: documents are chunked and returned as text, never rendered
  or evaluated. Do not index text you would not want an agent to read as an instruction.

Everything else — path escapes, archive extraction escaping its directory, a credential recoverable from a
database dump, cross-project leakage, a route that skips the policy table, a webhook accepted without a
valid signature, a session that outlives its revocation, a state-changing admin request that **succeeds**
and leaves no audit row or leaves one naming the wrong account, user content reaching a column of
`audit_events` — is a vulnerability. Report it.
