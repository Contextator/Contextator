# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

**Before `1.0.0`, a minor version may change a public contract** — the HTTP and MCP APIs, the MCP
tool names and their parameters, environment variable names — without a major bump. Once `1.0.0`
ships, that stops.

## [Unreleased]

### Added

- **`EMBEDDING_PROVIDER=openai` talks to any OpenAI-compatible endpoint.** `EMBEDDING_BASE_URL`
  (http or https, no credentials in the URL) points it at Ollama, vLLM, Text Embeddings Inference,
  LM Studio or a proxy; `OPENAI_BASE_URL` is still read when it is empty, and the base URL is now
  passed to the client explicitly instead of being picked up from the process environment by the SDK.
  `OPENAI_BASE_URL` is validated only when it is read: `EMBEDDING_PROVIDER=openai` and
  `EMBEDDING_BASE_URL` empty. `OPENAI_API_KEY` becomes optional when the base URL names a host other
  than `api.openai.com` — without one, no `Authorization` header is sent. A self-hosted endpoint is
  asked for float vectors rather than the SDK's base64.
  `EMBEDDING_REQUEST_DIMENSIONS` (`auto` by default: only `text-embedding-3-*`, as before; `always`;
  `never`) decides whether the request carries `dimensions`. The existing `EMBEDDING_QUERY_PREFIX` /
  `EMBEDDING_PASSAGE_PREFIX` and `EMBEDDING_MAX_INPUT_TOKENS` apply to this provider unchanged.
  An installation that already set `OPENAI_BASE_URL` keeps its model id and its index: the legacy
  name never enters the id (see Changed).
- **Every OAuth authorization response names its issuer (RFC 9207).** The redirect back to an MCP
  client now carries `iss` on a code and on an error alike, and the authorization server metadata
  announces it with `authorization_response_iss_parameter_supported: true`. A client that talks to
  more than one authorization server can now tell which one answered; one that ignores `iss` sees no
  difference.
- **Dynamic client registration reads `application_type` (RFC 7591).** `native` may register an
  `http` loopback callback (`127.0.0.1`, `[::1]`, `localhost`) on whatever port it picks, which the
  authorization request must then repeat exactly, or a private-use scheme such as
  `com.example.app:/callback`; `web` may register `https` on a non-loopback host only and is answered
  `invalid_redirect_uri` otherwise. An unknown value is `invalid_client_metadata`. A registration that
  leaves the field out is checked exactly as before.
- **Uploads, and forced re-indexes on the embedded database, are refused on a nearly full disk.**
  Below `DATA_DIR_MIN_FREE_BYTES` free (default 512 MiB, `0` turns it off) the request answers `507`
  with `error: "insufficient_disk"` and a message naming both figures and the disk. Uploads — the
  request that opens a session and every request that adds files to it — are checked against
  `DATA_DIR`'s file system. A forced re-index writes its new generation into the database, not into
  `DATA_DIR`, so it is checked against the embedded PostgreSQL's data directory; a rebuild that starts
  from the queue (a queued force, a model change) is checked again when it starts and fails the same
  way, leaving the live index as it was and the message in the project's error. **With an external
  database (`DATABASE_URL`) the database's disk cannot be measured from Contextator, so forced
  re-indexes are not checked at all** — watch that disk where the database runs. The check is
  advisory: passing it means the disk was not already below the threshold, not that the work will
  fit. `/api/health` reports `DATA_DIR`'s `disk: { freeBytes, totalBytes, minFreeBytes, ok }` to a
  signed-in caller; it does not change `ok` or the status code, which still report the database.
- **`CONVERSION_WORKER_MAX_HEAP_MB` caps the conversion thread's heap (opt-in).** Unset — the
  default — means no cap, as before. When set, a file whose conversion needs more than that many MiB
  becomes one refused document whose reason names the heap limit, distinct from a timeout or a crash;
  the thread is replaced and the run carries on with the next file (ADR-0097).
