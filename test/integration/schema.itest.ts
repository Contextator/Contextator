import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { ensureSchema } from '../../src/db/ensure-schema.js';
import {
  createTestDatabase,
  dropTestDatabase,
  pgvectorVersion,
  runSqlScript,
  silentLogger,
  TEST_EMBEDDING_DIMENSIONS,
  type TestDatabase,
} from './support/postgres.js';
import { captureSchema, renderSchemaSnapshot } from './support/schema-snapshot.js';

/**
 * `ensure-schema.ts` against a real server (ADR-0031): the empty case, the idempotent case, and the
 * upgrade of a genuine pre-v3 database. None of the three is observable without one.
 */

const baseUrl = inject('postgresBaseUrl');
const here = dirname(fileURLToPath(import.meta.url));

/** The ten tables the current schema version owns, in the order PostgreSQL lists them. */
const EXPECTED_TABLES = [
  'chunks',
  'document_sources',
  'documents',
  'index_runs',
  'mcp_tokens',
  'project_members',
  'projects',
  'settings',
  'user_sessions',
  'users',
];

const opened: TestDatabase[] = [];

afterAll(async () => {
  for (const database of opened) await dropTestDatabase(baseUrl, database);
});

async function freshDatabase(name: string): Promise<TestDatabase> {
  const database = await createTestDatabase(baseUrl, name);
  opened.push(database);
  return database;
}

function applySchema(database: TestDatabase): Promise<void> {
  return ensureSchema(database.db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });
}

describe('ensureSchema on an empty database', () => {
  it('creates every table, the enum, the settings and an HNSW index with the options NFR-02 claims', async () => {
    const database = await freshDatabase('schema_empty');
    await applySchema(database);
    const { db } = database;

    const tables = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`);
    expect(tables.rows.map((r) => (r as { table_name: string }).table_name)).toEqual(EXPECTED_TABLES);

    const enumLabels = await db.execute(sql`
      SELECT e.enumlabel FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'project_status'
      ORDER BY e.enumsortorder`);
    expect(enumLabels.rows.map((r) => (r as { enumlabel: string }).enumlabel)).toEqual(['idle', 'indexing', 'error']);

    const settings = await db.execute(sql`SELECT key, value FROM settings ORDER BY key`);
    expect(Object.fromEntries(settings.rows.map((r) => [(r as { key: string }).key, (r as { value: string }).value]))).toEqual({
      embedding_dimensions: '384',
      schema_version: '5',
    });

    // The column type carries the dimension, and the dimension is what the settings row guards.
    const embedding = await db.execute(sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a WHERE a.attrelid = 'chunks'::regclass AND a.attname = 'embedding'`);
    expect((embedding.rows[0] as { type: string }).type).toBe(`vector(${TEST_EMBEDDING_DIMENSIONS})`);

    // Not "an index by that name exists": an HNSW index built with other parameters is a different
    // index with the same name, and `m` and `ef_construction` are the numbers NFR-02 rests on.
    const index = await db.execute(sql`
      SELECT am.amname, c.reloptions
      FROM pg_class c
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'chunks_embedding_hnsw_idx'`);
    expect(index.rows).toHaveLength(1);
    const row = index.rows[0] as { amname: string; reloptions: string[] | null };
    expect(row.amname).toBe('hnsw');
    expect([...(row.reloptions ?? [])].sort()).toEqual(['ef_construction=64', 'm=16']);
  });
});

describe('ensureSchema twice', () => {
  it('is a no-op the second time, down to a byte-identical schema projection', async () => {
    const database = await freshDatabase('schema_twice');
    await applySchema(database);
    const before = await captureSchema(database.db);

    await expect(applySchema(database)).resolves.toBeUndefined();

    const after = await captureSchema(database.db);
    // The helper, not an inline query: this comparison is the entire review of the change that
    // replaces this DDL with generated migrations (ADR-0031).
    expect(renderSchemaSnapshot(after)).toBe(renderSchemaSnapshot(before));
    expect(after).toEqual(before);
  });
});

