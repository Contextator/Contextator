import { and, asc, cosineDistance, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chunks, documents, type DocumentRow } from '../db/schema.js';

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
 * Top-k cosine similarity search scoped to one project. Orders by the raw `<=>` distance
 * (not by `1 - distance DESC`) so PostgreSQL can use the HNSW index.
 */
export async function searchChunks(db: Db, projectId: string, queryEmbedding: number[], limit: number): Promise<SearchHit[]> {
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
    .where(eq(chunks.projectId, projectId))
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

export async function listDocumentsForProject(db: Db, projectId: string): Promise<DocumentSummary[]> {
  return db
    .select({
      relativePath: documents.relativePath,
      title: documents.title,
      chunkCount: documents.chunkCount,
      sizeBytes: documents.sizeBytes,
      indexedAt: documents.indexedAt,
    })
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(asc(documents.relativePath));
}

export async function getDocument(db: Db, projectId: string, relativePath: string): Promise<DocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.relativePath, relativePath)))
    .limit(1);
  return row;
}

export async function getExistingDocuments(
  db: Db,
  projectId: string,
): Promise<Map<string, { id: string; contentHash: string; sourceId: string | null }>> {
  const rows = await db
    .select({ id: documents.id, relativePath: documents.relativePath, contentHash: documents.contentHash, sourceId: documents.sourceId })
    .from(documents)
    .where(eq(documents.projectId, projectId));
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
  sourceId: string;
  relativePath: string;
  title: string;
  contentHash: string;
  sizeBytes: number;
}

/**
 * Fallback for clients that remember pre-v3 paths (without the source prefix): the document whose path
 * ends with `/<suffix>`, but only when exactly one matches.
 */
export async function getDocumentBySuffix(db: Db, projectId: string, suffix: string): Promise<DocumentRow | undefined> {
  const pattern = `%/${suffix.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), sql`${documents.relativePath} LIKE ${pattern} ESCAPE '\\'`))
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
      .onConflictDoUpdate({
        target: [documents.projectId, documents.relativePath],
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
      await tx.insert(chunks).values(newChunks.slice(i, i + INSERT_BATCH).map((c) => ({ projectId: doc.projectId, documentId: row.id, ...c })));
    }
    return row.id;
  });
}

export async function deleteDocuments(db: Db, projectId: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;
  await db.delete(documents).where(and(eq(documents.projectId, projectId), inArray(documents.relativePath, relativePaths)));
}

export async function deleteAllDocuments(db: Db, projectId: string): Promise<void> {
  await db.delete(documents).where(eq(documents.projectId, projectId));
}

export async function recountProject(db: Db, projectId: string): Promise<{ chunkCount: number; documentCount: number }> {
  const [c] = await db.select({ n: count() }).from(chunks).where(eq(chunks.projectId, projectId));
  const [d] = await db.select({ n: count() }).from(documents).where(eq(documents.projectId, projectId));
  return { chunkCount: c?.n ?? 0, documentCount: d?.n ?? 0 };
}
