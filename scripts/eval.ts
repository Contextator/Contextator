import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';

import { loadConfig, type Config } from '../src/config.js';
import type { Logger } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { projects, searchQueries } from '../src/db/schema.js';
import { chunkReserveTokens } from '../src/services/chunk-budget.js';
import { chunkMarkdown, embeddingText } from '../src/services/chunker.js';
import { createEmbeddingProvider, type EmbeddingProvider } from '../src/services/embeddings/index.js';
import { extractDocument } from '../src/services/doc-types/index.js';
import { createReranker } from '../src/services/reranker.js';
import { readAndHash } from '../src/services/fs-scan.js';
import { belowRelevanceFloor } from '../src/services/relevance.js';
import { searchProject } from '../src/services/search.js';
import { isTextSearchConfig, QUERY_TEXT_SEARCH_CONFIG, TEXT_SEARCH_CONFIGS, type TextSearchConfig } from '../src/services/text-search.js';
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
  type NegativeResult,
  type RowResult,
  type RunContext,
  type ScoredHit,
} from './eval-scoring.js';

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
const CORPUS_DIR = path.join(REPO_ROOT, 'eval', 'corpus');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval', 'golden.jsonl');
const NEGATIVE_PATH = path.join(REPO_ROOT, 'eval', 'negative.jsonl');

/**
 * Ten rather than the product's default five. `recall@5` is the headline and needs only five, but a
 * miss is far more informative when the report can say "rank 8" instead of "not found", and `MRR` over
 * a window of five is mostly a restatement of `recall@5`.
 */
const SEARCH_LIMIT = 10;

const PROJECT_NAME = 'eval';

/**
 * Which PostgreSQL text search configuration the lexical half runs in, on **both** sides — the corpus
 * is indexed with it and the questions are parsed with it ([ADR-0041](../.ssot/ADR.md#adr-0041)).
 *
 * A harness knob, like `EVAL_DATABASE_URL`, and deliberately not a product setting: the recommendation
 * is `simple` and the evidence for it is this variable being swept, not a paragraph. Running the two
 * sides in different configurations would measure nothing at all, which is why there is one variable
 * and not two.
 */
function evalTextSearchConfig(): TextSearchConfig {
  const value = process.env.EVAL_TEXT_SEARCH_CONFIG;
  if (value === undefined || value === '') return QUERY_TEXT_SEARCH_CONFIG;
  if (!isTextSearchConfig(value)) {
    throw new Error(`EVAL_TEXT_SEARCH_CONFIG=${JSON.stringify(value)} is not one of: ${TEXT_SEARCH_CONFIGS.join(', ')}`);
  }
  return value;
}

interface OutputTarget {
  format: 'text' | 'json' | 'markdown';
  /** `null` means stdout. */
  file: string | null;
}

interface Options {
  outputs: OutputTarget[];
  floors: Floors;
}

