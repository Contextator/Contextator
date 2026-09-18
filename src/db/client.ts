import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Logger } from '../context.js';
import * as schema from './schema.js';

const { Pool } = pg;

export type Db = NodePgDatabase<typeof schema>;

/**
 * Without a connection string node-postgres falls back to PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
 *
 * `log` is optional because the callers that have one are the server and the tests, and the one that
 * does not is a CLI whose output is already the terminal. What is not optional is the pool's `error`
 * handler below, so no caller can forget the thing that used to end the process.
 */
export function createDb(connectionString?: string, log?: Logger): { db: Db; pool: pg.Pool } {
  const pool = new Pool(connectionString ? { connectionString, max: 10 } : { max: 10 });

  // node-postgres emits `error` on the *pool* when a client sitting idle in it fails — a postmaster
  // that restarts into crash recovery, a `pg_terminate_backend`, a dropped network. An EventEmitter
  // with no `error` listener throws, and thrown from pg's own socket handler that is an uncaught
  // exception which ends the process: the 503 of ADR-0032 is unreachable in the case it was built
  // for. This listener is the whole fix; the pool opens fresh clients when the database returns.
  //
  // An error on a client that is *checked out* never arrives here. It rejects the query that client
  // is running, so a failing request still fails — nothing is swallowed by this.
  pool.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (log) log.error({ err: error }, 'idle database client failed; the pool will open a new one');
    else console.error(`idle database client failed; the pool will open a new one: ${message}`);
  });

  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Retries `select 1` until the database accepts connections (the container may still be starting). */
export async function waitForDb(
  db: Db,
  opts: { attempts: number; delayMs: number },
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (error) {
      lastError = error;
      onRetry?.(attempt, error);
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  throw new Error(`Database not reachable after ${opts.attempts} attempts: ${String(lastError)}`);
}