- **`CONFLUENCE_MAX_PAGES` and `NOTION_MAX_PAGES` set the page ceiling per source run** (default
  5000 each, as the built-in limit was; 1–100000). A source that reaches it stops there, logs a
  warning and writes `STOPPED AT THE N-PAGE CEILING (…_MAX_PAGES)` into the run's note, naming the
  setting to raise.
- **Text inside an inline SVG is indexed.** An HTML page's `<svg>` used to be dropped whole; its
  `<text>` (with `<tspan>`), `<title>` and `<desc>` now become paragraphs of the document, so a
  diagram's labels are searchable. Shapes, paths and styling are still dropped.
- **Static MCP tokens can expire.** `POST /api/projects/:id/mcp-tokens` takes an optional
  `expiresInDays` (`30`, `90` or `365`; any other value is a `400`) and
  defaults to `null`, a token that never expires — so a script that sends only `name` mints exactly
  what it did before, and so does a new project's first token. `GET /api/projects/:id/mcp-tokens`
  and the `token` of the `POST` answer now carry `expiresAt` (ISO 8601, or `null`). A token past its
  `expiresAt` is refused with `401` by a `token` or `account` project, like a revoked one; an expired
  token stays in the list until it is revoked. An `open` project still ignores the bearer it is given,
  expired or not (ADR-0054). No migration: `mcp_tokens.expires_at` already existed.
- **The dashboard sets and shows MCP token lifetimes.** The New MCP token dialog has an Expires
  choice — Never (the default), 30, 90 or 365 days. Each row of a project's token list shows
  "no expiry", the expiry date, or the time left once it is under two weeks; a token past its date
  is marked "expired" and stays listed until it is revoked. The "No token, no access" note of a
  `token` project now also appears when every token it has is expired.
- **The dashboard tells which projects still have a legacy SSE client.** A project whose
  `lastLegacySseAt` falls within the last seven days shows an informational note on its page, saying
  when a client last connected over legacy SSE and that the same URL takes Streamable HTTP. It gives
  no removal date, because none has been set (ADR-0096).

### Changed

- **A web source asks for Markdown first for the pages a sitemap or `llms.txt` lists.** Those
  requests' `Accept` header ranks `text/markdown` above `text/html`, so a site that negotiates
  answers with the page's Markdown source, which is indexed as `.md` without an HTML conversion. The
  entry URL and every page a crawl visits still ask for HTML first, because the crawl reads its links
  from HTML and the entry's type decides the mode. On a negotiating site a listed page's path moves
  from `.html` to `.md` once: the next sync re-embeds those pages and `read_document` paths change.
  A server that answers a stored ETag with `304 Not Modified` keeps the old `.html` copy until the
  page changes. A site that does not negotiate serves HTML as before.
- **`EMBEDDING_BASE_URL`'s host is part of the model id** (`openai:<model>:<dims>@<host:port>…`), so
  pointing the provider at another server re-indexes every project, because two servers answering to
  the same model name are not guaranteed to produce the same vectors. Unset, or naming `api.openai.com`,
  the id is exactly what it was. `OPENAI_BASE_URL` never enters the id. Moving an existing setup from
  `OPENAI_BASE_URL` to `EMBEDDING_BASE_URL` — even with the same URL — is therefore an opt-in that
  re-indexes once: until a project's re-index finishes, its searches are refused with `model_mismatch`.
  A scheduled run whose content has not changed may wait up to `SYNC_MAX_SKIP_HOURS` (24 h by default;
  with `0`, or no schedule, until "Sync now"), so start a forced re-index of each project
  (`POST /api/projects/:id/reindex?force=true`) right after the switch.
