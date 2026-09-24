import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { bootstrapDatabase, MIGRATIONS_FOLDER } from '../../src/db/bootstrap.js';
import { createDb } from '../../src/db/client.js';
import { ensureSchema } from './fixtures/ensure-schema-v5.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';
import { captureSchema, renderSchemaSnapshot, snapshotDifference } from './support/schema-snapshot.js';

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
 *
 * **The comparison is made at the head of the journal, not at the baseline, and it had to move there
 * the moment a second migration existed.** `0001_index_generations` ([ADR-0039](../../.ssot/ADR.md#adr-0039))
 * adds columns the frozen ladder cannot know about, so "the baseline equals the ladder" is no longer
 * something `bootstrapDatabase` can be asked — it always applies everything. What replaces it is the
 * stronger question anyway, and the one an operator actually has: **does a `0.1.0` database carried
 * forward end up byte-identical to a database created from scratch today?**
 */

const baseUrl = inject('postgresBaseUrl');
const opened: TestDatabase[] = [];

/** Every generation column this migration added, and the constraint it replaced. */
/**
 * Everything the migrations cut *after* the baseline are allowed to have changed, by name. It grows by
 * a term per migration, on purpose: a regex that said "anything" would let the next one through
 * unread, which is the whole thing this assertion is for. `0001_index_generations`
 * ([ADR-0039](../../.ssot/ADR.md#adr-0039)) is the first four; `0002_hybrid_search`
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)) is the fifth; `0003_chunk_neighbours`
 * ([ADR-0042](../../.ssot/ADR.md#adr-0042)) is the sixth; `0004_document_content`
 * ([ADR-0043](../../.ssot/ADR.md#adr-0043)) is the next two, and the `documents` qualifier on the
 * first of them is not decoration — `chunks.content` is a baseline column, and a term that matched it
 * too would wave through a future migration that re-typed the text every search result is cut from.
 * `0005_query_log` ([ADR-0047](../../.ssot/ADR.md#adr-0047)) is the next two: one column on `projects`
 * and two whole tables, which are anchored at the start of the line so that the term names *the tables*
 * rather than any future column whose name happens to contain them. `0006_scheduled_sync`
 * ([ADR-0048](../../.ssot/ADR.md#adr-0048)) is the next five: two columns and a partial index on
 * `document_sources`, and a column plus its check constraint on `index_runs` — `trigger` qualified by
 * its table and its column position, because the word is also PostgreSQL's own and an unqualified term
 * would wave through a future migration that added one. `0007_notion_webhook`
 * ([ADR-0049](../../.ssot/ADR.md#adr-0049)) is the last four: three columns on `document_sources` and
 * the second partial index the tick's widened due predicate needs. `webhook_secret` is **not** in this
 * list and must not be — it is a baseline column that entry reuses rather than adds, so a term for it
 * would wave through a future migration that re-typed the secret every delivery is verified against.
 * `0008_mcp_oauth` ([ADR-0054](../../.ssot/ADR.md#adr-0054)) is the last eight: one whole table, four
 * columns and two indexes on `mcp_tokens`, and the `kind` CHECK — `kind` and `user_id` are qualified by
 * their table and their column position for `trigger`'s reason, because both words are ordinary enough
 * that an unqualified term would wave through a future migration adding one anywhere else.
 * `projects_mcp_auth_check` **is** in the list, and it is the one term here that names a *baseline*
 * constraint. It has to be: `('open', 'token')` becoming `('open', 'token', 'account')` is a DROP and
 * an ADD, so the projection line changes text rather than appearing. The cost is real and is the price
 * of the widening — a future migration that narrowed this constraint would now pass unread — and it is
 * bounded by the whole projection being compared as text in the test above, where a narrowing would
 * show up as a difference between a database carried forward and one created today.
 * `0009_document_versions` ([ADR-0058](../../.ssot/ADR.md#adr-0058)) is the next one, qualified by its
 * table and its column position for `trigger`'s reason: `version` is an ordinary enough word that an
 * unqualified term would wave through a future migration adding one anywhere — `oauth_clients` or
 * `settings` being the obvious places. Its second column needs no term at all: that migration's
 * `search_queries.filter_version` is already inside `^search_quer`, which anchors the *table* rather
 * than the column, and is exactly the breadth that entry accepted for its own two tables.
 * `0010_audit_events` ([ADR-0055](../../.ssot/ADR.md#adr-0055)) is the next one, and it is a single
 * term because the migration is a single whole table: `^audit_events` anchors the *table* — its
 * columns, its three indexes, its foreign key and its three CHECK constraints all carry that prefix —
 * which is the same breadth `^search_quer` and `^oauth_clients` were already accepted at, and for the
 * same reason. It adds no column to any existing table, so it needs no second term.
 * `0012_mcp_auth_default_token` ([ADR-0065](../../.ssot/ADR.md#adr-0065)) is the one after it, and it is
 * the only term here about a column's *default* rather than about a line appearing or disappearing:
 * `SET DEFAULT 'token'` rewrites the default in `projects.mcp_auth`'s projection line, so the old line
 * leaves and a new one arrives. It is qualified by its table and its column position for `trigger`'s
 * reason. The cost is the one `projects_mcp_auth_check` already pays — a later migration that moved
 * this default again would pass here unread — and it is bounded the same way: a database carried
 * forward and one created today are compared as whole text in the test above, where the two would have
 * to agree about what a project is born as.
 * `0013_lexical_configurations` ([ADR-0064](../../.ssot/ADR.md#adr-0064)) is the newest, and it is one
 * unqualified term for `content_tsv`'s reason: `text_search_config` is not a word that could turn up
 * on another table by accident. It needs no second term for the index it rebuilds —
 * `chunks_project_generation_idx` gains this column and is already inside `index_generation`, which
 * matches the columns the projection lists rather than the index's name.
 * `0014_api_tokens` ([ADR-0076](../../.ssot/ADR.md#adr-0076)) is a single term because the migration is
 * a single whole table: `^api_tokens` anchors the *table* — its twelve columns, its two indexes, its
 * primary key and its three foreign keys all carry that prefix. The `audit_events` CHECK constraints it
 * widens to admit `'api_token'` are already covered by `^audit_events`, unqualified for the same reason
 * `projects_mcp_auth_check` is: the DROP-and-ADD shows up as changed text on a constraint name this term
 * already matches.
 * `0015_oidc_federated_identities` ([ADR-0077](../../.ssot/ADR.md#adr-0077)) is the newest, and it is
 * the same shape as `0014_api_tokens`: one whole new table, so `^user_federated_identities` anchors it
 * end to end — its seven columns, its two indexes, its primary key, its unique constraint and its one
 * foreign key.
 * `0016_session_auth_method` ([ADR-0077](../../.ssot/ADR.md#adr-0077)) is a single additive column on
 * an existing table, the same shape as `0012_mcp_auth_default_token`'s column: `user_sessions \| \d+ \|
 * auth_method \|` names the table and the column position, and `user_sessions_auth_method_check` names
 * the CHECK constraint the column ships with.
 * `0017_project_score_floor` is the same shape again: `projects \| \d+ \| score_floor \|` names the
 * nullable column a project's own relevance floor lives in, and `projects_score_floor_check` the CHECK
 * that holds it between 0 and 1.
 */
const POST_BASELINE_MARKERS =
  /index_generation|live_generation|\| generation \||documents_project_path_uq|content_tsv|chunks_document_chunk_index_uq|documents \| \d+ \| content \||content_truncated|query_log_enabled|^search_quer|sync_interval_minutes|next_sync_at|document_sources_due_idx|index_runs \| \d+ \| trigger \||index_runs_trigger_check|webhook_verification_expires_at|webhook_due_at|webhook_min_interval_minutes|document_sources_webhook_due_idx|^oauth_clients|mcp_tokens \| \d+ \| (kind|user_id|client_id|expires_at) \||mcp_tokens_kind_check|mcp_tokens_user_id_fkey|mcp_tokens_client_id_fkey|mcp_tokens_user_idx|mcp_tokens_expires_idx|projects_mcp_auth_check|documents \| \d+ \| version \||^audit_events|^api_tokens|projects \| \d+ \| mcp_auth \||text_search_config|^user_federated_identities|user_sessions \| \d+ \| auth_method \||user_sessions_auth_method_check|projects \| \d+ \| score_floor \||projects_score_floor_check/;

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

describe('a database carried forward from the DDL ladder against one created today', () => {
  it('produces an identical catalogue projection', async () => {
    const [ladderDb, migratedDb] = await Promise.all([freshDatabase('equiv_ladder'), freshDatabase('equiv_migrated')]);

    // The left-hand side is a `0.1.0` installation: the frozen ladder, then every start since.
    await ensureSchema(ladderDb.db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });
    await applySchema(ladderDb);
    // The right-hand side is an empty volume today.
    await applySchema(migratedDb);

    const ladder = await captureSchema(ladderDb.db);
    const migrated = await captureSchema(migratedDb.db);

    // As text first: a failure here is readable as a diff, which is the point of the helper.
    expect(renderSchemaSnapshot(migrated)).toBe(renderSchemaSnapshot(ladder));
    expect(migrated).toEqual(ladder);
  });
});

describe('adopting a database that already has the schema', () => {
  it('marks the baseline applied rather than running it, and then applies only what came after', async () => {
    const database = await freshDatabase('equiv_adopt');

    // The shape a `0.1.0` installation is sitting at right now: schema 5, and no journal at all.
    await ensureSchema(database.db, { dimensions: TEST_EMBEDDING_DIMENSIONS, resetVectors: false, log: silentLogger });
    const before = await captureSchema(database.db);
    const journalTable = await database.db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`);
    expect((journalTable.rows[0] as { present: boolean }).present).toBe(false);

    await applySchema(database);

    // The adoption itself still changes nothing — if it had run the baseline instead of marking it,
    // the first `CREATE TABLE` would have failed and there would be no projection to compare. What
    // *is* allowed to differ is what the migrations after the baseline did, and that is checked by
    // name rather than waved through: every line that appeared or disappeared names a generation
    // column, the unique constraint ADR-0039 replaced, or the lexical column ADR-0041 added — and
    // nothing else moved.
    const changed = snapshotDifference(before, await captureSchema(database.db));
    expect(changed).not.toHaveLength(0);
    expect(changed.filter((line) => !POST_BASELINE_MARKERS.test(line))).toEqual([]);

    // The first row is drizzle's own hash of the baseline file — not a hand-rolled digest that
    // merely looks like one. A row whose hash disagreed would describe a migration nobody applied.
    const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await journalRows(database);
    expect(rows).toHaveLength(files.length);
    const baseline = files[0];
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

    // The session-scoped advisory lock is the whole reason this is one row per migration rather than
    // two, or a duplicate-table error from whichever start lost the race.
    expect(await journalRows(database)).toHaveLength(readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length);

    const settings = await database.db.execute(sql`SELECT key, value FROM settings ORDER BY key`);
    expect(settings.rows).toHaveLength(2);
  });
});
