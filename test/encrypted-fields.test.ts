import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { ENCRYPTED_FIELDS, UNENCRYPTED_SECRET_COLUMNS } from '../src/services/encrypted-fields.js';

/**
 * The guard that keeps `ENCRYPTED_FIELDS` complete ([ADR-0075](../.ssot/ADR.md#adr-0075)).
 *
 * The rotation command is only as good as its list of columns, and a list is the kind of thing that
 * stops being true quietly: somebody adds `sources.oauth_refresh_token`, encrypts it correctly at the
 * call site, and the next rotation leaves it under a key the operator believes is retired. Nothing in
 * the type system notices that.
 *
 * So this test does not read the list — it walks every column of every table `src/db/schema.ts`
 * declares, of any type that could hold a value at all (`text`, `jsonb`, an enum, a custom `bytea` —
 * not only the `text(…)` calls a pattern over the file would find), picks out each one whose *name*
 * looks like a secret, and demands that each be accounted for: encrypted, or written down in
 * `UNENCRYPTED_SECRET_COLUMNS` with a reason.
 *
 * **What it cannot see is a secret with an innocent name.** The match is on the column name and
 * nothing else: `sources.auth` or `settings.value` holding a credential passes this test. That is the
 * limit of any check that does not read the data, and the reason the name list below errs towards
 * asking — `settings.key` is exempt for exactly that. Within that limit a new secret column has two
 * outcomes, and both of them are deliberate.
 */
const SCHEMA = readFileSync(fileURLToPath(new URL('../src/db/schema.ts', import.meta.url)), 'utf8');

/** `pgTable('<name>'` as written in the file — the count the runtime walk below has to reach. */
const TABLE_DECLARATIONS = [...SCHEMA.matchAll(/pgTable\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]);

/**
 * Every table the schema module exports, by its runtime identity rather than by a pattern over its
 * source text — so a column built with any builder, today's or one added later, is in the walk.
 */
const TABLES: PgTable[] = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));

/**
 * Names that mean "this holds a credential". Matched on whole underscore-separated words, singular or
 * plural, so that `keyword` and `tokenizer` are not asked about while `token_hash`, `secret_enc` and
 * `oauth_tokens` are questions this test insists on an answer to.
 */
const SECRET_SHAPED = /(?:^|_)(?:secret|token|password|passphrase|credential|key)s?(?:_|$)/;

/**
 * Column types that cannot carry a credential whatever they are called: a count, a flag, a timestamp,
 * a uuid. This is what keeps `chunks.token_count`, `users.must_change_password` and the foreign key
 * `search_queries.mcp_token_id` out of the question without exempting them by name. Everything else —
 * text, json, an enum, a vector, a custom type such as `bytea` — is walked.
 */
const CANNOT_HOLD_A_SECRET = new Set(['number', 'bigint', 'boolean', 'date']);

function canHoldASecret(column: PgColumn): boolean {
  return !CANNOT_HOLD_A_SECRET.has(column.dataType.split(' ')[0]) && column.columnType !== 'PgUUID';
}

function secretShapedColumnsInSchema(): string[] {
  const found: string[] = [];
  for (const table of TABLES) {
    for (const column of Object.values(getTableColumns(table)) as PgColumn[]) {
      if (canHoldASecret(column) && SECRET_SHAPED.test(column.name)) found.push(`${getTableName(table)}.${column.name}`);
    }
  }
  return found;
}

