import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_FOLDER, SchemaMismatchError } from '../../src/db/bootstrap.js';
import { DEFAULT_MCP_AUTH } from '../../src/db/schema.js';
import { ensureSchema } from './fixtures/ensure-schema-v5.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  pgvectorVersion,
  runSqlScript,
  silentLogger,
  TEST_EMBEDDING_DIMENSIONS,
  type TestDatabase,
} from './support/postgres.js';
import { captureSchema, renderSchemaSnapshot, snapshotDifference } from './support/schema-snapshot.js';

/**
 * `src/db/bootstrap.ts` against a real server (ADR-0031): the empty case, the idempotent case, and a
 * genuine pre-v3 `0.1` database carried forward along the route ADR-0033 documents. None of the three
 * is observable without one.
 */

const baseUrl = inject('postgresBaseUrl');
const here = dirname(fileURLToPath(import.meta.url));

/** The fifteen tables the current schema version owns, in the order PostgreSQL lists them. */
const EXPECTED_TABLES = [
  // An account's own bearer credentials for the admin API ([ADR-0076](../../../.ssot/ADR.md#adr-0076)).
  // Self-service and revocable, scoped to a subset of what its owner's live role can already do.
  'api_tokens',
  // Who changed this instance, and what they changed ([ADR-0055](../../../.ssot/ADR.md#adr-0055)).
  // Deliberately **not** the query log with a column added: that one holds what people asked, under a
  // thirty-day window because it is user content; this holds what an operator did, under a year's.
  'audit_events',
  'chunks',
  'document_sources',
  'documents',
  'index_runs',
  'mcp_tokens',
  // The OAuth clients this instance has met ([ADR-0054](../../../.ssot/ADR.md#adr-0054)). A row is a
  // name and a set of redirect URIs and confers nothing; every grant comes from a person approving one.
  'oauth_clients',
  'project_members',
  'projects',
  // The query log ([ADR-0047](../../../.ssot/ADR.md#adr-0047)): what agents asked, and what came back.
  'search_queries',
  'search_query_hits',
  'settings',
  'user_sessions',
  'users',
];

/** How many migrations `drizzle/` holds — the number of journal rows a finished start must leave. */
const MIGRATION_COUNT = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length;

const opened: TestDatabase[] = [];

afterAll(async () => {
  for (const database of opened) await dropTestDatabase(baseUrl, database);
});

async function freshDatabase(name: string): Promise<TestDatabase> {
  const database = await createTestDatabase(baseUrl, name);
  opened.push(database);
  return database;
}

describe('the bootstrap on an empty database', () => {
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

    // The column type carries the dimension, and the dimension is what the settings row guards. Note
    // that `information_schema` does not: a user-defined type has no typmod there, so the catalogue
    // projection this suite compares elsewhere cannot see this number and it is asserted by hand.
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

    // Every migration applied, in drizzle's own journal — the thing that now decides what a start does.
    const journal = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect((journal.rows[0] as { n: number }).n).toBe(MIGRATION_COUNT);
  });
});

describe('the bootstrap twice', () => {
  it('is a no-op the second time, down to a byte-identical schema projection', async () => {
    const database = await freshDatabase('schema_twice');
    await applySchema(database);
    const before = await captureSchema(database.db);

    await expect(applySchema(database)).resolves.toBeUndefined();

    const after = await captureSchema(database.db);
    expect(renderSchemaSnapshot(after)).toBe(renderSchemaSnapshot(before));
    expect(after).toEqual(before);

    // A second start must not re-apply anything, and must not add a journal row either.
    const journal = await database.db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect((journal.rows[0] as { n: number }).n).toBe(MIGRATION_COUNT);
  });
});

/**
 * `fixtures/schema-0.1.sql` is **derived, not extracted**, and the file says so at length: the
 * earliest revision of `ensure-schema.ts` in this repository's history already carries
 * `SCHEMA_VERSION = 3`, so no revision of that file ever produced the shape below — it was
 * reconstructed by reading that revision's three upgrade steps backwards. It is the best evidence
 * available of what a `0.1` database looked like, and it is evidence rather than a record.
 *
 * What the case asserts changed with ADR-0033. The bootstrap does not carry a pre-v5 database forward
 * any more; it refuses one, and names the two-step route out. That route is what runs here, with the
 * first step performed by the frozen copy of the DDL ladder in `fixtures/ensure-schema-v5.ts` —
 * which is not a stand-in for `0.1.0` but literally its code.
 */
