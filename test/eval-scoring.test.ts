import { describe, expect, it } from 'vitest';

import {
  aggregate,
  buildRefusalReport,
  buildReport,
  formatMarkdown,
  formatText,
  gateVerdict,
  GoldenSetError,
  headingMatches,
  NegativeSetError,
  NO_FLOORS,
  parseGoldenSet,
  parseNegativeSet,
  scoreNegativeRow,
  scoreRow,
  worstMisses,
  type Floors,
  type GoldenRow,
  type NegativeRow,
  type Report,
  type RunContext,
  type ScoredHit,
} from '../scripts/eval-scoring.js';

/**
 * The instrument has to be trustworthy before its readings are (ADR-0034). Everything here runs without
 * a database, a model or a container, because the question these tests answer — "did the arithmetic
 * change, or did retrieval?" — is only cheap to answer while it can be asked in milliseconds.
 *
 * The two cases the harness would be worthless without are the first two: a deliberately wrong
 * `expectFile` must score zero, and a question whose answer is the top hit must score one. A scoring bug
 * in either direction reads as a retrieval result and would be believed.
 */

const CORPUS = new Set(['en/install.md', 'en/config.md', 'tr/kurulum.md']);

const question = (over: Partial<GoldenRow> = {}): GoldenRow => ({
  id: 'en-install-01',
  lang: 'en',
  query: 'how do I install it',
  expectFile: 'en/install.md',
  tags: [],
  ...over,
});

const hit = (file: string, headingPath: string, score: number): ScoredHit => ({ file, headingPath, score });

const INSTALL_HITS: ScoredHit[] = [
  hit('en/install.md', 'Install > Docker', 0.62),
  hit('en/config.md', 'Configuration > Core', 0.51),
  hit('tr/kurulum.md', 'Kurulum > Docker olmadan', 0.44),
];

describe('a question whose answer is the top hit', () => {
  it('scores one on every metric, and reports the similarity of that hit', () => {
    const metrics = aggregate([scoreRow(question(), INSTALL_HITS)]);
    expect(metrics.recall1).toBe(1);
    expect(metrics.recall5).toBe(1);
    expect(metrics.mrr).toBe(1);
    expect(metrics.meanCorrectScore).toBeCloseTo(0.62, 10);
  });
});

describe('a question pointed at the wrong file', () => {
  it('scores zero on every metric, and has no correct hit to take a similarity from', () => {
    // Same hits, same ranking, same everything a retriever did. Only the expectation is wrong, and the
    // score must collapse — if this passes at anything above zero the harness is measuring nothing.
    const wrong = scoreRow(question({ expectFile: 'tr/kurulum.md' }), [INSTALL_HITS[0], INSTALL_HITS[1]]);
    expect(wrong.rank).toBeNull();
    expect(wrong.score).toBeNull();

    const metrics = aggregate([wrong]);
    expect(metrics.recall1).toBe(0);
    expect(metrics.recall5).toBe(0);
    expect(metrics.mrr).toBe(0);
    expect(metrics.meanCorrectScore).toBeNull();
  });
});

describe('a correct answer further down the list', () => {
  const at = (rank: number): ScoredHit[] =>
    Array.from({ length: 10 }, (_, i) =>
      i === rank ? hit('en/install.md', 'Install > Docker', 0.5) : hit('en/config.md', `Configuration > ${i}`, 0.9 - i / 100),
    );

  it('counts for recall@5 at rank 3 but not for recall@1, and contributes 1/3 to MRR', () => {
    const metrics = aggregate([scoreRow(question(), at(2))]);
    expect(metrics.recall1).toBe(0);
    expect(metrics.recall5).toBe(1);
    expect(metrics.mrr).toBeCloseTo(1 / 3, 10);
  });

  it('counts for neither recall at rank 6, and still contributes 1/6 to MRR', () => {
    const metrics = aggregate([scoreRow(question(), at(5))]);
    expect(metrics.recall5).toBe(0);
    expect(metrics.mrr).toBeCloseTo(1 / 6, 10);
  });
});

