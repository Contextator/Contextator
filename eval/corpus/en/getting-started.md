# Getting started with Halyard

Halyard accepts events over HTTP, stores them, and delivers them to the endpoints you have registered —
retrying on its own schedule until an endpoint accepts or the attempt budget runs out. It also runs
scheduled jobs against those same endpoints, which is why a single deployment usually replaces both a
webhook fan-out service and a cron box.

This page takes you from nothing to a delivered event. It assumes Docker; if you are installing on a
single machine without a container runtime, start from the single-server guide instead.

## What you need

- PostgreSQL 14 or newer. Halyard keeps every event, every endpoint and every delivery attempt there,
  and it is the only stateful dependency.
- A reachable HTTP endpoint to deliver to. For this walkthrough any request bin will do.
- Two free ports: `8480` for the API and `9480` for metrics.

## Start the server

```bash
export HALYARD_DATABASE_URL="postgres://halyard:halyard@localhost:5432/halyard"
export HALYARD_SIGNING_SECRET="$(openssl rand -hex 32)"
halyardctl migrate
halyardctl serve
```

`halyardctl migrate` applies the schema and exits. `halyardctl serve` starts the API listener, the
dispatch workers and — unless `HALYARD_SCHEDULER_ENABLED=false` — the scheduler. On a fresh database the
first start prints a bootstrap API key exactly once. Copy it; it is stored as a hash and cannot be
recovered.

## Register an endpoint

```bash
curl -sS http://localhost:8480/v1/endpoints \
  -H "Authorization: Bearer $HALYARD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.test/hooks/orders","event_types":["order.created","order.cancelled"]}'
```

The response carries the endpoint id, which every later call and every delivery header refers to. An
endpoint is created enabled. It stops receiving deliveries the moment it is disabled, and queued
deliveries for a disabled endpoint fail with `HLY-2002` rather than waiting for it to come back.

## Publish an event

```bash
curl -sS http://localhost:8480/v1/events \
  -H "Authorization: Bearer $HALYARD_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'X-Halyard-Idempotency-Key: order-8812-created' \
  -d '{"event_type":"order.created","payload":{"order_id":8812,"total":"149.90"}}'
```

Halyard answers `202 Accepted` with the event id and the list of deliveries it created — one per matching
enabled endpoint. Nothing has been delivered yet when that response arrives; publishing and delivering
are deliberately separate, which is what lets the API stay fast while an endpoint is slow.

## Watch it arrive

```bash
halyardctl deliveries list --event-id evt_01J8Z9 --watch
```

A delivery moves through `pending`, `in_flight` and then `succeeded` or `failed`. A `failed` delivery is
not final unless the attempt budget is exhausted: it is scheduled for another attempt with an exponential
backoff, and `halyardctl deliveries list` shows the time of the next one.

## Where to go next

The environment variable reference lists every setting and its default. The delivery semantics page
explains what Halyard guarantees and, more usefully, what it does not — read it before you write a
receiver, because the two questions everyone eventually asks (can I get the same event twice, and can two
events arrive out of order) both have answers there that are easier to design for than to discover.
