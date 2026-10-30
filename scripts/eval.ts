import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, count, eq, sql } from 'drizzle-orm';

import { loadConfig, type Config } from '../src/config.js';
import type { Logger } from '../src/context.js';
import { createDb, type Db } from '../src/db/client.js';
import { createProjectVectorIndex } from '../src/db/vector-indexes.js';
import { documentSources, projects, searchQueries, type ProjectRow } from '../src/db/schema.js';
import { chunkReserveTokens } from '../src/services/chunk-budget.js';
import { chunkMarkdown, embeddingText } from '../src/services/chunker.js';
import { createEmbeddingProvider, type EmbeddingProvider } from '../src/services/embeddings/index.js';
import { extractDocument } from '../src/services/doc-types/index.js';
import { createReranker, type Reranker } from '../src/services/reranker.js';
import { readAndHash } from '../src/services/fs-scan.js';
import { listGoldenQuestions, partitionByExpectFile, toGoldenRow } from '../src/services/golden-questions.js';
import { getProjectById, getProjectByName } from '../src/services/projects.js';
import { belowRelevanceFloor, effectiveScoreFloor } from '../src/services/relevance.js';
import { searchProject, type SearchDeps } from '../src/services/search.js';
import { DEFAULT_TEXT_SEARCH_CONFIG, isTextSearchConfig, TEXT_SEARCH_CONFIGS, type TextSearchConfig } from '../src/services/text-search.js';
import {
  getExistingDocuments,
  replaceDocument,
  scanFrom,
  selectionFrom,
  storedDocumentContent,
  type NewChunk,
} from '../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  startPostgres,
  type RunningPostgres,
  type TestDatabase,
} from '../test/integration/support/postgres.js';
import {
  buildRefusalReport,
  buildReport,
  byQuestionId,
  EVAL_SEARCH_LIMIT,
  formatMarkdown,
  formatText,
  gateVerdict,
  NO_FLOORS,
  parseGoldenSet,
  parseNegativeSet,
  scoreNegativeRow,
  scoreRow,
  type Floors,
  type GateVerdict,
  type GoldenRow,
  type NegativeResult,
  type NegativeRow,
  type Report,
  type RowResult,
  type RunContext,
  type ScoredHit,
} from '../src/services/eval-scoring.js';
import { createRemoteReranker, parseRerankUrl, RemoteReranker } from './eval-rerank-remote.js';

/**
 * `npm run eval` — the retrieval measurement of [ADR-0034](../.ssot/ADR.md#adr-0034), FR-190 to FR-195.
 *
 * It indexes `eval/corpus/` into a fresh database, asks every question in `eval/golden.jsonl` through
 * `searchProject` — the one search path the MCP tool and the dashboard use (FR-182) — and prints
 * `recall@1`, `recall@5`, `MRR` and the mean similarity of the correct hit, by language and by tag,
 * with the worst misses and what came back instead.
 *
 * Two things about this file are load-bearing and easy to undo by accident.
 *
 * **The indexing loop is the indexer's, lifted.** `chunkMarkdown` → `embeddingText` → `embedPassages` →
 * `replaceDocument`, in batches of `EMBEDDING_BATCH_SIZE`, exactly as `services/indexer.ts` does it —
 * including the token counter and the reserve it hands the chunker (ADR-0036, ADR-0038). The passage
 * side is the indexing side and the query side is `searchProject`'s; a harness that embedded the corpus
 * as queries would measure a configuration nobody runs.
 * What is left out is only what a corpus already sitting in the repository does not need: the source
 * drivers, the filesystem walk and the `document_sources` rows. `embeddingText` is imported rather than
 * re-derived — a harness that embedded a differently-assembled string would produce numbers that are
 * wrong and entirely plausible.
 *
 * **A run that skipped a file fails.** Phase 1's first three changes each touch chunking or the model,
 * and a run that silently measured chunks written by the previous configuration is the worst kind of
 * defect this could have: wrong, and believable.
 *
 * **With a floor, it is a gate.** `--min-recall5` and `--min-heading5` compare the measured figures
 * against numbers Phase 1 earned and exit `2` when either is short ([ADR-0044](../.ssot/ADR.md#adr-0044)).
 * With neither, it is the report it has always been and exits `0` whatever it finds — which is what an
 * operator sweeping a setting on a laptop wants, and the reason the floor is an argument and not a
 * constant in this file.
 *
 * **It also asks questions the corpus cannot answer.** `eval/negative.jsonl` holds two dozen of them
 * ([ADR-0045](../.ssot/ADR.md#adr-0045)), and the run reports three refusal rates: how many *real*
 * questions `SEARCH_SCORE_FLOOR` would refuse, and how often it fires over each of the two negative
 * classes. That is ADR-0042's three-band table, reproduced from the repository rather than quoted from
 * a paragraph. Two properties of it are load-bearing:
 *
 * - **The search runs with the floor off and the floor is computed from what came back.** One indexing
 *   pass then yields the floor's cost and its benefit in numbers that are comparable to each other and
 *   to the golden run, and `belowRelevanceFloor` — the product's own function, escape hatch and all —
 *   is what decides, so the harness cannot drift into measuring a floor nobody ships.
 * - **A negative question never enters a golden denominator.** It is loaded by a different parser into
 *   a different type and reaches the report through a different parameter. If one ever did, `recall@5`
 *   and `heading@5` would both move without retrieval moving, and ADR-0044's two floors would silently
 *   become floors over a different question set.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_CORPUS_DIR = path.join(REPO_ROOT, 'eval', 'corpus');
const DEFAULT_GOLDEN_PATH = path.join(REPO_ROOT, 'eval', 'golden.jsonl');
const DEFAULT_NEGATIVE_PATH = path.join(REPO_ROOT, 'eval', 'negative.jsonl');

/** The page every question is asked with; `EVAL_SEARCH_LIMIT` is shared with the server's run (ADR-0124), so the two figures describe one page. */
const SEARCH_LIMIT = EVAL_SEARCH_LIMIT;

const PROJECT_NAME = 'eval';

/**
 * What an operator would set on a source holding each language directory of the corpus
 * ([ADR-0064](../.ssot/ADR.md#adr-0064)).
 *
 * The corpus is two bodies of documentation in one project, which is the shape this product is for,
 * and `eval/corpus/tr` is a Turkish source: an operator would name its language and PostgreSQL would
 * stem it. Stamping that here is what makes the run measure the configuration being proposed rather
 * than a uniform one nobody would choose — and it is also what puts two configurations in one index,
 * so the multi-configuration query path is exercised by every run instead of by a test alone.
 *
 * `en` is `simple` and not `english` deliberately: ADR-0041 measured the two on this corpus and
 * `simple` won, because an English question about `HLY-4015` is mostly identifiers and a stemmer
 * costs more on them than it earns on the prose. A language whose morphology is the problem — Turkish
 * is agglutinative — is the case the stemmer is for.
 */
