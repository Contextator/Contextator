import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

import { CHUNK_TOKENIZER_RESERVE_TOKENS, loadConfig, type Config } from '../src/config.js';
import type { Logger } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { projects } from '../src/db/schema.js';
import { chunkMarkdown, embeddingText } from '../src/services/chunker.js';
import { createEmbeddingProvider, type EmbeddingProvider } from '../src/services/embeddings/index.js';
import { readAndHash } from '../src/services/fs-scan.js';
import { searchProject } from '../src/services/search.js';
import { getExistingDocuments, replaceDocument, type NewChunk } from '../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  startPostgres,
  type RunningPostgres,
  type TestDatabase,
} from '../test/integration/support/postgres.js';
import { buildReport, formatMarkdown, formatText, parseGoldenSet, scoreRow, type RowResult, type RunContext } from './eval-scoring.js';

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
 * **The indexing loop is the indexer's, lifted.** `chunkMarkdown` → `embeddingText` → `embed` →
 * `replaceDocument`, in batches of `EMBEDDING_BATCH_SIZE`, exactly as `services/indexer.ts` does it —
 * including the token counter and the reserve it hands the chunker (ADR-0036).
 * What is left out is only what a corpus already sitting in the repository does not need: the source
 * drivers, the filesystem walk and the `document_sources` rows. `embeddingText` is imported rather than
 * re-derived — a harness that embedded a differently-assembled string would produce numbers that are
 * wrong and entirely plausible.
 *
 * **A run that skipped a file fails.** Phase 1's first three changes each touch chunking or the model,
 * and a run that silently measured chunks written by the previous configuration is the worst kind of
 * defect this could have: wrong, and believable.
 *
 * It exits 0 whatever it finds. This is a report, not a gate; `--min-recall5` is accepted now so that
 * Phase 1 turns it on rather than having to plumb it first.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval', 'corpus');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval', 'golden.jsonl');

/**
 * Ten rather than the product's default five. `recall@5` is the headline and needs only five, but a
 * miss is far more informative when the report can say "rank 8" instead of "not found", and `MRR` over
 * a window of five is mostly a restatement of `recall@5`.
 */
const SEARCH_LIMIT = 10;

const PROJECT_NAME = 'eval';

interface OutputTarget {
  format: 'text' | 'json' | 'markdown';
  /** `null` means stdout. */
  file: string | null;
}

interface Options {
  outputs: OutputTarget[];
  minRecall5: number | null;
}

const USAGE = `Usage: npm run eval [-- <options>]

  --markdown[=<file>]      Markdown tables. With a file, written there and the text report still prints.
  --json[=<file>]          The same numbers as JSON, same rule about the file.
  --min-recall5=<0..1>     Compare recall@5 against a floor and say so. Not enforced in this phase.
  -h, --help               This.

  EVAL_DATABASE_URL, or DATABASE_URL, points at a PostgreSQL to carve a throwaway database out of.
  With neither, a pgvector container is started for the run and stopped at the end.
`;