describe('the heading breadcrumb', () => {
  it('matches as a suffix on a separator boundary and not as a bare substring', () => {
    expect(headingMatches('Tek sunucuya kurulum > Docker olmadan', 'Docker olmadan')).toBe(true);
    expect(headingMatches('Docker olmadan', 'Docker olmadan')).toBe(true);
    expect(headingMatches('Kurulum > Hiç Docker olmadan', 'Docker olmadan')).toBe(false);
    expect(headingMatches('Install > Docker > Compose', 'Docker')).toBe(false);
  });

  it('is scored separately, so the right file with the wrong heading still counts as found', () => {
    const result = scoreRow(question({ expectHeading: 'From source' }), INSTALL_HITS);
    expect(result.rank).toBe(0);
    expect(result.headingRank).toBeNull();

    const metrics = aggregate([result]);
    expect(metrics.recall1).toBe(1);
    expect(metrics.headingQuestions).toBe(1);
    expect(metrics.headingRecall1).toBe(0);
    expect(metrics.headingRecall5).toBe(0);
  });

  it('is measured only over the questions that carry one', () => {
    const metrics = aggregate([
      scoreRow(question({ id: 'a' }), INSTALL_HITS),
      scoreRow(question({ id: 'b', expectHeading: 'Docker' }), INSTALL_HITS),
    ]);
    expect(metrics.questions).toBe(2);
    expect(metrics.headingQuestions).toBe(1);
    expect(metrics.headingRecall1).toBe(1);
  });
});

describe('the worst misses', () => {
  it('put a question that found nothing above one that found its answer late', () => {
    const missed = scoreRow(question({ id: 'missed' }), [hit('en/config.md', 'Configuration > Core', 0.4)]);
    const late = scoreRow(question({ id: 'late' }), [hit('en/config.md', 'C', 0.4), hit('en/install.md', 'I', 0.3)]);
    expect(worstMisses([late, missed], 5).map((r) => r.row.id)).toEqual(['missed', 'late']);
  });

  it('put the more confident wrong answer first when both found nothing', () => {
    const quiet = scoreRow(question({ id: 'quiet' }), [hit('en/config.md', 'C', 0.3)]);
    const confident = scoreRow(question({ id: 'confident' }), [hit('en/config.md', 'C', 0.88)]);
    expect(worstMisses([quiet, confident], 5).map((r) => r.row.id)).toEqual(['confident', 'quiet']);
  });

  it('never lists a question that was answered at rank 1', () => {
    expect(worstMisses([scoreRow(question(), INSTALL_HITS)], 5)).toEqual([]);
  });
});

describe('loading golden.jsonl', () => {
  const line = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ id: 'en-install-01', lang: 'en', query: 'q', expectFile: 'en/install.md', ...over });

  it('accepts a well-formed file and defaults the tags to none', () => {
    const rows = parseGoldenSet(
      `${line()}\n\n${line({ id: 'tr-kurulum-01', lang: 'tr', expectFile: 'tr/kurulum.md', tags: ['install'] })}\n`,
      CORPUS,
    );
    expect(rows.map((r) => r.id)).toEqual(['en-install-01', 'tr-kurulum-01']);
    expect(rows[0].tags).toEqual([]);
  });

  it('fails the run on a malformed line rather than skipping it', () => {
    expect(() => parseGoldenSet(`${line()}\n{not json\n`, CORPUS)).toThrow(GoldenSetError);
    expect(() => parseGoldenSet(`${line()}\n{not json\n`, CORPUS)).toThrow(/golden\.jsonl:2/);
  });

  it('fails on a field the schema does not know, so a typo in a key is not silently ignored', () => {
    expect(() => parseGoldenSet(`${line({ expectHeadings: 'Docker' })}\n`, CORPUS)).toThrow(GoldenSetError);
  });

  it('fails on a duplicate id', () => {
    expect(() => parseGoldenSet(`${line()}\n${line()}\n`, CORPUS)).toThrow(/duplicate id/);
  });

  it('fails on an expectFile that is not in the corpus, which is what a renamed page looks like', () => {
    expect(() => parseGoldenSet(`${line({ expectFile: 'en/installation.md' })}\n`, CORPUS)).toThrow(/not a file under eval\/corpus/);
  });

  it('fails on an empty question set', () => {
    expect(() => parseGoldenSet('\n\n', CORPUS)).toThrow(/no questions/);
  });
});

