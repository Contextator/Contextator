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

## Golden-set eval runs

A project's golden questions (`/api/projects/:id/golden-questions`) are asked of its live index by the server
itself, and each run is kept, so a regression is visible without running anything. A run is started by a swap
(a force or model-change re-index), by an incremental run that wrote chunks, removed files or recorded document
changes, by a change to the set (after 60 seconds without another), and by a manager. A project with no golden
questions does nothing and records nothing.

| Method and path | Role | What it does |
|---|---|---|
| `GET /api/projects/:id/eval-runs?limit=` | viewer | The runs, newest first (`limit` 1 to 100, default 30), without per-question ranks. |
| `GET /api/projects/:id/eval-runs/:runId` | viewer | One run, with `results`: `{ key, fp, rank }` per question asked (the 0-based rank of the right file in a page of ten, so `rank: 4` is fifth place; `null` when absent). Question text is never in a run. |
| `POST /api/projects/:id/eval-runs` | manager | Starts a run now. `202 { runId }`; the run goes on in the background and is read back from the two routes above. The row is not guaranteed: a project deleted while it ran, a shutdown, or a failed write leave `runId` unwritten for good, so poll with a limit. A golden set emptied after the request is accepted records an `error` run. `409` when this project already has a run going or waiting, when the server is already running one (one at a time across the instance), or when the project has no golden questions. Audited. |

A run carries `trigger` (`index_rebuild`, `index_incremental`, `golden_set`, `manual`), `status` (`ok` or `error`,
with `error` saying why and no figures), `generation`, `embeddingModel`, `questionCount`, `scoredCount`, `recall5`,
`mrr`, `regressed`, `comparedTo` and three lists of question keys: `lostKeys`, `skippedKeys` and `newlySkippedKeys`.

- **Scored as `npm run eval -- --project` scores**: the same search with the floor off, no reranker (the server's
  search path has none, and `--project` ignores `SEARCH_RERANK`) and the same scoring module, so the two figures
  are one number.
- **A question whose `expectFile` is not in the live index is skipped.** It leaves the denominator and is listed in
  `skippedKeys`; one that the previous good run did ask is also in `newlySkippedKeys`, which is a warning and not
  a regression. A run with nothing left to ask is an `error`.
- **`regressed` is true when at least one question was lost** against the project's last `ok` run: it was in the
  top five then, is asked now with the same text, expected file and heading, and is not in the top five now. The
  count is gross, so a question gained elsewhere does not cancel a lost one. A question that was edited since is
  not compared. The first run has nothing to be compared with.
- **An index that changed during the run** (a swap) makes the run an `error`; the swap has already queued its own.
- The last 100 runs per project are kept, and runs are not part of a project export.

`/metrics` counts them without any label: `contextator_eval_runs_total`, `contextator_eval_run_errors_total` and
`contextator_eval_regressions_total`. A project's score is never a metric.

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

Two endpoints of the MCP-token group are worth knowing by name here. `POST /api/projects/:id/mcp-tokens` and
`PATCH /api/projects/:id/mcp-tokens/:tokenId` accept `allowedCidrs`, a list of at most 32 addresses or CIDR
ranges that the static token is limited to (`[]` or `null` removes the limit; see
[MCP access](mcp-access.md#restricting-a-static-token-to-a-network)). The PATCH answers with the token's view
and is audited without writing the list into the audit event. (Up to 0.4.x both answered `400` while
`TRUST_PROXY=1`, because the address would be client-controlled; 0.5.0 refuses that value at startup, so the case
no longer exists.) The PATCH also updates a token that has already expired, so its network list can
be changed before or after the expiry date; only a revoked token answers `404`.

A static token can also be bound to some of the project's sources ([MCP access](mcp-access.md#binding-a-static-token-to-some-of-a-projects-sources)).
`POST /api/projects/:id/mcp-tokens` takes `sources`, a list of source **names** (absent or `null`: the whole project);
`PATCH /api/projects/:id/mcp-tokens/:tokenId/sources` (`editor`) takes `{ "sources": ["handbook"] }` to replace the
scope or `{ "sources": null }` to remove it, and takes effect on the token's next request. Refusals, each with the
error code in `error`: `400 empty_scope` for `[]` (a token that reads nothing is never created on purpose),
`400 unknown_source` for a name this project does not have (the message lists the names it did not find),
`409 not_static` for an OAuth credential, `404` for a token that is not this project's or is revoked. `GET
/api/projects/:id/mcp-tokens` returns `sources` (`string[]` or `null`) and `scopeEmpty` (`true` for a scoped token whose
sources are all gone) on every token. Both writes are audited with `detail: { scoped, sources }`, the names read back
from the database.

The query log's summary (`GET /api/projects/:id/queries/summary`) and export take an optional `token` (a token id)
to show what one MCP token asked, on top of the existing filters.
