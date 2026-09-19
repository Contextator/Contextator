import { describe, expect, it } from 'vitest';
import { GoldenRowSchema } from '../scripts/eval-scoring.js';
import { buildExport, exportNote, questionId, toJsonl } from '../src/services/query-export.js';
import { type RepeatedQuestion, rankQuestionsByGap } from '../src/services/query-summary.js';

/**
 * The arithmetic and the file shape of the query panel ([ADR-0050](../.ssot/ADR.md#adr-0050)), with no
 * database in it. `test/integration/query-summary.itest.ts` asserts that PostgreSQL agrees.
 *
 * The ordering is the whole product decision: [ADR-0042](../.ssot/ADR.md#adr-0042) and
 * [ADR-0045](../.ssot/ADR.md#adr-0045) between them rule out any threshold that could print
 * "unanswered" beside a row, so what ships is a **ranking** — and a ranking is exactly the kind of
 * thing that can quietly stop ranking while every integration test still passes.
 */

const q = (queryNorm: string, asked: number, bestScore: number | null) => ({ queryNorm, asked, bestScore });

describe('ranking the repeated questions', () => {
  /**
   * The case the panel exists for, stated as a test: forty-one agents asking one thing that never
   * scored above 0.84 must sit above one asking with a terrible score. A ranking that read only the
   * score would invert exactly this pair, and it is the inversion that makes a panel useless — the
   * bottom of a query log is full of one-off questions with bad scores and always will be.
   */
  it('puts the repeated question with a passing score above the one-off with a terrible one', () => {
    const ranked = rankQuestionsByGap([q('how do i rotate the webhook secret', 41, 0.84), q('what is the airspeed of a swallow', 1, 0.31)]);
    expect(ranked.map((r) => r.queryNorm)).toEqual(['how do i rotate the webhook secret', 'what is the airspeed of a swallow']);
  });

  // Both names below are chosen so that the alphabetical last-resort tiebreak points the *wrong* way.
  // Without that the test passes under a ranking that dropped one of the two lists entirely, on the
  // tiebreak alone, which is a green test asserting nothing.
  it('separates two equally repeated questions by how badly each was answered', () => {
    const ranked = rankQuestionsByGap([q('a answered well', 20, 0.91), q('z answered badly', 20, 0.84)]);
    expect(ranked.map((r) => r.queryNorm)).toEqual(['z answered badly', 'a answered well']);
  });

  it('separates two equally answered questions by how often each was asked', () => {
    const ranked = rankQuestionsByGap([q('a asked once', 1, 0.84), q('z asked often', 30, 0.84)]);
    expect(ranked.map((r) => r.queryNorm)).toEqual(['z asked often', 'a asked once']);
  });

  /** "Nothing came back" is the extreme of "the best match never rose far", not a middling 0. */
  it('ranks a question that returned nothing at all as the worst-answered', () => {
    const ranked = rankQuestionsByGap([q('nothing', 5, null), q('something', 5, 0.2), q('plenty', 5, 0.9)]);
    expect(ranked[0].queryNorm).toBe('nothing');
    expect(ranked.find((r) => r.queryNorm === 'nothing')?.scoreRank).toBe(1);
  });

  /**
   * **No cut-off anywhere.** A minimum count or a score threshold would be the thing ADR-0045
   * refuted, wearing a different hat; the only bound is the page size, which changes no ordering.
   */
  it('returns every group it was given, including the ones asked once', () => {
    const groups = [q('a', 1, 0.99), q('b', 1, 0.98), q('c', 2, 0.5), q('d', 1, null)];
    expect(rankQuestionsByGap(groups)).toHaveLength(4);
  });

  it('gives tied groups the same rank, as PostgreSQL rank() does', () => {
    const ranked = rankQuestionsByGap([q('a', 10, 0.5), q('b', 10, 0.5), q('c', 1, 0.9)]);
    const byNorm = new Map(ranked.map((r) => [r.queryNorm, r]));
    expect(byNorm.get('a')?.askedRank).toBe(1);
    expect(byNorm.get('b')?.askedRank).toBe(1);
    expect(byNorm.get('c')?.askedRank).toBe(3);
  });

  it('is a total order, so two runs over the same groups agree', () => {
    const groups = [q('a', 3, 0.5), q('b', 3, 0.5), q('c', 3, 0.5)];
    expect(rankQuestionsByGap(groups).map((r) => r.queryNorm)).toEqual(rankQuestionsByGap([...groups].reverse()).map((r) => r.queryNorm));
  });
});

