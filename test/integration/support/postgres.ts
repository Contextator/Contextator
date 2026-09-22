import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { type ContainerRuntimeClient, getContainerRuntimeClient } from 'testcontainers';

import { bootstrapDatabase } from '../../../src/db/bootstrap.js';
import type { Logger } from '../../../src/context.js';
import { createDb, type Db } from '../../../src/db/client.js';

/**
 * The container harness for the integration suite (ADR-0031). Nothing in this file imports vitest:
 * the retrieval evaluation of ROADMAP.md Item 3 needs the same "start a database, fill it, throw it
 * away" primitives and should not have to run inside a test runner to get them.
 */

/**
 * `pgvector/pgvector:pg16` is a **floating tag**. It is rebuilt whenever PostgreSQL 16 or pgvector
 * publishes, so two runs a month apart are not guaranteed to be the same image. It lives here, in one
 * constant, so pinning it to a digest is a one-line change rather than a search — and
 * `pgvectorVersion()` below reads the installed extension version back out of the running server,
 * because Phase 1 depends on pgvector 0.8 for `hnsw.iterative_scan`. Nothing asserts on it yet; when
 * something must, `requirePgvectorAtLeast(db, '0.8')` is the whole of it.
 */
export const PGVECTOR_IMAGE = process.env.CONTEXTATOR_TEST_IMAGE ?? 'pgvector/pgvector:pg16';

/** The dimension the suite builds its schemas and its hand-written vectors at. */
export const TEST_EMBEDDING_DIMENSIONS = 384;

export interface RunningPostgres {
  /** Connection URL of the container's bootstrap database. Every test database is created from it. */
  baseUrl: string;
  /** The tag or digest the container was started from, for a failure message worth reading. */
  image: string;
  /**
   * The Docker id of the running container, so a test can run a command **inside** it.
   *
   * It is an id and not a handle because `globalSetup` and the test workers are different processes:
   * only serialisable values cross `project.provide`. `execInPostgres` below turns it back into a
   * handle in whichever worker needs one.
   */
  containerId: string;
  /**
   * A directory both the host and the container can write to — `local` as this process sees it,
   * `remote` as the container does.
   *
   * It exists for `backup-restore.itest.ts` and for one reason:
   * [ADR-0046](../../../.ssot/ADR.md#adr-0046) put `pg_dump` and `pg_restore` **inside** the container,
   * beside the server they speak to, and [ADR-0072](../../../.ssot/ADR.md#adr-0072) does not move them
   * — so the file those tools write has to reach a test that is not in there with them. A bind mount
   * is the whole of it: no base64 round trip, no copy out, and the archive the suite asserts on is the
   * archive the command wrote.
   */
  exchange: { local: string; remote: string };
  stop(): Promise<void>;
}

/** Where the exchange directory is mounted inside the container. */
export const EXCHANGE_DIR = '/exchange';

/**
 * Starts one `pgvector/pgvector:pg16` for the whole run. Callers get a base URL and are expected to
 * carve their own database out of it with `createTestDatabase`, which is what keeps test files from
 * being able to see one another.
 */
