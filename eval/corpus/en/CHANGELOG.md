# Changelog

Dates are the release date. Halyard follows semantic versioning: within a major version, a schema
migrates forward automatically and an API field is never removed.

## 3.0.0-rc.1 — 2026-09-10

**Breaking, and this is the release note to read before upgrading.**

- Removed `HALYARD_WORKER_COUNT` and `HALYARD_WEBHOOK_SECRET`, both deprecated since 2.x. A server that
  still has them set now refuses to start rather than ignoring them.
- `GET /v1/deliveries` no longer accepts an offset; only cursors. Offsets were skipping rows under
  insert load and no correct paging was possible with them.
- The minimum PostgreSQL is now 14. 13 reached end of life and the queue query uses
  `SELECT … FOR UPDATE SKIP LOCKED` with a `LIMIT` pushdown that 13's planner handles badly.
- Redirects are no longer followed under any configuration. `HALYARD_FOLLOW_REDIRECTS` is gone.

## 2.7.0 — 2026-08-21

- Per-endpoint rate limits (`--rate-limit`), enforced across replicas through a token bucket in the
  database rather than per process.
- `halyardctl doctor` now checks clock skew against the database server, which turned out to be the
  cause of most "the queue grows but nothing is being attempted" reports.
- `halyard_queue_oldest_seconds` added. The documentation now recommends alerting on it instead of on
  queue depth.
- Fixed: a delivery whose payload had been swept reported a generic `500` instead of `HLY-1001` on
  replay.

## 2.6.3 — 2026-07-30

- Fixed: `X-Halyard-Attempt` was 0-based in the header and 1-based in the API, which made attempt numbers
  in a receiver's logs impossible to line up with Halyard's. It is 1-based in both now. Receivers that
  worked around this will need the workaround removed.
- Fixed: a `Retry-After` longer than the computed backoff was being honoured, which let one receiver push
  its own deliveries arbitrarily far into the future. It is now honoured only when it is shorter.
- `HALYARD_WORKER_COUNT` is now ignored rather than partially respected.

## 2.6.0 — 2026-06-18

- Scheduler leases, so several replicas may run the scheduler. Previously exactly one replica could have
  `HALYARD_SCHEDULER_ENABLED=true` and a deployment had to arrange that itself.
- `HALYARD_SCHEDULER_CATCHUP_WINDOW`, and `HLY-6004` for occurrences older than it.
- Endpoint URLs are re-checked against blocked address ranges at delivery time, not only at creation
  (`HLY-2007`).

## 2.5.0 — 2026-05-07

- The payload spool: bodies larger than `HALYARD_PAYLOAD_INLINE_LIMIT` go to `HALYARD_DATA_DIR` instead of
  a database column. Deployments with large payloads should read the backup guide's ordering note, which
  first became load-bearing here.
- `halyardctl backup` and `halyardctl restore`.
- OIDC for the browser console.

## 2.4.0 — 2026-03-26

- `HALYARD_DISPATCH_CONCURRENCY` replaces `HALYARD_WORKER_COUNT`, which is deprecated and still read.
- Per-endpoint `--max-in-flight`.
- `410 Gone` from a receiver now disables the endpoint (`HLY-2009`) instead of being retried.
