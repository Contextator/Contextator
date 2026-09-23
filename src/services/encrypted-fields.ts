import { getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { documentSources } from '../db/schema.js';
import { ENVELOPE_PREFIXES } from './crypto.js';

/**
 * Every column in this database that holds a value encrypted under `SECRET_KEY`, in one place.
 *
 * **This list is the phase's real deliverable, not the rotation loop** ([ADR-0075](../../.ssot/ADR.md#adr-0075)).
 * A re-encryption pass is twenty lines; a re-encryption pass that silently skips a column added six
 * months later is an instance whose operator believes the old key is retired while one column still
 * needs it. So the list is stated once, here, it is derived from the schema objects rather than from
 * hand-written strings — a column that is renamed or deleted fails the build — and
 * `test/encrypted-fields.test.ts` re-reads `src/db/schema.ts` and refuses any secret-shaped column
 * that appears in neither this list nor the exemption table beside it.
 *
 * Two things consult it — `scripts/rotate-secret.ts`, which rewrites these columns, and
 * `scripts/backup.ts`, which counts the rows that depend on the key through `encryptedRowFilter`
 * below. Both ask this file rather than naming a column, because a second place that named columns
 * would be a second place that could disagree about what is encrypted.
 */
export interface EncryptedField {
  /** `document_sources.secret_enc` — what the rotation summary and every log line calls it. */
  readonly name: string;
  readonly table: PgTable;
  /** The primary key, so a rewrite can address exactly the row it read. */
  readonly id: PgColumn;
  readonly column: PgColumn;
  /** The JS property `db.update(...).set()` takes, derived from the table rather than retyped. */
  readonly property: string;
  /**
   * Whether a value that is not one of `crypto.ts`'s envelopes is legal rather than corrupt.
   *
   * True for exactly one column, and for a reason that is historical rather than structural:
   * `webhook_secret` was stored in the clear until ADR-0075. A `true` here means the rotation pass
   * *seals* such a value instead of refusing it; a `false` means an unopenable value is an error the
   * operator has to see.
   */
  readonly legacyPlaintext: boolean;
  /**
   * What losing this value costs, which is what a restore under the wrong key is allowed to decide on.
   *
   * `irrecoverable` — the value exists nowhere else. A git token or a Notion integration secret was
   * issued by the provider and typed in here once; this instance cannot mint another, so a restore
   * that brings it back undecryptable is a restore that has to be redone by hand. `checkSecretKey`
   * refuses for these.
   *
   * `regenerable` — the value is one this side can establish again. A git source's webhook secret is
   * generated here and pasted into the repository; a Notion one is re-delivered into a verification
   * window the operator reopens (ADR-0049). Either way losing it costs a step at the provider, not a
   * hunt through a password manager. Counting these as blocking is what turned an
   * instance of public repositories with webhooks — Faz 09's "unambiguously safe" case — into one
   * that cannot restore at all, so they are counted, said out loud, and not refused for.
   */
  readonly recovery: SecretRecovery;
}

/** @see EncryptedField.recovery */
export type SecretRecovery = 'irrecoverable' | 'regenerable';

function field(table: PgTable, column: PgColumn, id: PgColumn, legacyPlaintext: boolean, recovery: SecretRecovery): EncryptedField {
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const property = Object.keys(columns).find((key) => columns[key] === column);
  // Not reachable through the typed call sites below; it is here so that a future caller passing a
  // column from a different table finds out immediately instead of writing to a property that is not there.
  if (!property) throw new Error(`Column ${column.name} does not belong to table ${getTableName(table)}`);
  return { name: `${getTableName(table)}.${column.name}`, table, id, column, property, legacyPlaintext, recovery };
}

export const ENCRYPTED_FIELDS: readonly EncryptedField[] = [
  /** The git / Notion / Confluence token a private source authenticates with (ADR-0017). */
  field(documentSources, documentSources.secretEnc, documentSources.id, false, 'irrecoverable'),
  /**
   * The shared secret a push delivery is signed with — generated here for a git source, minted by
   * Notion for a Notion one (ADR-0018, ADR-0049). Encrypted since ADR-0075; rows written before it
   * are plaintext and are sealed by the first pass.
   */
  field(documentSources, documentSources.webhookSecret, documentSources.id, true, 'regenerable'),
];

/**
 * Secret-shaped columns that are deliberately **not** encrypted under `SECRET_KEY`, with the reason.
 *
 * The guard test reads this table, so "we thought about it" is recorded rather than remembered. A
 * column that is neither here nor in `ENCRYPTED_FIELDS` fails that test, which is the only mechanism
 * that makes the list above stay complete.
 */
export const UNENCRYPTED_SECRET_COLUMNS: Readonly<Record<string, string>> = {
  'mcp_tokens.token_hash':
    'A one-way hash of a bearer token, never reversed — the presented token is hashed and compared. Rotating SECRET_KEY has nothing to do with it.',
  'users.password_hash': 'scrypt (src/services/passwords.ts). Hashed, not encrypted; there is no plaintext to re-encrypt.',
  'user_sessions.token_hash': 'A one-way hash of a session cookie, like mcp_tokens.token_hash. Sessions also expire on their own.',
  'api_tokens.token_hash': 'A one-way hash of an ADR-0076 API token, like mcp_tokens.token_hash. Revocable and optionally expiring besides.',
  'settings.key':
    'The name of a setting — "schema_version", not key material. It is here only because the guard test matches column names and would otherwise ask about it on every run.',
};

/**
 * Whether one field of one row holds something that cannot be read without `SECRET_KEY`.
 *
 * For a column that has only ever held envelopes, that is `IS NOT NULL`. For `webhook_secret`, which
 * was plaintext until ADR-0075, a non-null value is not enough: an instance that has not run the
 * rotation pass yet still has rows a restore can read perfectly well without any key, and counting
 * those would make the backup's refusal fire where there is nothing at stake.
 */
function holdsEncryptedValue(entry: EncryptedField): SQL {
  const present = sql`${entry.column} IS NOT NULL`;
  if (!entry.legacyPlaintext) return present;
  const envelope = ENVELOPE_PREFIXES.map((prefix) => sql`${entry.column} LIKE ${`${prefix}%`}`);
  return sql`(${present} AND (${sql.join(envelope, sql` OR `)}))`;
}

/**
 * A predicate that is true for a row of `table` holding **at least one** value encrypted under
 * `SECRET_KEY` — the SQL half of this registry.
 *
 * `scripts/backup.ts` writes the number of such rows into the manifest, and `checkSecretKey` refuses
 * a restore when that number is above zero and the key is missing or different. Deriving the
 * predicate here rather than writing `WHERE secret_enc IS NOT NULL` there is the same guarantee the
 * list above is for: a column added to `ENCRYPTED_FIELDS` is counted by the backup on the day it is
 * added, instead of producing an archive that restores "completely" into rows nobody can open.
 *
 * `recovery` narrows it to the fields of one kind, because the backup counts the two kinds
 * separately: what a wrong key destroys (`irrecoverable`) is what stops a restore, and what it
 * merely costs a regeneration (`regenerable`) is what the restore mentions on its way through.
 * Without the argument the predicate is the union, which is "this row depends on the key at all".
 */
export function encryptedRowFilter(table: PgTable, recovery?: SecretRecovery): SQL {
  const parts = ENCRYPTED_FIELDS.filter((entry) => entry.table === table && (recovery === undefined || entry.recovery === recovery)).map(
    holdsEncryptedValue,
  );
  // No encrypted column of this kind on this table: nothing in it depends on the key that way.
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}
