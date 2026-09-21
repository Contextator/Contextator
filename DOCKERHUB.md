# Contextator

**Self-hosted, multi-tenant MCP documentation server.** Give a project its document sources —
mounted folders, git repositories, uploaded archives, a Notion workspace, a Confluence Cloud site —
and it becomes its own [Model Context Protocol](https://modelcontextprotocol.io) endpoint that AI
agents (Cursor, Claude Code, Claude Desktop, …) can search semantically at
`http://localhost:3444/mcp/<project-name>`.

- **One URL per project, fully isolated.** Each project has its own document collection and vector
  embeddings; a client connected to `/mcp/billing` never sees `/mcp/mobile`.
- **Many sources per project.** Local directories, git repositories, uploaded files/archives, a
  Notion workspace or a Confluence Cloud site — combined into one searchable endpoint.
- **100 % local by default.** Embeddings are generated on the CPU with transformers.js. Switch to
  OpenAI embeddings with two environment variables.
- **Admin dashboard** to manage projects and sources, and **accounts with roles** — `root`, `admin`,
  and a per-project `member` that is a read-only `viewer` or a source-managing `editor`.
- **Incremental indexing.** Files are hashed; only changed files are re-embedded, removed files are
  deleted.
- **More than Markdown.** `.html`, `.docx`, `.csv` and `.pdf` are converted to Markdown as they are
  indexed.

This image (`contextator/contextator`) is the whole product in **one container**: PostgreSQL 16 +
pgvector and the Node.js app, started and stopped together by a small entrypoint script. There is
nothing else to run.

Full documentation, configuration reference and source:
[github.com/Contextator/Contextator](https://github.com/Contextator/Contextator).

## Quick start

```bash
docker run -d --name contextator -p 127.0.0.1:3444:3444 \
  -e SETUP_CODE=whatever-you-like \
  -v contextator-pgdata:/var/lib/postgresql/data \
  -v contextator-models:/app/.cache/models \
  -v contextator-data:/data \
  -v /path/to/your/docs:/docs:ro \
  contextator/contextator
docker logs -f contextator   # wait for "embedding model ready"
```

Or with Compose — no need to clone the whole repository, just its compose file and its annotated
environment template:

```bash
mkdir contextator && cd contextator
curl -fsSLO https://raw.githubusercontent.com/Contextator/Contextator/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/Contextator/Contextator/main/.env.example
cp .env.example .env
docker compose up -d
```

**The port is published on `127.0.0.1` only** — with Compose and in the `docker run` above — so a
default installation answers on the machine it runs on and nowhere else. To publish it on the
network deliberately, set `CONTEXTATOR_BIND=0.0.0.0` in `.env` (Compose) or drop the `127.0.0.1:`
from `-p`, and put a TLS-terminating reverse proxy or a VPN in front of it.

**A new project's MCP endpoint requires a token.** Creating a project mints its first one and shows
it once; make the endpoint **open** from the project page if its documents should be readable by
anyone who can reach the URL.

Full walkthrough — what to set in `.env` before the first start, and what each line of that command
does: [wiki/Installation](https://github.com/Contextator/Contextator/wiki/Installation).

**Create the first account.** Open `http://localhost:3444/setup` and enter the `SETUP_CODE` — set
with `-e SETUP_CODE=...` in the `docker run` command above, or as a line in `.env` for Compose. The
code exists so nobody who reaches the server before you can claim it, and it stops working the
moment that first account is created. Left unset either way, a new code is generated and printed to
the container log on every start until that first account exists — copying one from an earlier
start's log will not work.

## Tags

| Tag | Meaning |
|-----|---------|
| `latest` | The most recent stable release. Never points at a pre-release (`-rc.*`, `-beta.*`, …). |
| `0.1` | The latest patch release inside the `0.1.x` minor line. Moves as `0.1.x` releases ship. |
| `0.1.0` | One exact release. Immutable — always the same image. |

Pin `0.1.0`-style tags for anything you upgrade deliberately; use `latest` only where an unattended
minor/patch bump is acceptable.

## Volumes

| Path in the container | Holds | Re-downloadable / re-creatable? |
|---|---|---|
| `/var/lib/postgresql/data` | Projects, documents and vector embeddings — the PostgreSQL cluster | **No.** This is the only copy of your indexed content and accounts. |
| `/app/.cache/models` | The downloaded embedding model | Yes — deleting it just re-downloads the model (~90–470 MB) on next start. |
| `/data` | Materialised sources: uploaded files, git checkouts, Notion pulls | Partially. Git checkouts and Notion pulls are re-pullable; **an uploaded source's content is not stored anywhere else.** |
| `/docs` | Your documentation, mounted **read-only** from the host | Not owned by the container at all — it is your own directory. |

Removing the container (`docker rm`) keeps all volumes; only an explicit `docker volume rm` (or
`docker compose down -v`) deletes them.

## Common environment variables

The full annotated list lives in
[`.env.example`](https://github.com/Contextator/Contextator/blob/main/.env.example); these are the
ones most installs touch first.

| Variable | Default | What it does |
|---|---|---|
| `SETUP_CODE` | – (generated and logged) | The code `/setup` asks for once, to claim the first `root` account. |
| `POSTGRES_PASSWORD` | `contextator` | Password of the embedded PostgreSQL, applied when the cluster is first created. |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Any transformers.js feature-extraction model; changing it re-indexes every project. |
| `EMBEDDING_DTYPE` | `fp32` | `fp16` or `q8` shrink the model download; the default model publishes all three. |
| `PUBLIC_BASE_URL` | – | e.g. `https://docs.example.com`. Required once a reverse proxy sits in front of this container. |
| `AUTH_COOKIE_SECURE` | `auto` | Set `1` behind HTTPS, `0` for a plain-HTTP LAN install, or the browser drops the session cookie. |

Every variable, including search tuning, upload limits, the audit log and running behind a reverse
proxy: [wiki/Configuration](https://github.com/Contextator/Contextator/wiki/Configuration).

## License

Free software under the **AGPL-3.0-or-later**
([`LICENSE`](https://github.com/Contextator/Contextator/blob/main/LICENSE), also served by every
running instance at `/license.txt`), with a **commercial license** available where the AGPL's
source-disclosure obligations do not fit — ask at [tunedness.com](https://tunedness.com).

Running the unmodified image, for yourself or your company, triggers no obligation at all. The one
obligation the AGPL adds over the GPL is section 13: modify Contextator and let people reach your
modified version over a network, and you owe those users its complete source, under the same
license.

## More

- Something not starting, not indexing, or not answering the way you expect:
  [wiki/Troubleshooting](https://github.com/Contextator/Contextator/wiki/Troubleshooting) and
  [wiki/FAQ](https://github.com/Contextator/Contextator/wiki/FAQ).
- What shipped in this tag and every one before it:
  [CHANGELOG.md](https://github.com/Contextator/Contextator/blob/main/CHANGELOG.md).
- Full README, source, issues and discussions:
  [github.com/Contextator/Contextator](https://github.com/Contextator/Contextator).
