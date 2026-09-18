# Contextator

**Self-hosted, multi-tenant MCP documentation server.** Give a project its document sources — mounted
folders, git repositories, uploaded archives, a Notion workspace — and it becomes its own
[Model Context Protocol](https://modelcontextprotocol.io) endpoint that AI agents (Cursor, Claude Code,
Claude Desktop, …) can search semantically:

```
http://localhost:3444/mcp/<project-name>
```

- **One URL per project, fully isolated.** Each project has its own document collection and
  vector embeddings in PostgreSQL + [pgvector](https://github.com/pgvector/pgvector). A client
  connected to `/mcp/billing` never sees `/mcp/mobile`.
- **Many sources per project.** A local directory, a git repository (or one subdirectory of it), an
  upload of files/folders/`.zip`/`.tar.gz`/`.rar`, or a Notion workspace — combined into one searchable
  endpoint. Every source is mounted under its own name, so documents read as `handbook/install.md`.
- **100 % local by default.** Embeddings are generated on the CPU with
  [transformers.js](https://huggingface.co/docs/transformers.js) (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`,
  50+ languages incl. Turkish). Switch to OpenAI embeddings with two env vars.
- **Both MCP transports on the same URL.** Streamable HTTP for current clients, legacy HTTP+SSE for older ones.
- **Admin dashboard** at `http://localhost:3444/` to manage projects and their sources — add a repository, drop a folder or an archive on the page, test a connection, trigger re-indexing and watch progress.
- **Accounts and roles.** People sign in with their own account. `root` and `admin` manage everything and everyone; a
  `member` sees only the projects it is assigned to, as a read-only `viewer` or an `editor` that adds sources, uploads
  files and re-indexes. `ADMIN_TOKEN` stays for scripts and CI. See [Accounts and permissions](#accounts-and-permissions).
- **A door on each MCP endpoint.** A project's endpoint is open by default, as it has always been; require a bearer
  token on it per project when you want it closed. See [MCP access](#mcp-access).
- **Incremental indexing.** Files are hashed; only changed files are re-embedded, removed files are deleted.

Stack: TypeScript · Node.js 20+ · Fastify 5 · PostgreSQL 16 + pgvector · Drizzle ORM · `@modelcontextprotocol/sdk` · `@huggingface/transformers`.
Ships as **one Docker container** (`contextator`) that holds both the database and the app.
Free software under the **AGPL-3.0-or-later** ([why](#license)), with a commercial license available.

---

## Quick start (Docker)

Everything runs in a single container named `contextator`: PostgreSQL 16 + pgvector and the Node.js
app, started and stopped together by a small entrypoint script. Data lives in Docker volumes and
survives container removal (see [Data and persistence](#data-and-persistence)).

```bash
git clone <this repo> contextator && cd contextator
cp .env.example .env
# in .env, pick the code that /setup will ask for once:
#   SETUP_CODE=whatever-you-like
# optional: DOCS_HOST_PATH=/path/to/your/docs  (defaults to ./docs, which contains a demo)
docker compose up -d
docker compose logs -f            # wait for "embedding model ready"
```

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
3. Press **New project** (or `n`): name `demo`, directory `/docs/demo` (the host folder from `DOCS_HOST_PATH` is mounted at `/docs`).
   Leaving the directory empty creates an empty project; add its sources afterwards with **Add source**.
4. Watch the project's status go `indexing → idle` in the list; the **Document sources** panel shows every
   source with its document count, last sync and any error.
5. Use the **Connect an agent** tabs (Claude Code, Cursor, Claude Desktop, legacy SSE) for copy-paste snippets, or run the bundled smoke test:

```bash
npm install && npm run smoke -- http://localhost:3444/mcp/demo "how do I re-index"
```

The first start initialises the database and downloads the embedding model (~470 MB for the
multilingual fp32 model, ~120 MB with `EMBEDDING_DTYPE=q8`, ~90 MB for `all-MiniLM-L6-v2`) into the
`contextator-models` volume; later starts take a few seconds.

Without Compose:

```bash
docker build -t contextator .
docker run -d --name contextator -p 3444:3444 \
  -v contextator-pgdata:/var/lib/postgresql/data \
  -v contextator-models:/app/.cache/models \
  -v contextator-data:/data \
  -v /path/to/your/docs:/docs:ro \
  contextator
```

## Document sources

A project is a set of **sources**. Each one is added in the dashboard (**Add source**), carries a
URL-safe `name`, and that name becomes the prefix of every document it contributes: a file
`install.md` in a source named `handbook` is indexed, searched and read as `handbook/install.md`.
The name is the mount point, so it cannot change after creation; everything else can.

| Type | What it is | Synced by |
|------|-----------|-----------|
| **Local directory** | A folder mounted on the server, scanned in place. Must live inside `ALLOWED_DOC_ROOTS`; nothing is copied. | Reading it at index time |
| **Git repository** | A shallow, single-branch checkout under `DATA_DIR`. Any HTTPS git server: GitHub, GitLab, Bitbucket, Gitea/Forgejo/Codeberg. Optionally only a **subdirectory** of the repository (`docs/`). | `git fetch` of the branch tip at the start of every index run, or a push webhook |
| **Upload** | Files, whole folders (structure preserved) and archives — `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.rar` — unpacked on the server. Add to the existing files or replace them all. | Nothing to sync; the files live under `DATA_DIR` |
| **Notion** | Every page shared with an internal integration (or the configured root pages/databases and their descendants), rendered to Markdown, nested by parent page. | The Notion API, re-rendering only pages whose `last_edited_time` changed |

Sources are synced at the start of every index run, one after another; a source that fails to sync is
reported on its own row and the others still index. **Sync** on a row and **Re-index** in the header
both queue the same run.

### Content types (flavors)

A source can declare what its files really are, which applies a small transform before chunking:

- **Plain Markdown / text** — no transform.
- **Obsidian vault** — see below.
- **Notion export** — the 32-hex page id Notion appends to file and folder names (`Getting started 1a2b…5c6d.md`) is stripped from paths and from the links pointing at them.

Upload a Notion **Export → Markdown & CSV** zip with the *Notion export* content type; use the
**Notion** source type instead when you want the live API.

The content type is applied on the way into the chunker, after the file hash that decides what to
re-embed — so changing it drops the stored hashes of that source and queues a run, otherwise the new
transform would never reach a file whose bytes did not change.

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
| GitLab | `oauth2` (OAuth and personal/project access tokens) |
| Bitbucket Cloud | `x-token-auth` for repository/workspace access tokens; **app passwords need your real username** in the Username field |
| Gitea / Forgejo / Codeberg / other | `token`, or whatever you type in Username |

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

Accounts govern the dashboard and the admin API. The MCP endpoints have their own door — see
[MCP access](#mcp-access) below.

## MCP access

A project's MCP endpoint is **open** by default: anyone who can reach `http://host:3444/mcp/<project>` reads every
document indexed there, with no account and no token. That is how Contextator has always behaved, and an upgrade does
not change it for a single existing project.

Per project, you can close it. **MCP access** on the project page switches it to **token required**, and from then on
only a client presenting one of that project's tokens gets an answer:

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

**What this does not do.** The token is a bearer credential for the endpoint, not an account: it carries no identity,
no per-document rules and no audit trail beyond "this token was last used at". A holder reads everything indexed in
that project. And a token-protected project answers `401` where an unknown project answers `404`, so the existence of
a project name is still discoverable by anyone who can reach the server — hiding that would mean answering `404` to a
client with a wrong token, which is worse to debug than it is worth.

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

`docker compose down`, `docker compose up --build`, image upgrades and `docker rm contextator` all keep
the volumes. Only `docker compose down -v` or `docker volume rm` deletes them. Examples:

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

PostgreSQL listens on `127.0.0.1` inside the container only and is not published. Inspect, back up and
restore it through the container:

```bash
docker exec -it contextator psql -U contextator
docker exec contextator pg_dump -U contextator -Fc contextator > contextator.dump
docker exec -i contextator pg_restore -U contextator -d contextator --clean --if-exists < contextator.dump
```

`POSTGRES_PASSWORD` is applied when the cluster is created. To change it later run
`ALTER USER contextator PASSWORD '...'` via `psql` and update `.env` before the next start.

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
| `search_docs` | `query: string`, `limit?: 1-20` (default 5) | Cosine-similarity search over the project's chunks. Returns ranked excerpts with file path, heading breadcrumb (`Guide > Install > Docker`) and score. |
| `list_topics` | – | Every indexed document grouped by directory, with title and chunk count. The first path segment is the source it came from. |
| `read_document` | `path: string` | Full Markdown of one indexed file (path as shown by the other tools, e.g. `handbook/install.md`). Only indexed paths are served; capped at 512 KB. |

The server also sends MCP `instructions` describing the project so agents know when to use which tool.

## How indexing works

1. Every source of the project is synced in turn (git fetch, Notion pull; local and upload sources have nothing to fetch), then its directory is walked for the file types the source selected — `.md`/`.mdx` by default, optionally `.txt` (dotfiles, `node_modules`, `dist`, `build`, symlinks and `IGNORE_GLOBS` are skipped). Every path collected is prefixed with the source name, so two sources can both hold an `install.md` without colliding.
2. The source's content type is applied (Obsidian wikilinks, Notion export ids), and every file is hashed (sha256). Unchanged files are skipped, changed/new files are re-chunked and re-embedded, files that disappeared are deleted. **Force** re-index wipes the project first. Every finished run (mode, counts, duration, error) is stored in `index_runs`; the last 20 per project are kept and shown in the dashboard.
3. Chunking is Markdown-aware: frontmatter is parsed (`title` wins), MDX `import`/`export` lines and component tags are stripped, the document is split at headings (`#`–`####`) with a breadcrumb kept per chunk, and oversized sections are packed from paragraphs and fenced code blocks (code is never split mid-block when avoidable) with a small overlap.
4. Each chunk is embedded as `heading breadcrumb + content` and stored in `chunks` with an HNSW cosine index.

**Chunk size caveat.** `CHUNK_MAX_TOKENS` defaults to 400 (tokens ≈ characters / 4). MiniLM-class models
only look at the first ~128–256 word pieces of each input, so with the local models a smaller value
(`250`) gives slightly better retrieval; 400+ is ideal for OpenAI (8k window). Putting the breadcrumb
first guarantees the most informative part is always inside the model window.

## Configuration

Everything is an environment variable; see [`.env.example`](.env.example) for the full annotated list.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` / `HOST` | `3444` / `0.0.0.0` | |
| `DATABASE_URL` | `postgres://contextator:contextator@localhost:5432/contextator` | Local development only. The container ignores it and talks to its embedded PostgreSQL via `PG*` variables set by the entrypoint |
| `POSTGRES_PASSWORD` | `contextator` | Password of the embedded PostgreSQL (loopback only), applied when the cluster is first created |
| `CONTEXTATOR_PGDATA_VOLUME` / `CONTEXTATOR_MODELS_VOLUME` | `contextator-pgdata` / `contextator-models` | Docker volume names (docker-compose only) |
| `CONTEXTATOR_PGDATA_PATH` / `CONTEXTATOR_MODELS_PATH` | – | Absolute host directories used instead of the volumes (docker-compose only) |
| `ALLOWED_DOC_ROOTS` | `/docs` | Comma-separated. Project directories **must** live inside one of these (path-escape protection). On Windows dev: `C:/path/to/docs` |
| `DOCS_HOST_PATH` | `./docs` | Host folder mounted read-only at `/docs` (docker-compose only) |
| `MODEL_CACHE_DIR` | `.cache/models` | Model download directory; `/app/.cache/models` inside the container |
| `IGNORE_GLOBS` | – | e.g. `**/CHANGELOG.md,drafts/**`. Applies to every source |
| `DATA_DIR` | `.data` | Writable directory holding the materialised sources (git checkouts, uploads, Notion pulls). `/data` inside the container |
| `SECRET_KEY` | – | At least 32 characters (`openssl rand -hex 32`). Encrypts git/Notion tokens at rest (AES-256-GCM). Needed only once such a source exists; changing it invalidates stored tokens |
| `UPLOAD_MAX_FILE_BYTES` | `52428800` (50 MB) | Per uploaded file |
| `UPLOAD_MAX_FILES_PER_REQUEST` | `500` | The dashboard splits large folders across requests by itself |
| `UPLOAD_MAX_ARCHIVE_BYTES` | `268435456` (256 MB) | Per uploaded archive |
| `ARCHIVE_MAX_ENTRIES` / `ARCHIVE_MAX_TOTAL_BYTES` | `20000` / `1073741824` (1 GB) | Zip-bomb guards applied while extracting |
| `EMBEDDING_PROVIDER` | `local` | `local` or `openai` |
| `EMBEDDING_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Any transformers.js feature-extraction model. English-only & faster: `Xenova/all-MiniLM-L6-v2` (also 384-d) |
| `EMBEDDING_DIMENSIONS` | `384` | Must match the model. `1536` for `text-embedding-3-small` |
| `EMBEDDING_DTYPE` | `fp32` | `q8` downloads a ~4× smaller quantized model |
| `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` | – / `text-embedding-3-small` | Used when the provider is `openai` |
| `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `400` / `50` | |
| `ADMIN_TOKEN` | – | **Machine access** to `/api/*` via `Authorization: Bearer …`, acting with root permissions. Browsers sign in with an account instead; treat this token like a root password |
| `AUTH_SESSION_IDLE_MS` | `43200000` (12 h) | A dashboard session unused for this long has to sign in again. Refreshed while the dashboard is in use |
| `AUTH_SESSION_TTL_DAYS` | `30` | Hard ceiling on a session's life, however actively it is used |
| `AUTH_COOKIE_SECURE` | `auto` | `auto` sets `Secure` when the request arrives over HTTPS (`trustProxy` is on). Force with `1`; use `0` for a plain-HTTP LAN install, or the browser drops the cookie |
| `AUTH_LOGIN_MAX_ATTEMPTS` | `10` | Failed sign-ins per account and per IP before a lockout / `429` |
| `AUTH_LOGIN_WINDOW_MIN` | `15` | The IP window, and the first lockout step (it doubles, capped at an hour) |
| `PASSWORD_MIN_LENGTH` | `12` | Applies to every password, temporary ones included. No composition rules |
| `SETUP_CODE` | – | The code `/setup` asks for once. Set it and you never have to read it out of the log; leave it empty and the server generates one and prints it at every start until the first account exists. Ignored from then on. Case, dashes and punctuation are ignored when it is checked, so give it enough letters and digits |
| `ALLOWED_ORIGINS` | – | Extra browser origins allowed on `/mcp/*` (non-browser clients are always allowed) |
| `PUBLIC_BASE_URL` | – | e.g. `https://docs.example.com` for the URLs shown in the dashboard |
| `SESSION_IDLE_TTL_MS` | `1800000` | Idle Streamable HTTP sessions are closed after 30 min |
| `RESET_VECTORS` | `0` | See *Changing the embedding model* |

### Changing the embedding model

- **Same dimension** (e.g. between the two MiniLM models): change `EMBEDDING_MODEL`, restart, and re-index.
  The server notices the model id stored on each project differs and performs a full re-index automatically;
  `search_docs` refuses to search a project indexed with another model until then.
- **Different dimension** (e.g. OpenAI `text-embedding-3-small` = 1536): set `EMBEDDING_PROVIDER=openai`,
  `OPENAI_API_KEY`, `EMBEDDING_DIMENSIONS=1536`, then start **once** with `RESET_VECTORS=1`. The vector
  column is re-typed and every chunk is dropped; re-index each project afterwards. Without the flag the
  server refuses to start and prints exactly this instruction.

## Admin API

All endpoints return JSON. Every request is authenticated either by the session cookie the dashboard receives at
sign-in, or by `Authorization: Bearer <ADMIN_TOKEN>` (machine access, root permissions). `GET /api/health` is exempt,
and answers with less detail when nobody is signed in.

A cookie-authenticated request that changes something must come from this site: the server checks `Sec-Fetch-Site`
(falling back to `Origin`/`Referer`) and answers `403 csrf_blocked` otherwise. Bearer requests are exempt — they carry
no ambient credential.

| Method & path | Description |
|---------------|-------------|
| `GET /api/health` | DB status, embedding provider/model/dtype/readiness, open MCP sessions, version |
| `GET /api/projects` | Projects with counts, `mcpUrl` and the live indexing `job` (phase, files done/total/skipped/removed, chunks; for queued jobs `queue.aheadProjectName`) |
| `POST /api/projects` `{ name, rootPath, index?: true }` | Create a project; `400` invalid name/path, `409` duplicate |
| `POST /api/projects/:id/reindex?force=true` | Queue (incremental or full) re-index → `202 { job }` |
| `GET /api/projects/:id/status` | Project row + live job |
| `GET /api/projects/:id/runs` | The project's last 20 index runs (mode, counts, duration, error), newest first |
| `DELETE /api/projects/:id` | Delete project, its chunks and open MCP sessions (`409` while indexing) |
| `GET /api/projects/:id/sources` | The project's sources (type, name, config, status, document count). Secrets are never returned — only `hasSecret` |
| `POST /api/projects/:id/sources` `{ type, name, label?, flavor?, config?, secret?, index? }` | Add a source. `type` is `local`, `git`, `upload` or `notion`; `config` is type-specific (`path` / `url`+`branch`+`subdir` / `rootIds`) |
| `PATCH /api/projects/:id/sources/:sid` | Change label, content type, config or token (`secret: null` removes it). Type and name are immutable |
| `DELETE /api/projects/:id/sources/:sid` | Remove the source, its documents, chunks and materialised directory (`409` while indexing) |
| `POST /api/projects/:id/sources/:sid/sync` | Queue a re-index (every source is synced at the start of it) → `202 { job }` |
| `POST /api/projects/:id/sources/:sid/test` | Connectivity check without indexing → `{ ok, message }` |
| `POST /api/projects/:id/sources/:sid/webhook-secret` | Generate a new push-webhook secret (git only) |
| `POST /api/projects/:id/sources/:sid/uploads` | Open an upload session → `{ session }` (upload sources only) |
| `POST …/uploads/:session/files` | `multipart/form-data`; each part's `filename` carries the path inside the source. Archives are unpacked server-side → `{ files, skipped, bytes, errors }` |
| `POST …/uploads/:session/commit?mode=add\|replace` | Move the staged tree into the source and queue an index run → `202 { files, job }` |
| `DELETE …/uploads/:session` | Discard a staged upload |
| `GET /api/projects/:id/sources/:sid/files` | Files currently materialised for an upload source |
| `DELETE /api/projects/:id/sources/:sid/files?path=…` | Delete one of them and re-index |
| `POST /api/webhooks/git/:sourceId` | Push webhook. Authenticated by the per-source secret, **not** `ADMIN_TOKEN` |
| `GET /api/projects/:id/mcp-tokens` | This project's live MCP tokens: name, prefix, when they were created and last used. Never the token itself |
| `POST /api/projects/:id/mcp-tokens` `{ name? }` | Mint one → `201 { token, secret }`; `secret` is returned **once** |
| `DELETE /api/projects/:id/mcp-tokens/:tokenId` | Revoke it and close the project's open MCP sessions |
| `PATCH /api/projects/:id/mcp-auth` `{ mode }` | `open` or `token` (root/admin) |

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
| `GET /api/projects/:id/members` | Accounts with access to this project and their role (any member of it) |
| `PUT /api/projects/:id/members/:userId` `{ role }` | Grant or change `viewer` / `editor` (root/admin) |
| `DELETE /api/projects/:id/members/:userId` | Revoke access (root/admin) |

A project a member has no access to answers `404`, not `403`, so project ids cannot be probed. `409` guards the last
root account; `403` guards an admin reaching for a root one.

## Local development (without Docker for the app)

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL + pgvector only, on localhost:5432
cp .env.example .env
# ALLOWED_DOC_ROOTS=C:/Users/me/docs     (Windows)  or  /home/me/docs
# DATA_DIR=.data                         (git checkouts, uploads and Notion pulls; gitignored)
# SECRET_KEY=$(openssl rand -hex 32)     (only needed for private repositories / Notion)
npm install
npm run dev                              # tsx watch, http://localhost:3444
npm test                                 # vitest: chunker + path-safety unit tests
npm run typecheck
npm run smoke -- http://localhost:3444/mcp/demo "kurulum" --sse   # exercise the legacy transport too
```

`npm run db:studio` opens Drizzle Studio against `DATABASE_URL`.

## Project layout

```
src/server.ts                 Fastify entrypoint / composition root
src/config.ts                 zod-validated environment
src/db/schema.ts              Drizzle schema (projects, document_sources, documents, chunks, index_runs, settings, users, user_sessions, project_members)
src/db/ensure-schema.ts       idempotent DDL applied at startup (extension, tables, HNSW index, dimension guard)
src/services/chunker.ts       Markdown/MDX-aware chunking with heading breadcrumbs
src/services/fs-scan.ts       safe directory walking + path-escape checks
src/services/sources.ts       source CRUD and the zod schema of each type's config
src/services/sources/         one driver per type: local, git (isomorphic-git), upload, notion
src/services/flavors.ts       content-type transforms (Obsidian wikilinks, Notion export ids)
src/services/archives.ts      zip / tar / tar.gz / rar extraction with path and size guards
src/services/uploads.ts       staged upload sessions and their commit into a source
src/services/data-dir.ts      layout of DATA_DIR, atomic directory swaps, orphan sweep
src/services/crypto.ts        AES-256-GCM encryption of source tokens (SECRET_KEY)
src/services/embeddings/      provider interface, local (transformers.js) and OpenAI implementations
src/services/indexer.ts       incremental background indexing queue
src/services/vector-store.ts  pgvector cosine search and chunk persistence
src/mcp/router.ts             /mcp/:project — Streamable HTTP + legacy SSE on one URL
src/mcp/tools.ts              search_docs, list_topics, read_document
src/mcp/sessions.ts           per-connection McpServer/transport registry + idle reaper
src/auth/policy.ts            every authorization rule as data — no DB, no Fastify, fully unit-tested
src/auth/authorize.ts         the request checks that need no database, in the order they must happen
src/auth/plugin.ts            resolves the principal (cookie or ADMIN_TOKEN) and applies the policy
src/auth/cookies.ts           the session cookie's name, flags and Secure decision
src/auth/csrf.ts              same-site check for cookie-authenticated writes
src/services/passwords.ts     scrypt hashing (node:crypto), policy and temporary passwords
src/services/auth/            accounts, sessions, memberships and the first-run setup gate
src/services/rate-limit.ts    in-memory sliding window for sign-in attempts
src/admin/routes.ts           REST API for the dashboard
src/admin/sources-routes.ts   source CRUD, sync, test, webhook secret
src/admin/upload-routes.ts    multipart upload sessions (the only multipart-parsing plugin)
src/admin/webhooks.ts         push webhooks, verified with the per-source secret
src/admin/auth-routes.ts      /api/auth/* and /api/setup/*
src/admin/users-routes.ts     /api/users/*
src/admin/members-routes.ts   /api/projects/:id/members/*
src/admin/mcp-routes.ts       /api/projects/:id/mcp-tokens/* and the open/token switch
src/mcp/access.ts             the MCP endpoint's access rule, as a pure function
src/admin/pages.ts            /about, /privacy, /cookies, /terms, /license rendered into one shell
src/admin/auth-pages.ts       /login, /setup, /change-password and the guard on `/`
public/                       vanilla HTML/JS dashboard (no build step)
public/core.js                shared helpers: el(), api(), state, the event bus
public/auth.js                the signed-in account, the top-bar menu, permission helpers
public/users.js               the account list at #/~users
public/members.js             a project's Members panel
public/mcp.js                 a project's MCP access panel and its tokens
public/auth-page.js           /login, /setup and /change-password — imports nothing from the dashboard
public/pages/                 body of each product/legal page + the shell they share
scripts/smoke-mcp.ts          end-to-end MCP client check
scripts/reset-password.ts     last-resort password reset straight against the database
docs/demo/                    sample documentation (English, Turkish, MDX)
Dockerfile                    one image: postgres:16 + pgvector + Node 22 + the app
docker/entrypoint.sh          starts PostgreSQL, then the app; stops both in order on SIGTERM
docker-compose.yml            the `contextator` container and its volumes
docker-compose.dev.yml        PostgreSQL only, for `npm run dev`
```

### How the single container works

`docker/entrypoint.sh` (under `tini`) launches the unchanged upstream `postgres` image entrypoint in the
background, so first-run `initdb`, `POSTGRES_*` handling and `/docker-entrypoint-initdb.d` work exactly
as in the official image. Once `pg_isready` succeeds on `127.0.0.1:5432` it starts `node dist/server.js`
as the unprivileged `node` user with the libpq `PG*` variables pointing at that server. `SIGTERM` stops
the app first and then PostgreSQL (fast shutdown); if either process dies the other is stopped and the
container exits so `restart: unless-stopped` can bring the pair back.

### Why no migrations?

The vector column's dimension is a deployment setting (`vector(384)` vs `vector(1536)`), which
generated migrations would hard-code. Instead `ensure-schema.ts` runs idempotent `CREATE … IF NOT EXISTS`
DDL on every start under an advisory lock and records the dimension in a `settings` table so a
mismatch fails fast with a clear message. `src/db/schema.ts` is kept in sync by hand and powers Drizzle's
typed queries and Drizzle Studio. Schema version 4 added `users`, `user_sessions` and `project_members`, and
version 5 added `mcp_tokens` and `projects.mcp_auth`; an existing database picks them up on the next start with
nothing to run by hand, and every project keeps the MCP behaviour it already had.

## Security notes

- The MCP endpoints are **unauthenticated by design** (MCP clients have no standard way to pass a token yet).
  Bind the server to a private network, or put it behind a reverse proxy that handles auth.
- Local source directories are confined to `ALLOWED_DOC_ROOTS`; `..`, symlinks that escape, and non-directories are rejected.
- Git and Notion tokens are encrypted at rest with `SECRET_KEY` (AES-256-GCM) and never returned by the API; credentials pasted into a repository URL are stripped before storage.
- Push webhooks verify the provider's signature against the per-source secret before anything is queued; the endpoint is otherwise unauthenticated by necessity.
- Uploads and archives are extracted into a scratch directory first and only then copied in: entries that escape, dot-directories, non-portable names and unselected file types are dropped, and `ARCHIVE_MAX_ENTRIES` / `ARCHIVE_MAX_TOTAL_BYTES` bound a zip bomb. Nested archives are unpacked one level deep.
- A git subdirectory is resolved inside the checkout; `..` segments are rejected.
- `read_document` only serves files that were indexed for that project, never arbitrary paths.
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
- `ADMIN_TOKEN` bypasses the account system with root permissions. It is meant for scripts; do not paste it into a browser.
- An MCP endpoint is **open** by default — the historical behaviour — and can be closed per project with a bearer
  token. Tokens are stored as hashes, shown once, scoped to one project, and revoking one closes that project's live
  MCP sessions rather than waiting for the next request.
- A token is a credential for the endpoint, not an account: it has no identity and no per-document rules, so a holder
  reads everything indexed in that project. A project left `open` is readable by anyone who can reach its URL,
  whatever the dashboard roles say.
- Browser `Origin` headers on `/mcp/*` are validated (DNS-rebinding protection); CLI clients send none.
- The embedded PostgreSQL is reachable only from inside the container (`listen_addresses=127.0.0.1`, no published port).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `The database was created with EMBEDDING_DIMENSIONS=… but the current config says …` | Match the value, or start once with `RESET_VECTORS=1` and re-index everything. |
| Dashboard shows `model loading` for a long time | First run downloads ~470 MB; check `docker compose logs -f`. Air-gapped hosts: pre-populate the `contextator-models` volume and set `EMBEDDING_OFFLINE=1`. |
| Container keeps restarting, logs say `PostgreSQL exited during startup` | The PostgreSQL output above that line tells why: usually a data directory from another PostgreSQL major version, or a bind-mounted `CONTEXTATOR_PGDATA_PATH` with wrong permissions. |
| `Directory is outside the allowed document roots` | Use a path under `ALLOWED_DOC_ROOTS` (`/docs/...` inside Docker). |
| Adding a private git or Notion source fails on `SECRET_KEY` | Set `SECRET_KEY` (32+ characters) and restart; it is only required once a source stores a token. |
| A git source's row shows an authentication error | Check the token's scope, and on Bitbucket app passwords put your real username in the Username field. **Test connection** reports the remote's answer verbatim. |
| `Subdirectory "…" does not exist in the repository` | The path is relative to the repository root and is checked against the branch that was checked out. |
| A push webhook returns `401 invalid_signature` | The secret in the repository settings is not the one shown while editing the source — copy it again, or **Regenerate** and paste the new one. |
| `search_docs` says the project was indexed with another model | Re-index the project (it happens automatically on the next index run). |
| `Could not load the sharp module` in the container | Regenerate `package-lock.json` on Linux or run `npm install --os=linux --cpu=x64 sharp` before building. |
| I missed the first-run setup code | Set `SETUP_CODE` in `.env` to something you choose and restart — it is read on every start until the first account exists. Or just restart and read the fresh code the server prints: `docker compose restart contextator && docker compose logs -f`. |
| I forgot my password | Any root or admin can reset it from **Users → Reset password**, which hands them a temporary one for you. |
| Nobody can sign in any more | On the server: `npm run reset-password -- <username>` (inside the container: `docker compose exec contextator node --import tsx scripts/reset-password.ts <username>`). It prints a new temporary password and ends that account's sessions. With `ADMIN_TOKEN` set, `curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3444/api/users/<id>/password` does the same. |
| I cannot delete the last root account | By design — the server answers `409` and the dashboard disables the button. Promote somebody else to `root` first. |
| Sign-in says *too many attempts* | Rate limiting. Wait out `AUTH_LOGIN_WINDOW_MIN`, or raise `AUTH_LOGIN_MAX_ATTEMPTS`. |
| The dashboard bounces between `/` and `/login` | The cookie is not coming back. Usually `AUTH_COOKIE_SECURE=1` on a plain-HTTP origin, or a reverse proxy dropping `Set-Cookie`. Set `AUTH_COOKIE_SECURE=0` for an HTTP-only LAN install. |
| `403 csrf_blocked` from my own script | The script is sending the session cookie from another origin. Use `Authorization: Bearer $ADMIN_TOKEN` instead; bearer requests are exempt. |
| After upgrading, `/api/*` answers `401 setup_required` | This instance had no `ADMIN_TOKEN` and was therefore open. It is now closed: open `/setup` with the code from the log and create the first account. Projects, sources and indexes are untouched. |
| A member reads a project in `/mcp/…` they are not a member of | Expected while that project is `open`: dashboard roles do not reach the MCP endpoint. Require a token on it under **MCP access**. |
| An MCP client suddenly answers `401` | The project now requires a token. Mint one under **MCP access** and add `--header "Authorization: Bearer …"` (or `headers` in `mcp.json`). |
| I lost an MCP token | It cannot be recovered — only a hash is stored. Revoke it and mint another. |

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
