import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

import type { Logger } from '../context.js';
import type { Db } from './client.js';

export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

export interface BootstrapOptions {
  /**
   * The pool the `db` handle was built from. The bootstrap needs one connection it can keep, because
   * the advisory lock below is session-scoped and `db.execute` may take a different client each time.
   */
  pool: pg.Pool;
  /** Vector dimension from config. The real type of `chunks.embedding` is settled against it. */
  dimensions: number;
  /** When true, drops all chunks/documents and re-types the vector column to `dimensions`. */
  resetVectors: boolean;
  log: Logger;
}

/**
 * The last hand-numbered schema version, and the only one this code can adopt into the migration
 * journal ([ADR-0033](../../.ssot/ADR.md#adr-0033)). It is frozen: from `0000_baseline` onwards the
 * journal is what says how far a database has come, and the row survives only so that a `0.1.0`
 * database can be recognised as one.
 */
const ADOPTABLE_SCHEMA_VERSION = '5';

/** The migration the adopt path marks applied. Checked against the journal file, never assumed. */
const BASELINE_TAG = '0000_baseline';

/**
 * Same key as the DDL ladder it replaces, so an old binary and a new one starting against one database
 * still exclude each other.
 */
const ADVISORY_LOCK_KEY = 7213001;

/**
 * `drizzle/` beside the package root, resolved from this module rather than from `process.cwd()`:
 * `dist/db/bootstrap.js` and `src/db/bootstrap.ts` are both two directories deep, so the same
 * expression finds `/app/drizzle` in the image and `<repo>/drizzle` under `tsx` and under vitest.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Brings a database up to the schema this build expects, on every start, with nothing for the operator
 * to run (P2). Five phases, in this order and for these reasons:
 *
 * 1. `CREATE EXTENSION vector` — the baseline migration declares a `vector` column and cannot install
 *    the type that column needs.
 * 2. `adoptBaselineIfNeeded` — a `0.1.0` database already has every table and no journal; applying the
 *    baseline to it would fail on the first `CREATE TABLE`.
 * 3. `migrate()` — drizzle applies whatever the journal says is outstanding.
 * 4. The dimension, the HNSW index and the legacy backfill — the three things that cannot be
 *    generated SQL, because the first is a deploy-time setting, the second depends on the first, and
 *    the third is a loop over rows.
 * 5. `content_tsv` for the chunks that predate it — a loop over rows for the same reason, and one
 *    that must not be inside phase 4's single transaction, because it rewrites every chunk of an
 *    existing installation ([ADR-0041](../../.ssot/ADR.md#adr-0041)).
 *
 * The whole of it runs under a **session-scoped** advisory lock. The transaction-scoped lock this
 * replaces could not span the phases, because `migrate()` opens transactions of its own.
 */
export async function bootstrapDatabase(db: Db, opts: BootstrapOptions): Promise<void> {
  const dims = Math.trunc(opts.dimensions); // validated integer, safe to interpolate into DDL

  // One dedicated connection, held for the duration: `pg_advisory_lock` belongs to the session that
  // took it, and a pooled `db.execute` is not guaranteed to come back to the same one.
  const locker = await opts.pool.connect();
  try {
    await locker.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
      await adoptBaselineIfNeeded(db, opts.log);
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await settleDimensionAndIndex(db, dims, opts);
      await backfillContentTsv(db, opts.log);
    } finally {
      // Released explicitly rather than left to the connection: this client goes back to the pool and
      // would carry the lock with it, and the next start would wait on a lock nobody is using.
      //
      // Best-effort, because this runs on the failure path too and a throw here would replace the
      // error that actually stopped the start — including the `SchemaMismatchError` that server.ts
      // turns into a readable fatal. A session that cannot answer has dropped its locks anyway.
      await locker
        .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
        .catch((error: unknown) => opts.log.warn({ err: error }, 'could not release the bootstrap advisory lock'));
    }
  } finally {
    locker.release();
  }

  opts.log.info({ dimensions: dims, schemaVersion: ADOPTABLE_SCHEMA_VERSION }, 'database schema ready');
}

/**
 * Everything the generated migrations deliberately do not contain, in one transaction.
 *
 * The dimension is the reason this function exists at all. `chunks.embedding` is `vector(384)` in
 * `drizzle/0000_baseline.sql` because a migration file has to say *some* number; the number an
 * installation actually runs at is `EMBEDDING_DIMENSIONS`, and it is settled here, once, against the
 * `settings` row that records it.
 */
