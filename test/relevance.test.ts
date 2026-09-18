import { describe, expect, it } from 'vitest';

import { EnvSchema } from '../src/config.js';
import { belowRelevanceFloor, FLOOR_MEASURED_MODEL, floorModelWarning, isIdentifierShaped } from '../src/services/relevance.js';
import { DEFAULT_RESULT_SELECTION, escapeLikePattern, selectionFrom, type SearchHit } from '../src/services/vector-store.js';

/**
 * The part of [ADR-0042](../.ssot/ADR.md#adr-0042) that needs no database: when a search refuses to
 * answer, when it refuses to refuse, and that the two places the selection defaults are written down
 * say the same numbers. The halves that need a real index — the filters, the cap and the neighbours in
 * SQL — are `test/integration/result-selection.itest.ts`.
 *
 * The floor's *value* is not asserted here beyond the schema default. It is a measurement over a corpus
 * and it belongs to `npm run eval`; what this file pins down is the shape of the decision, which is the
 * part that can be wrong for every corpus at once.
 */

const ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ALLOWED_DOC_ROOTS: '/docs',
};

const parse = (overrides: Record<string, string> = {}) => EnvSchema.safeParse({ ...ENV, ...overrides });

const hit = (score: number, lexicalRank: number | null = null): SearchHit => ({
  score,
  fusedScore: 0.0164,
  denseRank: 1,
  lexicalRank,
  file: 'handbook/errors.md',
  title: 'Errors',
  headingPath: 'Errors > 4xxx',
  content: 'HLY-4019 — the receiver rejected the delivery.',
  chunkIndex: 3,
  contextBefore: null,
  contextAfter: null,
});

describe('what the question has to look like for the floor to let it past', () => {
  it('recognises the shapes a similarity score cannot represent', () => {
    expect(isIdentifierShaped('AUTH_COOKIE_SECURE')).toBe(true);
    expect(isIdentifierShaped('what does HALYARD_DISPATCH_TIMEOUT do')).toBe(true);
    expect(isIdentifierShaped('std::vector')).toBe(true);
    expect(isIdentifierShaped('where is settings.json')).toBe(true);
    expect(isIdentifierShaped('3.0.0')).toBe(true);
  });

  it('recognises an identifier that arrives inside a sentence, which is how agents actually ask', () => {
    // The generous half of the rule, and the asymmetry it comes from: firing when it should not have
    // degrades one query to the behaviour before the floor existed, and failing to fire hides a
    // correct answer behind a refusal.
    expect(isIdentifierShaped('What does HLY-4019 mean?')).toBe(true);
    expect(isIdentifierShaped('HLY-4015 hatası ne anlama geliyor?')).toBe(true);
    expect(isIdentifierShaped('which header carries the HMAC signature')).toBe(true);
  });

  it('leaves an ordinary question alone, in either language', () => {
    expect(isIdentifierShaped('how do I back up the database before an upgrade')).toBe(false);
    expect(isIdentifierShaped('yedek alırken önce veritabanını mı almalıyım')).toBe(false);
    // Three characters, so not a token this rule reaches for — and a question of common words has to
    // stay ordinary, or the escape hatch is the whole product.
    expect(isIdentifierShaped('why is my api slow')).toBe(false);
  });
});

describe('the gate itself', () => {
  it('fires when the best hit is under the floor', () => {
    expect(belowRelevanceFloor('how do I bake sourdough bread', [hit(0.79), hit(0.78)], 0.82)).toBe(true);
  });

  it('does not fire when the best hit clears it, whatever is behind it', () => {
    expect(belowRelevanceFloor('how do I take a backup', [hit(0.88), hit(0.5)], 0.82)).toBe(false);
  });

  it('is off at zero, which is how an operator turns it off', () => {
    expect(belowRelevanceFloor('how do I bake sourdough bread', [hit(0.1)], 0)).toBe(false);
  });

  it('leaves an empty result alone, because "nothing matched" is a different answer', () => {
    expect(belowRelevanceFloor('anything at all', [], 0.82)).toBe(false);
  });

  it('lets an identifier question past when the keyword half found something', () => {
    // The case a pure similarity floor gets wrong: an exact `tsvector` match on a string is correct at
    // any cosine at all, because the string is either in the chunk or it is not.
    expect(belowRelevanceFloor('What does AUTH_COOKIE_SECURE do?', [hit(0.61, 1)], 0.82)).toBe(false);
  });

  it('still gates an identifier question no keyword matched, which is the floor being right', () => {
    expect(belowRelevanceFloor('What does AUTH_COOKIE_SECURE do?', [hit(0.61, null)], 0.82)).toBe(true);
  });
});

describe('the floor is a number about one model', () => {
  it('says nothing while the server runs the model it was measured on', () => {
    expect(floorModelWarning(0.82, FLOOR_MEASURED_MODEL)).toBeNull();
  });

  it('warns when the model has changed under it, naming both', () => {
    const warning = floorModelWarning(0.82, 'text-embedding-3-small');
    expect(warning).toContain('text-embedding-3-small');
    expect(warning).toContain(FLOOR_MEASURED_MODEL);
    expect(warning).toContain('SEARCH_SCORE_FLOOR=0');
  });

  it('says nothing at all when the floor is off, however exotic the model', () => {
    expect(floorModelWarning(0, 'something-nobody-has-measured')).toBeNull();
  });
});

describe('the selection an unconfigured installation runs at', () => {
  it('caps a document at two excerpts and shows one chunk either side', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.SEARCH_MAX_PER_DOCUMENT).toBe(2);
    expect(result.data.SEARCH_NEIGHBOR_CONTEXT).toBe(1);
    expect(result.data.SEARCH_SCORE_FLOOR).toBe(0.82);
  });

  it('gives `searchChunks` the same defaults when nobody hands it a configuration', () => {
    // `DEFAULT_HNSW_SCAN`'s rule, one setting group along: two files write these numbers down and this
    // is what keeps them equal.
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(selectionFrom(result.data)).toEqual(DEFAULT_RESULT_SELECTION);
  });

  it('refuses a per-document cap above the most excerpts a search may return', () => {
    expect(parse({ SEARCH_MAX_PER_DOCUMENT: '21' }).success).toBe(false);
    expect(parse({ SEARCH_MAX_PER_DOCUMENT: '0' }).success).toBe(false);
  });

  it('refuses a floor outside the range a cosine similarity lives in', () => {
    expect(parse({ SEARCH_SCORE_FLOOR: '1.5' }).success).toBe(false);
    expect(parse({ SEARCH_SCORE_FLOOR: '0' }).success).toBe(true);
  });
});

describe('the LIKE pattern a path prefix becomes', () => {
  it('escapes both wildcards, because an underscore in a path is a character somebody typed', () => {
    expect(escapeLikePattern('docs/getting_started')).toBe('docs/getting\\_started');
    expect(escapeLikePattern('a%b')).toBe('a\\%b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves an ordinary path exactly as it was', () => {
    expect(escapeLikePattern('handbook/operations/backup.md')).toBe('handbook/operations/backup.md');
  });
});
