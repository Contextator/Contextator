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
  [transformers.js](https://huggingface.co/docs/transformers.js) (`Xenova/multilingual-e5-small`, a
  retrieval model covering 100 languages incl. Turkish). Switch to OpenAI embeddings with two env vars.
- **Both MCP transports on the same URL.** Streamable HTTP for current clients, legacy HTTP+SSE for older ones.
- **Admin dashboard** at `http://localhost:3444/` to manage projects and their sources — add a repository, drop a folder or an archive on the page, test a connection, trigger re-indexing and watch progress.
- **Accounts and roles.** People sign in with their own account. `root` and `admin` manage everything and everyone; a
  `member` sees only the projects it is assigned to, as a read-only `viewer` or an `editor` that adds sources, uploads
  files and re-indexes. `ADMIN_TOKEN` stays for scripts and CI. See [Accounts and permissions](#accounts-and-permissions).
- **A door on each MCP endpoint.** A project's endpoint is open by default, as it has always been; require a bearer
  token on it per project when you want it closed. See [MCP access](#mcp-access).
- **Incremental indexing.** Files are hashed; only changed files are re-embedded, removed files are deleted.
- **More than Markdown.** `.html`, `.docx`, `.csv` and `.pdf` are converted to Markdown as they are indexed, so an agent
  reads a Word file or a PDF the way it reads a page of documentation. See [File types](#file-types).

Stack: TypeScript · Node.js 22+ · Fastify 5 · PostgreSQL 16 + pgvector · Drizzle ORM · `@modelcontextprotocol/sdk` · `@huggingface/transformers` · `unpdf` / `mammoth` / `turndown`.
Ships as **one Docker container** (`contextator`) that holds both the database and the app.
Free software under the **AGPL-3.0-or-later** ([why](#license)), with a commercial license available.

---

## Quick start (Docker)

Everything runs in a single container named `contextator`: PostgreSQL 16 + pgvector and the Node.js
app, started and stopped together by a small entrypoint script. Data lives in Docker volumes and
survives container removal (see [Data and persistence](#data-and-persistence)).

```bash
git clone https://github.com/Contextator/Contextator.git contextator && cd contextator
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

The first start initialises the database and downloads the embedding model (~470 MB for the default
fp32 model, ~235 MB with `EMBEDDING_DTYPE=fp16`, ~120 MB with `EMBEDDING_DTYPE=q8`, ~90 MB for
`all-MiniLM-L6-v2`) into the `contextator-models` volume; later starts take a few seconds.

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
| **Git repository** | A shallow, single-branch checkout under `DATA_DIR`. Any HTTPS git server: GitHub, GitLab, Bitbucket, Gitea/Forgejo/Codeberg. Optionally only a **subdirectory** of the repository (`docs/`). | `git fetch` of the branch tip at the start of every index run, a push webhook, or the sync interval below |
| **Upload** | Files, whole folders (structure preserved) and archives — `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.rar` — unpacked on the server. Add to the existing files or replace them all. | Nothing to sync; the files live under `DATA_DIR` |
| **Notion** | Every page shared with an internal integration (or the configured root pages/databases and their descendants), rendered to Markdown, nested by parent page. | The Notion API, re-rendering only pages whose `last_edited_time` changed |

Sources are synced at the start of every index run, one after another; a source that fails to sync is
reported on its own row and the others still index. **Sync** on a row and **Re-index** in the header
both queue the same run.

### Keeping a source fresh on its own

A source can carry a **sync interval** — the *Sync every* field in its dialog — and the server checks it
on that schedule instead of waiting for somebody to press a button.

**It does not re-read the files to decide.** Each source type answers one cheap question first, and the
index run only happens when the answer moved since the last successful sync:

| Type | What is asked | Instead of |
|------|---------------|-----------|
| Git | `git ls-remote` on the tracked branch — one ref advertisement, no objects | A fetch |
| Notion | One `search`, newest edit first, one result | A page read per page, 350 ms apart |
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

Those two commands are the ones the test suite runs. `test/integration/backup-restore.itest.ts` seeds a
real PostgreSQL, dumps it, **drops the database**, restores it, and then asserts that the schema, the
search results — identical rows, identical order, identical scores — and the next start of the
application all come back unchanged. A row count would not have caught a restore that lost the vector
index or the lexical column, so it is not one of the assertions.

Two things a dump does **not** contain, and both matter on the day you need it:

- **`SECRET_KEY`.** It is an environment variable. Without the original key, every stored source
  credential has to be re-entered. Keep it somewhere the dump is not — the dump plus the key is the
  whole instance.
- **`/data`.** Git checkouts are re-clonable and Notion pulls are re-pullable, but **an upload source's
  `current/` directory is the only copy of its content anywhere**. A `/data` backup can be restricted to
  those and skip the re-clonable gigabytes.

Take the backup when no project is `indexing`: a re-index writes a second generation beside the live one
and `pg_dump` cannot filter rows, so a dump taken mid-run is twice the size. Expect a dump of roughly
2 KB per indexed chunk — vectors dump as text and compress back down — and expect most of a restore's
time to be the HNSW index being rebuilt over every chunk in the instance.

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
| `search_docs` | `query: string`, `limit?: 1-20` (default 5), `source?: string`, `path_prefix?: string` | Hybrid search over the project's chunks — meaning and exact wording at once, so `HALYARD_DISPATCH_TIMEOUT` finds its page as readily as a question does. Returns ranked excerpts with file path, heading breadcrumb (`Guide > Install > Docker`), score and the passage either side of each excerpt. `source` and `path_prefix` narrow it to one source or one directory; both are optional and omitting them searches everything, as it always did. When nothing clears the relevance floor it says *no good match* and points at `list_topics` instead of returning its least bad hit. |
| `list_topics` | `cursor?: string`, `limit?: 1-1000` (default 200) | Indexed documents grouped by directory, with title and chunk count. The first path segment is the source it came from. A project larger than one page ends its answer with a `next_cursor:` to hand back, so a thousand documents can be listed to the end. |
| `read_document` | `path: string`, `heading?: string`, `from?: int`, `to?: int`, `max_tokens?: 200-20000` (default 4000) | Markdown of one indexed file (path as shown by the other tools, e.g. `handbook/install.md`). Served from the database, so it works after the file has moved or gone. `heading` takes a breadcrumb straight out of a search result and returns that section and the subsections under it; `from`/`to` take a chunk range. Output is capped at `max_tokens`, counted with the embedding model's own tokenizer, and says where it cut and how to ask for the rest. |

The server also sends MCP `instructions` describing the project so agents know when to use which tool.

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

## File types

A source indexes `.md` and `.mdx` by default and can be told to take `.txt`, `.html`/`.htm`, `.csv`, `.docx` and
`.pdf` as well. **Everything becomes Markdown on the way in** — the chunker, the embedder and
`read_document` see one format, and the conversion happens once, at the edge.

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
be converted is not in the new generation — the same rule [ADR-0039](#) applies to a source that cannot
be read.

**What a file may cost while it is converted.** Conversion runs in the server's own process, beside the
dashboard and the MCP endpoint, and until now only the upload path had any size limit at all — a file
reached through a local directory or a git checkout was parsed at whatever size it happened to be.
Three caps bound it, and each closes something the others do not:

| Setting | Default | What it stops |
|---------|---------|---------------|
| `MAX_CONVERTED_FILE_BYTES` | 32 MiB | one enormous document taking the process down with it. `.md`, `.mdx` and `.txt` are decoded rather than parsed and are not capped |
| `MAX_PDF_PAGES` | 2000 | a few kilobytes of PDF that *declares* a hundred thousand pages — every page is read into memory at once |
| `MAX_DOCX_UNPACKED_BYTES` | 256 MiB | the ordinary zip bomb: a `.docx` is a zip, and its central directory is read before anything is inflated |

A file over a cap is refused by name, the same way a scan is.

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

1. Every source of the project is synced in turn (git fetch, Notion pull; local and upload sources have nothing to fetch), then its directory is walked for the file types the source selected — `.md`/`.mdx` by default, optionally `.txt`, `.html`/`.htm`, `.csv`, `.docx` and `.pdf` (dotfiles, `node_modules`, `dist`, `build`, symlinks and `IGNORE_GLOBS` are skipped). Every path collected is prefixed with the source name, so two sources can both hold an `install.md` without colliding.
2. Every file is hashed (sha256) over its **raw bytes**, then converted to Markdown by its type ([File types](#file-types)) and the source's content type is applied (Obsidian wikilinks, Notion export ids). Unchanged files are skipped, changed/new files are re-chunked and re-embedded, files that disappeared are deleted. A **force** re-index (and one triggered by a changed embedding model) rebuilds everything, and does it *beside* the live index rather than by wiping it first: the project keeps answering `search_docs`, `list_topics` and `read_document` for the whole run, and a run that fails halfway leaves the previous index serving instead of an empty project. Every finished run (mode, counts, duration, error) is stored in `index_runs`; the last 20 per project are kept and shown in the dashboard.
3. Chunking is Markdown-aware: frontmatter is parsed (`title` wins), MDX `import`/`export` lines and component tags are stripped, the document is split at headings (`#`–`####`) with a breadcrumb kept per chunk, and oversized sections are packed from paragraphs and fenced code blocks (code is never split mid-block when avoidable) with a small overlap.
4. Each chunk is embedded as `heading breadcrumb + content` and stored in `chunks` with an HNSW cosine index. The same string is also stored as a `tsvector` with a GIN index — that is the keyword half of search, and it is written in the same statement as the row, so the two halves can never describe different text.

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

The keyword half indexes every source in PostgreSQL's `simple` configuration — words as written, no
stemming — and asks its questions in the same one. That is the honest default here: PostgreSQL has no
Turkish configuration at all, a project is routinely two languages, and an unstemmed index returns an
identifier as the string it is. A per-source `language` exists in the source config and the admin API
accepts it, so the version that varies the query side needs no migration and no re-index; it is not
offered in the dashboard, because until that version ships a source indexed with stemming is matched by
a `simple` query *less* well, not better.

### Cross-lingual search is a known limit, and it is not being fixed

**Ask a question in the language of the documentation that answers it.** A Turkish question will find a
Turkish page and an English question will find an English one; a question that has to cross the boundary
mostly will not be answered, and this is a property of the embedding model rather than a setting you can
turn on.

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
its search with `source` or `path_prefix` — `search_docs` takes both. Two sources that each answer well
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
| `HNSW_EF_SEARCH` | `100` | How many candidates the vector index produces **before** the project filter is applied — pgvector's own default is 40. One index serves every project and pgvector post-filters, so too low a value answers a project that does not dominate the index with too few hits, or none. Costs latency on every search |
| `HNSW_ITERATIVE_SCAN` | `relaxed_order` | `relaxed_order`, `strict_order` or `off`. Keeps scanning when the filter leaves fewer hits than asked for, instead of answering short (pgvector 0.8+; on an older one all three settings are ignored and search behaves as it did). `relaxed_order` returns the rows unordered and the server sorts them itself |
| `HNSW_MAX_SCAN_TUPLES` | `20000` | The ceiling that actually **ends** an iterative scan, counted in index tuples across the **whole instance** rather than the project. Raise it with the instance — a project holding one per cent of the rows has to be scanned past to be found |
| `SEARCH_MAX_PER_DOCUMENT` | `2` | Excerpts one document may contribute to one answer, applied after ranking and refilled from the excerpts below it, so an agent that asked for five still gets five. Measured on the golden set it *gains* a question — what it drops is a near-duplicate of something already on the page. `20` turns it off |
| `SEARCH_NEIGHBOR_CONTEXT` | `1` | Chunks either side of each hit, shown as context around it rather than as further results. `0` turns it off. A chunk is `CHUNK_MAX_TOKENS`, so one either side is about three times the context a hit used to be |
| `SEARCH_MAX_RESULT_CHARS` | `12000` | Ceiling on one rendered `search_docs` answer; past it whole excerpts are dropped and the result says how many. A default answer is around 3 300 characters |
| `SYNC_DEFAULT_INTERVAL_MINUTES` | `60` | The sync interval a **newly created** source is given, in minutes; `0` creates them unscheduled. It never reaches a source that already exists — not on upgrade, and not when this value changes — so an upgrade starts no outbound traffic nobody asked for. Per source the dashboard and the API accept 5 to 43200 (30 days), or *never* |
| `SYNC_PROBES_PER_TICK` | `10` | How many due sources one tick — one minute — may check. The rest keep their turn, oldest first, and the next tick takes them |
| `SEARCH_SCORE_FLOOR` | `0.82` | Similarity below which `search_docs` answers *no good match* rather than its best hit. `0` turns it off. **Measured against the default embedding model and meaningless on another one** — the server warns at startup if they disagree. A question naming an identifier that the keyword half actually matched skips the gate, because an exact string match is correct at any similarity |
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

All endpoints return JSON. Every request is authenticated either by the session cookie the dashboard receives at
sign-in, or by `Authorization: Bearer <ADMIN_TOKEN>` (machine access, root permissions). `GET /api/health` is exempt,
and answers with less detail when nobody is signed in.

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
| `GET /api/projects/:id/search?q=…&limit=…&source=…&path_prefix=…` | The same search the project's `search_docs` tool runs, as JSON: `{ query, limit, source, pathPrefix, belowFloor, scoreFloor, hits: [{ score, fusedScore, denseRank, lexicalRank, path, title, headingPath, chunkIndex, content, contextBefore, contextAfter }] }`. `score` is the cosine similarity and is shown rather than ranked on; `fusedScore` is what ordered the list, and the two ranks say which half of search found the excerpt (`null` for the half that did not). `belowFloor` is whether an agent would have been told *no good match* — the hits come back either way, so the dashboard can show what was withheld. `limit` is 1–20 (default 5); `source` and `path_prefix` are optional. `400 invalid_request` for a source this project does not have (the message names the ones it does), `409 not_indexed` when the project has no chunks, `409 model_mismatch` when they were embedded with another model |
| `DELETE /api/projects/:id` | Delete project, its chunks and open MCP sessions (`409` while indexing) |
| `GET /api/projects/:id/sources` | The project's sources (type, name, config, status, document count). Secrets are never returned — only `hasSecret` |
| `POST /api/projects/:id/sources` `{ type, name, label?, flavor?, config?, secret?, syncIntervalMinutes?, index? }` | Add a source. `type` is `local`, `git`, `upload` or `notion`; `config` is type-specific (`path` / `url`+`branch`+`subdir` / `rootIds`). `syncIntervalMinutes` is 5–43200 or `null`; omitted takes the instance default |
| `PATCH /api/projects/:id/sources/:sid` | Change label, content type, config, token (`secret: null` removes it) or `syncIntervalMinutes` (`null` switches the schedule off). Type and name are immutable |
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
src/db/bootstrap.ts           startup: the extension, the migration journal, `migrate()`, the vector dimension, the HNSW index
src/services/chunker.ts       Markdown/MDX-aware chunking with heading breadcrumbs; pure and synchronous, the token counter injected
src/services/fs-scan.ts       safe directory walking + path-escape checks
src/services/sources.ts       source CRUD and the zod schema of each type's config
src/services/sources/         one driver per type: local, git (isomorphic-git), upload, notion
src/services/flavors.ts       content-type transforms (Obsidian wikilinks, Notion export ids)
src/services/doc-types/       one transform per file extension, all of them producing Markdown: html, docx, csv, pdf
src/services/doc-types/pdf.ts a PDF read as a layout — lines, columns, running heads, headings by size, tables by alignment
scripts/build-doc-fixtures.ts the dependency-free PDF and zip writers the binary test fixtures come from
src/types/                    ambient declarations for the two dependencies that ship none (mammoth, the turndown GFM plugin)
src/services/archives.ts      zip / tar / tar.gz / rar extraction with path and size guards
src/services/uploads.ts       staged upload sessions and their commit into a source
src/services/data-dir.ts      layout of DATA_DIR, atomic directory swaps, orphan sweep
src/services/crypto.ts        AES-256-GCM encryption of source tokens (SECRET_KEY)
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
src/auth/policy.ts            every authorization rule as data — no DB, no Fastify, fully unit-tested
src/auth/authorize.ts         the request checks that need no database, in the order they must happen
src/auth/plugin.ts            resolves the principal (cookie or ADMIN_TOKEN) and applies the policy
src/auth/cookies.ts           the session cookie's name, flags and Secure decision
src/auth/csrf.ts              same-site check for cookie-authenticated writes
src/services/passwords.ts     scrypt hashing (node:crypto), policy and temporary passwords
src/services/auth/            accounts, sessions, memberships and the first-run setup gate
src/services/rate-limit.ts    in-memory sliding window for sign-in attempts
src/admin/routes.ts           REST API for the dashboard
src/services/scheduler.ts     the sync schedule: which sources are due, the cheap per-driver check, and the run it queues
src/admin/sources-routes.ts   source CRUD, sync, test, webhook secret
src/admin/upload-routes.ts    multipart upload sessions (the only multipart-parsing plugin)
src/admin/webhooks.ts         push webhooks, verified with the per-source secret — git's generated here, Notion's captured from them
src/services/notion-webhook.ts which Notion deliveries mean a run, the window a captured token may be stored in, and the debounce before the queue
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
public/search.js              a project's search box and the hits it renders, scores and all
public/auth-page.js           /login, /setup and /change-password — imports nothing from the dashboard
public/pages/                 body of each product/legal page + the shell they share
scripts/smoke-mcp.ts          end-to-end MCP client check
scripts/reset-password.ts     last-resort password reset straight against the database; ships in the image and runs there
scripts/eval.ts               `npm run eval` — indexes eval/corpus, asks eval/golden.jsonl, prints recall@1, recall@5, MRR
scripts/eval-scoring.ts       the scoring arithmetic and the report, with no database or model in it, so it can be unit-tested
test/*.test.ts                unit suite — pure functions, no database, no Docker (`npm test`)
test/integration/*.itest.ts   the bootstrap, the schema equivalence review, vector-store, the password reset and /api/health against a real PostgreSQL + pgvector
test/integration/support/     the testcontainers harness, and the schema projection two schemas are compared with
test/integration/fixtures/    a pre-v3 `0.1` schema derived from history, and the frozen DDL ladder the migrations replaced
test/fixtures/doc-types/      one real file per supported type, plus the malformed ones a refusal has to survive
eval/corpus/                  the fixture corpus the golden set asks about: 15 English and 11 Turkish pages, written for this
eval/golden.jsonl             48 questions, one JSON object per line, each naming the file that answers it
eval/README.md                what a good question is, how to add one, and why the failures are kept
eval/BASELINE.md              the last recorded run of the default configuration
drizzle/                      generated migrations (`npm run db:generate`), applied at startup and shipped in the image
CONTRIBUTING.md               how to run it, the four checks, the pairs kept in sync, and the licence grant
CLA.md                        the contributor licence grant — a draft, not yet in force
SECURITY.md                   how to report a vulnerability, and what is documented behaviour rather than one
CODE_OF_CONDUCT.md            Contributor Covenant 2.1
LICENSE                       AGPL-3.0-or-later, verbatim; copied into the image and served at /license.txt
docs/demo/                    sample documentation (English, Turkish, MDX)
Dockerfile                    one image: postgres:16 + pgvector + Node 22 + the app
docker/entrypoint.sh          starts PostgreSQL, then the app; stops both in order on SIGTERM
docker-compose.yml            the `contextator` container and its volumes
docker-compose.dev.yml        PostgreSQL only, for `npm run dev`
biome.jsonc                   the one formatter and linter, and why each rule is set as it is
tsconfig.test.json            typechecks test/ and scripts/, which the build's tsconfig cannot see
.github/workflows/ci.yml      the gate on every pull request: lint, typecheck, tests, image build
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

### How the schema evolves

There is one way to change the schema and it has four steps: edit `src/db/schema.ts`, run
`npm run db:generate`, read the SQL drizzle-kit wrote into `drizzle/`, and commit both. Nothing else
creates or alters a table, and `npm run db:check` — a step in CI — fails if the schema and the
migrations stop agreeing.

Nothing is asked of the operator. `src/db/bootstrap.ts` runs `migrate()` at startup, under a
session-scoped advisory lock, with `drizzle/*.sql` baked into the image: upgrading is still
`docker compose up -d` and there is still no migration command to forget. An installation that
predates the migrations is adopted on its first start — its schema is already the baseline, so a row
is written to drizzle's journal saying so and nothing is applied.

Two things stay out of the generated SQL because they cannot be in it. The vector column's dimension
is a deployment setting (`vector(384)` vs `vector(1536)`), so `schema.ts` carries a constant 384 for
the migration to bake in and the bootstrap re-types the column to the configured dimension
afterwards, once, before any row exists — drizzle-kit diffs `schema.ts` against its own snapshot and
never against the live database, so a deployment at 1536 cannot be seen by it, let alone broken by it.
The HNSW index is the second: it needs a fixed dimension and blocks the re-typing while it exists, so
the bootstrap creates it after. The dimension is still recorded in `settings` and a mismatch still
fails fast with the remedy in the message.

What used to rest on review has a test: `test/integration/schema-equivalence.itest.ts` applies the
frozen DDL ladder to one database and the new bootstrap to another and compares the two schemas as
text, on every pull request, against a real server.

## Security notes

- An MCP endpoint is **open** by default — the historical behaviour — and can be closed per project with a
  bearer token; the mechanism and who may change it are in [MCP access](#mcp-access). Tokens are stored as hashes,
  shown once, scoped to one project, and revoking one closes that project's live MCP sessions rather than waiting
  for the next request.
- A token is a credential for the endpoint, not an account: it has no identity and no per-document rules, so a holder
  reads everything indexed in that project. A project left `open` is readable by anyone who can reach its URL,
  whatever the dashboard roles say.
- So an instance that leaves its projects open belongs on a private network, or behind a reverse proxy that handles
  auth — the endpoint itself is the only thing a project token closes.
- Browser `Origin` headers on `/mcp/*` are validated (DNS-rebinding protection) in both modes; CLI clients send none.
- Local source directories are confined to `ALLOWED_DOC_ROOTS`; `..`, symlinks that escape, and non-directories are rejected.
- Git and Notion tokens are encrypted at rest with `SECRET_KEY` (AES-256-GCM) and never returned by the API; credentials pasted into a repository URL are stripped before storage.
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
| A git source's row shows an authentication error | Check the token's scope, and on Bitbucket app passwords put your real username in the Username field. **Test connection** reports the remote's answer verbatim. |
| `Subdirectory "…" does not exist in the repository` | The path is relative to the repository root and is checked against the branch that was checked out. |
| A push webhook returns `401 invalid_signature` | The secret in the repository settings is not the one shown while editing the source — copy it again, or **Regenerate** and paste the new one. |
| `search_docs` says the project was indexed with another model | Re-index the project (it happens automatically on the next index run). |
| Every search answers *no good match* | `SEARCH_SCORE_FLOOR` is a cosine similarity measured against the default embedding model. If you changed `EMBEDDING_MODEL`, the startup log says so — re-measure the floor with `npm run eval` against your corpus, or set `SEARCH_SCORE_FLOOR=0`. |
| An agent is told *no good match* for something that **is** documented | The floor refused a question it should not have. The server logs every gated query at `info` with the score it saw; compare that against `SEARCH_SCORE_FLOOR` and lower it, or set it to `0`. |
| Answers got longer after upgrading | Each excerpt now carries the chunk either side of it. `SEARCH_NEIGHBOR_CONTEXT=0` restores the old shape, and `SEARCH_MAX_RESULT_CHARS` caps the whole answer. |
| `Could not load the sharp module` in the container | Regenerate `package-lock.json` on Linux or run `npm install --os=linux --cpu=x64 sharp` before building. |
| I missed the first-run setup code | Set `SETUP_CODE` in `.env` to something you choose and restart — it is read on every start until the first account exists. Or just restart and read the fresh code the server prints: `docker compose restart contextator && docker compose logs -f`. |
| I forgot my password | Any root or admin can reset it from **Users → Reset password**, which hands them a temporary one for you. |
| Nobody can sign in any more | `docker compose exec contextator npm run reset-password -- <username>` — the tool ships in the image and has to run there, because the container's PostgreSQL is published nowhere. From a source checkout the same command runs against `DATABASE_URL`. It prints a new temporary password and ends that account's sessions. With `ADMIN_TOKEN` set, `curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3444/api/users/<id>/password` does the same. |
| I cannot delete the last root account | By design — the server answers `409` and the dashboard disables the button. Promote somebody else to `root` first. |
| Sign-in says *too many attempts* | Rate limiting. Wait out `AUTH_LOGIN_WINDOW_MIN`, or raise `AUTH_LOGIN_MAX_ATTEMPTS`. |
| The dashboard bounces between `/` and `/login` | The cookie is not coming back. Usually `AUTH_COOKIE_SECURE=1` on a plain-HTTP origin, or a reverse proxy dropping `Set-Cookie`. Set `AUTH_COOKIE_SECURE=0` for an HTTP-only LAN install. |
| `403 csrf_blocked` from my own script | The script is sending the session cookie from another origin. Use `Authorization: Bearer $ADMIN_TOKEN` instead; bearer requests are exempt. |
| After upgrading, `/api/*` answers `401 setup_required` | This instance had no `ADMIN_TOKEN` and was therefore open. It is now closed: open `/setup` with the code from the log and create the first account. Projects, sources and indexes are untouched. |
| A member reads a project in `/mcp/…` they are not a member of | Expected while that project is `open`: dashboard roles do not reach the MCP endpoint. Require a token on it under **MCP access**. |
| An MCP client suddenly answers `401` | The project now requires a token. Mint one under **MCP access** and add `--header "Authorization: Bearer …"` (or `headers` in `mcp.json`). |
| I lost an MCP token | It cannot be recovered — only a hash is stored. Revoke it and mint another. |

## Contributing and security

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the whole of how this project is worked on: getting it running, the
four checks a change has to pass, the three places where one statement is kept in two files, and the commit
register. Read it before the first pull request — it also explains the licence grant an outside
contribution is asked for ([`CLA.md`](CLA.md), currently a draft), which exists because the commercial
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
