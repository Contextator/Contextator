# MCP access

A new project's MCP endpoint **requires a token**. Creating a project mints its first one and shows it once — that
string is what a client is configured with, and the server keeps only its hash. A project is therefore closed from its
first second, and the operator leaves the creation dialog holding the one thing that opens it.

**Upgrading changes nothing about a project that already exists.** A project configured **open** stays open, because
the agents configured against it were configured against that answer; the new default is the state a *new* project is
born in and nothing else.

Per project, you decide. **MCP access** on the project page offers three modes, and they narrow in this order:

| Mode | Who gets an answer | What it is for |
|------|--------------------|----------------|
| **open** | Anyone who can reach the URL | Documents nobody has to be anybody to read: a public handbook, or an instance already behind a VPN. Chosen deliberately — and what every project created before the default moved still is. |
| **token required** | A client presenting one of that project's tokens | One credential per agent, revocable one at a time. The token names nobody: whoever holds it reads everything indexed in that project. |
| **account required** | A client acting as an account that is a **member** of the project | The memberships on the project page, reaching the endpoint. An administrator reaches it because an administrator reaches every project. |

Switching to **token required** means a client has to present one of that project's tokens:

```bash
claude mcp add --transport http demo-docs http://localhost:3444/mcp/demo   --header "Authorization: Bearer ctxm_9f3a…"
```

```json
{ "mcpServers": { "demo-docs": { "url": "http://localhost:3444/mcp/demo",
  "headers": { "Authorization": "Bearer ctxm_9f3a…" } } } }
```

Tokens are per project, named so you can tell them apart, and shown exactly once — the server keeps only a hash, the
same as it does for passwords and sessions. Revoking one closes that project's open MCP sessions immediately rather
than waiting for the client's next request. Turning the requirement on does the same, so a session opened while the
endpoint was public does not outlive the moment it stopped being.

| | root | admin | editor | viewer |
|---|:--:|:--:|:--:|:--:|
| See a project's tokens (names, prefixes, last use) | ✓ | ✓ | ✓ | ✓ |
| Mint and revoke a token | ✓ | ✓ | ✓ | – |
| Require a token, or make the endpoint open again | ✓ | ✓ | – | – |

Deciding whether a project's documents are readable by anything that can reach the URL is the same class of decision
as creating the project in the first place, which is why it sits with `admin` rather than `editor`.

## Account required, and connecting a browser-based client

**account required** is the mode where this dashboard's memberships reach `/mcp/*`. A client has to act as somebody,
and it then reads the project only while that account is a member of it — checked on **every request**, so removing a
membership, disabling an account or resetting its password cuts the connection off on its next call rather than at some
expiry. A static `ctxm_…` token names nobody, so it is refused here; that is the point of the mode rather than a
side effect.

A client gets an account-backed credential through OAuth 2.1, which is what browser-based MCP connectors already speak
and what the MCP authorization specification defines for remote servers. You do not configure anything: point the
connector at `http://host:3444/mcp/<project>`, and it discovers this server's authorization endpoints, registers
itself, and sends you to a page here to sign in and approve it. What it gets back acts as *your* account.

A connector can identify itself in one of two ways. It can register through `/oauth/register` (dynamic client
registration), or it can send an `https://` URL with a path as its `client_id`, a **Client ID Metadata Document
(CIMD)**, and skip the registration call; the authorization server metadata announces the second with
`client_id_metadata_document_supported: true`. The server fetches that document through the same egress guard
Confluence uses — https only, no loopback, link-local, private or unspecified address, checked after DNS and on
every redirect — limited to 5 KiB and 5 seconds, and caches it as its `Cache-Control` / `Expires` headers allow
(5 minutes without them, a day at most). The document's `client_id` must equal the URL, `client_name` and
`redirect_uris` are required, no secret is accepted, and the `redirect_uri` the client then asks for must be
listed in it exactly. The consent page names the host that published the document and where the answer is
sent, and warns when the client can only redirect to localhost.

Its credential renews itself quietly and expires if the connector goes unused for a month
(`MCP_OAUTH_ACCESS_TTL_MIN`, `MCP_OAUTH_REFRESH_TTL_DAYS`). **Changing your password disconnects every connector acting
as you**, the same way it signs out your other browsers, and a connector that says *disconnect* gives up its whole
grant rather than the one token it happened to hand back. `MCP_OAUTH=0` removes the whole flow, and then only static
tokens open a closed project — which also means browser-based connectors cannot connect at all.

**What this does not do.** A static token is a bearer credential for the endpoint, not an account: it carries no
identity, no per-document rules and no audit trail beyond "this token was last used at". A holder reads everything
indexed in that project — which is exactly what **account required** is for, and why it exists beside `token` rather
than instead of it: every CLI client configured with a pasted header keeps working. An account-backed credential is
narrowed by membership and by nothing finer: a `viewer` of a project reads every document in it, as they do in the
dashboard. And a closed project answers `401` where an unknown project answers `404`, so the existence of a project
name is still discoverable by anyone who can reach the server — hiding that would mean answering `404` to a client
with a wrong token, which is worse to debug than it is worth.

Clients that cannot set an `Authorization` header — a browser `EventSource` on the legacy (deprecated) SSE transport, for one —
cannot reach a token-protected project at all. Leave those projects open, or put the whole instance behind an
authenticating proxy.
