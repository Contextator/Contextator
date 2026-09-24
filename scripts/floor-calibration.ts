import fs from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../src/config.js';
import { createEmbeddingProvider } from '../src/services/embeddings/index.js';
import { createReranker } from '../src/services/reranker.js';
import { belowRelevanceFloor, isIdentifierShaped } from '../src/services/relevance.js';
import type { TextSearchConfig } from '../src/services/text-search.js';
import type { SearchHit } from '../src/services/vector-store.js';
import {
  EVAL_DIR,
  indexDocuments,
  loadDirectory,
  loadHarnessConfig,
  loadXquad,
  makeAsk,
  openDatabaseServer,
  parseProbeSet,
  quietLogger,
  step,
  type CorpusDocument,
  type XquadSet,
} from './eval-corpora.js';
import { aggregate, parseGoldenSet, parseNegativeSet, scoreRow, type GoldenRow } from './eval-scoring.js';

/**
 * `SEARCH_SCORE_FLOOR` over corpora of different shapes — the measurement Phase 17 asks for before the
 * floor's mechanism may change.
 *
 * `npm run eval` measures the floor over one corpus: `eval/corpus/`, a synthetic product's
 * documentation that the floor's default of 0.82 was fitted on ([ADR-0045](../.ssot/ADR.md#adr-0045)).
 * This asks the same questions of the same search path over up to four corpora and prints, for each,
 * where the top hit's cosine similarity sits for questions it answers and for questions it cannot, what
 * 0.82 does there, which floor the corpus itself would have asked for, and how two corpus-relative
 * criteria separate the classes compared with the absolute one.
 *
 *   - `halyard` — `eval/corpus/` with `eval/golden.jsonl` and `eval/negative.jsonl`: the control. Its
 *     top-hit band has to come out as `eval/BASELINE.md` records it, or this file's indexing loop has
 *     drifted from `eval.ts`'s.
 *   - `wiki` — the product's own user wiki (`--wiki=<dir>`), with the questions in
 *     `eval/probes/floor-wiki-2026-09-25.jsonl`: real documentation of a real product, English, written
 *     by a different hand than the synthetic corpus.
 *   - `xquad-tr`, `xquad-en` — XQuAD (`eval/external/xquad/`): encyclopaedic prose, one section per
 *     paragraph, 1190 questions per language written by annotators rather than by us.
 *
 * **What a corpus is asked that it cannot answer.** The absent-feature class exists only where somebody
 * wrote such questions for that corpus (`halyard`, `wiki`). The off-domain class is borrowed across
 * corpora: `negative.jsonl`'s off-domain rows everywhere, plus the first question of every XQuAD article
 * for the two documentation corpora and the documentation corpora's answerable questions for XQuAD.
 * Every off-domain row carries its origin, and the probe-derived candidate below calibrates on
 * `negative.jsonl`'s rows only and is scored on the rest.
 *
 * Nothing here is a gate and nothing here changes a number `npm run eval` reads.
 */

const WIKI_PROBES_PATH = path.join(EVAL_DIR, 'probes', 'floor-wiki-2026-09-25.jsonl');
const SHIPPED_FLOOR = 0.82;
const SWEEP = [0.78, 0.79, 0.8, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88];
const DROP_RATIOS = [0.95, 0.97, 0.98, 0.99];
const CORPUS_NAMES = ['halyard', 'wiki', 'xquad-tr', 'xquad-en'] as const;
type CorpusName = (typeof CORPUS_NAMES)[number];

type Klass = 'answerable' | 'absent-feature' | 'off-domain';

interface Probe {
  id: string;
  query: string;
  klass: Klass;
  /** Where the question came from — `negative.jsonl`, `xquad-tr`, `halyard-golden`, … */
  origin: string;
  /** The row that says which file answers it, for the answerable class only. */
  golden?: GoldenRow;
}

interface CorpusSpec {
  name: CorpusName;
  shape: string;
  documents: CorpusDocument[];
  textSearchConfigFor: (relativePath: string) => TextSearchConfig;
  probes: Probe[];
}

