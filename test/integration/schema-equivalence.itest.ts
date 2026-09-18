import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { bootstrapDatabase, MIGRATIONS_FOLDER } from '../../src/db/bootstrap.js';
import { createDb } from '../../src/db/client.js';
import { ensureSchema } from './fixtures/ensure-schema-v5.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';
import { captureSchema, renderSchemaSnapshot } from './support/schema-snapshot.js';

/**
 * The review of ADR-0033, executed rather than argued.
 *
 * Replacing a DDL ladder with generated migrations is not a refactor anybody can read their way to
 * confidence about: the two mechanisms are written in different languages, and "it looks equivalent"
 * is exactly the claim that has to be checked. So it is checked — the frozen `0.1.0` ladder on one
 * database, `bootstrapDatabase` on another, and the catalogue projection ADR-0031 left behind for
 * this purpose compared as text.
 *
 * The projection covers the `public` schema. Drizzle's journal lives in a schema of its own
 * (`drizzle.__drizzle_migrations`), so the new mechanism's own bookkeeping is outside the comparison
 * by construction rather than by an exclusion somebody had to remember to write.
 */

const baseUrl = inject('postgresBaseUrl');
const opened: TestDatabase[] = [];

afterAll(async () => {
  for (const database of opened) await dropTestDatabase(baseUrl, database);
});

async function freshDatabase(name: string): Promise<TestDatabase> {
  const database = await createTestDatabase(baseUrl, name);
  opened.push(database);
  return database;
}

async function journalRows(database: TestDatabase): Promise<Array<{ hash: string; created_at: string }>> {
  const result = await database.db.execute(sql`SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`);
  return result.rows as Array<{ hash: string; created_at: string }>;
}

describe('the generated baseline against the DDL ladder it replaces', () => {
  it('produces an identical catalogue projection', async () => {
    const [ladderDb, migratedDb] = await Promise.all([freshDatabase('equiv_ladder'), freshDatabase('equiv_migrated')]);

    await ensureSchema(ladderDb.db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });
    await applySchema(migratedDb);

    const ladder = await captureSchema(ladderDb.db);
    const migrated = await captureSchema(migratedDb.db);

    // As text first: a failure here is readable as a diff, which is the point of the helper.
    expect(renderSchemaSnapshot(migrated)).toBe(renderSchemaSnapshot(ladder));
    expect(migrated).toEqual(ladder);
  });
});

describe('adopting a database that already has the schema', () => {
  it('records exactly one journal row and changes no DDL', async () => {
    const database = await freshDatabase('equiv_adopt');

    // The shape a `0.1.0` installation is sitting at right now: schema 5, and no journal at all.
    await ensureSchema(database.db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });
    const before = await captureSchema(database.db);
    const journalTable = await database.db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`);
    expect((journalTable.rows[0] as { present: boolean }).present).toBe(false);

    await applySchema(database);

    expect(renderSchemaSnapshot(await captureSchema(database.db))).toBe(renderSchemaSnapshot(before));

    // One row, and it is drizzle's own hash of the baseline file — not a hand-rolled digest that
    // merely looks like one. A row whose hash disagreed would describe a migration nobody applied.
    const rows = await journalRows(database);
    expect(rows).toHaveLength(1);
    const baseline = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })[0];
    expect(baseline).toBeDefined();
    expect(rows[0]?.hash).toBe(baseline?.hash);
    expect(Number(rows[0]?.created_at)).toBe(baseline?.folderMillis);
  });
});

describe('a fresh database at a non-default dimension', () => {
  it('ends up at vector(1536) although the migration says 384', async () => {
    const database = await freshDatabase('equiv_dimension_1536');
    await applySchema(database, 1536);

    const embedding = await database.db.execute(sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a WHERE a.attrelid = 'chunks'::regclass AND a.attname = 'embedding'`);
    expect((embedding.rows[0] as { type: string }).type).toBe('vector(1536)');

    // And the index that could not have been built before the column was re-typed exists on it.
    const index = await database.db.execute(sql`
      SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.relname = 'chunks_embedding_hnsw_idx'`);
    expect((index.rows[0] as { amname: string }).amname).toBe('hnsw');

    const settings = await database.db.execute(sql`SELECT value FROM settings WHERE key = 'embedding_dimensions'`);
    expect((settings.rows[0] as { value: string }).value).toBe('1536');
  });

  it('leaves no dimension but 384 anywhere in the committed migrations', async () => {
    // The guard against the obvious accident: somebody regenerating the baseline on a box configured
    // for 1536 and committing a migration that strands every 384 deployment. `schema.ts` holds a
    // constant precisely so this can never come from the environment — this is that claim, checked.
    const files = (await readdir(MIGRATIONS_FOLDER)).filter((name) => name.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(0);

    const found: string[] = [];
    for (const file of files) {
      const text = await readFile(join(MIGRATIONS_FOLDER, file), 'utf8');
      for (const match of text.matchAll(/vector\((\d+)\)/g)) found.push(`${file}: vector(${match[1]})`);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((entry) => !entry.endsWith('vector(384)'))).toEqual([]);
  });
});

describe('two containers starting at once', () => {
  it('both succeed and leave one journal row', async () => {
    const database = await freshDatabase('equiv_concurrent');

    // Two separate pools, because that is what two containers are. One pool would let both bootstraps
    // share a connection and hide the thing being tested.
    const first = createDb(database.url, silentLogger);
    const second = createDb(database.url, silentLogger);
    try {
      const options = { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger };
      await expect(
        Promise.all([bootstrapDatabase(first.db, { ...options, pool: first.pool }), bootstrapDatabase(second.db, { ...options, pool: second.pool })]),
      ).resolves.toEqual([undefined, undefined]);
    } finally {
      await first.pool.end();
      await second.pool.end();
    }

    // The session-scoped advisory lock is the whole reason this is one row rather than two, or a
    // duplicate-table error from whichever start lost the race.
    expect(await journalRows(database)).toHaveLength(1);

    const settings = await database.db.execute(sql`SELECT key, value FROM settings ORDER BY key`);
    expect(settings.rows).toHaveLength(2);
  });
});