- **`OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are no longer sent to a self-hosted endpoint.** The SDK
  read them from the process environment and sent them as `OpenAI-Organization` / `OpenAI-Project`
  headers to whatever server it was pointed at; they now reach `api.openai.com` only.
- **Every project shows its MCP access mode as a neutral badge** — `open`, `token` or `account` —
  in the project list and on the project page, the three alike in weight and colour. `open` carries
  no warning colour, icon or text (ADR-0065); the badge's tooltip states what a client has to send.
- **The dashboard's connection snippets lead with Streamable HTTP.** A new Streamable HTTP tab gives
  the URL (and the `Authorization` header for a `token` project) for any other MCP client; the
  Legacy SSE tab comes last and is labelled deprecated, for a client that cannot speak Streamable
  HTTP.

### Deprecated

- **The legacy HTTP+SSE MCP transport (protocol 2024-11-05) is deprecated** (ADR-0096). Every
  response of it — the `GET /mcp/:project` stream opened without an `mcp-session-id` and every answer
  of `POST /mcp/:project/messages`, refusals included — now carries `Deprecation: true`. No `Sunset`
  header is sent, because no date has been set: the transport behaves exactly as before, and it will
  not be removed before 1.0 nor sooner than twelve months from this release. Streamable HTTP answers
  carry neither header. CORS now exposes `Deprecation`, so a browser client on an `ALLOWED_ORIGINS`
  origin can read it too. Move clients to Streamable HTTP (`POST /mcp/:project`) at your own pace.
  To tell which projects still have such clients, `GET /api/projects` and
  `GET /api/projects/:id/status` now carry each project's `lastLegacySseAt` (ISO 8601, or `null` when
  no legacy client has reached it), updated at most once a minute; the dashboard shows a note on
  such a project's page. Migration `0019` adds the nullable `projects.last_legacy_sse_at` column;
  it is not carried by a project export.

### Fixed

- **The dashboard's Claude Desktop snippet works on Windows.** For a `token` project it passed
  `--header "Authorization: Bearer …"` to `mcp-remote` as one argument with spaces, which Windows
  splits, so the server answered 401. It now passes `Authorization:${AUTH_HEADER}` and sets
  `AUTH_HEADER` in the server's `env`, the form the documentation already uses.
- **A Notion source no longer overshoots its page ceiling.** The limit was checked only after a
  whole search batch had been taken, so a source could pull up to one batch more than the ceiling;
  it is now applied page by page, and a source that fills the ceiling exactly is not reported as cut.
- **A run cut short by a restart no longer leaves its project stuck in `indexing`.** On startup every
  project the previous process left indexing gets an `interrupted` row in its run history, leaves the
  `indexing` state — which was blocking source edits and deletion — and an **incremental** run is
  queued for it in the background lane, whatever the lost run was: if it was a forced re-index,
  force it again. The dashboard's history shows the row as interrupted. A project whose recovery
  fails is logged and does not stop the others from being recovered.

## [0.2.0] - 2026-09-25

### Added

- **`npm run backup` and `npm run restore`: one archive that is the installation, not just the
  database.** `docker exec contextator npm run backup -- /data/backups/instance.tar.gz` writes the
  database dump, the materialised files of every **upload** source — which exist nowhere else — and a
  manifest that is read before anything else. Restoring is the same command backwards, and
  `--check` evaluates every refusal and writes nothing. The `pg_dump` and `pg_restore` lines you have
  been running by hand still work and are still what the test suite asserts on; what they never
  carried was the other half.
- **`SECRET_KEY` is never written into a backup, and a restore refuses the wrong one before it writes
  anything.** The archive records a fingerprint of the key, not the key: enough for `restore` to stop
  with a message naming the key it wants, and nothing like enough to be the key. Previously a restore
  with a different key succeeded and left every stored source credential undecryptable — discovered
  later, one source at a time. Keep the key where the archive is not.
- **A procedure for upgrading the embedded PostgreSQL across a major version**, in OPERATIONS.md §3.2,
  executed 16 → 17 before it was written: back up, start the new image against an *empty* cluster
  volume, restore, keep the old volume as the rollback. `pg_upgrade` needs both majors' binaries at
  once and the image carries one. Pulling an image whose PostgreSQL crossed a major without doing this
  gives `FATAL: database files are incompatible with server` and a restart loop — nothing is damaged,
  and rolling the tag back is the way out.

- **You can point Contextator at a PostgreSQL you already run.** Put a `DATABASE_URL` in `.env` and
  the container starts no database of its own: it connects to the server you named, creates and
  migrates its schema there, and leaves the `contextator-pgdata` volume empty. The server needs to be
  PostgreSQL 16 or newer with pgvector installed or installable by that role. **On this topology its
  backups are yours** — `docker exec contextator pg_dump …` dumps the embedded database and reaches
  nothing else.
- **A `-slim` image, for the same thing without a PostgreSQL inside it at all.** Every published tag
  from this release on has a `-slim` twin — `latest-slim`, `0.2-slim`, `0.2.0-slim` — carrying the
  application alone, on both architectures. It requires `DATABASE_URL` rather than accepting it, and started without one
  it exits immediately naming the variable and what the server behind it has to be.
  `docker-compose.slim.yml` runs it. The default image and the default installation are unchanged: a
  single container with its own PostgreSQL is still what `docker compose up -d` gives you.
- `/api/health` tells a signed-in caller which of the two databases it is talking to
  (`database.mode`), and an administrator the host, port and database name — never the credential.
- A source's **Language** setting is back on the dashboard, and `turkish` is one of the values it
  offers. Naming a source's language makes PostgreSQL stem it, so a Turkish question asking about
  `anahtarı` now finds a page that says `anahtarın`. Changing the setting re-indexes that source, as
  changing its content type already did.

- **A published documentation site is a source type.** Point a **Documentation site** source at a
  `sitemap.xml`, an `llms.txt` or one start URL, and it reads public pages over HTTP — staying on that
  host and under that path when it crawls. It refuses an entry point it cannot recognise rather than
  guessing, stores no credential at all, and stops at five ceilings (`WEB_MAX_PAGES`, `WEB_MAX_DEPTH`,
  `WEB_REQUEST_DELAY_MS`, `WEB_CRAWL_BUDGET_MS`, `WEB_RESPECT_ROBOTS`) that say which one ended a run.
- **Confluence Data Center 7.9 and later**, beside Cloud. Pick the *Deployment* when adding the source:
  Data Center takes a base URL with its context path and a personal access token. Its version is read
  before any credential is sent, and an older release or a server that is not Confluence is refused by
  name. Confluence Server is not supported.
- **A signed Confluence Data Center webhook**, off until an editor turns it on per source:
  `POST /api/webhooks/confluence/<source-id>` queues a sync through the same debounce as the git
  webhooks. Confluence Cloud cannot send these, so there the sync interval stays the only trigger.
- **Sign in through an OIDC identity provider.** `OIDC_ISSUER_URL` adds an SSO button beside the
  password form, which never goes away. By default SSO signs in accounts an admin already created;
  `OIDC_AUTO_PROVISION=1` lets a first sign-in create one with `OIDC_DEFAULT_ROLE`, which is never
  `root`.
- **Per-account API tokens.** Any account can mint one from its menu, restricted to a project, an
  expiry date and an exact list of routes, and revoke it on its own. A token never does more than the
  account behind it, and the audit log names the token that acted. It is now the recommended
  credential for scripts instead of `ADMIN_TOKEN`, which is unchanged.
- **`SECRET_KEY` can be rotated.** Set the old key as `SECRET_KEY_PREVIOUS` and the new one as
  `SECRET_KEY`, restart, run `npm run rotate-secret`, then remove `SECRET_KEY_PREVIOUS`. Reads fall back
  to the previous key while it is set; every write uses the new one.
- **A project can set its own relevance floor**, or turn it off, from its query-log panel, which shows
  what the new floor would have done to the searches already logged before it is applied.
  `SEARCH_SCORE_FLOOR=0` still turns every project's floor off.
- **Indexed documents are MCP resources** (`contextator://<project>/<source>/<path>`), listed and read
  behind the same auth as the tools and never beyond what `read_document` reaches.