interface Measured {
  probe: Probe;
  hits: SearchHit[];
  /** `hits[0].score`: the cosine similarity of the fused rank-1 hit, which is what the floor reads. */
  top: number;
  /** 1-based rank of the first hit in the expected file, or `null` — answerable rows only. */
  correctRank: number | null;
}

interface CorpusRun {
  spec: CorpusSpec;
  chunks: number;
  measured: Measured[];
}

interface Options {
  wiki: string | null;
  corpora: CorpusName[];
  json: string | null;
}

const USAGE = `Usage: tsx scripts/floor-calibration.ts [--wiki=<dir>] [--corpora=halyard,wiki,xquad-tr,xquad-en] [--json=<path>]

  --wiki=<dir>     The Contextator wiki checkout to index as the "wiki" corpus. Without it, that corpus
                   and the wiki questions borrowed as off-domain elsewhere are skipped.
  --corpora=<list> Which corpora to measure (default: all four, "wiki" only with --wiki).
  --json=<path>    Also write every question's top hits and scores, for re-analysis without re-indexing.

  Starts its own pgvector container unless EVAL_DATABASE_URL is set; never uses DATABASE_URL's own
  database, only fresh ones it creates and drops. Prints Markdown tables to stdout.
`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { wiki: null, corpora: [...CORPUS_NAMES], json: null };
  let corporaGiven = false;
  for (const arg of argv) {
    const [flag, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, ''];
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (flag === '--wiki' && value !== '') options.wiki = path.resolve(value);
    else if (flag === '--json' && value !== '') options.json = path.resolve(value);
    else if (flag === '--corpora' && value !== '') {
      corporaGiven = true;
      options.corpora = value.split(',').map((name) => {
        if (!(CORPUS_NAMES as readonly string[]).includes(name))
          throw new Error(`Unknown corpus ${name}; expected one of ${CORPUS_NAMES.join(', ')}`);
        return name as CorpusName;
      });
    } else {
      process.stderr.write(`Unknown argument ${arg}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  if (!options.wiki) {
    if (corporaGiven && options.corpora.includes('wiki')) throw new Error('--corpora names "wiki" but no --wiki=<dir> was given');
    options.corpora = options.corpora.filter((name) => name !== 'wiki');
  }
  return options;
}

// ---------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------

/** Nearest-rank percentile: a value that was measured, never one interpolated between two. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

interface Distribution {
  n: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p10: percentile(sorted, 0.1),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/**
 * The probability that a random answerable question scores above a random unanswerable one on a
 * feature — Mann–Whitney's U over the product of the two sizes, ties counted half. 1.0 is a feature
 * some threshold splits perfectly; 0.5 is a coin.
 */
function auc(positive: readonly number[], negative: readonly number[]): number {
  if (positive.length === 0 || negative.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

// ---------------------------------------------------------------------------------------------------
// Features — the absolute score and three corpus-relative ones
// ---------------------------------------------------------------------------------------------------

/**
 * Each maps one result list to a number where **higher reads as "this corpus answers it"**, so one AUC
 * convention holds for all of them. `abs` is what the floor reads today. The other three describe the
 * top hit relative to the rest of the same list — the family Phase 17 names as "a drop ratio relative
 * to the best hit" — and are measured as query-level separators, because only a query-level criterion
 * can refuse a query at all: a filter that keeps hits within some ratio of the best keeps the best.
 */
const FEATURES: Record<string, (hits: readonly SearchHit[]) => number> = {
  abs: (hits) => hits[0]?.score ?? Number.NaN,
  gap: (hits) => (hits.length < 2 ? Number.NaN : hits[0].score - Math.max(...hits.slice(1).map((h) => h.score))),
  spread: (hits) => (hits.length < 2 ? Number.NaN : hits[0].score - Math.min(...hits.slice(1).map((h) => h.score))),
  zscore: (hits) => {
    if (hits.length < 3) return Number.NaN;
    const scores = hits.map((h) => h.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
    return sd === 0 ? 0 : (hits[0].score - mean) / sd;
  },
};

// ---------------------------------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------------------------------

/** One question per XQuAD article — the first — as an off-domain question for a documentation corpus. */
function xquadSample(set: XquadSet): Probe[] {
  const seen = new Set<string>();
  const sample: Probe[] = [];
  for (const row of set.questions) {
    if (seen.has(row.expectFile)) continue;
    seen.add(row.expectFile);
    sample.push({ id: row.id, query: row.query, klass: 'off-domain', origin: `xquad-${set.lang}` });
  }
  return sample;
}

async function buildSpecs(options: Options): Promise<CorpusSpec[]> {
  const halyardDocs = await loadDirectory(path.join(EVAL_DIR, 'corpus'));
  const halyardFiles = new Set(halyardDocs.map((d) => d.relativePath));
  const golden = parseGoldenSet(await fs.readFile(path.join(EVAL_DIR, 'golden.jsonl'), 'utf8'), halyardFiles);
  const negative = parseNegativeSet(await fs.readFile(path.join(EVAL_DIR, 'negative.jsonl'), 'utf8'));
  const negativeOffDomain: Probe[] = negative
    .filter((row) => row.kind === 'off-domain')
    .map((row) => ({ id: row.id, query: row.query, klass: 'off-domain', origin: 'negative.jsonl' }));
  const xquad = { tr: await loadXquad('tr'), en: await loadXquad('en') };
  const xquadOffDomain = [...xquadSample(xquad.tr), ...xquadSample(xquad.en)];

  let wikiDocs: CorpusDocument[] = [];
  let wikiProbes: Probe[] = [];
  if (options.wiki) {
    wikiDocs = await loadDirectory(options.wiki);
    const probeSet = parseProbeSet(await fs.readFile(WIKI_PROBES_PATH, 'utf8'), new Set(wikiDocs.map((d) => d.relativePath)));
    wikiProbes = [
      ...probeSet.answerable.map((row): Probe => ({ id: row.id, query: row.query, klass: 'answerable', origin: 'wiki-probes', golden: row })),
      ...probeSet.negative.map((row): Probe => ({ id: row.id, query: row.query, klass: row.kind, origin: 'wiki-probes' })),
    ];
  }

  const halyardAnswerable: Probe[] = golden.map((row) => ({
    id: row.id,
    query: row.query,
    klass: 'answerable',
    origin: 'golden.jsonl',
    golden: row,
  }));
  const documentationQuestions: Probe[] = [
    ...halyardAnswerable.map((p): Probe => ({ id: p.id, query: p.query, klass: 'off-domain', origin: 'halyard-golden' })),
    ...wikiProbes
      .filter((p) => p.klass === 'answerable')
      .map((p): Probe => ({ id: p.id, query: p.query, klass: 'off-domain', origin: 'wiki-probes' })),
  ];

  const specs: CorpusSpec[] = [];
  for (const name of options.corpora) {
    if (name === 'halyard') {
      specs.push({
        name,
        shape: 'synthetic product documentation, en + tr, many short sections and identifiers',
        documents: halyardDocs,
        // eval.ts's default mapping: the language directory decides.
        textSearchConfigFor: (p) => (p.startsWith('tr/') ? 'turkish' : 'simple'),
        probes: [
          ...halyardAnswerable,
          ...negative.map((row): Probe => ({ id: row.id, query: row.query, klass: row.kind, origin: 'negative.jsonl' })),
          ...xquadOffDomain,
        ],
      });
    } else if (name === 'wiki') {
      specs.push({
        name,
        shape: 'real product user guide (Contextator wiki), en, prose + tables + config blocks',
        documents: wikiDocs,
        textSearchConfigFor: () => 'simple',
        probes: [...wikiProbes, ...negativeOffDomain, ...xquadOffDomain],
      });
    } else {
      const set = name === 'xquad-tr' ? xquad.tr : xquad.en;
      specs.push({
        name,
        shape: `encyclopaedic prose (XQuAD ${set.lang}), 48 articles, one section per paragraph`,
        documents: set.documents,
        textSearchConfigFor: () => (set.lang === 'tr' ? 'turkish' : 'simple'),
        probes: [
          ...set.questions.map((row): Probe => ({ id: row.id, query: row.query, klass: 'answerable', origin: `xquad-${set.lang}`, golden: row })),
          ...negativeOffDomain,
          ...documentationQuestions,
        ],
      });
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------

const byClass = (run: CorpusRun, klass: Klass): Measured[] => run.measured.filter((m) => m.probe.klass === klass);

function refusedShare(rows: readonly Measured[], floor: number): { refused: number; n: number } {
  return { refused: rows.filter((m) => belowRelevanceFloor(m.probe.query, m.hits, floor)).length, n: rows.length };
}

/**
 * The highest floor on a 0.001 grid that refuses at most `allowed` answerable questions — "the floor
 * this corpus would have asked for". The escape hatch is applied as the product applies it.
 */
function fittedFloor(answerable: readonly Measured[], allowedShare: number): number {
  const allowed = Math.floor(answerable.length * allowedShare);
  let best = 0;
  for (let milli = 600; milli <= 990; milli++) {
    const floor = milli / 1000;
    if (refusedShare(answerable, floor).refused <= allowed) best = floor;
    else break;
  }
  return best;
}

const fmt = (value: number, digits = 3): string => (Number.isNaN(value) ? '—' : value.toFixed(digits));
const pct = ({ refused, n }: { refused: number; n: number }): string => (n === 0 ? '—' : `${refused}/${n} (${((100 * refused) / n).toFixed(1)}%)`);

function analyse(runs: readonly CorpusRun[]): { markdown: string; summary: unknown } {
  const out: string[] = [];
  const summary: Record<string, unknown> = {};

  out.push('### Corpora', '', '| corpus | shape | files | chunks | answerable | absent-feature | off-domain |', '|---|---|---:|---:|---:|---:|---:|');
  for (const run of runs) {
    out.push(
      `| ${run.spec.name} | ${run.spec.shape} | ${run.spec.documents.length} | ${run.chunks} | ${byClass(run, 'answerable').length} | ${byClass(run, 'absent-feature').length} | ${byClass(run, 'off-domain').length} |`,
    );
  }

  out.push(
    '',
    '### Top-hit cosine similarity, by class',
    '',
    '| corpus | class | n | min | p10 | median | p90 | max |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const run of runs) {
    const answerable = byClass(run, 'answerable');
    const rows: [string, Measured[]][] = [
      ['answerable', answerable],
      ['↳ right file at rank 1', answerable.filter((m) => m.correctRank === 1)],
      ['↳ right file not at rank 1', answerable.filter((m) => m.correctRank !== 1)],
      ['absent-feature', byClass(run, 'absent-feature')],
      ['off-domain', byClass(run, 'off-domain')],
    ];
    const origins = [...new Set(byClass(run, 'off-domain').map((m) => m.probe.origin))];
    if (origins.length > 1)
      for (const origin of origins) rows.push([`↳ off-domain from ${origin}`, byClass(run, 'off-domain').filter((m) => m.probe.origin === origin)]);
    const dists: Record<string, Distribution> = {};
    for (const [label, measured] of rows) {
      if (measured.length === 0) continue;
      const d = distribution(measured.map((m) => m.top));
      dists[label] = d;
      out.push(`| ${run.spec.name} | ${label} | ${d.n} | ${fmt(d.min)} | ${fmt(d.p10)} | ${fmt(d.median)} | ${fmt(d.p90)} | ${fmt(d.max)} |`);
    }
    summary[run.spec.name] = { distributions: dists };
  }

  out.push(
    '',
    `### What ${SHIPPED_FLOOR} does on each corpus`,
    '',
    '`belowRelevanceFloor` itself, escape hatch included. "…with the answer in the top 5" is a false refusal the ranking had right.',
    '',
    '| corpus | recall@5 (no floor) | heading@5 | answerable refused | …with the answer in the top 5 | absent-feature refused | off-domain refused |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const run of runs) {
    const answerable = byClass(run, 'answerable');
    const metrics = aggregate(answerable.map((m) => scoreRow(m.probe.golden as GoldenRow, m.hits, false)));
    const refusedWithAnswer = answerable.filter(
      (m) => belowRelevanceFloor(m.probe.query, m.hits, SHIPPED_FLOOR) && m.correctRank !== null && m.correctRank <= 5,
    ).length;
    out.push(
      `| ${run.spec.name} | ${fmt(metrics.recall5)} | ${metrics.headingQuestions === 0 ? '—' : fmt(metrics.headingRecall5)} | ${pct(refusedShare(answerable, SHIPPED_FLOOR))} | ${refusedWithAnswer} | ${pct(refusedShare(byClass(run, 'absent-feature'), SHIPPED_FLOOR))} | ${pct(refusedShare(byClass(run, 'off-domain'), SHIPPED_FLOOR))} |`,
    );
    Object.assign(summary[run.spec.name] as object, {
      recall5: metrics.recall5,
      headingRecall5: metrics.headingRecall5,
      atShipped: {
        answerable: refusedShare(answerable, SHIPPED_FLOOR),
        answerableWithAnswer: refusedWithAnswer,
        absent: refusedShare(byClass(run, 'absent-feature'), SHIPPED_FLOOR),
        offDomain: refusedShare(byClass(run, 'off-domain'), SHIPPED_FLOOR),
      },
    });
  }

  out.push(
    '',
    '### Sweep — share refused per class',
    '',
    `| corpus | class | ${SWEEP.map((f) => f.toFixed(2)).join(' | ')} |`,
    `|---|---|${SWEEP.map(() => '---:').join('|')}|`,
  );
  for (const run of runs) {
    for (const klass of ['answerable', 'absent-feature', 'off-domain'] as const) {
      const rows = byClass(run, klass);
      if (rows.length === 0) continue;
      out.push(
        `| ${run.spec.name} | ${klass} | ${SWEEP.map((f) => {
          const r = refusedShare(rows, f);
          return `${((100 * r.refused) / r.n).toFixed(0)}%`;
        }).join(' | ')} |`,
      );
    }
  }

  out.push(
    '',
    '### The floor each corpus would have asked for',
    '',
    'Highest floor (0.001 grid) that refuses no answerable question, then at most 1% of them — and what each catches.',
    '',
    '| corpus | floor, 0 refused | off-domain caught | absent caught | floor, ≤1% refused | off-domain caught | absent caught |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  const fitted: Record<string, { zero: number; one: number }> = {};
  for (const run of runs) {
    const answerable = byClass(run, 'answerable');
    const zero = fittedFloor(answerable, 0);
    const one = fittedFloor(answerable, 0.01);
    fitted[run.spec.name] = { zero, one };
    out.push(
      `| ${run.spec.name} | ${fmt(zero)} | ${pct(refusedShare(byClass(run, 'off-domain'), zero))} | ${pct(refusedShare(byClass(run, 'absent-feature'), zero))} | ${fmt(one)} | ${pct(refusedShare(byClass(run, 'off-domain'), one))} | ${pct(refusedShare(byClass(run, 'absent-feature'), one))} |`,
    );
    Object.assign(summary[run.spec.name] as object, { fitted: { zero, one } });
  }

  out.push(
    '',
    '### Candidate (a′): a per-project floor set from probe questions the corpus cannot answer',
    '',
    "The floor is the highest top-hit score of `negative.jsonl`'s off-domain rows on that corpus (the calibration probes); it is scored on the corpus's answerable questions and on the off-domain rows **not** used to set it.",
    '',
    '| corpus | probe-derived floor | answerable refused | held-out off-domain refused | absent-feature refused |',
    '|---|---:|---:|---:|---:|',
  );
  for (const run of runs) {
    const probes = byClass(run, 'off-domain').filter((m) => m.probe.origin === 'negative.jsonl');
    const heldOut = byClass(run, 'off-domain').filter((m) => m.probe.origin !== 'negative.jsonl');
    const floor = Math.max(...probes.map((m) => m.top));
    out.push(
      `| ${run.spec.name} | ${fmt(floor)} | ${pct(refusedShare(byClass(run, 'answerable'), floor))} | ${pct(refusedShare(heldOut, floor))} | ${pct(refusedShare(byClass(run, 'absent-feature'), floor))} |`,
    );
    Object.assign(summary[run.spec.name] as object, {
      probeFloor: {
        floor,
        answerable: refusedShare(byClass(run, 'answerable'), floor),
        heldOut: refusedShare(heldOut, floor),
        absent: refusedShare(byClass(run, 'absent-feature'), floor),
      },
    });
  }

  out.push(
    '',
    '### Separation: the absolute score against three relative ones (AUC, answerable vs …)',
    '',
    '1.0 means some threshold on that feature splits the two classes perfectly on that corpus; 0.5 is a coin. `pooled` puts every corpus into one pool, which is what a **single global** threshold on that feature has to split.',
    '',
    `| corpus | vs | ${Object.keys(FEATURES).join(' | ')} |`,
    `|---|---|${Object.keys(FEATURES)
      .map(() => '---:')
      .join('|')}|`,
  );
  const separation = (answerable: readonly Measured[], other: readonly Measured[]) =>
    Object.fromEntries(
      Object.entries(FEATURES).map(([name, f]) => [
        name,
        auc(
          answerable.map((m) => f(m.hits)).filter((v) => !Number.isNaN(v)),
          other.map((m) => f(m.hits)).filter((v) => !Number.isNaN(v)),
        ),
      ]),
    );
  const pooledAnswerable = runs.flatMap((run) => byClass(run, 'answerable'));
  for (const [label, answerable, other] of [
    ...runs.flatMap((run): [string, Measured[], Measured[]][] => [
      [`${run.spec.name} | off-domain`, byClass(run, 'answerable'), byClass(run, 'off-domain')],
      [`${run.spec.name} | absent-feature`, byClass(run, 'answerable'), byClass(run, 'absent-feature')],
    ]),
    ['pooled | off-domain', pooledAnswerable, runs.flatMap((run) => byClass(run, 'off-domain'))] as [string, Measured[], Measured[]],
  ]) {
    if (other.length === 0) continue;
    const s = separation(answerable, other);
    out.push(
      `| ${label} | ${Object.values(s)
        .map((v) => fmt(v))
        .join(' | ')} |`,
    );
    summary[`auc:${label}`] = s;
  }

  // A single global threshold per feature, fitted on the pooled answerable questions the way
  // `fittedFloor` fits the absolute one: the value that refuses none of them. What it then catches on
  // each corpus is the number that says whether a relative criterion travels better than 0.82 did.
  out.push(
    '',
    '### One global threshold per feature, fitted to refuse no answerable question in the pool',
    '',
    `| feature | threshold | ${runs.map((run) => `${run.spec.name} off-domain caught`).join(' | ')} |`,
    `|---|---:|${runs.map(() => '---:').join('|')}|`,
  );
  for (const [name, f] of Object.entries(FEATURES)) {
    const values = pooledAnswerable.map((m) => f(m.hits)).filter((v) => !Number.isNaN(v));
    const threshold = Math.min(...values);
    const caught = runs.map((run) => {
      const od = byClass(run, 'off-domain');
      return pct({ refused: od.filter((m) => f(m.hits) < threshold).length, n: od.length });
    });
    out.push(`| ${name} | ${fmt(threshold, 4)} | ${caught.join(' | ')} |`);
  }

  out.push(
    '',
    '### What a hit-level drop ratio would cost',
    '',
    'Keep only hits scoring at least `ratio × top`. It can never refuse a query — the top hit always passes — so this is only its price: answerable questions whose right file was in the top 5 and would be trimmed out of it, and hits kept on average.',
    '',
    `| corpus | ${DROP_RATIOS.map((r) => `${r} lost / kept`).join(' | ')} |`,
    `|---|${DROP_RATIOS.map(() => '---:').join('|')}|`,
  );
  for (const run of runs) {
    const answerable = byClass(run, 'answerable');
    const cells = DROP_RATIOS.map((ratio) => {
      let lost = 0;
      let kept = 0;
      for (const m of answerable) {
        const cut = ratio * m.top;
        kept += m.hits.filter((h) => h.score >= cut).length;
        if (m.correctRank !== null && m.correctRank <= 5) {
          const survivors = m.hits.slice(0, 5).filter((h) => h.score >= cut);
          if (!survivors.some((h) => h.file === m.probe.golden?.expectFile)) lost += 1;
        }
      }
      return `${lost} / ${(kept / Math.max(1, answerable.length)).toFixed(1)}`;
    });
    out.push(`| ${run.spec.name} | ${cells.join(' | ')} |`);
  }

  out.push(
    '',
    `Fitted floors: ${Object.entries(fitted)
      .map(([name, f]) => `${name} ${fmt(f.zero)} / ${fmt(f.one)}`)
      .join('; ')}.`,
  );
  return { markdown: out.join('\n'), summary };
}

// ---------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------

async function measureCorpus(
  spec: CorpusSpec,
  config: Config,
  embeddings: ReturnType<typeof createEmbeddingProvider>,
  reranker: ReturnType<typeof createReranker>,
  server: Awaited<ReturnType<typeof openDatabaseServer>>,
): Promise<CorpusRun> {
  const { db, projectId, generation } = await server.project(spec.name);
  step(`floor-calibration: ${spec.name}: indexing ${spec.documents.length} files`);
  const indexed = await indexDocuments(db, embeddings, config, projectId, generation, spec.documents, spec.textSearchConfigFor);
  const ask = makeAsk(db, embeddings, config, projectId, reranker);
  step(`floor-calibration: ${spec.name}: ${indexed.chunks} chunks, asking ${spec.probes.length} questions`);
  const measured: Measured[] = [];
  for (const probe of spec.probes) {
    const hits = await ask(probe.id, probe.query);
    const expected = probe.golden?.expectFile;
    const index = expected === undefined ? -1 : hits.findIndex((h) => h.file === expected);
    measured.push({ probe, hits, top: hits[0]?.score ?? Number.NaN, correctRank: index === -1 ? null : index + 1 });
  }
  return { spec, chunks: indexed.chunks, measured };
}

/** The date the run happened where it happened, not in UTC: the heading is what a BASELINE section is dated by. */
function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadHarnessConfig();
  const specs = await buildSpecs(options);

  const embeddings = createEmbeddingProvider(config, quietLogger);
  step(`floor-calibration: loading ${embeddings.id}`);
  await embeddings.warmup();
  const reranker = createReranker(config, quietLogger);
  if (reranker) await reranker.warmup();

  const server = await openDatabaseServer(config, 'floor');
  const runs: CorpusRun[] = [];
  try {
    for (const spec of specs) runs.push(await measureCorpus(spec, config, embeddings, reranker, server));
  } finally {
    await server.close();
  }

  const { markdown, summary } = analyse(runs);
  const hatch = runs.flatMap((run) => run.measured).filter((m) => isIdentifierShaped(m.probe.query)).length;
  process.stdout.write(
    `## Floor calibration — ${localDate()}\n\n` +
      `Model ${embeddings.id}; chunking ${config.CHUNK_MAX_TOKENS}/${config.CHUNK_OVERLAP_TOKENS}; ` +
      `max_per_document=${config.SEARCH_MAX_PER_DOCUMENT}, neighbor_context=${config.SEARCH_NEIGHBOR_CONTEXT}; ` +
      `rerank ${reranker ? reranker.id : 'off'}; ${hatch} questions are identifier-shaped (the escape hatch can apply).\n\n` +
      `${markdown}\n`,
  );

  if (options.json) {
    const dump = {
      summary,
      runs: runs.map((run) => ({
        corpus: run.spec.name,
        chunks: run.chunks,
        questions: run.measured.map((m) => ({
          id: m.probe.id,
          klass: m.probe.klass,
          origin: m.probe.origin,
          correctRank: m.correctRank,
          hits: m.hits.map((h) => ({ file: h.file, headingPath: h.headingPath, score: h.score, lexicalRank: h.lexicalRank, denseRank: h.denseRank })),
        })),
      })),
    };
    await fs.writeFile(options.json, `${JSON.stringify(dump, null, 1)}\n`);
    step(`floor-calibration: wrote ${options.json}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`floor-calibration failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