const CORPUS_TEXT_SEARCH_CONFIGS: Readonly<Record<string, TextSearchConfig>> = { en: 'simple', tr: 'turkish' };

/** How a run decides what each corpus file is indexed with, and the one line the report prints about it. */
export interface CorpusTextSearchConfigs {
  /** For a corpus-relative posix path such as `tr/sss.md`. */
  forFile(relativePath: string): TextSearchConfig;
  /** Rendered into the report's configuration line, because two runs at different values are not comparable. */
  describe: string;
}

/**
 * Which PostgreSQL text search configuration the lexical half **indexes** with
 * ([ADR-0041](../.ssot/ADR.md#adr-0041), amended by [ADR-0064](../.ssot/ADR.md#adr-0064)).
 *
 * It is no longer "on both sides", and that is the change ADR-0064 made: the query side reads
 * `chunks.text_search_config` and speaks every configuration the index holds, so a run can no longer
 * put the two halves out of step even by trying. What is left to choose is the corpus, and by default
 * each language directory gets the configuration its operator would.
 *
 * `EVAL_TEXT_SEARCH_CONFIG` overrides that to one configuration for the whole corpus, which is what
 * keeps the sweep this variable exists for — and what reproduces ADR-0041's own measurement exactly,
 * with `EVAL_TEXT_SEARCH_CONFIG=simple`.
 */
export function evalTextSearchConfigs(): CorpusTextSearchConfigs {
  const value = process.env.EVAL_TEXT_SEARCH_CONFIG;
  if (value !== undefined && value !== '') {
    if (!isTextSearchConfig(value)) {
      throw new Error(`EVAL_TEXT_SEARCH_CONFIG=${JSON.stringify(value)} is not one of: ${TEXT_SEARCH_CONFIGS.join(', ')}`);
    }
    return { forFile: () => value, describe: `${value} (EVAL_TEXT_SEARCH_CONFIG, the whole corpus)` };
  }
  const mapped = Object.entries(CORPUS_TEXT_SEARCH_CONFIGS);
  return {
    // The first path segment, which is the corpus's language directory. Anything outside one of them
    // is `simple`, which is what a source that names no language gets.
    forFile: (relativePath) => CORPUS_TEXT_SEARCH_CONFIGS[relativePath.split('/')[0]] ?? DEFAULT_TEXT_SEARCH_CONFIG,
    describe: mapped.map(([dir, config]) => `${dir}/ → ${config}`).join(', '),
  };
}

interface OutputTarget {
  format: 'text' | 'json' | 'markdown';
  /** `null` means stdout. */
  file: string | null;
}

export interface Options {
  outputs: OutputTarget[];
  floors: Floors;
  /** The directory of `.md` files to index. Defaults to the repository's `eval/corpus/`. */
  corpusDir: string;
  /** The golden question file. Defaults to the repository's `eval/golden.jsonl`. */
  goldenPath: string;
  /**
   * The negative question file, or `null` for none (ADR-0045). The repository's `eval/negative.jsonl`
   * is the default **only for the repository's own corpus**: its `absent-feature` rows are claims about
   * what `eval/corpus/` does not say, and asking them of somebody else's documentation would report a
   * refusal rate over questions that may well be answerable there.
   */
  negativePath: string | null;
  /** A project's name or id: ask its stored question set of its live index instead of indexing a corpus. */
  project: string | null;
  /** Whether the run is the repository's own set, which is what the report header names. */
  customSet: boolean;
  /**
   * A remote cross-encoder to rerank with, over HTTP (`--rerank-url`): the measurement arm of K-22. `null`
   * is the default, and with it the run is exactly what it was before the flag existed.
   */
  rerankUrl: string | null;
  /** Where to write the remote rerank's latency summary as JSON (`--rerank-latency`). Only with `--rerank-url`. */
  rerankLatencyPath: string | null;
  /** `--project` only: refuse the run when a question expects a file the live index does not hold, as `0.4.0` did, instead of skipping it. */
  strict: boolean;
}

const USAGE = `Usage: npm run eval [-- <options>]

  --corpus <dir>           Index this directory of .md files instead of eval/corpus/.
  --golden <file>          Ask the questions in this JSONL file instead of eval/golden.jsonl. Its
                           expectFile values are paths under the corpus directory.
  --negative <file>        Also ask this file of questions whose right answer is "nothing". Without a
                           custom corpus it defaults to eval/negative.jsonl; with one it defaults to
                           none, because those rows describe the repository's corpus.
  --project <name|id>      Ask the question set stored for a project (the admin API's golden-questions)
                           of that project's live index, through the same search path. Reads DATABASE_URL
                           and indexes nothing. Cannot be combined with --corpus or --golden. A question
                           whose expectFile is not in the live index is skipped, listed, and left out of
                           the figures; the server's own runs do the same (ADR-0124). It never reranks
                           with the local model, whatever SEARCH_RERANK says: the server's search path
                           does not. Only --rerank-url reranks it.
  --strict                 With --project: refuse the whole run when such a question exists, as 0.4.0 did.
  --rerank-url <url>       Rerank the fused pool with a remote cross-encoder behind a TEI-compatible
                           /rerank endpoint (e.g. http://127.0.0.1:8089) instead of the local model. A
                           measurement arm: scripts/eval-rerank-remote.ts compares it with a run without.
                           Cannot be combined with SEARCH_RERANK=on (with --project SEARCH_RERANK is ignored).
  --rerank-latency <file>  With --rerank-url: write the per-search rerank latency (p50, p95, max) as JSON.
  --markdown[=<file>]      Markdown tables. With a file, written there and the text report still prints.
  --json[=<file>]          The same numbers as JSON, same rule about the file.
  --min-recall5=<0..1>     Fail the run when recall@5 is below this. The shipped floor is in eval/BASELINE.md.
  --min-heading5=<0..1>    The same for heading@5 — the right chunk of the right file, not just the file.
  -h, --help               This.

  A value flag takes its value as "--corpus <dir>" or "--corpus=<dir>". Relative paths, read and
  written alike, are taken from the directory "npm run eval" was typed in, not from the repository
  root. With none of the four, the run is the repository's own set and its numbers are the ones in
  eval/BASELINE.md.

  With a floor, a completed run whose numbers are short exits 2; without one it exits 0 whatever it
  finds. A harness failure — a malformed question, a skipped corpus file — is exit 1 either way, and
  the two are different codes on purpose: "retrieval got worse" and "this run measured nothing" are
  not the same news.

  EVAL_DATABASE_URL, or DATABASE_URL, points at a PostgreSQL to carve a throwaway database out of.
  With neither, a pgvector container is started for the run and stopped at the end.
  EVAL_TEXT_SEARCH_CONFIG names one text search configuration for the whole corpus. Unset, each
  corpus language directory is indexed the way its operator would set it (en/ simple, tr/ turkish);
  the query side is never told and reads the index instead (ADR-0064). "simple" reproduces the
  uniform run ADR-0041 was decided on, and "english" is the comparison it was decided against.
  SEARCH_MAX_PER_DOCUMENT, SEARCH_NEIGHBOR_CONTEXT and SEARCH_SCORE_FLOOR are read from the
  environment like every other setting, so measuring what the cap or the floor costs is running this
  twice with one of them changed rather than a flag this file has to grow.
  EVAL_SOURCE_SCOPE=1 measures the search a token bound to sources runs (ADR-0133): every corpus
  language directory becomes a document source, and every question is asked with a scope naming all
  of them, which is the filtered statement with the whole corpus inside it. The recall it reports
  is the unscoped run's to compare against, and the filter itself must change none of it.
  EVAL_SEARCH_LATENCY=1 prints the per-search p50 and p95 of the questions, so the two runs can be put
  side by side. Neither changes what an unset run does or what its report says.

  Every run also asks eval/negative.jsonl — questions whose right answer is "nothing" — and reports
  three refusal rates at SEARCH_SCORE_FLOOR: over the golden set, over absent-feature questions and
  over off-domain ones. Those three are reported and never gated, and the negative questions are in
  no recall@5 or heading@5 denominator.
`;