export async function startPostgres(): Promise<RunningPostgres> {
  // 0o777 because the tools run as the image's `postgres` user and this process is the host's: on
  // Linux the two are different uids over the same inode, and a directory only one of them can write
  // to is a bind mount that works on a laptop and fails in CI.
  const exchange = await mkdtemp(path.join(tmpdir(), 'contextator-exchange-'));
  await chmod(exchange, 0o777);

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(PGVECTOR_IMAGE)
    .withDatabase('contextator_test')
    .withUsername('contextator')
    .withPassword('contextator')
    // PGDATA on a tmpfs. This data is disposable by definition — it lives exactly as long as the
    // container — so writing it through to a disk buys nothing and costs most of the suite's runtime.
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    /**
     * **Docker's default `/dev/shm` is 64 MB, and one thing in this suite asks for 61 MB of it.**
     *
     * `backup-restore.itest.ts` restores a 10 048-chunk fixture, and 72 % of that restore is the one
     * `CREATE INDEX … USING hnsw` ([ADR-0046](../../../.ssot/ADR.md#adr-0046) measured it). A parallel
     * build of that index asks for a dynamic shared memory segment of **63 999 808 bytes** — 190 KB
     * under the default — so the suite has been passing on a margin of a fifth of a percent, and any
     * file added beside it that holds a second database is enough to turn that into
     * `could not resize shared memory segment … No space left on device` on roughly one run in three.
     * That was found by adding one ([ADR-0051](../../../.ssot/ADR.md#adr-0051)); it was not caused by it.
     *
     * 256 MB, because the number to size against is the index build's request and not the current
     * shortfall: a margin that is 4× the largest known allocation is one the next fixture does not
     * have to think about, and `/dev/shm` is allocated on demand — an unused tmpfs page costs nothing.
     */
    .withSharedMemorySize(256 * 1024 * 1024)
    .withBindMounts([{ source: exchange, target: EXCHANGE_DIR, mode: 'rw' }])
    .start();

  return {
    baseUrl: container.getConnectionUri(),
    image: PGVECTOR_IMAGE,
    containerId: container.getId(),
    exchange: { local: exchange, remote: EXCHANGE_DIR },
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * What `client.container.exec` resolves to — `{ output, stdout, stderr, exitCode }`. Derived from the
 * method rather than imported from `testcontainers/build/…`, which is a path inside somebody else's
 * package and not an entry point they promised.
 */
export type ExecResult = Awaited<ReturnType<ContainerRuntimeClient['container']['exec']>>;

/**
 * Runs a command inside the PostgreSQL container and returns what it printed.
 *
 * This exists for one reason: `pg_dump` and `pg_restore` ship **in the image** and have to match the
 * server they are pointed at. Running the host's copy — if there is one, at whatever version Homebrew
 * last installed — would make the backup test a test of the developer's laptop. So the tools run where
 * the server does, over its own Unix socket, and the dump file never leaves the container.
 *
 * `getContainerRuntimeClient()` is testcontainers' own way back to a container it started; the id
 * comes from `inject('postgresContainerId')`.
 */
export async function execInPostgres(containerId: string, command: string[]): Promise<ExecResult> {
  const client = await getContainerRuntimeClient();
  return client.container.exec(client.container.getById(containerId), command);
}

/**
 * `execInPostgres`, but a failure is an error rather than a non-zero number nobody looked at. Every
 * caller in the backup suite wants this one: a `pg_restore` that half worked and returned 1 would
 * otherwise be discovered three assertions later as a missing table.
 */
export async function execInPostgresOrThrow(containerId: string, command: string[]): Promise<ExecResult> {
  const result = await execInPostgres(containerId, command);
  if (result.exitCode !== 0) {
    throw new Error(`\`${command.join(' ')}\` exited ${result.exitCode} inside the container:\n${result.output}`);
  }
  return result;
}

/** Database names are interpolated into DDL that cannot take a parameter, so they are constrained. */
const DATABASE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export interface TestDatabase {
  /** The project's own Drizzle handle — the same `createDb` the server uses, on purpose. */
  db: Db;
  pool: pg.Pool;
  url: string;
  name: string;
}

/**
 * `CREATE DATABASE <name>` on the container, and a handle to it built with the product's own
 * `createDb`. A second, hand-rolled client here would mean the suite no longer exercises the one the
 * server actually opens — the pool settings, the type parsers and all.
 */
export async function createTestDatabase(baseUrl: string, name: string): Promise<TestDatabase> {
  if (!DATABASE_NAME_RE.test(name)) throw new Error(`Not a usable PostgreSQL database name: ${JSON.stringify(name)}`);

  const admin = createDb(baseUrl, silentLogger);
  try {
    // CREATE DATABASE cannot run inside a transaction block, which is why this is a bare execute.
    await admin.db.execute(sql.raw(`CREATE DATABASE ${name}`));
  } finally {
    await admin.pool.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const { db, pool } = createDb(url.toString(), silentLogger);
  return { db, pool, url: url.toString(), name };
}

/**
 * Closes the pool and drops the database. `WITH (FORCE)` terminates anything still connected: a test
 * that failed halfway through should not be able to wedge the teardown of the one after it.
 */
export async function dropTestDatabase(baseUrl: string, database: TestDatabase): Promise<void> {
  await database.pool.end();
  const admin = createDb(baseUrl, silentLogger);
  try {
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${database.name} WITH (FORCE)`));
  } finally {
    await admin.pool.end();
  }
}

/** Runs a file of SQL through the simple query protocol, so `DO $$ … $$` blocks arrive intact. */
export async function runSqlScript(database: TestDatabase, script: string): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query(script);
  } finally {
    client.release();
  }
}

/** The pgvector version the server has installed, e.g. `0.8.1`. */
export async function pgvectorVersion(db: Db): Promise<string> {
  const result = await db.execute(sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
  const row = result.rows[0] as { extversion: string } | undefined;
  if (!row) throw new Error('The `vector` extension is not installed in this database.');
  return row.extversion;
}

/**
 * Fails unless the installed pgvector is at least `minimum` (`'0.8'`, `'0.8.1'`). Unused today and
 * deliberately present: the image tag floats, and the first feature that needs a version floor should
 * find the check already written rather than discover the floor from a confusing failure.
 */
export async function requirePgvectorAtLeast(db: Db, minimum: string): Promise<string> {
  const installed = await pgvectorVersion(db);
  if (compareVersions(installed, minimum) < 0) {
    throw new Error(`This test needs pgvector >= ${minimum}, but ${PGVECTOR_IMAGE} has ${installed}. The image tag floats; pin it.`);
  }
  return installed;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The product's own startup path, against a test database: extension, journal adoption, migrations,
 * the vector dimension and the HNSW index. Every suite that needs tables goes through this rather than
 * through re-stated DDL, which is what makes the schema these tests run on the schema an operator gets.
 */
export function applySchema(database: TestDatabase, dimensions: number = TEST_EMBEDDING_DIMENSIONS): Promise<void> {
  return bootstrapDatabase(database.db, { pool: database.pool, dimensions, resetVectors: false, log: silentLogger });
}

/**
 * The bootstrap wants the Fastify logger the server hands its services. The tests have no server, and
 * a real pino instance would put the startup chatter of every case into the reporter's output.
 */
export const silentLogger: Logger = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => silentLogger,
};
