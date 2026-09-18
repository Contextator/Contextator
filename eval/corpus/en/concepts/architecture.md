# Architecture

Halyard is one binary and one database. Everything below is a description of what that binary does when
you run it, and of which parts of it can be run separately when you have a reason to.

## The four loops

**The API listener** accepts events and serves the management API. It does no delivery work at all: a
publish is a validation, a row and a set of delivery rows, and then a response. This is why publish
latency is flat while receivers are slow.

**The dispatcher** claims pending deliveries whose `next_attempt_at` has passed, takes a lease on each,
performs the HTTP request and records the outcome. It holds `HALYARD_DISPATCH_CONCURRENCY` in flight and
looks for more work every `HALYARD_QUEUE_POLL_INTERVAL` when it has capacity.

**The scheduler** wakes once a second, finds schedules whose next occurrence is due, and publishes an
event for each. It takes a per-schedule lease so that several replicas with the scheduler enabled fire
each occurrence exactly once between them.

**The retention sweeper** deletes deliveries older than `HALYARD_RETENTION_DELIVERIES` and payloads older
than `HALYARD_RETENTION_PAYLOADS`, in bounded batches, every `HALYARD_RETENTION_SWEEP_INTERVAL`.

## Why the database is the only coordination

There is no queue broker, no Redis and no gossip between replicas. Leases, rate-limit token buckets,
scheduler locks and the work queue itself are all rows in PostgreSQL, claimed with
`SELECT … FOR UPDATE SKIP LOCKED`.

The cost is real and worth stating: the queue's throughput is bounded by what one PostgreSQL can do with
short update transactions, which in practice is thousands of deliveries per second and not hundreds of
thousands. What it buys is that a Halyard deployment has exactly one thing to back up, one thing to
monitor and one thing that can be in an inconsistent state. For the workload Halyard is for — webhooks
leaving a product, rather than an event bus inside one — that trade has never been close.

## Replicas

Replicas are identical and stateless. Add one by starting another process with the same environment;
remove one by stopping it. There is no leader, no membership list and nothing to register.

Two things are worth knowing when you run more than one. The scheduler may be enabled on all of them —
the lease, not your configuration, is what prevents double firing. And `HALYARD_DATA_DIR` is per replica
unless you put it on shared storage, which means a large payload spooled by one replica is not readable
by another; deliveries of spooled payloads are therefore pinned to the replica that holds the body, and
if that replica is gone for good, those deliveries fail with `HLY-1001` on their next attempt. Shared
storage for `HALYARD_DATA_DIR` removes that entirely and is the recommended configuration for more than
two replicas.

## The data model, in one paragraph

An **event** is an immutable published fact with a type and a payload. An **endpoint** is a URL with a
subscription to one or more event types. A **delivery** is one event's journey to one endpoint, with a
state, an attempt count and a next-attempt time. An **attempt** is one HTTP request and its outcome. A
**schedule** produces events on a cron expression. Everything else — keys, leases, token buckets,
idempotency records — exists to make those five behave.
