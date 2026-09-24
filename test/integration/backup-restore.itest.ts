import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { gunzipSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { describeTopology, secretKeyFingerprint, type Manifest as BackupManifest, type PgTool, type PgTools } from '../../scripts/backup-archive.js';
import { runBackup } from '../../scripts/backup.js';
import { runRestore, type RestoreDeps } from '../../scripts/restore.js';
import { loadConfig, MAX_SEARCH_LIMIT } from '../../src/config.js';
import { MIGRATIONS_FOLDER } from '../../src/db/bootstrap.js';
import { documentSources, projects, type ProjectRow } from '../../src/db/schema.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../src/services/chunker.js';
import { decryptSecret, encryptSecret, encryptWebhookSecret } from '../../src/services/crypto.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  EXCHANGE_DIR,
  execInPostgresOrThrow,
  silentLogger,
  TEST_EMBEDDING_DIMENSIONS,
  type TestDatabase,
} from './support/postgres.js';
import { captureSchema, renderSchemaSnapshot, type SchemaSnapshot } from './support/schema-snapshot.js';

/**
 * "Can I get this database back" — asked of a real `pg_dump`, a real `pg_restore` and the product's own
 * read path ([ADR-0046](../../../.ssot/ADR.md#adr-0046), NFR-19).
 *
 * [OPERATIONS.md](../../../.ssot/OPERATIONS.md) §4 has documented two commands since the baseline and
 * nothing has ever run them. That is a procedure people will only find out is wrong on the day they
 * need it, which is the day it is least recoverable — so this file is the procedure, executed, with
 * three assertions on the other side of it.
 *
 * **Why a row count is not one of them.** A restore that dropped `chunks_embedding_hnsw_idx` on the
 * floor would still hold every chunk, and so would one that came back with `content_tsv` empty — the
 * first answers searches slowly and exactly, the second answers them with the dense half alone. Both
 * look like a healthy database until somebody compares an answer. So the three things asserted are the
 * catalogue projection, the *answers* (identical rows, identical order, identical scores), and the
 * next start of the application over the restored database.
 *
 * **`pg_dump` and `pg_restore` run inside the container**, through `execInPostgres`, and the dump file
 * never leaves it. The host's copy of those tools is at whatever version the host happens to have, and
 * a backup test that depended on it would be a test of somebody's laptop.
 */

const baseUrl = inject('postgresBaseUrl');
const containerId = inject('postgresContainerId');
/** The host side of the directory the container shares, where the command's archive is written. */
const exchangeDir = inject('postgresExchangeDir');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

/** Every project here is freshly created, so its live generation is the column's default (ADR-0039). */
const LIVE = 0;

/** The database the dump is taken from, dropped, recreated empty and restored into. */
const SUBJECT = 'backup_restore';

/** A second empty database, restored into in two timed pieces to say where the time went. */
const ATTRIBUTION = 'backup_restore_timing';

/** Inside the container, on its own filesystem. Nothing here crosses to the host. */
const DUMP_PATH = '/tmp/contextator-backup-restore.dump';
const TOC_ALL = '/tmp/contextator-backup-restore.toc';
const TOC_HNSW = '/tmp/contextator-backup-restore.hnsw.toc';
const TOC_REST = '/tmp/contextator-backup-restore.rest.toc';

/** The index whose rebuild the measurement below is about. */
const HNSW_INDEX = 'chunks_embedding_hnsw_idx';

/**
 * The corpus, and the reason it is this size rather than a comfortable one.
 *
 * The figures this file exists to produce are **ratios** — how much of a restore is the index rebuild,
 * and how much bigger a custom-format dump is than the binary vectors inside it — and both go wrong at
 * small scale, where fixed costs (connecting, creating twenty tables, the archive header) swamp what is
 * being measured. At 10 048 chunks the HNSW build is 72 % of the restore and the fixed costs are
 * visibly not the answer; that is the same order as `hnsw-scan.itest.ts`'s 21 050 and it costs this
 * file about half a minute. Shrinking it until the file is quick would leave the numbers in
 * [OPERATIONS.md](../../../.ssot/OPERATIONS.md) §4 and §7 describing nothing an operator will ever see.
 *
 * Two projects, not one, because the index does not know about projects: `pg_dump` emits one
 * `CREATE INDEX` over `chunks` and it rebuilds over **every chunk in the instance**. The handbook is
 * the project the search assertions are about; the ledger is the rest of the instance sitting in the
 * same index, which is exactly the shape that makes a restore slower than the project being restored
 * would suggest.
 *
 * **The handbook is 48 chunks and that number is load-bearing.** `searchChunks` takes
 * `DENSE_CANDIDATES` = 50 rows from the dense side with *no tie-break* — deliberately, because a
 * second sort key would make the ordering unsatisfiable by the HNSW index — and ranks them by
 * `(distance, id)` afterwards. Below the cut there is nothing for a tie to decide: every chunk of the
 * project is a candidate, the rank is total, and "identical order" is a claim about the restore rather
 * than about which row the executor happened to reach first. Above it, two chunks the same distance
 * from the question could swap across the cut and the assertion would flicker. A project small enough
 * that the planner sorts it exactly is also what `hnsw-scan.itest.ts` measured the boundary of.
 */
const HANDBOOK_DOCUMENTS = 6;
const HANDBOOK_CHUNKS_PER_DOCUMENT = 8;
const LEDGER_DOCUMENTS = 50;
const LEDGER_CHUNKS_PER_DOCUMENT = 200;
const HANDBOOK_CHUNKS = HANDBOOK_DOCUMENTS * HANDBOOK_CHUNKS_PER_DOCUMENT;
const TOTAL_CHUNKS = HANDBOOK_CHUNKS + LEDGER_DOCUMENTS * LEDGER_CHUNKS_PER_DOCUMENT;

/** Retrieval, not selection: the assertions are about which rows come back and in what order. */
const WHOLE_PAGE = { maxPerDocument: MAX_SEARCH_LIMIT, neighborContext: 1 };

/**
 * Word-hash bag of words, L2-normalised — `search.itest.ts`'s stub, for its property rather than its
 * quality: the same text embeds to the same vector every time, so "identical scores before and after"
 * is a claim about the restore and not about a model.
 */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

/**
 * **The bulk of the corpus carries dense vectors, and the first version of this file did not.**
 *
 * The stub above is a bag of words, so its output is mostly zeros — and a zero is one character in
 * pgvector's text form and compresses to nothing at all. Measured on the sparse fixture, the dump came
 * out at **0.21×** the binary vector footprint, which is not a fact about `pg_dump`: it is a fact about
 * a fixture nobody would deploy. A real embedding is dense, every component is a float printed to its
 * shortest round-trip form, and that is what the size figure in
 * [OPERATIONS.md](../../../.ssot/OPERATIONS.md) §7 has to be measured against.
 *
 * So the ledger — ten thousand of the ten thousand and forty-eight chunks — is seeded with normalised
 * Gaussian vectors, which is the shape an encoder produces and the worst case for both compression and
 * the HNSW build. The handbook keeps the deterministic stub, because the search assertions need the
 * same text to embed to the same vector and forty-eight chunks change no byte count that matters.
 */
