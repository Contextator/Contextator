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

## Limiting how much a client may ask for

Three optional limits sit in front of the tools, all counted per minute in a fixed one-minute window kept in the
database, so they hold across restarts and across replicas that share it:

| Variable | Counts | Default |
|----------|--------|---------|
| `MCP_RATE_LIMIT_PER_MINUTE` | requests per token (a static token, or the account behind an OAuth credential) | `0`, no limit |
| `MCP_RATE_LIMIT_ANON_PER_MINUTE` | requests per client address to an **open** project that arrive without a valid token | `60` |
| `MCP_RATE_LIMIT_TOOLS` | requests per token for one tool, e.g. `search_docs=30,read_document=60` | none |

Every JSON-RPC request message is one hit, so a batch of three costs three. Notifications, responses, `initialize`
and `ping` are free, and so is opening the event stream. The tool is the one named in the **body**, whatever the
`Mcp-Name` header says. A request over a limit is answered `429` with a `Retry-After` header (the seconds left in the
window) and a JSON-RPC `-32000` error whose `data` is `{ "error": "rate_limited", "retryAfterSec": 12, "scope": "token" }`;
`scope` is `token`, `anonymous` or `tool`.

- A request that fails authentication is not counted. A wrong or unknown token on a **token required** project is
  refused with `401` before any limit is looked at.
- An **open** project serves a request whatever its Bearer says, so a request with a token that means nothing is
  counted in the anonymous bucket of its address. A junk header is not a way round the address limit.
- IPv4-mapped IPv6 addresses are folded onto the IPv4 address, and an IPv6 address onto its `/64`.
- If the counter cannot be reached, the request is **served**, a warning is logged and
  `contextator_mcp_rate_limit_errors_total` is incremented. `MCP_RATE_LIMIT_FAIL_OPEN=0` answers `503` instead.
- The window is fixed, not sliding: a client can send up to twice the limit across a minute boundary.
- Counters are in the `mcp_rate_limits` table; rows older than ten minutes are removed by the maintenance sweep.
- Metrics: `contextator_mcp_rate_limited_total{scope}`.

Upgrading: with nothing set, token requests behave exactly as before. The one default that moves is the anonymous
limit of 60 requests a minute per address on an open project; `MCP_RATE_LIMIT_ANON_PER_MINUTE=0` restores the old
behaviour.

## Restricting a static token to a network

A static `ctxm_…` token can carry an allowlist of up to 32 addresses or CIDR ranges (`allowedCidrs`, set when the
token is created or later with `PATCH /api/projects/:id/mcp-tokens/:tokenId`). An empty or absent list means the token
works from anywhere, as before. `/0` is refused, and so is a CIDR with host bits set (`203.0.113.5/24`).

A request from outside the list is answered `403` with a JSON-RPC `-32000` error that names neither the address nor the
ranges; the server log names the token id and the address, and `contextator_mcp_access_denied_total{reason="network"}`
counts it. The check runs after the token is recognised and before the project's access mode is applied, so a token
that carries a list is bound on an open project too. Nothing is checked for OAuth access tokens, for an open project's
anonymous callers, or for a token with no list.

The address checked is the one the server believes the client has, which depends on `TRUST_PROXY`:

| `TRUST_PROXY` | Address checked | Use an allowlist? |
|---------------|-----------------|-------------------|
| `0` (default) | The socket's peer. `X-Forwarded-For` is ignored. | Yes, when clients connect directly. Behind a proxy every request appears to come from the proxy. |
| A list of proxy addresses or CIDRs | `X-Forwarded-For`, read right to left, skipping the listed proxies. A header sent by any other peer is ignored. | Yes. This is the setting meant for it: name the proxy, not your clients' network. |
| `loopback`, `linklocal` | As a list, for the proxy on the same host or link. | Yes. |
| `uniquelocal` | As a list, trusting every private (LAN) address as a proxy. | Only if no untrusted host can reach the server from those ranges, because any of them can write the header. |
| `1`, `true` (refused at startup since 0.5.0) | The server does not start: `1` believed every hop of `X-Forwarded-For`, so the **leftmost** value, which the client writes, became the address. | Not applicable. Before 0.5.0 the server refused to save a non-empty list under it, and answered `403` to a token that already carried one; with the value refused there is no instance in which either can happen. |

A request from an address that the list does not name, or from a peer the server does not trust that
writes `X-Forwarded-For` anyway, is answered `403` as above: the header of an untrusted peer is never read.

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