function parseArgs(argv: readonly string[]): Options {
  const outputs: OutputTarget[] = [];
  let minRecall5: number | null = null;
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
      case '--min-recall5': {
        const parsed = Number(value);
        if (value === null || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error('--min-recall5 takes a number between 0 and 1, e.g. --min-recall5=0.45');
        }
        minRecall5 = parsed;
        break;
      }
      default:
        throw new Error(`Unknown option ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
  }

  if (!quietText) outputs.unshift({ format: 'text', file: null });
  return { outputs, minRecall5 };
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
  files: readonly string[],
): Promise<IndexOutcome> {
  // A fresh database cannot hold a previous run's documents, so this map is expected to be empty. It is
  // read anyway: the guard below is what makes "unchanged, skipped" impossible to reach silently, and a
  // guard that only works because of an assumption elsewhere is a guard that stops working quietly.
  const existing = await getExistingDocuments(db, projectId);
  const skipped: string[] = [];
  let chunkCount = 0;

  for (const relativePath of files) {
    const { content, hash, sizeBytes } = await readAndHash(path.join(CORPUS_DIR, relativePath));
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
      // The indexer's own two arguments (ADR-0036). A harness that counted tokens differently from the
      // product would sweep `CHUNK_MAX_TOKENS` over chunks the product never produces.
      countTokens: (text: string) => embeddings.countTokens(text),
      reserveTokens: CHUNK_TOKENIZER_RESERVE_TOKENS,
    });
    if (chunks.length === 0) {
      skipped.push(`${relativePath} (produced no chunks)`);
      continue;
    }

    const rows: NewChunk[] = [];
    for (let i = 0; i < chunks.length; i += config.EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + config.EMBEDDING_BATCH_SIZE);
      const vectors = await embeddings.embed(batch.map(embeddingText));
      batch.forEach((c, j) => {
        rows.push({ chunkIndex: c.index, headingPath: c.headingPath, content: c.content, tokenCount: c.tokenCount, embedding: vectors[j] });
      });
    }

    await replaceDocument(db, { projectId, sourceId: null, relativePath, title, contentHash: hash, sizeBytes }, rows);
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

async function run(options: Options): Promise<void> {
  const startedAt = new Date();
  const totalStart = Date.now();
  const config = loadEvalConfig();

  const files = await corpusFiles();
  const golden = parseGoldenSet(await fs.readFile(GOLDEN_PATH, 'utf8'), new Set(files));
  step(`eval: ${files.length} corpus files, ${golden.length} questions`);

  const embeddings = createEmbeddingProvider(config, evalLogger);
  step(`eval: loading ${embeddings.id} (a first run downloads it, which takes minutes)`);
  const modelStart = Date.now();
  await embeddings.warmup();
  const modelLoadMs = Date.now() - modelStart;

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

    const [project] = await db.insert(projects).values({ name: PROJECT_NAME }).returning({ id: projects.id });

    step('eval: indexing the corpus');
    const indexStart = Date.now();
    const indexed = await indexCorpus(db, embeddings, config, project.id, files);
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

    step(`eval: asking ${golden.length} questions`);
    const searchStart = Date.now();
    const results: RowResult[] = [];
    for (const row of golden) {
      const outcome = await searchProject({ db, embeddings }, { projectId: project.id, query: row.query, limit: SEARCH_LIMIT });
      if (outcome.status !== 'ok') {
        throw new Error(`Question ${row.id} could not be scored: searchProject answered ${outcome.status}`);
      }
      results.push(
        scoreRow(
          row,
          outcome.hits.map((hit) => ({ file: hit.file, headingPath: hit.headingPath, score: hit.score })),
        ),
      );
    }
    const searchMs = Date.now() - searchStart;

    const context: RunContext = {
      commit: commitDescription(),
      providerId: embeddings.id,
      embeddingModel: embeddings.model,
      embeddingDtype: config.EMBEDDING_DTYPE,
      dimensions: embeddings.dimensions,
      chunkMaxTokens: config.CHUNK_MAX_TOKENS,
      chunkOverlapTokens: config.CHUNK_OVERLAP_TOKENS,
      searchLimit: SEARCH_LIMIT,
      documents: indexed.documents,
      chunks: indexed.chunks,
      startedAt: startedAt.toISOString(),
      totalMs: Date.now() - totalStart,
      modelLoadMs,
      indexMs,
      searchMs,
    };

    const report = buildReport(results, context, options.minRecall5);
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
  } finally {
    if (database) await dropTestDatabase(baseUrl, database).catch((err: unknown) => step(`eval: could not drop the database: ${String(err)}`));
    if (container) await container.stop().catch((err: unknown) => step(`eval: could not stop the container: ${String(err)}`));
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    // A failure here is the harness refusing to report a number it cannot stand behind, so it is loud
    // and it is non-zero. The metrics themselves never fail the run in this phase.
    process.stderr.write(`\neval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  process.exit(0);
}
