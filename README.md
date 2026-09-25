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

**Tags.** `latest` is the newest stable release; `0.1` tracks the latest patch inside the `0.1.x`
line; `0.1.0` is one exact, immutable release. Pin a versioned tag for anything you upgrade
deliberately by setting `CONTEXTATOR_TAG` in `.env` (e.g. `CONTEXTATOR_TAG=0.1.0`) and running
`docker compose up -d` — this reads at every start, not only the first. Every one of those tags has
a `-slim` twin — `latest-slim`, `0.1-slim`, `0.1.0-slim` — which is the section below.

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
Helm chart for the same `-slim` + external-database topology above. It is published to a Helm
repository on this project's GitHub Pages:

```bash
helm repo add contextator https://contextator.github.io/Contextator
helm repo update
helm install ctx contextator/contextator \
  --set database.url="postgres://user:password@db.example.com:5432/contextator" \
  --set-string image.tag="<version>-slim"
```

The repository is filled by the release workflow, from the first release that carries the chart
onwards; until that release is out (and GitHub Pages is turned on for the `gh-pages` branch), the URL
answers 404 — install from a checkout instead, `helm install ctx ./charts/contextator` with the same
flags. The chart's own `version` moves independently of the application's: patch for a fix, minor
for a new value, major for a removed or renamed value or one the chart newly rejects.

It deploys exactly one Pod — this chart does not expose a `replicaCount` value, and setting one fails
the install as an unknown key, because MCP sessions and the indexer both live in that one process
(same reason horizontal scaling is out of scope generally, below). Every value is checked against the
chart's strict `values.schema.json`: a misspelt key or a wrong type fails `helm install` and names the
key, rather than being ignored. Like the `-slim` image itself, it refuses to install without
`DATABASE_URL` or an equivalent Secret. `image.tag` has no default either: it must name a `slim` image
(a string, hence `--set-string` for a numeric-looking tag). No `-slim` tag has been published yet —
`<version>-slim`, `<major>.<minor>-slim` and `latest-slim` start with the first release after
`v0.1.0` — so until then, build the `slim` target yourself and push it to your own registry. See
`charts/contextator/README.md` for the full install guide, including the `SECRET_KEY`/persistence/probe
design, running behind an Ingress, and measured resource sizing; the reasoning is decision records
ADR-0078 and ADR-0092.

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

Pick the **Deployment** when you add the source. It is not detected, because the two authenticate
differently and a wrong guess would send the credential the wrong way.

- **Cloud** — the REST API under `https://<site>.atlassian.net/wiki`, authenticated with an Atlassian
  account e-mail and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). Put the
  site URL in with its `/wiki` path, the e-mail of the account the token belongs to, and the token.
- **Data Center 7.9 and later** — the base URL your users open, **including any context path**
  (`https://intranet.example.com/confluence`), and a **personal access token**, which is sent as a
  bearer; there is no e-mail. The server's version is read anonymously before any credential is sent,
  and an older release, a version that cannot be read or a server that is not Confluence is refused with
  the version named, on **Test connection** and on sync. **Confluence Server**, the product line before
  Data Center, is not supported.

Either token is stored encrypted with `SECRET_KEY` and is never shown again or returned by the API.

**A Data Center on the internal network needs one more step.** The base URL is typed by an editor and
the server connects to it with the source's token, so where it may connect is bounded
(ADR-0088):

- loopback, link-local (the cloud metadata address `169.254.169.254` included), unspecified and
  multicast addresses are **always refused**;
- private addresses — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` — are refused
  **unless the host is listed in `CONFLUENCE_ALLOWED_HOSTS`**.

So if your Data Center resolves to a private address, add its host name to that variable and restart:

```
CONFLUENCE_ALLOWED_HOSTS=wiki.corp.example
```

The check runs on the address the connection actually uses, after DNS, and again on every redirect, so
neither a name that resolves inward nor a redirect to an internal address gets past it. A refusal names
the rule on the source's row and in the Test message — for example ``refused: `wiki.corp.example`
resolves to a private address; list `wiki.corp.example` in CONFLUENCE_ALLOWED_HOSTS to allow it`` — and
no request, and so no token, is sent. The list lifts only the private rule, and only for the names on
it; there is no switch that turns the check off.

Leave *Spaces* empty and the source indexes every space the account can read; name space keys — one per
line, `ENG`, `OPS` — and it indexes exactly those. The account's own permissions are the outer boundary
either way: this product never sees a page the account cannot.

Confluence's storage format (the XHTML a page is stored as) goes through the same HTML→Markdown transform
`.html` files do, so tables, code blocks, task lists and admonitions survive as structure. Macros are
unwrapped: the text inside an expand or a panel is indexed, the macro's own configuration is not.

**One source indexes at most 5 000 pages.** A wiki larger than that is indexed up to the ceiling and
the run says so, in those words, on the source's row — because the alternative is a source that looks
completely indexed while `search_docs` answers "not in the documentation" about pages that exist. Split
a larger wiki across several sources by naming fewer spaces on each; the scheduled check below reports
the space's real total beside the number indexed, so the two are visible together.

**If one of several named spaces stops answering, nothing is deleted.** A renamed space key, or a
permission withdrawn from the account, reads to the API as a space with no pages — not as an error —
and the ordinary "remove what is gone" pass would then delete every document that came from it while
the run reported success. A configured space that held documents a moment ago and offers none now fails
the sync instead, naming the space. With *Spaces* left empty there is no list of what should be there,
so that check cannot be made; name your spaces if you want it.

On Data Center a **signed webhook** can start a sync as soon as a page changes — see
[Push webhooks](#push-webhooks). It complements the sync interval below; it does not replace it.

### Documentation sites: public pages, and five ceilings

A **Documentation site** source points at one of three things, and the driver reads the document rather
than the URL to decide which it is: a `sitemap.xml` (including a `<sitemapindex>`, which is followed),
an `llms.txt` (whose Markdown links are the pages), or **one start URL** to crawl from — staying on that
host and at or below that path, so `https://acme.example/docs/` means the documentation and not the
company. When the entry point is not recognisably any of the three, the source **refuses and says so**
rather than guessing; set *Entry format* by hand to tell it which.

**Public pages only. There is no login.** No credential is stored on this source type at all. A
documentation site behind SSO, a customer portal, a staging site behind basic auth: none of them is in
scope, and half a login flow would be a connector that fails in a way nobody can diagnose.

**No headless browser, and no blank documents either.** A page a browser renders from JavaScript serves
`<div id="root"></div>` to everything that is not a browser. Such a page is **refused by name** on the
source's row — "no text outside its scripts and styles" — rather than indexed as a document that exists,
matches nothing and reads as empty.

**This is the only source type that reaches a host nobody here has an account with**, so five ceilings
are enforced on every run. All five are instance settings (`WEB_*` in `.env.example`, where each one's
default is argued), and reaching any of them **stops the run and says which** on the source's row:

| Setting | Default | What it bounds |
|---------|---------|----------------|
| `WEB_MAX_PAGES` | 1000 | Pages one source **fetches** in a run; also nested sitemaps read |
| `WEB_MAX_DEPTH` | 10 | Links followed from the entry point; also `<sitemapindex>` nesting |
| `WEB_REQUEST_DELAY_MS` | 500 | Minimum gap between two requests — requests are never concurrent |
| `WEB_CRAWL_BUDGET_MS` | 900000 | Total time one run may spend fetching |
| `WEB_RESPECT_ROBOTS` | 1 | Whether `robots.txt` is read and obeyed |

**`WEB_MAX_PAGES` counts pages fetched, not pages indexed**, and the difference is the point of the
setting. A page that was refused — a JavaScript-rendered shell with no text in it, a 404 from a stale
sitemap, a connection that failed — was still served by somebody's web server. Counting only what this
product kept would mean the worse a site behaves the less the ceiling bounds, which is exactly
backwards for the one setting that exists to protect a host nobody here has an account with. A URL that
was never requested is never charged: one `robots.txt` disallowed, or one on another host, is a
decision taken locally before anything leaves the process.

The same number also bounds how many nested sitemaps one run may read. `WEB_MAX_DEPTH` bounds how deep
a `<sitemapindex>` tree goes and nothing bounded how wide, so an index naming fifty thousand children is
fifty thousand requests before a single page URL exists for the page ceiling to charge.

`robots.txt` is obeyed by default, its `Crawl-delay` **raises** the pacing when it asks for more than
the instance's, and a `robots.txt` that cannot be read at all — a 5xx, a connection error — fails the
sync rather than being treated as permission. A 404 is permission: a site with no `robots.txt` has
disallowed nothing. `WEB_RESPECT_ROBOTS=0` exists for one case, an operator crawling a staging site they
own that disallows everything to keep it out of search engines.

Only a `sitemap.xml` can be checked for freshness without walking the site, so only that entry format
takes part in the cheap scheduled check below; an `llms.txt` source and a crawl source re-fetch on every
scheduled run, which is a reason to prefer a sitemap where the site publishes one.

The check costs **two** requests, not one: `robots.txt` and then the sitemap. `robots.txt` is
deliberately **not** cached between a sync and the check that follows it, or between checks — a site
that adds a `Disallow` would otherwise keep being crawled under rules this product read once and kept,
which is the wrong way round for a file whose whole purpose is to be re-read. Two requests against a
site of a hundred thousand pages is still the point of the mechanism.

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

A source can declare what its files really are, which applies a small transform before chunking:

- **Plain Markdown / text** — no transform.
- **Obsidian vault** — see below.
- **Notion export** — the 32-hex page id Notion appends to file and folder names (`Getting started 1a2b…5c6d.md`) is stripped from paths and from the links pointing at them.
- **OpenAPI / Swagger** — see below. The one content type that does not merely transform a file: it turns a specification into **one document per endpoint**.

Upload a Notion **Export → Markdown & CSV** zip with the *Notion export* content type; use the
**Notion** source type instead when you want the live API.

The content type is applied on the way into the chunker, after the file hash that decides what to
re-embed — so changing it drops the stored hashes of that source and queues a run, otherwise the new
transform would never reach a file whose bytes did not change.

### OpenAPI and Swagger

An API specification is the most useful single thing you can give an agent about an API, and the least
useful shape to give it in: one `openapi.yaml` is one document that contains the answer to three hundred
different questions, so it matches every query and answers none of them.

With the **OpenAPI / Swagger** content type a specification is indexed as **one document per
operation** — path, method, summary, parameters, request and response schemas and examples, each under
its own heading so a hit carries a breadcrumb like `GET /pets/{petId} > Responses > 200`. `search_docs`
returns the endpoint, not the file.

- The source also takes `.yaml`, `.yml` and `.json`, and **only** this content type does: no extension implies a specification, so nothing else is offered them.
- Each document is stored at `<file>/<method>-<path>` — `api/petstore.yaml/get-pets-petId`. The path is derived from the method and the URL path alone, so re-indexing the same specification lands on the same documents even if the file was reformatted.
- Delete an operation and its document disappears on the next run; the others are untouched.
- `$ref` is resolved within the file. A recursive schema is rendered until it points back at itself and then says so; anything deeper than eight levels says it stopped there. A reference into another file is named rather than followed.
- Markdown beside the specifications is still Markdown: a `README.md` in the same source is one document, as always.
- A `.yaml` that is not a specification — a Helm values file, a CI config — is reported on the source and skipped, the same way an unreadable PDF is. The run still succeeds. So is one that will not parse, and one written to make a renderer fail: a self-referential example, a `$ref` whose pointer will not decode. Nothing a specification can contain fails the run.
- Swagger 2.0 is read as well as OpenAPI 3, `definitions`, `in: body` parameters and `host`/`basePath` included; a 3.1 path item that is itself a `$ref` is followed.
- A specification is measured against `MAX_SPEC_FILE_BYTES` (8 MiB) before it is read — its own ceiling, well below the one for converted files, because parsing one produces an object graph around fifty-five times the size of the file, held for as long as that file is being indexed. At the default ceiling that is about **400 MB of heap** while one specification is indexed; lower it on a tight container.
- One rendered document is capped at 2 000 lines and one specification at 5 000 operations. Neither is reachable by a real API — the largest published specifications are around a thousand operations — and both exist because the file ceiling bounds the *parse* and bounds nothing about what a file asks to be *rendered*.

