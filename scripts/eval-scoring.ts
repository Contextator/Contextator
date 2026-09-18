import { z } from 'zod';

/**
 * The scoring half of `npm run eval`, with nothing in it that touches a database, a model or a clock.
 *
 * It is a separate module from `scripts/eval.ts` for one reason: a scoring bug reads as a retrieval
 * result. If `recall@5` moves after a Phase 1 change, the first question is whether retrieval changed
 * or whether the arithmetic did, and that question is only cheap to answer while the arithmetic can be
 * tested without a container and a 465 MB download. `test/eval-scoring.test.ts` is that test
 * ([ADR-0034](../../.ssot/ADR.md#adr-0034)).
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const GoldenRowSchema = z.strictObject({
  /** Stable and unique; it appears in the miss list and in diffs, so it is never renumbered. */
  id: z.string().regex(ID_RE, 'must be lowercase letters, digits and hyphens'),
  /** The language of the *question*. A Turkish question about an English page is `tr`. */
  lang: z.enum(['en', 'tr']),
  query: z.string().min(1),
  /** Relative to `eval/corpus/`, exactly as the file is spelled on disk. */
  expectFile: z.string().min(1),
  /**
   * Matched as a breadcrumb suffix and scored apart from the file-level metrics — never folded into
   * them. ADR-0034 said it gates nothing; since [ADR-0044](../../.ssot/ADR.md#adr-0044) it has a floor
   * of its own, which is still not the same thing as being folded in.
   */
  expectHeading: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  /** Why this question is here, when that is not obvious. Ignored by the scorer. */
  note: z.string().optional(),
});

export type GoldenRow = z.infer<typeof GoldenRowSchema>;

export class GoldenSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenSetError';
  }
}

/**
 * Parses `golden.jsonl`. Every failure here is fatal rather than a skipped line: a question set that
 * silently shrinks is a `recall@5` that silently improves, which is the one failure mode a measurement
 * must not have. `corpusFiles` is passed in so that a question pointing at a file nobody has written —
 * or at one that has since been renamed — fails the run instead of scoring zero forever.
 */
