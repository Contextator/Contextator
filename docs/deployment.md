# Deployment topologies

Beyond the single container: an external PostgreSQL, and Kubernetes. The single-container install is in the [README](../README.md#quick-start).

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
