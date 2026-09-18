# halyardctl command reference

One binary is the server and the command line. Every command reads the same environment as the server
and accepts `--config <file>` to load it from a file of `KEY=value` lines first.

Global flags, accepted by every subcommand:

- `--config <path>` — environment file to load before anything else.
- `--output <format>` — `table` (default), `json` or `jsonl`. Scripts should use `jsonl`; the table
  layout is for people and changes between releases without notice.
- `--timeout <duration>` — how long the command waits on the database or the API. Default `30s`.
- `-q`, `--quiet` — suppress progress output; errors still go to stderr.

## halyardctl serve

Starts the API listener, the dispatch workers and the scheduler. The only subcommand that runs
indefinitely.

- `--drain-timeout <duration>` — overrides `HALYARD_DRAIN_TIMEOUT` for this process. On `SIGTERM` the
  listener stops accepting immediately, in-flight deliveries are given this long to finish, and anything
  still running when it elapses is abandoned and will be retried elsewhere.
- `--no-scheduler` — equivalent to `HALYARD_SCHEDULER_ENABLED=false`.

## halyardctl migrate

Applies outstanding migrations and exits. Safe to run concurrently: it takes an advisory lock, and the
processes that do not get it wait and then find nothing to do.

- `--to <version>` — stop after this migration instead of applying all of them.
- `--dry-run` — print the migrations that would be applied, with their checksums, and change nothing.

## halyardctl doctor

The first thing to run when something is wrong. It checks the database connection, the schema version
against the binary, the writability of `HALYARD_DATA_DIR`, the signing configuration, clock skew against
the database server, and whether any endpoint URL currently resolves to an address the delivery-time
check would refuse. It writes nothing and exits `1` if any check fails.

## halyardctl endpoints

- `list [--enabled|--disabled] [--event-type <type>]`
- `create --url <url> --event-type <type> [--event-type <type>…]`
- `update <endpoint_id> [--url …] [--max-in-flight <n>] [--rate-limit <n>/<unit>] [--enable|--disable]`
- `delete <endpoint_id> --confirm` — refuses without `--confirm`, and deletes the endpoint's delivery
  history with it.

## halyardctl deliveries

- `list [--event-id|--endpoint-id|--state|--since|--until] [--watch]` — `--watch` polls and appends new
  rows until interrupted.
- `show <delivery_id>` — the delivery with its full attempt history, the same data as the API.
- `replay --delivery-id <id>` — replay one.
- `replay --endpoint <id> --since <time> [--state failed]` — replay in bulk. Prints how many deliveries
  match and asks for confirmation unless `--yes` is given. This is the command that turns a receiver
  outage into a recovered afternoon, and the one most worth reading the `--dry-run` output of first.

## halyardctl keys

- `mint --name <name> --scope <scope>` — prints the key exactly once. Scopes are `events:write`,
  `deliveries:read`, `deliveries:replay`, `endpoints:write` and `admin`.
- `list` — names, prefixes, scopes, creation and last-use times. Never the key.
- `revoke <key_id>` — takes effect on the next request, not at the next restart.

## halyardctl backup and halyardctl restore

- `backup create --output <path>` — a consistent snapshot of the database and the payload spool.
- `restore --from <path> --confirm` — refuses to run against a database that is not empty.

Both are described properly in the backup and restore guide, including the one ordering constraint that
makes the difference between a restore that works and one that is missing bodies.

## halyardctl drain

Marks this replica as draining: it stops claiming new work and exits when the work it holds is finished
or `--drain-timeout` elapses. Intended for a rolling deploy where you would rather not rely on `SIGTERM`
arriving at a moment of your choosing.
