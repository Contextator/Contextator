# Admin API

Every endpoint under `/api/*` returns JSON and is authenticated by the dashboard's session cookie,
by `Authorization: Bearer <ADMIN_TOKEN>` (machine access, root permissions), or by an account's own
scoped API token. It covers projects and their live indexing jobs, sources of every type, MCP tokens,
accounts and API tokens, project membership, and an audit log that is written by the policy layer
itself — no handler can add a route without being covered. `GET /metrics` exposes Prometheus text
separately, gated by a signed-in account, `ADMIN_TOKEN`, `METRICS_TOKEN`, or `METRICS_PUBLIC=1`.

A project can be moved between instances: `GET /api/projects/:id/export` writes one `.tar.gz`, and
`POST /api/projects/import` (an instance `admin`'s) creates a project from it. The import is refused with
`507 insufficient_disk` when `DATA_DIR` — and, with the embedded database, its data directory — cannot hold
`DATA_DIR_MIN_FREE_BYTES` plus four times the archive's size. The check runs before the upload is read and
again before it is unpacked, so a refusal leaves no project row or file behind; `DATA_DIR_MIN_FREE_BYTES=0`
turns it off. It is advisory, and with an external database (`DATABASE_URL`) only `DATA_DIR` is measured.

Full endpoint tables (projects, sources, uploads, webhooks, MCP tokens, accounts, tokens, audit
query parameters) and the audit log's guarantees and limits — what it records, what it deliberately
does not (refused requests, actions that fail after committing), its performance at 200,004 rows,
and that it is not tamper-evident: [Admin API](https://contextator.com/en/docs/admin-api/).

## Scaling signals: when one process is no longer enough

Contextator runs one process with one indexer queue on purpose. `/metrics` carries the histograms
that say when that stops being true — `contextator_search_request_duration_seconds{indexing}` and
`contextator_search_duration_seconds{phase=embed|retrieve|rerank,indexing}` for every MCP and dashboard
search, `contextator_embedding_batch_*` for indexing, and `contextator_index_run_wait_seconds{lane}`
for the queue. `contextator_mcp_requests_total{method,tool,era}` counts MCP messages by protocol era, so you can
see when the last 2025-era client has gone, and `contextator_mcp_tool_duration_seconds{tool}` times each tool
call; no label carries a project, a document or a query. Revisit the single-process design when, sustained over a
week, the search p95 while indexing is above 1 s and twice the idle p95, the interactive queue wait p95 is
above 5 minutes, or the interactive backlog stays non-zero for 15 minutes at a time.
