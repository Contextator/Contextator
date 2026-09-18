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
  /** Matched as a breadcrumb suffix, scored separately, gates nothing. */
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

export function scoreRow(row: GoldenRow, hits: readonly ScoredHit[]): RowResult {
  const rank = hits.findIndex((hit) => hit.file === row.expectFile);
  const headingRank = row.expectHeading
    ? hits.findIndex((hit) => hit.file === row.expectFile && headingMatches(hit.headingPath, row.expectHeading as string))
    : -1;
  return {
    row,
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
  documents: number;
  chunks: number;
  startedAt: string;
  /** Wall clock of the whole run, and of the two parts worth knowing separately. */
  totalMs: number;
  modelLoadMs: number;
  indexMs: number;
  searchMs: number;
}

export interface Report {
  context: RunContext;
  overall: Metrics;
  byLang: Record<string, Metrics>;
  byTag: Record<string, Metrics>;
  /** Accepted and deliberately not enforced in this phase; Phase 1 turns it into a gate. */
  minRecall5: number | null;
  results: RowResult[];
}

export function buildReport(results: readonly RowResult[], context: RunContext, minRecall5: number | null): Report {
  const toRecord = (groups: Map<string, RowResult[]>): Record<string, Metrics> =>
    Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, aggregate(rows)]));
  return {
    context,
    overall: aggregate(results),
    byLang: toRecord(groupBy(results, (r) => [r.row.lang])),
    byTag: toRecord(groupBy(results, (r) => r.row.tags)),
    minRecall5,
    results: [...results],
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1).padStart(5)}%`;
const sim = (value: number | null): string => (value === null ? '    —' : value.toFixed(3));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

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

  if (report.minRecall5 !== null) {
    const verdict = overall.recall5 >= report.minRecall5 ? 'above' : 'below';
    out.push(`  --min-recall5 ${report.minRecall5}: recall@5 is ${verdict} it. Not enforced in this phase; the run still exits 0.`);
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
  out.push(
    `\`${c.providerId}\` · \`CHUNK_MAX_TOKENS=${c.chunkMaxTokens}\` · \`CHUNK_OVERLAP_TOKENS=${c.chunkOverlapTokens}\` · ${c.documents} documents, ${c.chunks} chunks · commit \`${c.commit}\``,
  );
  out.push('');
  out.push('| group | n | recall@1 | recall@5 | MRR | mean score | heading@5 |');
  out.push('|---|--:|--:|--:|--:|--:|--:|');
  out.push(mdRow('**overall**', report.overall));
  for (const [lang, m] of Object.entries(report.byLang)) out.push(mdRow(`lang \`${lang}\``, m));
  for (const [tag, m] of Object.entries(report.byTag)) out.push(mdRow(`tag \`${tag}\``, m));
  out.push('');

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
