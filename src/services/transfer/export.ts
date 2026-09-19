import { randomUUID } from 'node:crypto';
import { createWriteStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, count, eq, gt, inArray, sql } from 'drizzle-orm';
import * as tar from 'tar';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import {
  chunks,
  documents,
  documentSources,
  indexRuns,
  mcpTokens,
  projectMembers,
  searchQueries,
  searchQueryHits,
  type DocumentSourceRow,
  type ProjectRow,
} from '../../db/schema.js';
import { sourceCurrentDir } from '../data-dir.js';
import { PROBE_TOKEN_KEY, type SourceType } from '../sources.js';
import {
  DATA_PREFIX,
  DOCUMENTS_ENTRY,
  MANIFEST_ENTRY,
  MANIFEST_KIND,
  MANIFEST_VERSION,
  README_ENTRY,
  SOURCES_ENTRY,
  dataPrefixFor,
  readmeFor,
  type Manifest,
  type SourceNeed,
} from './manifest.js';

/**
 * Writing one project out as a streamed `.tar.gz` ([ADR-0051](../../../.ssot/ADR.md#adr-0051)).
 *
 * **Streamed, because the point of the feature is a project larger than the memory of the process
 * exporting it.** Nothing here ever holds the corpus: documents come out of the database in keyset
 * pages, each page is appended to an NDJSON file as it arrives, and the tarball is `tar`'s own stream
 * over that staging directory piped straight to the reply. The peak resident set is one page of
 * documents; the peak *disk* is one copy of the project, which is stated in the runbook rather than
 * pretended away.
 *
 * The staging directory lives under `DATA_DIR` and not under `os.tmpdir()`, unlike the upload
 * extractor: an export of a real corpus is gigabytes, and `DATA_DIR` is the volume an operator sized
 * for this product's data. `sweepOrphanDirs` reads `<DATA_DIR>/projects` only, so a sibling directory
 * is not something it can decide to delete.
 */

/** Documents read from the database — and written to the file — in pages of this many. */
const PAGE = 50;

/** Where a half-built export is assembled. A sibling of `projects/`, so the orphan sweep cannot see it. */
const STAGING = '.transfer';

export interface ProjectExport {
  /** The tarball, as a stream. Consume it, then call `cleanup()`. */
  stream: NodeJS.ReadableStream;
  manifest: Manifest;
  /** The filename a browser should save it as. */
  filename: string;
  /** Removes the staging directory. Safe to call twice; never throws. */
  cleanup(): Promise<void>;
}

/**
 * This instance's own id, minted on first use.
 *
 * It is provenance and never identity: nothing authenticates with it and no refusal is decided from
 * it. What it buys is a true answer to "where did this tarball come from" on an installation with no
 * `PUBLIC_BASE_URL`, and the import's ability to notice that a project is being imported back into the
 * instance it left — which is legitimate, and worth saying in the report rather than discovering as a
 * duplicate.
 *
 * A `settings` row rather than a column, because `settings` is exactly the key/value table the
 * schema version and the vector dimension already live in, and this needs no migration.
 */
export async function instanceId(db: Db): Promise<string> {
  const read = async (): Promise<string | null> => {
    const result = await db.execute(sql`SELECT value FROM settings WHERE key = 'instance_id'`);
    return (result.rows[0] as { value: string } | undefined)?.value ?? null;
  };
  const existing = await read();
  if (existing) return existing;
  const minted = randomUUID();
  await db.execute(sql`INSERT INTO settings (key, value) VALUES ('instance_id', ${minted}) ON CONFLICT (key) DO NOTHING`);
  // Re-read rather than trusting the insert: two processes starting at once must agree on one value.
  return (await read()) ?? minted;
}