describe('a 0.1 database, along the route ADR-0033 documents', () => {
  let upgradedDatabase: TestDatabase;
  let projectId: string;

  it('is refused by the bootstrap, with the remedy in the message', async () => {
    const database = await freshDatabase('schema_upgrade_0_1');
    upgradedDatabase = database;
    await runSqlScript(database, await readFile(join(here, 'fixtures', 'schema-0.1.sql'), 'utf8'));

    const { db } = database;
    const project = await db.execute(sql`
      INSERT INTO projects (name, root_path) VALUES ('handbook-project', '/srv/docs/handbook') RETURNING id`);
    projectId = (project.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO documents (project_id, relative_path, title, content_hash, size_bytes, chunk_count) VALUES
        (${projectId}, 'index.md', 'Index', 'hash-index', 10, 1),
        (${projectId}, 'guides/install.md', 'Install', 'hash-install', 20, 2)`);

    await expect(applySchema(database)).rejects.toThrow(SchemaMismatchError);
    await expect(applySchema(database)).rejects.toThrow(/schema_version=2 .*no migration journal/s);
    await expect(applySchema(database)).rejects.toThrow(/0\.1\.0/);

    // A refusal writes nothing. The database is still exactly the 0.1 shape it was loaded as.
    const version = await db.execute(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
    expect((version.rows[0] as { value: string }).value).toBe('2');
  });

  it('reaches schema 5 under the 0.1.0 ladder, and the bootstrap then adopts it and migrates it', async () => {
    const database = upgradedDatabase;
    const { db } = database;

    // Step one of the remedy: start 0.1.0 once. This *is* 0.1.0's startup DDL, frozen.
    await ensureSchema(db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });

    // **Rows before the migration, and chunks specifically.** `0003_chunk_neighbours` adds a UNIQUE
    // constraint over `(document_id, chunk_index)` ([ADR-0042](../../../.ssot/ADR.md#adr-0042)), and a
    // unique constraint is the one kind of migration that can fail on data rather than on schema — on
    // an operator's database, at startup, with the dashboard behind it. The invariant has always held
    // because `replaceDocument` deletes a document's chunks and rewrites them from the chunker's own
    // counter in one transaction, but "always held" is a claim about a writer, and this is the claim
    // about the ladder: a 0.1.0 database carrying chunks migrates.
    // By suffix: the ladder's own v3 step prefixes every path with the source it invented for it.
    const documentRow = await db.execute(sql`SELECT id FROM documents WHERE relative_path LIKE '%guides/install.md'`);
    const documentId = (documentRow.rows[0] as { id: string }).id;
    const vector = `[${Array(TEST_EMBEDDING_DIMENSIONS).fill('0.1').join(',')}]`;
    await db.execute(sql`
      INSERT INTO chunks (project_id, document_id, chunk_index, heading_path, content, token_count, embedding)
      SELECT ${projectId}::uuid, ${documentId}::uuid, i, 'Install > Step ' || i, 'step ' || i, 4, ${vector}::vector
      FROM generate_series(0, 2) AS i`);

    const afterLadder = await captureSchema(db);

    // Step two: the upgrade. It adopts the baseline rather than applying it — had it applied it, the
    // first `CREATE TABLE` would have failed — and then applies the migrations cut since, which today
    // is `0001_index_generations` ([ADR-0039](../../../.ssot/ADR.md#adr-0039)) and
    // `0002_hybrid_search` ([ADR-0041](../../../.ssot/ADR.md#adr-0041)) and `0003_chunk_neighbours`
    // ([ADR-0042](../../../.ssot/ADR.md#adr-0042)) and `0004_document_content`
    // ([ADR-0043](../../../.ssot/ADR.md#adr-0043)) and `0005_query_log`
    // ([ADR-0047](../../../.ssot/ADR.md#adr-0047)) and `0006_scheduled_sync`
    // ([ADR-0048](../../../.ssot/ADR.md#adr-0048)) and `0007_notion_webhook`
    // ([ADR-0049](../../../.ssot/ADR.md#adr-0049)) and `0008_mcp_oauth`
    // ([ADR-0054](../../../.ssot/ADR.md#adr-0054)) and `0009_document_versions`
    // ([ADR-0058](../../../.ssot/ADR.md#adr-0058)) and `0010_audit_events`
    // ([ADR-0055](../../../.ssot/ADR.md#adr-0055)), whose whole table is named by one anchored term
    // for the reason `^search_quer` and `^oauth_clients` are; `0012_mcp_auth_default_token`
    // ([ADR-0065](../../../.ssot/ADR.md#adr-0065)), whose term names `projects.mcp_auth` by its table
    // and its column position — the first here that is about a column's *default* rather than about a
    // line appearing, so the projection shows the old default leaving and the new one arriving; and
    // `0013_lexical_configurations` ([ADR-0064](../../../.ssot/ADR.md#adr-0064)), which adds
    // `chunks.text_search_config` and rebuilds `chunks_project_generation_idx` around it; and
    // `0014_api_tokens` ([ADR-0076](../../../.ssot/ADR.md#adr-0076)), one whole new table anchored by
    // `^api_tokens`, plus the `audit_events` CHECK constraints it widens, already covered by
    // `^audit_events`. So the claim is no longer "nothing changed": it is that nothing changed
    // *except* what those migrations say they change, and the lines that moved are checked by name
    // rather than counted.
    await applySchema(database);
    const changed = snapshotDifference(afterLadder, await captureSchema(db));
    expect(changed).not.toHaveLength(0);
    expect(
      changed.filter(
        (line) =>
          !/index_generation|live_generation|\| generation \||documents_project_path_uq|content_tsv|chunks_document_chunk_index_uq|documents \| \d+ \| content \||content_truncated|query_log_enabled|^search_quer|sync_interval_minutes|next_sync_at|document_sources_due_idx|index_runs \| \d+ \| trigger \||index_runs_trigger_check|webhook_verification_expires_at|webhook_due_at|webhook_min_interval_minutes|document_sources_webhook_due_idx|^oauth_clients|mcp_tokens \| \d+ \| (kind|user_id|client_id|expires_at) \||mcp_tokens_kind_check|mcp_tokens_user_id_fkey|mcp_tokens_client_id_fkey|mcp_tokens_user_idx|mcp_tokens_expires_idx|projects_mcp_auth_check|documents \| \d+ \| version \||^audit_events|^api_tokens|projects \| \d+ \| mcp_auth \||text_search_config/.test(
            line,
          ),
      ),
    ).toEqual([]);

    // The chunks are still there and still one per (document, index): the constraint was satisfied by
    // data that predates it, which is the only way to find out that it is an invariant and not a wish.
    const kept = await db.execute(sql`SELECT count(*)::int AS n FROM chunks WHERE document_id = ${documentId}`);
    expect((kept.rows[0] as { n: number }).n).toBe(3);

    // And the carried-forward rows kept the generation every pre-ADR-0039 document is already in.
    const generations = await db.execute(sql`SELECT DISTINCT index_generation FROM documents`);
    expect(generations.rows.map((r) => (r as { index_generation: number }).index_generation)).toEqual([0]);
    const live = await db.execute(sql`SELECT DISTINCT live_generation FROM projects`);
    expect(live.rows.map((r) => (r as { live_generation: number }).live_generation)).toEqual([0]);

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
    //
    // This line now carries [ADR-0065](../../.ssot/ADR.md#adr-0065) as well, and it is the assertion
    // that entry's migration was written around: `0012` moves the column *default* and nothing else,
    // so an instance that has been through the upgrade still answers every agent already configured
    // against this project. A migration that had closed it would have cut those connections in a
    // deployment nobody asked to be a change of access.
    const upgraded = await db.execute(sql`SELECT mcp_auth FROM projects WHERE id = ${projectId}`);
    expect((upgraded.rows[0] as { mcp_auth: string }).mcp_auth).toBe('open');

    // The other half of the same claim, on the same upgraded database: what the migration *did*
    // change is what the next project is born as. Inserted with no `mcp_auth`, the way every creation
    // path inserts it.
    const born = await db.execute(sql`INSERT INTO projects (name) VALUES ('born-after-upgrade') RETURNING mcp_auth`);
    expect((born.rows[0] as { mcp_auth: string }).mcp_auth).toBe(DEFAULT_MCP_AUTH);
    expect(DEFAULT_MCP_AUTH).not.toBe('open');
    await db.execute(sql`DELETE FROM projects WHERE name = 'born-after-upgrade'`);

    const version = await db.execute(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
    expect((version.rows[0] as { value: string }).value).toBe('5');

    const journal = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect((journal.rows[0] as { n: number }).n).toBe(MIGRATION_COUNT);
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
