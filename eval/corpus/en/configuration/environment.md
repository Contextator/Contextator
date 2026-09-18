# Environment variable reference

Every setting is an environment variable. There is no configuration file format of its own: `--config`
points at a file of `KEY=value` lines, which is read into the environment before anything else happens,
so a variable set in the process environment always wins over the same variable in that file.

Durations accept a unit suffix (`250ms`, `15s`, `6h`, `30d`). Sizes accept `KiB`, `MiB`, `GiB`. Booleans
accept `true`, `false`, `1` and `0`; anything else is a startup error rather than a silent `false`.

## Core

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_DATABASE_URL` | — | Required. A libpq connection string. `sslmode` defaults to `require`; set it explicitly for a local server. |
| `HALYARD_LISTEN_ADDR` | `0.0.0.0:8480` | Where the API listens. Set `127.0.0.1:8480` when a reverse proxy terminates TLS on the same host. |
| `HALYARD_DATA_DIR` | `/var/lib/halyard` | The payload spool. Must be writable by the server user and must survive restarts. |
| `HALYARD_DRAIN_TIMEOUT` | `30s` | How long a shutdown waits for in-flight deliveries before abandoning them. Abandoned deliveries are retried by whichever replica picks them up next. |
| `HALYARD_TRUSTED_PROXIES` | empty | Comma-separated CIDRs whose `X-Forwarded-For` is believed. Empty means no proxy header is trusted and the peer address is used. |

## Dispatch

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_DISPATCH_CONCURRENCY` | `32` | Deliveries in flight per replica. This is the single most consequential number in a Halyard deployment; the dispatch tuning page is about nothing else. |
| `HALYARD_DISPATCH_TIMEOUT` | `15s` | Per-attempt HTTP timeout, measured from connection start to the last byte of the response body. Exceeding it produces `HLY-4013`. |
| `HALYARD_QUEUE_POLL_INTERVAL` | `250ms` | How often a replica with idle workers looks for new work. Lowering it below `100ms` buys latency you will not notice and costs database round trips you will. |
| `HALYARD_MAX_ATTEMPTS` | `12` | Attempts before a delivery is abandoned as `failed` for good, at which point it answers `HLY-4019`. |
| `HALYARD_RETRY_BACKOFF_BASE` | `2s` | First retry delay. Each subsequent delay doubles. |
| `HALYARD_RETRY_BACKOFF_CAP` | `6h` | Ceiling on that doubling. With the defaults, attempt 12 lands roughly three days after the event. |
| `HALYARD_PAYLOAD_INLINE_LIMIT` | `64KiB` | Bodies at or below this go into the database; larger ones go to `HALYARD_DATA_DIR`. |

## Signing

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_SIGNING_SECRET` | — | Required. At least 32 bytes. Used for `hmac-sha256`; ignored when the algorithm is `ed25519`. |
| `HALYARD_SIGNING_ALGORITHM` | `hmac-sha256` | `hmac-sha256` or `ed25519`. Changing it re-signs future deliveries only; in-flight ones keep the algorithm they were signed with. |
| `HALYARD_SIGNING_PRIVATE_KEY_PATH` | — | Required when the algorithm is `ed25519`. A PKCS#8 PEM file, readable only by the server user. |
| `HALYARD_SIGNATURE_TOLERANCE` | `5m` | How far a receiver's clock may be from Halyard's before a verified signature is rejected. Receivers enforce this, not Halyard; the value is published in the reference so that both sides agree. |

## Authentication

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_ADMIN_API_KEYS` | empty | Comma-separated static keys with full access. Intended for bootstrap and CI. Keys minted with `halyardctl keys mint` are scoped and revocable; these are neither. |
| `HALYARD_OIDC_ISSUER` | empty | Enables the browser console when set. Must be an https URL serving a discovery document. |
| `HALYARD_OIDC_CLIENT_ID` | — | Required when the issuer is set. |
| `HALYARD_OIDC_CLIENT_SECRET` | — | Required when the issuer is set, unless the client is public. |
| `HALYARD_OIDC_REDIRECT_URL` | — | Must exactly match a redirect URI registered with the provider, including the trailing path. |
| `HALYARD_OIDC_ADMIN_GROUPS` | empty | Group claims that grant administrative access. With none set, every authenticated user is a reader. |

## Scheduler

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_SCHEDULER_ENABLED` | `true` | Whether this replica runs due schedules. Several replicas may have it on; a lease makes sure one fires each occurrence. |
| `HALYARD_SCHEDULER_TIMEZONE` | `UTC` | The zone every cron expression is interpreted in unless the schedule carries its own. Use an IANA name; an abbreviation such as `EST` is rejected at startup. |
| `HALYARD_SCHEDULER_CATCHUP_WINDOW` | `1h` | How far back a schedule that was missed — because nothing was running — is still fired for. Occurrences older than this are skipped and counted, not fired. |

## Retention

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_RETENTION_DELIVERIES` | `30d` | How long delivery rows and their attempt history are kept. |
| `HALYARD_RETENTION_PAYLOADS` | `7d` | How long request bodies are kept. Shorter than the delivery retention on purpose: after this, a delivery can still be inspected but no longer replayed. |
| `HALYARD_RETENTION_SWEEP_INTERVAL` | `15m` | How often the sweeper runs. It deletes in bounded batches and yields between them. |

## Observability

| Variable | Default | Meaning |
|---|---|---|
| `HALYARD_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `trace`. |
| `HALYARD_LOG_FORMAT` | `json` | `json` or `text`. `text` is for a terminal and is not stable enough to parse. |
| `HALYARD_METRICS_ADDR` | `127.0.0.1:9480` | Where `/metrics` is served. Set to empty to disable the listener entirely. |
| `HALYARD_TRACE_ENDPOINT` | empty | An OTLP/HTTP collector URL. Tracing is off when empty; there is no sampling configuration because Halyard samples at the collector. |

## Settings that no longer exist

`HALYARD_WORKER_COUNT` was replaced by `HALYARD_DISPATCH_CONCURRENCY` in 2.4.0 and has been ignored since
2.6.0. `HALYARD_WEBHOOK_SECRET` was renamed to `HALYARD_SIGNING_SECRET` in 2.2.0; the old name is still
read and logs a warning on every start. Both will be removed in 3.0.0.