export function parseGoldenSet(text: string, corpusFiles: ReadonlySet<string>): GoldenRow[] {
  const rows: GoldenRow[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const where = `golden.jsonl:${index + 1}`;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new GoldenSetError(`${where}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }

    const parsed = GoldenRowSchema.safeParse(json);
    if (!parsed.success) throw new GoldenSetError(`${where}: ${z.prettifyError(parsed.error).replace(/\n\s*/g, ' ')}`);

    const row = parsed.data;
    if (seen.has(row.id)) throw new GoldenSetError(`${where}: duplicate id ${JSON.stringify(row.id)}`);
    seen.add(row.id);

    if (!corpusFiles.has(row.expectFile)) {
      throw new GoldenSetError(`${where}: expectFile ${JSON.stringify(row.expectFile)} is not a file under eval/corpus/`);
    }
    rows.push(row);
  }

  if (rows.length === 0) throw new GoldenSetError('golden.jsonl holds no questions');
  return rows;
}

/** One search hit, reduced to the three things scoring looks at. */
export interface ScoredHit {
  file: string;
  headingPath: string;
  score: number;
}

export interface RowResult {
  row: GoldenRow;
  /**
   * Whether the relevance floor would have answered "no good match" for this question instead of the
   * hits below ([ADR-0042](../../.ssot/ADR.md#adr-0042)).
   *
   * It is recorded beside the rank rather than folded into it, because the two say different things
   * and only one of them is a retrieval result. A gated question whose answer was at rank 1 is the
   * floor being wrong; a gated question that missed anyway is the floor being right. `recall@5` cannot
   * tell them apart, which is why it is not the number the floor is judged on.
   */
  belowFloor: boolean;
  /** 0-based rank of the first hit from `expectFile`, or `null` when it is not in the returned hits. */
  rank: number | null;
  /** 0-based rank of the first hit from `expectFile` whose breadcrumb also matches `expectHeading`. */
  headingRank: number | null;
  /** Similarity of the hit at `rank`. `null` when there is no correct hit to take it from. */
  score: number | null;
  hits: ScoredHit[];
}

/**
 * `expectHeading` matches a breadcrumb suffix on a separator boundary: `Docker olmadan` matches
 * `Tek sunucuya kurulum > Docker olmadan` and does not match `… > Hiç Docker olmadan`. A bare
 * `endsWith` would make the second one count, and a heading metric that is generous in a way nobody
 * notices is a heading metric that cannot be compared with itself.
 */
export function headingMatches(headingPath: string, expected: string): boolean {
  return headingPath === expected || headingPath.endsWith(` > ${expected}`);
}

/**
 * `belowFloor` defaults to false so that a caller measuring retrieval alone — every test in
 * `test/eval-scoring.test.ts` — says nothing about a gate it is not exercising. `scripts/eval.ts`
 * passes what `searchProject` answered.
 */
export function scoreRow(row: GoldenRow, hits: readonly ScoredHit[], belowFloor = false): RowResult {
  const rank = hits.findIndex((hit) => hit.file === row.expectFile);
  const headingRank = row.expectHeading
    ? hits.findIndex((hit) => hit.file === row.expectFile && headingMatches(hit.headingPath, row.expectHeading as string))
    : -1;
  return {
    row,
    belowFloor,
    rank: rank === -1 ? null : rank,
    headingRank: !row.expectHeading || headingRank === -1 ? null : headingRank,
    score: rank === -1 ? null : hits[rank].score,
    hits: [...hits],
  };
}

export interface Metrics {
  questions: number;
  recall1: number;
  recall5: number;
  mrr: number;
  /** Mean similarity of the correct hit, over the questions that found one. `null` when none did. */
  meanCorrectScore: number | null;
  /** How many of `questions` carry an `expectHeading` at all; the two below are over that subset. */
  headingQuestions: number;
  headingRecall1: number;
  headingRecall5: number;
  /** Questions the relevance floor would have refused rather than answered (ADR-0042). */
  gated: number;
  /**
   * Of those, how many had their answer inside the top five anyway — **the floor's price**, and the
   * only number that says whether it is worth having. A question that was going to miss regardless
   * costs nothing to refuse; one whose answer was on the page costs everything.
   */
  gatedWithAnswer: number;
}

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

export function aggregate(results: readonly RowResult[]): Metrics {
  const withHeading = results.filter((r) => r.row.expectHeading !== undefined);
  const correctScores = results.filter((r) => r.score !== null).map((r) => r.score as number);
  return {
    questions: results.length,
    recall1: mean(results.map((r) => (r.rank === 0 ? 1 : 0))),
    recall5: mean(results.map((r) => (r.rank !== null && r.rank < 5 ? 1 : 0))),
    mrr: mean(results.map((r) => (r.rank === null ? 0 : 1 / (r.rank + 1)))),
    meanCorrectScore: correctScores.length === 0 ? null : mean(correctScores),
    headingQuestions: withHeading.length,
    headingRecall1: mean(withHeading.map((r) => (r.headingRank === 0 ? 1 : 0))),
    headingRecall5: mean(withHeading.map((r) => (r.headingRank !== null && r.headingRank < 5 ? 1 : 0))),
    gated: results.filter((r) => r.belowFloor).length,
    gatedWithAnswer: results.filter((r) => r.belowFloor && r.rank !== null && r.rank < 5).length,
  };
}

/** Groups results by every key a row produces — one key for `lang`, one per entry in `tags`. */
export function groupBy(results: readonly RowResult[], keys: (result: RowResult) => readonly string[]): Map<string, RowResult[]> {
  const groups = new Map<string, RowResult[]>();
  for (const result of results) {
    for (const key of keys(result)) {
      const bucket = groups.get(key);
      if (bucket) bucket.push(result);
      else groups.set(key, [result]);
    }
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The worst misses, which is the part of the report that turns a number into something to do. A
 * question that found nothing is worse than one that found its answer at rank 8; between two that found
 * nothing, the one whose top hit scored highest is worse, because a confident wrong answer is what an
 * agent will act on.
 */
export function worstMisses(results: readonly RowResult[], count: number): RowResult[] {
  return [...results]
    .filter((r) => r.rank !== 0)
    .sort((a, b) => {
      const rrA = a.rank === null ? 0 : 1 / (a.rank + 1);
      const rrB = b.rank === null ? 0 : 1 / (b.rank + 1);
      if (rrA !== rrB) return rrA - rrB;
      return (b.hits[0]?.score ?? 0) - (a.hits[0]?.score ?? 0);
    })
    .slice(0, count);
}

export interface RunContext {
  commit: string;
  providerId: string;
  embeddingModel: string;
  embeddingDtype: string;
  dimensions: number;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  searchLimit: number;
  /**
   * The pgvector scan settings the run searched under, rendered for the report (ADR-0040). A recall
   * number is a number about a configuration, and `hnsw.ef_search` is now part of that configuration:
   * two runs at different values are not comparable, and without this line nothing would say so.
   */
  hnswScan: string;
  /**
   * The text search configuration the lexical half of retrieval ran in, on both sides
   * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). Here for `hnswScan`'s reason: two runs at different
   * configurations are not comparable, and without this line nothing would say so.
   */
  textSearchConfig: string;
  /**
   * How the fused list was turned into an answer ([ADR-0042](../../.ssot/ADR.md#adr-0042)): the
   * per-document cap, the neighbour context and the relevance floor, rendered for the report. Here for
   * `hnswScan`'s reason — the cap changes `recall@5` and the floor changes what a caller is told, so a
   * run that did not print them is a run nobody can compare.
   */
  resultSelection: string;
  documents: number;
  chunks: number;
  startedAt: string;
  /** Wall clock of the whole run, and of the two parts worth knowing separately. */
  totalMs: number;
  modelLoadMs: number;
  indexMs: number;
  searchMs: number;
}

/**
 * The floors a run is judged against ([ADR-0044](../../.ssot/ADR.md#adr-0044)). Both are `null` by
 * default, and with both null `npm run eval` is the report it has always been: it measures, it prints,
 * it exits `0`.
 *
 * There are two of them and not one because they fail differently. `recall@5` asks whether the right
 * *document* came back; `heading@5` asks whether the right *chunk* of it did, over the same sixty-four
 * questions. A chunk budget the model cannot read to the end of keeps the first and loses the second —
 * measured, not supposed: `CHUNK_MAX_TOKENS=496` on the shipped model measures `recall@5` 85.9 %, which
 * clears the floor below, and `heading@5` 78.1 %, which is four questions down and is the defect
 * ROADMAP.md Item 1 existed to fix.
 */
export interface Floors {
  /** `--min-recall5`: the answer's file is in the top five. */
  recall5: number | null;
  /** `--min-heading5`: the answer's chunk is, over the questions carrying an `expectHeading`. */
  headingRecall5: number | null;
}

export const NO_FLOORS: Floors = { recall5: null, headingRecall5: null };

export interface Report {
  context: RunContext;
  overall: Metrics;
  byLang: Record<string, Metrics>;
  byTag: Record<string, Metrics>;
  /** What the run was gated on, carried into the JSON so an artifact says what it had to clear. */
  floors: Floors;
  results: RowResult[];
}

export function buildReport(results: readonly RowResult[], context: RunContext, floors: Floors): Report {
  const toRecord = (groups: Map<string, RowResult[]>): Record<string, Metrics> =>
    Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, aggregate(rows)]));
  return {
    context,
    overall: aggregate(results),
    byLang: toRecord(groupBy(results, (r) => [r.row.lang])),
    byTag: toRecord(groupBy(results, (r) => r.row.tags)),
    floors,
    results: [...results],
  };
}

export interface GateVerdict {
  /** False when no floor was given at all, which is the report-only run. */
  enforced: boolean;
  passed: boolean;
  /** One line per floor, then the configuration the numbers are about. Rendered for a log, not a table. */
  lines: string[];
}

/**
 * Compares the measured figures against the floors and says so in words.
 *
 * The lines are the whole point. A build that goes red on a percentage nobody can see is a build
 * somebody turns off, so a failing run states the measured figure, the count behind it, the floor it
 * missed, and the configuration it was measured at — because `recall@5` is a number about a
 * configuration and a run at a different `CHUNK_MAX_TOKENS` or a different model is not the same
 * measurement (ADR-0034, ADR-0044).
 */
export function gateVerdict(report: Report): GateVerdict {
  const { overall, floors } = report;
  if (floors.headingRecall5 !== null && overall.headingQuestions === 0) {
    throw new Error('--min-heading5 was given, but no question in the set carries an expectHeading, so heading@5 is not a measurement.');
  }

  const checks = [
    { label: 'recall@5 ', measured: overall.recall5, of: overall.questions, floor: floors.recall5 },
    { label: 'heading@5', measured: overall.headingRecall5, of: overall.headingQuestions, floor: floors.headingRecall5 },
  ].flatMap((c) => (c.floor === null ? [] : [{ ...c, floor: c.floor }]));

  if (checks.length === 0) return { enforced: false, passed: true, lines: [] };

  const lines = checks.map((c) => {
    const verdict = c.measured < c.floor ? 'BELOW' : 'above';
    // The count as well as the percentage: sixty-four questions means one of them is 1.6 points, and a
    // floor argued in questions should be readable in questions.
    return `${c.label}  ${pct(c.measured)} (${Math.round(c.measured * c.of)} of ${c.of})  ${verdict} the ${pct(c.floor).trim()} floor`;
  });
  lines.push(`measured at ${configurationSummary(report.context)}`);
  return { enforced: true, passed: checks.every((c) => c.measured >= c.floor), lines };
}

const pct = (value: number): string => `${(value * 100).toFixed(1).padStart(5)}%`;
const sim = (value: number | null): string => (value === null ? '    —' : value.toFixed(3));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * The configuration a number is about, on one line. `tick` wraps each value — a backtick for the
 * Markdown summary, nothing for a log line that is read as plain text. One function rather than two
 * strings, because the failing gate message and the pull request summary must not drift into naming
 * different halves of the same configuration.
 */
function configurationSummary(c: RunContext, tick = ''): string {
  const v = (value: string): string => `${tick}${value}${tick}`;
  return (
    `${v(c.providerId)} · ${v(`CHUNK_MAX_TOKENS=${c.chunkMaxTokens}`)} · ${v(`CHUNK_OVERLAP_TOKENS=${c.chunkOverlapTokens}`)} · ` +
    `${c.documents} documents, ${c.chunks} chunks · ${c.hnswScan} · ${v(`to_tsvector('${c.textSearchConfig}', …)`)} · ` +
    `${c.resultSelection} · commit ${v(c.commit)}`
  );
}

function metricRow(label: string, m: Metrics, width: number): string {
  const heading = m.headingQuestions === 0 ? '   —  ' : pct(m.headingRecall5);
  return `  ${label.padEnd(width)} ${String(m.questions).padStart(3)}  ${pct(m.recall1)}  ${pct(m.recall5)}  ${m.mrr.toFixed(3)}  ${sim(m.meanCorrectScore)}  ${heading}`;
}

export function formatText(report: Report): string {
  const { context: c, overall } = report;
  const out: string[] = [];

  out.push('Retrieval evaluation — eval/corpus + eval/golden.jsonl');
  out.push('');
  out.push(`  commit              ${c.commit}`);
  out.push(`  provider            ${c.providerId}`);
  out.push(`  dimensions          ${c.dimensions}`);
  out.push(`  CHUNK_MAX_TOKENS    ${c.chunkMaxTokens}`);
  out.push(`  CHUNK_OVERLAP_TOKENS ${c.chunkOverlapTokens}`);
  out.push(`  corpus              ${c.documents} documents, ${c.chunks} chunks`);
  out.push(`  search limit        ${c.searchLimit} (MRR is MRR@${c.searchLimit})`);
  out.push(`  HNSW scan           ${c.hnswScan}`);
  out.push(`  text search config  ${c.textSearchConfig} (both sides — the corpus and the questions)`);
  out.push(`  result selection    ${c.resultSelection}`);
  out.push(
    `  timing              ${seconds(c.totalMs)} total — model ${seconds(c.modelLoadMs)}, index ${seconds(c.indexMs)}, search ${seconds(c.searchMs)}`,
  );
  out.push('');

  const labels = ['overall', ...Object.keys(report.byLang).map((k) => `lang ${k}`), ...Object.keys(report.byTag).map((k) => `tag ${k}`)];
  const width = Math.max(...labels.map((l) => l.length));

  out.push(`  ${'group'.padEnd(width)}   n  rec@1  rec@5    MRR  score  head@5`);
  out.push(`  ${'-'.repeat(width)} ---- ------ ------ ------ ------ -------`);
  out.push(metricRow('overall', overall, width));
  out.push('');
  for (const [lang, m] of Object.entries(report.byLang)) out.push(metricRow(`lang ${lang}`, m, width));
  out.push('');
  for (const [tag, m] of Object.entries(report.byTag)) out.push(metricRow(`tag ${tag}`, m, width));
  out.push('');

  // The floor's own line, and deliberately not a column in the table above: it is not a retrieval
  // metric. `recall@5` counts a question the floor refused as answered, because retrieval did answer
  // it — what the floor costs is the second number here (ADR-0042).
  if (overall.gated > 0) {
    out.push(
      `  relevance floor     ${overall.gated} of ${overall.questions} questions would be told "no good match"` +
        ` — ${overall.gatedWithAnswer} of them had the answer inside the top five.`,
    );
    for (const gated of report.results.filter((r) => r.belowFloor)) {
      const where = gated.rank === null ? `missed anyway` : `answer at rank ${gated.rank + 1}`;
      out.push(`    ${gated.row.id} [${gated.row.lang}] ${(gated.hits[0]?.score ?? 0).toFixed(3)} — ${where} — ${gated.row.query}`);
    }
    out.push('');
  } else {
    out.push('  relevance floor     no question in the set falls under it.');
    out.push('');
  }

  const misses = worstMisses(report.results, 5);
  if (misses.length === 0) {
    out.push('  Every question answered at rank 1. Suspect the question set before believing this.');
  } else {
    out.push('  The five worst misses, and what came back instead:');
    for (const miss of misses) {
      out.push('');
      out.push(`  ${miss.row.id} [${miss.row.lang}] ${miss.rank === null ? `not in top ${report.context.searchLimit}` : `rank ${miss.rank + 1}`}`);
      out.push(`    asked     ${miss.row.query}`);
      out.push(`    wanted    ${miss.row.expectFile}${miss.row.expectHeading ? ` — ${miss.row.expectHeading}` : ''}`);
      for (const [i, hit] of miss.hits.slice(0, 3).entries()) {
        out.push(`    got ${i + 1}     ${hit.score.toFixed(3)}  ${hit.file} — ${hit.headingPath}`);
      }
    }
  }
  out.push('');

  const gate = gateVerdict(report);
  if (gate.enforced) {
    out.push(gate.passed ? '  The gate passed.' : '  THE GATE FAILED.');
    for (const line of gate.lines) out.push(`    ${line}`);
    out.push('');
  }
  return out.join('\n');
}

function mdRow(label: string, m: Metrics): string {
  const heading = m.headingQuestions === 0 ? '—' : `${(m.headingRecall5 * 100).toFixed(1)}%`;
  const score = m.meanCorrectScore === null ? '—' : m.meanCorrectScore.toFixed(3);
  return `| ${label} | ${m.questions} | ${(m.recall1 * 100).toFixed(1)}% | ${(m.recall5 * 100).toFixed(1)}% | ${m.mrr.toFixed(3)} | ${score} | ${heading} |`;
}

export function formatMarkdown(report: Report): string {
  const { context: c } = report;
  const out: string[] = [];

  out.push('## Retrieval evaluation');
  out.push('');
  out.push(configurationSummary(c, '`'));
  out.push('');

  // First, above the tables: on a red build this is the line somebody is looking for, and a summary
  // that buries it under nine rows of per-tag metrics has made them scroll for it.
  const gate = gateVerdict(report);
  if (gate.enforced) {
    out.push(gate.passed ? '**The retrieval gate passed.**' : '**The retrieval gate failed.**');
    out.push('');
    for (const line of gate.lines) out.push(`- ${line.replace(/\s{2,}/g, ' ').trim()}`);
    out.push('');
  }
  out.push('| group | n | recall@1 | recall@5 | MRR | mean score | heading@5 |');
  out.push('|---|--:|--:|--:|--:|--:|--:|');
  out.push(mdRow('**overall**', report.overall));
  for (const [lang, m] of Object.entries(report.byLang)) out.push(mdRow(`lang \`${lang}\``, m));
  for (const [tag, m] of Object.entries(report.byTag)) out.push(mdRow(`tag \`${tag}\``, m));
  out.push('');

  if (report.overall.gated > 0) {
    out.push(
      `**The relevance floor would refuse ${report.overall.gated} of ${report.overall.questions} questions**, ` +
        `${report.overall.gatedWithAnswer} of which had the answer inside the top five.`,
    );
    out.push('');
  }

  const misses = worstMisses(report.results, 5);
  if (misses.length > 0) {
    out.push('<details><summary>The five worst misses</summary>');
    out.push('');
    for (const miss of misses) {
      const where = miss.rank === null ? `not in top ${c.searchLimit}` : `rank ${miss.rank + 1}`;
      out.push(`**\`${miss.row.id}\`** (${miss.row.lang}, ${where}) — ${miss.row.query}`);
      out.push('');
      out.push(`- wanted \`${miss.row.expectFile}\`${miss.row.expectHeading ? ` — ${miss.row.expectHeading}` : ''}`);
      for (const hit of miss.hits.slice(0, 3)) out.push(`- got \`${hit.file}\` — ${hit.headingPath} (${hit.score.toFixed(3)})`);
      out.push('');
    }
    out.push('</details>');
    out.push('');
  }

  out.push(`Ran in ${seconds(c.totalMs)} — model ${seconds(c.modelLoadMs)}, index ${seconds(c.indexMs)}, search ${seconds(c.searchMs)}.`);
  out.push('');
  out.push('These numbers are comparable only to themselves: this corpus, these questions, this configuration. See `eval/README.md`.');
  return out.join('\n');
}