/** A floor is a fraction, because every metric in the report is one. `--min-recall5=85` is a mistake. */
function parseFloor(flag: string, value: string | null): number {
  const parsed = Number(value);
  if (value === null || value === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} takes a number between 0 and 1, e.g. ${flag}=0.855`);
  }
  return parsed;
}

/** The value of a value flag: `--corpus=dir` carries it, `--corpus dir` takes the next argument. */
function takeValue(flag: string, inline: string | null, argv: readonly string[], index: number): { value: string; consumed: number } {
  if (inline !== null) {
    if (inline === '') throw new Error(`${flag} takes a value, e.g. ${flag}=<path>`);
    return { value: inline, consumed: 0 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) throw new Error(`${flag} takes a value, e.g. ${flag} <path>`);
  return { value: next, consumed: 1 };
}

/**
 * The directory a relative path on the command line means. `npm run` moves the process into the package
 * root and leaves the directory the person typed it in as `INIT_CWD`, so `npm run eval -- --golden q.jsonl`
 * from `docs/` reads `docs/q.jsonl` rather than looking for it beside `package.json`. Run without npm there
 * is no `INIT_CWD` and the process directory is the one the person is in.
 */
export function invocationDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const initCwd = env.INIT_CWD;
  return initCwd !== undefined && initCwd !== '' ? initCwd : process.cwd();
}

export function parseArgs(argv: readonly string[], cwd: string = invocationDirectory()): Options {
  const outputs: OutputTarget[] = [];
  const floors: Floors = { ...NO_FLOORS };
  let quietText = false;
  let corpus: string | null = null;
  let golden: string | null = null;
  let negative: string | null = null;
  let project: string | null = null;
  let rerankUrl: string | null = null;
  let rerankLatency: string | null = null;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--corpus':
      case '--golden':
      case '--negative':
      case '--project': {
        const taken = takeValue(flag, value, argv, i);
        i += taken.consumed;
        if (flag === '--corpus') corpus = taken.value;
        else if (flag === '--golden') golden = taken.value;
        else if (flag === '--negative') negative = taken.value;
        else project = taken.value;
        break;
      }
      case '--rerank-url': {
        const taken = takeValue(flag, value, argv, i);
        i += taken.consumed;
        rerankUrl = parseRerankUrl(taken.value).href;
        break;
      }
      case '--rerank-latency': {
        const taken = takeValue(flag, value, argv, i);
        i += taken.consumed;
        rerankLatency = path.resolve(cwd, taken.value);
        break;
      }
      case '--markdown':
      case '--json': {
        const format = flag === '--json' ? 'json' : 'markdown';
        outputs.push({ format, file: value === null ? null : path.resolve(cwd, value) });
        // Without a path the chosen format replaces the human report on stdout; with one it is written
        // to the file and the text report still goes to the terminal, which is what CI wants.
        if (value === null) quietText = true;
        break;
      }
      case '--strict':
        if (value !== null) throw new Error('--strict takes no value');
        strict = true;
        break;
      case '--min-recall5':
        floors.recall5 = parseFloor(flag, value);
        break;
      case '--min-heading5':
        floors.headingRecall5 = parseFloor(flag, value);
        break;
      default:
        throw new Error(`Unknown option ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
  }

  // A project's questions come out of its own table and are asked of its own index, so a corpus
  // directory or a question file beside it would be silently ignored — refused instead.
  if (project !== null && (corpus !== null || golden !== null)) {
    throw new Error('--project asks the questions stored for a project of its live index; it cannot be combined with --corpus or --golden');
  }
  if (rerankLatency !== null && rerankUrl === null) throw new Error('--rerank-latency measures the remote rerank and needs --rerank-url');
  if (strict && project === null)
    throw new Error('--strict applies to --project only: it refuses a question that expects a file the live index does not hold');
  if (!quietText) outputs.unshift({ format: 'text', file: null });

  const corpusDir = corpus === null ? DEFAULT_CORPUS_DIR : path.resolve(cwd, corpus);
  const goldenPath = golden === null ? DEFAULT_GOLDEN_PATH : path.resolve(cwd, golden);
  // Naming the repository's own files is the same run as naming nothing: flags that resolve to the
  // defaults keep the refusal set and the report title, so the explicit form reports the same figures.
  const customSet = project !== null || corpusDir !== DEFAULT_CORPUS_DIR || goldenPath !== DEFAULT_GOLDEN_PATH;
  return {
    outputs,
    floors,
    corpusDir,
    goldenPath,
    negativePath: negative !== null ? path.resolve(cwd, negative) : customSet ? null : DEFAULT_NEGATIVE_PATH,
    project,
    customSet,
    rerankUrl,
    rerankLatencyPath: rerankLatency,
    strict,
  };
}

/** Progress on stderr so that `--json > file` is still valid JSON. */
const step = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * The embedding provider logs the model download, which is the one thing worth seeing on a cold run and
 * takes minutes. Everything else it says is startup chatter.
 */
