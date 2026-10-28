import { inArray, sql, type SQL } from 'drizzle-orm';

/**
 * A source-id column (`documents.source_id`, `document_sources.id`) confined to a token's source scope ([ADR-0133](../../.ssot/ADR.md#adr-0133)).
 * **`undefined` here means the caller passed no scope and the predicate is left out entirely**, so an
 * unscoped read runs the SQL it always ran; `[]` is a scope that holds nothing and matches no row, never
 * every row. The two are different values on purpose: the allowlist next to this feature reads an empty
 * list as "no restriction", and this must not.
 */
export function withinSourceScope(column: Parameters<typeof inArray>[0], sourceIds: readonly string[] | null | undefined): SQL | undefined {
  if (sourceIds === null || sourceIds === undefined) return undefined;
  return sourceIds.length === 0 ? sql`false` : inArray(column, [...sourceIds]);
}
