import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { loadConfig, type Config } from '../src/config.js';
import type { Logger } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { projects } from '../src/db/schema.js';
import { chunkReserveTokens } from '../src/services/chunk-budget.js';
import { chunkMarkdown, embeddingText } from '../src/services/chunker.js';
import type { EmbeddingProvider } from '../src/services/embeddings/index.js';
import { extractDocument } from '../src/services/doc-types/index.js';
import type { Reranker } from '../src/services/reranker.js';
import { searchProject } from '../src/services/search.js';
import { replaceDocument, scanFrom, selectionFrom, storedDocumentContent, type NewChunk, type SearchHit } from '../src/services/vector-store.js';
import type { TextSearchConfig } from '../src/services/text-search.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  startPostgres,
  type RunningPostgres,
  type TestDatabase,
} from '../test/integration/support/postgres.js';
import { GoldenRowSchema, NegativeRowSchema, type GoldenRow, type NegativeRow } from './eval-scoring.js';

/**
 * The corpora the measurements beside `npm run eval` read, and the one indexing loop they share.
 *
 * `scripts/eval.ts` indexes one corpus from one directory and is the gate; nothing in this file is
 * imported by it, so nothing here can move a number that gate reads. What lives here is for the
 * questions `eval.ts` was never built to ask: how the scores of the same model are spread over a
 * corpus of a **different shape** (`scripts/floor-calibration.ts`), and what retrieval measures on an
 * external, openly licensed set kept apart from the golden one (`scripts/eval-external.ts`).
 *
 * **The indexing loop is `eval.ts`'s, which is the indexer's.** `extractDocument` → `chunkMarkdown`
 * with the embedder's own token counter and reserve → `embeddingText` → `embedPassages` in batches of
 * `EMBEDDING_BATCH_SIZE` → `replaceDocument` with a per-file text search configuration. It is written
 * out a second time rather than exported from `eval.ts` so that the gate's file does not change for a
 * measurement that only sits beside it; `floor-calibration.ts` re-measures the golden set's top-hit
 * band through this copy and prints it next to the band `eval/BASELINE.md` records, which is the check
 * that the two loops still agree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const EVAL_DIR = path.join(REPO_ROOT, 'eval');

/** One file of a corpus, held in memory: a directory walk and a generated corpus look the same here. */
export interface CorpusDocument {
  relativePath: string;
  bytes: Buffer;
}

export interface IndexOutcome {
  documents: number;
  chunks: number;
}

export const step = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** Errors on stderr, everything else dropped — the shape `eval.ts`'s logger has, without its model chatter. */
export const quietLogger: Logger = {
  level: 'warn',
  fatal: (...args: unknown[]) => step(`  ! ${JSON.stringify(args[0])}`),
  error: (...args: unknown[]) => step(`  ! ${JSON.stringify(args[0])}`),
  warn: (...args: unknown[]) => step(`  ~ ${JSON.stringify(args[0])}`),
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => quietLogger,
};

/** The server's configuration, with a database URL filled in when none is set — as `eval.ts` does. */
export function loadHarnessConfig(): Config {
  const url = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://eval:eval@127.0.0.1:5432/eval';
  return loadConfig({ ...process.env, DATABASE_URL: url });
}

/** Every `.md` file under `dir`, as `eval.ts` walks its corpus, sorted so a run is reproducible. */
export async function loadDirectory(dir: string): Promise<CorpusDocument[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(path.relative(dir, absolute).split(path.sep).join('/'));
      }
    }
  };
  await walk(dir);
  found.sort();
  return Promise.all(found.map(async (relativePath) => ({ relativePath, bytes: await fs.readFile(path.join(dir, relativePath)) })));
}

/**
 * The indexer's loop over `docs`, into `projectId` at `generation`, then the four project columns
 * `searchProject` checks before it will search at all.
 */
