#!/usr/bin/env bash
# Contextator container entrypoint. It supervises one or two processes, depending on where the
# database is — and where the database is, is the only thing that differs between the two published
# images and between the two topologies either of them can run in (ADR-0069).
#
#   Embedded PostgreSQL — the default image, DATABASE_URL unset. This is ADR-0006's single container
#   and the installation the quick start describes:
#     tini (PID 1) -> this script -> postgres (user "postgres")
#                                 -> node dist/server.js (user "node")
#
#   External database — DATABASE_URL set, on either image. Nothing starts a PostgreSQL here; the app
#   connects to the server named in that URL, and backing it up belongs to whoever operates it:
#     tini (PID 1) -> this script -> node dist/server.js (user "node")
#
# On the embedded path PostgreSQL is started through the unchanged upstream postgres image
# entrypoint, so first-run initialisation, POSTGRES_* variables and /docker-entrypoint-initdb.d/*.sql
# behave exactly like the official image. It listens on 127.0.0.1 only; nothing outside the container
# can reach it. The app is pointed at it through the libpq PG* variables (no DATABASE_URL needed) —
# which is why "DATABASE_URL is unset" and "the database is the embedded one" are the same sentence.
#
# The `slim` image carries no PostgreSQL at all and says so through CONTEXTATOR_EMBEDDED_POSTGRES=0.
# Started without DATABASE_URL it exits immediately with a message naming what it wanted, rather than
# looking for a postmaster that was never installed or waiting for one that is never coming.
#
# Stopping the container (SIGTERM) shuts the app down first, then PostgreSQL if there is one (fast
# shutdown). If either process dies on its own the other one is stopped and the container exits, so
# `restart: unless-stopped` brings the pair back.
set -uo pipefail

: "${POSTGRES_USER:=contextator}"
: "${POSTGRES_DB:=contextator}"
: "${POSTGRES_PASSWORD:=contextator}"
: "${PGDATA:=/var/lib/postgresql/data}"
: "${MODEL_CACHE_DIR:=/app/.cache/models}"
: "${DATA_DIR:=/data}"
: "${PG_START_TIMEOUT:=300}"
# Baked into the image rather than sniffed for: 1 in the default image, 0 in `slim`. Detecting it by
# looking for a `postgres` binary would turn "this image was built without a database" into "this
# image's database is missing", and those two need different messages.
: "${CONTEXTATOR_EMBEDDED_POSTGRES:=1}"
export POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD PGDATA

log() { printf '[contextator] %s\n' "$*" >&2; }

# postgres://user:secret@db.example.com:5432/contextator -> postgres://db.example.com:5432/contextator
# The startup log has to name the database it chose — that is half of "which topology am I in?" — and
# a connection string carries a password, so the userinfo is cut before it is printed. A string this
# does not recognise is not printed at all rather than printed hopefully.
redact_url() {
  case "$1" in
    *://*) printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#' ;;
    *) printf '%s' 'the server named in DATABASE_URL' ;;
  esac
}

if [ "$(id -u)" != '0' ]; then
  log "the container must start as root; privileges are dropped to 'postgres' and 'node' internally"
  exit 1
fi

# Bind-mounted directories may arrive owned by the host user; the model cache and the data directory
# (uploads, git checkouts) must be writable by "node". (PGDATA ownership is fixed by the upstream entrypoint.)
for dir in "$MODEL_CACHE_DIR" "$DATA_DIR"; do
  mkdir -p "$dir"
  if [ -n "$(find "$dir" ! -user node -print -quit)" ]; then
    chown -R node:node "$dir"
  fi
done