const evalLogger: Logger = {
  level: 'info',
  fatal: () => {},
  error: (...args: unknown[]) => step(`  ! ${JSON.stringify(args[0])}`),
  warn: () => {},
  info: (obj: unknown, msg?: unknown) => {
    if (typeof msg === 'string' && (msg.startsWith('downloading') || msg.startsWith('loading') || msg.startsWith('embedding model'))) {
      step(`  · ${msg} ${JSON.stringify(obj)}`);
    }
  },
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => evalLogger,
};

/**
 * `loadConfig` is the product's own parser, so the chunk budget and the model this harness measures are
 * exactly the ones a server would run with. It refuses an environment with no database, and by design
 * `process.exit`s rather than throwing — so it is called before any container is started, with a
 * placeholder URL when there is none yet. Nothing here reads `DATABASE_URL` back out of the result; the
 * connection is made from the URL resolved below.
 */
function loadEvalConfig(): Config {
  const url = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://eval:eval@127.0.0.1:5432/eval';
  return loadConfig({ ...process.env, DATABASE_URL: url });
}

function commitDescription(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

/** Every `.md` under the corpus directory, as posix paths relative to it, sorted so a run is reproducible. */
export async function corpusFiles(corpusDir: string = DEFAULT_CORPUS_DIR): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(path.relative(corpusDir, absolute).split(path.sep).join('/'));
      }
    }
  };
  await walk(corpusDir);
  return found.sort();
}

/**
 * Makes each top-level directory of the corpus a document source and stamps its documents with it, so a scope can
 * name them ([ADR-0133](../.ssot/ADR.md#adr-0133)). The harness indexes with no source rows at all, and that is
 * right for every other measurement; this is only for `EVAL_SOURCE_SCOPE=1`. Returns the source ids: the scope
 * that covers the whole corpus, which is the worst case for the filtered statement and the figure worth having.
 *
 * A file with no directory belongs to no source, and a scope over every source would then miss it: the run would
 * measure a different corpus, so it is refused rather than reported.
 */
export async function bindCorpusSources(db: Db, projectId: string, files: readonly string[]): Promise<string[]> {
  const loose = files.filter((file) => !file.includes('/'));
  if (loose.length > 0) {
    throw new Error(`EVAL_SOURCE_SCOPE=1 needs every corpus file in a directory (its source); these are not: ${loose.join(', ')}`);
  }
  const names = [...new Set(files.map((file) => file.slice(0, file.indexOf('/'))))].sort();
  const rows = await db
    .insert(documentSources)
    .values(names.map((name) => ({ projectId, type: 'local', name, config: {} })))
    .returning({ id: documentSources.id });
  await db.execute(sql`
    update documents d set source_id = s.id
    from document_sources s
    where d.project_id = ${projectId} and s.project_id = ${projectId} and starts_with(d.relative_path, s.name || '/')`);
  return rows.map((row) => row.id);
}

/** Nearest-rank percentile of a sample: a value that was measured, never one interpolated. */
function nearestRank(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

export interface IndexOutcome {
  documents: number;
  chunks: number;
}

export async function indexCorpus(
  db: Db,
  embeddings: EmbeddingProvider,
  config: Config,
  projectId: string,
  generation: number,
  files: readonly string[],
  textSearchConfigs: CorpusTextSearchConfigs,
  corpusDir: string = DEFAULT_CORPUS_DIR,
): Promise<IndexOutcome> {
  // A fresh database cannot hold a previous run's documents, so this map is expected to be empty. It is
  // read anyway: the guard below is what makes "unchanged, skipped" impossible to reach silently, and a
  // guard that only works because of an assumption elsewhere is a guard that stops working quietly.
  const existing = await getExistingDocuments(db, projectId, generation);
  const skipped: string[] = [];
  let chunkCount = 0;
  // The indexer's, and for its reason: the passage prefix is part of what the model reads (ADR-0038).
  // Computed after warmup, which `run` has already done, so the prefix is counted and not estimated.
  const reserveTokens = chunkReserveTokens(embeddings);

  for (const relativePath of files) {
    const { bytes, hash, sizeBytes } = await readAndHash(path.join(corpusDir, relativePath));
    // The indexer's own step, and the identity for a `.md` file (ADR-0056). Calling it here rather
    // than decoding the buffer keeps the harness on the product's single path into the chunker.
    const content = await extractDocument(relativePath, bytes, {
      maxFileBytes: config.MAX_CONVERTED_FILE_BYTES,
      maxPdfPages: config.MAX_PDF_PAGES,
      maxUnpackedBytes: config.MAX_DOCX_UNPACKED_BYTES,
    });
    const previous = existing.get(relativePath);
    if (previous && previous.contentHash === hash) {
      skipped.push(`${relativePath} (content hash unchanged — this database was not fresh)`);
      continue;
    }

    // No `transformContent`: the corpus is plain Markdown, the `plain` flavor is the identity transform,
    // and naming a flavor here would imply the harness can be pointed at Obsidian or Notion exports.
    const { title, chunks } = chunkMarkdown(content, relativePath, {
      maxTokens: config.CHUNK_MAX_TOKENS,
      overlapTokens: config.CHUNK_OVERLAP_TOKENS,
      // The indexer's own two arguments (ADR-0036, ADR-0038). A harness that counted tokens differently
      // from the product would sweep `CHUNK_MAX_TOKENS` over chunks the product never produces.
      countTokens: (text: string) => embeddings.countTokens(text),
      reserveTokens,
    });
    if (chunks.length === 0) {
      skipped.push(`${relativePath} (produced no chunks)`);
      continue;
    }

    const rows: NewChunk[] = [];
    for (let i = 0; i < chunks.length; i += config.EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + config.EMBEDDING_BATCH_SIZE);
      const vectors = await embeddings.embedPassages(batch.map(embeddingText));
      batch.forEach((c, j) => {
        rows.push({ chunkIndex: c.index, headingPath: c.headingPath, content: c.content, tokenCount: c.tokenCount, embedding: vectors[j] });
      });
    }

    await replaceDocument(
      db,
      {
        projectId,
        sourceId: null,
        relativePath,
        title,
        contentHash: hash,
        sizeBytes,
        indexGeneration: generation,
        // The corpus is one unversioned release, and stating that is what keeps the measurement
        // comparable across ADR-0058: an unversioned document is what every `version` filter misses
        // and what a search with no filter reaches, which is exactly the baseline configuration.
        version: '',
        // The corpus text, stored as the indexer stores it (ADR-0043). It changes no vector and no
        // chunk, so it moves no number in this report — it is here because the harness is the
        // indexer's loop, and a loop that had stopped writing one of the columns the product writes
        // would be a loop that no longer measures the product.
        ...storedDocumentContent(content, config.MAX_STORED_DOCUMENT_BYTES),
      },
      rows,
      // Per file, because the corpus is two sources in one project and each of them is indexed the way
      // its operator would set it (ADR-0064). This is the only place in the harness that names a
      // configuration; the query side is handed none and reads the index instead.
      textSearchConfigs.forFile(relativePath),
    );
    chunkCount += rows.length;
  }

  if (skipped.length > 0) {
    throw new Error(
      `The indexing step skipped ${skipped.length} of ${files.length} corpus files, so this run would measure ` +
        `something other than the current configuration:\n  ${skipped.join('\n  ')}`,
    );
  }
  return { documents: files.length, chunks: chunkCount };
}