/** How far this database's schema has come, in the two terms the manifest states it in. */
export async function schemaFacts(db: Db): Promise<{ version: string; migrations: number }> {
  const version = await db.execute(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
  const journal = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
  return {
    version: (version.rows[0] as { value: string } | undefined)?.value ?? 'unknown',
    migrations: (journal.rows[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/**
 * A source as it travels: every column that describes what the source *is*, and not one that describes
 * what the source instance's relationship with it was.
 *
 * **`secretEnc` and `webhookSecret` are absent by construction rather than deleted afterwards.** This
 * function names the fields it emits; a column added to `document_sources` tomorrow does not
 * silently join the export, which is the opposite of the `{ ...row }` that would have been shorter.
 *
 * Three more are dropped for reasons that are not secrecy:
 *
 * - `syncProbeToken` and git's `lastCommit` are a driver's statement that *the tree on this disk* is at
 *   that revision ([ADR-0048](../../../.ssot/ADR.md#adr-0048)). The destination's disk is empty, so
 *   carrying them would let the probe answer "nothing moved" about a checkout that does not exist.
 * - `webhookVerificationExpiresAt` and `webhookDueAt` are an open capture window and a pending delivery
 *   claim belonging to the other instance's clock ([ADR-0049](../../../.ssot/ADR.md#adr-0049)).
 * - `syncIntervalMinutes` is dropped on the way *in* rather than here — see `import.ts`.
 */
export function exportedSource(row: DocumentSourceRow): Record<string, unknown> {
  const config = { ...row.config };
  delete config[PROBE_TOKEN_KEY];
  delete config.lastCommit;
  return {
    type: row.type,
    name: row.name,
    label: row.label,
    config,
    flavor: row.flavor,
    syncIntervalMinutes: row.syncIntervalMinutes,
    webhookMinIntervalMinutes: row.webhookMinIntervalMinutes,
  };
}

/** What this source will need on the other side, from what it has here. */
export function needsFor(row: DocumentSourceRow): SourceNeed[] {
  const needs: SourceNeed[] = [];
  if (row.secretEnc) needs.push('credential');
  if (row.webhookSecret) needs.push('webhook-secret');
  if (row.type === 'upload') needs.push('files-carried');
  if (row.type === 'local') needs.push('path-on-this-host');
  if (row.syncIntervalMinutes !== null) needs.push('never-scheduled');
  return needs;
}

/** Counts of everything that stays behind, so that the manifest states the absence as a number. */
async function excludedCounts(db: Db, projectId: string): Promise<Manifest['excluded']> {
  const one = async (value: Promise<Array<{ n: number }>>): Promise<number> => (await value)[0]?.n ?? 0;
  const [queries, hits, tokens, runs, members] = await Promise.all([
    one(db.select({ n: count() }).from(searchQueries).where(eq(searchQueries.projectId, projectId))),
    one(
      db
        .select({ n: count() })
        .from(searchQueryHits)
        .innerJoin(searchQueries, eq(searchQueryHits.queryId, searchQueries.id))
        .where(eq(searchQueries.projectId, projectId)),
    ),
    one(db.select({ n: count() }).from(mcpTokens).where(eq(mcpTokens.projectId, projectId))),
    one(db.select({ n: count() }).from(indexRuns).where(eq(indexRuns.projectId, projectId))),
    db
      .select({ role: projectMembers.role, n: count() })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .groupBy(projectMembers.role),
  ]);
  return {
    searchQueries: queries,
    searchQueryHits: hits,
    mcpTokens: tokens,
    indexRuns: runs,
    projectMembers: {
      viewer: members.find((r) => r.role === 'viewer')?.n ?? 0,
      editor: members.find((r) => r.role === 'editor')?.n ?? 0,
    },
  };
}

/**
 * Streams the live generation of one project into a `.tar.gz`.
 *
 * The caller owns the stream and must call `cleanup()` once it has been consumed or abandoned — the
 * route does both, in a `finally`.
 */
export async function exportProject(
  deps: { db: Db; config: Config; product: { name: string; version: string } },
  project: ProjectRow,
): Promise<ProjectExport> {
  const { db, config } = deps;
  const staging = path.join(config.DATA_DIR, STAGING, randomUUID());
  const cleanup = async (): Promise<void> => {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  };

  try {
    await fs.mkdir(staging, { recursive: true });
    const generation = project.liveGeneration;

    const sources = await db.select().from(documentSources).where(eq(documentSources.projectId, project.id)).orderBy(asc(documentSources.name));

    await fs.writeFile(path.join(staging, SOURCES_ENTRY), `${sources.map((s) => JSON.stringify(exportedSource(s))).join('\n')}\n`);

    const written = await writeDocuments(db, staging, project.id, generation);
    const uploads = await copyUploadTrees(config, staging, project.id, sources);

    const manifest: Manifest = {
      kind: MANIFEST_KIND,
      manifestVersion: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      product: deps.product,
      schema: await schemaFacts(db),
      instance: { id: await instanceId(db), publicBaseUrl: config.PUBLIC_BASE_URL ?? null },
      // The project's own stamp and not the server's: it is what these vectors were actually made
      // with, and on a project whose model has moved under it the two differ.
      embedding: project.embeddingModel ? { id: project.embeddingModel, dimensions: config.EMBEDDING_DIMENSIONS } : null,
      project: {
        name: project.name,
        exportedGeneration: generation,
        mcpAuth: project.mcpAuth,
        queryLogEnabled: project.queryLogEnabled,
        lastIndexedAt: project.lastIndexedAt?.toISOString() ?? null,
      },
      counts: { sources: sources.length, documents: written.documents, chunks: written.chunks, ...uploads },
      excluded: await excludedCounts(db, project.id),
      sources: sources.map((s) => ({ name: s.name, type: s.type as SourceType, needs: needsFor(s) })),
    };

    await fs.writeFile(path.join(staging, MANIFEST_ENTRY), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(staging, README_ENTRY), readmeFor(manifest));

    // The manifest first, so that an importer reading the stream in order meets it before any data.
    const entries = [MANIFEST_ENTRY, README_ENTRY, SOURCES_ENTRY, DOCUMENTS_ENTRY];
    if (uploads.uploadFiles > 0) entries.push(DATA_PREFIX);

    return {
      stream: tar.create({ gzip: true, cwd: staging, portable: true }, entries) as unknown as NodeJS.ReadableStream,
      manifest,
      filename: `${project.name}-${manifest.createdAt.slice(0, 10)}.tar.gz`,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * The documents of one generation, and their chunks, appended to `documents.ndjson` a page at a time.
 *
 * Keyset by `relative_path` over the unique constraint `(project_id, index_generation, relative_path)`
 * ([ADR-0039](../../../.ssot/ADR.md#adr-0039)), which is what makes the paging a key rather than a
 * guess: page two costs what page one cost, and no row can land on both pages or on neither.
 *
 * **Chunk ids and document ids do not travel.** They are `uuid` primary keys of another database, and
 * a chunk is identified inside this file by the document it is written under and by its own
 * `chunkIndex`, which `chunks_document_chunk_index_uq` already guarantees is unique per document.
 * Carrying them would tempt a future import into preserving them, and an id preserved across
 * instances is a collision waiting for the day two exports meet.
 */
async function writeDocuments(db: Db, staging: string, projectId: string, generation: number): Promise<{ documents: number; chunks: number }> {
  const out = createWriteStream(path.join(staging, DOCUMENTS_ENTRY), { encoding: 'utf8' });
  let documentCount = 0;
  let chunkCount = 0;
  let after = '';

  try {
    for (;;) {
      const page = await db
        .select()
        .from(documents)
        .where(and(eq(documents.projectId, projectId), eq(documents.indexGeneration, generation), gt(documents.relativePath, after)))
        .orderBy(asc(documents.relativePath))
        .limit(PAGE);
      if (page.length === 0) break;
      after = page[page.length - 1].relativePath;

      const rows = await db
        .select({
          documentId: chunks.documentId,
          chunkIndex: chunks.chunkIndex,
          headingPath: chunks.headingPath,
          content: chunks.content,
          tokenCount: chunks.tokenCount,
          embedding: chunks.embedding,
        })
        .from(chunks)
        .where(
          inArray(
            chunks.documentId,
            page.map((d) => d.id),
          ),
        )
        .orderBy(asc(chunks.documentId), asc(chunks.chunkIndex));

      const byDocument = new Map<string, Array<Omit<(typeof rows)[number], 'documentId'>>>();
      for (const { documentId, ...chunk } of rows) {
        const list = byDocument.get(documentId);
        if (list) list.push(chunk);
        else byDocument.set(documentId, [chunk]);
      }

      for (const doc of page) {
        const own = byDocument.get(doc.id) ?? [];
        chunkCount += own.length;
        documentCount++;
        // `sourceName` and not `sourceId`: the id is the other instance's, and the name is both unique
        // per project and already the prefix of every one of this document's paths.
        const line = JSON.stringify({
          sourceName: sourceNameOf(doc.relativePath),
          relativePath: doc.relativePath,
          title: doc.title,
          contentHash: doc.contentHash,
          sizeBytes: doc.sizeBytes,
          content: doc.content,
          contentTruncated: doc.contentTruncated,
          indexedAt: doc.indexedAt.toISOString(),
          chunks: own,
        });
        if (!out.write(`${line}\n`)) await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  return { documents: documentCount, chunks: chunkCount };
}

/**
 * The mount prefix of a document path — `<source name>/<path inside the source>`.
 *
 * Reading it off the path rather than joining `document_sources` is deliberate: the path is what the
 * import has to rebuild, so the name that decides which source a document is re-attached to should be
 * the name the path already carries. A document with no source (the evaluation harness writes those)
 * has no prefix that means anything, and gets `null`.
 */
export function sourceNameOf(relativePath: string): string | null {
  const slash = relativePath.indexOf('/');
  return slash > 0 ? relativePath.slice(0, slash) : null;
}

/**
 * Copies the `current/` tree of every `upload` source into the staging directory.
 *
 * **Only upload sources, and that is the decision.** [ADR-0046](../../../.ssot/ADR.md#adr-0046)
 * classified `DATA_DIR` per source type and the classification is what decides this: a git `repo/` is
 * re-clonable, a Notion `current/` is re-pullable, `.staging/` is disposable by construction — and an
 * **upload `current/` is the only copy of its content anywhere**. A source whose files exist nowhere
 * else, imported without them, is a source that is permanently empty and looks configured.
 *
 * Keyed by source **name**, because the destination mints its own ids and the name is what the
 * document paths already agree on.
 */
async function copyUploadTrees(
  config: Config,
  staging: string,
  projectId: string,
  sources: readonly DocumentSourceRow[],
): Promise<{ uploadFiles: number; uploadBytes: number }> {
  let uploadFiles = 0;
  let uploadBytes = 0;
  for (const source of sources) {
    if (source.type !== 'upload') continue;
    const from = sourceCurrentDir(config.DATA_DIR, projectId, source.id);
    const to = path.join(staging, dataPrefixFor(source.name));
    const stats = await copyTree(from, to);
    uploadFiles += stats.files;
    uploadBytes += stats.bytes;
  }
  return { uploadFiles, uploadBytes };
}

/** A plain recursive copy that counts what it moved, and treats a missing tree as an empty one. */
async function copyTree(from: string, to: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(from, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  await fs.mkdir(to, { recursive: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    // A symlink inside a source tree is not followed here for the same reason `importTree` skips one.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const inner = await copyTree(src, dst);
      files += inner.files;
      bytes += inner.bytes;
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
      files++;
      bytes += (await fs.stat(dst)).size;
    }
  }
  return { files, bytes };
}
