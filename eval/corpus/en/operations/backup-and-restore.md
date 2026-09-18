# Backup and restore

Halyard's state is the database plus the payload spool in `HALYARD_DATA_DIR`. A backup of one without the
other is not a backup, and the order in which you take them decides which of the two failure modes you
get.

## Take the database first, the spool second

A payload is written to the spool before the event row that references it is committed. So:

- Database first, then spool: the spool may contain files nothing references. Harmless; the sweeper
  removes them.
- Spool first, then database: the database may reference a file the spool does not have. That is a
  delivery that cannot be sent and a replay that fails with `HLY-1001`.

The first ordering is the one to use, and it is what `halyardctl backup create` does.

## halyardctl backup create

```bash
halyardctl backup create --output /backups/halyard-$(date -u +%Y%m%dT%H%M%SZ).tar.zst
```

It takes a repeatable-read snapshot of the database, streams it, then copies the spool files the snapshot
references. The archive holds a manifest with the schema version, the Halyard version and the snapshot
timestamp. Restoring into a binary older than the recorded schema version is refused.

`--exclude-payloads` produces a much smaller archive that can restore a working deployment but cannot
replay anything older than what is still in the database inline. It is a reasonable daily companion to a
weekly full backup, not a replacement for one.

## Restoring

```bash
halyardctl restore --from /backups/halyard-20260918T031500Z.tar.zst --confirm
```

The target database must be empty. Restoring over a database that already has tables is refused, without
a flag to override it: a partial overlay of one deployment's events onto another's is not something a
tool should make easy.

After a restore, before starting the server:

```bash
halyardctl doctor
```

The check that matters here is the spool. `doctor` reports how many referenced payload files are missing,
and if that number is not zero, the restore was taken in the wrong order or the archive was truncated.

## What a restore means for deliveries in flight

Every delivery that was `in_flight` at snapshot time comes back as `pending` with its lease expired,
because a lease is a row and the row is as old as the snapshot. Those deliveries are attempted again. A
receiver that already processed them sees a duplicate — which is the ordinary at-least-once case your
receiver already deduplicates, and if it does not, a restore is when you find out.

Deliveries that succeeded after the snapshot and before the failure are, from the restored database's
point of view, still pending. They will be delivered again too. There is no way around this: the record
of their success was in the part of the database that was lost.

## Point-in-time recovery

`halyardctl backup` is a snapshot tool and nothing more. If you need recovery to an arbitrary instant,
use PostgreSQL's own WAL archiving for the database and a filesystem snapshot for the spool, taken in the
same order as above, and treat `halyardctl backup` as the thing you test restores with. The
`restore --from` path is still the one to use for moving a deployment between hosts.

## Testing a restore

A backup nobody has restored is a hypothesis. The cheap version of the test:

```bash
createdb halyard_restore_test
HALYARD_DATABASE_URL=postgres://…/halyard_restore_test \
  halyardctl restore --from /backups/latest.tar.zst --confirm
HALYARD_DATABASE_URL=postgres://…/halyard_restore_test halyardctl doctor
dropdb halyard_restore_test
```

Four commands, a few minutes, and it catches the two things that actually go wrong: an archive truncated
by a full disk, and a spool taken before the database.