async function settleDimensionAndIndex(db: Db, dims: number, opts: BootstrapOptions): Promise<void> {
  await db.transaction(async (tx) => {
    const run = (statement: string) => tx.execute(sql.raw(statement));

    const stored = await tx.execute(sql`SELECT value FROM settings WHERE key = 'embedding_dimensions'`);
    const storedDims = stored.rows[0] ? Number((stored.rows[0] as { value: string }).value) : undefined;

    if (storedDims === undefined) {
      // No recorded dimension: either a database the baseline has just created, or one whose setting
      // never existed. Either way the column type is whatever the migration said, and this is the one
      // moment it can be changed — before the HNSW index exists and before a single row is written.
      const actual = await embeddingColumnDimensions(tx);
      if (actual !== dims) await run(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${dims})`);
    } else if (storedDims !== dims) {
      if (!opts.resetVectors) {
        throw new SchemaMismatchError(
          `The database was created with EMBEDDING_DIMENSIONS=${storedDims} but the current config says ${dims}. ` +
            `Either set EMBEDDING_DIMENSIONS=${storedDims}, or start once with RESET_VECTORS=1 ` +
            `(drops every indexed chunk; all projects must be re-indexed), or wipe the pgdata volume.`,
        );
      }
      opts.log.warn({ from: storedDims, to: dims }, 'RESET_VECTORS=1: dropping all chunks and re-typing the embedding column');
      await run(`DROP INDEX IF EXISTS chunks_embedding_hnsw_idx`);
      await run(`TRUNCATE chunks`);
      await run(`DELETE FROM documents`);
      await run(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${dims})`);
      await run(
        `UPDATE projects SET chunk_count = 0, document_count = 0, status = 'idle', last_indexed_at = NULL, embedding_model = NULL, last_error = NULL`,
      );
      await run(`UPDATE settings SET value = '${dims}', updated_at = now() WHERE key = 'embedding_dimensions'`);
    }

    // After the column type and never in a migration: an HNSW index needs a fixed dimension, and it
    // blocks the `ALTER COLUMN … TYPE` above while it exists. `m` and `ef_construction` are NFR-02.
    await run(`CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
      ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);

    await migrateLegacyRootPaths(tx, opts.log);

    await run(`INSERT INTO settings (key, value) VALUES
      ('embedding_dimensions', '${dims}'),
      ('schema_version', '${ADOPTABLE_SCHEMA_VERSION}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE settings.key = 'schema_version'`);
  });
}

/** How many chunks one backfill statement rewrites before coming up for air. */
const TSV_BACKFILL_BATCH = 2_000;

/** Safety valve, as in `sweepGenerations`: a loop against a live table must not be able to spin forever. */
const TSV_BACKFILL_MAX_BATCHES = 50_000;

/**
 * Fills `chunks.content_tsv` for every chunk written before it existed
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)).
 *
 * **Why this is not "the next index run will fix it".** It would not. An incremental run skips every
 * file whose sha256 is unchanged, which after an upgrade is all of them, so an installation would
 * carry an empty lexical half until somebody forced a rebuild — and a rebuild re-embeds the entire
 * corpus to produce a column that is a pure function of text already in the database. The vector is
 * the expensive half; this one is `to_tsvector` over rows that are already here.
 *
 * `simple`, and not the per-source language, because the query side is `simple` in this version and
 * the two have to agree. A source that names a language gets its own configuration on its next run.
 *
 * Batched and outside the migration's transaction: one `UPDATE` over a large `chunks` would hold row
 * locks for its whole duration and write a write-ahead log the size of the table. Idempotent by the
 * `IS NULL` guard, so the steady-state cost of running it at every start is one query that matches
 * nothing.
 */
async function backfillContentTsv(db: Db, log: Logger): Promise<void> {
  let filled = 0;
  for (let batch = 0; batch < TSV_BACKFILL_MAX_BATCHES; batch++) {
    const updated = await db.execute(sql`
      UPDATE chunks SET content_tsv = to_tsvector('simple', heading_path || ' ' || content)
      WHERE id IN (SELECT id FROM chunks WHERE content_tsv IS NULL LIMIT ${TSV_BACKFILL_BATCH})`);
    // `rowCount` is `number | null` on the driver's result type. Nothing here produces the null, but
    // a loop whose exit condition is `=== 0` and whose value can be null is a loop that runs fifty
    // thousand times to find that out.
    const rows = updated.rowCount ?? 0;
    if (rows === 0) break;
    filled += rows;
  }
  if (filled > 0) log.info({ chunks: filled }, 'filled the lexical index of chunks written before hybrid search');
}

/** The dimension `chunks.embedding` currently carries, read out of the catalogue. */
async function embeddingColumnDimensions(tx: Tx): Promise<number | undefined> {
  const result = await tx.execute(sql`
    SELECT format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid = 'chunks'::regclass AND a.attname = 'embedding'`);
  const type = result.rows[0] ? (result.rows[0] as { type: string }).type : undefined;
  const match = type?.match(/^vector\((\d+)\)$/);
  return match ? Number(match[1]) : undefined;
}

interface MigrationJournal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

/**
 * The existing-database problem. An installation at schema version 5 has every table the baseline
 * would create and no journal to say so, and `migrate()` would try to create them again.
 *
 * Marking the baseline applied is therefore part of starting up, not a command somebody has to
 * remember (P2 again). Three cases, and only the first writes anything:
 *
 * - **No journal row, `settings.schema_version = 5`** — a `0.1.0` database. Insert the row.
 * - **No journal and no `settings` table** — an empty database. Do nothing; `migrate()` runs the
 *   baseline the ordinary way.
 * - **No journal and a `schema_version` below 5** — refuse, and say what closes the gap. There are no
 *   production installations older than this, and carrying the ladder forward just to support a shape
 *   nobody runs would keep the file this decision exists to delete.
 *
 * The hash is drizzle's own, from `readMigrationFiles`. A hand-rolled sha256 that disagreed by a byte
 * would put a row in the journal that does not describe the migration it claims to.
 */
async function adoptBaselineIfNeeded(db: Db, log: Logger): Promise<void> {
  const journalTable = await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`);
  if ((journalTable.rows[0] as { present: boolean }).present) {
    const applied = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    if ((applied.rows[0] as { n: number }).n > 0) return;
  }

  const settingsTable = await db.execute(sql`SELECT to_regclass('public.settings') IS NOT NULL AS present`);
  if (!(settingsTable.rows[0] as { present: boolean }).present) return;

  const version = await db.execute(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
  const found = version.rows[0] ? (version.rows[0] as { value: string }).value : undefined;
  if (found !== ADOPTABLE_SCHEMA_VERSION) {
    throw new SchemaMismatchError(
      `This database reports schema_version=${found ?? 'none'} and has no migration journal, so there is nothing this ` +
        `build can safely apply to it. Start Contextator 0.1.0 against it once — that brings it to schema version ` +
        `${ADOPTABLE_SCHEMA_VERSION} — and then upgrade to this version, or restore a dump into an empty volume.`,
    );
  }

  // The tag is read rather than assumed: if the baseline is ever renamed or re-cut, this must stop
  // rather than mark the wrong migration applied.
  const journal = JSON.parse(await readFile(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as MigrationJournal;
  const first = journal.entries[0];
  if (!first || first.tag !== BASELINE_TAG) {
    throw new SchemaMismatchError(`Expected ${BASELINE_TAG} to be the first migration in ${MIGRATIONS_FOLDER}/meta/_journal.json.`);
  }
  const baseline = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })[0];
  if (!baseline) throw new SchemaMismatchError(`No migration files were found in ${MIGRATIONS_FOLDER}.`);

  // The same table drizzle's own migrator creates, created the same way, so the `migrate()` two lines
  // later finds what it expects rather than something that merely resembles it.
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    await tx.execute(sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES (${baseline.hash}, ${baseline.folderMillis})`);
  });

  log.info({ tag: BASELINE_TAG, schemaVersion: found }, 'adopted an existing schema into the migration journal');
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Mirrors PROJECT_NAME_RE without importing config (schema code stays dependency-free). */
function legacySourceName(rootPath: string, taken: Set<string>): string {
  const base =
    rootPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  let name = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) name = 'local';
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name.slice(0, 60)}-${i}`;
  return candidate;
}

/**
 * v3 data migration, idempotent: every project that still has a `root_path` but no source gets a
 * `local` source, and its documents are re-keyed under `<source>/…` so the next run re-embeds nothing.
 *
 * This stays procedural and stays here. It is a loop over rows that mints a name from a path and then
 * writes rows that depend on the one before, which is not something `drizzle-kit generate` can emit —
 * and it is idempotent by its `NOT EXISTS` guard, so running it on every start costs one query.
 */
async function migrateLegacyRootPaths(tx: Tx, log: Logger): Promise<void> {
  const legacy = await tx.execute(sql`
    SELECT p.id, p.root_path FROM projects p
    WHERE p.root_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_sources s WHERE s.project_id = p.id)`);
  for (const row of legacy.rows as Array<{ id: string; root_path: string }>) {
    const name = legacySourceName(row.root_path, new Set());
    const config = JSON.stringify({ path: row.root_path, extensions: ['md', 'mdx'] });
    const inserted = await tx.execute(sql`
      INSERT INTO document_sources (project_id, type, name, label, config)
      VALUES (${row.id}, 'local', ${name}, 'Local directory', ${config}::jsonb)
      RETURNING id`);
    const sourceId = (inserted.rows[0] as { id: string }).id;
    await tx.execute(sql`
      UPDATE documents SET source_id = ${sourceId}, relative_path = ${name} || '/' || relative_path
      WHERE project_id = ${row.id} AND source_id IS NULL`);
    await tx.execute(
      sql`UPDATE document_sources SET document_count = (SELECT count(*) FROM documents WHERE source_id = ${sourceId}) WHERE id = ${sourceId}`,
    );
    log.info({ projectId: row.id, source: name, rootPath: row.root_path }, 'migrated legacy project root to a local source');
  }
}
