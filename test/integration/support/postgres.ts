import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type pg from 'pg';

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
  stop(): Promise<void>;
}

/**
 * Starts one `pgvector/pgvector:pg16` for the whole run. Callers get a base URL and are expected to
 * carve their own database out of it with `createTestDatabase`, which is what keeps test files from
 * being able to see one another.
 */
export async function startPostgres(): Promise<RunningPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(PGVECTOR_IMAGE)
    .withDatabase('contextator_test')
    .withUsername('contextator')
    .withPassword('contextator')
    // PGDATA on a tmpfs. This data is disposable by definition — it lives exactly as long as the
    // container — so writing it through to a disk buys nothing and costs most of the suite's runtime.
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();

  return {
    baseUrl: container.getConnectionUri(),
    image: PGVECTOR_IMAGE,
    stop: async () => {
      await container.stop();
    },
  };
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