describe('the list of encrypted columns', () => {
  it('finds the schema at all — a silent zero here would make every assertion below vacuous', () => {
    expect(TABLE_DECLARATIONS.length).toBeGreaterThan(10);
    expect(secretShapedColumnsInSchema().length).toBeGreaterThanOrEqual(5);
  });

  it('walks every table the schema declares — one left unexported would be a table nobody checks', () => {
    expect(TABLES.map((table) => getTableName(table)).sort()).toEqual([...TABLE_DECLARATIONS].sort());
  });

  it('asks about a secret-shaped name in either number', () => {
    for (const name of ['secret_enc', 'token_hash', 'oauth_tokens', 'api_secrets', 'client_credentials', 'signing_keys', 'passwords']) {
      expect(SECRET_SHAPED.test(name), name).toBe(true);
    }
    for (const name of ['keyword', 'tokenizer', 'monkeys', 'secretary', 'passwordless', 'turkey']) {
      expect(SECRET_SHAPED.test(name), name).toBe(false);
    }
  });

  it('accounts for every secret-shaped column in src/db/schema.ts', () => {
    const encrypted = new Set(ENCRYPTED_FIELDS.map((f) => f.name));
    const exempt = new Set(Object.keys(UNENCRYPTED_SECRET_COLUMNS));
    const unaccounted = secretShapedColumnsInSchema().filter((name) => !encrypted.has(name) && !exempt.has(name));
    // The message is the point: whoever added the column reads it, not this file.
    expect(unaccounted, 'add each of these to ENCRYPTED_FIELDS, or to UNENCRYPTED_SECRET_COLUMNS with the reason it needs no key').toEqual([]);
  });

  it('covers the two columns this phase was written for', () => {
    const names = ENCRYPTED_FIELDS.map((f) => f.name);
    expect(names).toContain('document_sources.secret_enc');
    expect(names).toContain('document_sources.webhook_secret');
  });

  it('does not claim a column in both directions at once', () => {
    for (const field of ENCRYPTED_FIELDS) expect(UNENCRYPTED_SECRET_COLUMNS[field.name]).toBeUndefined();
  });

  it('gives every exemption a reason long enough to be one', () => {
    for (const [name, reason] of Object.entries(UNENCRYPTED_SECRET_COLUMNS)) {
      expect(name, 'exemptions are keyed by "<table>.<column>"').toMatch(/^[a-z_0-9]+\.[a-z_0-9]+$/);
      expect(reason.length, `${name} needs a reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it('exempts nothing that is no longer in the schema', () => {
    const inSchema = new Set(secretShapedColumnsInSchema());
    for (const name of Object.keys(UNENCRYPTED_SECRET_COLUMNS)) {
      expect(inSchema.has(name), `${name} is exempt but no longer exists; delete the exemption`).toBe(true);
    }
  });
});

describe('each entry', () => {
  it('names a real column of a real table, derived rather than typed', () => {
    for (const field of ENCRYPTED_FIELDS) {
      const columns = getTableColumns(field.table as PgTable) as Record<string, PgColumn>;
      expect(columns[field.property], `${field.name}: property ${field.property}`).toBe(field.column);
      expect(field.name).toBe(`${getTableName(field.table as PgTable)}.${field.column.name}`);
    }
  });

  it('addresses rows by a primary key of the same table', () => {
    for (const field of ENCRYPTED_FIELDS) {
      const columns = Object.values(getTableColumns(field.table as PgTable)) as PgColumn[];
      expect(columns, `${field.name}: id column`).toContain(field.id);
      expect(field.id.primary, `${field.name}: id must be the primary key`).toBe(true);
    }
  });

  it('allows legacy plaintext only where there was any — secret_enc has always been encrypted', () => {
    const secretEnc = ENCRYPTED_FIELDS.find((f) => f.name === 'document_sources.secret_enc');
    expect(secretEnc?.legacyPlaintext).toBe(false);
    const webhook = ENCRYPTED_FIELDS.find((f) => f.name === 'document_sources.webhook_secret');
    expect(webhook?.legacyPlaintext).toBe(true);
  });

  /**
   * What a restore under the wrong key is allowed to refuse for. A sync credential was issued by the
   * provider and cannot be reissued from here, so losing it is losing it; a webhook secret is minted
   * here, so losing it costs one regeneration. Marking the second `irrecoverable` would be enough to
   * stop the restore of an instance that has nothing to lose — see `checkSecretKey`.
   */
  it('marks a value the provider issued irrecoverable, and one this instance mints regenerable', () => {
    const secretEnc = ENCRYPTED_FIELDS.find((f) => f.name === 'document_sources.secret_enc');
    expect(secretEnc?.recovery).toBe('irrecoverable');
    const webhook = ENCRYPTED_FIELDS.find((f) => f.name === 'document_sources.webhook_secret');
    expect(webhook?.recovery).toBe('regenerable');
  });
});
