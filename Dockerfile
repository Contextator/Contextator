# syntax=docker/dockerfile:1
#
# Two images out of one file, over one shared build (ADR-0069):
#
#   full  — the default target, published as contextator/contextator:<version>. PostgreSQL 16 +
#           pgvector + the Node.js app, supervised by docker/entrypoint.sh. One container, nothing to
#           provide, and the installation the quick start describes (ADR-0006).
#   slim  — `--target slim`, published as contextator/contextator:<version>-slim. The application
#           alone. It carries no database and **requires DATABASE_URL**; started without one it exits
#           with a message naming it rather than looking for a postmaster that was never installed.
#
# `full` is the last stage on purpose: `docker build .` with no --target has to keep building the
# default installation, because that is what every existing command and every document assumes.
#
# Persistent paths (mount volumes here):
#   /var/lib/postgresql/data   PostgreSQL cluster — `full` only; `slim` has no cluster to keep
#   /app/.cache/models         downloaded embedding models
#   /data                      materialised sources (uploads, git checkouts, Notion pulls)
#   /docs                      your documentation (read-only bind mount)

# ---- build stage ----
# Debian (glibc) rather than Alpine: onnxruntime-node and sharp ship glibc prebuilds.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# onnxruntime-node's postinstall only fetches optional GPU binaries; skip it to keep the build offline-friendly.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# The rest of what a runtime stage needs, gathered here rather than copied twice below. Two runtime
# stages listing the same five paths is two lists that can drift apart, and the half that drifts is
# whichever one is built less often — which, between `full` and `slim`, is not a safe thing to depend
# on. `COPY --from=build /app /app` further down is one line either side of that.
#
# The generated migrations. Without them the image boots against an empty database and `migrate()`
# cannot find `drizzle/meta/_journal.json` — which is why `drizzle` is no longer in `.dockerignore`,
# and why CI's image job lists this directory (ADR-0033).
COPY drizzle ./drizzle
# The server runs dist/; the operator scripts run from source through tsx, which is a runtime
# dependency for exactly that reason (ADR-0032). src/ is already here above, because
# scripts/reset-password.ts imports the config, the database client and the schema out of it.
COPY scripts ./scripts
COPY public ./public
COPY LICENSE ./

# ---- slim runtime ----
# Same Debian release as the build stage, and the same node binary — so nothing is copied out of
# /usr/local here: node and npm are already what they were above. What it does not have is
# PostgreSQL, which is the entire point: no postmaster, no initdb, no /var/lib/postgresql.
FROM node:22-bookworm-slim AS slim
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini gosu ca-certificates; \
    rm -rf /var/lib/apt/lists/*
# `gosu` comes from the postgres base image in the `full` stage below and has to be installed here:
# the entrypoint starts as root to fix bind-mount ownership and then drops to `node`, on both images.
# The `node` user (uid 1000) is already in this base image.

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3444 \
    HOST=0.0.0.0 \
    ALLOWED_DOC_ROOTS=/docs \
    MODEL_CACHE_DIR=/app/.cache/models \
    DATA_DIR=/data \
    CONTEXTATOR_EMBEDDED_POSTGRES=0
COPY --from=build --chown=node:node /app /app
COPY docker/entrypoint.sh /usr/local/bin/contextator-entrypoint
RUN set -eux; \
    sed -i 's/\r$//' /usr/local/bin/contextator-entrypoint; \
    chmod 0755 /usr/local/bin/contextator-entrypoint; \
    mkdir -p /app/.cache/models /data /docs; \
    chown -R node:node /app/.cache /data

EXPOSE 3444
STOPSIGNAL SIGTERM
# No initdb to cover here, but the embedding model download is the same download.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3444) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/contextator-entrypoint"]

# ---- full runtime (the default target) ----
# pgvector/pgvector:pg16 = official postgres:16 image (Debian bookworm) + the extension. The Node image
# above is built on the same Debian release, so its node binary is copied over as-is (it only needs
# libstdc++, which the base image already has).
FROM pgvector/pgvector:pg16 AS full
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system node; \
    useradd --system --gid node --home-dir /app --shell /usr/sbin/nologin node
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# npm comes with it, because the last-resort password reset is run as `npm run reset-password`
# inside this container and there is nowhere else it can be run from (ADR-0032). npm is a JavaScript
# program under /usr/local/lib rather than a binary next to node, and COPY dereferences the symlink
# in /usr/local/bin into a file that can no longer find its own modules — hence the link below.
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app
# PGDATA=/var/lib/postgresql/data is inherited from the postgres image.
ENV NODE_ENV=production \
    PORT=3444 \
    HOST=0.0.0.0 \
    ALLOWED_DOC_ROOTS=/docs \
    MODEL_CACHE_DIR=/app/.cache/models \
    DATA_DIR=/data \
    POSTGRES_USER=contextator \
    POSTGRES_DB=contextator
COPY --from=build --chown=node:node /app /app
# Runs once when the PostgreSQL cluster is first created (upstream entrypoint behaviour).
COPY db/init.sql /docker-entrypoint-initdb.d/01-init.sql
COPY docker/entrypoint.sh /usr/local/bin/contextator-entrypoint
RUN set -eux; \
    sed -i 's/\r$//' /usr/local/bin/contextator-entrypoint; \
    chmod 0755 /usr/local/bin/contextator-entrypoint; \
    mkdir -p /app/.cache/models /data /docs; \
    chown -R node:node /app/.cache /data

EXPOSE 3444
# The entrypoint runs as root only to fix volume ownership and drop privileges (postgres / node).
STOPSIGNAL SIGTERM
# start-period covers first-run initdb plus the embedding model download.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3444) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/contextator-entrypoint"]
