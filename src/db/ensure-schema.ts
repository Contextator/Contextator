import { sql } from 'drizzle-orm';
import type { Logger } from '../context.js';
import type { Db } from './client.js';

export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

export interface EnsureSchemaOptions {
  /** Vector dimension from config. Baked into the `chunks.embedding` column type. */
  dimensions: number;
  /** When true, drops all chunks/documents and re-types the vector column to `dimensions`. */
  resetVectors: boolean;
  log: Logger;
}

const SCHEMA_VERSION = 4;
const ADVISORY_LOCK_KEY = 7213001;

/**
 * Idempotent DDL applied on every start. Chosen over drizzle-kit migrations because the
 * vector dimension is a deploy-time setting: generated migrations would hard-code it.
 * Keep this in sync with src/db/schema.ts.
 */
export async function ensureSchema(db: Db, opts: EnsureSchemaOptions): Promise<void> {
  const dims = Math.trunc(opts.dimensions); // validated integer, safe to interpolate into DDL

  await db.transaction(async (tx) => {
    const run = (statement: string) => tx.execute(sql.raw(statement));

    await run(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
    await run(`CREATE EXTENSION IF NOT EXISTS vector`);
    await run(`DO $$ BEGIN
      CREATE TYPE project_status AS ENUM ('idle', 'indexing', 'error');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

    await run(`CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await run(`CREATE TABLE IF NOT EXISTS projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      root_path text NOT NULL,
      status project_status NOT NULL DEFAULT 'idle',
      chunk_count integer NOT NULL DEFAULT 0,
      document_count integer NOT NULL DEFAULT 0,
      last_indexed_at timestamptz,
      last_error text,
      embedding_model text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

    // v3: projects may have several sources; root_path is legacy and no longer required.
    await run(`ALTER TABLE projects ALTER COLUMN root_path DROP NOT NULL`);

    await run(`CREATE TABLE IF NOT EXISTS document_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type text NOT NULL,
      name text NOT NULL,
      label text NOT NULL DEFAULT '',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      secret_enc text,
      webhook_secret text,
      flavor text NOT NULL DEFAULT 'plain',
      status text NOT NULL DEFAULT 'idle',
      last_synced_at timestamptz,
      last_error text,
      document_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT document_sources_project_name_uq UNIQUE (project_id, name)
    )`);
    await run(`CREATE INDEX IF NOT EXISTS document_sources_project_idx ON document_sources (project_id)`);

    await run(`CREATE TABLE IF NOT EXISTS documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id uuid REFERENCES document_sources(id) ON DELETE CASCADE,
      relative_path text NOT NULL,
      title text NOT NULL,
      content_hash text NOT NULL,
      size_bytes integer NOT NULL DEFAULT 0,
      chunk_count integer NOT NULL DEFAULT 0,
      indexed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT documents_project_path_uq UNIQUE (project_id, relative_path)
    )`);
    await run(`CREATE INDEX IF NOT EXISTS documents_project_idx ON documents (project_id)`);
    // Pre-v3 databases created the table without the column.
    await run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES document_sources(id) ON DELETE CASCADE`);
    await run(`CREATE INDEX IF NOT EXISTS documents_source_idx ON documents (source_id)`);

    await migrateLegacyRootPaths(tx, opts.log);

    await run(`CREATE TABLE IF NOT EXISTS chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index integer NOT NULL,
      heading_path text NOT NULL DEFAULT '',
      content text NOT NULL,
      token_count integer NOT NULL,
      embedding vector(${dims}) NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks (project_id)`);
    await run(`CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id)`);

    await run(`CREATE TABLE IF NOT EXISTS index_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mode text NOT NULL,
      status text NOT NULL,
      files_total integer NOT NULL DEFAULT 0,
      files_skipped integer NOT NULL DEFAULT 0,
      files_updated integer NOT NULL DEFAULT 0,
      files_removed integer NOT NULL DEFAULT 0,
      chunks_written integer NOT NULL DEFAULT 0,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL,
      duration_ms integer NOT NULL DEFAULT 0,
      error text
    )`);
    await run(`CREATE INDEX IF NOT EXISTS index_runs_project_idx ON index_runs (project_id, started_at DESC)`);

    // v4: dashboard accounts. A CHECK rather than an enum, so the set of roles can move with an
    // idempotent DROP/ADD CONSTRAINT instead of the pain of ALTER TYPE.
    await run(`CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text NOT NULL UNIQUE,
      email text,
      display_name text NOT NULL DEFAULT '',
      role text NOT NULL DEFAULT 'member',
      password_hash text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      must_change_password boolean NOT NULL DEFAULT false,
      failed_login_count integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      last_login_at timestamptz,
      password_changed_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await run(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await run(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('root', 'admin', 'member'))`);

    await run(`CREATE TABLE IF NOT EXISTS user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      user_agent text NOT NULL DEFAULT '',
      ip text
    )`);
    await run(`CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at)`);

    // PK order is (user_id, project_id): the hot queries are "this account's projects" and the
    // point lookup, both served by that index. The reverse direction gets its own.
    await run(`CREATE TABLE IF NOT EXISTS project_members (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role text NOT NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, project_id)
    )`);
    await run(`ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check`);
    await run(`ALTER TABLE project_members ADD CONSTRAINT project_members_role_check CHECK (role IN ('viewer', 'editor'))`);
    await run(`CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members (project_id)`);

    // Dimension guard: the column type is fixed once created.
    const stored = await tx.execute(sql`SELECT value FROM settings WHERE key = 'embedding_dimensions'`);
    const storedDims = stored.rows[0] ? Number((stored.rows[0] as { value: string }).value) : undefined;

    if (storedDims !== undefined && storedDims !== dims) {
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

    await run(`CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
      ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);

    await run(`INSERT INTO settings (key, value) VALUES
      ('embedding_dimensions', '${dims}'),
      ('schema_version', '${SCHEMA_VERSION}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE settings.key = 'schema_version'`);
  });

  opts.log.info({ dimensions: dims, schemaVersion: SCHEMA_VERSION }, 'database schema ready');
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Mirrors PROJECT_NAME_RE without importing config (schema code stays dependency-free). */
function legacySourceName(rootPath: string, taken: Set<string>): string {
  const base = rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
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
    await tx.execute(sql`UPDATE document_sources SET document_count = (SELECT count(*) FROM documents WHERE source_id = ${sourceId}) WHERE id = ${sourceId}`);
    log.info({ projectId: row.id, source: name, rootPath: row.root_path }, 'migrated legacy project root to a local source');
  }
}