/** One question's answer as the scorer wants it: the hits, and whether the relevance floor would have refused. */
export type Ask = (id: string, query: string) => Promise<{ hits: ScoredHit[]; refused: boolean }>;

/** What `makeAsk` needs of a search: the product's own dependencies, minus the three the harness fixes. */
export interface AskDeps {
  db: Db;
  embeddings: EmbeddingProvider;
  config: Config;
  reranker: Reranker | null;
  projectId: string;
  /** The floor `refused` is decided against: the instance's, or the project's own when it holds one (ADR-0083). */
  refusalFloor: number;
  /**
   * A token's source scope ([ADR-0133](../.ssot/ADR.md#adr-0133)), for measuring the filtered statement.
   * Unset, and **unset is the call this function always made**, the search is unscoped.
   */
  sourceScope?: readonly string[];
}

/**
 * One question through the product's own search path, with the relevance floor **off**.
 *
 * The floor changes no hit and no score — `searchProject` returns the same list either way and
 * only sets a flag — so asking with it off and deciding here costs nothing and buys two things.
 * The golden run and the negative run are then one measurement rather than two, and the decision
 * is made by `belowRelevanceFloor` itself, escape hatch included, so the figures describe the
 * floor the product ships rather than a re-implementation of it (ADR-0045).
 *
 * The scan settings are the server's own, not the defaults (ADR-0040). The eval corpus is one
 * project in an otherwise empty database, so iterative scan has nothing to do here — but a harness
 * that measured a different `ef_search` from the one an agent searches under would be measuring
 * something nobody runs, which is the mistake this whole file exists to avoid. The server's own
 * result selection as well, for the same reason: SEARCH_MAX_PER_DOCUMENT changes `recall@5` by a
 * question (ADR-0042).
 */
export function makeAsk({ db, embeddings, config, reranker, projectId, refusalFloor, sourceScope }: AskDeps): Ask {
  const deps: SearchDeps = { db, embeddings, scan: scanFrom(config), selection: selectionFrom(config), scoreFloor: 0, rerank: reranker ?? undefined };
  return async (id, query) => {
    const outcome = await searchProject(deps, { projectId, query, limit: SEARCH_LIMIT, ...(sourceScope ? { sourceScope } : {}) });
    if (outcome.status !== 'ok') {
      throw new Error(`Question ${id} could not be scored: searchProject answered ${outcome.status}`);
    }
    return {
      hits: outcome.hits.map((hit) => ({ file: hit.file, headingPath: hit.headingPath, score: hit.score })),
      refused: belowRelevanceFloor(query, outcome.hits, refusalFloor),
    };
  };
}

/**
 * Both question sets through one `ask`, as two loops over two types.
 *
 * The negative set is never merged into `golden` anywhere below — that is what keeps it out of every
 * denominator in the report (ADR-0045). A caller that holds a project's questions and a negative file
 * passes them here as two arguments for the same reason the corpus run does.
 */
export async function askQuestions(
  ask: Ask,
  golden: readonly GoldenRow[],
  negative: readonly NegativeRow[],
): Promise<{ results: RowResult[]; negativeResults: NegativeResult[]; searchMs: number }> {
  step(`eval: asking ${golden.length} questions`);
  const searchStart = Date.now();
  const results: RowResult[] = [];
  for (const row of golden) {
    const { hits, refused } = await ask(row.id, row.query);
    // What the agent would have been told, recorded beside the rank rather than instead of it.
    // The hits are scored either way: the floor's cost is "the answer was here and we refused it",
    // and folding a refusal into `recall@5` would hide exactly that (ADR-0042).
    results.push(scoreRow(row, hits, refused));
  }

  if (negative.length > 0) step(`eval: asking ${negative.length} questions the corpus cannot answer`);
  const negativeResults: NegativeResult[] = [];
  for (const row of negative) {
    const { hits, refused } = await ask(row.id, row.query);
    negativeResults.push(scoreNegativeRow(row, hits, refused));
  }
  return { results, negativeResults, searchMs: Date.now() - searchStart };
}

/**
 * The report for a set of results, whatever order they were asked in.
 *
 * The corpus run asks in file order and a project run asks in key order, and a mean is not
 * associative: the same questions summed in two orders can differ in the last digit, which `--json`
 * prints. Both runs are put in id order here, so the same set of questions yields the same report,
 * byte for byte, from either source.
 *
 * The negative results reach the report here and only here — as their own argument, never merged
 * into `results` (ADR-0045). `test/eval-scoring.test.ts` asserts what that buys: the golden
 * denominators are the same number with the negative set loaded and without it. A run with no
 * negative file has no refusal report at all rather than one over an empty set.
 */
export function assembleReport(
  results: readonly RowResult[],
  negativeResults: readonly NegativeResult[],
  context: RunContext,
  floors: Floors,
  refusalFloor: number,
  hasNegatives: boolean,
): Report {
  const golden = [...results].sort(byQuestionId);
  return buildReport(
    golden,
    context,
    floors,
    hasNegatives ? buildRefusalReport(golden, [...negativeResults].sort(byQuestionId), refusalFloor) : null,
  );
}

/** Builds the report, judges the gate, and writes every requested output. */
async function emitReport(
  options: Options,
  results: readonly RowResult[],
  negativeResults: readonly NegativeResult[],
  context: RunContext,
  refusalFloor: number,
  hasNegatives: boolean,
): Promise<GateVerdict> {
  const report = assembleReport(results, negativeResults, context, options.floors, refusalFloor, hasNegatives);
  // The verdict is computed before anything is written, so a floor that cannot be judged — a
  // `--min-heading5` over a question set carrying no headings — fails the run rather than being
  // rendered into a summary as a pass.
  const verdict = gateVerdict(report);
  for (const output of options.outputs) {
    const text =
      output.format === 'json'
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${output.format === 'markdown' ? formatMarkdown(report) : formatText(report)}\n`;
    if (output.file === null) process.stdout.write(text);
    else {
      await fs.appendFile(output.file, text, 'utf8');
      step(`eval: wrote ${output.format} to ${output.file}`);
    }
  }
  return verdict;
}

/** A path that must exist as the kind of thing the flag names, said in the flag's words. */
async function requireKind(flag: string, target: string, kind: 'directory' | 'file'): Promise<void> {
  const stat = await fs.stat(target).catch(() => null);
  if (stat === null) throw new Error(`${flag}: ${target} does not exist`);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${flag}: ${target} is not a ${kind}`);
}