export async function indexDocuments(
  db: Db,
  embeddings: EmbeddingProvider,
  config: Config,
  projectId: string,
  generation: number,
  docs: readonly CorpusDocument[],
  textSearchConfigFor: (relativePath: string) => TextSearchConfig,
): Promise<IndexOutcome> {
  const reserveTokens = chunkReserveTokens(embeddings);
  let chunkCount = 0;
  const skipped: string[] = [];

  for (const doc of docs) {
    const content = await extractDocument(doc.relativePath, doc.bytes, {
      maxFileBytes: config.MAX_CONVERTED_FILE_BYTES,
      maxPdfPages: config.MAX_PDF_PAGES,
      maxUnpackedBytes: config.MAX_DOCX_UNPACKED_BYTES,
    });
    const { title, chunks } = chunkMarkdown(content, doc.relativePath, {
      maxTokens: config.CHUNK_MAX_TOKENS,
      overlapTokens: config.CHUNK_OVERLAP_TOKENS,
      countTokens: (text: string) => embeddings.countTokens(text),
      reserveTokens,
    });
    if (chunks.length === 0) {
      skipped.push(doc.relativePath);
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
        relativePath: doc.relativePath,
        title,
        contentHash: createHash('sha256').update(doc.bytes).digest('hex'),
        sizeBytes: doc.bytes.byteLength,
        indexGeneration: generation,
        version: '',
        ...storedDocumentContent(content, config.MAX_STORED_DOCUMENT_BYTES),
      },
      rows,
      textSearchConfigFor(doc.relativePath),
    );
    chunkCount += rows.length;
  }

  // A corpus that silently lost a file measures a smaller corpus than it names, which is the one
  // failure a distribution cannot show. Refused loudly, as `eval.ts` refuses it.
  if (skipped.length > 0) {
    throw new Error(`Indexing produced no chunks for ${skipped.length} of ${docs.length} files: ${skipped.join(', ')}`);
  }

  await db
    .update(projects)
    .set({ chunkCount, documentCount: docs.length, embeddingModel: embeddings.id, lastIndexedAt: new Date() })
    .where(eq(projects.id, projectId));
  return { documents: docs.length, chunks: chunkCount };
}

/**
 * A pgvector server to carve databases out of: the one `EVAL_DATABASE_URL` names, or a container
 * started here and stopped by `close`. Every database this hands out is dropped by `close` too.
 */
export interface DatabaseServer {
  /** A fresh database with the schema applied, holding one empty project named `name`. */
  project(name: string): Promise<{ db: Db; projectId: string; generation: number }>;
  close(): Promise<void>;
}

export async function openDatabaseServer(config: Config, label: string): Promise<DatabaseServer> {
  const provided = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL;
  let container: RunningPostgres | null = null;
  if (!provided) {
    step(`${label}: starting a pgvector container (set EVAL_DATABASE_URL to use a server you already have)`);
    container = await startPostgres();
  }
  const baseUrl = provided ?? (container as RunningPostgres).baseUrl;
  const databases: TestDatabase[] = [];

  return {
    async project(name) {
      // One database per corpus: the instance-wide HNSW index is shared between projects, and a
      // measurement of one corpus's scores must not depend on which other corpus was indexed beside it.
      const database = await createTestDatabase(baseUrl, `contextator_${label}_${name}_${Date.now().toString(36)}`.replace(/[^a-z0-9_]/g, '_'));
      databases.push(database);
      await applySchema(database, config.EMBEDDING_DIMENSIONS);
      const [project] = await database.db.insert(projects).values({ name }).returning({ id: projects.id, liveGeneration: projects.liveGeneration });
      return { db: database.db, projectId: project.id, generation: project.liveGeneration };
    },
    async close() {
      for (const database of databases) {
        await dropTestDatabase(baseUrl, database).catch((err: unknown) => step(`${label}: could not drop a database: ${String(err)}`));
      }
      if (container) await container.stop().catch((err: unknown) => step(`${label}: could not stop the container: ${String(err)}`));
    },
  };
}

/** `eval.ts`'s page size: every figure these harnesses print is about the same ten hits it scores. */
export const SEARCH_LIMIT = 10;

/**
 * One question through `searchProject` — the product's one search path — with the server's own scan
 * and selection settings and the relevance floor **off**, returning the hits as the product has them.
 * The floor changes no hit and no score, so the callers decide refusals themselves with
 * `belowRelevanceFloor` at whatever floor they are measuring, exactly as `eval.ts` does.
 */
export function makeAsk(
  db: Db,
  embeddings: EmbeddingProvider,
  config: Config,
  projectId: string,
  reranker: Reranker | null,
): (id: string, query: string) => Promise<SearchHit[]> {
  const scan = scanFrom(config);
  const selection = selectionFrom(config);
  return async (id, query) => {
    const outcome = await searchProject(
      { db, embeddings, scan, selection, scoreFloor: 0, rerank: reranker ?? undefined },
      { projectId, query, limit: SEARCH_LIMIT },
    );
    if (outcome.status !== 'ok') throw new Error(`Question ${id} could not be scored: searchProject answered ${outcome.status}`);
    return outcome.hits;
  };
}

// ---------------------------------------------------------------------------------------------------
// XQuAD — the external set (eval/external/xquad/README.md)
// ---------------------------------------------------------------------------------------------------

export const XQUAD_DIR = path.join(EVAL_DIR, 'external', 'xquad');
export const XQUAD_LANGUAGES = ['tr', 'en'] as const;
export type XquadLanguage = (typeof XQUAD_LANGUAGES)[number];

/**
 * The bytes the files were downloaded as, from google-deepmind/xquad at `7d30520`. Checked on every
 * load: the set is kept **unmodified** — that is the licence's easiest condition to keep and the only
 * way a number measured here stays comparable with the next one — and a file that was reformatted,
 * re-encoded or trimmed would otherwise still parse and quietly measure something else.
 */
