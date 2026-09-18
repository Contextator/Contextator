import { and, asc, cosineDistance, count, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chunks, documents, type DocumentRow } from '../db/schema.js';

/**
 * Every query in this file is scoped by a **project and a generation**
 * ([ADR-0039](../../.ssot/ADR.md#adr-0039)). A project's `live_generation` is the published index;
 * a rebuild writes the next generation beside it and is switched over in one row update, so the two
 * exist at once and a query that named only the project would see both.
 *
 * The generation is a value the caller passes, never a sub-select on `projects`: every read path
 * already holds the project row it re-read for its own guards, and a sub-select would put a join
 * between pgvector and the predicate the search below depends on.
 */

export interface SearchHit {
  /** Cosine similarity in [-1, 1]; higher is better. */
  score: number;
  file: string;
  title: string;
  headingPath: string;
  content: string;
  chunkIndex: number;
}

/**
 * Top-k cosine similarity search scoped to one project's live generation. Orders by the raw `<=>`
 * distance (not by `1 - distance DESC`) so PostgreSQL can use the HNSW index.
 *
 * `chunks.index_generation` is denormalised from the document precisely so that this stays two plain
 * column predicates on the table the index is on — no join between the vector operator and the filter.
 */
export async function searchChunks(db: Db, projectId: string, generation: number, queryEmbedding: number[], limit: number): Promise<SearchHit[]> {
  const distance = cosineDistance(chunks.embedding, queryEmbedding);
  const score = sql<number>`(1 - (${distance}))::float8`;
  return db
    .select({
      score,
      file: documents.relativePath,
      title: documents.title,
      headingPath: chunks.headingPath,
      content: chunks.content,
      chunkIndex: chunks.chunkIndex,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(eq(chunks.projectId, projectId), eq(chunks.indexGeneration, generation)))
    .orderBy(asc(distance))
    .limit(limit);
}

export interface DocumentSummary {
  relativePath: string;
  title: string;
  chunkCount: number;
  sizeBytes: number;
  indexedAt: Date;
}

export async function listDocumentsForProject(db: Db, projectId: string, generation: number): Promise<DocumentSummary[]> {
  return db
    .select({
      relativePath: documents.relativePath,
      title: documents.title,
      chunkCount: documents.chunkCount,
      sizeBytes: documents.sizeBytes,
      indexedAt: documents.indexedAt,
    })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation)))
    .orderBy(asc(documents.relativePath));
}

export async function getDocument(db: Db, projectId: string, generation: number, relativePath: string): Promise<DocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), eq(documents.relativePath, relativePath)))
    .limit(1);
  return row;
}

/**
 * The paths a run writes into, with what is already there under them. A rebuild passes the generation
 * it is about to write — which holds nothing — so it gets an empty map and skips no file. "Force means
 * re-embed everything" is therefore a consequence of writing into a fresh generation rather than a
 * case anybody has to remember to special-case.
 */
export async function getExistingDocuments(
  db: Db,
  projectId: string,
  generation: number,
): Promise<Map<string, { id: string; contentHash: string; sourceId: string | null }>> {
  const rows = await db
    .select({ id: documents.id, relativePath: documents.relativePath, contentHash: documents.contentHash, sourceId: documents.sourceId })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation)));
  return new Map(rows.map((r) => [r.relativePath, { id: r.id, contentHash: r.contentHash, sourceId: r.sourceId }]));
}

