# Error codes

Every error Halyard returns, logs or records on a delivery carries a stable code of the form `HLY-NNNN`.
The code is the thing to search for, to alert on and to quote in an issue; the message next to it is
written for a person and is not stable between releases.

The first digit groups the code by what is wrong: `1` the request, `2` the endpoint, `3` signing, `4`
delivery, `5` the server, `6` scheduling.

## 1xxx — the request

| Code | HTTP | Meaning and what to do |
|---|---|---|
| `HLY-1001` | `400` | Malformed body: not JSON, `payload` not an object, or an `event_types` pattern with a wildcard anywhere but the end. Also returned by a replay whose payload has already been swept. |
| `HLY-1002` | `413` | The body exceeds `HALYARD_PAYLOAD_MAX` (1 MiB by default). Send a reference rather than the object; a webhook is a notification, not a transport. |
| `HLY-1003` | `409` | An `X-Halyard-Idempotency-Key` was reused within 24 hours with a different body. The first body is what was stored and the second is refused. |
| `HLY-1004` | `422` | Unknown `event_type` while strict typing is on. Register the type or turn strict typing off; do not spell the type differently to make the error go away. |
| `HLY-1005` | `400` | `not_before` is more than 30 days in the future, or in the past by more than the clock tolerance. |

## 2xxx — the endpoint

| Code | HTTP | Meaning and what to do |
|---|---|---|
| `HLY-2001` | `404` | No endpoint with that id, or it belongs to another tenant. |
| `HLY-2002` | `409` | The endpoint is disabled. Deliveries queued for it fail with this rather than waiting; enable it and replay. |
| `HLY-2005` | `400` | The URL is not https and the host is not loopback. |
| `HLY-2007` | — | Recorded on a delivery, not returned: at delivery time the URL resolved to a link-local, loopback or metadata-service address. DNS changed after the endpoint was created, or someone is trying to make Halyard fetch `169.254.169.254`. |
| `HLY-2009` | `409` | The endpoint has been disabled automatically after a receiver answered `410 Gone`. |

## 3xxx — signing

| Code | HTTP | Meaning and what to do |
|---|---|---|
| `HLY-3001` | `500` | `HALYARD_SIGNING_SECRET` is shorter than 32 bytes, or missing. The server refuses to start; this code appears in the log, not in a response. |
| `HLY-3002` | `500` | `HALYARD_SIGNING_ALGORITHM=ed25519` with no readable key at `HALYARD_SIGNING_PRIVATE_KEY_PATH`, or a key that is not PKCS#8. |
| `HLY-3005` | — | A receiver reported a timestamp outside `HALYARD_SIGNATURE_TOLERANCE`. Recorded from the receiver's response body when it is machine-readable. Almost always a clock, almost never a secret. |

## 4xxx — delivery

| Code | Meaning and what to do |
|---|---|
| `HLY-4001` | The connection was refused or DNS did not resolve. Retried. |
| `HLY-4002` | TLS handshake failed — an expired certificate, or a private CA the server does not trust. Retried, and retrying will not help until the certificate is fixed. |
| `HLY-4013` | The attempt exceeded `HALYARD_DISPATCH_TIMEOUT`. Retried. If a receiver routinely needs longer, raise the timeout for everyone or give that endpoint a queue of its own; do not let it sit on a worker. |
| `HLY-4015` | The receiver answered a `4xx` other than `408` or `429`. Permanent: the delivery is abandoned with its attempt budget unspent. |
| `HLY-4019` | `HALYARD_MAX_ATTEMPTS` is exhausted. The delivery is `failed` for good and only a replay will send it again. |

## 5xxx — the server

| Code | HTTP | Meaning and what to do |
|---|---|---|
| `HLY-5002` | `503` | The database is unreachable. `/readyz` fails with this and the API refuses writes; reads of cached data continue briefly. |
| `HLY-5008` | — | The schema version in the database is ahead of what this binary expects. The server refuses to start rather than query columns that have moved. Roll the binary forward, or restore the database from before the upgrade. |
| `HLY-5011` | `503` | `HALYARD_DATA_DIR` is not writable. Large payloads cannot be spooled, so writes are refused rather than silently dropping bodies. |
| `HLY-5030` | `500` | A migration failed. The message names the migration. The database is left at the last version that applied cleanly. |

## 6xxx — scheduling

| Code | HTTP | Meaning and what to do |
|---|---|---|
| `HLY-6001` | `400` | The cron expression does not parse, or names a timezone that is not an IANA identifier. |
| `HLY-6003` | — | An occurrence was skipped because the previous run of the same schedule was still in flight and the schedule's overlap policy is `skip`. Counted in `halyard_schedule_runs_total{result="skipped"}`, which is worth alerting on: a schedule that skips regularly is a schedule whose interval is shorter than its work. |
| `HLY-6004` | — | An occurrence was older than `HALYARD_SCHEDULER_CATCHUP_WINDOW` and was not fired. Expected after an outage longer than that window. |