export const XQUAD_SHA256: Readonly<Record<XquadLanguage, string>> = {
  tr: '92179a564774b7696100d144c1e10870d0a966b6fccbdd254a65b9d2ab1971cc',
  en: 'e4c57d1c9143aaa1c5d265ba5987a65f4e69528d2a98f29d6e75019b10344f29',
};

const XquadSchema = z.object({
  data: z.array(
    z.object({
      title: z.string().min(1),
      paragraphs: z.array(
        z.object({
          context: z.string().min(1),
          qas: z.array(z.object({ id: z.string().min(1), question: z.string().min(1) })),
        }),
      ),
    }),
  ),
});

export interface XquadSet {
  lang: XquadLanguage;
  documents: CorpusDocument[];
  questions: GoldenRow[];
  paragraphs: number;
}

/** `Victoria_(Australia)` → `Victoria-Australia`: a file name every filesystem and every URL can hold. */
export function xquadSlug(title: string): string {
  return title
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * One Markdown document per article, one `##` section per paragraph, numbered in the file's order.
 *
 * The section heading is the paragraph's number and nothing else, on purpose: `embeddingText` puts
 * the breadcrumb in front of every chunk, and a heading with words in it would be a second, invented
 * signal for the question to match. A number carries none, so `heading@5` here means "the paragraph
 * the answer was taken from" and nothing easier. The article title is XQuAD's own, which is English in
 * every language of the set — recorded rather than translated, because translating it is editing it.
 */
export function xquadToCorpus(lang: XquadLanguage, raw: string): XquadSet {
  const parsed = XquadSchema.parse(JSON.parse(raw));
  const documents: CorpusDocument[] = [];
  const questions: GoldenRow[] = [];
  let paragraphs = 0;
  const seen = new Set<string>();

  for (const article of parsed.data) {
    const slug = xquadSlug(article.title);
    const relativePath = `${lang}/${slug}.md`;
    if (seen.has(relativePath)) throw new Error(`XQuAD ${lang}: two articles map to ${relativePath}`);
    seen.add(relativePath);

    const title = article.title.replace(/_/g, ' ');
    const sections = article.paragraphs.map((paragraph, i) => {
      // The Turkish file opens with a byte-order mark inside its first context string.
      const text = paragraph.context.replace(/^﻿/, '').trim();
      for (const qa of paragraph.qas) {
        questions.push(
          GoldenRowSchema.parse({
            id: `xq-${lang}-${qa.id.toLowerCase()}`,
            lang,
            query: qa.question.replace(/^﻿/, '').trim(),
            expectFile: relativePath,
            expectHeading: String(i + 1),
            tags: [slug.toLowerCase()],
          }),
        );
      }
      paragraphs += 1;
      return `## ${i + 1}\n\n${text}\n`;
    });
    documents.push({ relativePath, bytes: Buffer.from(`# ${title}\n\n${sections.join('\n')}`, 'utf8') });
  }
  return { lang, documents, questions, paragraphs };
}

export async function loadXquad(lang: XquadLanguage): Promise<XquadSet> {
  const bytes = await fs.readFile(path.join(XQUAD_DIR, `xquad.${lang}.json`));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== XQUAD_SHA256[lang]) {
    throw new Error(
      `eval/external/xquad/xquad.${lang}.json is not the file that was downloaded (sha256 ${sha}, expected ${XQUAD_SHA256[lang]}). ` +
        'The set is kept unmodified; see eval/external/xquad/README.md.',
    );
  }
  return xquadToCorpus(lang, bytes.toString('utf8'));
}

// ---------------------------------------------------------------------------------------------------
// Probe files that mix answerable and unanswerable rows
// ---------------------------------------------------------------------------------------------------

export interface ProbeSet {
  answerable: GoldenRow[];
  negative: NegativeRow[];
}

/**
 * A JSONL file whose rows are either the golden shape or the negative shape, told apart by `kind`.
 * Every `expectFile` has to be a file of the corpus it is asked against — the same rule
 * `parseGoldenSet` enforces, for the same reason: a typo there would read as a miss.
 */
export function parseProbeSet(text: string, corpusFiles: ReadonlySet<string>): ProbeSet {
  const answerable: GoldenRow[] = [];
  const negative: NegativeRow[] = [];
  const ids = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const value: unknown = JSON.parse(line);
    const isNegative = typeof value === 'object' && value !== null && 'kind' in value;
    const row = isNegative ? NegativeRowSchema.parse(value) : GoldenRowSchema.parse(value);
    if (ids.has(row.id)) throw new Error(`line ${i + 1}: duplicate id ${row.id}`);
    ids.add(row.id);
    if ('kind' in row) negative.push(row);
    else {
      if (!corpusFiles.has(row.expectFile)) throw new Error(`line ${i + 1}: ${row.expectFile} is not a file of the corpus`);
      answerable.push(row);
    }
  });
  return { answerable, negative };
}