/** The label a question file goes by in a parse error: the path as the operator would recognise it. */
function labelFor(absolute: string): string {
  // The repository's own files keep the names the parse errors and the report have always used.
  if (absolute === DEFAULT_CORPUS_DIR) return 'eval/corpus';
  if (absolute === DEFAULT_GOLDEN_PATH) return 'golden.jsonl';
  if (absolute === DEFAULT_NEGATIVE_PATH) return 'negative.jsonl';
  const relative = path.relative(invocationDirectory(), absolute);
  return relative !== '' && !relative.startsWith('..') ? relative.split(path.sep).join('/') : absolute;
}

async function warmModels(
  config: Config,
  options: Options,
  withLocalReranker = true,
): Promise<{ embeddings: EmbeddingProvider; reranker: Reranker | null; modelLoadMs: number }> {
  const embeddings = createEmbeddingProvider(config, evalLogger);
  step(`eval: loading ${embeddings.id} (a first run downloads it, which takes minutes)`);
  const modelStart = Date.now();
  await embeddings.warmup();
  const modelLoadMs = Date.now() - modelStart;

  // The second model, and only when an operator asked for one (ROADMAP.md Item 12). It is warmed up
  // here rather than on the first question so that its load does not land inside `searchMs` and read
  // as latency every search pays.
  if (options.rerankUrl !== null) {
    if (config.SEARCH_RERANK === 'on' && withLocalReranker) {
      throw new Error('--rerank-url and SEARCH_RERANK=on both name a reranker; a run measures one, so set only one of them');
    }
    const remote = createRemoteReranker({ url: options.rerankUrl });
    step(`eval: contacting the remote reranker at ${options.rerankUrl}`);
    await remote.warmup();
    return { embeddings, reranker: remote, modelLoadMs };
  }
  const reranker = withLocalReranker ? createReranker(config, evalLogger) : null;
  if (reranker) {
    step(`eval: loading ${reranker.id} (a first run downloads it, which takes minutes)`);
    await reranker.warmup();
  }
  return { embeddings, reranker, modelLoadMs };
}

/**
 * The report's `rerank` row. A remote reranker describes itself, latency included, because it is read
 * after the questions were asked; the local one is what it has always been, and `off` stays `off`.
 */
function describeRerank(reranker: Reranker | null, config: Config): string {
  if (reranker === null) return 'off';
  if (reranker instanceof RemoteReranker) return reranker.describe();
  return `${reranker.id}, max_tokens=${config.SEARCH_RERANK_MAX_TOKENS}, batch=${config.SEARCH_RERANK_BATCH}`;
}

