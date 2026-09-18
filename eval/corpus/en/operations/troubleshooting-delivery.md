# Troubleshooting deliveries

This page is about deliveries that do not arrive, arrive late, or arrive and are rejected. Problems that
stop the server from starting at all are a different shape and are covered in the Turkish startup
troubleshooting notes.

Start with `halyardctl doctor`. It takes a few seconds and rules out half of what follows.

## Nothing is being delivered at all

Check, in this order:

1. `halyard_dispatch_workers_busy`. Zero with a non-zero `halyard_queue_depth` means no replica is
   claiming work. The usual cause is that every replica is draining — a rolling deploy that stalled — or
   that the process is running with `--no-scheduler` and you are looking at schedules rather than events.
2. `/readyz`. A `503` naming the database means the dispatcher is not running either.
3. Clock skew between the server and the database. `halyardctl doctor` checks it, and the Turkish
   startup troubleshooting page works through the symptom and the fix in full.

## One endpoint is quiet while the others are fine

Look at the endpoint rather than the server.

```bash
halyardctl endpoints list --disabled
halyardctl deliveries list --endpoint-id ep_01J8ZC --state pending --limit 5
```

An endpoint disabled with `HLY-2009` was disabled by Halyard because the receiver answered `410 Gone`.
That is the one status treated as an instruction, and re-enabling an endpoint whose receiver still means
it will simply disable it again.

A `pending` delivery whose reason is `rate_limited` is not failing. It is waiting for its endpoint's
token bucket, and nothing counts against the attempt budget while that is true. If the rate limit is
lower than the rate you publish at, the queue for that endpoint grows without bound and the fix is
arithmetic, not configuration.

## Everything is late but nothing is failing

`halyard_queue_oldest_seconds` is the number to look at, and depth is the number that will mislead you.

- Workers at the ceiling and oldest-pending growing: you are out of dispatch capacity. Raise
  `HALYARD_DISPATCH_CONCURRENCY` or add a replica.
- Workers idle and oldest-pending growing: something is holding work back. A per-endpoint
  `--max-in-flight` set too low, a rate limit, a poll interval somebody raised, or leases held by a
  replica that is partitioned rather than stopped.
- Workers at the ceiling with low throughput: one endpoint is timing out and occupying everyone. Find it
  with `halyardctl deliveries list --state in_flight` and look at which endpoint id dominates. Give it a
  `--max-in-flight` immediately; that is the containment, and the conversation with the receiver's owner
  is the fix.

## Deliveries fail with HLY-4013 on one receiver only

The attempt exceeded `HALYARD_DISPATCH_TIMEOUT`. Before raising the timeout, check what the receiver is
doing with the request: a receiver that does its work before answering will get slower as your volume
grows, and raising the timeout moves the failure rather than removing it. The receiver should answer
`202` and work afterwards.

If the receiver genuinely needs longer — a synchronous downstream you do not control — raise
`HALYARD_DISPATCH_TIMEOUT` and give that endpoint a `--max-in-flight` in the same change, so the longer
timeout cannot consume every worker.

## Deliveries fail with HLY-4002 after a certificate renewal

The TLS handshake failed. Either the receiver's new certificate is signed by a CA that is not in the
server's trust store, or the chain it serves is incomplete — browsers repair an incomplete chain and Go
does not, so "it works in my browser" is consistent with this failure rather than evidence against it.

```bash
openssl s_client -connect example.test:443 -servername example.test -showcerts
```

Retrying will not help until the chain is fixed. Once it is, the pending attempts succeed on their own
schedule; you do not need to replay unless the budget was exhausted in the meantime.

## The receiver says the signature is invalid

Three causes, in the order they actually occur:

1. The receiver is verifying against the body after its framework re-serialised it. Verify against the
   raw bytes, before any JSON parsing.
2. Clock skew beyond `HALYARD_SIGNATURE_TOLERANCE`, recorded as `HLY-3005`. Five minutes is generous;
   a receiver whose clock is off by more than that has other problems.
3. The secret actually differs. Rare, and it is the one people check first.

## A bulk replay after an outage

```bash
halyardctl deliveries replay --endpoint ep_01J8ZC --since 2026-09-17T00:00:00Z --state failed --dry-run
halyardctl deliveries replay --endpoint ep_01J8ZC --since 2026-09-17T00:00:00Z --state failed --yes
```

Run the dry run first and read the count. Replays are new deliveries with fresh attempt budgets, and
replaying ten thousand of them at once into a receiver that has just come back is how a recovered
receiver goes down again. Replay in windows of an hour, and set a `--rate-limit` on the endpoint before
you start.

Deliveries whose payloads have been swept by `HALYARD_RETENTION_PAYLOADS` cannot be replayed and are
reported as `HLY-1001` in the dry run's summary. If you routinely need to replay further back than seven
days, that variable is the one to change, and it is the reason the payload retention is separate from the
delivery retention at all.