describe('ensureSchema over a 0.1 database', () => {
  let upgradedDatabase: TestDatabase;

  it('adds what v3, v4 and v5 added, and migrates the legacy root_path into a local source', async () => {
    const database = await freshDatabase('schema_upgrade_0_1');
    upgradedDatabase = database;
    await runSqlScript(database, await readFile(join(here, 'fixtures', 'schema-0.1.sql'), 'utf8'));

    const { db } = database;
    const project = await db.execute(sql`
      INSERT INTO projects (name, root_path) VALUES ('handbook-project', '/srv/docs/handbook') RETURNING id`);
    const projectId = (project.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO documents (project_id, relative_path, title, content_hash, size_bytes, chunk_count) VALUES
        (${projectId}, 'index.md', 'Index', 'hash-index', 10, 1),
        (${projectId}, 'guides/install.md', 'Install', 'hash-install', 20, 2)`);

    await applySchema(database);

    const tables = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`);
    expect(tables.rows.map((r) => (r as { table_name: string }).table_name)).toEqual(EXPECTED_TABLES);

    // Exactly one source, typed `local`, named after the last segment of the root path.
    const sources = await db.execute(sql`SELECT type, name, label, config, document_count FROM document_sources`);
    expect(sources.rows).toHaveLength(1);
    const source = sources.rows[0] as {
      type: string;
      name: string;
      label: string;
      config: { path: string; extensions: string[] };
      document_count: number;
    };
    expect(source.type).toBe('local');
    expect(source.name).toBe('handbook');
    expect(source.label).toBe('Local directory');
    expect(source.config).toEqual({ path: '/srv/docs/handbook', extensions: ['md', 'mdx'] });
    expect(source.document_count).toBe(2);

    // Both documents re-keyed under `<source>/…` and pointed at it, so the next run re-embeds nothing.
    const documents = await db.execute(sql`
      SELECT d.relative_path, d.source_id, s.name AS source_name
      FROM documents d LEFT JOIN document_sources s ON s.id = d.source_id
      ORDER BY d.relative_path`);
    expect(
      documents.rows.map((r) => {
        const doc = r as { relative_path: string; source_id: string | null; source_name: string | null };
        return { path: doc.relative_path, hasSource: doc.source_id !== null, source: doc.source_name };
      }),
    ).toEqual([
      { path: 'handbook/guides/install.md', hasSource: true, source: 'handbook' },
      { path: 'handbook/index.md', hasSource: true, source: 'handbook' },
    ]);

    // v5: an upgraded project stays reachable by whatever was already configured against it.
    const upgraded = await db.execute(sql`SELECT mcp_auth, root_path FROM projects WHERE id = ${projectId}`);
    expect((upgraded.rows[0] as { mcp_auth: string }).mcp_auth).toBe('open');

    const version = await db.execute(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
    expect((version.rows[0] as { value: string }).value).toBe('5');
  });

  it('is idempotent over the upgraded database: a second start creates no second source', async () => {
    const database = upgradedDatabase;
    const before = await captureSchema(database.db);

    await applySchema(database);

    expect(renderSchemaSnapshot(await captureSchema(database.db))).toBe(renderSchemaSnapshot(before));
    const sources = await database.db.execute(sql`SELECT count(*)::int AS n FROM document_sources`);
    expect((sources.rows[0] as { n: number }).n).toBe(1);
  });
});

describe('the container', () => {
  it('reports the pgvector version the image shipped', async () => {
    const database = await freshDatabase('schema_pgvector_version');
    await applySchema(database);
    const version = await pgvectorVersion(database.db);
    // Not an assertion on the number: the tag floats and pinning it is a decision, not a test's job.
    // Phase 1 needs 0.8 for `hnsw.iterative_scan`, and `requirePgvectorAtLeast` is waiting for it.
    expect(version).toMatch(/^\d+\.\d+/);
    console.info(`pgvector ${version} on ${inject('postgresImage')}`);
  });
});