export interface NewChunk {
  chunkIndex: number;
  headingPath: string;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export interface DocumentInput {
  projectId: string;
  /**
   * Nullable because the column is: pre-v3 documents carried no source, and the evaluation harness
   * (`scripts/eval.ts`, ADR-0034) indexes a corpus that is already on disk in the repository and has
   * therefore no `document_sources` row to point at. The indexer always supplies one.
   */
  sourceId: string | null;
  relativePath: string;
  title: string;
  contentHash: string;
  sizeBytes: number;
  /** The generation this document belongs to; the run decides it, not this function. */
  indexGeneration: number;
}

/**
 * Fallback for clients that remember pre-v3 paths (without the source prefix): the document whose path
 * ends with `/<suffix>`, but only when exactly one matches — within the live generation, so a rebuild
 * in flight cannot turn one match into two and make the fallback stop resolving.
 */
export async function getDocumentBySuffix(db: Db, projectId: string, generation: number, suffix: string): Promise<DocumentRow | undefined> {
  const pattern = `%/${suffix.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), sql`${documents.relativePath} LIKE ${pattern} ESCAPE '\\'`),
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

const INSERT_BATCH = 200;

/** Upserts the document row and atomically replaces all of its chunks. Returns the document id. */
export async function replaceDocument(db: Db, doc: DocumentInput, newChunks: NewChunk[]): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(documents)
      .values({ ...doc, chunkCount: newChunks.length, indexedAt: now })
      // Three columns since ADR-0039: the same path in two generations is two rows, and the
      // conflict target has to be the constraint that says so.
      .onConflictDoUpdate({
        target: [documents.projectId, documents.indexGeneration, documents.relativePath],
        set: {
          sourceId: doc.sourceId,
          title: doc.title,
          contentHash: doc.contentHash,
          sizeBytes: doc.sizeBytes,
          chunkCount: newChunks.length,
          indexedAt: now,
        },
      })
      .returning({ id: documents.id });

    await tx.delete(chunks).where(eq(chunks.documentId, row.id));
    for (let i = 0; i < newChunks.length; i += INSERT_BATCH) {
      await tx
        .insert(chunks)
        .values(
          newChunks
            .slice(i, i + INSERT_BATCH)
            .map((c) => ({ projectId: doc.projectId, documentId: row.id, indexGeneration: doc.indexGeneration, ...c })),
        );
    }
    return row.id;
  });
}

export async function deleteDocuments(db: Db, projectId: string, generation: number, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;
  await db
    .delete(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), inArray(documents.relativePath, relativePaths)));
}

export async function recountProject(db: Db, projectId: string, generation: number): Promise<{ chunkCount: number; documentCount: number }> {
  const [c] = await db
    .select({ n: count() })
    .from(chunks)
    .where(and(eq(chunks.projectId, projectId), eq(chunks.indexGeneration, generation)));
  const [d] = await db
    .select({ n: count() })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation)));
  return { chunkCount: c?.n ?? 0, documentCount: d?.n ?? 0 };
}

/** How many documents one `sweepGenerations` statement removes before coming up for air. */
const SWEEP_BATCH = 500;

/** Safety valve: a loop against a table something else is still writing must not be able to spin forever. */
const SWEEP_MAX_BATCHES = 10_000;

/**
 * Deletes every document of a project that does not belong to `liveGeneration`, and with them, by
 * cascade, their chunks. Both directions matter and both are the same statement:
 *
 * - `< live` is what a finished swap left behind — the generation that was being served until a
 *   moment ago.
 * - `> live` is an attempt that never went live: a rebuild that failed, or one whose process was
 *   killed between writing rows and swapping. Nothing else would ever collect those.
 *
 * That is what makes reclamation idempotent and crash-safe rather than a step a run has to survive
 * long enough to reach. It runs under the project's mutex, in batches, **outside** the swap's
 * transaction: one `DELETE` over a whole generation would hold locks for as long as it took and write
 * a write-ahead log the size of the index it is removing.
 *
 * Returns the number of documents removed.
 */
export async function sweepGenerations(db: Db, projectId: string, liveGeneration: number): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const doomed = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), ne(documents.indexGeneration, liveGeneration)))
      .limit(SWEEP_BATCH);
    if (doomed.length === 0) return removed;
    await db.delete(documents).where(
      inArray(
        documents.id,
        doomed.map((d) => d.id),
      ),
    );
    removed += doomed.length;
  }
  return removed;
}