/** The configuration a report is about. Module-level because the negative-set block below needs it too. */
const context: RunContext = {
  commit: 'abc1234',
  providerId: 'local:a-model:fp32',
  embeddingModel: 'a-model',
  embeddingDtype: 'fp32',
  dimensions: 384,
  chunkMaxTokens: 400,
  chunkOverlapTokens: 50,
  searchLimit: 10,
  hnswScan: 'ef_search=100, iterative_scan=relaxed_order, max_scan_tuples=20000',
  textSearchConfig: 'simple',
  resultSelection: 'max_per_document=2, neighbor_context=1, score_floor=0.82',
  documents: 3,
  chunks: 9,
  startedAt: '2026-09-18T03:00:00.000Z',
  totalMs: 12_000,
  modelLoadMs: 3000,
  indexMs: 7000,
  searchMs: 2000,
};

describe('the report', () => {
  const report = buildReport(
    [
      scoreRow(question({ id: 'a', lang: 'en', tags: ['install'] }), INSTALL_HITS),
      scoreRow(question({ id: 'b', lang: 'tr', tags: ['install', 'cross-lingual'], expectFile: 'tr/kurulum.md' }), INSTALL_HITS),
    ],
    context,
    { recall5: 0.45, headingRecall5: null },
  );

  it('breaks the same four metrics down by language and by tag', () => {
    expect(report.overall.questions).toBe(2);
    expect(report.byLang.en.recall1).toBe(1);
    expect(report.byLang.tr.recall1).toBe(0);
    // One question carries two tags, so it is counted under both — a tag row is a slice, not a partition.
    expect(report.byTag.install.questions).toBe(2);
    expect(report.byTag['cross-lingual'].questions).toBe(1);
  });

  it('says which floor the run was judged against, in both formats', () => {
    expect(formatText(report)).toContain('The gate passed.');
    expect(formatMarkdown(report)).toContain('**The retrieval gate passed.**');
  });

  it('renders both formats without throwing, and names the configuration in each', () => {
    for (const rendered of [formatText(report), formatMarkdown(report)]) {
      expect(rendered).toContain('local:a-model:fp32');
      expect(rendered).toContain('400');
      // The cap and the floor are part of the configuration a number is about, exactly as `ef_search`
      // is: two runs at different values are not comparable (ADR-0042).
      expect(rendered).toContain('max_per_document=2');
    }
  });

  it('counts what the relevance floor refused apart from what retrieval missed', () => {
    // Three questions, two of them gated. One of the gated ones had its answer at rank 1 — that is the
    // floor's price — and the other had missed anyway, which costs nothing to refuse. `recall@5` is
    // unmoved by either, which is the whole reason these are separate numbers.
    const gatedWithAnswer = scoreRow(question({ id: 'gated-hit' }), INSTALL_HITS, true);
    const gatedMiss = scoreRow(question({ id: 'gated-miss', expectFile: 'tr/kurulum.md' }), [INSTALL_HITS[0]], true);
    const answered = scoreRow(question({ id: 'answered' }), INSTALL_HITS);
    const metrics = aggregate([gatedWithAnswer, gatedMiss, answered]);

    expect(metrics.gated).toBe(2);
    expect(metrics.gatedWithAnswer).toBe(1);
    expect(metrics.recall5).toBeCloseTo(2 / 3, 10);
  });

  it('names every gated question in the report, because a count alone cannot be argued with', () => {
    const gated = buildReport([scoreRow(question({ id: 'refused' }), INSTALL_HITS, true)], context, NO_FLOORS);
    const text = formatText(gated);

    expect(text).toContain('1 of 1 questions would be told "no good match"');
    expect(text).toContain('refused');
    expect(formatMarkdown(gated)).toContain('relevance floor would refuse 1 of 1');
  });

  it('says so when nothing falls under the floor, rather than printing nothing at all', () => {
    expect(formatText(report)).toContain('no question in the set falls under it');
  });

  /**
   * The gate decides whether a pull request merges, so its arithmetic is tested here for the reason the
   * rest of this file exists: a gate that is wrong in the lenient direction is invisible, and one that
   * is wrong in the strict direction gets switched off ([ADR-0044](../../.ssot/ADR.md#adr-0044)).
   */
  describe('the gate', () => {
    // Four questions: two answered at rank 1, two missed entirely. recall@5 is 0.5. Three carry a
    // heading and one of those found it, so heading@5 is 1/3 — deliberately different from recall@5,
    // because a gate that confused the two would pass every test written on a fixture where they agree.
    const rows = [
      scoreRow(question({ id: 'a', expectHeading: 'Install > Docker' }), INSTALL_HITS),
      scoreRow(question({ id: 'b', expectHeading: 'Install > From source' }), INSTALL_HITS),
      scoreRow(question({ id: 'c', expectHeading: 'Kurulum', expectFile: 'tr/kurulum.md' }), [INSTALL_HITS[0]]),
      scoreRow(question({ id: 'd', expectFile: 'tr/kurulum.md' }), [INSTALL_HITS[0]]),
    ];
    const withFloors = (floors: Floors): Report => buildReport(rows, context, floors);

    it('is not enforced at all when no floor was given, and the report says nothing about one', () => {
      const verdict = gateVerdict(withFloors(NO_FLOORS));
      expect(verdict.enforced).toBe(false);
      expect(verdict.passed).toBe(true);
      expect(formatText(withFloors(NO_FLOORS))).not.toContain('gate');
    });

    it('passes when the measured figure equals the floor, because a floor is a floor and not a margin', () => {
      expect(gateVerdict(withFloors({ recall5: 0.5, headingRecall5: null })).passed).toBe(true);
      expect(gateVerdict(withFloors({ recall5: 0.51, headingRecall5: null })).passed).toBe(false);
    });

    it('names the measured figure, the questions behind it, the floor and the configuration when it fails', () => {
      const verdict = gateVerdict(withFloors({ recall5: 0.75, headingRecall5: null }));
      expect(verdict.passed).toBe(false);
      // The whole point of the message: a CI log that explains itself without opening the artifact.
      expect(verdict.lines[0]).toContain('50.0%');
      expect(verdict.lines[0]).toContain('(2 of 4)');
      expect(verdict.lines[0]).toContain('BELOW');
      expect(verdict.lines[0]).toContain('75.0%');
      expect(verdict.lines[1]).toContain('local:a-model:fp32');
      expect(verdict.lines[1]).toContain('CHUNK_MAX_TOKENS=400');
    });

    /**
     * The reason there are two floors. `CHUNK_MAX_TOKENS=496` on the shipped model measures `recall@5`
     * 85.9 % — over the floor — and `heading@5` 78.1 %, four questions down: the right document found
     * through the wrong chunk of it, which is the defect ROADMAP.md Item 1 existed to fix. A gate on
     * one number would let it through.
     */
    it('fails on heading@5 alone, which is the case a file-level floor cannot see', () => {
      const verdict = gateVerdict(withFloors({ recall5: 0.5, headingRecall5: 0.5 }));
      expect(verdict.passed).toBe(false);
      expect(verdict.lines[0]).toContain('above');
      expect(verdict.lines[1]).toContain('BELOW');
      // heading@5 is measured over the three questions that carry a heading, not over all four.
      expect(verdict.lines[1]).toContain('(1 of 3)');
    });

    it('refuses a heading floor over a question set with no headings, rather than scoring it zero', () => {
      const headless = buildReport([scoreRow(question({ id: 'a' }), INSTALL_HITS)], context, { recall5: null, headingRecall5: 0.5 });
      expect(() => gateVerdict(headless)).toThrow(/no question in the set carries an expectHeading/);
    });

    it('tells a red build apart from a green one in the run summary', () => {
      expect(formatMarkdown(withFloors({ recall5: 0.75, headingRecall5: null }))).toContain('**The retrieval gate failed.**');
      expect(formatMarkdown(withFloors({ recall5: 0.25, headingRecall5: null }))).toContain('**The retrieval gate passed.**');
    });
  });
});

