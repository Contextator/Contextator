#!/usr/bin/env bash
# Contextator single-container entrypoint: PostgreSQL 16 (+pgvector) and the Node.js app in one container.
#
# Process tree
#   tini (PID 1) -> this script -> postgres (user "postgres")
#                               -> node dist/server.js (user "node")
#
# PostgreSQL is started through the unchanged upstream postgres image entrypoint, so first-run
# initialisation, POSTGRES_* variables and /docker-entrypoint-initdb.d/*.sql behave exactly like the
# official image. It listens on 127.0.0.1 only; nothing outside the container can reach it.
# The app is pointed at it through the libpq PG* variables (no DATABASE_URL needed).
#
# Stopping the container (SIGTERM) shuts the app down first, then PostgreSQL (fast shutdown).
# If either process dies on its own the other one is stopped and the container exits, so
# `restart: unless-stopped` brings the whole pair back.
set -uo pipefail

: "${POSTGRES_USER:=contextator}"
: "${POSTGRES_DB:=contextator}"
: "${POSTGRES_PASSWORD:=contextator}"
: "${PGDATA:=/var/lib/postgresql/data}"
: "${MODEL_CACHE_DIR:=/app/.cache/models}"
: "${DATA_DIR:=/data}"
: "${PG_START_TIMEOUT:=300}"
export POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD PGDATA

log() { printf '[contextator] %s\n' "$*" >&2; }

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

if [ -n "${DATABASE_URL:-}" ]; then
  log "DATABASE_URL is set: the app will use that database instead of the embedded PostgreSQL"
fi

# ---- PostgreSQL --------------------------------------------------------------------------------------
# The upstream entrypoint re-execs itself via gosu as "postgres", initialises the cluster on first run
# and finally execs the postmaster. exec keeps the PID, so $PG_PID is the postmaster.
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

# ---- Contextator -------------------------------------------------------------------------------------
PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE="$POSTGRES_DB" \
  gosu node node /app/dist/server.js &
APP_PID=$!

stop_app() {
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null
    wait "$APP_PID"
  fi
}
stop_pg() {
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

# Block until one of the two exits (or a signal arrives, which runs on_signal).
wait -n "$APP_PID" "$PG_PID"
rc=$?
if kill -0 "$APP_PID" 2>/dev/null; then
  log "PostgreSQL exited unexpectedly (exit code $rc); stopping the app"
  stop_app
  exit 1
fi
log "app exited (exit code $rc); stopping PostgreSQL"
stop_pg
exit "$rc"
