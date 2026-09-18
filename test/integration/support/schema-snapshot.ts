import { sql } from 'drizzle-orm';

import type { Db } from '../../../src/db/client.js';

/**
 * A stable, sorted projection of everything `public` holds that a schema change can move: every
 * column with its type and default, every index with its definition and its storage options, every
 * constraint with its definition.
 *
 * This exists as a named helper rather than as an inline query in one test because it is the whole
 * review of the next change to this area. When `ensure-schema.ts` is replaced by generated migrations
 * (ADR-0005 is the decision being revisited, ADR-0031 §Decision says why the harness comes first), the
 * question a reviewer has to answer is "does the new mechanism produce the same schema" — and the
 * answer is this projection, captured through both paths, compared as text.
 */

export interface SchemaSnapshot {
  columns: string[];
  indexes: string[];
  constraints: string[];
  enums: string[];
}

export async function captureSchema(db: Db): Promise<SchemaSnapshot> {
  const columns = await db.execute(sql`
    SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable,
           coalesce(column_default, '-') AS column_default,
           coalesce(character_maximum_length::text, '-') AS character_maximum_length,
           coalesce(numeric_precision::text, '-') AS numeric_precision,
           coalesce(datetime_precision::text, '-') AS datetime_precision
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`);

  // pg_class.reloptions is where `WITH (m = 16, ef_construction = 64)` actually lives: pg_get_indexdef
  // prints it too, but only some of it, and an index is not the same index if its build parameters
  // changed. NFR-02 is a claim about those numbers.
  const indexes = await db.execute(sql`
    SELECT t.relname AS table_name, c.relname AS index_name,
           pg_get_indexdef(i.indexrelid) AS definition,
           coalesce(array_to_string(c.reloptions, ', '), '-') AS options
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.relname, c.relname`);

  const constraints = await db.execute(sql`
    SELECT rel.relname AS table_name, con.conname AS constraint_name, con.contype::text AS constraint_type,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY rel.relname, con.conname`);

  const enums = await db.execute(sql`
    SELECT t.typname AS enum_name, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname`);

  return {
    columns: columns.rows.map(joinRow),
    indexes: indexes.rows.map(joinRow),
    constraints: constraints.rows.map(joinRow),
    enums: enums.rows.map(joinRow),
  };
}

/** The snapshot as one string, so "identical" can be asserted as text and read as a diff. */
export function renderSchemaSnapshot(snapshot: SchemaSnapshot): string {
  return [
    `# columns (${snapshot.columns.length})`,
    ...snapshot.columns,
    `# indexes (${snapshot.indexes.length})`,
    ...snapshot.indexes,
    `# constraints (${snapshot.constraints.length})`,
    ...snapshot.constraints,
    `# enums (${snapshot.enums.length})`,
    ...snapshot.enums,
  ].join('\n');
}

/**
 * Every projection line that one of the two snapshots has and the other does not, in one list. The
 * `# count` headers are excluded: they move whenever anything else does and say nothing of their own.
 *
 * This is what a test asserts against when a schema change is *expected* — "these lines and no others
 * moved" is a claim about the change, where "the two are identical" is only a claim about no change.
 */
export function snapshotDifference(before: SchemaSnapshot, after: SchemaSnapshot): string[] {
  const lines = (snapshot: SchemaSnapshot): string[] =>
    renderSchemaSnapshot(snapshot)
      .split('\n')
      .filter((line) => !line.startsWith('#'));
  const left = new Set(lines(before));
  const right = new Set(lines(after));
  return [...lines(before).filter((line) => !right.has(line)), ...lines(after).filter((line) => !left.has(line))];
}

function joinRow(row: Record<string, unknown>): string {
  return Object.values(row)
    .map((value) => String(value))
    .join(' | ');
}
