import { describe, expect, it } from 'vitest';

import { fuseRankLists, RRF_K, rrfScore } from '../src/services/rrf.js';

/**
 * The arithmetic half of [ADR-0041](../.ssot/ADR.md#adr-0041), with no database in it.
 *
 * It exists for the reason `test/eval-scoring.test.ts` exists: when `recall@5` moves, the first
 * question is whether retrieval changed or whether the thing that orders it did, and that question
 * has to be cheap to answer. Fusion is arithmetic over two lists of ids — nothing about it needs
 * PostgreSQL, a model or a container, and the moment it does, it has stopped being fusion.
 *
 * `test/integration/hybrid-search.itest.ts` holds the SQL to the ordering this file specifies.
 */

describe('one list’s contribution', () => {
  it('is 1/(k + rank), with rank counted from one', () => {
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 12);
    expect(rrfScore(2)).toBeCloseTo(1 / 62, 12);
    expect(rrfScore(50)).toBeCloseTo(1 / 110, 12);
  });

  it('is nothing at all when the list did not return the chunk', () => {
    expect(rrfScore(null)).toBe(0);
  });

  it('uses 60, which is the constant from the paper and not a tuned number', () => {
    expect(RRF_K).toBe(60);
  });
});

describe('fusing two rankings', () => {
  it('puts a chunk both halves found above one either half found alone', () => {
    // `b` is second on both lists and still wins: 1/62 + 1/62 against `a`'s single 1/61. That is the
    // whole mechanism in one assertion — agreement beats a better rank on one side.
    const fused = fuseRankLists(['a', 'b'], ['c', 'b']);

    expect(fused.map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]).toMatchObject({ id: 'b', denseRank: 2, lexicalRank: 2 });
    expect(fused[0].fusedScore).toBeCloseTo(2 / 62, 12);
  });

  it('carries the rank each half gave a chunk, and null for the half that did not', () => {
    const fused = fuseRankLists(['a'], ['b']);

    expect(fused).toEqual([
      { id: 'a', denseRank: 1, lexicalRank: null, fusedScore: 1 / 61 },
      { id: 'b', denseRank: null, lexicalRank: 1, fusedScore: 1 / 61 },
    ]);
  });

  it('breaks an exact tie towards the dense half', () => {
    // A lexical-only first place and a dense-only first place score identically, to the bit. Something
    // has to decide, and it is the half that is asked on every query — including the ones with no
    // lexical match at all.
    const fused = fuseRankLists(['dense-only'], ['lexical-only']);

    expect(fused[0].id).toBe('dense-only');
    expect(fused[0].fusedScore).toBe(fused[1].fusedScore);
  });

  it('is an ordering, not a coin toss, when neither rank can separate two chunks', () => {
    const fused = fuseRankLists([], ['b', 'a']);
    const again = fuseRankLists([], ['b', 'a']);

    expect(fused.map((row) => row.id)).toEqual(again.map((row) => row.id));
    expect(fused.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('lets a lexical hit outrank the dense half’s second place, which is the point of running two', () => {
    // The identifier case, stated as arithmetic: the chunk the lexical half put first (1/61) sits
    // above the chunk the dense half put second (1/62) and below the one it put first.
    const fused = fuseRankLists(['prose-1', 'prose-2'], ['identifier']);

    expect(fused.map((row) => row.id)).toEqual(['prose-1', 'identifier', 'prose-2']);
  });

  it('returns each chunk once however many lists hold it', () => {
    const fused = fuseRankLists(['a', 'b', 'c'], ['c', 'b', 'a']);

    expect(fused).toHaveLength(3);
    expect(new Set(fused.map((row) => row.id)).size).toBe(3);
  });

  it('degrades to the dense ordering when the lexical half returns nothing', () => {
    // What a project mid-upgrade gets, and what `hnsw.iterative_scan`'s own tests rely on: an empty
    // lexical list must not reorder anything.
    const dense = ['a', 'b', 'c', 'd'];
    expect(fuseRankLists(dense, []).map((row) => row.id)).toEqual(dense);
  });

  it('accepts a different k, because the constant is an argument and not a literal in the loop', () => {
    expect(fuseRankLists(['a'], [], 1)[0].fusedScore).toBeCloseTo(1 / 2, 12);
  });

  it('fuses two empty lists into nothing rather than into a row with no ranks', () => {
    expect(fuseRankLists([], [])).toEqual([]);
  });
});
