# Tuning dispatch

`HALYARD_DISPATCH_CONCURRENCY` decides how many deliveries one replica has in flight. It defaults to 32,
which is a number chosen to be safe on a small machine rather than a number chosen for your workload.
Everything on this page is about how to move it deliberately.

## The number you are actually choosing

A replica's delivery throughput is concurrency divided by the average attempt duration. Thirty-two
workers against receivers that answer in 200 ms is about 160 deliveries per second; the same thirty-two
against receivers that answer in three seconds is about eleven. The distribution matters more than the
mean, because one slow receiver occupies a worker for the whole of `HALYARD_DISPATCH_TIMEOUT` and that
worker is not delivering to anyone else while it waits.

This is the failure mode to design against, and it has a name in the issue tracker: head-of-line
blocking across endpoints. One endpoint that has started timing out can consume every worker on every
replica, and the symptom an operator sees is that unrelated endpoints have gone quiet.

## Per-endpoint limits are the real fix

```bash
halyardctl endpoints update ep_01J8ZC --max-in-flight 4 --rate-limit 20/s
```

`--max-in-flight` caps how many of a replica's workers may be occupied by one endpoint at a time.
Setting it to a quarter of `HALYARD_DISPATCH_CONCURRENCY` for every endpoint is a crude policy that
nonetheless removes the worst of the blocking. `--rate-limit` is separate and is about the receiver's
capacity rather than yours: it is enforced per endpoint across all replicas, using a token bucket held in
the database, so adding replicas does not multiply the rate a receiver sees.

An endpoint that is being rate-limited is not failing. Its deliveries stay `pending` and the delivery
row records `rate_limited` as the reason it has not been attempted. Nothing counts against
`HALYARD_MAX_ATTEMPTS` while that is the case.

## Sizing the connection pool with it

Each in-flight delivery holds a database connection only briefly — to mark the attempt and to record its
result — but the scheduler, the API and the retention sweeper hold them too. The pool defaults to
`HALYARD_DISPATCH_CONCURRENCY + 8` and is capped by PostgreSQL's own `max_connections`. Raising
concurrency to 256 on four replicas therefore asks for a thousand connections, which is more than a
default PostgreSQL will give you. Put PgBouncer in transaction mode in front of it before you raise
concurrency that far, and not after.

## Reading the metrics while you change it

Three series answer the question together, and one of them alone is misleading.

- `halyard_dispatch_workers_busy` against your configured concurrency. Persistently at the ceiling means
  the replica is the bottleneck.
- `halyard_queue_depth`. Growing with workers at the ceiling means you need more capacity; growing with
  workers idle means something else is holding work back — a rate limit, a lease, or a poll interval.
- `halyard_queue_oldest_seconds`. This is the one to alert on. Depth is a number without a unit anybody
  cares about; oldest-pending is latency, and it is what a receiver experiences.

## When more replicas beat more concurrency

Concurrency is bounded by one process's ability to schedule goroutines and by the connection pool of one
database client. Past roughly 256 in flight, a second replica is cheaper than a larger first one, and it
also survives a restart of the first. Halyard replicas are stateless and coordinate through the database
alone, so adding one is starting another container with the same environment.
