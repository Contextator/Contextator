import { existsSync } from 'node:fs';

/**
 * Where an operator command finds the database when it is run **inside the shipped container**.
 *
 * **This is a defect found by running the thing rather than by reading it, and it is
 * [ADR-0032](../.ssot/ADR.md#adr-0032)'s own failure mode one layer further out.** That entry taught
 * the image to carry `scripts/`, `src/`, `tsx` and `npm` so that `npm run reset-password -- <user>`
 * would work in the container, and [ADR-0062](../.ssot/ADR.md#adr-0062)'s release job asserts that the
 * command "reaches its usage line". It does — and then, given an actual username, it stops at
 * `Invalid configuration: Set DATABASE_URL, or the libpq variables PGHOST/PGUSER/PGPASSWORD/PGDATABASE`.
 *
 * The reason is that `docker/entrypoint.sh` puts the `PG*` variables in the environment of the **one
 * process it spawns**, and `docker exec` inherits the *image's* environment, not that process's. So
 * the embedded topology is the only one where an operator command cannot find the database, and it is
 * the topology every default installation runs. The usage-line assertion passed for eighteen days
 * because the failure is three lines after the line it checks.
 *
 * `POSTGRES_USER`, `POSTGRES_DB` and `PGDATA` *are* image environment, so `docker exec` does see them,
 * and the socket is `trust` for local connections — which is the same property that lets `pg_dump` run
 * there at all. That `trust` line is written by the PostgreSQL base image's own `initdb` wrapper and by
 * nothing in this repository: `db/init.sql` creates the extension and says nothing about
 * authentication, so an installation that replaces the base image's `pg_hba.conf` is one where this
 * falls back to `POSTGRES_PASSWORD` below. Reading those rather than baking
 * `PGHOST`/`PGUSER` into the `Dockerfile` is deliberate: an operator who overrides `POSTGRES_USER` on
 * the compose file would otherwise get a command silently pointed at a role that does not exist.
 */

/** The socket directory of the PostgreSQL in the default image, from its own base image's layout. */
const SOCKET_DIR = '/var/run/postgresql';

export type DatabaseSource = 'configured' | 'embedded';

/**
 * Fills in the libpq variables for the container's own PostgreSQL when nothing else says where the
 * database is, and returns which of the two happened.
 *
 * It never overrides anything: a `DATABASE_URL` ([ADR-0069](../.ssot/ADR.md#adr-0069)), a `PGHOST` or
 * a `PGDATABASE` already in the environment is the answer and this function is a no-op. Outside the
 * image — a checkout with no `.env`, the `slim` image, which has no `PGDATA` and no socket — it is
 * also a no-op, so the configuration error an operator sees there is the same one they saw before.
 */
export function useEmbeddedDatabaseWhenNothingElseSays(
  env: NodeJS.ProcessEnv = process.env,
  /** Injected only by the unit suite: the socket directory does not exist on a developer's host. */
  exists: (path: string) => boolean = existsSync,
): DatabaseSource {
  // Trimmed, because `describeTopology` and `connectionFromEnv` trim: `docker-compose.yml` writes
  // `DATABASE_URL: ${DATABASE_URL:-}` into the image environment, so the empty case is ordinary, and
  // a value that is whitespace must not send three functions to three different answers.
  if (env.DATABASE_URL?.trim() || env.PGHOST?.trim() || env.PGDATABASE?.trim()) return 'configured';
  if (!env.PGDATA || !exists(SOCKET_DIR)) return 'configured';

  env.PGHOST = SOCKET_DIR;
  env.PGUSER = env.POSTGRES_USER ?? 'contextator';
  env.PGDATABASE = env.POSTGRES_DB ?? 'contextator';
  if (env.POSTGRES_PASSWORD) env.PGPASSWORD = env.POSTGRES_PASSWORD;
  return 'embedded';
}
