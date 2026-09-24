import { pathToFileURL } from 'node:url';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  keyringOf,
  needsReEncryption,
  secretKeyId,
  type SecretKeyring,
} from '../src/services/crypto.js';
import { ENCRYPTED_FIELDS, type EncryptedField } from '../src/services/encrypted-fields.js';
import { useEmbeddedDatabaseWhenNothingElseSays } from './embedded-database.js';

/**
 * `npm run rotate-secret` — rewrites every value encrypted under `SECRET_KEY` with the current key.
 *
 * **It is a catch-up pass, not a cutover** ([ADR-0075](../.ssot/ADR.md#adr-0075)). By the time it runs
 * the instance is already writing with the new key and reading with both, so nothing depends on this
 * command finishing, or on it finishing quickly, or on it running at all before the next deploy. What
 * it does is make the *old* key removable: it converts what is still sealed under it, and then says
 * how much is left, which is the only fact that makes dropping `SECRET_KEY_PREVIOUS` a decision rather
 * than a hope.
 *
 * Three properties follow from doing it one row at a time with a conditional `UPDATE`:
 *
 * - **Interrupting it is not a state.** Each row is readable under some key in the ring before the
 *   write and under the current key after it; there is no moment in between. Half a run is simply a
 *   run that converted fewer rows.
 * - **Re-running it is free.** A row already carrying the current key's id is skipped without a
 *   decryption, so the second run of a finished rotation does no writes at all.
 * - **It cannot overwrite a concurrent edit.** The `WHERE` carries the exact value that was read, so
 *   an operator who re-entered a token while the pass was walking the table keeps their token; the
 *   pass counts the row as raced and the next run finds nothing to do, because the value the operator
 *   wrote is already under the current key.
 *
 * **No plaintext leaves this file.** ADR-0017's promise is that stored secrets are never returned, and
 * a rotation tool is the most tempting place in the product to break it — a `console.log` of the value
 * that would not open is the obvious debugging aid and is exactly the thing that must not exist. The
 * output is counts and column names; a row that cannot be opened is reported by its id.
 */

/** What one pass did to one column. Every number here is safe to print. */
export interface FieldOutcome {
  /** `document_sources.secret_enc`. */
  field: string;
  /** Rows with a non-null value. */
  scanned: number;
  /** Already sealed under the current key; not read, not written. */
  alreadyCurrent: number;
  /** Opened with some key in the ring and rewritten under the current one. */
  reEncrypted: number;
  /** Legacy plaintext (only `webhook_secret`, only before ADR-0075) encrypted for the first time. */
  sealed: number;
  /** Changed by something else between the read and the write; left alone. */
  raced: number;
  /** No key in the ring opens it. Ids only — the value is not printed, quoted or logged. */
  unreadable: string[];
}

export interface RotationReport {
  /** The key everything is written with, by its check value. */
  keyId: string;
  /** The retired key, when one is configured. */
  previousKeyId: string | null;
  fields: FieldOutcome[];
  /**
   * Rows that are still not under the current key, counted after the pass.
   *
   * **This is the number the operator acts on**: zero is what makes removing `SECRET_KEY_PREVIOUS`
   * safe. It is measured rather than derived from the counters above, because a row written by the
   * running application while the pass walked the table belongs in the answer too.
   */
  remaining: number;
}

interface Row {
  id: string;
  value: string | null;
}

async function readRows(db: Db, field: EncryptedField): Promise<Row[]> {
  return (await db
    .select({ id: field.id, value: field.column })
    .from(field.table as PgTable)
    .where(isNotNull(field.column))) as Row[];
}

/** How many stored values are not yet under `keys.current`, across every encrypted column. */
export async function remainingUnderOldKeys(db: Db, keys: SecretKeyring): Promise<number> {
  let remaining = 0;
  for (const field of ENCRYPTED_FIELDS) {
    for (const row of await readRows(db, field)) {
      if (row.value !== null && needsReEncryption(row.value, keys)) remaining += 1;
    }
  }
  return remaining;
}

export interface RotationOptions {
  /**
   * Called before each write, with the count of writes already made.
   *
   * It exists for `test/integration/secret-rotation.itest.ts`, which throws from it to cut the pass in
   * half and then proves the database is still consistent — a property that can only be tested by
   * interrupting a real run, and that would otherwise be asserted by reading the code.
   */
  beforeWrite?: (field: EncryptedField, written: number) => void | Promise<void>;
}

/**
 * Converts everything that is not already under `keys.current`.
 *
 * Throws only for a caller error (no key at all) or from `beforeWrite`; a value that will not open is
 * reported in the outcome rather than thrown, because one unreadable row must not stop the other
 * nine hundred from being converted.
 */