/**
 * The negative set: questions whose right answer is "nothing"
 * ([ADR-0045](../../.ssot/ADR.md#adr-0045)).
 *
 * The first test below is the one that matters most in this file, and it is not about arithmetic. A
 * negative question inside `recall@5`'s denominator would move both of ADR-0044's floors without
 * retrieval moving at all — the gate would then be enforcing a number over a question set nobody
 * argued it from, and every figure in `eval/BASELINE.md` would be about a different measurement. It is
 * asserted rather than trusted to the types, because the types can be changed by the same hand that
 * forgets why they were separate.
 */
describe('negative questions and the golden denominators', () => {
  const negatives: NegativeRow[] = [
    { id: 'af-01', lang: 'en', query: 'does it speak SAML', kind: 'absent-feature', note: 'auth page exists, SAML is not on it' },
    { id: 'af-02', lang: 'tr', query: 'Kafka çıkışı var mı', kind: 'absent-feature', note: 'her uç nokta bir URL' },
    { id: 'od-01', lang: 'en', query: 'how do I feed a sourdough starter', kind: 'off-domain' },
    { id: 'od-02', lang: 'tr', query: 'satrançta İspanyol açılışı', kind: 'off-domain' },
  ];

  const goldenRows = [
    scoreRow(question({ id: 'a', expectHeading: 'Install > Docker' }), INSTALL_HITS),
    scoreRow(question({ id: 'b', expectHeading: 'Install > Docker', expectFile: 'tr/kurulum.md' }), [INSTALL_HITS[0]]),
  ];

  // Two refused, two answered — deliberately a different rate from anything on the golden side, so a
  // number that leaked from one set into the other would be visible rather than coincidental.
  const negativeResults = negatives.map((row, i) => scoreNegativeRow(row, INSTALL_HITS, i % 2 === 0));

  it('leaves recall@5, heading@5 and every denominator exactly where they were', () => {
    const without = buildReport(goldenRows, context, NO_FLOORS);
    const withNegatives = buildReport(goldenRows, context, NO_FLOORS, buildRefusalReport(goldenRows, negativeResults, 0.82));

    expect(withNegatives.overall.questions).toBe(without.overall.questions);
    expect(withNegatives.overall.questions).toBe(2);
    expect(withNegatives.overall.headingQuestions).toBe(without.overall.headingQuestions);
    expect(withNegatives.overall.recall5).toBe(without.overall.recall5);
    expect(withNegatives.overall.headingRecall5).toBe(without.overall.headingRecall5);
    expect(withNegatives.overall.mrr).toBe(without.overall.mrr);
    // And not by accident of the overall row: the per-language slices are denominators too.
    expect(Object.keys(withNegatives.byLang)).toEqual(Object.keys(without.byLang));
    expect(withNegatives.byLang.en.questions).toBe(without.byLang.en.questions);
    expect(withNegatives.results.map((r) => r.row.id)).toEqual(['a', 'b']);
  });

  it('reports three bands over the right questions, and the floor they were computed at', () => {
    const refusals = buildRefusalReport(goldenRows, negativeResults, 0.82);
    expect(refusals.floor).toBe(0.82);
    expect(refusals.absentFeature.questions).toBe(2);
    expect(refusals.absentFeature.refused).toBe(1);
    expect(refusals.absentFeature.rate).toBeCloseTo(0.5, 10);
    expect(refusals.offDomain.questions).toBe(2);
    expect(refusals.offDomain.refused).toBe(1);
    // The cost band is the golden set, and it says how many of the refusals had the answer on the page.
    expect(refusals.falseRefusal.questions).toBe(2);
    expect(refusals.falseRefusal.refused).toBe(0);
    expect(refusals.falseRefusal.withAnswer).toBe(0);
  });

  it('counts a false refusal that hid an answer, which is the only number that makes the floor a trade', () => {
    const gated = [
      scoreRow(question({ id: 'a' }), INSTALL_HITS, true),
      scoreRow(question({ id: 'b', expectFile: 'tr/kurulum.md' }), [INSTALL_HITS[0]], true),
    ];
    const refusals = buildRefusalReport(gated, negativeResults, 0.82);
    expect(refusals.falseRefusal.refused).toBe(2);
    expect(refusals.falseRefusal.withAnswer).toBe(1);
    expect(refusals.falseRefusal.rate).toBe(1);
  });

  it('rates an empty band at zero rather than dividing by it', () => {
    const refusals = buildRefusalReport(goldenRows, [], 0.82);
    expect(refusals.absentFeature.questions).toBe(0);
    expect(refusals.absentFeature.rate).toBe(0);
    expect(formatText(buildReport(goldenRows, context, NO_FLOORS, refusals))).toContain('absent-feature');
  });

  it('prints all three rates in both formats, and says the floor is not gated on them', () => {
    const report = buildReport(goldenRows, context, NO_FLOORS, buildRefusalReport(goldenRows, negativeResults, 0.82));
    const text = formatText(report);
    expect(text).toContain('false refusal');
    expect(text).toContain('absent-feature');
    expect(text).toContain('off-domain');
    expect(text).toContain('SEARCH_SCORE_FLOOR=0.82');
    expect(text).toContain('never gated');
    // The questions the floor let through are named, because a rate alone cannot be argued with.
    expect(text).toContain('af-02');

    const markdown = formatMarkdown(report);
    expect(markdown).toContain('Refusal rates');
    expect(markdown).toContain('`absent-feature`');
    expect(markdown).toContain('`off-domain`');
  });

  it('says nothing at all about refusals when no negative set was asked', () => {
    const text = formatText(buildReport(goldenRows, context, NO_FLOORS));
    expect(text).not.toContain('refusal rates');
    expect(formatMarkdown(buildReport(goldenRows, context, NO_FLOORS))).not.toContain('Refusal rates');
  });
});