/** Writes the remote rerank's latency summary where `--rerank-latency` asked, and says it on stderr either way. */
async function reportRerankLatency(reranker: Reranker | null, options: Options): Promise<void> {
  if (!(reranker instanceof RemoteReranker)) return;
  const summary = reranker.latencySummary();
  if (summary === null) return;
  step(`eval: remote rerank latency over ${summary.searches} searches: p50 ${summary.p50Ms.toFixed(0)} ms, p95 ${summary.p95Ms.toFixed(0)} ms`);
  if (options.rerankLatencyPath !== null) {
    await fs.writeFile(options.rerankLatencyPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    step(`eval: wrote the rerank latency to ${options.rerankLatencyPath}`);
  }
}

async function readNegatives(options: Options): Promise<NegativeRow[]> {
  if (options.negativePath === null) return [];
  await requireKind('--negative', options.negativePath, 'file');
  return parseNegativeSet(await fs.readFile(options.negativePath, 'utf8'), labelFor(options.negativePath));
}

async function run(options: Options): Promise<GateVerdict> {
  return options.project === null ? runCorpus(options) : runProject(options);
}

/** The corpus run: index a directory of Markdown into a throwaway database and ask it a question file. */
async function runCorpus(options: Options): Promise<GateVerdict> {
  const startedAt = new Date();
  const totalStart = Date.now();
  const config = loadEvalConfig();
  const textSearchConfigs = evalTextSearchConfigs();

  await requireKind('--corpus', options.corpusDir, 'directory');
  await requireKind('--golden', options.goldenPath, 'file');
  const files = await corpusFiles(options.corpusDir);
  if (files.length === 0) throw new Error(`--corpus: ${options.corpusDir} holds no .md files`);
  const corpusLabel = `${labelFor(options.corpusDir)}/`;
  const golden = parseGoldenSet(await fs.readFile(options.goldenPath, 'utf8'), new Set(files), {
    file: labelFor(options.goldenPath),
    corpus: corpusLabel,
  });
  // Two files, two parsers, two types (ADR-0045).
  const negative = await readNegatives(options);
  step(`eval: ${files.length} corpus files, ${golden.length} questions, ${negative.length} negative questions`);

  const { embeddings, reranker, modelLoadMs } = await warmModels(config, options);

  const provided = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL;
  let container: RunningPostgres | null = null;
  let database: TestDatabase | null = null;
  let baseUrl = provided ?? '';

  try {
    if (!provided) {
      step('eval: starting a pgvector container (set EVAL_DATABASE_URL to use a server you already have)');
      container = await startPostgres();
      baseUrl = container.baseUrl;
    }
    // A database of its own, dropped in the `finally` below, whether it was carved out of a container
    // started here or out of a server somebody handed us. Never the caller's own database.
    database = await createTestDatabase(baseUrl, `contextator_eval_${Date.now().toString(36)}`);
    await applySchema(database, config.EMBEDDING_DIMENSIONS);
    const db = database.db;

    // The generation comes off the inserted row rather than being written down as `0` here: the
    // harness indexes through the product's own functions and those take a generation (ADR-0039), and
    // a literal would be a second place that has to agree with the column's default.
    const [project] = await db
      .insert(projects)
      .values({ name: PROJECT_NAME })
      .returning({ id: projects.id, liveGeneration: projects.liveGeneration });
    // The index `createProject` would have built: the harness inserts the row itself, and a project
    // searched without its own index is searched by exact scan — a better answer than the product gives.
    await createProjectVectorIndex(db, project.id);

    step('eval: indexing the corpus');
    const indexStart = Date.now();
    const indexed = await indexCorpus(db, embeddings, config, project.id, project.liveGeneration, files, textSearchConfigs, options.corpusDir);
    const indexMs = Date.now() - indexStart;

    // `searchProject` re-reads the project and refuses one with no chunks or a model it does not run,
    // so these four columns are not bookkeeping — they are what makes the next step legal.
    await db
      .update(projects)
      .set({
        chunkCount: indexed.chunks,
        documentCount: indexed.documents,
        embeddingModel: embeddings.id,
        lastIndexedAt: new Date(),
      })
      .where(eq(projects.id, project.id));

    // Opt-in measurement of the filtered statement (ADR-0133): unset, `sourceScope` is undefined and so is every
    // difference from the run this was before.
    const sourceScope = process.env.EVAL_SOURCE_SCOPE === '1' ? await bindCorpusSources(db, project.id, files) : undefined;
    if (sourceScope) step(`eval: every question is asked with a source scope covering all ${sourceScope.length} corpus sources`);
    const baseAsk = makeAsk({ db, embeddings, config, reranker, projectId: project.id, refusalFloor: config.SEARCH_SCORE_FLOOR, sourceScope });
    const latenciesMs: number[] = [];
    const ask: Ask =
      process.env.EVAL_SEARCH_LATENCY === '1' || sourceScope
        ? async (id, query) => {
            const started = performance.now();
            try {
              return await baseAsk(id, query);
            } finally {
              latenciesMs.push(performance.now() - started);
            }
          }
        : baseAsk;
    const { results, negativeResults, searchMs } = await askQuestions(ask, golden, negative);
    if (latenciesMs.length > 0) {
      step(
        `eval: ${latenciesMs.length} searches, ${sourceScope ? 'scoped to every corpus source' : 'unscoped'}: ` +
          `p50 ${nearestRank(latenciesMs, 0.5).toFixed(1)} ms, p95 ${nearestRank(latenciesMs, 0.95).toFixed(1)} ms`,
      );
    }
    await reportRerankLatency(reranker, options);

    /**
     * **The harness records nothing, and that is asserted rather than assumed**
     * ([ADR-0047](../.ssot/ADR.md#adr-0047)).
     *
     * `SearchDeps.queryLog` is optional and unset is off, so `ask` above writes no row by construction
     * — the same convention that makes `scan` and `scoreFloor` safe to omit. This is the check that the
     * construction is still the construction. An `ask` that acquired a sink by accident — by being
     * handed a whole `AppContext` one day, say — would quietly turn every run of this file into
     * eighty-eight rows of invented traffic inside a table whose entire value is that its traffic is
     * real, and no retrieval number would move to say so.
     */
    const [recorded] = await db.select({ rows: count() }).from(searchQueries);
    if (recorded.rows !== 0) {
      throw new Error(
        `The harness passes no query log sink, so search_queries must be empty — it holds ${recorded.rows} rows. ` +
          'Something on the search path is recording without being asked to (ADR-0047).',
      );
    }

    const scan = scanFrom(config);
    const selection = selectionFrom(config);
    const context: RunContext = {
      commit: commitDescription(),
      // Named only when the run is not the repository's own set, so the default report is byte-identical.
      ...(options.customSet ? { subject: `${corpusLabel} + ${labelFor(options.goldenPath)}` } : {}),
      providerId: embeddings.id,
      embeddingModel: embeddings.model,
      embeddingDtype: config.EMBEDDING_DTYPE,
      dimensions: embeddings.dimensions,
      chunkMaxTokens: config.CHUNK_MAX_TOKENS,
      chunkOverlapTokens: config.CHUNK_OVERLAP_TOKENS,
      searchLimit: SEARCH_LIMIT,
      hnswScan: `ef_search=${scan.efSearch}, iterative_scan=${scan.iterativeScan}, max_scan_tuples=${scan.maxScanTuples}`,
      textSearchConfig: textSearchConfigs.describe,
      resultSelection:
        `max_per_document=${selection.maxPerDocument}, neighbor_context=${selection.neighborContext}, ` + `score_floor=${config.SEARCH_SCORE_FLOOR}`,
      rerank: describeRerank(reranker, config),
      documents: indexed.documents,
      chunks: indexed.chunks,
      startedAt: startedAt.toISOString(),
      totalMs: Date.now() - totalStart,
      modelLoadMs,
      indexMs,
      searchMs,
    };
    return await emitReport(options, results, negativeResults, context, config.SEARCH_SCORE_FLOOR, negative.length > 0);
  } finally {
    if (database) await dropTestDatabase(baseUrl, database).catch((err: unknown) => step(`eval: could not drop the database: ${String(err)}`));
    if (container) await container.stop().catch((err: unknown) => step(`eval: could not stop the container: ${String(err)}`));
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a project run measured: the two result lists, plus the facts the report needs about the index it asked. */
export interface ProjectMeasurement {
  project: ProjectRow;
  /** The questions that were asked: the set less `skipped`. */
  golden: GoldenRow[];
  /** The questions left out because their `expectFile` is not in the live index (ADR-0124). */
  skipped: GoldenRow[];
  results: RowResult[];
  negativeResults: NegativeResult[];
  /** The floor `refused` was decided against: the instance's, or the project's own (ADR-0083). */
  refusalFloor: number;
  searchMs: number;
}

/** Resolves `--project`: a uuid is an id, anything else a name. */
async function findProject(db: Db, nameOrId: string): Promise<ProjectRow> {
  const project = UUID_RE.test(nameOrId) ? await getProjectById(db, nameOrId) : await getProjectByName(db, nameOrId);
  if (!project) throw new Error(`--project: no project named or identified ${JSON.stringify(nameOrId)}`);
  return project;
}

/**
 * Asks a project's **stored** question set of that project's **live** index, through the same
 * `searchProject` and the same scoring as the corpus run.
 *
 * What it refuses, because each would produce a number nobody could stand behind: a project with no
 * questions; one with nothing indexed; one indexed by a model this instance does not run (the vectors
 * would be compared across models); and a project none of whose questions can be asked.
 *
 * **A question whose `expectFile` is not a document of the live generation is skipped, and said so**
 * ([ADR-0124](../.ssot/ADR.md#adr-0124)): asked, it would score zero for ever and read as a retrieval
 * failure, and refusing the run for it would blind the measurement of every other question until a person
 * edited the set. It leaves the denominator, as it does in the server's own run, so the two figures stay one
 * number. `strict` keeps `0.4.0`'s refusal, for an operator who wants a stale set to stop the run.
 *
 * `negative` is passed in by the caller and asked through the same loop as the corpus run's — a separate
 * list, a separate type, never merged into the project's questions (ADR-0045).
 */
export async function measureProject(
  db: Db,
  config: Config,
  embeddings: EmbeddingProvider,
  reranker: Reranker | null,
  nameOrId: string,
  negative: readonly NegativeRow[],
  options: { strict?: boolean } = {},
): Promise<ProjectMeasurement> {
  const project = await findProject(db, nameOrId);
  if (project.chunkCount === 0) throw new Error(`Project ${project.name} has nothing indexed, so there is nothing to ask`);
  if (project.embeddingModel !== embeddings.id) {
    throw new Error(
      `Project ${project.name} was indexed with ${project.embeddingModel ?? 'no model'} and this instance runs ${embeddings.id}; ` +
        "its vectors cannot be compared with this model's queries",
    );
  }

  const rows = await listGoldenQuestions(db, project.id);
  if (rows.length === 0) throw new Error(`Project ${project.name} has no golden questions; add some through the admin API first`);
  const { scorable: golden, skipped } = await partitionByExpectFile(db, project.id, project.liveGeneration, rows.map(toGoldenRow));
  if (skipped.length > 0) {
    const list = skipped.map((r) => `${r.id}: ${r.expectFile}`).join('\n  ');
    if (options.strict) {
      throw new Error(`${skipped.length} of ${rows.length} questions expect a file the project's live index does not hold:\n  ${list}`);
    }
    step(
      `eval: skipping ${skipped.length} of ${rows.length} questions that expect a file the project's live index does not hold (--strict refuses instead):\n  ${list}`,
    );
  }
  if (golden.length === 0)
    throw new Error(`Project ${project.name} has no question that can be asked: every one expects a file its live index does not hold`);

  const refusalFloor = effectiveScoreFloor(config.SEARCH_SCORE_FLOOR, project.scoreFloor);
  const ask = makeAsk({ db, embeddings, config, reranker, projectId: project.id, refusalFloor });

  // ADR-0047 on a live server. The corpus run asserts that `search_queries` is empty; a project's
  // table holds real traffic, so the assertion becomes "this run added nothing" and cannot be
  // exact — an agent searching the same project in the same seconds is indistinguishable from a leak.
  // Reported rather than thrown for that reason.
  const countQueries = async (): Promise<number> => {
    const [row] = await db
      .select({ rows: count() })
      .from(searchQueries)
      .where(and(eq(searchQueries.projectId, project.id)));
    return row.rows;
  };
  const before = await countQueries();
  const asked = await askQuestions(ask, golden, negative);
  const added = (await countQueries()) - before;
  if (added !== 0) {
    step(
      `eval: search_queries grew by ${added} rows for this project while the run was asking. The harness passes no query log sink, ` +
        'so this is real traffic on a live server unless it is a bug (ADR-0047).',
    );
  }
  return { project, golden, skipped, ...asked, refusalFloor };
}

/** The project run: the same questions-and-scoring as the corpus run, against a live project's own index. */
async function runProject(options: Options): Promise<GateVerdict> {
  const startedAt = new Date();
  const totalStart = Date.now();
  const config = loadEvalConfig();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('--project reads the live database: set DATABASE_URL to the server the project lives on');
  const nameOrId = options.project ?? '';

  const negative = await readNegatives(options);
  // No local reranker, whatever `SEARCH_RERANK` says: no search path of the server attaches one, and the server's own runs
  // (ADR-0124) are scored without. A project's figure from here is then the figure the server stores for it. Only the
  // explicit `--rerank-url` measurement arm (K-22) changes that.
  if (config.SEARCH_RERANK === 'on') {
    step(
      options.rerankUrl === null
        ? 'eval: SEARCH_RERANK=on is ignored with --project: the server does not rerank, so neither does this run'
        : `eval: SEARCH_RERANK=on is ignored with --project; this run reranks with the remote reranker of --rerank-url only`,
    );
  }
  const { embeddings, reranker, modelLoadMs } = await warmModels(config, options, false);
  const { db, pool } = createDb(url);
  try {
    const measured = await measureProject(db, config, embeddings, reranker, nameOrId, negative, { strict: options.strict });
    await reportRerankLatency(reranker, options);
    const scan = scanFrom(config);
    const selection = selectionFrom(config);
    const context: RunContext = {
      commit: commitDescription(),
      subject:
        `project ${measured.project.name} + its ${measured.golden.length} stored questions` +
        (measured.skipped.length > 0 ? ` (${measured.skipped.length} skipped: file not in the live index)` : ''),
      providerId: embeddings.id,
      embeddingModel: embeddings.model,
      embeddingDtype: config.EMBEDDING_DTYPE,
      dimensions: embeddings.dimensions,
      chunkMaxTokens: config.CHUNK_MAX_TOKENS,
      chunkOverlapTokens: config.CHUNK_OVERLAP_TOKENS,
      searchLimit: SEARCH_LIMIT,
      hnswScan: `ef_search=${scan.efSearch}, iterative_scan=${scan.iterativeScan}, max_scan_tuples=${scan.maxScanTuples}`,
      // The project was indexed before this run, source by source, each with the configuration its
      // operator set (ADR-0064); the query side reads the index to learn them.
      textSearchConfig: 'as indexed, per source',
      resultSelection:
        `max_per_document=${selection.maxPerDocument}, neighbor_context=${selection.neighborContext}, ` + `score_floor=${measured.refusalFloor}`,
      rerank: describeRerank(reranker, config),
      documents: measured.project.documentCount,
      chunks: measured.project.chunkCount,
      startedAt: startedAt.toISOString(),
      totalMs: Date.now() - totalStart,
      modelLoadMs,
      indexMs: 0,
      searchMs: measured.searchMs,
    };
    return await emitReport(options, measured.results, measured.negativeResults, context, measured.refusalFloor, negative.length > 0);
  } finally {
    await pool.end().catch((err: unknown) => step(`eval: could not close the database pool: ${String(err)}`));
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let verdict: GateVerdict;
  try {
    verdict = await run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    // A failure here is the harness refusing to report a number it cannot stand behind, so it is loud
    // and it is non-zero — and it is a *different* non-zero from the one below.
    process.stderr.write(`\neval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if (!verdict.passed) {
    // Repeated on stderr rather than left in the report: a `--json > file` run prints no text report
    // at all, and a CI log that says only "exit 2" is a gate somebody disables instead of reading.
    process.stderr.write(`\neval: the retrieval gate failed.\n${verdict.lines.map((line) => `  ${line}\n`).join('')}`);
    process.stderr.write('The floors are in eval/BASELINE.md, with the commit they were measured at (ADR-0044).\n');
    process.exit(2);
  }
  process.exit(0);
}
