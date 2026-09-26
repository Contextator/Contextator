# Contextator

**Self-hosted, multi-tenant MCP documentation server.** Give a project its document sources — mounted
folders, git repositories, uploaded archives, a Notion workspace, a Confluence Cloud site or Data Center instance, a published
documentation site — and it
becomes its own [Model Context Protocol](https://modelcontextprotocol.io) endpoint that AI agents
(Cursor, Claude Code, Claude Desktop, …) can search semantically:

```
http://localhost:3444/mcp/<project-name>
```

- **One URL per project, fully isolated.** Each project has its own document collection and
  vector embeddings in PostgreSQL + [pgvector](https://github.com/pgvector/pgvector). A client
  connected to `/mcp/billing` never sees `/mcp/mobile`.
- **Many sources per project.** A local directory, a git repository (or one subdirectory of it), an
  upload of files/folders/`.zip`/`.tar.gz`/`.rar`, a Notion workspace, a Confluence Cloud site or Data Center instance, or a
  published documentation site read from its `sitemap.xml` —
  combined into one searchable endpoint. Every source is mounted under its own name, so documents read
  as `handbook/install.md`.
- **100 % local by default.** Embeddings are generated on the CPU with
  [transformers.js](https://huggingface.co/docs/transformers.js) (`Xenova/multilingual-e5-small`, a
  retrieval model covering 100 languages incl. Turkish). Switch to OpenAI embeddings with two env vars.
- **Both MCP transports on the same URL.** Streamable HTTP for current clients, legacy HTTP+SSE for older ones.
- **Admin dashboard** at `http://localhost:3444/` to manage projects and their sources — add a repository, drop a folder or an archive on the page, test a connection, trigger re-indexing and watch progress.
- **Accounts and roles.** People sign in with their own account. `root` and `admin` manage everything and everyone; a
  `member` sees only the projects it is assigned to, as a read-only `viewer` or an `editor` that adds sources, uploads
  files and re-indexes. Any account can mint its own named, scoped, revocable **API token** for a script or CI job;
  `ADMIN_TOKEN` still works too. See [Accounts and permissions](#accounts-and-permissions).
- **A door on each MCP endpoint, with three settings.** A new project requires a **bearer token** that your client
  sends as an ordinary header, and is handed its first one as it is created, shown once. Make it **open** if its documents should be readable by anyone who can reach the
  URL, or require an **account** and its access becomes the memberships you already manage. Browser-based connectors
  sign in through OAuth 2.1. See [MCP access](#mcp-access).
- **Incremental indexing.** Files are hashed; only changed files are re-embedded, removed files are deleted.
- **More than Markdown.** `.html`, `.docx`, `.csv` and `.pdf` are converted to Markdown as they are indexed, so an agent
  reads a Word file or a PDF the way it reads a page of documentation. See [File types](#file-types).

Stack: TypeScript · Node.js 22+ · Fastify 5 · PostgreSQL 16 + pgvector · Drizzle ORM · `@modelcontextprotocol/sdk` · `@huggingface/transformers` · `unpdf` / `mammoth` / `turndown`.
Ships as **one Docker container**, published as `contextator/contextator`, that holds both the database and the app.
Free software under the **AGPL-3.0-or-later** ([why](#license)), with a commercial license available.

---

## Quick start (Docker)

Everything runs in a single container named `contextator`: PostgreSQL 16 + pgvector and the Node.js
app, started and stopped together by a small entrypoint script. Data lives in Docker volumes and
survives container removal (see [Data and persistence](#data-and-persistence)). The published image
is `contextator/contextator`; `docker compose up -d` pulls it, so the two files below — not the whole
repository — are all a fresh install needs.

```bash
mkdir contextator && cd contextator
curl -fsSLO https://raw.githubusercontent.com/Contextator/Contextator/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/Contextator/Contextator/main/.env.example
cp .env.example .env
# in .env, pick the code that /setup will ask for once:
#   SETUP_CODE=whatever-you-like
# optional: point DOCS_HOST_PATH at your own docs (it defaults to ./docs, created empty if missing)
docker compose up -d
docker compose logs -f            # wait for "embedding model ready"
```

**The port is published on `127.0.0.1` only.** The dashboard and every MCP endpoint answer on this
machine and nowhere else, so a container started on a laptop or an office server does not appear on
the network it is plugged into. To publish it on the network deliberately, set `CONTEXTATOR_BIND=0.0.0.0`
in `.env` and put a TLS-terminating reverse proxy or a VPN in front of it — see
[Running behind a reverse proxy](#running-behind-a-reverse-proxy).

1. **Create the first account.** Open **http://localhost:3444/setup**, enter the `SETUP_CODE` you chose, and create
   the `root` account. The code exists so that nobody who reaches the server before you can claim it; it stops working
   the moment that account is created.

   Left `SETUP_CODE` empty? The server generates one and prints it at every start until an account exists — it is in
   the log you are already tailing:

   ```
   ┌─ Contextator first-run setup ───────────────────────────────────────────┐
   │ No user accounts exist yet; the dashboard is waiting for its first one. │
   │                                                                         │
   │   Open   http://localhost:3444/setup                                    │
   │   Code   K7QM-92QX-VBHT                                                 │
   │                                                                         │
   │ A new code is printed on every start until that first account exists.   │
   └─────────────────────────────────────────────────────────────────────────┘
   ```
2. Sign in at **http://localhost:3444/**.
3. Press **New project** (or `n`): name it `demo`, and for the directory point at one of your own
   subfolders under `/docs` — the host folder from `DOCS_HOST_PATH` is mounted there, so `docs/handbook`
   on the host is `/docs/handbook` here. Leaving the directory empty creates an empty project;
   add its sources afterwards with **Add source**.
4. Watch the project's status go `indexing → idle` in the list; the **Document sources** panel shows every
   source with its document count, last sync and any error.
5. Use the **Connect an agent** tabs (Claude Code, Cursor, Claude Desktop, legacy SSE) for copy-paste snippets. From
   a source checkout, the bundled smoke test does the same thing from the command line:

```bash
npm install && npm run smoke -- http://localhost:3444/mcp/demo "how do I re-index"
```

The first start initialises the database and downloads the embedding model (~470 MB for the default
fp32 model, ~235 MB with `EMBEDDING_DTYPE=fp16`, ~120 MB with `EMBEDDING_DTYPE=q8`, ~90 MB for
`all-MiniLM-L6-v2`) into the `contextator-models` volume; later starts take a few seconds.

Without Compose:

```bash
docker run -d --name contextator -p 127.0.0.1:3444:3444 \
  -e SETUP_CODE=whatever-you-like \
  -v contextator-pgdata:/var/lib/postgresql/data \
  -v contextator-models:/app/.cache/models \
  -v contextator-data:/data \
  -v /path/to/your/docs:/docs:ro \
  contextator/contextator
```

Building the image from source instead of pulling it:
[wiki/Installation#build-the-image-yourself](https://github.com/Contextator/Contextator/wiki/Installation#build-the-image-yourself).

**Tags.** `latest` is the newest stable release; `0.2` tracks the latest patch inside the `0.2.x`
line; `0.2.0` is one exact, immutable release. Pin a versioned tag for anything you upgrade
deliberately by setting `CONTEXTATOR_TAG` in `.env` (e.g. `CONTEXTATOR_TAG=0.2.0`) and running
`docker compose up -d` — this reads at every start, not only the first. Every one of those tags from
`0.2.0` on has a `-slim` twin — `latest-slim`, `0.2-slim`, `0.2.0-slim` — which is the section below.

### Bringing your own PostgreSQL

The single container above is the default and most installations should stay on it: there is nothing
to provision, nothing to connect, and one thing to back up. Some installations already have a
PostgreSQL, though — a managed service, an HA pair, a server whose backups and monitoring somebody
else operates — and for those, **one line of `.env` moves the database out of the container**:

```bash
DATABASE_URL=postgres://user:password@db.example.com:5432/contextator
docker compose up -d
```

The container then starts no PostgreSQL of its own. It connects to that server, creates and migrates
its schema there at startup, and the `contextator-pgdata` volume stays empty. Nothing else changes —
same image, same command, same everything above.

For the application *without* a PostgreSQL inside the image at all, use the `-slim` tag with the
compose file that comes with it. It carries no database, so `DATABASE_URL` is required rather than
optional; started without one it exits and says so:

```bash
curl -fsSLO https://raw.githubusercontent.com/Contextator/Contextator/main/docker-compose.slim.yml
docker compose -f docker-compose.slim.yml up -d
```

What that server has to be, either way: **PostgreSQL 16 or newer**, with **pgvector installed or
installable by the role in the URL** — the first start runs `CREATE EXTENSION IF NOT EXISTS vector`,
which on a managed service usually means a role such as `rds_superuser` or `cloudsqlsuperuser`, or
enabling the extension on the instance beforehand — and **a database of its own**, which may be
empty.

And what changes hands with it: **backups are yours.** `docker exec contextator pg_dump …` dumps the
*embedded* database and reaches nothing else, so on this topology everything the database holds —
projects, documents, embeddings, accounts, MCP tokens, the audit and query logs — is covered by
whatever covers that server, and by nothing this image ships. The `contextator-data` volume needs
backing up on both topologies: an uploaded source's content is not in the database at all.

### Running on Kubernetes

For operators who already run Kubernetes rather than a single Docker host, `charts/contextator/` is a
Helm chart for the same `-slim` + external-database topology above — one Pod by design (ADR-0078),
strict value validation (ADR-0092), and no default `image.tag` (it must name a `slim` image):

```bash
helm repo add contextator https://contextator.github.io/Contextator
helm repo update
helm install ctx contextator/contextator \
  --set database.url="postgres://user:password@db.example.com:5432/contextator" \
  --set-string image.tag="<version>-slim"
```

Full install guide — `SECRET_KEY` handling, Ingress and reverse-proxy interplay, persistence, probes,
security context, resource sizing, uninstalling — on
[Running on Kubernetes](https://contextator.com/en/docs/kubernetes/), and in `charts/contextator/README.md`.

## Document sources

A project is a set of **sources**. Each one is added in the dashboard (**Add source**), carries a
URL-safe `name`, and that name becomes the prefix of every document it contributes: a file
`install.md` in a source named `handbook` is indexed, searched and read as `handbook/install.md`.
The name is the mount point, so it cannot change after creation; everything else can.

| Type | What it is | Synced by |
|------|-----------|-----------|
| **Local directory** | A folder mounted on the server, scanned in place. Must live inside `ALLOWED_DOC_ROOTS`; nothing is copied. | Reading it at index time |
| **Git repository** | A shallow, single-branch checkout under `DATA_DIR`. Any HTTPS git server: GitHub, GitLab, Bitbucket, Gitea/Forgejo/Codeberg. Optionally only a **subdirectory** of the repository (`docs/`). | `git fetch` of the branch tip at the start of every index run, a push webhook, or the sync interval below |
| **Upload** | Files, whole folders (structure preserved) and archives — `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.rar` — unpacked on the server. Add to the existing files or replace them all. | Nothing to sync; the files live under `DATA_DIR` |
| **Notion** | Every page shared with an internal integration (or the configured root pages/databases and their descendants), rendered to Markdown, nested by parent page. | The Notion API, re-rendering only pages whose `last_edited_time` changed |
| **Confluence** | **Cloud, or Data Center 7.9 and later** (see below). Every page in the chosen spaces — or in every space the account can read — rendered from Confluence's storage format to Markdown, nested the way it is in the wiki: `<name>/<space>/<parent page>/<page>.md`. | The Confluence REST API, re-rendering only pages whose version number changed; a signed webhook on Data Center, or the sync interval below |
| **Documentation site** | **Public pages only** (see below). A published site, found through its `sitemap.xml`, its `llms.txt` or a crawl from one start URL, written under the site's own paths: `<name>/guide/install.html`, converted to Markdown by the same transform `.html` files use. | Conditional GETs against the site (`ETag`/`Last-Modified`), inside the five crawl ceilings below |

Sources are synced at the start of every index run, one after another; a source that fails to sync is
reported on its own row and the others still index. **Sync** on a row and **Re-index** in the header
both queue the same run.

### Versions: two releases of one product in one project

A source can carry a **version** — the *Version* field in its dialog — and every document it indexes is
stamped with it. An agent then narrows a search to one release:

```
search_docs(query: "rotate the signing key", version: "v3")
```

Omit it and the search reaches every version, which is what it did before the field existed and what a
project with one release wants. The point is the project that has two: index v2 and v3 of a product side
by side and an agent asked about "the timeout setting" will otherwise answer confidently out of
whichever page ranked higher.

**It is a free-text label, matched exactly, and there is no "latest".** `v3`, `2024.1`, `next` and
`legacy` are all things a documentation team writes, and a product that claimed to order them would be
confidently wrong about at least one — which is the failure this feature exists to stop. An agent that
asks for a version this project does not have is told so, with the versions it *does* have, and picks
one.

**Several sources may share a version**, which is the reason this is not the `source` filter under
another name: `api-v3` and `sdk-v3` are two mount points of one release, and `version: "v3"` searches
both. Changing a source's version re-indexes it, the way changing its content type does.

### Confluence: Cloud or Data Center

Cloud (API token) and Data Center (personal access token) authenticate differently, so **Deployment** is
picked by hand, not detected. Data Center connections to a private address are refused unless the host is
listed in `CONFLUENCE_ALLOWED_HOSTS` (ADR-0088), one source indexes at most 5 000 pages, and a named
space that stops answering fails the sync rather than deleting its documents. On Data Center a signed
webhook can start a sync as soon as a page changes.

Full setup for both deployments, the SSRF boundary, space scoping and the webhook: [Confluence](https://contextator.com/en/docs/confluence/).

### Documentation sites: public pages, and five ceilings

A **Documentation site** source reads a public site's own `sitemap.xml` or `llms.txt`, or crawls it from
one start URL — no login, no credential stored, no headless browser. Five instance-wide ceilings
(`WEB_MAX_PAGES`, `WEB_MAX_DEPTH`, `WEB_REQUEST_DELAY_MS`, `WEB_CRAWL_BUDGET_MS`, `WEB_RESPECT_ROBOTS`)
bound a crawl and stop it by name rather than failing the run; only a `sitemap.xml` source gets a cheap
freshness check, `llms.txt` and crawl sources re-fetch in full on every scheduled run.

Field-by-field setup, the five ceilings table, `robots.txt` handling and common problems: [Documentation Site Source](https://contextator.com/en/docs/documentation-site-source/).

### Keeping a source fresh on its own

A source can carry a **sync interval** — the *Sync every* field in its dialog — and the server checks it
on that schedule instead of waiting for somebody to press a button.

**It does not re-read the files to decide.** Each source type answers one cheap question first, and the
index run only happens when the answer moved since the last successful sync:

| Type | What is asked | Instead of |
|------|---------------|-----------|
| Git | `git ls-remote` on the tracked branch — one ref advertisement, no objects | A fetch |
| Notion | One `search`, newest edit first, one result | A page read per page, 350 ms apart |
| Confluence | One CQL search over the same spaces the run indexes: how many pages there are, and when the newest was touched | A listing plus a body read per page |
| Documentation site | Two requests — `robots.txt`, then the `sitemap.xml`: how many URLs it lists, and the newest `<lastmod>` among them | A conditional GET per page |
| Local, Upload | The file count and the newest modification time | Reading and hashing every file |

A check that cannot answer — a directory that has gone, a rate-limited API, a network that is down —
counts as *changed*, so the run happens and reports the real error. The check is an optimisation; it is
never a reason a source silently stops syncing.

Two things about the timing are deliberate. A source that is switched on is given a **random** first
due time inside its first interval, so a hundred sources added by one script do not all wake in the
same minute — and keep not waking together afterwards. And scheduled runs queue **behind** anything a
person or a webhook asked for, so pressing *Re-index* never means waiting for the timer's backlog.

**Upgrading an existing installation switches nothing on.** Every source that already existed stays at
*Never*; only sources created afterwards take `SYNC_DEFAULT_INTERVAL_MINUTES` (an hour by default, and
`0` means new sources are unscheduled too). If this server should never make an outbound call nobody
asked for, it does not have to be turned off — it was never on.

### Content types (flavors)

A source can declare what its files really are, which applies a small transform before chunking: plain
Markdown/text (no transform), Obsidian vault (see below), Notion export (strips the page id Notion
appends to names and links), or OpenAPI/Swagger (see below — the one content type that turns a
specification into **one document per endpoint**). Changing a source's content type drops its stored
file hashes and queues a full re-index, because the transform runs after the hash that decides what to
re-embed.

Full comparison table and the Notion-export id-stripping example: [Content Types](https://contextator.com/en/docs/content-types/).

### OpenAPI and Swagger

An API specification is the most useful single thing you can give an agent about an API, and the least
useful shape to give it in: one `openapi.yaml` is one document that contains the answer to three hundred
different questions, so it matches every query and answers none of them.

With the **OpenAPI / Swagger** content type a specification is indexed as **one document per
operation** — path, method, summary, parameters, request and response schemas and examples, each under
its own heading so a hit carries a breadcrumb like `GET /pets/{petId} > Responses > 200`. `search_docs`
returns the endpoint, not the file. Both OpenAPI 3 and Swagger 2.0 are read, a specification is measured
against `MAX_SPEC_FILE_BYTES` (8 MiB, roughly 400 MB of parsed heap at the default) before it is read, and
one rendered document is capped at 2 000 lines, one specification at 5 000 operations.

Full behaviour — path derivation, `$ref` resolution depth, malformed-file handling, versioning per
specification: [Content Types](https://contextator.com/en/docs/content-types/#openapi--swagger).

### Obsidian vaults

A vault — mounted on the server as a **Local directory** with content type *Obsidian vault*, or uploaded
as a folder or zip through the **Obsidian vault** tab — has its own syntax flattened so an agent reads
plain Markdown: `[[wikilinks]]`, block references, image embeds, callouts and `%% comments %%` are all
converted; `.obsidian/` and other dot-directories are skipped.

Full conversion table and frontmatter handling: [Obsidian Vaults](https://contextator.com/en/docs/obsidian-vaults/).

### Notion

An **internal integration** (token from `notion.so/profile/integrations`, shared with the pages or
databases you want indexed) turns each page into one Markdown file, nested by parent page, re-rendered
only when its `last_edited_time` moves. A rejected token or an unreadable root fails the source with that
message rather than reporting an empty workspace — which would otherwise delete every page already
imported.

Full setup steps, the rendered-block list and rate limiting: [Notion](https://contextator.com/en/docs/notion/).

### Private repositories and tokens

An access token pasted into a git source's **Access token** field is encrypted with `SECRET_KEY`
(AES-256-GCM), never returned by the API or shown again. The username sent with it is detected from the
provider (`x-access-token` for GitHub, `oauth2` for GitLab, `x-token-auth` for Bitbucket Cloud) unless you
type one in the **Username** field. **Git is read over HTTPS only** — SSH remotes are not supported and no
SSH key can be stored (ADR-0086); a repository reachable only over SSH is mirrored yourself and added as a
**Local directory** source instead.

Provider-by-provider token scopes and usernames, the SSH-mirror workaround, common `Test connection`
errors: [Git Repository Source](https://contextator.com/en/docs/git-repository-source/).

### Push webhooks

Every git source gets a webhook URL and a shared secret (shown while editing the source):

```
POST http://<your-host>/api/webhooks/git/<source-id>
```

Add it as a **push** webhook in the repository settings with that secret; GitHub, GitLab, Gitea/Forgejo
and Bitbucket are all recognised and signature-verified before anything is queued. A Confluence Data
Center source has its own webhook, off by default (ADR-0085) and turned on from the source's edit dialog.

Full provider-by-provider field screenshots, the Confluence webhook walkthrough and troubleshooting:
[Push Webhooks](https://contextator.com/en/docs/push-webhooks/).

## Accounts and permissions

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
[Configuration](#configuration) for the full variable list.

Full role matrix, the temporary-password flow, `ADMIN_TOKEN` and API-token mechanics: [Accounts and Permissions](https://contextator.com/en/docs/accounts-and-permissions/). Full SSO setup, linking and unlinking, and every guardrail around `root`: [Single Sign-On](https://contextator.com/en/docs/sso/).

Accounts govern the dashboard and the admin API. The MCP endpoints have their own door — see
[MCP access](#mcp-access) below.

## MCP access

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

### Account required, and connecting a browser-based client

**account required** is the mode where this dashboard's memberships reach `/mcp/*`. A client has to act as somebody,
and it then reads the project only while that account is a member of it — checked on **every request**, so removing a
membership, disabling an account or resetting its password cuts the connection off on its next call rather than at some
expiry. A static `ctxm_…` token names nobody, so it is refused here; that is the point of the mode rather than a
side effect.

A client gets an account-backed credential through OAuth 2.1, which is what browser-based MCP connectors already speak
and what the MCP authorization specification defines for remote servers. You do not configure anything: point the
connector at `http://host:3444/mcp/<project>`, and it discovers this server's authorization endpoints, registers
itself, and sends you to a page here to sign in and approve it. What it gets back acts as *your* account.

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

Clients that cannot set an `Authorization` header — a browser `EventSource` on the legacy SSE transport, for one —
cannot reach a token-protected project at all. Leave those projects open, or put the whole instance behind an
authenticating proxy.

## Data and persistence

| What | Path in the container | Default volume | Override (`.env`) |
|------|-----------------------|----------------|-------------------|
| PostgreSQL cluster: projects, documents, embeddings | `/var/lib/postgresql/data` | `contextator-pgdata` | `CONTEXTATOR_PGDATA_VOLUME` (another volume name) or `CONTEXTATOR_PGDATA_PATH` (absolute host directory) |
| Downloaded embedding models | `/app/.cache/models` | `contextator-models` | `CONTEXTATOR_MODELS_VOLUME` or `CONTEXTATOR_MODELS_PATH` |
| Materialised sources: uploaded files, git checkouts, Notion pulls | `/data` | `contextator-data` | `CONTEXTATOR_DATA_VOLUME` or `CONTEXTATOR_DATA_PATH` |
| Your documentation (read-only) | `/docs` | – | `DOCS_HOST_PATH` (default `./docs`) |

`docker compose down`, `docker compose pull && docker compose up -d`, and `docker rm contextator` all
keep the volumes. Only `docker compose down -v` or `docker volume rm` deletes them. Examples:

```bash
CONTEXTATOR_PGDATA_PATH=/srv/contextator/pgdata     # Linux server: keep the database on a chosen disk
CONTEXTATOR_MODELS_PATH=D:/contextator/models       # Windows host directory (forward slashes)
CONTEXTATOR_PGDATA_VOLUME=contextator-pgdata-v2     # or simply another named volume
```

Host directories are created on first start and the entrypoint fixes their ownership. Both kinds of
override were verified on Linux-style paths and on Docker Desktop for Windows (WSL 2 backend), where
PostgreSQL initialised and indexed fine on a `C:/…` directory. Named volumes remain the faster choice for
the database on Docker Desktop; if `initdb` ever reports permission errors on a host directory, switch
that mount back to a volume.

**Everything from here to the end of this section is about the embedded PostgreSQL.** On an
installation that set `DATABASE_URL` ([Bringing your own PostgreSQL](#bringing-your-own-postgresql))
there is no cluster in the container to dump: the three commands below reach nothing, the `pgdata`
volume is empty, and backing that database up — and restoring it, and watching it — is whatever
already covers the server it runs on. The two bullets below about what a dump does *not* contain
apply on both topologies, and so does the paragraph about `/data`.

PostgreSQL listens on `127.0.0.1` inside the container only and is not published, so everything here
goes through the container.

**One command takes the backup, because a `pg_dump` is not the installation:**

<!-- MIRRORED-IN backup-and-restore: ../wiki/Backup-and-Data.md ../.ssot/OPERATIONS.md -->

```bash
docker exec contextator npm run backup -- /data/backups/contextator-$(date +%F).tar.gz
docker cp contextator:/data/backups/contextator-$(date +%F).tar.gz .
```

Restoring on a fresh installation — which is the case that matters — starts with the directory:

```bash
# The directory first — on a fresh installation nothing has created it yet, and `docker cp` into a
# directory that is not there answers `no such directory`.
docker exec contextator sh -c 'mkdir -p /data/backups'
docker cp contextator-2026-09-22.tar.gz contextator:/data/backups/

# Reads the manifest and every refusal, writes nothing:
docker exec contextator npm run restore -- /data/backups/contextator-2026-09-22.tar.gz --check
docker exec contextator npm run restore -- /data/backups/contextator-2026-09-22.tar.gz
docker compose restart contextator
```

<!-- /MIRRORED-IN -->

Run `npm run backup` with no path at all and it writes `<DATA_DIR>/backups/contextator-backup-<timestamp>.tar.gz`
— on the data volume, never in the container's working directory, which is an image layer.

**These two blocks are mirrored in two other places**, and both follow this one:

| Mirror | Why it exists |
|---|---|
| `wiki/Backup-and-Data.md` → *Backing up*, *Restoring* | The wiki is the only published documentation until this branch merges |
| `.ssot/OPERATIONS.md` → §4.1, §4.2 | The operations record, read by a maintainer who holds both working trees |

`restore` overwrites a live database, so these must not drift: change a command **here**, then in
both. `test/readme-mirrors.test.ts` fails when they differ — in either direction, and also when one
of them is dropped from the list above.

The archive holds the database, the materialised files of every **upload** source — which exist nowhere
else — and a manifest that is the first entry in it, so `--check` costs one small read of a file that
may be gigabytes.

**`SECRET_KEY` is not in it and never will be.** A backup carrying the key would be the whole instance
in one file, on a volume with a weaker access story than the environment it came from. What travels is
a fingerprint of the key — 128 bits of keyed HMAC — which is what lets `restore` **refuse a wrong or
missing key before it writes anything, when that key would cost something real** — an archive whose
sources hold no sync credential encrypted under it restores anyway, with a note, instead of stopping
the one case that is unambiguously safe. Only `git`, `notion` and `confluence` sources hold a sync
credential, so only their secrets count. An archive taken before the manifest recorded which types it
counted is judged on the rows of its own dump, still before the target is touched: a secret stored on a
`local`, `upload` or `web` source by an older release does not refuse the restore, and after the restore
such secrets — which nothing ever read — are set to empty and their number is printed. Keep the key
where the archive is not.

That key is rotatable — a four-step runbook (`npm run rotate-secret` is step 3, ADR-0075 is the record
of why) — which gives the paragraph above a second edge: **retiring the old key — removing
`SECRET_KEY_PREVIOUS` — and then discarding it invalidates every archive taken before the rotation
that carries a source's sync credential — a private git, Notion or Confluence token — encrypted under
it.** The old archive's fingerprint names a key the environment no longer holds, and for that archive
`restore` refuses, because the credential's ciphertext was written under the key that was retired and
discarded and cannot be re-derived; an archive with no such credential restores anyway, and the
refusal starts at step 2 of the four, not step 4. Keeping the retired key instead of discarding it
keeps that archive restorable until its retention expires. A rotation is bracketed by backups, in
three steps and in this order: a normal backup **before** the
rotation, under the current key; a fresh archive **after** `npm run rotate-secret` reports every row
converted and before `SECRET_KEY_PREVIOUS` is removed, under the new key — the oldest one the
rotated instance can restore; and the retired key kept in the secret store, labelled and not beside
the archives, until the retention of the oldest pre-rotation archive expires — only then discarded.
The full runbook, with each step's command, is
[wiki/Security#rotating-secret_key](https://github.com/Contextator/Contextator/wiki/Security#rotating-secret_key).

The restore also refuses a dump taken from a newer PostgreSQL major version than the server it is going
into; going the other way, 16 to 17, is the documented upgrade and is what the command exists for.

**By hand, when you want the database and nothing else** — and these are the two commands the test
suite runs:

```bash
docker exec -it contextator psql -U contextator
docker exec contextator pg_dump -U contextator -Fc contextator > contextator.dump
docker exec -i contextator pg_restore -U contextator -d contextator --clean --if-exists < contextator.dump
```

`test/integration/backup-restore.itest.ts` seeds a real PostgreSQL, dumps it, **drops the database**,
restores it, and then asserts that the schema, the search results — identical rows, identical order,
identical scores — and the next start of the application all come back unchanged. A row count would not
have caught a restore that lost the vector index or the lexical column, so it is not one of the
assertions. The same file then does the whole round trip through `npm run backup` and `npm run restore`,
with an upload source and an encrypted credential, and asserts that a wrong key leaves the instance
untouched.

Two things a **dump** does not contain, which is the whole reason the command above exists:

- **`SECRET_KEY`.** It is an environment variable. Without the original key, every stored source
  credential has to be re-entered. Keep it somewhere the dump is not — the dump plus the key is the
  whole instance — and keep the key you retire when you rotate, or the dumps older than the rotation
  become unrestorable.
- **`/data`.** Git checkouts are re-clonable and Notion pulls are re-pullable, but **an upload source's
  `current/` directory is the only copy of its content anywhere**. A `/data` backup can be restricted to
  those and skip the re-clonable gigabytes, which is exactly what `npm run backup` does.

Take the backup when no project is `indexing`: a re-index writes a second generation beside the live one
and `pg_dump` cannot filter rows, so a dump taken mid-run is twice the size. Expect a dump of roughly
2 KB per indexed chunk — vectors dump as text and compress back down — and expect most of a restore's
time to be the HNSW indexes being rebuilt: one per project, and each scans every chunk in the instance
to find its own project's rows, so a restore is sized by the instance and the project count together.

**A backup holds project creation and deletion until it ends.** `pg_dump` reads the database in one
snapshot, and creating a project builds its HNSW index with `CREATE INDEX CONCURRENTLY` while deleting
one drops it with `DROP INDEX CONCURRENTLY` — both wait for every transaction open when they start.
Creating a project (`POST /api/projects` or the dashboard), deleting one or importing one during a
backup returns when the backup finishes; nothing fails, and searches and indexing into existing
projects are not held. Schedule the backup away from the hours projects are created.

`POSTGRES_PASSWORD` is applied when the cluster is created. To change it later run
`ALTER USER contextator PASSWORD '...'` via `psql` and update `.env` before the next start.

### Upgrading PostgreSQL across a major version

**An ordinary image upgrade never does this.** `docker compose pull` moves the application; it does not
move the cluster, because the cluster is a volume and the image's PostgreSQL major version is what can
read it. The day a release moves from PostgreSQL 16 to 17 is the day this applies, and it applies
**before** the pull, not after.

What happens if you just pull:

```
PostgreSQL Database directory appears to contain a database; Skipping initialization
FATAL:  database files are incompatible with server
DETAIL:  The data directory was initialized by PostgreSQL version 16, which is not compatible with
         this version 17.11 (Debian 17.11-1.pgdg12+2).
[contextator] PostgreSQL exited during startup (exit code 1)
```

The container exits 1, `restart: unless-stopped` starts it again, and it exits 1 again. **Nothing is
damaged**: the old cluster is untouched and the old image still reads it.

**If that is where you are right now, this is the way out and it is one line.** Put `CONTEXTATOR_TAG`
back to the major you were on, `docker compose up -d`, and you are exactly where you were — then do the
upgrade below, in order, on the running old image. Do **not** start with the rollback block further
down: that one restores a *parked copy* of the cluster, and on an accidental pull no copy has been
made yet, so it has nothing to restore from.

`pg_upgrade` is not the path, and it is worth knowing why: it needs the binaries of *both* majors
present at once, and this image carries exactly one. So the path is a logical dump and a restore — the
same `npm run backup` and `npm run restore` as above, run across the version boundary.

**Find out what your cluster volume is actually called before anything else**, because step 3 removes it
by name and `docker run -v <name>:/from` **creates an empty volume when that name does not exist, without
an error**. `docker-compose.yml` names it `${CONTEXTATOR_PGDATA_VOLUME:-contextator-pgdata}`, so an
instance that set that variable has a different name — and one that set `CONTEXTATOR_PGDATA_PATH` has no
volume at all but a host directory, which is copied and moved with `cp -a` on the host instead.

Step 3 is **one `&&` chain** rather than a list with a warning between the lines, and that is the whole
of the protection: `docker volume inspect` fails on a name that is not there, `cp -a` fails on a full
disk, the `PG_VERSION` comparison fails on a short copy — and any of those stops the chain **before**
`docker volume rm`. **The removal is deliberately the last link**, so "stopped" and "nothing was
removed" are the same sentence. Pasting a whole block in one go is how this is actually used, so the
guards are in the shell and not in the prose around it.

**Read what `STOPPED:` actually says, because the two blocks say different things on purpose.** Each
is the `||` of a chain, so it prints when *any* link fails, and what is true at that moment depends on
which side of the deletion the chain stopped on. In step 3 the deletion is the last link, so stopping
means the volume is still there. In the rollback it cannot be last — the volume has to be emptied
before it can be refilled — so the emptying and the refilling are one container command, and the
message states the only thing true in every failure of that chain: the parked copy was only read. A
message that said "nothing has been deleted" in both places would be wrong in one of them.

On an instance that keeps the cluster in a host directory (`CONTEXTATOR_PGDATA_PATH`) there is no
volume in any of this: copy that directory aside with `cp -a` on the host, check the copy, and empty
the original instead of removing a volume.

<!-- MIRRORED-IN postgres-major-upgrade: ../wiki/Backup-and-Data.md -->

```bash
PGVOL=${CONTEXTATOR_PGDATA_VOLUME:-contextator-pgdata}   # from your .env; the default is shown
OLD=16                                                   # the major you are leaving
```

```bash
# 1. On the OLD image, still running. Take it when no project is indexing.
#    No mkdir here: `backup` creates the directory it is given. Step 5 needs one, because
#    `docker cp` does not.
docker exec contextator npm run backup -- /data/backups/pre-pg17.tar.gz
docker cp contextator:/data/backups/pre-pg17.tar.gz .     # off this host, not beside the volume

# 2. Stop the old container. KEEP its cluster — it is the rollback.
docker compose down

# 3. Copy the old cluster aside, CHECK THE COPY, and only then remove the original.
#    Step 4 recreates the volume — Compose creates a named volume it does not find — so there is
#    no `docker volume create "$PGVOL"` here to be the link after the deletion.
docker volume inspect "$PGVOL" >/dev/null &&
  docker volume create "$PGVOL-pg$OLD" &&
  docker run --rm -v "$PGVOL":/from -v "$PGVOL-pg$OLD":/to alpine sh -c 'cp -a /from/. /to/' &&
  [ "$(docker run --rm -v "$PGVOL-pg$OLD":/to alpine cat /to/PG_VERSION 2>/dev/null)" = "$OLD" ] &&
  docker volume rm "$PGVOL" ||
  printf '%s\n' \
    "STOPPED: see the error above." \
    "$PGVOL has NOT been removed: the removal is the last link of that chain, so it was either" \
    "never reached or refused by Docker. The parked copy $PGVOL-pg$OLD may or may not exist and" \
    "may or may not be complete — nothing depends on it yet." \
    "Fix the error and run this block again; it is safe to repeat."

# 4. Pull the new image and start it. It initdb's the empty volume and creates an empty schema.
docker compose pull && docker compose up -d
docker exec contextator psql -U contextator -c 'select version()'

# 5. Put the instance back.
docker exec contextator sh -c 'mkdir -p /data/backups'
docker cp pre-pg17.tar.gz contextator:/data/backups/
docker exec contextator npm run restore -- /data/backups/pre-pg17.tar.gz --check
docker exec contextator npm run restore -- /data/backups/pre-pg17.tar.gz
docker compose restart contextator
```

**The rollback is step 3 in reverse, and it is a copy rather than a rename** — Docker has no
`volume rename`. Put `CONTEXTATOR_TAG` back to the version you were on, then:

```bash
# Re-stated here on purpose: a rollback is run later, and often in a shell that never saw step 1.
PGVOL=${CONTEXTATOR_PGDATA_VOLUME:-contextator-pgdata}
OLD=16

docker compose down
# The emptying and the refilling are one container command, so no link here deletes something the
# next link then fails to replace. `$PGVOL-pg$OLD` is only ever read.
docker volume inspect "$PGVOL-pg$OLD" >/dev/null &&
  docker run --rm -v "$PGVOL-pg$OLD":/from -v "$PGVOL":/to alpine \
    sh -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/' &&
  docker compose up -d ||
  printf '%s\n' \
    "STOPPED: see the error above." \
    "Nothing in this block writes to $PGVOL-pg$OLD — it is only read — so the cluster you are" \
    "rolling back to is whatever it was before you started." \
    "$PGVOL may be untouched, emptied, or half-written depending on where this stopped, so do NOT" \
    "start the old image against it yet. Fix the error and run this block again: it empties and" \
    "refills $PGVOL from scratch, so repeating it is safe."
```

<!-- /MIRRORED-IN -->

That throws away whatever the new major had in it, which after step 5 is the restored instance — so it
is a rollback to the moment of step 1 and not to the moment you run it. Anything indexed in between is
re-indexed.

**Three things to know before you start.**

- **`SECRET_KEY` has to be the same on the other side.** It is not in the archive, and the restore stops
  before writing if it is missing or different. Have `.env` in front of you — and if you have rotated
  `SECRET_KEY` since this archive was taken, `.env` is now the *wrong* key: a pre-rotation archive can
  only be restored with the key it was taken under, so use the retired key here or take a fresh backup
  before starting.
- **The restore rebuilds every index, and that is most of the wall clock.** Size the maintenance window
  from the whole instance's chunk count.
- **The restore refuses the other direction.** A dump taken from 17 will not go into a 16 server, and it
  says so before writing rather than half-applying. So a rollback is the *volume*, not the dump.

**This section is the source for this procedure, and it is not the only copy of it.** It is written
here, beside the code that implements `backup` and `restore` and versioned with it, because a
procedure that deletes a cluster has to have exactly one copy that decides what it says.

| Mirror | Why it exists | Rule |
|---|---|---|
| `wiki/Backup-and-Data.md` → *Upgrading PostgreSQL across a major version* | The wiki is the only published documentation until this branch merges, and an operator whose cluster will not start cannot be sent to a page they cannot reach | Kept **byte-identical** to the commands above. **If you change a command here, change it there.** Where the two disagree, **this copy wins** |

`test/readme-mirrors.test.ts` checks that byte-identity on every `npm test` run that can see the
mirror checkouts, fails rather than shrugs when a listed mirror is missing, and pins how many mirrors
this file claims — a list that can quietly get shorter is not a list. See ADR-0073 as amended by
ADR-0074.

## Connecting AI clients

Point Claude Code, Cursor, Claude Desktop or any other MCP client at `http://localhost:3444/mcp/<project>`
— the dashboard's **Connect** panel prints the exact snippet, token header included when the project
requires one. Three read-only tools are exposed: `search_docs` (hybrid search, ranked excerpts),
`list_topics` (the indexed document list) and `read_document` (one file's Markdown, by path or heading
range). See [MCP access](#mcp-access) for the auth modes.

Ready-to-paste config for every client, structured output, MCP resources and the relevance floor:
[Connecting AI Clients](https://contextator.com/en/docs/connecting-ai-clients/) and
[MCP Tools](https://contextator.com/en/docs/mcp-tools/).

## File types

A source indexes `.md`/`.mdx` by default and can be told to take `.txt`, `.html`/`.htm`, `.csv`, `.docx`
and `.pdf` as well; `.yaml`/`.yml`/`.json` are readable only through the
[OpenAPI / Swagger](#openapi-and-swagger) content type. **Everything becomes Markdown on the way in**,
once, at the edge, so the chunker, the embedder and `read_document` see one format. A file that cannot be
converted — a scanned or encrypted PDF, a Word file that is all images — is refused by name rather than
indexed blank, and the refusal never fails the source or the project.

Full per-type conversion table (what each format keeps and loses), the size and page caps that bound a
single file while it converts, and the PDF-length benchmark against `MAX_STORED_DOCUMENT_BYTES`:
[Document Sources](https://contextator.com/en/docs/document-sources/#what-gets-indexed).

## How indexing works

Each run syncs every source, hashes files to skip what has not changed, converts and chunks what has
(frontmatter-aware, split at headings, a breadcrumb kept per chunk), then embeds each chunk and writes it
beside a keyword index — search is **hybrid**, meaning and exact wording fused by rank, which is why an
environment variable name finds its page as readily as a question does. A **force** re-index rebuilds
everything beside the live index rather than replacing it first, so the project keeps answering while it
runs. `CHUNK_MAX_TOKENS` defaults to a measured **96**, not the model's much larger window — filling the
window measures worse.

Full run mechanics, the chunk-budget measurement, hybrid search and rank fusion, and the cross-lingual
search limit (measured, not fixed, with what to do instead): [Indexing](https://contextator.com/en/docs/indexing/)
and [Embedding Models](https://contextator.com/en/docs/embedding-models/#how-search-actually-works).

## Configuration

Everything is an environment variable; see [`.env.example`](.env.example) for the full annotated list.
The variables that most installs touch:

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` / `HOST` | `3444` / `0.0.0.0` | |
| `DATABASE_URL` | – | Empty uses the embedded PostgreSQL; set it to bring your own — see [Bringing your own PostgreSQL](#bringing-your-own-postgresql) |
| `ALLOWED_DOC_ROOTS` | `/docs` | Comma-separated. Project directories **must** live inside one of these |
| `SECRET_KEY` | – | At least 32 characters. Encrypts git/Notion/Confluence tokens and webhook secrets at rest |
| `ADMIN_TOKEN` | – | Machine access to `/api/*` with root permissions |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | `local` / `Xenova/multilingual-e5-small` | See *Changing the embedding model* below |
| `PUBLIC_BASE_URL` / `TRUST_PROXY` | – / `0` | Required together behind a reverse proxy — see below |
| `OIDC_ISSUER_URL` | – | On/off switch for federated sign-in — see [Single Sign-On](https://contextator.com/en/docs/sso/) |

The full table — every storage, upload, chunking, search-ranking, sync, auth and observability variable,
each with its reasoning — is on [Configuration](https://contextator.com/en/docs/configuration/).

### Running behind a reverse proxy

Nothing is in front of this by default. Put nginx, Caddy, Traefik or a cloud load balancer in front and
**three settings have to move together**, or sign-in rate limiting, MCP OAuth and the session cookie each
break in a way that does not announce itself:

```bash
TRUST_PROXY=172.18.0.0/16        # the proxy's address or CIDR, or `loopback` if it is on the host
PUBLIC_BASE_URL=https://docs.example.com
AUTH_COOKIE_SECURE=1
```

Full reasoning for each of the three, what breaks without them, and the "name the proxy, not the
network your clients are on" rule for `TRUST_PROXY`: [Configuration](https://contextator.com/en/docs/configuration/#running-behind-a-reverse-proxy).

### Changing the embedding model

Changing `EMBEDDING_MODEL` (same dimension) triggers an automatic full re-index once you press
`Re-index now` on each project; a different-dimension model (e.g. OpenAI's `text-embedding-3-small`)
needs `RESET_VECTORS=1` on one restart first. Full procedure for both cases, plus upgrading across a
default-model change: [Embedding Models](https://contextator.com/en/docs/embedding-models/#changing-the-model).

## Admin API

Every endpoint under `/api/*` returns JSON and is authenticated by the dashboard's session cookie,
by `Authorization: Bearer <ADMIN_TOKEN>` (machine access, root permissions), or by an account's own
scoped API token. It covers projects and their live indexing jobs, sources of every type, MCP tokens,
accounts and API tokens, project membership, and an audit log that is written by the policy layer
itself — no handler can add a route without being covered. `GET /metrics` exposes Prometheus text
separately, gated by a signed-in account, `ADMIN_TOKEN`, `METRICS_TOKEN`, or `METRICS_PUBLIC=1`.

Full endpoint tables (projects, sources, uploads, webhooks, MCP tokens, accounts, tokens, audit
query parameters) and the audit log's guarantees and limits — what it records, what it deliberately
does not (refused requests, actions that fail after committing), its performance at 200,004 rows,
and that it is not tamper-evident: [Admin API](https://contextator.com/en/docs/admin-api/).

## Contributing to Contextator

Running it without Docker, the checks a change has to pass, the full file-by-file project layout, how
the single container and the schema migrations work, and the licence grant a pull request needs — all
of that lives in [`CONTRIBUTING.md`](CONTRIBUTING.md), not here.

## Security notes

The port is published on `127.0.0.1` only by default; MCP endpoints require a token unless a project is
explicitly set `open`; source tokens are encrypted at rest with `SECRET_KEY` (AES-256-GCM) and rotatable
without re-entering them; local and Confluence sources are confined against path escapes and private-network
egress; passwords are salted `scrypt` and sessions are revocable rows; and the last active root account can
never be deleted, demoted or disabled.

Full write-up of every guarantee above, plus what a reverse proxy has to add and what a static MCP token
does and does not protect: [Security](https://contextator.com/en/docs/security/).

## Troubleshooting

Symptom → fix tables for embedding-dimension and chunk-budget mismatches, the model download and offline
setup, PostgreSQL container restarts, document-root and source-token errors, webhook signature failures,
search-floor tuning, sign-in and session problems, and MCP/OAuth connector errors:
[Troubleshooting](https://contextator.com/en/docs/troubleshooting/).

## Contributing and security

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the whole of how this project is worked on: getting it running, the
four checks a change has to pass, the three places where one statement is kept in two files, and the commit
register. Read it before the first pull request — it also explains the licence grant an outside
contribution is asked for ([`CLA.md`](CLA.md), signed on the pull request), which exists because the commercial
option below depends on the copyright being held in full.

**Found a security problem? Do not open an issue.** [`SECURITY.md`](SECURITY.md) says where it goes
instead, and lists the things that look like vulnerabilities and are documented behaviour — a project left
`open`, and what an MCP token does and does not grant.

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) is the Contributor Covenant, and it applies here.

## License

**GNU Affero General Public License, version 3 or later** ([`LICENSE`](LICENSE), also served by every instance at
`/license.txt`).

Contextator is free software: run it, read it, change it, redistribute it. The one obligation the AGPL adds over the
GPL is section 13, and it is the reason this license was chosen for a server: **if you modify Contextator and let people
reach your modified version over a network, you owe those users its complete source**, under the same license. Running
the unmodified software — for yourself, your team or your company — triggers nothing at all.

```
Contextator — self-hosted MCP documentation server
Copyright (C) 2026 Muhammet Şafak — Tunedness

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
see the GNU Affero General Public License for more details.
```

The documents you index are yours; the license covers Contextator's own code, and an MCP client talking to `/mcp/…`
does not become a derivative work of it. Dependencies keep their own permissive licenses — the
`/license` page of a running instance lists them.

**Commercial license.** The copyright is held in full by Muhammet Şafak, so a separate commercial license — without the
source-disclosure obligations of sections 5, 6 and 13 — can be granted where the AGPL does not fit. Ask at
[tunedness.com](https://tunedness.com). This is an alternative offered alongside the AGPL, not a restriction of it.