// ---------- the export ----------

const question = (over: Partial<RepeatedQuestion> = {}): RepeatedQuestion => ({
  queryNorm: 'how do i rotate the webhook secret',
  sample: 'How do I rotate the webhook secret?',
  asked: 41,
  askers: 3,
  unattributed: 0,
  days: 6,
  bestScore: 0.841,
  everRefused: false,
  firstAskedAt: '2026-09-12T08:00:00.000Z',
  lastAskedAt: '2026-09-19T11:00:00.000Z',
  askedRank: 1,
  scoreRank: 1,
  gapScore: 0.032,
  paths: [{ relativePath: 'handbook/webhooks.md', headingPath: 'Rotating the secret', bestScore: 0.841, returned: 38 }],
  ...over,
});

describe('the exported question set', () => {
  it('derives a stable id from the normalised question, in the harness id alphabet', () => {
    const id = questionId('how do i rotate the webhook secret');
    expect(id).toBe(questionId('how do i rotate the webhook secret'));
    expect(id).not.toBe(questionId('something else entirely'));
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('lengthens an id rather than colliding with one already taken', () => {
    const first = questionId('a question');
    const second = questionId('a question', new Set([first]));
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
  });

  /**
   * **The decision this file is the evidence for.** The row is the harness's own shape with the two
   * fields the log cannot know left out, so the file fails `parseGoldenSet` until a person has made
   * both judgements — and it passes the moment they have, with nothing else to change and no
   * conversion step. A row that validated as it stands would be a row claiming a document answered a
   * question when nobody had checked.
   */
  it('is the harness golden row minus exactly expectFile and lang', () => {
    const [row] = buildExport([question()]);
    const parsed = GoldenRowSchema.safeParse(row);
    expect(parsed.success).toBe(false);
    const missing = (parsed.success ? [] : parsed.error.issues).map((issue) => issue.path.join('.')).sort();
    expect(missing).toEqual(['expectFile', 'lang']);

    // And those two are the whole of the operator's edit: nothing else is wrong with the line.
    expect(GoldenRowSchema.safeParse({ ...row, lang: 'en', expectFile: 'handbook/webhooks.md' }).success).toBe(true);
  });

  it('carries no key the strict schema would reject', () => {
    const [row] = buildExport([question()]);
    expect(Object.keys(row).sort()).toEqual(['id', 'note', 'query']);
  });

  /** The raw spelling somebody typed, not the normalised fold: a golden question is read by people. */
  it('exports the question as it was typed', () => {
    const [row] = buildExport([question()]);
    expect(row.query).toBe('How do I rotate the webhook secret?');
  });

  /**
   * `note` is where the candidate shape's information went. `strictObject` leaves no room for a
   * structured `candidates` key, so the documents the search *did* return travel as prose in the one
   * free-text field the schema already has — which is what lets a person fill in `expectFile` by
   * choosing rather than by re-running the search.
   */
  it('names what the search did return, and what the operator still has to decide', () => {
    const note = exportNote(question());
    expect(note).toContain('Asked 41x by 3 tokens on 6 days');
    expect(note).toContain('2026-09-12 to 2026-09-19');
    expect(note).toContain('Best match ever: 0.841');
    expect(note).toContain('handbook/webhooks.md > Rotating the secret (0.841, 38x)');
    expect(note).toContain('"expectFile"');
    expect(note).toContain('"lang"');
  });

  it('says plainly when a question returned nothing, and when nothing could be attributed', () => {
    const note = exportNote(question({ bestScore: null, paths: [], askers: 0, unattributed: 41 }));
    expect(note).toContain('nothing came back');
    expect(note).toContain('It returned nothing at all.');
    expect(note).toContain('no token attribution');
  });

  it('writes one JSON object per line, each of them a single line', () => {
    const jsonl = toJsonl(buildExport([question(), question({ queryNorm: 'another', sample: 'Another?' })]));
    const lines = jsonl.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(jsonl.endsWith('\n')).toBe(true);
  });

  it('writes an empty file rather than a blank line when there is nothing to export', () => {
    expect(toJsonl([])).toBe('');
  });
});
