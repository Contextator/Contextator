# syntax=docker/dockerfile:1
#
# Single image: PostgreSQL 16 + pgvector + the Contextator Node.js app, supervised by docker/entrypoint.sh.
# Persistent paths (mount volumes here):
#   /var/lib/postgresql/data   PostgreSQL cluster
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

# ---- runtime stage ----
# pgvector/pgvector:pg16 = official postgres:16 image (Debian bookworm) + the extension. The Node image
# above is built on the same Debian release, so its node binary is copied over as-is (it only needs
# libstdc++, which the base image already has).
FROM pgvector/pgvector:pg16
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system node; \
    useradd --system --gid node --home-dir /app --shell /usr/sbin/nologin node
COPY --from=build /usr/local/bin/node /usr/local/bin/node

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
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./
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
