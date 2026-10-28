import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Db } from '../src/db/client.js';
import { searchChunks, type SearchRequest } from '../src/services/vector-store.js';

/**
 * The text of the search statement, rendered without a database. **Held byte for byte** for every call that
 * carries no source scope ([ADR-0133](../.ssot/ADR.md#adr-0133) decision 4): the plans ADR-0040, ADR-0041 and
 * ADR-0042 measured, and the eval baseline, are the statement below, and a scope may add predicates only to a
 * search that has one. The files under `__snapshots__/` were written from the code as it stood before the
 * scope existed; this test failing means an unscoped search now sends different SQL, which is a decision, not
 * a refactor.
 */

const dialect = new PgDialect();

/** `searchChunks` against a database that records the statements and answers none. */
async function statementOf(request: Partial<SearchRequest>): Promise<{ text: string; params: unknown[] }> {
  const seen: SQL[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      seen.push(statement);
      return { rows: [] };
    },
  };
  const db = { transaction: async (run: (t: typeof tx) => Promise<unknown>) => run(tx), execute: tx.execute } as unknown as Db;
  await searchChunks(db, {
    projectId: '00000000-0000-4000-8000-000000000001',
    generation: 3,
    queryEmbedding: [0.5, 0.25],
    queryText: 'dispatch workers',
    limit: 5,
    ...request,
  });
  // The first statement sets the scan; the second is the search.
  const search = dialect.sqlToQuery(seen[1]);
  return { text: search.sql, params: search.params };
}

describe('the search statement without a source scope', () => {
  it('is the unfiltered statement, byte for byte', async () => {
    const { text, params } = await statementOf({});
    await expect(text).toMatchFileSnapshot('./__snapshots__/vector-store-unfiltered.sql');
    expect(params.length).toBeGreaterThan(0);
  });

  it('is the filtered statement of a source, a path prefix and a version, byte for byte', async () => {
    const { text } = await statementOf({ sourceId: '00000000-0000-4000-8000-0000000000aa', pathPrefix: 'handbook/', version: 'v1' });
    await expect(text).toMatchFileSnapshot('./__snapshots__/vector-store-filtered.sql');
  });

  it('null is no scope, as undefined is', async () => {
    const plain = await statementOf({});
    const nulled = await statementOf({ sourceIds: null });
    expect(nulled.text).toBe(plain.text);
  });
});

describe('the search statement with a source scope', () => {
  const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];

  it('confines the corpus count and the probe to the scope as well as the candidates', async () => {
    const { text, params } = await statementOf({ sourceIds: ids });
    // Three places read chunks across the project: the corpus count, the probe, and (through `withinScope`)
    // both candidate lists. Each carries the scope's own document subselect.
    const scopedChunks =
      text.match(/c\.document_id in \(select id from documents where project_id = \$\d+ and index_generation = \$\d+ and source_id in \(/g) ?? [];
    expect(scopedChunks).toHaveLength(2);
    expect(text).toContain('filtered_documents');
    for (const id of ids) expect(params.filter((p) => p === id).length).toBeGreaterThanOrEqual(3);
  });

  it('an empty scope matches nothing at every one of those places', async () => {
    const { text } = await statementOf({ sourceIds: [] });
    expect(text.match(/and false/g) ?? []).toHaveLength(3);
  });
});