- **`MCP_STRUCTURED_OUTPUT=1` adds structured JSON to every tool answer** — an `outputSchema` and
  `structuredContent` beside the text, which stays exactly the same. It is off by default, because
  Claude Code reads the structured part instead of the text when both are present.
- **A Helm chart, `charts/contextator/` (chart version 1.0.0)**, for the `-slim` image against an
  external database, published to `https://contextator.github.io/Contextator` by every release. It
  runs exactly one Pod, and its values schema is strict: a misspelt key fails `helm install` by name.
- `GET /api/audit` takes `actorUser`, which finds an account's own events and those of every API token
  it owns; the dashboard's audit view gains an account picker.

### Changed

- **`.env.example` now ships `DATABASE_URL` empty, and this is the one thing to check before you
  upgrade.** The container reads that line where it used to clear it. A `.env` copied from the old
  template carries `postgres://contextator:contextator@localhost:5432/contextator` for `npm run dev`
  — and after this release that line tells the container *not* to start its own PostgreSQL and to
  connect to its own loopback instead, where nothing is listening. **Clear `DATABASE_URL` in `.env`
  before `docker compose up -d`**, unless you are deliberately naming an external database. The
  container says so in its log if you forget: the startup line names the database it chose, and a
  loopback address on an image that embeds one is called out by name. Running from a source checkout
  with `npm run dev`, put the value back — it is the only way to say where the database is there.