# ---- which database ----------------------------------------------------------------------------------
if [ -n "${DATABASE_URL:-}" ]; then
  EMBEDDED_PG=0
  log "database: external — $(redact_url "$DATABASE_URL")"
  log "the PostgreSQL embedded in this image is not started; backing that database up is yours"
  # One warning, for one mistake that is going to be made: `.env.example` shipped a live
  # `postgres://contextator:contextator@localhost:5432/contextator` for `npm run dev` back when
  # docker-compose.yml cleared DATABASE_URL, so a `.env` copied from it before ADR-0069 now says
  # "connect to this container's own loopback" — where nothing is listening, because that URL is
  # exactly what stopped the postmaster from starting. It is a warning and not a refusal: the same
  # address is correct for a container on the host's network namespace reaching a PostgreSQL there.
  case "$DATABASE_URL" in
    # The brackets around an IPv6 host are escaped: unescaped, `[::1]` is a bracket *expression*
    # matching one character out of `:` and `1`, so the pattern would quietly never match the address
    # it names — and a warning that never fires is worse than no warning, because it reads as covered.
    *@localhost:* | *@127.0.0.1:* | *@localhost/* | *@127.0.0.1/* | *@\[::1\]:* | *@\[::1\]/*)
      if [ "$CONTEXTATOR_EMBEDDED_POSTGRES" = '1' ]; then
        log "warning: that address is this container's own loopback, and the PostgreSQL in this image"
        log "warning: is not started when DATABASE_URL is set — so unless this container shares a"
        log "warning: network namespace with a host that is running one, nothing is listening there."
        log "warning: A .env copied from an older .env.example carries that URL; clear it to use the"
        log "warning: embedded database, or point it at the server you meant."
      fi
      ;;
  esac
elif [ "$CONTEXTATOR_EMBEDDED_POSTGRES" = '1' ]; then
  EMBEDDED_PG=1
  log "database: embedded — the PostgreSQL inside this container ($PGDATA)"
else
  # The worst outcome this image can produce is a container that starts, finds no database, and sits
  # there. So it does not: it names the variable, what the server behind it has to be, and the image
  # that needs neither.
  log "no database configured, and this image has none of its own."
  log ""
  log "  This is the 'slim' image (contextator/contextator:*-slim). It carries the application and"
  log "  no PostgreSQL, so it cannot start without being told where its database is:"
  log ""
  log "      DATABASE_URL=postgres://user:password@host:5432/contextator"
  log ""
  log "  That server must be PostgreSQL 16 or newer, with the pgvector extension installed or"
  log "  installable by the role in the URL — the first start runs CREATE EXTENSION IF NOT EXISTS"
  log "  vector — and the database in it may be empty; the schema is created and migrated at startup."
  log ""
  log "  The default image, contextator/contextator, embeds its own PostgreSQL and needs none of this."
  exit 1
fi

# ---- PostgreSQL --------------------------------------------------------------------------------------
# The upstream entrypoint re-execs itself via gosu as "postgres", initialises the cluster on first run
# and finally execs the postmaster. exec keeps the PID, so $PG_PID is the postmaster.
PG_PID=''
if [ "$EMBEDDED_PG" = '1' ]; then
  docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 &
  PG_PID=$!

  log "waiting for PostgreSQL"
  pg_started=$(date +%s)
  until pg_isready -q -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do
    if ! kill -0 "$PG_PID" 2>/dev/null; then
      wait "$PG_PID"
      log "PostgreSQL exited during startup (exit code $?)"
      exit 1
    fi
    if [ $(( $(date +%s) - pg_started )) -ge "$PG_START_TIMEOUT" ]; then
      log "PostgreSQL did not become ready within ${PG_START_TIMEOUT}s"
      kill -INT "$PG_PID" 2>/dev/null
      wait "$PG_PID"
      exit 1
    fi
    sleep 1
  done
  log "PostgreSQL is ready (data directory: $PGDATA)"
fi

# ---- Contextator -------------------------------------------------------------------------------------
# On the embedded path the libpq PG* variables are how the app is told where its database is; on the
# external path they are deliberately not set, so DATABASE_URL is the only answer to that question and
# there is no second, stale one underneath it.
if [ "$EMBEDDED_PG" = '1' ]; then
  PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE="$POSTGRES_DB" \
    gosu node node /app/dist/server.js &
else
  gosu node node /app/dist/server.js &
fi
APP_PID=$!

stop_app() {
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null
    wait "$APP_PID"
  fi
}
stop_pg() {
  [ -n "$PG_PID" ] || return 0
  if kill -0 "$PG_PID" 2>/dev/null; then
    kill -INT "$PG_PID" 2>/dev/null # SIGINT = PostgreSQL "fast" shutdown
    wait "$PG_PID"
  fi
}
on_signal() {
  trap '' TERM INT
  log "shutdown requested"
  stop_app
  stop_pg
  log "stopped"
  exit 0
}
trap on_signal TERM INT

# Block until one of the supervised processes exits (or a signal arrives, which runs on_signal).
if [ -n "$PG_PID" ]; then
  wait -n "$APP_PID" "$PG_PID"
else
  wait "$APP_PID"
fi
rc=$?
if kill -0 "$APP_PID" 2>/dev/null; then
  log "PostgreSQL exited unexpectedly (exit code $rc); stopping the app"
  stop_app
  exit 1
fi
if [ -n "$PG_PID" ]; then
  log "app exited (exit code $rc); stopping PostgreSQL"
  stop_pg
else
  log "app exited (exit code $rc)"
fi
exit "$rc"
