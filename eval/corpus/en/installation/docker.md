# Installing with Docker Compose

The published image is `ghcr.io/halyard/halyard`. It contains the server and `halyardctl`; it does not
contain PostgreSQL, because an event store that disappears with the container is not an event store.

## A complete compose file

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: halyard
      POSTGRES_PASSWORD: halyard
      POSTGRES_DB: halyard
    volumes:
      - halyard-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U halyard"]
      interval: 5s
      retries: 20

  halyard:
    image: ghcr.io/halyard/halyard:2.7.0
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      HALYARD_DATABASE_URL: postgres://halyard:halyard@postgres:5432/halyard?sslmode=disable
      HALYARD_SIGNING_SECRET: ${HALYARD_SIGNING_SECRET:?set this}
      HALYARD_LISTEN_ADDR: 0.0.0.0:8480
      HALYARD_METRICS_ADDR: 0.0.0.0:9480
    ports:
      - "8480:8480"
    volumes:
      - halyard-data:/var/lib/halyard

volumes:
  halyard-db:
  halyard-data:
```

Pin the image to an exact version. `latest` is published on every release and an upgrade you did not
choose is an upgrade you cannot roll back deliberately.

## Migrations run themselves

The container entrypoint runs `halyardctl migrate` before `halyardctl serve`, under an advisory lock, so
several replicas starting at once is safe: one applies the migrations and the rest wait and then start.
There is no separate migration step for you to run and no `docker compose run` to remember.

If a migration fails the container exits non-zero rather than serving a half-applied schema. The exit
message names the migration that failed. Do not restart it in a loop hoping it clears — read
`docker compose logs halyard` and the troubleshooting notes for `HLY-5008`.

## The metrics port is not published on purpose

`HALYARD_METRICS_ADDR` binds inside the container and the compose file above does not map it to the host.
`/metrics` carries endpoint URLs and delivery counts per endpoint, which is more than you want on a
public interface. Scrape it from the compose network, or map it to `127.0.0.1:9480:9480` if your
collector runs on the host.

## Persistent state that is not the database

`/var/lib/halyard` holds the payload spool: request bodies larger than `HALYARD_PAYLOAD_INLINE_LIMIT`
(64 KiB by default) are written there instead of into a database column. Losing that directory does not
lose events, but it does lose the bodies of the large ones, and a replay of those deliveries will fail
with `HLY-1001`. Back it up with the database, not separately — the backup guide explains why the two
have to be consistent with each other.

## Upgrading

```bash
docker compose pull halyard
docker compose up -d halyard
```

Halyard is forward-compatible within a major version: a 2.7 server reads a 2.5 schema and migrates it. It
is not backward-compatible. Rolling an image back below a migration its database has already applied
leaves a server querying columns that have moved, and the fix is a restore.
