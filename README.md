# Contextator

Self-hosted MCP server that turns your documentation into one semantically searchable endpoint per project.

[![Designed & Maintained with Tan](https://muhammetsafak.com/badges/designed-maintained-with-tan.svg)](https://muhammetsafak.com/tan/)

Give a project its document sources — mounted folders, git repositories, uploaded archives, a Notion
workspace, a Confluence Cloud site or Data Center instance, a published documentation site — and it becomes
its own [Model Context Protocol](https://modelcontextprotocol.io) endpoint that AI agents (Cursor, Claude Code,
Claude Desktop, …) can search:

```text
http://localhost:3444/mcp/<project-name>
```

It ships as **one Docker container**, published as `contextator/contextator`, that holds both the database and
the app, and is free software under the **AGPL-3.0-or-later** with a commercial license available
([License](#license)).

## Features

- **One URL per project, fully isolated.** Each project has its own document collection and vector embeddings
  in PostgreSQL + [pgvector](https://github.com/pgvector/pgvector). A client connected to `/mcp/billing` never
  sees `/mcp/mobile`.
- **Many sources per project.** A local directory, a git repository (or one subdirectory of it), an upload of
  files/folders/`.zip`/`.tar.gz`/`.rar`, a Notion workspace, a Confluence Cloud site or Data Center instance,
  or a published documentation site read from its `sitemap.xml`, combined into one searchable endpoint. See
  [Document sources](docs/document-sources.md).
- **100 % local by default.** Embeddings are generated on the CPU with
  [transformers.js](https://huggingface.co/docs/transformers.js) (`Xenova/multilingual-e5-small`, a retrieval
  model covering 100 languages incl. Turkish). Switch to OpenAI embeddings with two env vars.
- **Admin dashboard** at `http://localhost:3444/` to manage projects and their sources — add a repository,
  drop a folder or an archive on the page, test a connection, trigger re-indexing and watch progress.
- **Accounts and roles.** People sign in with their own account. `root` and `admin` manage everything and
  everyone; a `member` sees only the projects it is assigned to, as a read-only `viewer` or an `editor` that
  adds sources, uploads files and re-indexes. Any account can mint its own named, scoped, revocable **API
  token** for a script or CI job; `ADMIN_TOKEN` still works too. See
  [Accounts and permissions](docs/accounts-and-permissions.md).
- **A door on each MCP endpoint, with three settings.** A new project requires a **bearer token** that your
  client sends as an ordinary header, and is handed its first one as it is created, shown once. Make it
  **open** if its documents should be readable by anyone who can reach the URL, or require an **account** and
  its access becomes the memberships you already manage. Browser-based connectors sign in through OAuth 2.1.
  See [MCP access](docs/mcp-access.md).
- **Incremental indexing.** Files are hashed; only changed files are re-embedded, removed files are deleted.
- **More than Markdown.** `.html`, `.docx`, `.csv`, `.pdf`, `.pptx`, `.xlsx`, `.ipynb`, `.rst` and `.adoc`/`.asciidoc` are converted to Markdown as they
  are indexed, so an agent reads a Word file or a PDF the way it reads a page of documentation. See
  [File types](docs/file-types.md).

## Quick Start

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
[Running behind a reverse proxy](docs/configuration.md#running-behind-a-reverse-proxy).

1. **Create the first account.** Open **http://localhost:3444/setup**, enter the `SETUP_CODE` you chose, and create
   the `root` account. The code exists so that nobody who reaches the server before you can claim it; it stops working
   the moment that account is created.

   Left `SETUP_CODE` empty? The server generates one and prints it at every start until an account exists — it is in
   the log you are already tailing:

   ```text
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
5. Use the **Connect an agent** tabs (Claude Code, Cursor, Claude Desktop, and the deprecated legacy SSE) for copy-paste snippets. From
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

**Tags.** `latest` is the newest stable release; `0.4` tracks the latest patch inside the `0.4.x`
line; `0.4.2` is one exact, immutable release. Pin a versioned tag for anything you upgrade
deliberately by setting `CONTEXTATOR_TAG` in `.env` (e.g. `CONTEXTATOR_TAG=0.4.2`) and running
`docker compose up -d` — this reads at every start, not only the first. Every one of those tags from
`0.2.0` on has a `-slim` twin — `latest-slim`, `0.4-slim`, `0.4.2-slim` — which is described in [Bringing your
own PostgreSQL](docs/deployment.md#bringing-your-own-postgresql).

## Usage

Point Claude Code, Cursor, Claude Desktop or any other MCP client at `http://localhost:3444/mcp/<project>` —
the dashboard's **Connect** panel prints the exact snippet, token header included when the project requires
one. For a project that requires a token:

```bash
claude mcp add --transport http demo-docs http://localhost:3444/mcp/demo   --header "Authorization: Bearer ctxm_9f3a…"
```

Three read-only tools are exposed: `search_docs` (hybrid search, ranked excerpts), `list_topics` (the indexed
document list) and `read_document` (one file's Markdown, by path or heading range). Beside the tools, each
project publishes its documents as MCP resources and two read-only **prompts**, `answer_from_docs` (argument
`question`) and `explore_topic` (argument `topic`).

**One URL, Streamable HTTP first.** Streamable HTTP is the way to connect. The legacy HTTP+SSE transport is
**deprecated**: it still answers on the same URL and keeps working, no removal date is set, and its responses
carry a `Deprecation: true` header. The same URL also speaks the stateless MCP **2026-07-28** protocol beside
2025-11-25.

A project is a set of **sources** — a local directory, a git repository, an upload, a Notion workspace, a
Confluence site or a documentation site — each added in the dashboard under its own name, so a file
`install.md` in a source named `handbook` is searched and read as `handbook/install.md`. An agent can narrow
a search to one release with `search_docs(query: "rotate the signing key", version: "v3")`.

Everything else — the protocol eras, the source types, access modes and file types — is in
[Connecting AI clients](docs/connecting-ai-clients.md), [Document sources](docs/document-sources.md),
[MCP access](docs/mcp-access.md) and [File types](docs/file-types.md).

## How It Works

Stack: TypeScript · Node.js 22+ · Fastify 5 · PostgreSQL 16 + pgvector · Drizzle ORM · `@modelcontextprotocol/server` (MCP TypeScript SDK 2.x) · `@huggingface/transformers` · `unpdf` / `mammoth` / `turndown`.

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
| `DATABASE_URL` | – | Empty uses the embedded PostgreSQL; set it to bring your own — see [Bringing your own PostgreSQL](docs/deployment.md#bringing-your-own-postgresql) |
| `ALLOWED_DOC_ROOTS` | `/docs` | Comma-separated. Project directories **must** live inside one of these |
| `SECRET_KEY` | – | At least 32 characters. Encrypts git/Notion/Confluence tokens and webhook secrets at rest |
| `ADMIN_TOKEN` | – | Machine access to `/api/*` with root permissions |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | `local` / `Xenova/multilingual-e5-small` | See [Changing the embedding model](docs/configuration.md#changing-the-embedding-model) |
| `PUBLIC_BASE_URL` / `TRUST_PROXY` | – / `0` | Required together behind a reverse proxy — see [Running behind a reverse proxy](docs/configuration.md#running-behind-a-reverse-proxy) |
| `OIDC_ISSUER_URL` | – | On/off switch for federated sign-in — see [Single Sign-On](https://contextator.com/en/docs/sso/) |

The full table — every storage, upload, chunking, search-ranking, sync, auth and observability variable,
each with its reasoning — is on [Configuration](https://contextator.com/en/docs/configuration/).

## Deployment

The single container from the [Quick Start](#quick-start) is the default, and most installations should stay
on it. Two other topologies exist:

- **Your own PostgreSQL.** One line of `.env` moves the database out of the container:

  ```bash
  DATABASE_URL=postgres://user:password@db.example.com:5432/contextator
  ```

  It needs **PostgreSQL 16 or newer** with pgvector, and backups become yours. The `-slim` image carries no
  database at all. See [Bringing your own PostgreSQL](docs/deployment.md#bringing-your-own-postgresql).
- **Kubernetes.** `charts/contextator/` is a Helm chart for the `-slim` + external-database topology. See
  [Running on Kubernetes](docs/deployment.md#running-on-kubernetes).

Behind a reverse proxy, three settings have to move together:
[Running behind a reverse proxy](docs/configuration.md#running-behind-a-reverse-proxy). Where your data goes,
and what leaves the machine, is on [Where your data goes](docs/where-your-data-goes.md).


### Data and persistence

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

**On an installation that set `DATABASE_URL`** ([Bringing your own PostgreSQL](docs/deployment.md#bringing-your-own-postgresql))
the database is a server this image does not operate. `npm run backup` and `npm run restore` still
work: they reach that server through `DATABASE_URL`, because the upload trees in the archive are in no
other backup — and `backup` says, in its output and in the archive's manifest, that the server's own
backup regime is the one that matters. Run them from the default image: the `-slim` image has no
`pg_dump` and stops, saying it is not on the `PATH` (refusal `no_pg_tools`). The default image's client is PostgreSQL **16**, so against a
17+ server `pg_dump` stops with `server version mismatch` (and `pg_restore` 16 cannot read a 17 dump):
install `postgresql-client-<major>` for the server's major version in the container and put
`/usr/lib/postgresql/<major>/bin` first on `PATH` — the Helm chart's
[Taking a backup](charts/contextator/README.md#taking-a-backup) shows how. What does **not** apply
on that topology is everything about the embedded cluster: the three by-hand commands further down (`psql`, `pg_dump`, `pg_restore` as user
`contextator`) reach nothing, and the `pgdata` volume is empty. The two bullets below about what a
dump does *not* contain apply on both topologies, and so does the paragraph about `/data`.

**Scheduled backups for the external database.** Add the optional sidecar to the slim stack:

```bash
docker compose -f docker-compose.slim.yml -f docker-compose.backup.yml up -d
docker compose -f docker-compose.slim.yml -f docker-compose.backup.yml logs -f backup
```

The sidecar waits for the app to be healthy, runs `npm run backup`, then waits `BACKUP_INTERVAL_SECONDS` (default
`86400`, one day) after each attempt. A sleep loop keeps this optional recipe independent of a cron
daemon; it measures intervals after a run finishes, rather than promising a wall-clock execution time.
Set `BACKUP_INTERVAL_SECONDS` and `BACKUP_KEEP` in `.env` to change the interval and retention; both
must be positive integers. The default retention is **7** completed archives. Failed backups retain
every existing archive and are retried after the interval. Invalid settings stop after at most three
container restarts; correct `.env` and run `up -d backup` to start again.

It uses the **default, non-slim image** for its PostgreSQL tools, overrides that image's entrypoint,
runs as UID/GID `1000:1000` to match the slim app (with `HOME=/tmp` for npm), and mounts only the same `data` volume at `/data`. It never starts an embedded PostgreSQL or mounts
`pgdata`. Its `.env` is the app's `.env`, including `DATABASE_URL` and `SECRET_KEY`, so the archive
records the fingerprint of the app's `SECRET_KEY` and a restore with that key passes the key check.
The PostgreSQL client major version must be at least the server's major version.

Archives are in `/data/backups/`, written as `.partial` files and renamed only after a successful
backup, so interrupted writes do not count toward retention. On stop, the sidecar terminates the
backup process group with TERM followed by KILL after one second and removes its partial archive and private staging files. After a forced kill,
the next iteration removes stale scheduled `.partial` archives and staging files under
`/data/.scheduled-backup-staging`. Run only one
backup sidecar per data volume. Retention applies only to the default
timestamped
`contextator-backup-<timestamp>.tar.gz` filenames; custom-named archives are left alone. Copy backups
off the host too: sharing the app's data volume does not protect against losing that volume.

An on-demand backup also runs from the default image, because the slim app container has no
`pg_dump`. Reuse the `backup` service definition, but replace its loop and clear
`BACKUP_STAGING_DIR`, so the backup stages under `/data/.backup-*`, which the sidecar's cleanup
never touches. Give the archive a name of your own, so retention does not count it:

```bash
docker compose -f docker-compose.slim.yml -f docker-compose.backup.yml run --rm --no-deps \
  -e BACKUP_STAGING_DIR= --entrypoint npm backup \
  run backup -- /data/backups/contextator-manual-$(date +%F).tar.gz
```

To restore an archive into a fresh installation, use the `npm run restore -- <file> --check` and
`npm run restore -- <file>` procedure below, but run both commands the same way as the on-demand
backup above (`run --rm --no-deps -e BACKUP_STAGING_DIR= --entrypoint npm backup run restore -- …`),
not with `docker exec` in the slim app container, and restart the app with
`docker compose -f docker-compose.slim.yml restart contextator`. Stop the backup sidecar while
restoring so it does not take an archive of the restore in progress:

```bash
docker compose -f docker-compose.slim.yml -f docker-compose.backup.yml stop backup
```

Start it again with `up -d backup` after the restore is complete.

The embedded PostgreSQL listens on `127.0.0.1` inside the container only and is not published, so
everything here goes through the container.

**One command takes the backup, because a `pg_dump` is not the installation:**

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

Run `npm run backup` with no path at all and it writes `<DATA_DIR>/backups/contextator-backup-<timestamp>.tar.gz`
— on the data volume, never in the container's working directory, which is an image layer.

**To an S3-compatible bucket.** Set `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID` and
`BACKUP_S3_SECRET_ACCESS_KEY` (optionally `BACKUP_S3_ENDPOINT` for MinIO, Ceph or R2, `BACKUP_S3_REGION`,
`BACKUP_S3_PREFIX`, `BACKUP_S3_SESSION_TOKEN`) and add `--s3`; the archive is built in the staging
directory, uploaded (multipart above 16 MiB) and removed locally, and only the newest `BACKUP_KEEP`
(default 7) timestamped archives under the prefix are kept:

```sh
docker exec contextator npm run backup -- --s3
docker exec contextator npm run restore -- --s3 latest --check
docker exec contextator npm run restore -- --s3 latest
docker compose restart contextator
```

`latest` is the newest timestamped archive; a name restores that one. Requests are path-style and signed
with SigV4 by the script itself, so no extra package is installed. Nothing in the server schedules this:
on Kubernetes the chart renders an optional CronJob
([Scheduled backup to S3](charts/contextator/README.md#scheduled-backup-to-s3)), elsewhere use cron or your
orchestrator. `restore --check` with `--s3` downloads the archive to the data volume first and deletes
the copy afterwards.

**These blocks are the only copy of this procedure.** The wiki and the documentation site
carry no commands for it and point here. `restore` overwrites a live database,
so a command is changed **here** and nowhere else. `test/readme-mirrors.test.ts` fails if a copy that
declares itself a mirror (a `MIRRORED-IN` / `MIRRORED-FROM` marker) appears; it cannot see an unmarked
copy in another repository, and review is what catches that.

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

That key is rotatable — a four-step runbook (`npm run rotate-secret` is step 3) — which gives the paragraph
above a second edge: **retiring the old key — removing
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
[Security → Rotating things](https://contextator.com/en/docs/security/#rotating-things).

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

## Upgrading

An ordinary image upgrade is a `docker compose pull`; it moves the application and not the cluster. The one
upgrade that needs a procedure is a PostgreSQL major-version change.

### Upgrading PostgreSQL across a major version

**An ordinary image upgrade never does this.** `docker compose pull` moves the application; it does not
move the cluster, because the cluster is a volume and the image's PostgreSQL major version is what can
read it. The day a release moves from PostgreSQL 16 to 17 is the day this applies, and it applies
**before** the pull, not after.

What happens if you just pull:

```text
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

**This section is the only copy of this procedure.** It is written here, beside the code that
implements `backup` and `restore` and versioned with it, because a procedure that deletes a cluster has
to have exactly one copy that decides what it says. The wiki and the documentation site point here and
do not repeat the commands.

## Documentation

- [Document sources](docs/document-sources.md) — source types, versions, sync, webhooks
- [Accounts and permissions](docs/accounts-and-permissions.md)
- [MCP access](docs/mcp-access.md) — open, token required, account required; OAuth for browser clients
- [Connecting AI clients](docs/connecting-ai-clients.md)
- [File types](docs/file-types.md)
- [Configuration](docs/configuration.md) — reverse proxy, embedding with a server of your own, changing the model
- [Deployment topologies](docs/deployment.md) — external PostgreSQL, Kubernetes
- [Admin API](docs/admin-api.md) and scaling signals
- [Where your data goes](docs/where-your-data-goes.md), [Security notes](docs/security-notes.md), [Troubleshooting](docs/troubleshooting.md), [License](docs/license.md)
- The full guides are on [contextator.com](https://contextator.com/en/docs/), and installing from source is on the [wiki](https://github.com/Contextator/Contextator/wiki/Installation#build-the-image-yourself).

## Project Status

**Beta.** Contextator is at `0.4.x`; it is not yet stable. Before `1.0.0` a minor version may change a public
contract — the HTTP and MCP APIs, the MCP tool names and their parameters, environment variable names — without
a major bump. Breaking changes are listed in [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) is the whole of how this project is worked on:
getting it running, the four checks a change has to pass, the three places where one statement is kept in two
files, and the commit register. It also explains the licence grant an outside contribution is asked for
([`CLA.md`](CLA.md), signed on the pull request), which exists because the commercial license below depends on
the copyright being held in full. [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) is the Contributor Covenant, and it
applies here.

## Security

**Found a security problem? Do not open an issue.** [`SECURITY.md`](SECURITY.md) says where it goes instead,
and lists the things that look like vulnerabilities and are documented behaviour — a project left `open`, and
what an MCP token does and does not grant. What the defaults guarantee is
in [Security notes](docs/security-notes.md).

## License

Licensed under the [GNU Affero General Public License, version 3 or later](LICENSE) (`AGPL-3.0-or-later`).
If you modify Contextator and let people reach your modified version over a network, you owe those users its
complete source; running the unmodified software triggers nothing. The copyright is held in full by Muhammet
Şafak, so a separate **commercial license** can be granted where the AGPL does not fit — ask at
[tunedness.com](https://tunedness.com). The full explanation is in [docs/license.md](docs/license.md).
