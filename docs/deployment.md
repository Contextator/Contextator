# Deployment topologies

Beyond the single container: an external PostgreSQL, Kubernetes, and one-click templates for Railway, Render and Fly.io. The single-container install is in the [README](../README.md#quick-start).

## Bringing your own PostgreSQL

The single container from the [Quick Start](../README.md#quick-start) is the default and most installations should stay on it: there is nothing
to provision, nothing to connect, and one thing to back up. Some installations already have a
PostgreSQL, though — a managed service, an HA pair, a server whose backups and monitoring somebody
else operates — and for those, **one line of `.env` moves the database out of the container**:

```bash
DATABASE_URL=postgres://user:password@db.example.com:5432/contextator
docker compose up -d
```

The container then starts no PostgreSQL of its own. It connects to that server, creates and migrates
its schema there at startup, and the `contextator-pgdata` volume stays empty. Nothing else changes —
same image, same command, same everything as in the Quick Start.

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

## Running on Kubernetes

For operators who already run Kubernetes rather than a single Docker host, `charts/contextator/` is a
Helm chart for the same `-slim` + external-database topology above — one Pod by design,
strict value validation, and no default `image.tag` (it must name a `slim` image):

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

## One-click templates (Railway, Render, Fly.io)

The files under `deploy/` set Contextator up on a hosted platform: the `-slim` image from Docker Hub, a
PostgreSQL 16 with pgvector, and one volume for `/data`. They are the hosted counterpart of
`docker-compose.slim.yml`, and they differ from it in one way that matters.

**Read this first: these templates publish the port to the internet.** The compose files publish it on
`127.0.0.1` ([ADR-0065](../.ssot/ADR.md#adr-0065)); a hosted platform gives the service a public URL, and
`HOST=0.0.0.0` inside the container is how it receives traffic there. What keeps the instance closed is
authentication, and the templates are built around it:

- **A project is token-protected from the moment it exists.** Nothing in any template changes that
  default, and there is no setting in them that opens a project. `test/deploy-templates.test.ts` fails if
  one ever does.
- **The first-run setup page needs a code** (`SETUP_CODE`), so whoever finds the URL before you do cannot
  create the first account. Render generates one; on Railway and Fly you set it (below). Without it the
  server generates a code and prints it once in the log, which is just as good, but is easy to miss on a
  platform that rotates logs.
- **`SECRET_KEY`** (32 characters or more) encrypts the credentials stored for git, Notion and Confluence
  sources. Generate it once, keep a copy outside the platform: losing it makes those credentials unreadable.
- If you do switch a project to *open* in the dashboard, the server says so in its log at the next start
  whenever it is listening on a non-loopback address — and on a hosted platform it always is. Open means
  anyone with the URL can read that project. Keep it token-protected.

### Behind the platform's proxy

Every template runs behind the platform's reverse proxy, and **none of them sets `TRUST_PROXY`**. That is
deliberate ([ADR-0060](https://contextator.com/en/docs/configuration/#running-behind-a-reverse-proxy)).
`TRUST_PROXY` is a list of the peers allowed to say where a request came from, and a template cannot know
the address of a platform's proxy, which differs per platform and can change. The one value that would have
needed no address, `1` ("trust every hop"), makes the client address the left-most `X-Forwarded-For` value, and
unless the platform replaces what a caller sends (which these templates do not assume) a caller writes that
value itself, picking a new rate-limit key on every request. Since 0.5.0 the server refuses to start with it
(ADR-0122). The templates
therefore keep the safe default, and set what does not depend on it: `AUTH_COOKIE_SECURE=1` (these platforms
are HTTPS only) and `PUBLIC_BASE_URL`, so published URLs do not read a header.

**The cost.** The server sees the platform's proxy as the client of every request, so everything that is
limited per address is limited for the whole instance at once (or, if the platform uses several proxy
addresses, for a small set of them). Concretely:

- **Sign-in and the first-run setup page share one budget** (`AUTH_LOGIN_MAX_ATTEMPTS` in
  `AUTH_LOGIN_WINDOW_MIN` minutes, 10 in 15 by default). `/api/setup` spends from it too.
- **Anyone who can reach the URL can hold that budget empty.** Ten requests every fifteen minutes keep password
  sign-in closed for everybody, and need no user name; on a brand-new instance the same requests can keep the
  owner from completing setup. The URL is a public `*.onrender.com` or `*.fly.dev` address.
- **A successful sign-in resets the shared budget**, so after a legitimate login the same caller has ten new
  attempts. The per-account lockout is unaffected.
- **OAuth client registration (60 an hour) and the metadata-document fetch limiter are instance-wide too**, so one
  caller can use up the hour's registrations for every connector. Bearer-token clients do not register and are
  not affected.
- **The audit log's `actor_ip` and the session's IP are the proxy's address**, which tells you nothing about who
  signed in.

What the shared key does keep is that a caller cannot choose its own key: a request that writes
`X-Forwarded-For` is still counted against the proxy's address. It does **not** mean nobody can guess faster than
the budget allows. Anyone with an account of their own can sign in successfully to reset the shared budget
whenever they like, so against *other* accounts what bounds guessing is the per-account lockout, not this
budget. If you would rather have per-client limits, the choice is yours: set `TRUST_PROXY` to the **address or
CIDR block of the platform's proxy** — check that range in the platform's own documentation, and name nothing
wider, because the list applies to every hop and a range that includes your clients lets them write their own
address again. `1` and `true` are not an alternative: the server refuses to start with either since 0.5.0, and
says what to write instead.

Two habits shrink the exposure on a hosted instance: **do not share the URL before the first account exists**,
and **do the first-run setup right after the deploy** (step 2 below). After the first forwarded request the log
says once that a forwarded header was ignored; that line is expected here.

Whichever platform you choose, finish with the same three steps, in this order:

1. Make sure `PUBLIC_BASE_URL` is set to the public URL (`https://...`; Render asks for it, Railway and Fly set it
   in the steps below). **Without it, OAuth connectors such as Claude are refused with `invalid_target`**, because the
   proxy is not trusted for the scheme and the server would build `http://` URLs for a client that sends
   `https://`. Clients that send a bearer token directly are not affected, which is what makes a missing value
   easy to miss.
2. Open the service URL, enter the setup code, and create the first account.
3. Create a project. Its MCP endpoint is `https://<your-url>/mcp/<project>`, it is born token-protected, and
   the creation dialog shows the project's first token **once**: copy it and give it to the client
   ([MCP access](mcp-access.md)). Until a client sends it, the endpoint answers `401`.

The first start downloads the embedding model (about 500 MB) into the volume and takes a few minutes; the
health check waits for it. Later starts reuse it. Backups are yours, as on any external-database topology:
the platform's database backups cover the database, and **the `/data` volume** — uploaded sources — needs its
own (see [Bringing your own PostgreSQL](#bringing-your-own-postgresql)).

These templates have not been run on the platforms by the project's CI; the checks in
`test/deploy-templates.test.ts` are structural. If a platform changed its file format since, the platform's
own validator will say so, and the fix is a pull request against the file.

### Railway

Files: `deploy/railway/railway.json` and `deploy/railway/Dockerfile` (a single `FROM` line that names the
published slim image).

1. In Railway, **New Project → Deploy from GitHub repo** and pick your fork of this repository (or, to avoid
   a fork, create an **Empty service** and set its **Source** to the Docker image
   `contextator/contextator:latest-slim`, then skip step 3).
2. In the service's **Settings → Config-as-code**, set the file path to `deploy/railway/railway.json`.
3. Add a database: **New → Database → PostgreSQL** using a template that includes **pgvector**. The stock
   PostgreSQL image has no pgvector, and the first start would fail on `CREATE EXTENSION vector`.
4. In the Contextator service's **Variables**, set:
   - `DATABASE_URL` = `${{<your database service>.DATABASE_URL}}`
   - `SECRET_KEY` = 32 or more random characters (`openssl rand -hex 32`)
   - `SETUP_CODE` = 8 or more random characters
   - `DATA_DIR` = `/data` and `MODEL_CACHE_DIR` = `/data/models`
   - `AUTH_COOKIE_SECURE` = `1`
   - `PUBLIC_BASE_URL` = the service's public URL, after step 6
5. In **Settings → Volumes**, attach a volume mounted at `/data`. Railway allows one volume per service, which is
   why the model cache lives under it.
6. In **Settings → Networking**, generate a domain, then set `PUBLIC_BASE_URL` (step 4) to it and deploy. Follow the three steps above.

### Render

File: `deploy/render/render.yaml` — a Blueprint with the web service, a disk at `/data` and a
PostgreSQL 16 database.

1. Fork this repository, or copy `deploy/render/render.yaml` into a repository of your own at the root as
   `render.yaml`. (Render reads a Blueprint from the repository root, or from a path you give it.)
2. In Render, **New → Blueprint**, pick that repository, and — if the file is not at the root — set the
   Blueprint path to `deploy/render/render.yaml`.
3. Render shows the resources it will create. `SECRET_KEY` and `SETUP_CODE` are generated; open the
   service's **Environment** tab afterwards to read `SETUP_CODE` and to keep a copy of `SECRET_KEY`.
   `PUBLIC_BASE_URL` is asked for; enter `https://<service>.onrender.com` (or your own domain).
4. **Apply**. The disk and a paid instance are required: the free tier has neither a disk nor enough memory
   for the embedding model. Then follow the three steps above.

### Fly.io

File: `deploy/fly/fly.toml`. It needs [`flyctl`](https://fly.io/docs/flyctl/) and an external PostgreSQL 16 with
pgvector, which Fly's own managed Postgres offering provides when you pick a version and extension that
supports it; any reachable server meeting
[the requirements above](#bringing-your-own-postgresql) works.

```bash
cp deploy/fly/fly.toml fly.toml
fly apps create <your-app-name>          # and put the same name in `app = "..."` in fly.toml
fly volumes create contextator_data --size 5 --region <region>
fly secrets set \
  DATABASE_URL='postgres://user:password@host:5432/contextator' \
  SECRET_KEY="$(openssl rand -hex 32)" \
  SETUP_CODE="$(openssl rand -hex 8)" \
  PUBLIC_BASE_URL='https://<your-app-name>.fly.dev'
fly deploy
```

Print the setup code you generated before you close the shell (`echo` it, or set it from a value you
already have), because secrets are write-only on Fly. The machine has 2 GB of memory; the embedding model
does not fit in less. The volume belongs to one region and one machine, which matches the one-instance
design: do not scale the app out.