describe('loading negative.jsonl', () => {
  const absent = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ id: 'af-01', lang: 'en', query: 'does it speak SAML', kind: 'absent-feature', note: 'not on the auth page', ...over });

  it('accepts both kinds, and an off-domain question with no note', () => {
    const rows = parseNegativeSet(`${absent()}\n\n{"id":"od-01","lang":"tr","query":"ekşi maya","kind":"off-domain"}\n`);
    expect(rows.map((r) => r.id)).toEqual(['af-01', 'od-01']);
    expect(rows[0].kind).toBe('absent-feature');
    expect(rows[1].note).toBeUndefined();
  });

  /**
   * The note on an absent-feature question is a claim about the corpus — *this is not written down
   * here* — and a claim nobody wrote down is a claim nobody can re-check when a page is added.
   */
  it('refuses an absent-feature question with no note, because the note is what makes it checkable', () => {
    expect(() => parseNegativeSet(`${absent({ note: undefined })}\n`)).toThrow(NegativeSetError);
  });

  it('refuses a kind it does not know, rather than filing it under one it does', () => {
    expect(() => parseNegativeSet(`${absent({ kind: 'hard' })}\n`)).toThrow(NegativeSetError);
  });

  it('fails on a malformed line, an unknown field and a duplicate id, exactly as the golden loader does', () => {
    expect(() => parseNegativeSet(`${absent()}\n{not json\n`)).toThrow(/negative\.jsonl:2/);
    expect(() => parseNegativeSet(`${absent({ expectFile: 'en/install.md' })}\n`)).toThrow(NegativeSetError);
    expect(() => parseNegativeSet(`${absent()}\n${absent()}\n`)).toThrow(/duplicate id/);
  });

  it('fails on an empty file, because a negative set that silently vanished is a refusal rate of zero', () => {
    expect(() => parseNegativeSet('\n\n')).toThrow(/no questions/);
  });

  /**
   * The reason this is a second file and not an optional `expectFile` on the golden row: a golden
   * question that lost its answer must stay a hard failure, not become a question with no answer.
   */
  it('cannot express a golden question, and the golden loader cannot express a negative one', () => {
    expect(() => parseNegativeSet(`${JSON.stringify({ id: 'a', lang: 'en', query: 'q', expectFile: 'en/install.md' })}\n`)).toThrow(NegativeSetError);
    expect(() => parseGoldenSet(`${absent()}\n`, CORPUS)).toThrow(GoldenSetError);
  });
});
