# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

**Before `1.0.0`, a minor version may change a public contract** — the HTTP and MCP APIs, the MCP
tool names and their parameters, environment variable names — without a major bump. Once `1.0.0`
ships, that stops.

## [Unreleased]

### Added

- **You can point Contextator at a PostgreSQL you already run.** Put a `DATABASE_URL` in `.env` and
  the container starts no database of its own: it connects to the server you named, creates and
  migrates its schema there, and leaves the `contextator-pgdata` volume empty. The server needs to be
  PostgreSQL 16 or newer with pgvector installed or installable by that role. **On this topology its
  backups are yours** — `docker exec contextator pg_dump …` dumps the embedded database and reaches
  nothing else.
- **A `-slim` image, for the same thing without a PostgreSQL inside it at all.** Every published tag
  now has a `-slim` twin — `latest-slim`, `0.1-slim`, `0.1.0-slim` — carrying the application alone,
  on both architectures. It requires `DATABASE_URL` rather than accepting it, and started without one
  it exits immediately naming the variable and what the server behind it has to be.
  `docker-compose.slim.yml` runs it. The default image and the default installation are unchanged: a
  single container with its own PostgreSQL is still what `docker compose up -d` gives you.
- `/api/health` tells a signed-in caller which of the two databases it is talking to
  (`database.mode`), and an administrator the host, port and database name — never the credential.
- A source's **Language** setting is back on the dashboard, and `turkish` is one of the values it
  offers. Naming a source's language makes PostgreSQL stem it, so a Turkish question asking about
  `anahtarı` now finds a page that says `anahtarın`. Changing the setting re-indexes that source, as
  changing its content type already did.

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

### Fixed

- **The same search over the same documentation returns the same page again.** Between two results
  that scored identically, which one came first was decided by an internal identifier that is minted
  fresh every time a project is re-indexed — so a project holding two languages could hand back a
  different fifth result after a rebuild, with nothing having changed but the rebuild. Equal results
  are now ordered by the documents themselves: the shorter excerpt first, then the document's own
  path and the position of the passage within it.
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

[Unreleased]: https://github.com/Contextator/Contextator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Contextator/Contextator/releases/tag/v0.1.0