function gaussianVector(next: () => number): number[] {
  const v = new Array<number>(DIMS);
  for (let i = 0; i < DIMS; i += 2) {
    const u1 = Math.max(next(), Number.EPSILON);
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    v[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < DIMS) v[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Deterministic PRNG (mulberry32), so the corpus is a description rather than a sample. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The filler vocabulary, and it shares **not one word** with the three questions below. That is what
 * makes the expected answer a property of the corpus rather than of a threshold: exactly one chunk in
 * the handbook contains any of a question's words, on the dense side and on the lexical side alike, so
 * "the right page came first" cannot come out differently on a different machine.
 */
const FILLER = [
  'cluster',
  'latency',
  'threshold',
  'retention',
  'quota',
  'snapshot',
  'replica',
  'partition',
  'vacuum',
  'planner',
  'buffer',
  'checkpoint',
  'autovacuum',
  'extension',
  'catalogue',
  'tuple',
  'heap',
  'locale',
  'collation',
  'timezone',
  'encoding',
  'segment',
  'backend',
  'cursor',
  'portal',
  'sequence',
  'trigger',
  'constraint',
  'namespace',
  'statistics',
];

function prose(next: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(FILLER[Math.floor(next() * FILLER.length)]);
  return `${out.join(' ')}.`;
}

/** The three questions the restore is judged on. Each is answered by one handbook page and no other. */
const QUESTIONS = ['how do I rotate the webhook secret', 'where is an uploaded archive unpacked', 'are pages pulled on every sync'];

/** The first chunk of the first three handbook pages, and the only text in the project that answers. */
const ANSWERS = [
  'Rotate the webhook secret from the source panel. The old secret stops verifying push payloads immediately.',
  'An uploaded archive is unpacked on the server into a staging directory and swapped in when the upload is committed.',
  'Pages shared with an internal integration are pulled on every sync and rendered to Markdown before chunking.',
];

let subject: TestDatabase;
let handbookId: string;
let ledgerId: string;

interface Measurements {
  dumpMs: number;
  dumpBytes: number;
  restoreMs: number;
  restoreEverythingElseMs: number;
  restoreHnswMs: number;
  vectorBytes: number;
  vectorTextBytes: number;
  chunkTextBytes: number;
  documentTextBytes: number;
  tableBytes: number;
  indexBytes: number;
}
let measured: Measurements;

/** Captured before the database is destroyed; every assertion compares against these. */
let schemaBefore: SchemaSnapshot;
let hitsBefore: SearchHit[][];
let journalBefore: Array<{ hash: string; created_at: string }>;
let settingsBefore: Array<{ key: string; value: string }>;

const search = (question: string): Promise<SearchHit[]> =>
  searchChunks(subject.db, {
    projectId: handbookId,
    generation: LIVE,
    queryEmbedding: stubVector(question),
    queryText: question,
    limit: 10,
    selection: WHOLE_PAGE,
  });

async function journalRows(database: TestDatabase): Promise<Array<{ hash: string; created_at: string }>> {
  const result = await database.db.execute(sql`SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`);
  return result.rows as Array<{ hash: string; created_at: string }>;
}

async function settingsRows(database: TestDatabase): Promise<Array<{ key: string; value: string }>> {
  const result = await database.db.execute(sql`SELECT key, value FROM settings ORDER BY key`);
  return result.rows as Array<{ key: string; value: string }>;
}

async function countChunks(database: TestDatabase, predicate = sql`true`): Promise<number> {
  const result = await database.db.execute(sql`SELECT count(*)::int AS n FROM chunks WHERE ${predicate}`);
  return (result.rows[0] as { n: number }).n;
}

/** One project, `documents` pages of `perDocument` chunks, written through the product's own upsert. */
async function seedProject(
  name: string,
  documentCount: number,
  perDocument: number,
  seed: number,
  opts: { answers?: string[]; dense?: boolean } = {},
): Promise<string> {
  const answers = opts.answers ?? [];
  const [project] = await subject.db.insert(projects).values({ name }).returning({ id: projects.id });
  const [source] = await subject.db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name })
    .returning({ id: documentSources.id });

  const next = rng(seed);
  for (let d = 0; d < documentCount; d++) {
    const relativePath = `${name}/page-${String(d).padStart(3, '0')}.md`;
    const newChunks: NewChunk[] = [];
    const body: string[] = [];
    for (let c = 0; c < perDocument; c++) {
      const headingPath = `${name} > page ${d} > section ${c}`;
      // The one page that answers a question says so and nothing else does, so the expected ordering
      // is a property of the corpus rather than of how a random cloud fell.
      const content = d < answers.length && c === 0 ? answers[d] : prose(next, 40);
      body.push(`## section ${c}\n\n${content}`);
      newChunks.push({
        chunkIndex: c,
        headingPath,
        content,
        tokenCount: 40,
        // The same text the indexer would embed: breadcrumb, blank line, content (ADR-0008) — or, for
        // the bulk project, a vector of the shape an encoder actually produces. See `gaussianVector`.
        embedding: opts.dense ? gaussianVector(next) : stubVector(`${headingPath}\n\n${content}`),
      });
    }
    await replaceDocument(
      subject.db,
      {
        projectId: project.id,
        sourceId: source.id,
        relativePath,
        title: `${name} page ${d}`,
        contentHash: `sha-${name}-${d}`,
        sizeBytes: body.join('\n\n').length,
        indexGeneration: LIVE,
        // ADR-0043's column, filled: a dump that lost it would leave `read_document` reading a
        // filesystem that a restored instance does not have.
        content: `# ${name} page ${d}\n\n${body.join('\n\n')}`,
        contentTruncated: false,
        version: '',
      },
      newChunks,
    );
  }
  return project.id;
}

/** `select pg_total_relation_size(...)`, split into the heap side and the index side. */
async function storageBytes(database: TestDatabase): Promise<{ tableBytes: number; indexBytes: number }> {
  const result = await database.db.execute(sql`
    SELECT sum(pg_table_size(c.oid))::bigint AS table_bytes, sum(pg_indexes_size(c.oid))::bigint AS index_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  const row = result.rows[0] as { table_bytes: string; index_bytes: string };
  return { tableBytes: Number(row.table_bytes), indexBytes: Number(row.index_bytes) };
}

async function textBytes(database: TestDatabase): Promise<{ chunkTextBytes: number; documentTextBytes: number; vectorTextBytes: number }> {
  const result = await database.db.execute(sql`
    SELECT (SELECT coalesce(sum(octet_length(content)), 0)::bigint FROM chunks) AS chunk_bytes,
           (SELECT coalesce(sum(octet_length(content)), 0)::bigint FROM documents) AS document_bytes,
           -- What the vector column weighs as pg_dump writes it: pgvector's own text form,
           -- [0.051234,-0.0173,...], before the archive compresses it. This is the number the
           -- OPERATIONS.md section 7 arithmetic is about, measured rather than derived.
           (SELECT coalesce(sum(octet_length(embedding::text)), 0)::bigint FROM chunks) AS vector_text_bytes`);
  const row = result.rows[0] as { chunk_bytes: string; document_bytes: string; vector_text_bytes: string };
  return {
    chunkTextBytes: Number(row.chunk_bytes),
    documentTextBytes: Number(row.document_bytes),
    vectorTextBytes: Number(row.vector_text_bytes),
  };
}

/** `sh -c` because every command here redirects, and exec takes an argv rather than a command line. */
const shell = (script: string): Promise<{ stdout: string }> => execInPostgresOrThrow(containerId, ['sh', '-c', script]);

async function elapsed(script: string): Promise<number> {
  const started = Date.now();
  await shell(script);
  return Date.now() - started;
}

beforeAll(async () => {
  subject = await createTestDatabase(baseUrl, SUBJECT);
  await applySchema(subject, DIMS);

  handbookId = await seedProject('handbook', HANDBOOK_DOCUMENTS, HANDBOOK_CHUNKS_PER_DOCUMENT, 11, { answers: ANSWERS });
  ledgerId = await seedProject('ledger', LEDGER_DOCUMENTS, LEDGER_CHUNKS_PER_DOCUMENT, 22, { dense: true });

  schemaBefore = await captureSchema(subject.db);
  hitsBefore = await Promise.all(QUESTIONS.map(search));
  journalBefore = await journalRows(subject);
  settingsBefore = await settingsRows(subject);
  const { tableBytes, indexBytes } = await storageBytes(subject);
  const { chunkTextBytes, documentTextBytes, vectorTextBytes } = await textBytes(subject);

  // ── The backup, exactly as OPERATIONS.md §4 writes it ────────────────────────────────────────────
  const dumpMs = await elapsed(`pg_dump -U contextator -Fc -f ${DUMP_PATH} ${SUBJECT}`);
  const dumpBytes = Number((await shell(`stat -c %s ${DUMP_PATH}`)).stdout.trim());

  // ── Drop the database and recreate it empty ──────────────────────────────────────────────────────
  // The strict version of "restore": not `--clean` over a schema that is already right, but a database
  // with nothing in it at all, which is what a new volume is.
  await dropTestDatabase(baseUrl, subject);
  subject = await createTestDatabase(baseUrl, SUBJECT);

  const restoreMs = await elapsed(`pg_restore -U contextator -d ${SUBJECT} --clean --if-exists ${DUMP_PATH}`);

  // ── The same restore again, in two pieces, to say where the time went ────────────────────────────
  // `pg_restore -l` prints the archive's own table of contents, one line per object, and `-L` replays a
  // chosen subset of it. Splitting that list on the HNSW index gives the attribution directly from
  // pg_restore's own accounting rather than from a guess: first everything else, then the index alone.
  const attribution = await createTestDatabase(baseUrl, ATTRIBUTION);
  await shell(
    `pg_restore -l ${DUMP_PATH} > ${TOC_ALL} && grep ${HNSW_INDEX} ${TOC_ALL} > ${TOC_HNSW} && grep -v ${HNSW_INDEX} ${TOC_ALL} > ${TOC_REST}`,
  );
  const restoreEverythingElseMs = await elapsed(`pg_restore -U contextator -d ${ATTRIBUTION} -L ${TOC_REST} ${DUMP_PATH}`);
  const restoreHnswMs = await elapsed(`pg_restore -U contextator -d ${ATTRIBUTION} -L ${TOC_HNSW} ${DUMP_PATH}`);
  await dropTestDatabase(baseUrl, attribution);

  measured = {
    dumpMs,
    dumpBytes,
    restoreMs,
    restoreEverythingElseMs,
    restoreHnswMs,
    vectorBytes: TOTAL_CHUNKS * DIMS * 4,
    vectorTextBytes,
    chunkTextBytes,
    documentTextBytes,
    tableBytes,
    indexBytes,
  };

  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  const s = (ms: number) => (ms / 1000).toFixed(1);
  console.log(
    [
      `backup-restore: ${TOTAL_CHUNKS} chunks (${HANDBOOK_CHUNKS} of them the searched project), ${HANDBOOK_DOCUMENTS + LEDGER_DOCUMENTS} documents, 2 projects`,
      `  dump      ${s(dumpMs)}s  →  ${mb(dumpBytes)} MB custom-format`,
      `  vectors   ${mb(measured.vectorBytes)} MB binary in the table, ${mb(vectorTextBytes)} MB as pg_dump writes them ` +
        `(${(vectorTextBytes / (TOTAL_CHUNKS * DIMS)).toFixed(1)} chars/float, ${(vectorTextBytes / measured.vectorBytes).toFixed(2)}× the binary)`,
      `            →  the compressed dump is ${(dumpBytes / measured.vectorBytes).toFixed(2)}× the binary vector footprint`,
      `  heap ${mb(tableBytes)} MB + indexes ${mb(indexBytes)} MB on disk; chunk text ${mb(chunkTextBytes)} MB, document text ${mb(documentTextBytes)} MB`,
      `  restore   ${s(restoreMs)}s total`,
      `    of which ${s(restoreHnswMs)}s is CREATE INDEX ${HNSW_INDEX} (${((restoreHnswMs / (restoreHnswMs + restoreEverythingElseMs)) * 100).toFixed(0)} %)`,
      `    and      ${s(restoreEverythingElseMs)}s is the schema, the data and every other index`,
    ].join('\n'),
  );
}, 600_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, subject);
});

describe('a custom-format dump restored into an empty database', () => {
  it('produces an identical catalogue projection', async () => {
    const after = await captureSchema(subject.db);
    // As text first: a failure here reads as a diff, which is what the helper is for.
    expect(renderSchemaSnapshot(after)).toBe(renderSchemaSnapshot(schemaBefore));
    expect(after).toEqual(schemaBefore);
  });

  it('holds every row, and the two columns a row count cannot speak for', async () => {
    expect(await countChunks(subject)).toBe(TOTAL_CHUNKS);
    // `content_tsv` is the lexical half of every search (ADR-0041) and it is ordinary column data, so
    // a dump carries it — but nothing else in this file would notice if it did not, because the dense
    // half alone still answers.
    expect(await countChunks(subject, sql`content_tsv IS NULL`)).toBe(0);
    // ADR-0043's column, which `read_document` serves instead of the filesystem. A restored instance
    // has no filesystem to fall back to.
    const documents = await subject.db.execute(sql`SELECT count(*)::int AS n FROM documents WHERE content IS NULL`);
    expect((documents.rows[0] as { n: number }).n).toBe(0);
  });

  it('still answers with the HNSW index rather than by sorting the table', async () => {
    // The index came back with its build parameters — the projection above asserts that — but a
    // restored index that the planner will not use is a restored index nobody benefits from.
    const plan = await subject.db.execute(sql`
      EXPLAIN (FORMAT JSON) SELECT id FROM chunks ORDER BY embedding <=> ${JSON.stringify(stubVector(QUESTIONS[0]))}::vector LIMIT 10`);
    expect(JSON.stringify(plan.rows)).toContain(HNSW_INDEX);
  });

  it('returns the identical rows in the identical order, with identical scores', async () => {
    const after = await Promise.all(QUESTIONS.map(search));

    // The guard against passing vacuously: an assertion that two empty lists are equal would hold on a
    // database with no rows at all.
    for (const hits of hitsBefore) expect(hits.length).toBeGreaterThan(1);
    for (const [i, hits] of hitsBefore.entries()) expect(hits[0].content).toBe(ANSWERS[i]);
    // And the lexical half actually participated, which is the functional proof that `content_tsv`
    // survived rather than merely being non-null.
    expect(hitsBefore.some((hits) => hits.some((hit) => hit.lexicalRank !== null))).toBe(true);

    expect(after).toEqual(hitsBefore);
  });
});

describe('the next start of the application, over the restored database', () => {
  it('is a clean no-op: no migration runs, no backfill fires, nothing in the schema moves', async () => {
    const before = await captureSchema(subject.db);
    const nullTsvBefore = await countChunks(subject, sql`content_tsv IS NULL`);

    // The whole of `bootstrapDatabase`, with the product's own arguments — the extension, the journal
    // adoption, `migrate()`, the dimension, the HNSW index and the `content_tsv` backfill.
    await applySchema(subject, DIMS);

    expect(renderSchemaSnapshot(await captureSchema(subject.db))).toBe(renderSchemaSnapshot(before));

    // The journal is the assertion that matters. `adoptBaselineIfNeeded` writes a row when it finds a
    // database with the tables and no journal, and a dump that had lost `drizzle.__drizzle_migrations`
    // would look exactly like that — so a restore whose journal did not survive would be *adopted*
    // here, silently, as a `0.1.0` installation, and every migration after the baseline would then be
    // applied a second time over a schema that already has it.
    expect(await journalRows(subject)).toEqual(journalBefore);
    expect(journalBefore).toHaveLength(readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length);

    // `key` and `value`, not the whole row: the bootstrap's last statement re-writes `updated_at` on
    // the `schema_version` row on every start, restored database or not, and asserting on a timestamp
    // that is meant to move would be asserting the wrong thing.
    expect(await settingsRows(subject)).toEqual(settingsBefore);

    // The backfill is a loop over rows and it is guarded by `IS NULL`. A restore that lost the column's
    // contents would be repaired here rather than reported — quietly, at the cost of one rewrite of
    // every chunk in the instance — so "nothing to fill, before and after" is part of the claim.
    expect(nullTsvBefore).toBe(0);
    expect(await countChunks(subject, sql`content_tsv IS NULL`)).toBe(0);
    expect(await countChunks(subject)).toBe(TOTAL_CHUNKS);
  });

  it('leaves the answers exactly where the restore put them', async () => {
    expect(await Promise.all(QUESTIONS.map(search))).toEqual(hitsBefore);
  });
});

describe('the same dump replayed over a database that is not empty', () => {
  it('lands the same answers again, which is the command OPERATIONS.md §4 actually gives an operator', async () => {
    // Everything above restores into an **empty** database, which is the disaster case: a new volume,
    // nothing in it. The case an operator reaches for far more often is the other one — the container
    // is up, the database is populated, and they are rolling back to a dump. That is the same command
    // with the same two flags, and `--clean --if-exists` is what makes one command serve both: the
    // DROPs find something here and found nothing there.
    //
    // It runs last, and over the database the tests above already asserted on, because it is the
    // destructive one.
    const restoreMs = await elapsed(`pg_restore -U contextator -d ${SUBJECT} --clean --if-exists ${DUMP_PATH}`);
    console.log(`backup-restore: replaying the dump over the populated database took ${(restoreMs / 1000).toFixed(1)}s`);

    expect(renderSchemaSnapshot(await captureSchema(subject.db))).toBe(renderSchemaSnapshot(schemaBefore));
    expect(await countChunks(subject)).toBe(TOTAL_CHUNKS);
    expect(await Promise.all(QUESTIONS.map(search))).toEqual(hitsBefore);
  });
});

describe('a dump taken while a rebuild is in flight', () => {
  it('carries both generations, and very nearly doubles', async () => {
    // [ADR-0039](../../../.ssot/ADR.md#adr-0039): a rebuild writes generation `live + 1` beside the
    // live one and swaps in a single row update, so for the duration of a run the tables hold two
    // copies of the project. `pg_dump` has no way to filter rows — it is a dump of a database, not of
    // an index — so a backup taken in that window carries both.
    //
    // The second generation is copied server-side rather than re-embedded: a rebuild would compute
    // fresh vectors, but they would be the same *shape* and the same *width*, and this measurement is
    // about bytes. Nothing else in this file is asserted after it.
    await subject.db.execute(sql`
      with copied as (
        insert into documents (project_id, source_id, relative_path, title, content_hash, size_bytes,
                               chunk_count, content, content_truncated, index_generation)
        select project_id, source_id, relative_path, title, content_hash, size_bytes,
               chunk_count, content, content_truncated, 1
        from documents where project_id = ${ledgerId} and index_generation = 0
        returning id, relative_path
      )
      insert into chunks (project_id, document_id, index_generation, chunk_index, heading_path,
                          content, token_count, embedding, content_tsv)
      select c.project_id, copied.id, 1, c.chunk_index, c.heading_path,
             c.content, c.token_count, c.embedding, c.content_tsv
      from chunks c
      join documents d on d.id = c.document_id
      join copied on copied.relative_path = d.relative_path
      where c.project_id = ${ledgerId} and c.index_generation = 0`);

    const midRebuildPath = `${DUMP_PATH}.mid-rebuild`;
    await shell(`pg_dump -U contextator -Fc -f ${midRebuildPath} ${SUBJECT}`);
    const midRebuildBytes = Number((await shell(`stat -c %s ${midRebuildPath}`)).stdout.trim());

    const ratio = midRebuildBytes / measured.dumpBytes;
    console.log(
      `backup-restore: a dump taken mid-rebuild is ${(midRebuildBytes / 1024 / 1024).toFixed(1)} MB against ` +
        `${(measured.dumpBytes / 1024 / 1024).toFixed(1)} MB — ${ratio.toFixed(2)}× — for the same live index`,
    );

    expect(await countChunks(subject, sql`index_generation = 1`)).toBe(LEDGER_DOCUMENTS * LEDGER_CHUNKS_PER_DOCUMENT);
    expect(ratio).toBeGreaterThan(1.8);
  });
});

describe('what the measurement says', () => {
  it('spends more of the restore on the HNSW index than on everything else together', async () => {
    // The claim OPERATIONS.md §4 and §7 make, held as an assertion rather than as a sentence: the cost
    // of a restore is dominated by rebuilding one index over every chunk in the **instance**. It is a
    // ratio and not a duration, so it does not turn red on a slow machine.
    expect(measured.restoreHnswMs).toBeGreaterThan(measured.restoreEverythingElseMs);
  });

  it('writes a dump larger than the binary vectors it carries, because a vector dumps as text', async () => {
    // pgvector's output format is `[0.123456,-0.045678,…]`: eight to fourteen characters for four
    // bytes in the table. A custom-format dump compresses that, and it is still bigger than the binary
    // footprint — which is the number an operator sizing a backup volume needs and the one nobody had
    // written down.
    expect(measured.dumpBytes).toBeGreaterThan(measured.vectorBytes);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────────────────────────
 * `npm run backup` / `npm run restore` — the command, end to end
 * ([ADR-0072](../../../.ssot/ADR.md#adr-0072))
 *
 * Everything above proves what a `pg_dump` and a `pg_restore` do. What it cannot prove is the thing
 * ADR-0046 wrote down and left to a document: **a dump is not the installation.** It carries no
 * `SECRET_KEY`, so every stored source credential comes back undecryptable; it carries nothing from
 * `DATA_DIR`, so an upload source — the only source type whose files exist nowhere else — comes back
 * configured and permanently empty. The section below is those two gaps, closed by a command and
 * asserted end to end: a real instance with an upload source and an encrypted credential, backed up,
 * emptied, and restored, with the answers and the files asked for on the other side.
 *
 * The tools still run **inside the container**, at the version that matches the server, exactly where
 * ADR-0046 put them. `PgTools` is the seam that lets them: the operator's invocation runs them on its
 * own `PATH` (`localPgTools`), and this file runs them through the harness's exec handle with a bind
 * mount underneath, so what the suite asserts on is the archive the command actually wrote.
 * ────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The key the fixture's encrypted credential is written under, and the one the restore must want. */
const BACKUP_KEY = 'f'.repeat(64);
/** A key that is 32+ characters and is not that one. */
const WRONG_KEY = '9'.repeat(64);

const CLI_DATABASE = 'backup_cli';

/** The file the upload source holds, which is in no `pg_dump` and in no remote anybody can re-pull. */
const UPLOADED_PATH = 'onboarding.md';
const UPLOADED_BODY = [
  '# Onboarding',
  '',
  '## Rotating the deploy key',
  '',
  'The deploy key is rotated from the source panel; the previous key stops working immediately.',
  '',
  '## Where uploads land',
  '',
  'An uploaded archive is unpacked into a staging directory and swapped in when the upload is committed.',
].join('\n');

/**
 * `PgTools` over the harness's container: the tools where ADR-0046 put them, writing into a directory
 * the host can read.
 *
 * `umask 000` because the exec runs as root inside the container and this process is the host user:
 * a dump written 0600 by one of them is a dump the other cannot open, and that is a property of the
 * bind mount rather than of anything under test. `PGUSER` is set here rather than passed as `-U` for
 * the same reason `connectionFromEnv` does it — the command under test adds no connection flags.
 */
function containerTools(scratchLocal: string, scratchRemote: string, ran: PgTool[] = []): PgTools {
  const quote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;
  const script = (tool: string, args: string[]): string =>
    `umask 000; export PGUSER=contextator PGDATABASE=${CLI_DATABASE}; exec ${tool} ${args.map(quote).join(' ')}`;
  return {
    scratch: { local: scratchLocal, remote: scratchRemote },
    database: CLI_DATABASE,
    run: async (tool, args) => {
      // **`ran` is how a test says "and it never got that far".** Every refusal in this feature is a
      // claim about *order* — nothing written before the check — and the only thing that writes is
      // `pg_restore`. Asserting on the database's contents afterwards cannot separate "it did not
      // run" from "it ran and put back the same rows", which is exactly the shape a restore has: the
      // dump is valid, so re-applying it leaves every count where it was. Recording the call does
      // separate them.
      ran.push(tool);
      return (await execInPostgresOrThrow(containerId, ['sh', '-c', script(tool, args)])).stdout;
    },
    // Deliberately not recorded: `--version` is one of the refusal *inputs* and touches nothing.
    version: async (tool) => (await execInPostgresOrThrow(containerId, [tool, '--version'])).stdout.trim(),
  };
}

/** One Markdown page indexed the way the indexer indexes one: chunked, embedded, stored. */
async function seedPage(database: TestDatabase, projectId: string, sourceId: string, relativePath: string, body: string): Promise<void> {
  const { title, chunks: pieces } = chunkMarkdown(body, relativePath, { maxTokens: 96, overlapTokens: 24, countTokens: estimateTokens });
  const rows: NewChunk[] = pieces.map((piece) => ({
    chunkIndex: piece.index,
    headingPath: piece.headingPath,
    content: piece.content,
    tokenCount: piece.tokenCount,
    embedding: stubVector(embeddingText(piece)),
  }));
  await replaceDocument(
    database.db,
    {
      projectId,
      sourceId,
      relativePath,
      title,
      contentHash: `sha-${relativePath}`,
      sizeBytes: body.length,
      indexGeneration: LIVE,
      content: body,
      contentTruncated: false,
      version: '',
    },
    rows,
  );
}

/** The three fields `registerTools` reaches for, and a stub encoder, so `read_document` can be called. */
function toolContext(database: TestDatabase, dataDir: string): ToolContext {
  const provider: EmbeddingProvider = {
    id: 'local:stub-bag-of-words:fp32',
    provider: 'local',
    model: 'stub-bag-of-words',
    dimensions: DIMS,
    ready: true,
    maxInputTokens: 512,
    truncatesAtTokens: 512,
    windowSource: 'default',
    countTokens: estimateTokens,
    queryPrefix: '',
    passagePrefix: '',
    warmup: async () => {},
    embedPassages: async (texts: string[]) => texts.map(stubVector),
    embedQuery: async (text: string) => stubVector(text),
  };
  return {
    db: database.db,
    embeddings: provider,
    // The floor was measured against a real encoder (ADR-0042); this file's vectors are a stub, and
    // what is being asserted is that the rows came back, not where they scored.
    config: loadConfig({ DATABASE_URL: database.url, DATA_DIR: dataDir, ALLOWED_DOC_ROOTS: dataDir, SEARCH_SCORE_FLOOR: '0' }),
    log: silentLogger,
    queryLog: undefined,
  } as ToolContext;
}

async function readDocument(database: TestDatabase, dataDir: string, project: ProjectRow, relativePath: string): Promise<string> {
  const server = new McpServer({ name: 'contextator-test', version: '0.0.0' });
  registerTools(server, toolContext(database, dataDir), project);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'itest', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'read_document', arguments: { path: relativePath } });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    expect(result.isError).not.toBe(true);
    return content.find((c) => c.type === 'text')?.text ?? '';
  } finally {
    await client.close();
  }
}

/** Every file under a directory, as path → bytes, so "the tree came back" is a claim about content. */
async function treeContents(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const entry of await fsp.readdir(at, { withFileTypes: true })) {
      const full = nodePath.join(at, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, key);
      else if (entry.isFile()) out[key] = await fsp.readFile(full, 'utf8');
    }
  };
  try {
    await walk(dir, '');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return out;
}

describe('the backup command, and the instance it is asked to bring back', () => {
  let cli: TestDatabase;
  let dataDir: string;
  let scratch: { local: string; remote: string };
  let archive: string;
  let project: ProjectRow;
  let uploadDir: string;
  let uploadBefore: Record<string, string>;
  let backupOutput: string[];
  let backupManifest: BackupManifest;

  /** A fresh, empty instance at the shape a first start leaves: schema created, nothing in it. */
  async function emptyInstance(): Promise<void> {
    await dropTestDatabase(baseUrl, cli);
    cli = await createTestDatabase(baseUrl, CLI_DATABASE);
    await applySchema(cli, DIMS);
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.mkdir(dataDir, { recursive: true });
  }

  const restoreDeps = (secretKey: string | undefined, ran: PgTool[] = []): RestoreDeps => ({
    db: cli.db,
    config: loadConfig({ DATABASE_URL: cli.url, DATA_DIR: dataDir, SECRET_KEY: secretKey ?? '' }),
    tools: containerTools(scratch.local, scratch.remote, ran),
    // The topology this suite runs in: it reaches the database over a URL, which is exactly what
    // ADR-0069 calls external — and the command has to say so rather than imply the container's own.
    topology: describeTopology({ DATABASE_URL: cli.url }),
    secretKey,
    say: () => {},
  });

  beforeAll(async () => {
    cli = await createTestDatabase(baseUrl, CLI_DATABASE);
    await applySchema(cli, DIMS);

    dataDir = await fsp.mkdtemp(nodePath.join(tmpdir(), 'contextator-backup-data-'));
    scratch = { local: nodePath.join(exchangeDir, 'cli'), remote: `${EXCHANGE_DIR}/cli` };
    await fsp.mkdir(scratch.local, { recursive: true });
    await fsp.chmod(scratch.local, 0o777);
    archive = nodePath.join(exchangeDir, 'instance-backup.tar.gz');

    [project] = await cli.db.insert(projects).values({ name: 'handbook', embeddingModel: 'local:stub-bag-of-words:fp32' }).returning();

    // An upload source: its `current/` tree is the only copy of its content anywhere, and no `pg_dump`
    // has ever contained it.
    const [upload] = await cli.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'upload', name: 'manuals' })
      .returning({ id: documentSources.id });
    uploadDir = nodePath.join(dataDir, 'projects', project.id, 'sources', upload.id, 'current');
    await fsp.mkdir(uploadDir, { recursive: true });
    await fsp.writeFile(nodePath.join(uploadDir, UPLOADED_PATH), UPLOADED_BODY, 'utf8');
    await seedPage(cli, project.id, upload.id, `manuals/${UPLOADED_PATH}`, UPLOADED_BODY);
    uploadBefore = await treeContents(uploadDir);

    // And a source holding a credential encrypted under SECRET_KEY, so the key the backup records is a
    // key something in the dump actually depends on.
    await cli.db.insert(documentSources).values({
      projectId: project.id,
      type: 'git',
      name: 'private-repo',
      config: { url: 'https://example.invalid/private.git', branch: 'main', subdir: '', extensions: ['md'] },
      secretEnc: encryptSecret('ghp_a_token_that_must_not_travel', { current: BACKUP_KEY }),
    });

    // And a source that holds **no** sync credential and is still unreadable without the key: its
    // webhook secret is encrypted under it (ADR-0075). A manifest that counted only `secret_enc`
    // would call this instance key-independent and let a restore with the wrong key report success.
    await cli.db.insert(documentSources).values({
      projectId: project.id,
      type: 'notion',
      name: 'workspace',
      config: { rootIds: [], extensions: ['md'] },
      webhookSecret: encryptWebhookSecret('secret_a_verification_token_notion_minted', { current: BACKUP_KEY }),
    });

    // A row that has not been through the rotation pass yet: its webhook secret is still in the clear,
    // so it is readable without any key and must **not** be counted. Counting it would make an
    // instance that has never encrypted anything refuse restores it has nothing at stake in.
    await cli.db.insert(documentSources).values({
      projectId: project.id,
      type: 'confluence',
      name: 'handbook-wiki',
      config: { baseUrl: 'https://example.invalid/wiki', email: 'ops@example.invalid', spaceKeys: ['DOCS'], extensions: ['md'] },
      webhookSecret: 'wh-written-in-the-clear-before-adr-0075',
    });

    backupOutput = [];
    const result = await runBackup(
      {
        db: cli.db,
        config: loadConfig({ DATABASE_URL: cli.url, DATA_DIR: dataDir, SECRET_KEY: BACKUP_KEY }),
        tools: containerTools(scratch.local, scratch.remote),
        topology: describeTopology({ DATABASE_URL: cli.url }),
        say: (line) => backupOutput.push(line),
      },
      archive,
    );
    backupManifest = result.manifest;
  }, 600_000);

  afterAll(async () => {
    await dropTestDatabase(baseUrl, cli);
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(scratch.local, { recursive: true, force: true });
    await fsp.rm(archive, { force: true });
  });

  describe('what one archive holds', () => {
    it('carries the database, the upload tree and a manifest that is read first', async () => {
      const entries: string[] = [];
      await tar.list({ file: archive, onReadEntry: (entry) => entries.push(entry.path) });
      expect(entries[0]).toBe('manifest.json');
      expect(entries).toContain('README.txt');
      expect(entries).toContain('database.dump');
      expect(entries.some((path) => path.startsWith('data/projects/') && path.endsWith(UPLOADED_PATH))).toBe(true);

      expect(backupManifest.counts.projects).toBe(1);
      expect(backupManifest.counts.uploadSources).toBe(1);
      expect(backupManifest.counts.uploadFiles).toBe(1);
      expect(backupManifest.uploads[0].path).toBe(`projects/${project.id}/sources/${backupManifest.uploads[0].path.split('/')[3]}/current`);
    });

    /**
     * The worst thing this phase could have produced, asserted against rather than promised. The key
     * is searched for in the **decompressed** bytes of the whole archive, not in the manifest: a
     * convenience that wrote it into `README.txt`, or into a `.env` somebody decided to carry, would
     * pass every other assertion in this file.
     */
    it('does not contain SECRET_KEY anywhere in it, only a key check value', async () => {
      const bytes = gunzipSync(await fsp.readFile(archive)).toString('latin1');
      expect(bytes).not.toContain(BACKUP_KEY);
      expect(bytes).toContain(secretKeyFingerprint(BACKUP_KEY));

      expect(backupManifest.secretKey.present).toBe(true);
      expect(backupManifest.secretKey.fingerprint).toBe(secretKeyFingerprint(BACKUP_KEY));
      // Two sources in the dump depend on that key, and they are counted apart because a wrong key
      // costs two different things. One holds a sync credential the provider issued: that is what
      // `encryptedSources` counts and what makes the refusal below a statement about the data rather
      // than about a setting. The other holds nothing but a webhook secret, which this instance can
      // generate again — counted, reported, and never a reason to stop a restore. The third source's
      // webhook secret is pre-ADR-0075 plaintext and is in neither number, because a restore reads
      // it without any key at all.
      expect(backupManifest.secretKey.encryptedSources).toBe(1);
      expect(backupManifest.secretKey.regenerableSecrets).toBe(1);
      expect(backupOutput.join('\n')).toContain('SECRET_KEY is NOT in this file');
    });

    /**
     * ADR-0069's topology, said out loud. This suite reaches its database over a URL, which is the
     * external case — where the dump may be a second, unmanaged copy of somebody else's production
     * data, and where the upload trees beside it are still in no other backup.
     */
    it('says which database it talked to and whose job that database is', () => {
      const said = backupOutput.join('\n');
      expect(said).toContain('database: external');
      expect(said).toContain('Nothing in this image operates that server');
      expect(said).toContain('upload trees');
      expect(said).not.toContain(BACKUP_KEY);
      expect(backupManifest.database.mode).toBe('external');
      expect(backupManifest.database.target).not.toBeNull();
      // The credential in the URL is not in the manifest either.
      expect(JSON.stringify(backupManifest)).not.toContain('contextator:contextator@');
    });
  });

  describe('restored with the wrong SECRET_KEY', () => {
    it('stops before it writes anything, and leaves the empty instance empty', async () => {
      await emptyInstance();

      const ran: PgTool[] = [];
      await expect(runRestore(restoreDeps(WRONG_KEY, ran), archive)).rejects.toMatchObject({ code: 'secret_key_mismatch' });

      // The whole of "it does not leave a half-loaded instance": the database it was pointed at still
      // has nothing in it, and DATA_DIR is still empty. A refusal made *after* `pg_restore --clean`
      // would have dropped the schema and half-written the rest. The row count says that here because
      // this instance is empty and the archive is not; `ran` says it on any instance, which is the
      // claim that survives somebody reusing this case against a populated one.
      expect(ran).toEqual([]);
      const rows = await cli.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
      expect((rows.rows[0] as { n: number }).n).toBe(0);
      expect(await treeContents(dataDir)).toEqual({});
    });

    it('refuses a missing key the same way, naming the fingerprint it wants', async () => {
      const ran: PgTool[] = [];
      await expect(runRestore(restoreDeps(undefined, ran), archive)).rejects.toMatchObject({ code: 'secret_key_missing' });
      expect(ran).toEqual([]);
      const rows = await cli.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
      expect((rows.rows[0] as { n: number }).n).toBe(0);
      expect(await treeContents(dataDir)).toEqual({});
    });
  });

  /**
   * Step 2 of the SECRET_KEY rotation runbook (OPERATIONS.md §5.20) replaces `SECRET_KEY` with the new
   * key and keeps the old one in `SECRET_KEY_PREVIOUS`, so the *instance* can still read everything.
   * A restore cannot: it runs before there is an instance, and the check value in the manifest is
   * compared against `SECRET_KEY` and nothing else. That is why the runbook says an older archive
   * stops being restorable at step 2 rather than at step 4, and this is the case that says so —
   * teaching the check to fall back to the keyring would turn the documented consequence into a lie.
   */
  describe('restored at step 2 of a rotation, with the archive\u2019s key still in SECRET_KEY_PREVIOUS', () => {
    it('refuses exactly as it would with no old key anywhere, and writes nothing', async () => {
      await emptyInstance();

      const ran: PgTool[] = [];
      const deps: RestoreDeps = {
        ...restoreDeps(WRONG_KEY, ran),
        config: loadConfig({ DATABASE_URL: cli.url, DATA_DIR: dataDir, SECRET_KEY: WRONG_KEY, SECRET_KEY_PREVIOUS: BACKUP_KEY }),
      };
      await expect(runRestore(deps, archive)).rejects.toMatchObject({ code: 'secret_key_mismatch' });

      expect(ran).toEqual([]);
      const rows = await cli.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
      expect((rows.rows[0] as { n: number }).n).toBe(0);
      expect(await treeContents(dataDir)).toEqual({});
    });
  });

  describe('restored with the key it was taken under', () => {
    it('brings the project back searchable, and the uploaded file back on disk and readable', async () => {
      // The instance is the empty one the two refusals above left behind.
      const ran: PgTool[] = [];
      const report = await runRestore(restoreDeps(BACKUP_KEY, ran), archive);
      expect(report.uploadsRestored).toBe(1);
      // The guard against the recorder being something no code path can fill: a real restore does
      // reach `pg_restore`, exactly once. Without this, every `expect(ran).toEqual([])` above would
      // pass on a recorder that was never wired to anything.
      expect(ran).toEqual(['pg_restore']);

      const restored = await cli.db.select().from(projects).limit(1);
      expect(restored).toHaveLength(1);
      expect(restored[0].name).toBe('handbook');

      // Searchable: the product's own read path, over the restored database.
      const hits = await searchChunks(cli.db, {
        projectId: restored[0].id,
        generation: restored[0].liveGeneration,
        queryEmbedding: stubVector('where do uploaded archives land'),
        queryText: 'where do uploaded archives land',
        limit: 5,
        selection: WHOLE_PAGE,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => hit.content.includes('staging directory'))).toBe(true);

      // Readable: `read_document` through a real MCP client, which serves `documents.content`.
      const answer = await readDocument(cli, dataDir, restored[0], `manuals/${UPLOADED_PATH}`);
      expect(answer).toContain('Rotating the deploy key');
      expect(answer).toContain('swapped in when the upload is committed');

      // And the file itself, which no `pg_dump` has ever held: byte for byte, where it was.
      const upload = await cli.db.select().from(documentSources).where(eq(documentSources.type, 'upload')).limit(1);
      const restoredDir = nodePath.join(dataDir, 'projects', restored[0].id, 'sources', upload[0].id, 'current');
      expect(await treeContents(restoredDir)).toEqual(uploadBefore);

      // The credential came back encrypted, and the key this environment holds still opens it — which
      // is the thing the refusal above was protecting.
      const git = await cli.db.select().from(documentSources).where(eq(documentSources.type, 'git')).limit(1);
      expect(decryptSecret(git[0].secretEnc ?? '', { current: BACKUP_KEY })).toBe('ghp_a_token_that_must_not_travel');
    });

    it('is a clean no-op for the next start of the application over it', async () => {
      const before = await captureSchema(cli.db);
      await applySchema(cli, DIMS);
      expect(renderSchemaSnapshot(await captureSchema(cli.db))).toBe(renderSchemaSnapshot(before));
    });
  });

  describe('--check, which is what an operator is told to run first', () => {
    it('evaluates every refusal and writes nothing at all — not a row, not a file, not a directory', async () => {
      // A scratch directory that does not exist yet, so "it created nothing" is assertable rather
      // than a claim about a directory `beforeAll` already made. `main()` names its staging directory
      // the same way and lets `runRestore` be the thing that creates it.
      const untouched = nodePath.join(exchangeDir, 'check-scratch');
      await fsp.rm(untouched, { recursive: true, force: true });
      const deps: RestoreDeps = { ...restoreDeps(BACKUP_KEY), tools: containerTools(untouched, `${EXCHANGE_DIR}/check-scratch`) };

      const before = await treeContents(dataDir);
      const ran: PgTool[] = [];
      const report = await runRestore({ ...deps, tools: containerTools(untouched, `${EXCHANGE_DIR}/check-scratch`, ran) }, archive, { check: true });

      // The write claims first, so a regression reports as the thing that broke rather than as a
      // changed return value. The same reason as the refusals below: this instance already holds what
      // the archive holds, so a `--check` that quietly went on and restored would leave every count
      // where it is. What it cannot do is reach `pg_restore` without being seen.
      expect(ran).toEqual([]);
      // Nothing unpacked, nothing created: the archive is gigabytes in a real instance and `--check`
      // is meant to cost a few hundred bytes of it.
      await expect(fsp.stat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
      // And the instance it was pointed at is exactly as it was.
      expect(await treeContents(dataDir)).toEqual(before);
      const rows = await cli.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
      expect((rows.rows[0] as { n: number }).n).toBe(1);

      expect(report.checkedOnly).toBe(true);
      expect(report.uploadsRestored).toBe(0);
      expect(report.manifest.counts.chunks).toBe(backupManifest.counts.chunks);
    });

    it('still refuses the wrong key, because a check that passes everything checks nothing', async () => {
      const ran: PgTool[] = [];
      await expect(runRestore(restoreDeps(WRONG_KEY, ran), archive, { check: true })).rejects.toMatchObject({ code: 'secret_key_mismatch' });
      // The code alone would also be satisfied by a check that ran `pg_restore` first and refused
      // afterwards; that is the one ordering `--check` promises never to have.
      expect(ran).toEqual([]);
    });
  });

  describe('an archive whose manifest promises an upload tree it does not carry', () => {
    /**
     * A truncated download, an archive somebody opened and repacked, an entry the extraction filter
     * dropped. The restore removes each carried tree and puts the archive's copy in its place, so a
     * manifest that names a tree the bytes do not hold would **delete that source's only copy** and
     * then die on the copy — with `pg_restore --clean` already behind it.
     */
    it('refuses before it touches the database, and the tree that was already there survives', async () => {
      const doctored = nodePath.join(exchangeDir, 'missing-tree.tar.gz');
      const staging = nodePath.join(exchangeDir, 'missing-tree');
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });
      // Everything the real archive holds except the upload tree its manifest still lists.
      await tar.extract({ file: archive, cwd: staging });
      await fsp.rm(nodePath.join(staging, 'data'), { recursive: true, force: true });
      await tar.create({ gzip: true, file: doctored, cwd: staging, portable: true }, ['manifest.json', 'README.txt', 'database.dump']);

      const upload = await cli.db.select().from(documentSources).where(eq(documentSources.type, 'upload')).limit(1);
      const project = await cli.db.select().from(projects).limit(1);
      const onDisk = nodePath.join(dataDir, 'projects', project[0].id, 'sources', upload[0].id, 'current');
      const before = await treeContents(onDisk);
      expect(Object.keys(before)).toHaveLength(1);

      try {
        const ran: PgTool[] = [];
        await expect(runRestore(restoreDeps(BACKUP_KEY, ran), doctored)).rejects.toMatchObject({ code: 'incomplete_archive' });

        /**
         * **"Before it touches the database" is this line and nothing else.**
         *
         * The two assertions that used to stand here cannot see the difference the name claims. The
         * tree survives whether the check sits before `pg_restore` or after it, because either way it
         * is refused before the `rm`/`cp` loop; and `chunks > 0` holds either way too, because the
         * doctored archive carries the **same valid dump** — re-applying it leaves every count
         * exactly where it was. Moving the check after `pg_restore` therefore kept all 21 tests
         * green, which is how this was found.
         *
         * A restore that ran and put the same rows back is not the same event as one that never ran:
         * `--clean --if-exists` dropped and rebuilt every table on the way, and an operator who is
         * told "Nothing has been written." would be told it by a command that had just replaced their
         * database. So the assertion is that the tool was never invoked.
         */
        expect(ran).toEqual([]);

        // The files are still there — this is the assertion the refusal exists for.
        expect(await treeContents(onDisk)).toEqual(before);
        const rows = await cli.db.execute(sql`SELECT count(*)::int AS n FROM chunks`);
        expect((rows.rows[0] as { n: number }).n).toBeGreaterThan(0);
      } finally {
        await fsp.rm(doctored, { force: true });
        await fsp.rm(staging, { recursive: true, force: true });
      }
    });
  });

  describe('an archive that is not an instance backup', () => {
    it('is refused by what it says it is, not by what it is called', async () => {
      const other = nodePath.join(exchangeDir, 'not-a-backup.tar.gz');
      const staging = nodePath.join(exchangeDir, 'not-a-backup');
      await fsp.mkdir(staging, { recursive: true });
      await fsp.writeFile(
        nodePath.join(staging, 'manifest.json'),
        JSON.stringify({ kind: 'contextator.project-export', manifestVersion: 1 }),
        'utf8',
      );
      await tar.create({ gzip: true, file: other, cwd: staging, portable: true }, ['manifest.json']);
      const ran: PgTool[] = [];
      try {
        await expect(runRestore(restoreDeps(BACKUP_KEY, ran), other)).rejects.toMatchObject({ code: 'not_a_backup' });
        // Every refusal in this feature is a claim about order, so every one of them says so.
        expect(ran).toEqual([]);
      } finally {
        await fsp.rm(other, { force: true });
        await fsp.rm(staging, { recursive: true, force: true });
      }
    });
  });
});
