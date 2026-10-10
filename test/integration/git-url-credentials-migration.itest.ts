import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_FOLDER } from '../../src/db/bootstrap.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { applySchema, createTestDatabase, dropTestDatabase, runSqlScript, type TestDatabase } from './support/postgres.js';

/**
 * `drizzle/0020_git_source_url_credentials.sql` against rows, which no other test does: the schema
 * suites migrate an **empty** database, where the `WHERE` and the `regexp_replace` are never evaluated
 * and a pattern PostgreSQL rejects or mis-reads would pass unnoticed. This migration destroys data and
 * runs at every boot, so it is run here on a table that holds a credential in every spelling the
 * application's own URL validation admits, plus rows that must come through untouched.
 *
 * The file is the migration itself, read from the folder the bootstrap reads — not a copy. It is
 * idempotent by design, so running it again over a fully migrated database is the same operation an
 * upgrade performs on old rows.
 */

const baseUrl = inject('postgresBaseUrl');
const MIGRATION = '0020_git_source_url_credentials.sql';

let database: TestDatabase;
let projectId: string;
let migration: string;

/** [stored url, url after the migration] — a credential in each shape `z.url()` lets through. */
const REWRITTEN: Array<[string, string]> = [
  ['https://alice:ghp_s3cret@github.com/org/repo.git', 'https://github.com/org/repo.git'],
  ['https://ghp_tok@github.com/org/repo.git', 'https://github.com/org/repo.git'],
  // An unencoded `@` in the password: the userinfo ends at the LAST `@` of the authority.
  ['https://u:p@ss@host/x', 'https://host/x'],
  ['https://u:p%40ss@host/x', 'https://host/x'],
  ['https://tok@[::1]:8443/x', 'https://[::1]:8443/x'],
  ['https://tok@host:8443/x?y=1#frag', 'https://host:8443/x?y=1#frag'],
  ['HTTPS://u:p@Host/x', 'HTTPS://Host/x'],
  // The loose spellings of a special scheme.
  ['https:u:p@host/x', 'https:host/x'],
  ['https:///u:p@host/x', 'https:///host/x'],
  ['https:\\\\u:p@host/x', 'https:\\\\host/x'],
  ['https://u:p@host', 'https://host'],
];

/** Carry no credential — an `@` outside the authority is not one. Must come through byte for byte. */
const UNTOUCHED = [
  'https://github.com/org/repo.git',
  'https://example.com',
  'https://host:8443/a/b.git',
  'https://host/a@b',
  'https://host/?q=a@b',
  'https://host/#a@b',
  'https:host/x@y',
];

async function insert(type: string, name: string, config: Record<string, unknown>): Promise<string> {
  const [row] = await database.db.insert(documentSources).values({ projectId, type, name, config }).returning({ id: documentSources.id });
  return row.id;
}

async function configOf(id: string): Promise<Record<string, unknown>> {
  const result = await database.db.execute(sql`SELECT config FROM document_sources WHERE id = ${id}`);
  return (result.rows[0] as { config: Record<string, unknown> }).config;
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'git_url_credentials_migration');
  await applySchema(database);
  migration = await readFile(path.join(MIGRATIONS_FOLDER, MIGRATION), 'utf8');
  [{ id: projectId }] = await database.db.insert(projects).values({ name: 'migration-fixture' }).returning({ id: projects.id });
});

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('migration 0020 on stored git sources', () => {
  const rewritten = new Map<string, string>();
  const untouched = new Map<string, string>();
  const ids = {} as { noUrl: string; numericUrl: string; web: string; kept: string };

  beforeAll(async () => {
    // Rows are seeded after `applySchema` already ran 0020 on an empty table, then the file is run again.
    for (const [i, [stored]] of REWRITTEN.entries()) rewritten.set(await insert('git', `dirty-${i}`, { url: stored, branch: 'main' }), stored);
    for (const [i, url] of UNTOUCHED.entries()) untouched.set(await insert('git', `clean-${i}`, { url, branch: 'main' }), url);
    ids.noUrl = await insert('git', 'no-url', { branch: 'main' });
    ids.numericUrl = await insert('git', 'numeric-url', { url: 42 });
    // Another type with the same shape of URL: not this migration's to touch.
    ids.web = await insert('web', 'web-with-userinfo', { url: 'https://u:p@example.com/page' });
    ids.kept = await insert('git', 'keeps-other-keys', {
      url: 'https://u:p@host/x',
      branch: 'dev',
      subdir: 'docs',
      lastCommit: 'abc123',
      extensions: ['md'],
    });
  });

  async function apply(script: string): Promise<void> {
    await runSqlScript(database, script);
  }

  function expectMigrated(): Promise<void> {
    return (async () => {
      for (const [id, stored] of rewritten) {
        const expected = REWRITTEN.find(([from]) => from === stored)?.[1];
        expect((await configOf(id)).url, stored).toBe(expected);
      }
      for (const [id, url] of untouched) expect((await configOf(id)).url, url).toBe(url);
      expect(await configOf(ids.noUrl)).toEqual({ branch: 'main' });
      expect(await configOf(ids.numericUrl)).toEqual({ url: 42 });
      expect(await configOf(ids.web)).toEqual({ url: 'https://u:p@example.com/page' });
      expect(await configOf(ids.kept)).toEqual({ url: 'https://host/x', branch: 'dev', subdir: 'docs', lastCommit: 'abc123', extensions: ['md'] });
    })();
  }

  it('removes the credential from every spelling of it and leaves every other row alone', async () => {
    await apply(migration);
    await expectMigrated();
  });

  it('is a no-op the second time', async () => {
    await apply(migration);
    await expectMigrated();
  });

  it('means the same with standard_conforming_strings off, which the pattern must not depend on', async () => {
    const id = await insert('git', 'scs-off', { url: 'https://u:p@ss@host/x' });
    // The setting has to be in force before the migration is *parsed*: the simple query protocol lexes a
    // whole multi-statement string first and only then runs it, so `SET …; <migration>` in one string would
    // read the literals under the old setting. Hence three separate round trips on one connection.
    const client = await database.pool.connect();
    try {
      await client.query('SET standard_conforming_strings = off');
      const shown = await client.query('SHOW standard_conforming_strings');
      expect(shown.rows[0].standard_conforming_strings).toBe('off');
      await client.query(migration);
    } finally {
      try {
        await client.query('RESET standard_conforming_strings');
      } finally {
        client.release();
      }
    }
    expect((await configOf(id)).url).toBe('https://host/x');
    await expectMigrated();
  });
});
