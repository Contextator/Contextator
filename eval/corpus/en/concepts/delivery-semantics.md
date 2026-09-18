# Delivery semantics

This page is the contract. Everything a receiver has to be written to survive is here, and the two
guarantees people assume Halyard offers and it does not are stated first, because assuming either one is
how a correct-looking integration corrupts data six months later.

## At least once, never exactly once

A delivery is attempted until the receiver answers `2xx` or the attempt budget is exhausted. If the
receiver processes a request and the response is lost — a connection reset after the body was read, a
proxy that timed out while the handler was still committing, a receiver that crashed after its own commit
and before its reply — Halyard has no way to distinguish that from a request that never arrived, so it
retries.

Your receiver will therefore see the same delivery twice. Not often, and not never. The fix is not on
Halyard's side and cannot be: deduplicate on `X-Halyard-Delivery-Id`, which is stable across every
attempt of one delivery. Record it in the same transaction as the work the delivery causes, and treat a
duplicate id as success without redoing the work. A delivery id is 26 characters and keeping them for a
week is a small table.

Note that `X-Halyard-Event-Id` is not the right key for this. One event fans out to several endpoints and
a replay of a delivery produces a new delivery id for the same event id; deduplicating on the event would
make a deliberate replay a no-op, which is the opposite of what a replay is for.

## No ordering guarantee, in any sense

Two events published in order are not delivered in order. There is no per-endpoint ordering, no
per-event-type ordering and no per-payload-key ordering. Deliveries are claimed by whichever worker on
whichever replica is free, retries reorder things further, and a delivery that fails once lands after
events published minutes later.

This is a design decision rather than a limitation that will be lifted. Ordered delivery requires a
single consumer per ordering key, and that means one slow receiver stalls a queue rather than one
worker — the failure mode the dispatch tuning page exists to avoid. If you need order, put a sequence
number or a version in your payload and let the receiver discard what it has already seen. A receiver
that can tell a stale update from a fresh one is a receiver that also survives its own restarts, which is
a property you want for other reasons.

## What a receiver must do

Answer quickly. The attempt timeout is `HALYARD_DISPATCH_TIMEOUT`, 15 seconds by default, and a receiver
that habitually takes ten of them is occupying a dispatch worker for ten seconds per delivery. The
established shape is to validate, persist and answer `202`, then do the work asynchronously.

Answer honestly. A receiver that returns `200` after a failure so that Halyard will stop retrying has
thrown the event away, and nothing in Halyard's records will suggest anything went wrong. Return `500`
and let the retry happen.

Verify the signature before parsing the body, and compare in constant time. The signing reference has the
exact bytes; the important part is that the timestamp is signed together with the body, so a replay of a
captured request is detectable and a body swapped under a captured signature is not accepted.

Be prepared for a body that is larger than you expect and for fields you do not know. New fields appear
in payloads within a major version.

## What Halyard guarantees

- **Durability before acknowledgement.** `202` from `POST /v1/events` means the event and its deliveries
  are committed. A crash immediately afterwards loses nothing.
- **Idempotent publishing, within a window.** With `X-Halyard-Idempotency-Key`, a repeat within 24 hours
  returns the original response and creates no second event. Without it, a retried publish creates a
  second event and a second set of deliveries.
- **At most one in-flight attempt per delivery.** A lease makes sure two replicas do not attempt the same
  delivery at the same time. The lease has a duration, and a replica that is partitioned rather than dead
  can in principle still be attempting a delivery whose lease has expired — which is another way of
  arriving at the first section of this page.
- **A complete attempt history**, for `HALYARD_RETENTION_DELIVERIES`, including the status and the first
  4 KiB of the body of every failed attempt.

## The retry schedule, concretely

With the defaults — base `2s`, doubling, capped at `6h`, twelve attempts — a delivery that never succeeds
is attempted at roughly 2s, 4s, 8s, 16s, 32s, 1m, 2m, 4m, 8m, 17m, 34m and 68m after the first failure,
and is abandoned about two and a half hours later. Raising `HALYARD_MAX_ATTEMPTS` to 18 pushes the tail
out to roughly three days, because by then every delay has reached the six-hour cap. Each attempt's delay
carries a jitter of up to 10 percent so that a receiver coming back from an outage is not hit by every
pending delivery in the same instant.
