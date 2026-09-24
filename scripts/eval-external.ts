import fs from 'node:fs/promises';

import { createEmbeddingProvider } from '../src/services/embeddings/index.js';
import { createReranker } from '../src/services/reranker.js';
import { belowRelevanceFloor } from '../src/services/relevance.js';
import {
  indexDocuments,
  loadHarnessConfig,
  loadXquad,
  makeAsk,
  openDatabaseServer,
  quietLogger,
  step,
  XQUAD_LANGUAGES,
  type XquadLanguage,
} from './eval-corpora.js';
import { aggregate, scoreRow, type Metrics, type RowResult } from './eval-scoring.js';

/**
 * Retrieval on the external set — XQuAD, tr and en — reported **apart from** `npm run eval`.
 *
 * The golden set is 92 questions written against one synthetic product's documentation; its numbers
 * say how retrieval does on that shape of corpus and nothing wider. XQuAD is a second, openly licensed
 * container of a different shape — encyclopaedic prose, questions written by other people, 1190 per
 * language — so that a change which helps the golden set and hurts everything else has somewhere to
 * show it. It is **never** folded into the golden numbers: a pool of 92 beside 2380 would be a pool
 * that is almost all XQuAD, and the floors of ADR-0044 were argued from the golden set alone.
 *
 * Each language is its own corpus in its own database, indexed with the configuration an operator
 * would pick for it (tr → turkish, en → simple). The relevance floor is reported the way `eval.ts`
 * reports it — how many answerable questions `SEARCH_SCORE_FLOOR` would refuse, and how many of those
 * had the answer in the top five — and gates nothing. With `--min-recall5` / `--min-heading5` a run
 * whose numbers are short in either language exits 2, as `eval.ts` does; `--min-recall5-<lang>` /
 * `--min-heading5-<lang>` set one language's bar apart from the other's, since the two languages do
 * not sit at the same height (en is closer to saturation than tr).
 */

const USAGE = `Usage: npx tsx scripts/eval-external.ts [options]

  --lang=<tr,en>           Which XQuAD languages to run (default: both).
  --markdown=<file>        Also write the result as a Markdown section.
  --json=<file>            Also write the numbers as JSON.
  --min-recall5=<0..1>     Fail (exit 2) when recall@5 of any language is below this.
  --min-heading5=<0..1>    The same for heading@5 (the right paragraph of the right article).
  --min-recall5-<lang>=<0..1>, --min-heading5-<lang>=<0..1>
                           The same for one language only (tr or en); overrides the flag above
                           for that language.
  -h, --help               This.

  EVAL_DATABASE_URL, or DATABASE_URL, points at a PostgreSQL to carve throwaway databases out of.
  With neither, a pgvector container is started for the run and stopped at the end.`;

interface Options {
  languages: XquadLanguage[];
  markdown: string | null;
  json: string | null;
  minRecall5: number | null;
  minHeading5: number | null;
  /** Per-language bars; a language listed here is judged by these, not by the two above. */
  perLanguage: Partial<Record<XquadLanguage, { minRecall5?: number; minHeading5?: number }>>;
}

