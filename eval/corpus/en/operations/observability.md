# Metrics, logs and traces

## The metrics endpoint

Prometheus text format on `HALYARD_METRICS_ADDR`, `127.0.0.1:9480` by default, at `/metrics`. It is bound
to loopback deliberately: the series carry endpoint ids and, in one case, endpoint hosts. Set it to
`0.0.0.0:9480` only on a network where that is acceptable.

## The series

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `halyard_deliveries_total` | counter | `result`, `endpoint_id` | `result` is `succeeded`, `failed`, `abandoned` or `skipped`. |
| `halyard_delivery_attempts_total` | counter | `outcome`, `code` | `code` is the `HLY-NNNN` for failures and empty for successes. |
| `halyard_delivery_duration_seconds` | histogram | `endpoint_id` | Whole attempt, connection to last byte. Buckets go to 30s. |
| `halyard_queue_depth` | gauge | `state` | Rows in `pending` and in `in_flight`. |
| `halyard_queue_oldest_seconds` | gauge | — | Age of the oldest pending delivery whose `next_attempt_at` has passed. |
| `halyard_dispatch_workers_busy` | gauge | — | In-flight attempts on this replica. Compare with `halyard_dispatch_concurrency_limit`. |
| `halyard_dispatch_concurrency_limit` | gauge | — | The configured `HALYARD_DISPATCH_CONCURRENCY`, exported so a dashboard does not have to be told. |
| `halyard_schedule_runs_total` | counter | `schedule_id`, `result` | `result` is `fired`, `skipped` or `missed`. |
| `halyard_http_requests_total` | counter | `route`, `status` | The API's own traffic. `route` is the template, not the path. |
| `halyard_db_pool_in_use` | gauge | — | Against `halyard_db_pool_size`. |

## What to alert on

**`halyard_queue_oldest_seconds` above your delivery objective.** This is the alert. It is latency as a
receiver experiences it, it catches every cause at once — no capacity, a stuck endpoint, a stalled
replica, a clock that is wrong — and it does not fire during a burst that is being worked off quickly.

**`rate(halyard_schedule_runs_total{result="skipped"}[1h]) > 0`.** A schedule that skips is a schedule
whose work takes longer than its interval, and it will not fix itself.

**`halyard_db_pool_in_use / halyard_db_pool_size > 0.9` for five minutes.** Pool exhaustion presents as
everything being slightly slow, which is the hardest symptom to diagnose from anywhere else.

Do not alert on `halyard_queue_depth` alone. It rises during every normal burst, and an alert that fires
when nothing is wrong is an alert that gets silenced before the day it matters.

## Logs

JSON by default. Every line carries `ts`, `level`, `msg`, and where applicable `delivery_id`,
`event_id`, `endpoint_id`, `attempt` and `code`. A request-scoped `request_id` is generated per API
request and echoed in the `X-Request-Id` response header, so a report from a user is traceable to the
lines it produced.

`HALYARD_LOG_FORMAT=text` is for a terminal and is not stable enough to parse. `HALYARD_LOG_LEVEL=debug`
adds one line per attempt including the outcome and the duration, which is what you want while
diagnosing a single endpoint and not what you want left on.

## Traces

Set `HALYARD_TRACE_ENDPOINT` to an OTLP/HTTP collector URL. A publish produces a span for the API request
and a linked span for each delivery attempt, so the whole life of an event is one trace even though the
attempts happen minutes or hours later and possibly on another replica.

There is no sampling configuration. Halyard exports everything and expects the collector to sample,
because a decision taken in the process cannot be revisited and a decision taken in the collector can.
