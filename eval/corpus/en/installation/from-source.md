# Building and installing from source

You need Go 1.22 or newer and a C toolchain for the SQLite-backed test fixtures. Nothing else; the
server has no Node build step and no generated assets that are not committed.

## Build

```bash
git clone https://github.com/halyard/halyard
cd halyard
make build
```

`make build` writes a single static binary to `bin/halyardctl`. The server and the command line are the
same binary — `halyardctl serve` is the server — so there is exactly one artefact to install and to
version.

```bash
sudo install -m 0755 bin/halyardctl /usr/local/bin/halyardctl
halyardctl version
```

`halyardctl version` prints the semantic version, the commit and the schema version the binary expects.
The third of those is the one to check after an upgrade: a binary that expects schema 41 against a
database at 38 will run its own migrations, and a binary that expects 38 against a database at 41 will
refuse to start with `HLY-5008`.

## Running the tests

```bash
make test           # unit tests, no database
make test-integration   # needs a PostgreSQL; honours HALYARD_TEST_DATABASE_URL
```

The integration tests create and drop their own databases inside whatever server that URL points at.
They will not run against a database that already contains a `halyard_schema_migrations` table, which is
a guard against pointing them at production by accident.

## Cross-compiling

```bash
make build GOOS=linux GOARCH=arm64
```

The release artefacts are built exactly this way, for `linux/amd64`, `linux/arm64`, `darwin/arm64` and
`windows/amd64`. Windows is supported for the command line only; `halyardctl serve` on Windows starts
and works, and is not something the project tests under load.

## Build flags worth knowing

- `make build TAGS=noscheduler` omits the scheduler entirely. Useful for a replica that should only ever
  dispatch, and more reliable than `HALYARD_SCHEDULER_ENABLED=false` because it cannot be turned back on
  by an environment file somebody edits later.
- `make build LDFLAGS_EXTRA=-X main.defaultConfigPath=/etc/halyard/halyard.env` changes where the binary
  looks for its environment file when no `--config` is given.