Two versions of the same API in one project do not collide — `v2/openapi.yaml/get-pets` and
`v3/openapi.yaml/get-pets` are different documents — and which one an agent gets is answered by
[the version field](#versions-two-releases-of-one-product-in-one-project): give each specification's
source a version and `search_docs` can be asked for one of them. Every document derived from a
specification carries its file's version, because forty operations rendered out of one file are forty
documents of one release.

### Obsidian vaults

A vault is a folder of Markdown, so it arrives either way:

- **Mounted on the server** — add it as a **Local directory** inside `ALLOWED_DOC_ROOTS` with content type *Obsidian vault*. Nothing is copied and edits show up on the next run.
- **Not on the server** — the **Obsidian vault** tab takes the folder itself or a zip of it; it is an upload source that carries the content type for you.

Either way the vault's own syntax is flattened so an agent reads plain Markdown:

| In the vault | Indexed as |
|--------------|-----------|
| `[[Guides/Install]]` | `[Guides/Install](Guides/Install.md)` |
| `[[Setup\|the setup guide]]` | `[the setup guide](Setup.md)` |
| `[[API#Auth]]` | `[API › Auth](API.md#auth)` |
| `[[#Konular]]` (same note) | `[Konular](#konular)` |
| `[[Install#^step-3]]` (block ref) | `[Install](Install.md#^step-3)` |
| `![[diagram.png]]` | `![diagram.png](diagram.png)` — images stay embeds |
| `![[Release Notes]]` | `[Release Notes](Release%20Notes.md)` — a note embed is a link, not a broken image |
| `> [!NOTE] Heads up` | `> **Note:** Heads up` — the callout's kind stays searchable |
| `%% private note %%` | removed; comments are written not to be read |

`.obsidian/`, other dot-directories and every non-document file (attachments, `.canvas`) are skipped.
Frontmatter is parsed by the chunker, and a `title` in it wins over the first heading.

### Notion

1. Create an **internal integration** at `notion.so/profile/integrations` and copy its token.
2. In Notion, share the pages or databases you want with that integration (… → Connections).
3. Add a **Notion** source and paste the token. **Test connection** reads the integration's own user
   and answers with its name, so a wrong token is obvious before any indexing.

Leave **Root pages or databases** empty to take everything shared with the integration; otherwise paste
page or database ids (or just their URLs — the id is picked out of them), one per line. Each page becomes
one Markdown file, nested in a folder named after its parent page, with the title, Notion id, URL and
`last_edited_time` in frontmatter. A page is re-rendered only when its `last_edited_time` moved, and a
page that stops being shared has its file removed.

Paragraphs, all three heading levels (including the blocks folded under a toggleable one), bulleted,
numbered and to-do lists with their nesting, quotes, callouts, code blocks, tables, dividers, equations,
bookmarks, images and file links are rendered; unknown block types are skipped rather than failing the
page. Notion's own rate limit is respected (~3 requests/second).

If the token is rejected, or none of the configured roots can be read, the source fails with that
message instead of reporting an empty workspace — which would otherwise delete every page it had
already imported. The other sources of the project still index, and the project reports
`2/3 sources synced; <source>: <reason>`.

### Private repositories and tokens

Paste an access token into the source's **Access token** field. It is encrypted with `SECRET_KEY`
(AES-256-GCM) before it is stored and is never returned by the API or shown again — the dialog only
says a token exists. The username sent with it depends on the provider and is detected from the URL:

| Provider | Username used with the token |
|----------|------------------------------|
| GitHub | `x-access-token` (classic PAT, fine-grained PAT, App installation token) |
| GitLab | `oauth2` (OAuth and personal/project access tokens); **a deploy token needs its own generated username** (`gitlab+deploy-token-N`) in the Username field |
| Bitbucket Cloud | `x-token-auth` for repository/workspace access tokens; an **API token** needs your Bitbucket username, or `x-bitbucket-api-token-auth`, in the Username field |
| Gitea / Forgejo / Codeberg / other | `token`, or whatever you type in Username |

A username you type in the Username field always replaces the default in the table.

**Git is read over HTTPS only. SSH remotes (`ssh://…`, `git@host:path`) are not supported**, and no
SSH key can be stored (ADR-0086). A private repository is reached one of two ways:

1. **A read-only HTTPS token for that one repository** — the narrowest credential each provider offers:

   | Provider | Token | Username |
   |----------|-------|----------|
   | GitHub | A fine-grained personal access token limited to the repository with *Contents: read*, or a GitHub App installation token | leave empty (`x-access-token`) |
   | GitLab | A project **deploy token** with `read_repository` | the token's generated username, e.g. `gitlab+deploy-token-42` — the default `oauth2` is refused for a deploy token |
   | Bitbucket Cloud | A repository access token with *Repositories: read* | leave empty (`x-token-auth`) |
   | Gitea / Forgejo | An access token with read scope on the repository | your username, or leave empty (`token`) |

   Use the repository's HTTPS clone URL (`https://gitlab.example.com/group/docs.git`).

2. **A mirror you keep yourself**, when the repository is reachable only over SSH. Clone or mirror it
   on the host, inside `ALLOWED_DOC_ROOTS`, keep it current with your own schedule (a cron job running
   `git pull`, or your CI), and add that directory as a **Local directory** source. It is then a folder
   like any other: there is no push webhook, no branch or subdirectory setting and no Test connection
   for it, and it is exactly as fresh as your schedule keeps it.

**Test connection** on a git source lists the remote refs without cloning; on a Notion source it reads
the integration's own user. Credentials pasted into the URL itself are stripped before storage.

### Push webhooks

Every git source gets a webhook URL and a shared secret (shown while editing the source):

```
POST http://<your-host>/api/webhooks/git/<source-id>
```

Add it as a **push** webhook in the repository settings with that secret. GitHub
(`X-Hub-Signature-256`), GitLab (`X-Gitlab-Token`), Gitea/Forgejo (`X-Gitea-Signature`) and Bitbucket
are recognised; the signature is verified before anything is queued, pushes to other branches are
ignored, and a valid delivery queues a re-index of the project. **Regenerate** invalidates the old
secret. The endpoint authenticates with this per-source secret, not with `ADMIN_TOKEN`.

#### Confluence Data Center webhook

A Confluence source has **no webhook until you turn it on** (ADR-0085): until then every delivery is
refused with `not_enabled` and nothing is stored. Confluence Cloud cannot send these — its webhooks need
a Forge or Connect app — so on Cloud the sync interval is the only trigger.

1. Edit the source and choose **Turn on** under *Confluence webhook*. A secret is generated; **Copy URL** and
   **Copy secret**:

   ```
   POST http://<your-host>/api/webhooks/confluence/<source-id>
   ```

2. In Confluence, **Administration → Webhooks → Create a webhook**: paste the URL and the secret and
   choose the page events (created, updated, removed, restored, moved). Confluence signs each delivery
   with `X-Hub-Signature: sha256=…` over the body; a delivery whose signature does not match is refused
   with `invalid_signature`.

Comments, labels, attachments, likes, user and group changes and **blog posts** cannot change what is
indexed, so those events are acknowledged and ignored; anything else — including permission changes
and an event this build does not know — queues a run. A burst of edits becomes one run, and runs are at
least the minimum webhook interval apart (`WEBHOOK_MIN_INTERVAL_MINUTES`, 5 by default): a webhook makes
the source **look soon**, not within seconds. Once on, the button reads **New secret** and replaces the
secret; **Turn off** removes it, after which deliveries are refused again.

It does not see everything: a delivery Confluence gave up on, a page that became unreadable to the
account without an event, and deliveries Confluence skips for hours after repeated failures all go
unnoticed until the next scheduled sync — so keep the sync interval on. The endpoint has to be
reachable from Confluence.

## Accounts and permissions

The dashboard and the admin API are behind a personal account. The first one is created at `/setup` with a one-time
code — either the `SETUP_CODE` you set in `.env`, or one the server generates and prints while no account exists. Its
only job is to make sure the operator, and not whoever reaches the server first, claims that account; it stops working
once one exists. After that, accounts are managed from **Users** in the top-right menu.

There are three instance roles, and on top of them a per-project role for members:

| | root | admin | editor | viewer |
|---|:--:|:--:|:--:|:--:|
| See the project list | all | all | its own | its own |
| Create / delete a project | ✓ | ✓ | – | – |
| Re-index (incremental or full) | ✓ | ✓ | ✓ | – |
| See a project's sources | ✓ | ✓ | ✓ | ✓ |
| Add, edit, delete, sync or test a source | ✓ | ✓ | ✓ | – |
| Upload and delete files | ✓ | ✓ | ✓ | – |
| See and regenerate a webhook secret | ✓ | ✓ | ✓ | – |
| See a project's members | ✓ | ✓ | ✓ | ✓ |
| Add, change or remove a member | ✓ | ✓ | – | – |
| Manage accounts | ✓ | ✓ (not root ones) | – | – |

`editor` and `viewer` are memberships, not roles: a `member` account gets one per project from **Members** on the
project page. `root` and `admin` reach every project without being listed.

Three rules are enforced no matter who asks:

- **The last active root account cannot be deleted, demoted or disabled.** An instance can never lock itself out of its
  own user management.
- **An admin cannot touch a root account** and cannot hand out the `root` role. Only another root can.
- **Nobody can disable, demote or delete themselves.**

New accounts get a temporary password — either one you type or one the server generates and shows exactly once. Until
the person replaces it at their next sign-in, every endpoint except the password-change loop answers `403
password_change_required`.

`ADMIN_TOKEN` is unchanged and still works: `Authorization: Bearer <token>` acts with **root** permissions, so scripts
and CI that predate accounts keep running. Treat it like a root password and keep it out of browsers.

For a new script or CI job, an **API token** is the recommended credential instead of `ADMIN_TOKEN`: any signed-in
account can mint one from *API tokens* in the account menu, name it, optionally restrict it to one project and an
expiry date, and pick exactly which routes it may call (`POST /api/projects/:id/reindex` and nothing else, for
example). The secret is shown once, at creation. A token can never do more than the account that minted it can, and
it can be revoked on its own — unlike `ADMIN_TOKEN`, which is all-or-nothing and requires an environment-variable
edit and a restart to retire.

Setting `OIDC_ISSUER_URL` adds a second door: `/login` shows an SSO button (`OIDC_BUTTON_LABEL`) beside
the password form, and the password form never goes away. A federated sign-in is matched to an account
by the provider's `sub` claim, never its e-mail claim — an e-mail is exactly what a misconfigured or
compromised provider could forge into reaching a different local account. By default
(`OIDC_AUTO_PROVISION=0`) SSO only signs in accounts an admin already created; turn it on and a first
successful sign-in mints one with `OIDC_DEFAULT_ROLE` (`admin` or `member` — never `root`, since the
one account this product cannot recreate from a provider claim stays a local password sign-in). Once
signed in, a federated account is governed by the same role table above as any other, and a provider
outage never blocks local password sign-in. See [Configuration](#configuration) for the full variable
list.

An existing local account can also **link** the provider to itself from its own account page — signing
in either way afterwards reaches the same account — and **unlink** it again, both self-service and both
requiring the caller's own session. `root` is refused a link (`403 root_local_only`), the same rule that
keeps `OIDC_DEFAULT_ROLE` from ever being `root`: the one account this product cannot recreate from a
provider claim never signs in over SSO.

**A linked account cannot be promoted to root, full stop.** `PATCH /api/users/:id` (and every other path
that changes a role — there is exactly one, `updateUser`) refuses with `409 root_requires_unlink` the
moment `role: "root"` is requested for an account that still has an SSO identity attached, regardless of
which credential is doing the promoting — a session, an API token, `ADMIN_TOKEN`. This is checked ahead
of the write, not after: the account's role never becomes `root` while the link exists, so there is
nothing for the "acts as root over SSO" case below to ever actually catch in normal operation — it is a
backstop, not the primary defence, kept in case some future path someday writes a role outside
`updateUser`. If it ever did fire, every request re-reads the session's role, and one that reads `root`
on a session opened over SSO is revoked and its cookie cleared right there, falling through to an
anonymous request rather than completing it.

**Unlinking is self-service and revokes the account's standing credentials in the same request:** every
session and every API token that account holds is invalidated the moment `DELETE /api/auth/oidc/link`
removes the identity — including the very session making that call — because unlinking is also what
clears the way for a later promotion, and nothing opened while the account was still provably tied to an
external identity provider should outlive that link. The same transaction revokes the account's **MCP OAuth
credentials** — every access and refresh token it was issued for `/mcp/<project>` — so an MCP client
signed in as that account gets `401` on its next request and has to authorize again; other accounts'
credentials are untouched. The audit event of the unlink records how many were revoked, as
`detail.revokedMcpCredentials`. Sign back in (locally, since the link is gone) to
get a working session again. Only after unlinking can another root account grant this one the `root`
role.
See `POST /api/auth/oidc/link` and `DELETE
/api/auth/oidc/link` in [wiki/Admin-API](https://github.com/Contextator/Contextator/wiki/Admin-API#single-sign-on).

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
of why) — which gives the paragraph above a second edge: **rotating the key, and then retiring the old
one, invalidates every archive taken before the rotation that carries a source's sync credential — a
private git, Notion or Confluence token — encrypted under it.** The old archive's fingerprint names a
key the environment no longer holds, and for that archive `restore` refuses, because the credential's
ciphertext was written under the key that was retired and cannot be re-derived; an archive with no
such credential restores anyway, and the refusal starts at step 2 of the four, not step 4. A
rotation is bracketed by backups, in three steps and in this order: a normal backup **before** the
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

Replace `demo` with your project name. The dashboard's **Connect** panel prints these for you.

**Claude Code**

```bash
claude mcp add --transport http demo-docs http://localhost:3444/mcp/demo
```

**Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per repo)

```json
{ "mcpServers": { "demo-docs": { "url": "http://localhost:3444/mcp/demo" } } }
```

**Claude Desktop** — `claude_desktop_config.json` (needs a stdio bridge such as `mcp-remote`)

```json
{ "mcpServers": { "demo-docs": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3444/mcp/demo"] } } }
```

**Legacy SSE clients** connect with `GET http://localhost:3444/mcp/demo`; the server answers with an
`endpoint` event pointing at `/mcp/demo/messages?sessionId=…`. Modern clients POST an `initialize`
request to the same URL and get Streamable HTTP. No client configuration is needed to pick one.

If the project requires a token, every one of these needs `Authorization: Bearer <token>` — on the SSE
stream and on the messages channel both. The dashboard's **Connect** panel prints the snippets with the
header already in place. See [MCP access](#mcp-access).

### Tools exposed to the agent

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `search_docs` | `query: string`, `limit?: 1-20` (default 5), `source?: string`, `path_prefix?: string`, `version?: string` | Hybrid search over the project's chunks — meaning and exact wording at once, so `HALYARD_DISPATCH_TIMEOUT` finds its page as readily as a question does. Returns ranked excerpts with file path, heading breadcrumb (`Guide > Install > Docker`), score and the passage either side of each excerpt. `source`, `path_prefix` and `version` narrow it to one source, one directory or one release; all three are optional and omitting them searches everything, as it always did. An unknown `source` or `version` is answered with the ones this project has, never with an empty page. When nothing clears the relevance floor it says *no good match* and points at `list_topics` instead of returning its least bad hit. |
| `list_topics` | `cursor?: string`, `limit?: 1-1000` (default 200) | Indexed documents grouped by directory, with title and chunk count. The first path segment is the source it came from. A project larger than one page ends its answer with a `next_cursor:` to hand back, so a thousand documents can be listed to the end. |
| `read_document` | `path: string`, `heading?: string`, `from?: int`, `to?: int`, `max_tokens?: 200-20000` (default 4000) | Markdown of one indexed file (path as shown by the other tools, e.g. `handbook/install.md`). Served from the database, so it works after the file has moved or gone. `heading` takes a breadcrumb straight out of a search result and returns that section and the subsections under it; `from`/`to` take a chunk range. Output is capped at `max_tokens`, counted with the embedding model's own tokenizer, and says where it cut and how to ask for the rest. |

The server also sends MCP `instructions` describing the project so agents know when to use which tool.

**Structured output is opt-in.** `MCP_STRUCTURED_OUTPUT=1` has each tool declare an `outputSchema` and return its
answer a second time as `structuredContent` — the same results, status and fenced text as fields, for a client that
wants to read them rather than parse prose. The text answer is identical either way. It is off by default because
Claude Code, when a result carries `structuredContent`, hands its model that and drops the text
([anthropics/claude-code#55677](https://github.com/anthropics/claude-code/issues/55677),
[#79944](https://github.com/anthropics/claude-code/issues/79944)), so the guidance written into each answer would reach
it only as a JSON field. Off, every tool definition and every answer is byte for byte what it was before the setting
existed. Independently of it, every project's indexed documents are also MCP resources
(`contextator://<project>/<source>/<path>`), listed and read behind the same auth and never beyond what `read_document` can reach.

**What an answer looks like, and what it costs.** Each excerpt is rendered with the chunk before and
after it, marked with a leading and trailing `…`, so an agent usually does not have to spend a
`read_document` call to see the sentence a chunk boundary cut in half. At most two excerpts come from
any one document, because five results that are five consecutive chunks of one page answer the question
once and crowd out four other pages. The whole answer is capped at `SEARCH_MAX_RESULT_CHARS` and says
so when it cuts. All three are settings; see the configuration table.

**Reading a document is not the same as reading a file.** `read_document` serves `documents.content` —
the text this server indexed, stored beside the chunks — and never touches the filesystem. So a document
stays readable after its file is renamed, its git checkout is re-cloned, or the whole source directory is
unmounted, and a page that was *never* indexed can never be served by mistake. The text is stored as the
indexer transformed it, which is what keeps `read_document` and `search_docs` from ever disagreeing about
what a page says; the price is that an Obsidian note's original `[[wikilink]]` syntax is not readable
through MCP, only the Markdown link it became. Documents indexed by an older version hold no stored text
and are read from disk until their next index run, which is the one case where a missing file is still an
error.

**The relevance floor is the one setting to know about before you change the embedding model.** Below
`SEARCH_SCORE_FLOOR` — a cosine similarity, defaulting to `0.82` — `search_docs` answers *no good
match* instead of handing over a hit an agent would cite. That number was measured against the default
model and means nothing on another one, so changing `EMBEDDING_MODEL` and leaving it alone can refuse
every search; the server warns about that at startup. What it catches is a question that is not about
your documentation at all. What it does **not** catch is a question shaped like your product whose
answer is not written down — those score exactly where real questions score, and no threshold
separates them.

`SEARCH_SCORE_FLOOR` (default 0.82) is the server's floor. A project can set its own from the query
panel, or turn the floor off for itself, when its corpus scores differently — prose-heavy corpora
usually want a lower one. The panel shows what a floor would have done to the searches already logged
before it is applied, and the server's `SEARCH_SCORE_FLOOR=0` still turns every project's floor off.

## File types

A source indexes `.md` and `.mdx` by default and can be told to take `.txt`, `.html`/`.htm`, `.csv`, `.docx` and
`.pdf` as well. **Everything becomes Markdown on the way in** — the chunker, the embedder and
`read_document` see one format, and the conversion happens once, at the edge.

`.yaml`, `.yml` and `.json` are the exception and are not on this list: no extension says what such a
file *is*, so they are readable only by the [OpenAPI / Swagger](#openapi-and-swagger) content type, and
a file it reads becomes several documents rather than one.

| Type | What it becomes | Kept | Lost |
|------|-----------------|------|------|
| `.md`, `.mdx`, `.txt` | itself, unchanged | everything | nothing |
| `.html`, `.htm` | Markdown via turndown + GFM | headings, lists, tables, code, links, `<title>` | scripts, stylesheets, `svg`, embedded image data (the `alt` text stays) |
| `.docx` | Markdown via mammoth, then the same converter | Word's own heading styles, numbered and bulleted lists, tables, links | images, footnotes, comments, tracked changes |
| `.csv` | one GFM table, `## Rows n–m` sections every 200 rows | the header above every section, quoted commas and newlines, `;`/tab/pipe delimiters | nothing of the data; cell newlines become `<br>` |
| `.pdf` | Markdown reconstructed from glyph positions | headings by font size, paragraphs rejoined across line ends and de-hyphenated, bullet and numbered lists, column-aligned tables, two-column reading order, running heads and feet dropped | footnotes, figures, and any table whose columns are not aligned |

Every failure — a parser's own exception included — leaves the conversion as a refusal that names the
file. That is not tidiness: the indexer treats an unrecognised exception as a failed *run*, and because
a malformed file fails the same way every time, one of them would stop the whole project from being
re-indexed until somebody found it.

**A file that cannot be converted is refused, not indexed.** A scan of paper contains pictures of words
and no words, and there is no OCR in this product. Such a file is skipped, the reason — naming the file
— is shown on its source in the dashboard, and the rest of the source indexes normally. The alternative
is a document that exists, matches nothing and reads as blank, which nobody ever notices is wrong. The
same happens to an encrypted PDF, a `.doc` renamed to `.docx`, a Word file whose content is entirely
pictures, a damaged file of any of these types, and a page or spreadsheet that converts to no text at
all.

**A refusal never fails the run.** The source is not marked failed and the project is not marked
failed: it synced, and everything else in it indexed. The dashboard shows the source's reason line
whether or not the source failed, which is the only thing that makes the refusal visible rather than
merely recorded. On an incremental run the file keeps whatever document it already had; a **rebuild**
(`force`, or a changed embedding model) publishes the corpus as it stands, so a file that can no longer
be converted is not in the new generation — the same rule the index applies to a source that cannot be read.

**Conversion runs on its own thread.** Every file type, the content-type transforms and the OpenAPI
expansion happen on a worker thread, not on the thread that serves the dashboard and the MCP endpoint —
so a file that takes a second to parse is not a second nobody can search in, and a parser that exhausts
its heap fails that file instead of taking the server with it. Nothing about the conversion itself
changes: the same transforms, producing the same Markdown. A thread that dies, or that is still
converting one file after `CONVERSION_TIMEOUT_MS` (two minutes), is a file refused **by name** with the
reason on its source, exactly as an unreadable PDF is; the thread is replaced and the run carries on.
The thread is kept between files and dropped after `CONVERSION_IDLE_MS` (one minute) of quiet, so an
idle server is not holding the heap a large document grew.

**What a file may cost while it is converted.** The memory is still this container's, wherever the
thread is, and until the caps below existed only the upload path had any size limit at all — a file
reached through a local directory or a git checkout was parsed at whatever size it happened to be.
Three caps bound it, and each closes something the others do not:

| Setting | Default | What it stops |
|---------|---------|---------------|
| `MAX_CONVERTED_FILE_BYTES` | 32 MiB | one enormous document taking the process down with it. Checked against the size the **scan** recorded, before the file is read — a limit applied to the bytes already in memory is not a limit. `.md`, `.mdx` and `.txt` are decoded rather than parsed and are not capped |
| `MAX_SPEC_FILE_BYTES` | 8 MiB | one enormous API specification taking the process down with it. Its own ceiling and not `MAX_CONVERTED_FILE_BYTES`, because a specification is parsed whole into an object graph around **fifty-five times** the size of the file — 8 MiB of YAML measured 444 MiB of objects — so the conversion ceiling would have bounded the wrong number. Checked against the scan's size, before the read. **The graph is not transient**: documents are rendered out of it one at a time, so it is resident for as long as that file is being indexed, beside a ~470 MB embedding model. Measured directly, a file at the ceiling needs about **400 MB of heap headroom** — it completes at `--max-old-space-size=384` and is OOM-killed at 320. Lower the ceiling on a container that cannot spare that; a refused file is named on its source and the run carries on |
| render caps | 2 000 lines / doc, 5 000 operations / file | what a specification asks to be **rendered**, which the byte ceiling does not bound at all: responses × media types is a count limited only by the file size divided by about forty bytes, so one 40 KB operation can ask for a hundred thousand lines. A document past the line cap says it was cut; a file past the operation cap is refused whole, because a truncated *endpoint list* would answer "not in the documentation" for endpoints that exist |
| `MAX_PDF_PAGES` | 2000 | a few kilobytes of PDF that *declares* a hundred thousand pages — every page is read into memory at once |
| `MAX_DOCX_UNPACKED_BYTES` | 256 MiB | the zip bomb. A `.docx` is a zip, and the size in its directory is a number the file's author writes, so each part is inflated through a counter and discarded, with the cap as the ceiling. DEFLATE reaches about 1030:1, so nothing short of measuring it is a bound |

A file over a cap is refused by name, the same way a scan is. So is a file the filesystem will not hand
over — deleted between the scan and the read, permissions changed, or simply larger than `fs.readFile`
will return.

A converted document is stored under its original path and extension (`handbook/support-handbook.pdf`),
and that is the path `search_docs` cites and `read_document` takes. Its **title** comes from the
document — a `<title>`, a PDF's `Title` metadata, the first heading — and falls back to the filename.

**Where a long PDF falls against `MAX_STORED_DOCUMENT_BYTES`** (1 MB of UTF-8, past which the prefix is
stored and `content_truncated` is set). Measured on generated manuals of 80, 200, 600 and 1600 pages,
each page a dense one — 42 lines of about 95 characters, a running head and foot, a chapter heading
every tenth page:

| Pages | Markdown | Per page | Extraction |
|-------|----------|----------|------------|
| 80 | 316 KiB | 4.0 KiB | 0.18 s |
| 200 | 795 KiB | 4.0 KiB | 0.21 s |
| 600 | 2393 KiB | 4.0 KiB | 0.61 s |
| 1600 | 6414 KiB | 4.0 KiB | 1.73 s |

So the cap bites at roughly **250 dense pages**, and a typical page is looser than these — call it 300
to 400 pages of a real manual. Past that the document is still fully searchable, because the cut is on
`documents.content` and not on the chunks: every page is chunked and embedded, and only the stored text
`read_document` serves is truncated, which the tool says. Extraction costs about a millisecond a page
and happens once, after the content hash says the file changed.

What is capped on the way *in* is the file itself: `UPLOAD_MAX_FILE_BYTES`, 50 MB by default.

## How indexing works

1. Every source of the project is synced in turn (git fetch, Notion pull; local and upload sources have nothing to fetch), then its directory is walked for the file types the source selected — `.md`/`.mdx` by default, optionally `.txt`, `.html`/`.htm`, `.csv`, `.docx` and `.pdf`, plus `.yaml`/`.yml`/`.json` on a source whose content type is OpenAPI (dotfiles, `node_modules`, `dist`, `build`, symlinks and `IGNORE_GLOBS` are skipped). Every path collected is prefixed with the source name, so two sources can both hold an `install.md` without colliding.
2. Every file is hashed (sha256) over its **raw bytes**, then converted to Markdown by its type ([File types](#file-types)) and the source's content type is applied (Obsidian wikilinks, Notion export ids). Unchanged files are skipped, changed/new files are re-chunked and re-embedded, files that disappeared are deleted. A file the [OpenAPI](#openapi-and-swagger) content type expands is several documents rather than one: every one of them carries the specification's hash, so an unchanged specification re-embeds nothing, and an operation that left the file leaves the index with it. A **force** re-index (and one triggered by a changed embedding model) rebuilds everything, and does it *beside* the live index rather than by wiping it first: the project keeps answering `search_docs`, `list_topics` and `read_document` for the whole run, and a run that fails halfway leaves the previous index serving instead of an empty project. Every finished run (mode, counts, duration, error) is stored in `index_runs`; the last 20 per project are kept and shown in the dashboard.
3. Chunking is Markdown-aware: frontmatter is parsed (`title` wins), MDX `import`/`export` lines and component tags are stripped, the document is split at headings (`#`–`####`) with a breadcrumb kept per chunk, and oversized sections are packed from paragraphs and fenced code blocks (code is never split mid-block when avoidable) with a small overlap.
4. Each chunk is embedded as `heading breadcrumb + content` and stored in `chunks`, under its project's own partial HNSW cosine index. The same string is also stored as a `tsvector` with a GIN index — that is the keyword half of search, and it is written in the same statement as the row, so the two halves can never describe different text.

**How the chunk budget is spent, and why it is 96.** Tokens are counted with the embedding model's own
tokenizer — the one the provider has already loaded — rather than approximated from the character count.
The approximation it replaced was not merely rough, it was biased by the text: on the retrieval corpus it
under-counted English by 17 % and Turkish by 11 %, so one setting meant two different chunk sizes in the
two languages this product serves first.

Two different model limits are involved and it is worth keeping them apart: the window a model was
*trained* at, and the point its tokenizer *truncates* at. They agree for the default
`Xenova/multilingual-e5-small` — both 512 — and they did not for the model before it, which read 128 and
truncated at 512. Where they differ, a chunk between the two is not cut: it is embedded in full, by
weights that were never trained to represent that much, and the vector that comes out looks exactly as
confident as any other. If you run a model this build has not heard of, state its window in
`EMBEDDING_MAX_INPUT_TOKENS`; the server works the numbers out from the model once it has loaded and
logs an `error` line naming them and a budget that fits, which `/api/health` and the project page carry
so it is still visible tomorrow.

`CHUNK_MAX_TOKENS` defaults to **96**, and that is a measurement and not a derivation. Fitting the window
would allow 496, and 496 measures *worse*: a chunk is embedded as one mean-pooled vector, so the more
text it holds the vaguer that vector is, and the fewer chunks a document produces the fewer chances the
right one has of being returned. On the golden set the budget was swept from 496 down to 64, and 88
through 108 all measured the same — 96 is the middle of that plateau rather than its edge. The budget is
charged for the heading breadcrumb as well as the content, because the breadcrumb is part of what is
embedded, and the overlap between chunks is dropped rather than allowed to push a chunk past the budget.

The default model is also **asymmetric**: its authors trained it with `query: ` in front of a search query
and `passage: ` in front of an indexed passage, so the server puts them there. Nothing you index or search
mentions them, and a model without prefixes — every other one this README names — encodes a query and a
passage identically, which costs nothing. The passage prefix is charged against `CHUNK_MAX_TOKENS` like
the breadcrumb is, because it is part of what the model reads. On the retrieval corpus the prefixes were
worth one question at rank 1 and nothing at `recall@5`; they are on because that is how the model was
trained, not because the measurement demanded it, and `EMBEDDING_QUERY_PREFIX=none` with
`EMBEDDING_PASSAGE_PREFIX=none` turns them off and restores the previous model id exactly.
Raise it on OpenAI, whose window is 8191.

On the golden set in [`eval/`](eval/), the tokenizer and budget work moved `recall@5` from 70.8 % to
79.2 %, and the move to `multilingual-e5-small` at 96/24 took it to 85.4 % with `recall@1` at 77.1 %.
**Changing the budget — or the model — re-chunks as well as re-embeds, so an existing project keeps its
old chunks until it is re-indexed.**

**Search is hybrid: meaning and exact wording, fused.** A 384-dimensional sentence model has no useful
representation of `HALYARD_DISPATCH_TIMEOUT` — it has a representation of the words around it, which is
why an operator asking which variable sets the attempt timeout used to be handed prose about the retry
schedule. So every chunk is also stored as a PostgreSQL `tsvector` of the same text, with a GIN index
beside the vector one, and a search runs both: fifty candidates by cosine distance, fifty by keyword
rank, combined with **reciprocal rank fusion** — `Σ 1/(60 + rank)` over whichever lists each chunk
appeared on — and truncated to your `limit` afterwards. It is one SQL statement and one round trip.

Ranks rather than scores, deliberately. Cosine similarity and `ts_rank` are not comparable quantities,
so any weighted sum of them would have to be re-learnt every time the embedding model changed; ranks
survive a model swap untouched. The consequence is that **the score on a result no longer explains its
position** — a result scoring 0.86 can sit above one scoring 0.88. `GET /api/projects/:id/search` and
the dashboard therefore also carry the rank the result held on each side, shown as `D3 L1`; a result
with an `L` and no `D` is an identifier the vector search could not see.

On the golden set — extended first with sixteen identifier-shaped questions written from the corpus
before anything was measured — the thirty identifier questions go from `recall@5` 76.7 % to 83.3 %, the
sixteen new ones from 75.0 % to 87.5 %, and the thirty-four natural-language questions do not move at
all. `recall@1` falls from 78.1 % to 75.0 %, which is the trade rank fusion makes: a chunk found by one
half alone cannot outrank a chunk found respectably by both. Cross-lingual retrieval, which a hybrid
search was expected to help, **did not improve** on the questions that measure it.

The keyword half indexes a source in PostgreSQL's `simple` configuration — words as written, no
stemming — unless the source **names its language**, and it asks each question in every configuration
the project's index actually holds. `simple` is still the default and it is the right one for
reference material: unstemmed, `HALYARD_DISPATCH_TIMEOUT`, `X-Halyard-Signature` and `HLY-4015` survive
into the index as the strings they are. Naming a language is what a body of prose wants instead —
PostgreSQL then stems it, so a Turkish question asking about `anahtarı` finds a page that says
`anahtarın`, which under `simple` are two unrelated strings that never match. The two live in one
project without interfering: each source is read in its own configuration and a single search reaches
all of them, each configuration contributing its own ranked list to the fusion.

Set it per source on the **Language** field of the source form; changing it re-indexes that source.
Earlier versions of this README said PostgreSQL has no Turkish configuration and that the field was
deliberately not offered in the dashboard. Both were true of the version that spoke one configuration
for the whole instance, and the first was never measured and is simply wrong: `turkish` is in
`pg_ts_config` on the image this product ships.

### Cross-lingual search is a known limit, and it is not being fixed

**Ask a question in the language of the documentation that answers it.** A Turkish question will find a
Turkish page and an English question will find an English one; a question that has to cross the boundary
mostly will not be answered, and this is a property of the embedding model rather than a setting you can
turn on.

**The server cannot cross that boundary, but the caller usually can — so it is told which language to
write in.** Every MCP client is a language model, and a language model can write a sentence in a
different language when it is told to. `list_topics` names a source's language when its `config.language`
sets one, and `instructions` directs the calling agent to write its `search_docs` query in the language
of the documentation it expects the answer from. This is a direction to the caller, not a change to
search: nothing below moved, and an agent that ignores the direction, or that is itself asking on behalf
of someone who cannot read the language it switches to, sees exactly the limit this section describes.

The measurement is in [`eval/BASELINE.md`](eval/BASELINE.md) and it is not close. Thirty questions ask
about a page written in the other language — fifteen in each direction, written from the corpus before
anything was run. Four of the thirty are answered in the top five. Twenty-seven of the thirty return, at
rank 1, a page in the language of the *question*: the model is not failing to understand what was asked,
it is ranking the language of the asking above the answer to it. Both directions fail equally, so there
is no "good" direction to prefer.

**Identifiers are the exception, and they are the useful one.** `HALYARD_DISPATCH_TIMEOUT`, `HLY-4015`,
`X-Halyard-Signature` — a string is the same string in both languages, and the keyword half of search
finds it whatever surrounds it. Of the nine cross-lingual questions in the set that name an identifier,
four are answered; of the twenty-one that are phrased as ordinary questions, none is. So an agent that
quotes the identifier it is looking for will cross the language boundary, and one that describes the
concept will not.

**What to do instead of waiting for a fix.** Keep each language in its own source and let an agent scope
its search with `source` or `path_prefix` — `search_docs` takes both, and `version` beside them. Two sources that each answer well
are worth more than one collection that answers either language badly, and an agent told which source to
ask is not relying on the encoder to bridge anything.

**Both remedies have been built and measured, which is why this is written down as a limit rather than
as a backlog item.** Hybrid search was the first: it recovered cross-lingual *identifier* retrieval and
not one natural-language question. A multilingual cross-encoder rerank over the fused candidates was the
second, behind `SEARCH_RERANK` — it took cross-lingual `recall@5` from 13.3 % to 33.3 %, which is still
below the 42.9 % the embedding model *before* this one managed, while costing thirteen ordinary
questions their rank-1 answer and taking a search from 12 ms to 1.2 s. It is off by default and should
stay off. What would actually fix this is a second, translation-trained encoder as an additional index —
roughly four times the download, a second vector column, and a full re-index on every installation — and
that price is not worth paying for a documentation server. If your corpus is genuinely bilingual and
cross-language search is essential to you, that is a reason to choose a different tool rather than a
reason to wait for this one.

## Configuration

Everything is an environment variable; see [`.env.example`](.env.example) for the full annotated list.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` / `HOST` | `3444` / `0.0.0.0` | |
| `CONTEXTATOR_BIND` | `127.0.0.1` | **Which host interface `docker compose` publishes the port on** (docker-compose only; the app never reads it). The default answers on this machine and nowhere else. `0.0.0.0` publishes on every interface — do that with a reverse proxy or a VPN in front, and set `TRUST_PROXY` and `PUBLIC_BASE_URL` to match. `HOST` above stays `0.0.0.0` either way: it is the interface *inside* the container, and Docker cannot forward a published port to a process listening only on the container's own loopback |
| `DATABASE_URL` | – | **Where the database is.** Empty — the shipped default — means the PostgreSQL embedded in the image, which the entrypoint starts and points the app at through the libpq `PG*` variables. Set, the container starts no PostgreSQL at all and connects to the server you named: PostgreSQL 16+, pgvector installed or installable by that role, a database that may be empty. See [Bringing your own PostgreSQL](#bringing-your-own-postgresql) — including that its backups become yours. The same line is what `npm run dev` on the host reads |
| `POSTGRES_PASSWORD` | `contextator` | Password of the embedded PostgreSQL (loopback only), applied when the cluster is first created. Unread once `DATABASE_URL` is set |
| `CONTEXTATOR_PGDATA_VOLUME` / `CONTEXTATOR_MODELS_VOLUME` | `contextator-pgdata` / `contextator-models` | Docker volume names (docker-compose only) |
| `CONTEXTATOR_PGDATA_PATH` / `CONTEXTATOR_MODELS_PATH` | – | Absolute host directories used instead of the volumes (docker-compose only) |
| `ALLOWED_DOC_ROOTS` | `/docs` | Comma-separated. Project directories **must** live inside one of these (path-escape protection). On Windows dev: `C:/path/to/docs` |
| `DOCS_HOST_PATH` | `./docs` | Host folder mounted read-only at `/docs` (docker-compose only) |
| `MODEL_CACHE_DIR` | `.cache/models` | Model download directory; `/app/.cache/models` inside the container |
| `IGNORE_GLOBS` | – | e.g. `**/CHANGELOG.md,drafts/**`. Applies to every source |
| `CONFLUENCE_ALLOWED_HOSTS` | – | Comma-separated host names (or IP literals) a Confluence source may reach **on a private address** (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), e.g. `wiki.corp.example`. Needed for a Data Center on the internal network; loopback, link-local (`169.254.169.254`), unspecified and multicast stay refused whatever is listed. Checked on the connected address and on every redirect (ADR-0088) |
| `DATA_DIR` | `.data` | Writable directory holding the materialised sources (git checkouts, uploads, Notion pulls). `/data` inside the container |
| `SECRET_KEY` | – | At least 32 characters (`openssl rand -hex 32`). Encrypts git/Notion/Confluence tokens and webhook secrets at rest (AES-256-GCM). Needed only once such a source exists. Changing it on its own leaves every stored token unreadable — replace it with a rotation instead: `SECRET_KEY_PREVIOUS` below |
| `SECRET_KEY_PREVIOUS` | – | The key being retired, set only for the length of a rotation. It never encrypts: reads fall back to it, every write uses `SECRET_KEY`. Set it, set the new `SECRET_KEY`, restart, run `npm run rotate-secret`, then remove it and restart again — that removal is what retires the old key |
| `MAX_STORED_DOCUMENT_BYTES` | `1048576` (1 MB) | How much of each document's text is kept in the database for `read_document`. Past it the prefix is stored and the tool says so. Compressed out of line by PostgreSQL, so the cost is a small fraction of the same document's vectors |
| `UPLOAD_MAX_FILE_BYTES` | `52428800` (50 MB) | Per uploaded file |
| `UPLOAD_MAX_FILES_PER_REQUEST` | `500` | The dashboard splits large folders across requests by itself |
| `UPLOAD_MAX_ARCHIVE_BYTES` | `268435456` (256 MB) | Per uploaded archive |
| `ARCHIVE_MAX_ENTRIES` / `ARCHIVE_MAX_TOTAL_BYTES` | `20000` / `1073741824` (1 GB) | Zip-bomb guards applied while extracting |
| `EMBEDDING_PROVIDER` | `local` | `local` or `openai` |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Any transformers.js feature-extraction model. Previous default, reads only 128 tokens: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`. English-only & faster: `Xenova/all-MiniLM-L6-v2`. All three are 384-d |
| `EMBEDDING_DIMENSIONS` | `384` | Must match the model. `1536` for `text-embedding-3-small` |
| `EMBEDDING_DTYPE` | `fp32` | `fp16` halves the download, `q8` downloads a ~4× smaller quantized model. The default model publishes all three; another model may not, and a missing artefact fails the download with a 404 |
| `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` | – / `text-embedding-3-small` | Used when the provider is `openai` |
| `EMBEDDING_MAX_INPUT_TOKENS` | – | What the model reads **usefully** — the window it was trained at, not where its tokenizer truncates. Left empty the server discovers it from the loaded model and warns after startup if `CHUNK_MAX_TOKENS` does not fit; set, it overrules that and a contradicting `CHUNK_MAX_TOKENS` refuses to start |
| `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_PASSAGE_PREFIX` | – | The instruction prefixes the model was trained with, put on by the server and never by you. Empty means the model decides: `query: ` / `passage: ` for `multilingual-e5-*`, nothing for anything else. The trailing space matters and `.env` strips an unquoted one, so write `EMBEDDING_QUERY_PREFIX="query: "`. An empty value reads as *unset*, so `none` is how you say *no prefix* on a model that has them. Either value is part of the model id, so changing one re-indexes every project |
| `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `96` / `24` | Counted with the model's own tokenizer. `96` is what measured best on the golden set, not what fits the model's 512-token window — filling the window measures *worse*. Raise both on OpenAI (8191). Changing either re-chunks every project on its next index run |
| `HNSW_EF_SEARCH` | `100` | How many candidates the vector index produces **before** the generation filter is applied — pgvector's own default is 40. Every project has its own partial index, so the candidates are the project's rows; while a project re-indexes, its next generation sits in the same index and is filtered out after it. Costs latency on every search |
| `HNSW_ITERATIVE_SCAN` | `relaxed_order` | `relaxed_order`, `strict_order` or `off`. Keeps scanning when the filter leaves fewer hits than asked for, instead of answering short (pgvector 0.8+; on an older one all three settings are ignored and search behaves as it did). `relaxed_order` returns the rows unordered and the server sorts them itself |
| `HNSW_MAX_SCAN_TUPLES` | `20000` | The ceiling that actually **ends** an iterative scan, counted in tuples of the **project's own** index. Raise it as a project grows, not as the instance does |
| `SEARCH_MAX_PER_DOCUMENT` | `2` | Excerpts one document may contribute to one answer, applied after ranking and refilled from the excerpts below it, so an agent that asked for five still gets five. Measured on the golden set it *gains* a question — what it drops is a near-duplicate of something already on the page. `20` turns it off |
| `SEARCH_NEIGHBOR_CONTEXT` | `1` | Chunks either side of each hit, shown as context around it rather than as further results. `0` turns it off. A chunk is `CHUNK_MAX_TOKENS`, so one either side is about three times the context a hit used to be |
| `SEARCH_MAX_RESULT_CHARS` | `12000` | Ceiling on one rendered `search_docs` answer; past it whole excerpts are dropped and the result says how many. A default answer is around 3 300 characters |
| `SYNC_DEFAULT_INTERVAL_MINUTES` | `60` | The sync interval a **newly created** source is given, in minutes; `0` creates them unscheduled. It never reaches a source that already exists — not on upgrade, and not when this value changes — so an upgrade starts no outbound traffic nobody asked for. Per source the dashboard and the API accept 5 to 43200 (30 days), or *never* |
| `SYNC_PROBES_PER_TICK` | `10` | How many due sources one tick — one minute — may check. The rest keep their turn, oldest first, and the next tick takes them |
| `SEARCH_SCORE_FLOOR` | `0.82` | Similarity below which `search_docs` answers *no good match* rather than its best hit. `0` turns it off. **Measured against the default embedding model and meaningless on another one** — the server warns at startup if they disagree. A question naming an identifier that the keyword half actually matched skips the gate, because an exact string match is correct at any similarity. A project can override it from the query-log panel; `0` here turns every project's floor off too |
| `ADMIN_TOKEN` | – | **Machine access** to `/api/*` via `Authorization: Bearer …`, acting with root permissions. Browsers sign in with an account instead; treat this token like a root password |
| `AUTH_SESSION_IDLE_MS` | `43200000` (12 h) | A dashboard session unused for this long has to sign in again. Refreshed while the dashboard is in use |
| `AUTH_SESSION_TTL_DAYS` | `30` | Hard ceiling on a session's life, however actively it is used |
| `AUTH_COOKIE_SECURE` | `auto` | `auto` sets `Secure` when the request arrives over HTTPS — which behind a proxy is only read when `TRUST_PROXY` says so. Force with `1`; use `0` for a plain-HTTP LAN install, or the browser drops the cookie |
| `AUTH_LOGIN_MAX_ATTEMPTS` | `10` | Failed sign-ins per account and per IP before a lockout / `429` |
| `AUTH_LOGIN_WINDOW_MIN` | `15` | The IP window, and the first lockout step (it doubles, capped at an hour) |
| `PASSWORD_MIN_LENGTH` | `12` | Applies to every password, temporary ones included. No composition rules |
| `SETUP_CODE` | – | The code `/setup` asks for once. Set it and you never have to read it out of the log; leave it empty and the server generates one and prints it at every start until the first account exists. Ignored from then on. Case, dashes and punctuation are ignored when it is checked, so give it enough letters and digits |
| `OIDC_ISSUER_URL` | – | **On/off switch for federated sign-in.** Set to the provider's issuer URL and `/login` grows a second, SSO button; left empty, no discovery request is ever made and the button never renders, but the SSO routes stay registered (`/api/auth/oidc/login` answers `404`, the callback redirects to `/login?oidc_error=not_configured`). Discovery is fetched once and cached |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | – | Issued by the provider. `OIDC_CLIENT_SECRET` is a process secret like `ADMIN_TOKEN` — read from the environment, never written to the database, so no backup or dump ever carries it |
| `OIDC_REDIRECT_URI` | – | The callback URL registered with the provider, e.g. `https://docs.example.com/api/auth/oidc/callback` |
| `OIDC_SCOPES` | `openid profile email` | Space-separated scopes requested at the provider |
| `OIDC_BUTTON_LABEL` | `Single sign-on` | Text on the `/login` SSO button |
| `OIDC_AUTO_PROVISION` | `0` | `1` lets a first successful provider sign-in create an account here on its own. Off by default: an unmapped provider identity is refused rather than silently handed an account. A federated identity is always matched by the provider's `sub` claim, never by an e-mail claim |
| `OIDC_DEFAULT_ROLE` | `member` | Role a provisioned account gets. `admin` or `member` only — never `root`, which stays a local, provider-independent sign-in |
| `ALLOWED_ORIGINS` | – | Extra browser origins allowed on `/mcp/*` (non-browser clients are always allowed) |
| `PUBLIC_BASE_URL` | – | e.g. `https://docs.example.com` for the URLs shown in the dashboard |
| `TRUST_PROXY` | `0` | **Which peers may tell this server where a request came from.** It decides `req.ip` — the key of the per-IP sign-in limit, of `/oauth/register`'s per-host budget and of the address beside an audit event — and `req.protocol`, which three places build published URLs from when `PUBLIC_BASE_URL` is unset. `0` reads the socket's own peer address and ignores `X-Forwarded-*`, which is right for the shipped `docker compose` shape: nothing is in front of it, so a caller writing those headers would otherwise choose its own rate-limit key. **Put a reverse proxy in front and you must set this** — see *Running behind a reverse proxy* below for what breaks if you do not, including MCP connectors being answered `invalid_target`. Name the **proxy**: an IP, a CIDR block, or the subnet names `loopback` / `linklocal` / `uniquelocal`, comma-separated (`TRUST_PROXY=loopback`, `TRUST_PROXY=172.18.0.0/16`). The range is matched against **every hop**, not just the peer, so a range your clients are also inside (`uniquelocal` on a LAN) protects nothing. `1` trusts whoever wrote the header and is only safe when nothing but the proxy can open a socket to this port. A hop count is **not** accepted — it is a claim the server cannot check and goes silently wrong the day a CDN appears in front of the proxy |
| `SESSION_IDLE_TTL_MS` | `1800000` | Idle Streamable HTTP sessions are closed after 30 min |
| `MCP_STRUCTURED_OUTPUT` | `0` | `1` makes the MCP tools publish an `outputSchema` and return `structuredContent` beside the unchanged text. Off by default because Claude Code reads the structured content instead of the text when both are there — see [Tools exposed to the agent](#tools-exposed-to-the-agent). The `contextator://` resources do not depend on it |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | How long an audit event is kept. There is no switch for the log itself: every state-changing admin request that succeeds is recorded with the account that made it, written by the policy layer rather than by each route. The rows carry no question, no document and no excerpt — that is the query log, which is a separate table under a separate window |
| `METRICS_TOKEN` | – | A bearer credential that reaches `GET /metrics` and **nothing else**, so scraping does not mean handing Prometheus an `ADMIN_TOKEN`. At least 16 characters, and generate it as you would any other secret — the length is a floor, not entropy, and this endpoint is not rate-limited. Unset, `/metrics` still answers a signed-in account or `ADMIN_TOKEN` — but only while the database is up, so an instance that wants to be readable during an outage sets this |
| `METRICS_PUBLIC` | `0` | `1` answers `/metrics` with no credential at all. For a private network or a proxy that already guards the path; anywhere the port is reachable, leave it off — the exposition describes the instance |
| `RESET_VECTORS` | `0` | See *Changing the embedding model* |

### Running behind a reverse proxy

Nothing is in front of this by default — `docker compose` publishes 3444 on the loopback interface,
with nothing between it and the port — and the defaults are written for that. Publishing it anywhere
else (`CONTEXTATOR_BIND=0.0.0.0`) is the moment to put something in front. Put nginx, Caddy, Traefik or a cloud load balancer in front and **two settings
have to move together**:

```bash
TRUST_PROXY=172.18.0.0/16        # the proxy's address or CIDR, or `loopback` if it is on the host
PUBLIC_BASE_URL=https://docs.example.com
AUTH_COOKIE_SECURE=1
```

`TRUST_PROXY` is what lets this server read `X-Forwarded-For` and `X-Forwarded-Proto` from that proxy.
Left at `0` behind one, three things break and none of them says so on its own:

- **The per-IP sign-in limit becomes instance-wide.** Every request carries the proxy's address, so
  `AUTH_LOGIN_MAX_ATTEMPTS` failures from one person answer `429` to everybody.
- **MCP connectors stop being able to authorize.** With `PUBLIC_BASE_URL` unset, the OAuth
  protected-resource metadata and the `WWW-Authenticate` pointer are built from `req.protocol` — which
  reads `http` — so the document advertises `http://…` while the client sends `https://…`, and
  `/oauth/authorize` answers `invalid_target` every time. Setting `PUBLIC_BASE_URL` fixes this half on
  its own, which is why it is in the block above.
- **The session cookie loses its `Secure` flag**, because `AUTH_COOKIE_SECURE=auto` follows the same
  forwarded scheme. `AUTH_COOKIE_SECURE=1` fixes this half on its own.

The server watches for the mistake rather than guessing at it: the first request that arrives carrying
an `X-Forwarded-*` header this instance is not trusting logs one warning naming all three.

**Name the proxy, not the network your clients are on.** The list is matched against *every* hop, not
only against the peer — the server walks the chain from the socket outwards and `req.ip` is the first
address the list does **not** cover. So `TRUST_PROXY=uniquelocal` on a LAN where the clients are also
on `10.0.0.0/8` or `192.168.0.0/16` protects nothing: a client is walked past exactly as a proxy is,
and `X-Forwarded-For: 203.0.113.99` puts that value into `req.ip` again. `TRUST_PROXY=1` is the same
hazard stated plainly and is only safe when nothing but the proxy can reach the port at all.

Make sure the proxy **replaces** `X-Forwarded-For` rather than appending to whatever the client sent
(nginx: `proxy_set_header X-Forwarded-For $remote_addr;`, not `$proxy_add_x_forwarded_for`, unless
there is a further trusted proxy in front of it). A proxy that appends hands the caller the left-most
value, and no setting here can tell the difference.

### Changing the embedding model

- **Same dimension** (e.g. between the local 384-d models): change `EMBEDDING_MODEL`, restart, and re-index.
  The server notices the model id stored on each project differs and performs a full re-index automatically;
  `search_docs` refuses to search a project indexed with another model until then. **Nothing starts that run
  by itself** — the project page shows the mismatch with a `Re-index now` button, and search stays refused
  until it is pressed. The run itself is safe to start at any time of day: it is written beside the old
  index and published in one step at the end, so the project goes from "indexed with another model"
  straight to "indexed with this one" without passing through "no indexed content". While it runs, that
  project holds two copies of its chunks and its share of the vector index, so plan disk for the peak.
- **Upgrading across the default change.** `Xenova/multilingual-e5-small` became the default after
  `Xenova/paraphrase-multilingual-MiniLM-L12-v2`. An installation that never set `EMBEDDING_MODEL` picks the
  new one up on upgrade and every existing project reads as a mismatch until it is re-indexed. Pin the old
  value in `.env` to postpone that. Going *back* is not a matter of reverting the setting alone: a project
  already re-indexed under the new model needs another re-index to return.
- **Changing a prefix counts as changing the model.** `EMBEDDING_QUERY_PREFIX` and
  `EMBEDDING_PASSAGE_PREFIX` are part of the id stamped on each project, because a corpus indexed without
  them and searched with them is a mismatch nothing else would catch. Setting either — including setting
  both to `none` — makes every project re-index on its next run, exactly as a model change does.
- **Different dimension** (e.g. OpenAI `text-embedding-3-small` = 1536): set `EMBEDDING_PROVIDER=openai`,
  `OPENAI_API_KEY`, `EMBEDDING_DIMENSIONS=1536`, then start **once** with `RESET_VECTORS=1`. The vector
  column is re-typed and every chunk is dropped; re-index each project afterwards. Without the flag the
  server refuses to start and prints exactly this instruction.

## Admin API

All endpoints return JSON. Every request is authenticated by the session cookie the dashboard receives at sign-in, by
`Authorization: Bearer <ADMIN_TOKEN>` (machine access, root permissions), or by `Authorization: Bearer <ctxk_…>` — an
account's own API token, scoped to a subset of routes and, optionally, one project (below, under **Accounts**).
`GET /api/health` is exempt, and answers with less detail when nobody is signed in.

A cookie-authenticated request that changes something must come from this site: the server checks `Sec-Fetch-Site`
(falling back to `Origin`/`Referer`) and answers `403 csrf_blocked` otherwise. Bearer requests are exempt — they carry
no ambient credential.

| Method & path | Description |
|---------------|-------------|
| `GET /api/health` | DB status, embedding provider/model/dtype/readiness and its input window, whether `CHUNK_MAX_TOKENS` fits that window, open MCP sessions, version. `503` with the same body while the database is unreachable, `200` otherwise |
| `GET /api/projects` | Projects with counts, `mcpUrl` and the live indexing `job` (phase, files done/total/skipped/removed, chunks; for queued jobs `queue.aheadProjectName`) |
| `POST /api/projects` `{ name, rootPath, index?: true }` | Create a project; `400` invalid name/path, `409` duplicate |
| `POST /api/projects/:id/reindex?force=true` | Queue (incremental or full) re-index → `202 { job }` |
| `GET /api/projects/:id/status` | Project row + live job |
| `GET /api/projects/:id/runs` | The project's last 20 index runs (mode, counts, duration, error), newest first |
| `GET /api/projects/:id/search?q=…&limit=…&source=…&path_prefix=…&version=…` | The same search the project's `search_docs` tool runs, as JSON: `{ query, limit, source, pathPrefix, version, belowFloor, scoreFloor, hits: [{ score, fusedScore, denseRank, lexicalRank, path, title, headingPath, chunkIndex, content, contextBefore, contextAfter }] }`. `score` is the cosine similarity and is shown rather than ranked on; `fusedScore` is what ordered the list, and the two ranks say which half of search found the excerpt (`null` for the half that did not). `belowFloor` is whether an agent would have been told *no good match* — the hits come back either way, so the dashboard can show what was withheld. `limit` is 1–20 (default 5); `source`, `path_prefix` and `version` are optional. `400 invalid_request` for a source or a version this project does not have (the message names the ones it does), `409 not_indexed` when the project has no chunks, `409 model_mismatch` when they were embedded with another model |
| `DELETE /api/projects/:id` | Delete project, its chunks and open MCP sessions (`409` while indexing) |
| `GET /api/projects/:id/sources` | The project's sources (type, name, config, status, document count). Secrets are never returned — only `hasSecret` |
| `POST /api/projects/:id/sources` `{ type, name, label?, flavor?, config?, secret?, syncIntervalMinutes?, index? }` | Add a source. `type` is `local`, `git`, `upload` or `notion`; `config` is type-specific (`path` / `url`+`branch`+`subdir` / `rootIds`). `secret` is taken only by the types that use a credential — `git`, `notion`, `confluence`; on `local`, `upload` or `web` it answers `400 invalid_request` naming the type. `secret: null` means "no secret" and is accepted on every type. `syncIntervalMinutes` is 5–43200 or `null`; omitted takes the instance default |
| `PATCH /api/projects/:id/sources/:sid` | Change label, content type, config, token (`secret: null` removes it) or `syncIntervalMinutes` (`null` switches the schedule off). Type and name are immutable. A `secret` on a `local`, `upload` or `web` source is `400 invalid_request`, as on create; one an older release already stored stays until `secret: null` removes it |
| `DELETE /api/projects/:id/sources/:sid` | Remove the source, its documents, chunks and materialised directory (`409` while indexing) |
| `POST /api/projects/:id/sources/:sid/sync` | Queue a re-index (every source is synced at the start of it) → `202 { job }` |
| `POST /api/projects/:id/sources/:sid/test` | Connectivity check without indexing → `{ ok, message }` |
| `POST /api/projects/:id/sources/:sid/webhook-secret` | Generate a new webhook secret: git, or Confluence (turns its webhook on, or regenerates it) |
| `DELETE /api/projects/:id/sources/:sid/webhook-secret` | Confluence: turn the webhook off; deliveries are refused with `not_enabled` again |
| `POST /api/projects/:id/sources/:sid/uploads` | Open an upload session → `{ session }` (upload sources only) |
| `POST …/uploads/:session/files` | `multipart/form-data`; each part's `filename` carries the path inside the source. Archives are unpacked server-side → `{ files, skipped, bytes, errors }` |
| `POST …/uploads/:session/commit?mode=add\|replace` | Move the staged tree into the source and queue an index run → `202 { files, job }` |
| `DELETE …/uploads/:session` | Discard a staged upload |
| `GET /api/projects/:id/sources/:sid/files` | Files currently materialised for an upload source |
| `DELETE /api/projects/:id/sources/:sid/files?path=…` | Delete one of them and re-index |
| `POST /api/webhooks/git/:sourceId` | Push webhook. Authenticated by the per-source secret, **not** `ADMIN_TOKEN` |
| `POST /api/webhooks/confluence/:sourceId` | Confluence Data Center webhook, signed with `X-Hub-Signature` over the per-source secret; `not_enabled` until the webhook is turned on |
| `GET /api/projects/:id/mcp-tokens` | This project's live MCP tokens: name, prefix, when they were created and last used. Never the token itself |
| `POST /api/projects/:id/mcp-tokens` `{ name? }` | Mint one → `201 { token, secret }`; `secret` is returned **once** |
| `DELETE /api/projects/:id/mcp-tokens/:tokenId` | Revoke it and close the project's open MCP sessions |
| `PATCH /api/projects/:id/mcp-auth` `{ mode }` | `open` or `token` (root/admin) |
| `GET /metrics` | Prometheus text (`text/plain; version=0.0.4`): the indexing queue by lane, whether one is running, the last index run and whether it worked, searches by actor, the database pool and whether the database answers. **Not public** — a signed-in account, `ADMIN_TOKEN`, a `METRICS_TOKEN` bearer, or nothing at all when `METRICS_PUBLIC=1`. `200` even while the database is down, with `contextator_db_up 0` and the rows that need one left out, so a scrape gap is never the way an outage is reported. **While the database is down only the three credentials that need no database answer** — `ADMIN_TOKEN`, `METRICS_TOKEN`, `METRICS_PUBLIC` — because a session cookie is a row and cannot be confirmed; a browser presenting one then gets `401` rather than `500`. That is the reason to configure `METRICS_TOKEN` before you need it |

### Accounts

| Method & path | Description |
|---------------|-------------|
| `GET /api/setup/status` | `{ needsSetup }` — true while no account exists. Public |
| `POST /api/setup` `{ code, username, displayName?, email?, password }` | Creates the first `root` account and signs it in. `403` on a wrong code, `409` once an account exists. Public |
| `POST /api/auth/login` `{ username, password }` | Sets the session cookie. `401 invalid_credentials` for both a wrong password and an unknown username, `403 account_disabled`, `429` with `Retry-After` when rate-limited |
| `POST /api/auth/logout` | Destroys the session and clears the cookie. Idempotent |
| `GET /api/auth/me` | The signed-in account, its role and — for a member — its per-project roles |
| `POST /api/auth/password` `{ currentPassword, newPassword }` | Change own password; clears `mustChangePassword` and revokes this account's **other** sessions |
| `GET /api/auth/sessions` · `DELETE /api/auth/sessions?scope=others\|all` | List or end your own sessions |
| `GET /api/users` | Every account with role, status, project count, last sign-in and active session count (root/admin) |
| `POST /api/users` `{ username, displayName?, email?, role?, password?, mustChangePassword? }` | Create an account → `201 { user, temporaryPassword }`; the password is generated when omitted and returned **once** |
| `GET /api/users/:id` · `PATCH /api/users/:id` | Read, or change display name, e-mail, role and active flag |
| `POST /api/users/:id/password` `{ password? }` | Set a new temporary password → `{ temporaryPassword }`, forces a change at next sign-in and ends that account's sessions |
| `DELETE /api/users/:id` | Delete the account, its sessions and its memberships |
| `DELETE /api/users/:id/sessions` | Sign that account out everywhere |
| `GET /api/tokens` | Your own API tokens: name, prefix, scope, restricted project (if any), status, expiry, last used. Never the secret |
| `POST /api/tokens` `{ name?, scope, projectId?, expiresAt? }` | Mint one → `201 { token, secret }`; `secret` is returned **once**. Scope entries and `projectId` outside your own reach mint fine but never match anything, since every request re-checks your live role and project access |
| `DELETE /api/tokens/:tokenId` | Revoke one of your own tokens. Takes effect on its very next use |
| `GET /api/projects/:id/members` | Accounts with access to this project and their role (any member of it) |
| `PUT /api/projects/:id/members/:userId` `{ role }` | Grant or change `viewer` / `editor` (root/admin) |
| `DELETE /api/projects/:id/members/:userId` | Revoke access (root/admin) |
| `GET /api/audit?actor&actorUser&action&project&from&to&limit&cursor` | The audit log, newest first (root/admin). Every filter is applied in SQL: `actor` is the label as it was at the time, `actorUser` is an account id matched **exactly** against the acting account — the events of that account's sessions **and** of every API token it owns, whatever the tokens are named; a value that is not a UUID answers `400 validation_failed`. `action` is `<METHOD> <route template>`, `project` is a project id or `none`; `from`/`to` are **UTC days** and `to` is inclusive of the day named. `limit` is 1–200 (default 50). `cursor` is the previous page's `nextCursor` — **a row id**, never an encoded instant, so two events inside one millisecond cannot lose one of themselves at a page boundary; a cursor naming no row answers `400` rather than an empty page. Answers `{ events, nextCursor, filters, retentionDays }`; `nextCursor` is `null` on the last page, and `filters` carries the distinct actors, actions and projects, and the accounts (`{ id, username }`) that have events, for the pickers, and comes back with the first page only |

A project a member has no access to answers `404`, not `403`, so project ids cannot be probed. `409` guards the last
root account; `403` guards an admin reaching for a root one.

### The audit log

Every one of the state-changing requests above leaves a row in `audit_events` naming the account that made it —
what was done, to which project, to which source, token, membership or account, and when. **A sign-in and the
creation of the first account are recorded too**, and so is `POST /oauth/authorize`, which is a person granting a
connector lasting read access to one project. It is written by the policy layer rather than by each handler, so
there is no route that can be added without being covered and none that can opt out; the exceptions are **seven**
and each is listed with its reason in `src/auth/policy.ts`.

A route that *creates* something names nothing in its path, so the new object's id is read back out of the
response — through a table of fixed paths in that same file, and kept only when the value found there is a UUID.
"Who minted this token" is therefore a question the log answers, and it lines up against the revocation that names
the same id.

The rows carry no user content. A question, a document and an excerpt never reach a column of this table: the only
body fields any action may record are named in that same file, each restricted to a closed set of values (`mode` is
one of `open`/`token`/`account`, and so on). That is what keeps it a different record from the query log, which
holds what agents asked and is governed by [its own retention](#configuration) and its own per-project switch. The
two are deliberately not one table.

Two things it does not hold. **Refused requests** — a refusal is the permission matrix working, and recording every
probe would turn the table into a scan log; the one exception is a person refusing a connector at
`/oauth/authorize`, which is somebody deciding rather than the matrix declining. And **an action that changed
something and then answered `5xx`**: the row is written only for a response under 400, so a handler that commits
and then fails afterwards leaves none. No handler in this API is currently shaped that way, and `SECURITY.md` names
it as the limit it is.

`GET /api/audit` reads it, and the dashboard's **Audit log** — in the account menu, beside Users — is the panel over
that. Both are root/admin only: the log is instance-wide, and a project membership is not standing to read who was
given the root role. Each row is rendered as a sentence ("dana deleted a source from handbook") rather than as the
columns it is stored in, and every filter — who, what, which project, and a range of UTC days — is applied in SQL,
one keyset page at a time. "Who" is two pickers: **Actor** is the label as it was recorded, and **Account** is the
account id, which finds that account's own actions together with those of every API token it owns — a token's label
is its name and owner, so the label alone cannot gather them. A project that has since been deleted still has its rows: `project_id` carries no foreign
key, so what the panel cannot do is look its *name* up, and it says so on the row rather than leaving it blank.

The two columns the panel filters on — `actor_label`, because it outlives the account, and `action` — are indexed by
migration `0011`. At 200,004 rows a selective actor filter is 0.07 ms against 9.7 ms without it, a page turn is 3 ms,
and a first page is 19–52 ms because it also fills the filter dropdowns with three `DISTINCT` scans no index can help.
Those are paid once per filter change and never per page turn.

The panel is deliberately not reassuring about two things, because neither is true: the log is **not tamper-evident**
— anyone with database access can remove a row and nothing here would show it ([SECURITY.md](SECURITY.md)) — and rows
older than `AUDIT_LOG_RETENTION_DAYS` are swept on the same quarter-hourly timer as expired sessions.

## Local development (without Docker for the app)

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL + pgvector only, on localhost:5432
cp .env.example .env
# DATABASE_URL=postgres://contextator:contextator@localhost:5432/contextator   (ships empty; the
#   container reads the same line, so a value here would point an installation at your laptop)
# ALLOWED_DOC_ROOTS=C:/Users/me/docs     (Windows)  or  /home/me/docs
# DATA_DIR=.data                         (git checkouts, uploads and Notion pulls; gitignored)
# SECRET_KEY=$(openssl rand -hex 32)     (only needed for private repositories / Notion)
npm install
npm run dev                              # tsx watch, http://localhost:3444
npm test                                 # vitest: the unit suite — no database, no Docker
npm run test:integration                 # the same runner against a real PostgreSQL + pgvector
npm run test:all                         # both suites
npm run typecheck                        # the build's tsconfig, then the one that covers test/
npm run lint                             # biome: format + lint over src, test, scripts and public
npm run lint:fix                         # the same, writing every fix it can make
npm run smoke -- http://localhost:3444/mcp/demo "kurulum" --sse   # exercise the legacy transport too
```

`npm run db:studio` opens Drizzle Studio against `DATABASE_URL`.

`npm test`, `npm run typecheck` and `npm run lint` are exactly what CI's `check` job runs on every pull
request, alongside a build of the Docker image, so running them before you push is most of staying green.

`npm run test:integration` is CI's other job and the one command here that needs a container runtime. It
starts `pgvector/pgvector:pg16` itself through testcontainers, gives every test file its own database and
throws the container away afterwards — the compose file above is not involved and nothing has to be
started by hand. Docker Desktop and a stock Linux install need no configuration; a socket somewhere else
(Colima, Rancher Desktop, rootless Podman) needs `DOCKER_HOST` and a `TESTCONTAINERS_*` setting or two.
The first run pulls a 460 MB image and is a minute or two slower than every run after it.

Tell `git blame` to skip the one commit that reformatted the tree:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Project layout

```
src/server.ts                 Fastify entrypoint / composition root
src/config.ts                 zod-validated environment
src/db/schema.ts              Drizzle schema — the source `drizzle/*.sql` is generated from, and the only description of the tables
src/db/bootstrap.ts           startup: the extension, the migration journal, `migrate()`, the vector dimension, and reconciling the per-project HNSW indexes
src/db/vector-indexes.ts      one partial HNSW index per project: its name, its concurrent build and drop, the queue that serialises them, and the bootstrap's reconcile
src/services/chunker.ts       Markdown/MDX-aware chunking with heading breadcrumbs; pure and synchronous, the token counter injected
src/services/fs-scan.ts       safe directory walking + path-escape checks
src/services/sources.ts       source CRUD and the zod schema of each type's config
src/services/sources/         one driver per type: local, git (isomorphic-git), upload, notion, confluence
src/services/sources/confluence.ts        the Confluence driver, Cloud and Data Center: the page tree, the incremental skip, and the probe
src/services/sources/confluence-client.ts the REST surface it talks to, as an interface plus an HTTPS implementation, and the one place CQL is built
src/services/sources/confluence-egress.ts where a Confluence request may connect: the address check after DNS and on every redirect, CONFLUENCE_ALLOWED_HOSTS
src/services/sources/confluence-render.ts storage format → the plain XHTML `doc-types/html.ts` converts; it does not convert HTML itself
src/services/sources/web.ts               the documentation-site driver: the three entry formats, the five ceilings, and the sitemap probe
src/services/sources/web-client.ts        its one HTTP surface — serial, paced, inside a deadline — as an interface plus an implementation
src/services/sources/web-entry.ts         sitemap, llms.txt, robots.txt, links and URL→path, as pure functions over strings
src/services/flavors.ts       content-type transforms (Obsidian wikilinks, Notion export ids) and which of them expand one file into many
src/services/openapi.ts       OpenAPI/Swagger → one Markdown document per operation: $ref resolution, cycle and depth guards, derived paths
src/services/doc-types/       one transform per file extension, all of them producing Markdown: html, docx, csv, pdf
src/services/doc-types/pdf.ts a PDF read as a layout — lines, columns, running heads, headings by size, tables by alignment
src/services/conversion/      the thread all of that runs on: `worker.ts` (the same transforms, over there), `client.ts` (a thread that dies, one that stops answering, a refusal that has to arrive as a refusal), `protocol.ts` (the wire)
scripts/build-doc-fixtures.ts the dependency-free PDF and zip writers the binary test fixtures come from
src/types/                    ambient declarations for the two dependencies that ship none (mammoth, the turndown GFM plugin)
src/services/archives.ts      zip / tar / tar.gz / rar extraction with path and size guards
src/services/uploads.ts       staged upload sessions and their commit into a source
src/services/data-dir.ts      layout of DATA_DIR, atomic directory swaps, orphan sweep
src/services/crypto.ts        AES-256-GCM encryption of source tokens and webhook secrets, and the key id that makes SECRET_KEY rotatable
src/services/encrypted-fields.ts  the one list of columns encrypted under SECRET_KEY, derived from the schema so a new one cannot be forgotten
src/services/embeddings/      provider interface, local (transformers.js) and OpenAI implementations
src/services/chunk-budget.ts  the after-warmup half of the chunk budget check: what the model reads, against what the chunker produces
src/services/indexer.ts       incremental background indexing queue
src/services/vector-store.ts  the fused search statement (vector + keyword) and chunk persistence
src/services/rrf.ts           reciprocal rank fusion: the arithmetic that turns two rankings into one
src/services/text-search.ts   which PostgreSQL text search configuration the keyword half speaks
src/services/search.ts        the one search path: the guards, the query embedding and the top-k query, shared by the MCP tool and the search API
src/mcp/router.ts             /mcp/:project — Streamable HTTP + legacy SSE on one URL
src/mcp/tools.ts              search_docs, list_topics, read_document
src/services/document-read.ts  joining chunks back into a section, and cutting text to a token budget
src/mcp/sessions.ts           per-connection McpServer/transport registry + idle reaper
src/auth/policy.ts            every authorization rule as data — no DB, no Fastify, fully unit-tested; also which requests are audit events and what they may record
src/auth/authorize.ts         the request checks that need no database, in the order they must happen
src/auth/plugin.ts            resolves the principal (cookie, ADMIN_TOKEN or an account's own API token) and applies the policy
src/services/auth/api-tokens.ts  mint/list/verify/revoke for an account's own scoped API tokens (ctxk_…)
src/auth/cookies.ts           the session cookie's name, flags and Secure decision
src/auth/csrf.ts              same-site check for cookie-authenticated writes
src/services/passwords.ts     scrypt hashing (node:crypto), policy and temporary passwords
src/services/auth/            accounts, sessions, memberships and the first-run setup gate
src/services/rate-limit.ts    in-memory sliding window for sign-in attempts
src/services/audit.ts         the audit log: the row an action becomes, the writer the policy layer holds, and the retention sweep
src/services/metrics.ts       the process counters and the Prometheus text /metrics answers with
src/admin/routes.ts           REST API for the dashboard
src/services/scheduler.ts     the sync schedule: which sources are due, the cheap per-driver check, and the run it queues
src/admin/sources-routes.ts   source CRUD, sync, test, webhook secret
src/admin/upload-routes.ts    multipart upload sessions (the only multipart-parsing plugin)
src/admin/webhooks.ts         push webhooks, verified with the per-source secret — git's generated here, Notion's captured from them
src/services/notion-webhook.ts which Notion deliveries mean a run, the window a captured token may be stored in, and the debounce before the queue
src/admin/auth-routes.ts      /api/auth/* and /api/setup/*
src/admin/users-routes.ts     /api/users/*
src/admin/tokens-routes.ts    /api/tokens/* — an account's own API tokens, self-service
src/admin/audit-routes.ts     /api/audit — the read side of the audit log: the filters, the keyset page, and the sentence a row is rendered as
src/admin/members-routes.ts   /api/projects/:id/members/*
src/admin/mcp-routes.ts       /api/projects/:id/mcp-tokens/* and the open/token/account switch
src/mcp/access.ts             the MCP endpoint's access rule, as a pure function
src/mcp/identity.ts           turns the Authorization header into an account and its membership, for that rule to judge
src/mcp/oauth-routes.ts       the OAuth 2.1 flow for /mcp/*: discovery, registration, the approval page, the token endpoint
src/services/auth/oauth.ts    registered OAuth clients, the authorization codes, and the PKCE check
src/admin/pages.ts            /about, /privacy, /cookies, /terms, /license rendered into one shell
src/admin/auth-pages.ts       /login, /setup, /change-password and the guard on `/`
public/                       vanilla HTML/JS dashboard (no build step)
public/core.js                shared helpers: el(), api(), state, the event bus
public/auth.js                the signed-in account, the top-bar menu, permission helpers
public/users.js               the account list at #/~users
public/tokens.js              your own API tokens at #/~tokens — create, list, revoke
public/audit.js               the audit log at #/~audit — who changed this instance, filtered and paged by the server
public/queries.js             a project's query-log panel: what agents asked, the export beside it, and the project's own relevance floor with its preview
public/members.js             a project's Members panel
public/mcp.js                 a project's MCP access panel and its tokens
public/search.js              a project's search box and the hits it renders, scores and all
public/auth-page.js           /login, /setup and /change-password — imports nothing from the dashboard
public/product-facts.json     generated: the numbers and identifiers this product can be quoted on, for the site in the other repository to check its prose against
public/pages/                 body of each product/legal page + the shell they share, and the OAuth approval page
scripts/smoke-mcp.ts          end-to-end MCP client check
scripts/reset-password.ts     last-resort password reset straight against the database; ships in the image and runs there
scripts/rotate-secret.ts      `npm run rotate-secret` — moves every encrypted value onto the current SECRET_KEY; re-runnable, interruptible, and silent about plaintext
scripts/backup.ts             `npm run backup` — the database, the upload trees and a manifest in one archive; never SECRET_KEY, only its fingerprint
scripts/restore.ts            `npm run restore` — the same archive back, with every refusal decided before a byte is unpacked (`--check` decides them and writes nothing)
scripts/backup-archive.ts     the archive's format and every refusal in it: the manifest, the key check value, the topology, and where pg_dump/pg_restore run
scripts/embedded-database.ts  how an operator command run through `docker exec` finds the container's own PostgreSQL — the entrypoint's PG* variables are not in that environment
scripts/build-product-facts.ts `npm run build:facts` — writes public/product-facts.json by reading the declarations, never by restating them
scripts/eval.ts               `npm run eval` — indexes eval/corpus, asks eval/golden.jsonl, prints recall@1, recall@5, MRR
scripts/eval-scoring.ts       the scoring arithmetic and the report, with no database or model in it, so it can be unit-tested
scripts/cla/rules.ts          the licence gate's judgements — who authored a pull request, who may sign, what the record says — with no I/O in them
scripts/cla/github.ts         the two GitHub surfaces it is handed: this repository, and the signatures repository behind its own narrow token
scripts/cla/run.ts            the gate wired up: read the event, record a signature, judge, ask once, re-run the pull request's check
scripts/cla/main.ts           what the workflow runs — the environment, the two tokens and the exit code, and no decision at all
test/*.test.ts                unit suite — pure functions, no database, no Docker (`npm test`)
test/cla-*.test.ts            the licence gate: its judgements, the whole flow against fakes, and the GitHub clients against an injected fetch
test/dockerhub-description.test.ts  DOCKERHUB.md fits Docker Hub's limit, its links are absolute, and it names the image
test/container-topology.test.ts     the packaging contract: `full` is still the default target, `slim` still carries no database, and neither compose file has gone back to forcing DATABASE_URL empty
test/backup-manifest.test.ts        the backup's refusals, each in both directions: the key check value, the server's major version, the topology, the manifest reader
test/product-facts.test.ts    public/product-facts.json is still what the generator produces from today's code
test/integration/*.itest.ts   the bootstrap, the schema equivalence review, vector-store, the password reset and /api/health against a real PostgreSQL + pgvector
test/integration/support/     the testcontainers harness, and the schema projection two schemas are compared with
test/integration/fixtures/    a pre-v3 `0.1` schema derived from history, and the frozen DDL ladder the migrations replaced
test/fixtures/doc-types/      one real file per supported type, plus the malformed ones a refusal has to survive
test/support/confluence-stub.ts a `ConfluenceClient` answering out of an array, shared by the unit and the integration suite so one page tree drives both
test/support/web-stub.ts      a `WebClient` answering out of a map of URL → response, recording every request so a ceiling can be asserted by what was *not* fetched
test/fixtures/web/            a sitemap, a sitemap index, an `llms.txt` and a `robots.txt`, each carrying the awkward case the parser has to survive
eval/corpus/                  the fixture corpus the golden set asks about: 15 English and 11 Turkish pages, written for this
eval/golden.jsonl             48 questions, one JSON object per line, each naming the file that answers it
eval/README.md                what a good question is, how to add one, and why the failures are kept
eval/BASELINE.md              the last recorded run of the default configuration
drizzle/                      generated migrations (`npm run db:generate`), applied at startup and shipped in the image
CHANGELOG.md                  what shipped in each release, Keep a Changelog style, for the operator pulling the image — not the commit log
CONTRIBUTING.md               how to run it, the four checks, the pairs kept in sync, and the licence grant
CLA.md                        the contributor licence grant, in force; signed on a pull request
SECURITY.md                   how to report a vulnerability, and what is documented behaviour rather than one
CODE_OF_CONDUCT.md            Contributor Covenant 2.1
LICENSE                       AGPL-3.0-or-later, verbatim; copied into the image and served at /license.txt
docs/demo/                    sample documentation (English, Turkish, MDX)
Dockerfile                    two images over one build: `full` (postgres:16 + pgvector + Node 22 + the app, the default target) and `slim` (the app alone)
docker/entrypoint.sh          starts PostgreSQL unless DATABASE_URL names one, then the app; stops both in order on SIGTERM
docker-compose.yml            the `contextator` container and its volumes; embedded PostgreSQL, or an external one when .env names it
docker-compose.build.yml      overlay for docker-compose.yml that builds the image from source instead of pulling it
docker-compose.slim.yml       the `-slim` image against a PostgreSQL you operate — a whole file rather than an overlay, because the pgdata mount has to be absent
docker-compose.dev.yml        PostgreSQL only, for `npm run dev`
charts/contextator/           Helm chart for Kubernetes: one Pod, the `-slim` image, an external PostgreSQL; `replicas: 1` is hardcoded, not a value; values checked by a strict values.schema.json
DOCKERHUB.md                  what Docker Hub shows on the repository page; not this README, which is well past its 25,000-character limit
biome.jsonc                   the one formatter and linter, and why each rule is set as it is
tsconfig.test.json            typechecks test/ and scripts/, which the build's tsconfig cannot see
.github/workflows/ci.yml      the gate on every pull request: lint, typecheck, tests, image build
.github/workflows/cla.yml     the licence grant: the `Licence grant` required check, and the lock on a merged thread
.github/workflows/release.yml on a `v*` tag: verify the image, then build and push it to Docker Hub for both architectures; then publish a changed Helm chart to the gh-pages repository
.github/workflows/helm-chart.yml lints and renders charts/contextator on every change to it, and asserts the decisions it encodes: one replica, the required values, the strict schema, probes, the data mount, a bumped chart version
.github/workflows/dockerhub-description.yml pushes DOCKERHUB.md to Docker Hub's description whenever it changes
.github/PULL_REQUEST_TEMPLATE.md   the FR/ADR reference, the checks, and the documented claims a change touches
.github/ISSUE_TEMPLATE/       bug report, feature request, and the links the issue chooser offers first
.git-blame-ignore-revs        commits that only reformatted; `git blame` should look through them
```

### How the single container works

`docker/entrypoint.sh` (under `tini`) launches the unchanged upstream `postgres` image entrypoint in the
background, so first-run `initdb`, `POSTGRES_*` handling and `/docker-entrypoint-initdb.d` work exactly
as in the official image. Once `pg_isready` succeeds on `127.0.0.1:5432` it starts `node dist/server.js`
as the unprivileged `node` user with the libpq `PG*` variables pointing at that server. `SIGTERM` stops
the app first and then PostgreSQL (fast shutdown); if either process dies the other is stopped and the
container exits so `restart: unless-stopped` can bring the pair back.

`DATABASE_URL` is what makes that paragraph conditional. Set, the entrypoint skips all of it: no
postmaster is started, the `PG*` variables are deliberately left unset so the URL is the only answer
to *where is the database*, and the container supervises one process instead of two. The startup log
names which of the two it chose — with the credentials cut out of the connection string — and
`/api/health` says the same thing as `database.mode` to a signed-in caller, with the host, port and
database name beside it for an administrator. The `-slim` image is this path with the PostgreSQL
removed from the image as well: it sets `CONTEXTATOR_EMBEDDED_POSTGRES=0`, and started without a
`DATABASE_URL` it exits immediately naming the variable rather than searching for a database that
was never built into it.

### How the schema evolves

There is one way to change the schema and it has four steps: edit `src/db/schema.ts`, run
`npm run db:generate`, read the SQL drizzle-kit wrote into `drizzle/`, and commit both. Nothing else
creates or alters a table, and `npm run db:check` — a step in CI — fails if the schema and the
migrations stop agreeing.

Nothing is asked of the operator. `src/db/bootstrap.ts` runs `migrate()` at startup, under a
session-scoped advisory lock, with `drizzle/*.sql` baked into the image: upgrading is
`docker compose pull && docker compose up -d` and there is still no migration command to forget. An installation that
predates the migrations is adopted on its first start — its schema is already the baseline, so a row
is written to drizzle's journal saying so and nothing is applied.

Two things stay out of the generated SQL because they cannot be in it. The vector column's dimension
is a deployment setting (`vector(384)` vs `vector(1536)`), so `schema.ts` carries a constant 384 for
the migration to bake in and the bootstrap re-types the column to the configured dimension
afterwards, once, before any row exists — drizzle-kit diffs `schema.ts` against its own snapshot and
never against the live database, so a deployment at 1536 cannot be seen by it, let alone broken by it.
The HNSW indexes are the second: one partial index per project, named after the project, which a
generated migration could never describe; each needs a fixed dimension and blocks the re-typing while
it exists, so the bootstrap creates them after. The dimension is still recorded in `settings` and a mismatch still
fails fast with the remedy in the message.

What used to rest on review has a test: `test/integration/schema-equivalence.itest.ts` applies the
frozen DDL ladder to one database and the new bootstrap to another and compares the two schemas as
text, on every pull request, against a real server.

## Security notes

- **The port is published on `127.0.0.1` only.** A default installation is reachable from the machine it runs on and
  from nowhere else; `CONTEXTATOR_BIND=0.0.0.0` publishes it on the network, and is the one place that decision is
  made. The container's own `HOST` stays `0.0.0.0` because that is the interface inside it, which Docker forwards the
  published port to.
- A new MCP endpoint **requires a token**: creating a project mints its first one and shows it once. A project that
  already exists is not touched by an upgrade — one configured **open** stays open, because its clients are
  configured against that answer. The mechanism and who may change it are in [MCP access](#mcp-access). Tokens are
  stored as hashes, shown once, scoped to one project, and revoking one closes that project's live MCP sessions
  rather than waiting for the next request.
- A static token is a credential for the endpoint, not an account: it has no identity and no per-document rules, so a
  holder reads everything indexed in that project. A project left `open` is readable by anyone who can reach its URL,
  whatever the dashboard roles say. A project set to **account required** is the case where they do say: a credential
  there names an account, and that account's membership is re-checked on every request.
- The OAuth endpoints (`/.well-known/oauth-*`, `/oauth/*`) are reachable without a credential by design — the two
  discovery documents exist to be fetched by a client that has none, and registering a client grants nothing at all.
  Approving one is a signed-in browser action, same-site checked like every other write in the dashboard.
- So an instance that publishes its port and leaves its projects open belongs on a private network, or behind a
  reverse proxy that handles auth — the endpoint itself is the only thing a project token closes.
- Browser `Origin` headers on `/mcp/*` are validated (DNS-rebinding protection) in both modes; CLI clients send none.
- Local source directories are confined to `ALLOWED_DOC_ROOTS`; `..`, symlinks that escape, and non-directories are rejected.
- A Confluence source's base URL is operator-typed, so its requests may not connect to loopback, link-local (the cloud metadata address included), unspecified or multicast addresses, nor to a private one unless its host is in `CONFLUENCE_ALLOWED_HOSTS`. The check is on the address actually dialled, after DNS and on every redirect, and a refusal sends no request and no token.
- Git and Notion tokens are encrypted at rest with `SECRET_KEY` (AES-256-GCM) and never returned by the API; credentials pasted into a repository URL are stripped before storage. `SECRET_KEY` can be rotated without re-entering them — `SECRET_KEY_PREVIOUS`, then `npm run rotate-secret` — and the command never prints a secret.
- Push webhooks verify the provider's signature against the per-source secret before anything is queued; the endpoint is otherwise unauthenticated by necessity.
- Uploads and archives are extracted into a scratch directory first and only then copied in: entries that escape, dot-directories, non-portable names and unselected file types are dropped, and `ARCHIVE_MAX_ENTRIES` / `ARCHIVE_MAX_TOTAL_BYTES` bound a zip bomb. Nested archives are unpacked one level deep.
- A git subdirectory is resolved inside the checkout; `..` segments are rejected.
- `read_document` only serves documents that were indexed for that project, never arbitrary paths — and since it reads the stored text rather than the filesystem, there is no path for it to traverse.
- The dashboard requires an account. Roles are `root`, `admin` and `member`, with a per-project `viewer`/`editor` role
  on top; every rule is enforced server-side from a single policy table, and a route that forgets to declare one fails
  the test suite. Hiding a button in the browser is cosmetic and the code says so.
- Passwords are stored as salted `scrypt` hashes (`node:crypto`, N=2¹⁵). They are never logged, never returned by the
  API and cannot be reversed. An unknown username is answered with the same message, and after the same amount of work,
  as a wrong password.
- Sign-in is rate-limited per IP and per account; the account lockout backs off by doubling, capped at an hour.
- The session cookie is `HttpOnly`, `SameSite=Lax`, `Path=/` and `Secure` over HTTPS. Sessions are rows that can be
  revoked: changing a password ends that account's other sessions, and disabling, deleting or resetting an account ends
  all of them. Only a hash of the cookie's token is stored.
- Cookie-authenticated writes must come from this site (`Sec-Fetch-Site`, falling back to `Origin`/`Referer`). CORS is
  deliberately left without `credentials`, so `ALLOWED_ORIGINS` cannot be used to read the API as a signed-in user.
- The last active root account cannot be deleted, demoted or disabled, and an admin cannot touch a root account.
- `ADMIN_TOKEN` bypasses the account system with root permissions. It is meant for scripts; do not paste it into a
  browser. It does not open a token-protected MCP endpoint — that takes one of the project's own tokens.
- The embedded PostgreSQL is reachable only from inside the container (`listen_addresses=127.0.0.1`, no published port).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `The database was created with EMBEDDING_DIMENSIONS=… but the current config says …` | Match the value, or start once with `RESET_VECTORS=1` and re-index everything. |
| `CHUNK_MAX_TOKENS=… exceeds what … reads` | The budget is larger than the model reads usefully. The shipped default fits the shipped model, so this means either was changed. Set `CHUNK_MAX_TOKENS` to the value the line suggests and re-index. If you run a model this build does not know, state its window in `EMBEDDING_MAX_INPUT_TOKENS`. |
| Dashboard shows `model loading` for a long time | First run downloads ~470 MB (fp32); check `docker compose logs -f`. Air-gapped hosts: pre-populate the `contextator-models` volume and set `EMBEDDING_OFFLINE=1`. |
| Container keeps restarting, logs say `PostgreSQL exited during startup` | The PostgreSQL output above that line tells why: usually a data directory from another PostgreSQL major version, or a bind-mounted `CONTEXTATOR_PGDATA_PATH` with wrong permissions. |
| `Directory is outside the allowed document roots` | Use a path under `ALLOWED_DOC_ROOTS` (`/docs/...` inside Docker). |
| Adding a private git or Notion source fails on `SECRET_KEY` | Set `SECRET_KEY` (32+ characters) and restart; it is only required once a source stores a token. |
| Every private source stopped syncing after `SECRET_KEY` was changed | The old key is what those tokens were encrypted with. Put it back in `SECRET_KEY_PREVIOUS`, restart, run `npm run rotate-secret`, then remove `SECRET_KEY_PREVIOUS` and restart. If the old key is gone, re-enter each source's token. |
| A git source's row shows an authentication error | Check the token's scope and the Username field. Leave it empty for a Bitbucket repository or workspace access token (the default `x-token-auth` is for those only); a Bitbucket Cloud API token needs your Bitbucket username or `x-bitbucket-api-token-auth`, and a GitLab deploy token its generated `gitlab+deploy-token-N` username. **Test connection** reports the remote's answer verbatim. |
| `Subdirectory "…" does not exist in the repository` | The path is relative to the repository root and is checked against the branch that was checked out. |
| A push webhook returns `401 invalid_signature` | The secret in the repository settings is not the one shown while editing the source — copy it again, or **Regenerate** and paste the new one. |
| `search_docs` says the project was indexed with another model | Re-index the project (it happens automatically on the next index run). |
| Every search answers *no good match* | `SEARCH_SCORE_FLOOR` is a cosine similarity measured against the default embedding model. If you changed `EMBEDDING_MODEL`, the startup log says so — re-measure the floor with `npm run eval` against your corpus, or set `SEARCH_SCORE_FLOOR=0`, which turns the projects' own floors off as well. The warning names the projects that carry one. |
| An agent is told *no good match* for something that **is** documented | The floor refused a question it should not have. The server logs every gated query at `info` with the score it saw; compare that against the floor in effect — the project's own if it set one, else `SEARCH_SCORE_FLOOR`. A corpus that scores lower than the rest (prose more than reference pages) is better served by lowering that project's floor in the query-log panel, which previews the change first, than by lowering the server's. |
| Answers got longer after upgrading | Each excerpt now carries the chunk either side of it. `SEARCH_NEIGHBOR_CONTEXT=0` restores the old shape, and `SEARCH_MAX_RESULT_CHARS` caps the whole answer. |
| `Could not load the sharp module` in the container | Only when building from source: regenerate `package-lock.json` on Linux or run `npm install --os=linux --cpu=x64 sharp` before building. |
| I missed the first-run setup code | Set `SETUP_CODE` in `.env` to something you choose and restart — it is read on every start until the first account exists. Or just restart and read the fresh code the server prints: `docker compose restart contextator && docker compose logs -f`. |
| I forgot my password | Any root or admin can reset it from **Users → Reset password**, which hands them a temporary one for you. |
| Nobody can sign in any more | `docker compose exec contextator npm run reset-password -- <username>` — the tool ships in the image and has to run there, because the container's PostgreSQL is published nowhere. From a source checkout the same command runs against `DATABASE_URL`. It prints a new temporary password and ends that account's sessions. With `ADMIN_TOKEN` set, `curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3444/api/users/<id>/password` does the same. |
| I cannot delete the last root account | By design — the server answers `409` and the dashboard disables the button. Promote somebody else to `root` first. |
| Sign-in says *too many attempts* | Rate limiting. Wait out `AUTH_LOGIN_WINDOW_MIN`, or raise `AUTH_LOGIN_MAX_ATTEMPTS`. |
| The dashboard bounces between `/` and `/login` | The cookie is not coming back. Usually `AUTH_COOKIE_SECURE=1` on a plain-HTTP origin, or a reverse proxy dropping `Set-Cookie`. Set `AUTH_COOKIE_SECURE=0` for an HTTP-only LAN install. |
| `403 csrf_blocked` from my own script | The script is sending the session cookie from another origin. Use `Authorization: Bearer $ADMIN_TOKEN` instead; bearer requests are exempt. |
| After upgrading, `/api/*` answers `401 setup_required` | This instance had no `ADMIN_TOKEN` and was therefore open. It is now closed: open `/setup` with the code from the log and create the first account. Projects, sources and indexes are untouched. |
| A member reads a project in `/mcp/…` they are not a member of | Expected while that project is `open` or `token required`: a credential that names nobody is judged by the mode and not by memberships. Switch the project to **account required** under **MCP access** and its endpoint follows the member list. |
| An MCP client suddenly answers `401` | The project now requires a credential. Mint a token under **MCP access** and add `--header "Authorization: Bearer …"` (or `headers` in `mcp.json`) — or, if the project says **account required**, reconnect a client that can sign in, because a static token is refused there. |
| An MCP client answers `403 … not a member of this project` | The credential is fine and the account behind it is not on the project. Add them under **Members**, or connect with an account that is one. |
| A browser-based connector cannot connect at all | Either the project is `open`/`token required` and the connector has no header to send, or `MCP_OAUTH=0` on this instance and there is no flow for it to use. |
| A connector says it was disconnected and has to be approved again | Expected after a password change, after its membership was removed, or after the same credential was presented twice — which this server treats as two parties holding one token and answers by taking the grant down. A connector simply left unused past `MCP_OAUTH_REFRESH_TTL_DAYS` is a different and quieter case: it is asked to authorize again and nothing is revoked. Approve it again either way. |
| A connector reports `invalid_scope` | It asked for an OAuth scope. This server issues none — an account-backed credential reaches exactly what its account may read — so the request is refused rather than granted under a scope nobody honours. The server log names the client that asked. |
| I lost an MCP token | It cannot be recovered — only a hash is stored. Revoke it and mint another. |

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
