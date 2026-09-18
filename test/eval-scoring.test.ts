import { describe, expect, it } from 'vitest';

import {
  aggregate,
  buildReport,
  formatMarkdown,
  formatText,
  GoldenSetError,
  headingMatches,
  parseGoldenSet,
  scoreRow,
  worstMisses,
  type GoldenRow,
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

describe('the report', () => {
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
    documents: 3,
    chunks: 9,
    startedAt: '2026-09-18T03:00:00.000Z',
    totalMs: 12_000,
    modelLoadMs: 3000,
    indexMs: 7000,
    searchMs: 2000,
  };

  const report = buildReport(
    [
      scoreRow(question({ id: 'a', lang: 'en', tags: ['install'] }), INSTALL_HITS),
      scoreRow(question({ id: 'b', lang: 'tr', tags: ['install', 'cross-lingual'], expectFile: 'tr/kurulum.md' }), INSTALL_HITS),
    ],
    context,
    0.45,
  );

  it('breaks the same four metrics down by language and by tag', () => {
    expect(report.overall.questions).toBe(2);
    expect(report.byLang.en.recall1).toBe(1);
    expect(report.byLang.tr.recall1).toBe(0);
    // One question carries two tags, so it is counted under both — a tag row is a slice, not a partition.
    expect(report.byTag.install.questions).toBe(2);
    expect(report.byTag['cross-lingual'].questions).toBe(1);
  });

  it('says the floor was not enforced rather than leaving it out', () => {
    expect(formatText(report)).toContain('Not enforced in this phase');
  });

  it('renders both formats without throwing, and names the configuration in each', () => {
    for (const rendered of [formatText(report), formatMarkdown(report)]) {
      expect(rendered).toContain('local:a-model:fp32');
      expect(rendered).toContain('400');
    }
  });
});
