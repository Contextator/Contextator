/**
 * Reciprocal rank fusion ([ADR-0041](../../.ssot/ADR.md#adr-0041)): how the dense ranking and the
 * lexical ranking become one ordering.
 *
 * `score(chunk) = Σ 1 / (k + rank_i)` over the lists the chunk appears in, ranks 1-based, a chunk
 * absent from a list contributing nothing. The arithmetic is here and the fusion itself happens in
 * SQL, in `searchChunks`, because shipping a hundred chunk texts to Node to throw ninety away is a
 * worse trade than a `FULL OUTER JOIN`.
 *
 * **`fuseRankLists` is the specification the SQL is held to, not a second implementation of it.**
 * `test/rrf.test.ts` asserts the arithmetic with no database at all — a fusion bug and a retrieval
 * regression read identically in a `recall@5`, and only one of them is cheap to rule out — and
 * `test/integration/hybrid-search.itest.ts` asserts that PostgreSQL's ordering is the one this
 * function produces for the same two lists. Nothing in the request path calls it.
 */

/**
 * 60, from Cormack, Clarke and Buettcher (2009), and the value every implementation uses.
 *
 * It is a constant and not a setting on purpose. `k` trades how far down a list a hit still counts
 * against how much the very top of each list dominates, and choosing it needs a tuning budget this
 * phase does not have — a knob nobody has measured is a knob that gets turned on a hunch.
 */
export const RRF_K = 60;

/** One list's contribution. `null` is "this list did not return the chunk", which is worth nothing. */
export function rrfScore(rank: number | null, k: number = RRF_K): number {
  return rank === null ? 0 : 1 / (k + rank);
}

/** A chunk id with the 1-based rank it held in each list, and what the two add up to. */
export interface FusedRow {
  id: string;
  denseRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
}

/**
 * Fuses two ranked lists of chunk ids, best first.
 *
 * The tie-break is the dense rank, nulls last, then the id. Ties are not a corner case here: a chunk
 * that is first on one list and absent from the other scores exactly what a chunk first on the other
 * list and absent from this one scores, and something has to decide. Dense first, because it is the
 * half that is asked on every query, including the ones with no lexical match at all; the id last,
 * because an ordering that depends on which row PostgreSQL happened to hand back is an ordering that
 * cannot be asserted.
 */
export function fuseRankLists(dense: readonly string[], lexical: readonly string[], k: number = RRF_K): FusedRow[] {
  const rows = new Map<string, FusedRow>();
  const place = (ids: readonly string[], side: 'denseRank' | 'lexicalRank'): void => {
    ids.forEach((id, i) => {
      const row = rows.get(id) ?? { id, denseRank: null, lexicalRank: null, fusedScore: 0 };
      row[side] = i + 1;
      rows.set(id, row);
    });
  };
  place(dense, 'denseRank');
  place(lexical, 'lexicalRank');

  for (const row of rows.values()) row.fusedScore = rrfScore(row.denseRank, k) + rrfScore(row.lexicalRank, k);

  return [...rows.values()].sort((a, b) => {
    if (a.fusedScore !== b.fusedScore) return b.fusedScore - a.fusedScore;
    if (a.denseRank !== b.denseRank) return (a.denseRank ?? Number.POSITIVE_INFINITY) - (b.denseRank ?? Number.POSITIVE_INFINITY);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
