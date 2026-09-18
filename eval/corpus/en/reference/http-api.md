# HTTP API reference

The API is served on `HALYARD_LISTEN_ADDR` and versioned in the path. `/v1` is stable: a field is never
removed from a response within a major version, and a new field may appear at any time, so parse
leniently.

Every request needs `Authorization: Bearer <key>` except `/healthz` and `/readyz`. A missing or unknown
key is `401`; a key that is valid but not scoped for the operation is `403`. The two are deliberately
distinguishable, because a deployment where every failure looks the same is a deployment nobody can
debug.

## POST /v1/events

Publishes an event and creates one delivery per enabled endpoint subscribed to its type.

Request headers:

- `Content-Type: application/json` — required.
- `X-Halyard-Idempotency-Key` — optional but strongly recommended. Scoped to the API key, retained for
  24 hours. A repeat within that window returns the original response with `200` instead of `202`, and
  creates nothing.

Body:

```json
{
  "event_type": "order.created",
  "payload": {"order_id": 8812},
  "endpoint_ids": ["ep_01J8ZC"],
  "not_before": "2026-09-18T10:00:00Z"
}
```

`endpoint_ids` narrows delivery to specific endpoints instead of every subscriber; the named endpoints
still have to be subscribed to the type. `not_before` holds the deliveries until that instant — it is how
a delayed webhook is expressed, and it does not involve the scheduler.

Response `202 Accepted`:

```json
{
  "event_id": "evt_01J8Z9",
  "event_type": "order.created",
  "deliveries": [{"delivery_id": "dlv_01J8ZD", "endpoint_id": "ep_01J8ZC", "state": "pending"}]
}
```

An event with no matching endpoint is still stored and still answers `202`, with an empty `deliveries`
array. This is on purpose: an event that was published before its subscriber existed can be replayed to
it afterwards, and an error here would have thrown the event away.

`400` with `HLY-1001` means the body is not valid JSON or `payload` is not an object. `422` with
`HLY-1004` means `event_type` is not in the registered type list and strict typing is on.

## GET /v1/deliveries

Lists deliveries newest first. Query parameters: `event_id`, `endpoint_id`, `state` (repeatable),
`since`, `until`, `limit` (default 50, maximum 500) and `cursor`.

The response carries `next_cursor` when more rows exist. Cursors are opaque and stable across inserts —
paging through a busy queue will not show you the same delivery twice or skip one — and they expire after
an hour.

## GET /v1/deliveries/{delivery_id}

The delivery, and its full attempt history: for each attempt the number, the timestamp, the response
status, the duration in milliseconds, and the first 4 KiB of the response body. The body is truncated
rather than omitted because the useful half of a receiver's error message is almost always in the first
line.

## POST /v1/deliveries/{delivery_id}/replay

Creates a new delivery of the same event to the same endpoint, with a fresh attempt budget. The original
is untouched and keeps its history.

`409` with `HLY-1001` means the payload has already been swept by `HALYARD_RETENTION_PAYLOADS` and there
is nothing left to send. `409` with `HLY-2002` means the endpoint is disabled — re-enable it first, on
the grounds that replaying into a disabled endpoint is more likely to be a mistake than an intention.

## POST /v1/endpoints

```json
{
  "url": "https://example.test/hooks/orders",
  "event_types": ["order.created", "order.*"],
  "description": "Order service",
  "max_in_flight": 4,
  "rate_limit": "20/s",
  "headers": {"X-Tenant": "acme"}
}
```

`event_types` accepts a trailing `*` as a suffix wildcard and nothing else; `order.*` matches
`order.created`, `*.created` is rejected with `HLY-1001`. Custom `headers` are sent with every delivery
and may not override any `X-Halyard-*` header or `Content-Type`.

The URL must be https unless the host is loopback, and must not resolve to a link-local or
metadata-service address. Both checks happen at creation and again at delivery time, because DNS can
change in between; the delivery-time failure is `HLY-2007`.

## PATCH /v1/endpoints/{endpoint_id}

Accepts any subset of the creation fields plus `enabled`. Changing `url` does not re-deliver anything
that has already succeeded.

## GET /v1/schedules and POST /v1/schedules

A schedule is a cron expression, a target endpoint and a payload template. See the scheduled-jobs
documentation for the expression syntax and the overlap rules; the API surface is the expected four
verbs and holds no behaviour of its own.

## GET /healthz and GET /readyz

`/healthz` answers `200` whenever the process is running. `/readyz` answers `200` only when the database
is reachable and the schema is at the version this binary expects, and `503` with a body naming which of
the two failed. Point a load balancer at `/readyz` and a process supervisor at `/healthz`; pointing both
at the same one is how a rolling deploy removes every replica at once.

## Delivery request headers

Every delivery Halyard sends carries:

| Header | Meaning |
|---|---|
| `X-Halyard-Delivery-Id` | The delivery, not the event. It is stable across attempts of the same delivery and different for a replay. |
| `X-Halyard-Event-Id` | The event. Two deliveries of one event to two endpoints share it. |
| `X-Halyard-Event-Type` | The registered type string. |
| `X-Halyard-Endpoint-Id` | Which of your endpoints this is. Useful when one receiver serves several. |
| `X-Halyard-Attempt` | 1-based attempt number within this delivery. |
| `X-Halyard-Signature` | The signature; format and verification are in the signing reference. |
| `X-Halyard-Signature-Timestamp` | Unix seconds, signed together with the body. |
| `User-Agent` | `Halyard/2.7.0`, with the exact running version. |

## What a receiver's status code means to Halyard

`2xx` is success. `410 Gone` disables the endpoint immediately and stops the remaining deliveries, which
is the one status that is treated as an instruction rather than an outcome. `429` and any `5xx` are
retried on the ordinary backoff, and a `Retry-After` on a `429` is honoured when it is shorter than the
backoff would have been but never when it is longer. Every other `4xx` is a permanent failure: the
delivery is abandoned immediately with the attempt budget unspent, because a body Halyard will send again
unchanged is a body that will be rejected again.
