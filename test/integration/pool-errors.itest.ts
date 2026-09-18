import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Logger } from '../../src/context.js';
import { createDb } from '../../src/db/client.js';
import { createTestDatabase, dropTestDatabase, silentLogger, type TestDatabase } from './support/postgres.js';

/**
 * The failure ADR-0032 left open: PostgreSQL does not only refuse new connections, it also hangs up on
 * established ones — a restart into crash recovery terminates every backend it finds. node-postgres
 * reports that on the *pool*, and an EventEmitter whose `error` nobody listens for throws; from pg's
 * socket handler that is an uncaught exception and the process is gone, which is precisely when the
 * 503 was supposed to be answered.
 *
 * So the test does the thing rather than inspecting the wiring: it lets a client go idle in a real
 * pool, terminates that exact backend from a second connection, and asks the pool for another query.
 * It deliberately attaches **no** listener of its own to the pool under test — one would stop the
 * EventEmitter throwing, and the test would pass with the fix taken back out.
 *
 * What it cannot show is the process dying, because vitest's worker installs its own
 * `uncaughtException` handler and survives what the server would not. Taking the handler out of
 * `createDb` was tried: the run goes red and exits 1, this case fails on "the pool never reported the
 * terminated idle client", and vitest reports the uncaught `terminating connection due to
 * administrator command` beside it — the same error, from the same `TCP.onStreamRead` frame, that
 * ends the real process. So what is asserted here is that the error is caught and reported and the
 * pool keeps working; that catching it is also what keeps the process alive is the runtime's rule,
 * not something this file can demonstrate.
 */

const baseUrl = inject('postgresBaseUrl');

/** The killer connection, and the teardown. Never the pool being terminated. */
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'pool_errors');
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

/** `silentLogger` with `error` teed into an array, so the handler's own line is the thing asserted. */
function recordingLogger(sink: string[]): Logger {
  const logger: Logger = {
    ...silentLogger,
    error: (first: unknown, second?: string) => {
      sink.push(typeof first === 'string' ? first : (second ?? ''));
    },
    child: () => logger,
  };
  return logger;
}

async function waitFor(condition: () => boolean, complaint: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(complaint);
}

describe('when PostgreSQL terminates a connection sitting idle in the pool', () => {
  it('logs it, leaves the process running, and serves the next query from a fresh client', async () => {
    const logged: string[] = [];
    const app = createDb(database.url, recordingLogger(logged));
    try {
      // One query. The client that ran it goes back into the pool, and idle is the only state whose
      // failure reaches `pool.on('error')` at all.
      const first = await app.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      const pid = Number(first.rows[0]?.pid);
      expect(Number.isInteger(pid)).toBe(true);
      expect(app.pool.idleCount).toBe(1);

      // From the other pool, so the kill cannot land on the connection issuing it, and scoped to the
      // one pid rather than to the database — `pg_stat_activity` is cluster-wide and a WHERE on the
      // database name would take the killer with it.
      const killed = await database.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ${pid}`);
      expect(killed.rows).toHaveLength(1);

      await waitFor(() => logged.length > 0, 'The pool never reported the terminated idle client.');
      expect(logged[0]).toContain('idle database client failed');

      // Still here — and pg opened a new backend rather than handing the dead one back.
      const second = await app.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      expect(Number(second.rows[0]?.pid)).not.toBe(pid);
    } finally {
      await app.pool.end();
    }
  });

  it('keeps a running query failing, rather than routing its error into the pool handler', async () => {
    const logged: string[] = [];
    const app = createDb(database.url, recordingLogger(logged));
    const client = await app.pool.connect();
    try {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = Number(rows[0]?.pid);

      // Checked out and busy. pg removes the pool's idle listener for the duration, so this error
      // belongs to the query and must still reject it: the handler is not allowed to turn a failing
      // request into a silent one.
      // The handler goes on now rather than after the kill: the rejection lands the moment the
      // backend dies, and a promise that rejects with nothing attached is an unhandled rejection —
      // which is noise from the test, not from the code under test.
      const outcome = client.query('SELECT pg_sleep(30)').then(
        () => undefined,
        (error: unknown) => error,
      );
      // Long enough for the sleep to have reached the server: terminating a backend that has not yet
      // been handed the query would prove something else.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await database.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ${pid}`);

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/terminating connection/);
      expect(logged).toEqual([]);
    } finally {
      client.release(true);
      await app.pool.end();
    }
  });
});