- **A new project's MCP endpoint requires a token.** Creating a project now mints that project's
  first token and shows it once, in the creation dialog; before this, a new project was `open` and
  answered anyone who could reach its URL. Make it **open** from the project page if its documents
  should be readable without a credential — the mode is unchanged and is still there.
- **`docker compose` publishes the port on `127.0.0.1` instead of on every interface.** A default
  installation is now reachable from the machine it runs on and from nowhere else. Set
  `CONTEXTATOR_BIND=0.0.0.0` in `.env` to publish it on the network as before, and put a
  TLS-terminating reverse proxy or a VPN in front of it when you do. `HOST` inside the container is
  unchanged at `0.0.0.0`; what moved is which host interface Docker publishes to.
- **Keyword search now speaks every language in a project at once.** It used to parse every question
  in one configuration chosen for the whole instance, which meant a source that named a language was
  indexed one way and asked another, and contributed nothing to the keyword half at all. Each source
  is now read in its own configuration and one search reaches all of them. A project that names no
  language on any source is unaffected, down to the ordering of its results.
- **Every project has its own partial HNSW index**, built with `CREATE INDEX CONCURRENTLY` when the
  project is created. A search now scans its own project's rows instead of every chunk in the instance,
  so `HNSW_MAX_SCAN_TUPLES` is counted per project. The first start after upgrading builds one index
  per existing project.
- **Where a Confluence source may connect is bounded** (ADR-0088). Loopback, link-local — the cloud
  metadata address included — unspecified and multicast addresses are always refused; a private
  address is reached only when its host is listed in `CONFLUENCE_ALLOWED_HOSTS`. The check runs on the
  connected address, after DNS and on every redirect.
- **Unlinking an SSO identity revokes that account's MCP OAuth tokens** in the same transaction, as it
  already invalidated its sessions and API tokens.
- **A secret on a `local`, `upload` or `web` source is refused** with `400 invalid_request` naming the
  type, instead of being stored and never used. `secret: null` is accepted on every type.
- Files are converted on a worker thread. A file that takes seconds to parse no longer blocks search,
  and one that exhausts its thread or runs past `CONVERSION_TIMEOUT_MS` is refused by name while the
  run carries on.
- Document text in MCP tool answers is fenced, and the fence widens rather than escaping the document,
  so a page cannot pass itself off as the tool's own words.

### Fixed

- **Operator commands run inside the container could not find the database.**
  `docker exec contextator npm run reset-password -- <username>` — the documented last resort when
  nobody can sign in — stopped at `Invalid configuration: Set DATABASE_URL, or the libpq variables
  PGHOST/PGUSER/PGPASSWORD/PGDATABASE` on every installation using the container's own PostgreSQL.
  The entrypoint sets those variables for the one process it starts, and `docker exec` does not see
  that process's environment. CI had been asserting that the command prints its usage line, which it
  reaches three lines earlier. It now works, and CI talks to the database.