function parseFloor(flag: string, value: string): number {
  const parsed = Number(value);
  if (value === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} takes a number between 0 and 1, e.g. ${flag}=0.98`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    languages: [...XQUAD_LANGUAGES],
    markdown: null,
    json: null,
    minRecall5: null,
    minHeading5: null,
    perLanguage: {},
  };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    switch (flag) {
      case '--lang': {
        const wanted = value.split(',').map((s) => s.trim());
        for (const lang of wanted) {
          if (!(XQUAD_LANGUAGES as readonly string[]).includes(lang)) throw new Error(`--lang knows ${XQUAD_LANGUAGES.join(', ')}; got "${lang}"`);
        }
        options.languages = wanted as XquadLanguage[];
        break;
      }
      case '--markdown':
        if (!value) throw new Error('--markdown takes a file');
        options.markdown = value;
        break;
      case '--json':
        if (!value) throw new Error('--json takes a file');
        options.json = value;
        break;
      case '--min-recall5':
        options.minRecall5 = parseFloor(flag, value);
        break;
      case '--min-heading5':
        options.minHeading5 = parseFloor(flag, value);
        break;
      default: {
        const perLanguage = /^--min-(recall5|heading5)-([a-z]+)$/.exec(flag ?? '');
        if (!perLanguage) throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
        const lang = perLanguage[2] as string;
        if (!(XQUAD_LANGUAGES as readonly string[]).includes(lang))
          throw new Error(`${flag}: no XQuAD language "${lang}" (${XQUAD_LANGUAGES.join(', ')})`);
        const bars = options.perLanguage[lang as XquadLanguage] ?? {};
        if (perLanguage[1] === 'recall5') bars.minRecall5 = parseFloor(flag as string, value);
        else bars.minHeading5 = parseFloor(flag as string, value);
        options.perLanguage[lang as XquadLanguage] = bars;
      }
    }
  }
  return options;
}

interface LanguageRun {
  lang: XquadLanguage;
  documents: number;
  paragraphs: number;
  chunks: number;
  metrics: Metrics;
  seconds: number;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function table(runs: readonly LanguageRun[], floor: number): string {
  const lines = [
    `| set | articles | paragraphs | chunks | n | recall@1 | recall@5 | MRR@10 | heading@1 | heading@5 | refused at ${floor} | …with the answer in the top 5 |`,
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of runs) {
    const m = r.metrics;
    lines.push(
      `| xquad-${r.lang} | ${r.documents} | ${r.paragraphs} | ${r.chunks} | ${m.questions} | ${pct(m.recall1)} | ${pct(m.recall5)} | ${m.mrr.toFixed(3)} | ` +
        `${pct(m.headingRecall1)} | ${pct(m.headingRecall5)} | ${m.gated} (${pct(m.gated / m.questions)}) | ${m.gatedWithAnswer} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadHarnessConfig();
  const floor = config.SEARCH_SCORE_FLOOR;

  const embeddings = createEmbeddingProvider(config, quietLogger);
  step(`eval-external: loading ${embeddings.id}`);
  await embeddings.warmup();
  const reranker = createReranker(config, quietLogger);
  if (reranker) await reranker.warmup();

  const server = await openDatabaseServer(config, 'external');
  const runs: LanguageRun[] = [];
  try {
    for (const lang of options.languages) {
      const started = Date.now();
      const set = await loadXquad(lang);
      const { db, projectId, generation } = await server.project(`xquad_${lang}`);
      step(`eval-external: xquad-${lang}: indexing ${set.documents.length} articles`);
      const indexed = await indexDocuments(db, embeddings, config, projectId, generation, set.documents, () =>
        lang === 'tr' ? 'turkish' : 'simple',
      );
      const ask = makeAsk(db, embeddings, config, projectId, reranker);
      step(`eval-external: xquad-${lang}: ${indexed.chunks} chunks, asking ${set.questions.length} questions`);
      const results: RowResult[] = [];
      for (const row of set.questions) {
        const hits = await ask(row.id, row.query);
        results.push(scoreRow(row, hits, belowRelevanceFloor(row.query, hits, floor)));
      }
      runs.push({
        lang,
        documents: set.documents.length,
        paragraphs: set.paragraphs,
        chunks: indexed.chunks,
        metrics: aggregate(results),
        seconds: (Date.now() - started) / 1000,
      });
    }
  } finally {
    await server.close();
  }

  const settings =
    `${embeddings.id} · CHUNK_MAX_TOKENS=${config.CHUNK_MAX_TOKENS} · CHUNK_OVERLAP_TOKENS=${config.CHUNK_OVERLAP_TOKENS} · ` +
    `max_per_document=${config.SEARCH_MAX_PER_DOCUMENT}, neighbor_context=${config.SEARCH_NEIGHBOR_CONTEXT} · ` +
    `score_floor=${floor} · rerank ${reranker ? reranker.id : 'off'} · tr → turkish, en → simple`;
  const markdown = `${table(runs, floor)}\n\nMeasured at ${settings}.\n`;
  process.stdout.write(`External set — XQuAD (eval/external/xquad), reported apart from the golden set\n\n${markdown}\n`);

  if (options.markdown) await fs.writeFile(options.markdown, markdown);
  if (options.json) {
    await fs.writeFile(options.json, `${JSON.stringify({ settings, floor, runs }, null, 2)}\n`);
  }

  const short: string[] = [];
  let gated = false;
  for (const r of runs) {
    const minRecall5 = options.perLanguage[r.lang]?.minRecall5 ?? options.minRecall5;
    const minHeading5 = options.perLanguage[r.lang]?.minHeading5 ?? options.minHeading5;
    if (minRecall5 !== null) {
      gated = true;
      if (r.metrics.recall5 < minRecall5) short.push(`xquad-${r.lang} recall@5 ${pct(r.metrics.recall5)} is below the ${pct(minRecall5)} floor`);
    }
    if (minHeading5 !== null) {
      gated = true;
      if (r.metrics.headingRecall5 < minHeading5) {
        short.push(`xquad-${r.lang} heading@5 ${pct(r.metrics.headingRecall5)} is below the ${pct(minHeading5)} floor`);
      }
    }
  }
  if (gated) {
    if (short.length > 0) {
      process.stdout.write(`The external gate failed.\n${short.map((s) => `  ${s}`).join('\n')}\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write('The external gate passed.\n');
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`eval-external: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
