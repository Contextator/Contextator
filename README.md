# Contextator

**Self-hosted, multi-tenant MCP documentation server.** Point it at folders of Markdown/MDX
files, and every folder becomes its own [Model Context Protocol](https://modelcontextprotocol.io)
endpoint that AI agents (Cursor, Claude Code, Claude Desktop, …) can search semantically:

```
http://localhost:3444/mcp/<project-name>
```

- **One URL per project, fully isolated.** Each project has its own document collection and
  vector embeddings in PostgreSQL + [pgvector](https://github.com/pgvector/pgvector). A client
  connected to `/mcp/billing` never sees `/mcp/mobile`.
- **100 % local by default.** Embeddings are generated on the CPU with
  [transformers.js](https://huggingface.co/docs/transformers.js) (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`,
  50+ languages incl. Turkish). Switch to OpenAI embeddings with two env vars.
- **Both MCP transports on the same URL.** Streamable HTTP for current clients, legacy HTTP+SSE for older ones.
- **Admin dashboard** at `http://localhost:3444/` to create/delete projects, trigger re-indexing and watch progress.
- **Incremental indexing.** Files are hashed; only changed files are re-embedded, removed files are deleted.

Stack: TypeScript · Node.js 20+ · Fastify 5 · PostgreSQL 16 + pgvector · Drizzle ORM · `@modelcontextprotocol/sdk` · `@huggingface/transformers`.
Ships as **one Docker container** (`contextator`) that holds both the database and the app.

---

## Quick start (Docker)

Everything runs in a single container named `contextator`: PostgreSQL 16 + pgvector and the Node.js
app, started and stopped together by a small entrypoint script. Data lives in Docker volumes and
survives container removal (see [Data and persistence](#data-and-persistence)).

```bash
git clone <this repo> contextator && cd contextator
cp .env.example .env
# optional: DOCS_HOST_PATH=/path/to/your/docs  (defaults to ./docs, which contains a demo)
docker compose up -d
docker compose logs -f            # wait for "embedding model ready"
```

1. Open **http://localhost:3444/**.
2. Press **New project** (or `n`): name `demo`, directory `/docs/demo` (the host folder from `DOCS_HOST_PATH` is mounted at `/docs`).
3. Watch the project's status go `indexing → idle` in the list; the detail panel shows documents, chunks, the last index run and any error.
4. Use the **Connect an agent** tabs (Claude Code, Cursor, Claude Desktop, legacy SSE) for copy-paste snippets, or run the bundled smoke test:

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
  -v /path/to/your/docs:/docs:ro \
  contextator
```

## Data and persistence

| What | Path in the container | Default volume | Override (`.env`) |
|------|-----------------------|----------------|-------------------|
| PostgreSQL cluster: projects, documents, embeddings | `/var/lib/postgresql/data` | `contextator-pgdata` | `CONTEXTATOR_PGDATA_VOLUME` (another volume name) or `CONTEXTATOR_PGDATA_PATH` (absolute host directory) |
| Downloaded embedding models | `/app/.cache/models` | `contextator-models` | `CONTEXTATOR_MODELS_VOLUME` or `CONTEXTATOR_MODELS_PATH` |
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

### Tools exposed to the agent

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `search_docs` | `query: string`, `limit?: 1-20` (default 5) | Cosine-similarity search over the project's chunks. Returns ranked excerpts with file path, heading breadcrumb (`Guide > Install > Docker`) and score. |
| `list_topics` | – | Every indexed document grouped by directory, with title and chunk count. |
| `read_document` | `path: string` | Full Markdown of one indexed file (path as shown by the other tools). Only indexed paths are served; capped at 512 KB. |

The server also sends MCP `instructions` describing the project so agents know when to use which tool.

## How indexing works

1. The project directory is walked for `.md`/`.mdx` files (dotfiles, `node_modules`, `dist`, `build`, symlinks and `IGNORE_GLOBS` are skipped).
2. Every file is hashed (sha256). Unchanged files are skipped, changed/new files are re-chunked and re-embedded, files that disappeared are deleted. **Force** re-index wipes the project first. Every finished run (mode, counts, duration, error) is stored in `index_runs`; the last 20 per project are kept and shown in the dashboard.
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
| `IGNORE_GLOBS` | – | e.g. `**/CHANGELOG.md,drafts/**` |
| `EMBEDDING_PROVIDER` | `local` | `local` or `openai` |
| `EMBEDDING_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Any transformers.js feature-extraction model. English-only & faster: `Xenova/all-MiniLM-L6-v2` (also 384-d) |
| `EMBEDDING_DIMENSIONS` | `384` | Must match the model. `1536` for `text-embedding-3-small` |
| `EMBEDDING_DTYPE` | `fp32` | `q8` downloads a ~4× smaller quantized model |
| `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` | – / `text-embedding-3-small` | Used when the provider is `openai` |
| `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `400` / `50` | |
| `ADMIN_TOKEN` | – | When set, `/api/*` requires `Authorization: Bearer …`; the dashboard asks for it once |
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

All endpoints return JSON. With `ADMIN_TOKEN` set, send `Authorization: Bearer <token>` (health is exempt).

| Method & path | Description |
|---------------|-------------|
| `GET /api/health` | DB status, embedding provider/model/dtype/readiness, open MCP sessions, version |
| `GET /api/projects` | Projects with counts, `mcpUrl` and the live indexing `job` (phase, files done/total/skipped/removed, chunks; for queued jobs `queue.aheadProjectName`) |
| `POST /api/projects` `{ name, rootPath, index?: true }` | Create a project; `400` invalid name/path, `409` duplicate |
| `POST /api/projects/:id/reindex?force=true` | Queue (incremental or full) re-index → `202 { job }` |
| `GET /api/projects/:id/status` | Project row + live job |
| `GET /api/projects/:id/runs` | The project's last 20 index runs (mode, counts, duration, error), newest first |
| `DELETE /api/projects/:id` | Delete project, its chunks and open MCP sessions (`409` while indexing) |

## Local development (without Docker for the app)

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL + pgvector only, on localhost:5432
cp .env.example .env
# ALLOWED_DOC_ROOTS=C:/Users/me/docs     (Windows)  or  /home/me/docs
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
src/db/schema.ts              Drizzle schema (projects, documents, chunks, settings)
src/db/ensure-schema.ts       idempotent DDL applied at startup (extension, tables, HNSW index, dimension guard)
src/services/chunker.ts       Markdown/MDX-aware chunking with heading breadcrumbs
src/services/fs-scan.ts       safe directory walking + path-escape checks
src/services/embeddings/      provider interface, local (transformers.js) and OpenAI implementations
src/services/indexer.ts       incremental background indexing queue
src/services/vector-store.ts  pgvector cosine search and chunk persistence
src/mcp/router.ts             /mcp/:project — Streamable HTTP + legacy SSE on one URL
src/mcp/tools.ts              search_docs, list_topics, read_document
src/mcp/sessions.ts           per-connection McpServer/transport registry + idle reaper
src/admin/routes.ts           REST API for the dashboard
public/                       vanilla HTML/JS dashboard (no build step)
scripts/smoke-mcp.ts          end-to-end MCP client check
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
typed queries and Drizzle Studio.

## Security notes

- The MCP endpoints are **unauthenticated by design** (MCP clients have no standard way to pass a token yet).
  Bind the server to a private network, or put it behind a reverse proxy that handles auth.
- Project directories are confined to `ALLOWED_DOC_ROOTS`; `..`, symlinks that escape, and non-directories are rejected.
- `read_document` only serves files that were indexed for that project, never arbitrary paths.
- Set `ADMIN_TOKEN` whenever the dashboard is reachable by anyone but you.
- Browser `Origin` headers on `/mcp/*` are validated (DNS-rebinding protection); CLI clients send none.
- The embedded PostgreSQL is reachable only from inside the container (`listen_addresses=127.0.0.1`, no published port).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `The database was created with EMBEDDING_DIMENSIONS=… but the current config says …` | Match the value, or start once with `RESET_VECTORS=1` and re-index everything. |
| Dashboard shows `model loading` for a long time | First run downloads ~470 MB; check `docker compose logs -f`. Air-gapped hosts: pre-populate the `contextator-models` volume and set `EMBEDDING_OFFLINE=1`. |
| Container keeps restarting, logs say `PostgreSQL exited during startup` | The PostgreSQL output above that line tells why: usually a data directory from another PostgreSQL major version, or a bind-mounted `CONTEXTATOR_PGDATA_PATH` with wrong permissions. |
| `Directory is outside the allowed document roots` | Use a path under `ALLOWED_DOC_ROOTS` (`/docs/...` inside Docker). |
| `search_docs` says the project was indexed with another model | Re-index the project (it happens automatically on the next index run). |
| `Could not load the sharp module` in the container | Regenerate `package-lock.json` on Linux or run `npm install --os=linux --cpu=x64 sharp` before building. |

## License

MIT
