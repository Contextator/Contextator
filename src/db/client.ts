import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

const { Pool } = pg;

export type Db = NodePgDatabase<typeof schema>;

/** Without a connection string node-postgres falls back to PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. */
export function createDb(connectionString?: string): { db: Db; pool: pg.Pool } {
  const pool = new Pool(connectionString ? { connectionString, max: 10 } : { max: 10 });
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