const USAGE = `Usage: npm run eval [-- <options>]

  --markdown[=<file>]      Markdown tables. With a file, written there and the text report still prints.
  --json[=<file>]          The same numbers as JSON, same rule about the file.
  --min-recall5=<0..1>     Fail the run when recall@5 is below this. The shipped floor is in eval/BASELINE.md.
  --min-heading5=<0..1>    The same for heading@5 — the right chunk of the right file, not just the file.
  -h, --help               This.

  With a floor, a completed run whose numbers are short exits 2; without one it exits 0 whatever it
  finds. A harness failure — a malformed question, a skipped corpus file — is exit 1 either way, and
  the two are different codes on purpose: "retrieval got worse" and "this run measured nothing" are
  not the same news.

  EVAL_DATABASE_URL, or DATABASE_URL, points at a PostgreSQL to carve a throwaway database out of.
  With neither, a pgvector container is started for the run and stopped at the end.
  EVAL_TEXT_SEARCH_CONFIG names the text search configuration the lexical half indexes and queries
  with, on both sides. Default "simple"; "english" is the comparison ADR-0041 was decided on.
  SEARCH_MAX_PER_DOCUMENT, SEARCH_NEIGHBOR_CONTEXT and SEARCH_SCORE_FLOOR are read from the
  environment like every other setting, so measuring what the cap or the floor costs is running this
  twice with one of them changed rather than a flag this file has to grow.

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

function parseArgs(argv: readonly string[]): Options {
  const outputs: OutputTarget[] = [];
  const floors: Floors = { ...NO_FLOORS };
  let quietText = false;

  for (const arg of argv) {
    const [flag, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--markdown':
      case '--json': {
        const format = flag === '--json' ? 'json' : 'markdown';
        outputs.push({ format, file: value });
        // Without a path the chosen format replaces the human report on stdout; with one it is written
        // to the file and the text report still goes to the terminal, which is what CI wants.
        if (value === null) quietText = true;
        break;
      }
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

  if (!quietText) outputs.unshift({ format: 'text', file: null });
  return { outputs, floors };
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

/** Every `.md` under `eval/corpus/`, as posix paths relative to it, sorted so a run is reproducible. */
async function corpusFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(path.relative(CORPUS_DIR, absolute).split(path.sep).join('/'));
      }
    }
  };
  await walk(CORPUS_DIR);
  return found.sort();
}

interface IndexOutcome {
  documents: number;
  chunks: number;
}

async function indexCorpus(
  db: Db,
  embeddings: EmbeddingProvider,
  config: Config,
  projectId: string,
  generation: number,
  files: readonly string[],
  textSearchConfig: TextSearchConfig,
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
    const { bytes, hash, sizeBytes } = await readAndHash(path.join(CORPUS_DIR, relativePath));
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
      textSearchConfig,
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

async function run(options: Options): Promise<GateVerdict> {
  const startedAt = new Date();
  const totalStart = Date.now();
  const config = loadEvalConfig();
  const textSearchConfig = evalTextSearchConfig();

  const files = await corpusFiles();
  const golden = parseGoldenSet(await fs.readFile(GOLDEN_PATH, 'utf8'), new Set(files));
  // Two files, two parsers, two types. The negative set is never merged into `golden` anywhere below
  // — that is what keeps it out of every denominator in the report (ADR-0045).
  const negative = parseNegativeSet(await fs.readFile(NEGATIVE_PATH, 'utf8'));
  step(`eval: ${files.length} corpus files, ${golden.length} questions, ${negative.length} negative questions`);

  const embeddings = createEmbeddingProvider(config, evalLogger);
  step(`eval: loading ${embeddings.id} (a first run downloads it, which takes minutes)`);
  const modelStart = Date.now();
  await embeddings.warmup();
  const modelLoadMs = Date.now() - modelStart;

  // The second model, and only when an operator asked for one (ROADMAP.md Item 12). It is warmed up
  // here rather than on the first question so that its load does not land inside `searchMs` and read
  // as latency every search pays.
  const reranker = createReranker(config, evalLogger);
  if (reranker) {
    step(`eval: loading ${reranker.id} (a first run downloads it, which takes minutes)`);
    await reranker.warmup();
  }

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

    step('eval: indexing the corpus');
    const indexStart = Date.now();
    const indexed = await indexCorpus(db, embeddings, config, project.id, project.liveGeneration, files, textSearchConfig);
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

    const scan = scanFrom(config);
    // The server's own result selection as well as its own scan settings, for the same reason and with
    // the same risk: SEARCH_MAX_PER_DOCUMENT changes `recall@5` by a question, so a harness that
    // hard-coded either would measure a product nobody runs (ADR-0042).
    const selection = selectionFrom(config);
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
     * something nobody runs, which is the mistake this whole file exists to avoid.
     */
    const ask = async (id: string, query: string): Promise<{ hits: ScoredHit[]; refused: boolean }> => {
      const outcome = await searchProject(
        { db, embeddings, scan, textSearchConfig, selection, scoreFloor: 0, rerank: reranker ?? undefined },
        { projectId: project.id, query, limit: SEARCH_LIMIT },
      );
      if (outcome.status !== 'ok') {
        throw new Error(`Question ${id} could not be scored: searchProject answered ${outcome.status}`);
      }
      return {
        hits: outcome.hits.map((hit) => ({ file: hit.file, headingPath: hit.headingPath, score: hit.score })),
        refused: belowRelevanceFloor(query, outcome.hits, config.SEARCH_SCORE_FLOOR),
      };
    };

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

    step(`eval: asking ${negative.length} questions the corpus cannot answer`);
    const negativeResults: NegativeResult[] = [];
    for (const row of negative) {
      const { hits, refused } = await ask(row.id, row.query);
      negativeResults.push(scoreNegativeRow(row, hits, refused));
    }
    const searchMs = Date.now() - searchStart;

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

    const context: RunContext = {
      commit: commitDescription(),
      providerId: embeddings.id,
      embeddingModel: embeddings.model,
      embeddingDtype: config.EMBEDDING_DTYPE,
      dimensions: embeddings.dimensions,
      chunkMaxTokens: config.CHUNK_MAX_TOKENS,
      chunkOverlapTokens: config.CHUNK_OVERLAP_TOKENS,
      searchLimit: SEARCH_LIMIT,
      hnswScan: `ef_search=${scan.efSearch}, iterative_scan=${scan.iterativeScan}, max_scan_tuples=${scan.maxScanTuples}`,
      textSearchConfig,
      resultSelection:
        `max_per_document=${selection.maxPerDocument}, neighbor_context=${selection.neighborContext}, ` + `score_floor=${config.SEARCH_SCORE_FLOOR}`,
      rerank: reranker ? `${reranker.id}, max_tokens=${config.SEARCH_RERANK_MAX_TOKENS}, batch=${config.SEARCH_RERANK_BATCH}` : 'off',
      documents: indexed.documents,
      chunks: indexed.chunks,
      startedAt: startedAt.toISOString(),
      totalMs: Date.now() - totalStart,
      modelLoadMs,
      indexMs,
      searchMs,
    };

    // The negative results reach the report here and only here — as their own argument, never merged
    // into `results` (ADR-0045). `test/eval-scoring.test.ts` asserts what that buys: the golden
    // denominators are the same number with the negative set loaded and without it.
    const report = buildReport(results, context, options.floors, buildRefusalReport(results, negativeResults, config.SEARCH_SCORE_FLOOR));
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
  } finally {
    if (database) await dropTestDatabase(baseUrl, database).catch((err: unknown) => step(`eval: could not drop the database: ${String(err)}`));
    if (container) await container.stop().catch((err: unknown) => step(`eval: could not stop the container: ${String(err)}`));
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