export async function rotateSecrets(db: Db, keys: SecretKeyring, opts: RotationOptions = {}): Promise<RotationReport> {
  if (!keys.current) throw new Error('SECRET_KEY is not set; there is no key to rotate towards');
  let written = 0;
  const fields: FieldOutcome[] = [];

  for (const field of ENCRYPTED_FIELDS) {
    const outcome: FieldOutcome = { field: field.name, scanned: 0, alreadyCurrent: 0, reEncrypted: 0, sealed: 0, raced: 0, unreadable: [] };
    for (const row of await readRows(db, field)) {
      const value = row.value;
      if (value === null) continue;
      outcome.scanned += 1;
      if (!needsReEncryption(value, keys)) {
        outcome.alreadyCurrent += 1;
        continue;
      }

      let plain: string;
      let sealing = false;
      if (isEncryptedSecret(value)) {
        try {
          plain = decryptSecret(value, keys);
        } catch {
          // Neither key opens it: the row predates a rotation nobody ran this command for, or was
          // edited by hand. It is left exactly as it is — an unreadable value is still evidence, and
          // rewriting it with the current key would destroy the only copy of whatever it holds.
          outcome.unreadable.push(row.id);
          continue;
        }
      } else if (field.legacyPlaintext) {
        plain = value;
        sealing = true;
      } else {
        outcome.unreadable.push(row.id);
        continue;
      }

      const next = encryptSecret(plain, keys);
      await opts.beforeWrite?.(field, written);
      const updated = await db
        .update(field.table)
        .set({ [field.property]: next } as Record<string, unknown>)
        // The value that was read, not just the id: whatever else wrote this row while the pass was
        // running wins, and wins silently, because it wrote with the current key too.
        .where(and(eq(field.id, row.id), eq(field.column, value)))
        .returning({ id: field.id });
      written += 1;
      if (updated.length === 1) {
        if (sealing) outcome.sealed += 1;
        else outcome.reEncrypted += 1;
      } else {
        outcome.raced += 1;
      }
    }
    fields.push(outcome);
  }

  return {
    keyId: secretKeyId(keys.current),
    previousKeyId: keys.previous ? secretKeyId(keys.previous) : null,
    fields,
    remaining: await remainingUnderOldKeys(db, keys),
  };
}

/** The report as an operator reads it. Counts and column names only — see the file comment. */
export function reportLines(report: RotationReport): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  Writing with key ${report.keyId}${report.previousKeyId ? `, also reading with ${report.previousKeyId}` : ''}.`);
  lines.push('');
  for (const f of report.fields) {
    const parts = [`${f.scanned} row(s)`, `${f.alreadyCurrent} already current`, `${f.reEncrypted} re-encrypted`];
    if (f.sealed > 0) parts.push(`${f.sealed} encrypted for the first time`);
    if (f.raced > 0) parts.push(`${f.raced} changed while running`);
    lines.push(`  ${f.field}: ${parts.join(', ')}`);
    if (f.unreadable.length > 0) {
      lines.push(`    ${f.unreadable.length} row(s) no configured key can open: ${f.unreadable.join(', ')}`);
    }
  }
  lines.push('');
  if (report.remaining === 0) {
    lines.push('  Nothing is left under an older key.');
    lines.push('  Remove SECRET_KEY_PREVIOUS from the environment and restart — that is what retires the old key.');
  } else {
    lines.push(`  ${report.remaining} value(s) are still not under the current key. Keep SECRET_KEY_PREVIOUS set.`);
    lines.push('  Run this again; if the number does not move, the listed rows need their secret re-entered in the dashboard.');
  }
  lines.push('');
  return lines;
}

async function main(): Promise<void> {
  // Imported here rather than at the top: a test importing `rotateSecrets` must not have this file
  // rewrite its environment on the way in.
  await import('dotenv/config');
  // See `embedded-database.ts` — the same reason `reset-password` needs it (ADR-0032).
  useEmbeddedDatabaseWhenNothingElseSays();

  const config = loadConfig();
  const keys = keyringOf(config);
  if (!keys.current) {
    console.error('SECRET_KEY is not set. There is nothing to rotate towards; set it (and SECRET_KEY_PREVIOUS to the key being retired) first.');
    process.exit(2);
  }
  if (!keys.previous) {
    // Not an error: this is also how a v1 installation upgrades its envelopes, and how an instance
    // that has just been given its first key seals the webhook secrets it wrote before it had one.
    console.error('SECRET_KEY_PREVIOUS is not set; values only the previous key can open will be reported as unreadable.');
  }

  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const report = await rotateSecrets(db, keys);
    for (const line of reportLines(report)) console.log(line);
    // `exitCode`, not `exit()`: the pool has to close in `finally`, and stdout is asynchronous when it
    // is a pipe (`… | tee rotation.log`), so exiting here could cut off the very lines that name the
    // rows still owed — the branch where the operator most needs to read them (ADR-0075).
    if (report.remaining > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

/** Only when this file *is* the command; importing it from a test must not rewrite anything. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
