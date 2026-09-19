import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { MAX_SEARCH_LIMIT } from '../../src/config.js';
import { MIGRATIONS_FOLDER } from '../../src/db/bootstrap.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import {
  applySchema,
  createTestDatabase,
  dropTestDatabase,
  execInPostgresOrThrow,
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