- **The same search over the same documentation returns the same page again.** Between two results
  that scored identically, which one came first was decided by an internal identifier that is minted
  fresh every time a project is re-indexed — so a project holding two languages could hand back a
  different fifth result after a rebuild, with nothing having changed but the rebuild. Equal results
  are now ordered by the documents themselves: the shorter excerpt first, then the document's own
  path and the position of the passage within it.
- **Revoking an account's MCP credentials could miss a sign-in already in flight.** An SSO unlink, a
  password change or an administrator's reset did not reach an authorization code approved in the
  minute before it, and a refresh rotation racing the revoke could mint a pair it never saw. The
  exchange now re-checks the account, its access to the project and a revoke counter under the account
  row's lock, and refuses a stale code with `invalid_grant`.
- Documentation said PostgreSQL has no Turkish configuration. It has one, and Turkish sources were
  being indexed without stemming because of that claim.

### Upgrade notes

- **No existing project changes.** The migration moves the column's default and rewrites no row: a
  project configured `open` stays `open` after the upgrade, and every agent already configured
  against it keeps working. What is different is the next project you create — it is born requiring
  a token, and hands you that token as it is created.
- **The published port moves on your next `docker compose up -d`.** If you reach this instance from
  another machine — a colleague's laptop, an agent running elsewhere, a proxy on another host — set
  `CONTEXTATOR_BIND=0.0.0.0` in `.env` before restarting, or it will stop answering them. Reaching
  it from the host it runs on needs nothing.
- **Nothing is re-indexed for the keyword change.** The first start after upgrading rewrites the
  keyword index of any source that names a language, in batches, from text already in the database —
  no re-embedding and no rebuild. Searches keep working while it runs.

## [0.1.0] - 2026-09-19

First published release. `0.1.0` describes what the product does, not what changed to get there.

### Added

- A self-hosted, multi-tenant MCP documentation server: give a project its document sources and it
  becomes its own `/mcp/<project-name>` endpoint that AI agents can search.
- Source types: local directories, git repositories, uploaded files and archives (`.zip`, `.tar`,
  `.tar.gz`, `.rar`), Notion workspaces and Confluence Cloud sites.
- Document conversion to Markdown for `.html`, `.docx`, `.csv` and `.pdf` files, so an agent reads
  them the way it reads a page of documentation.
- An OpenAPI/Swagger content type: a specification is indexed as one document per operation, not
  as a single file, so a hit is the endpoint rather than the whole spec.
- Hybrid search: vector similarity and keyword search fused with reciprocal rank fusion, over
  chunks that carry a heading breadcrumb.
- Local embeddings on the CPU by default (`multilingual-e5-small`, covering 100 languages), with
  `EMBEDDING_DTYPE` to trade model size against precision (fp32/fp16/q8), or OpenAI embeddings as
  an alternative. Search within a language is strong; cross-language search is a known limit and
  is documented as one in the README rather than fixed.
- An admin dashboard and REST API to manage projects, sources and members — the normal way to add
  a source and trigger a re-index.
- MCP access on one URL per project, both transports: Streamable HTTP and legacy HTTP+SSE. Tools:
  `search_docs`, `list_topics`, `read_document`.
- Three settings for an MCP endpoint: open, a static bearer token, or account-backed access through
  OAuth 2.1 — the last so browser-based connectors can sign in.
- Accounts, roles and per-project memberships, with `ADMIN_TOKEN` for scripts and CI.
- An audit log and a per-query log of what agents asked and what they were told.
- Incremental indexing: files are hashed, only changed files are re-embedded, removed files are
  deleted from the index.
- One Docker image, `contextator/contextator`, for `linux/amd64` and `linux/arm64`, holding both
  PostgreSQL and the app. The schema updates itself on startup, and `npm run reset-password` ships
  inside the image as a last-resort recovery tool.

[Unreleased]: https://github.com/Contextator/Contextator/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Contextator/Contextator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Contextator/Contextator/releases/tag/v0.1.0
