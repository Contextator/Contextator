import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ENCRYPTED_FIELDS, UNENCRYPTED_SECRET_COLUMNS } from '../src/services/encrypted-fields.js';

/**
 * The guard that keeps `ENCRYPTED_FIELDS` complete ([ADR-0075](../.ssot/ADR.md#adr-0075)).
 *
 * The rotation command is only as good as its list of columns, and a list is the kind of thing that
 * stops being true quietly: somebody adds `sources.oauth_refresh_token`, encrypts it correctly at the
 * call site, and the next rotation leaves it under a key the operator believes is retired. Nothing in
 * the type system notices that.
 *
 * So this test does not read the list — it reads `src/db/schema.ts` as text, picks out every column
 * whose *name* looks like a secret, and demands that each one be accounted for: encrypted, or written
 * down in `UNENCRYPTED_SECRET_COLUMNS` with a reason. Adding a secret column then has exactly two
 * outcomes, and both of them are deliberate.
 */
const SCHEMA = readFileSync(fileURLToPath(new URL('../src/db/schema.ts', import.meta.url)), 'utf8');

/** `pgTable('<name>'` — the position of each declaration, so a column can be attributed to one. */
const TABLE_DECLARATIONS = [...SCHEMA.matchAll(/pgTable\(\s*'([a-z_0-9]+)'/g)].map((m) => ({ at: m.index ?? 0, name: m[1] }));

/** Every `text('…')` / `varchar('…')` column in the file, in declaration order. */
const TEXT_COLUMNS = /(?:^|\W)(?:text|varchar)\(\s*'([a-z_0-9]+)'/g;

/**
 * Names that mean "this holds a credential". Matched on whole underscore-separated words so that
 * `token_count` is a column about counting and `mcp_token_id` is a foreign key, while `token_hash`
 * and `secret_enc` are questions this test insists on an answer to.
 */
const SECRET_SHAPED = /(?:^|_)(?:secret|token|password|passphrase|credential|key)(?:_|$)/;

function tableAt(position: number): string {
  let name = '';
  for (const t of TABLE_DECLARATIONS) {
    if (t.at > position) break;
    name = t.name;
  }
  return name;
}

function secretShapedColumnsInSchema(): string[] {
  const found: string[] = [];
  for (const m of SCHEMA.matchAll(TEXT_COLUMNS)) {
    const column = m[1];
    if (!SECRET_SHAPED.test(column)) continue;
    found.push(`${tableAt(m.index ?? 0)}.${column}`);
  }
  return found;
}

describe('the list of encrypted columns', () => {
  it('finds the schema at all — a silent zero here would make every assertion below vacuous', () => {
    expect(TABLE_DECLARATIONS.length).toBeGreaterThan(10);
    expect(secretShapedColumnsInSchema().length).toBeGreaterThanOrEqual(5);
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
