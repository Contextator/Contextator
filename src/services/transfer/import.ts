import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Logger } from '../../context.js';
import type { Db } from '../../db/client.js';
import { documentSources, projects } from '../../db/schema.js';
import { type ImportLimits, importTree, unpackTar, withScratch } from '../archives.js';
import { removeProjectDir, sourceCurrentDir } from '../data-dir.js';
import { FLAVORS, type Flavor } from '../flavors.js';
import { createProject } from '../projects.js';
import { SOURCE_TYPES, type SourceType, parseSourceConfig } from '../sources.js';
import { textSearchConfigFor } from '../text-search.js';
import { recountProject, replaceDocument } from '../vector-store.js';
import {
  DOCUMENTS_ENTRY,
  ImportRefusedError,
  MANIFEST_ENTRY,
  Manifest,
  SOURCES_ENTRY,
  checkManifest,
  dataPrefixFor,
  describeNeeds,
} from './manifest.js';
import { schemaFacts, instanceId } from './export.js';

/**
 * Reading a project export back in ([ADR-0051](../../../.ssot/ADR.md#adr-0051)).
 *
 * **An uploaded tarball is the largest untrusted-input surface this product has**, and nothing in this
 * file unpacks one. The archive is expanded by `unpackTar` and the document trees inside it are copied
 * into `DATA_DIR` by `importTree` — the extractor the upload route has used since the beginning,
 * carrying the entry cap, the total and per-file size caps, the extension filter, the dot-directory
 * skip, the Windows-portable name check and the `isInside` containment. A second implementation of any
 * of those is the one that would get the traversal check wrong.
 *
 * **Four of the five refusals happen before anything is written**, and the fifth cannot. The manifest
 * is read first and checked first, so a wrong model, a wrong dimension, an unreadable manifest format
 * and a too-new schema all stop the import with no project row, no source row and no files on disk.
 *
 * **The fifth is the one that makes the rest of this function's shape necessary.** A manifest is a
 * *claim* about bytes, and the bytes are the untrusted part: a hand-edited tarball can say 384 and
 * carry 768, and only the per-chunk re-check in `writeDocuments` can see that. By then the project
 * row, its sources and its carried files exist. So the whole write phase is unwound on any failure —
 * `discardPartialImport` below — because a refusal that fires late and a refusal that fires early must
 * look the same from outside, and "look the same" means *leave the same nothing behind*. That property
 * is asserted, not reasoned about: `test/integration/project-transfer.itest.ts` censuses every table
 * an import can write and every directory it can create, around each of the refusals.
 *
 * The import is memory-bounded but not stream-only: the tarball is expanded to a scratch directory and
 * `documents.ndjson` is then read a line at a time. Streaming was the *export's* requirement, because
 * that is the side that must not hold a corpus in memory; the import holds one document at a time and
 * one copy of the tarball on disk, which the runbook states.
 */

/** A single NDJSON line longer than this is refused rather than buffered. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** The manifest is read whole; a "manifest" larger than this is not one. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

const ImportedSource = z.object({
  type: z.enum(SOURCE_TYPES),
  name: z.string().min(1).max(63),
  label: z.string().max(500).default(''),
  config: z.record(z.string(), z.unknown()).default({}),
  flavor: z.string().max(64).default('plain'),
  syncIntervalMinutes: z.number().int().nullable().default(null),
  webhookMinIntervalMinutes: z.number().int().min(1).max(43_200).nullable().default(null),
});

const ImportedChunk = z.object({
  chunkIndex: z.number().int().min(0),
  headingPath: z.string().default(''),
  content: z.string(),
  tokenCount: z.number().int().min(0),
  embedding: z.array(z.number()),
});

const ImportedDocument = z.object({
  sourceName: z.string().max(63).nullable(),
  relativePath: z.string().min(1).max(4096),
  title: z.string().max(2048),
  contentHash: z.string().max(200),
  sizeBytes: z.number().int().min(0),
  content: z.string().nullable(),
  contentTruncated: z.boolean(),
  indexedAt: z.string(),
  chunks: z.array(ImportedChunk),
});

/** What the operator is told happened, including everything that did not. */
export interface ImportReport {
  projectId: string;
  projectName: string;
  manifest: Manifest;
  documents: number;
  chunks: number;
  sources: Array<{ name: string; type: SourceType; files: number; needs: string }>;
  /**
   * The memberships question, answered out loud rather than left to be discovered by an operator
   * wondering why a project arrived that nobody can see.
   */
  memberships: { carried: 0; sourceHad: { viewer: number; editor: number }; note: string };
  mcpTokens: { carried: 0; sourceHad: number; note: string };
  /** True when this tarball came from this very instance — legitimate, and worth saying. */
  sameInstance: boolean;
}

export interface ImportDeps {
  db: Db;
  config: Config;
  embeddings: { id: string; dimensions: number };
  /**
   * Optional, and there for exactly one line: the case where unwinding a failed import **itself**
   * fails. That leaves rows an operator has to delete by hand, and it is the only outcome of this
   * whole path that nothing else would report.
   */
  log?: Logger;
}

/**
 * Imports `archivePath` as a new project.
 *
 * `name` overrides the exported name, which is how two copies of one project live on one instance and
 * how a collision is resolved; without it the exported name is used and a collision is a `409`.
 */
export async function importProject(deps: ImportDeps, archivePath: string, name?: string): Promise<ImportReport> {
  const { db, config } = deps;
  const limits: ImportLimits = {
    maxEntries: config.ARCHIVE_MAX_ENTRIES,
    maxTotalBytes: config.ARCHIVE_MAX_TOTAL_BYTES,
    maxFileBytes: config.UPLOAD_MAX_FILE_BYTES,
    // The extension filter that applies to the carried trees is the *source's* own, read from its
    // config below. This one covers the unpack, where nothing is being decided about a document yet.
    extensions: [],
    flavor: 'plain',
  };

  return withScratch(async (scratch) => {
    await unpackTar(archivePath, scratch, limits);

    const manifest = await readManifest(path.join(scratch, MANIFEST_ENTRY));
    checkManifest(manifest, {
      embeddingId: deps.embeddings.id,
      embeddingDimensions: deps.embeddings.dimensions,
      migrations: (await schemaFacts(db)).migrations,
    });

    const sources = await readSources(path.join(scratch, SOURCES_ENTRY));
    // Every document names the source it belongs to by the prefix of its own path, so a tarball whose
    // two halves disagree is refused before a project exists rather than landing documents with no source.
    const byName = new Map(sources.map((s) => [s.name, s]));

    // Everything from here on writes. `createProject` is deliberately outside the unwind: a name
    // collision throws from inside it, having written nothing, and there is no project id to unwind.
    const project = await createProject(db, { name: name ?? manifest.project.name }, config.ALLOWED_DOC_ROOTS);

    try {
      return await landProject(deps, { scratch, manifest, sources, byName, project, name });
    } catch (err) {
      await discardPartialImport(deps, project.id, err);
      throw err;
    }
  });
}

/** What `importProject` does once a project row exists — every line of it undone if any line throws. */
async function landProject(
  deps: ImportDeps,
  ctx: {
    scratch: string;
    manifest: Manifest;
    sources: Array<z.infer<typeof ImportedSource>>;
    byName: Map<string, z.infer<typeof ImportedSource>>;
    project: { id: string; name: string };
    name?: string;
  },
): Promise<ImportReport> {
  const { db } = deps;
  const { scratch, manifest, sources, byName, project } = ctx;

  const created = new Map<string, { id: string; type: SourceType; config: Record<string, unknown> }>();
  for (const source of sources) {
    const row = await insertImportedSource(db, project.id, source);
    created.set(source.name, { id: row.id, type: row.type as SourceType, config: row.config });
  }

  const carried = await carryUploadTrees(deps, scratch, project.id, sources, created);
  const written = await writeDocuments(deps, project.id, path.join(scratch, DOCUMENTS_ENTRY), byName, created);

  const counts = await recountProject(db, project.id, 0);
  await db
    .update(projects)
    .set({
      // Renumbered to 0, which is the whole of [ADR-0039](../../../.ssot/ADR.md#adr-0039)'s reason:
      // a generation number is instance-local and load-bearing in every search predicate, so a
      // project that arrived carrying "7" would be a project whose live generation is a number this
      // instance never wrote.
      liveGeneration: 0,
      chunkCount: counts.chunkCount,
      documentCount: counts.documentCount,
      embeddingModel: manifest.embedding?.id ?? null,
      mcpAuth: manifest.project.mcpAuth,
      queryLogEnabled: manifest.project.queryLogEnabled,
      // A true statement about the corpus: this text was indexed then, on another machine.
      lastIndexedAt: manifest.project.lastIndexedAt ? new Date(manifest.project.lastIndexedAt) : null,
      status: 'idle',
      lastError: null,
    })
    .where(eq(projects.id, project.id));

  for (const source of sources) {
    const id = created.get(source.name);
    if (!id) continue;
    await db
      .update(documentSources)
      .set({ documentCount: written.perSource.get(source.name) ?? 0 })
      .where(eq(documentSources.id, id.id));
  }

  const members = manifest.excluded.projectMembers;
  return {
    projectId: project.id,
    projectName: project.name,
    manifest,
    documents: written.documents,
    chunks: written.chunks,
    sources: sources.map((s) => ({
      name: s.name,
      type: s.type,
      files: carried.get(s.name) ?? 0,
      needs: describeNeeds(manifest.sources.find((m) => m.name === s.name)?.needs ?? []),
    })),
    memberships: {
      carried: 0,
      sourceHad: members,
      note:
        members.viewer + members.editor === 0
          ? 'The exported project had no members.'
          : `The exported project had ${members.viewer} viewer and ${members.editor} editor membership(s). None were carried: they name ` +
            'accounts of the instance the export came from, which either do not exist here or belong to different people. ' +
            'This project is currently reachable by root and admin accounts only — add members with ' +
            `PUT /api/projects/${project.id}/members/:userId.`,
    },
    mcpTokens: {
      carried: 0,
      sourceHad: manifest.excluded.mcpTokens,
      note:
        manifest.excluded.mcpTokens === 0
          ? 'The exported project had no MCP tokens.'
          : `${manifest.excluded.mcpTokens} MCP token(s) stayed behind: they are bearer credentials for the other instance's ` +
            `endpoint and only their hashes were ever stored. Mint new ones here${
              manifest.project.mcpAuth === 'token' ? ', which this project needs before any agent can reach it.' : '.'
            }`,
    },
    sameInstance: manifest.instance.id === (await instanceId(db)),
  };
}

/**
 * Undoes a landing that failed, so that a refusal which could only fire late leaves exactly what an
 * early one leaves: nothing.
 *
 * **One `DELETE` and one `rm`, because that is already the product's own definition of removing a
 * project.** `documents`, `chunks` and `document_sources` all cascade from `projects.id`, and
 * `removeProjectDir` is what `DELETE /api/projects/:id` calls; re-deriving either here would be a
 * second answer to a question that already has one.
 *
 * **Not a transaction, and the reason is the filesystem.** Wrapping the landing in one would make the
 * database half atomic and do nothing at all for the carried upload trees, so a compensating action is
 * needed either way — and then the transaction is a second mechanism covering a subset of what the
 * first already covers, at the price of holding write locks and a growing WAL for the length of a
 * whole corpus import, on the one path that writes a whole corpus. `replaceDocument` stays
 * per-document transactional, as the indexer has it.
 *
 * **What this does not cover, stated rather than discovered: a process that dies mid-import.** That
 * leaves a project row and its directory behind. It is visible in the dashboard and deletable from it,
 * which is the difference that matters — the failure this whole function exists to prevent is a
 * project that is *wrong*, not one that is obviously unfinished. (`sweepOrphanDirs` will not collect
 * the directory, because it collects directories whose project row is *gone*.)
 *
 * The original failure is always what the caller sees. A cleanup that fails itself is logged at
 * `error` naming the project id, because it is the only outcome here that leaves an operator with
 * something to do and nothing else would tell them.
 */
async function discardPartialImport(deps: ImportDeps, projectId: string, cause: unknown): Promise<void> {
  try {
    await deps.db.delete(projects).where(eq(projects.id, projectId));
  } catch (err) {
    deps.log?.error({ err, cause, projectId }, 'a project import failed and could not be unwound; delete this project by hand — it is incomplete');
    return;
  }
  await removeProjectDir(deps.config.DATA_DIR, projectId).catch((err: unknown) => {
    // The rows are gone, so the tree is an orphan by `sweepOrphanDirs`'s own definition and the next
    // start collects it. Worth a line, not worth failing over.
    deps.log?.warn({ err, projectId }, 'could not remove the data directory of an import that was unwound');
  });
}

async function readManifest(file: string): Promise<Manifest> {
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_MANIFEST_BYTES) throw new ImportRefusedError('manifest_too_large', 'This file carries a manifest that is not one.');
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof ImportRefusedError) throw err;
    throw new ImportRefusedError(
      'not_an_export',
      `This archive has no ${MANIFEST_ENTRY} at its root, so it is not a Contextator project export. ` +
        'A project export is the file GET /api/projects/:id/export produces.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ImportRefusedError('not_an_export', `${MANIFEST_ENTRY} is not valid JSON.`);
  }
  const result = Manifest.safeParse(parsed);
  if (!result.success) {
    throw new ImportRefusedError('not_an_export', `${MANIFEST_ENTRY} is not a project export manifest: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

async function readSources(file: string): Promise<Array<z.infer<typeof ImportedSource>>> {
  const out: Array<z.infer<typeof ImportedSource>> = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  for await (const line of lines(file)) {
    lineNumber++;
    const result = ImportedSource.safeParse(parseLine(SOURCES_ENTRY, lineNumber, line));
    if (!result.success) throw new ImportRefusedError('bad_source', `${SOURCES_ENTRY}:${lineNumber}: ${z.prettifyError(result.error)}`);
    if (seen.has(result.data.name)) throw new ImportRefusedError('bad_source', `${SOURCES_ENTRY}: two sources named "${result.data.name}".`);
    seen.add(result.data.name);
    out.push(result.data);
  }
  return out;
}

/**
 * Inserts one imported source.
 *
 * **The config goes through `parseSourceConfig`**, which is the same zod schema the create and update
 * routes use: it fills defaults, rejects the wrong shape and strips every key the type's schema does
 * not name — so a hand-edited tarball cannot put arbitrary jsonb into a row the dashboard renders and
 * a driver reads.
 *
 * **What it deliberately does not do is re-run `resolveProjectRoot` against `ALLOWED_DOC_ROOTS`.** A
 * `local` source names a directory of the machine the export came from, and the honest outcomes are to
 * refuse the whole import over one source, to throw the path away, or to keep it and let the operator
 * decide. It is kept — because nothing reads it on the strength of this row: `LocalDriver.docRoot()`
 * resolves the path against this instance's allowlist on **every** sync, every probe and every
 * connection test, so an unreadable path is an error at the moment of reading rather than a privilege
 * this row conferred. The import's report names the source and says to check it.
 *
 * **Scheduling is off, whatever the source had at home.** [NFR-10](../../../.ssot/PRD.md) is that an
 * installation makes no outbound request an operator did not ask for, and an import is not that ask:
 * the credential did not travel, so every scheduled run would fail against somebody else's API on a
 * timer nobody on this instance set. It is one `PATCH` to switch back on, and FR-319 set the precedent
 * — an upgrade switches nothing on either.
 *
 * `secret_enc` and `webhook_secret` are absent for the reasons the export gave: one is encrypted under
 * a key belonging to another instance, and the other authenticates deliveries to an instance that did
 * not move. A git source is **not** given a fresh generated webhook secret here, because a secret
 * nobody has pasted into a repository is a secret that means nothing; the regenerate route mints one
 * when the operator is ready to carry it across.
 */
async function insertImportedSource(
  db: Db,
  projectId: string,
  source: z.infer<typeof ImportedSource>,
): Promise<{ id: string; type: string; config: Record<string, unknown> }> {
  const flavor = source.flavor as Flavor;
  if (!FLAVORS.includes(flavor)) throw new ImportRefusedError('bad_source', `${SOURCES_ENTRY}: unknown flavor "${source.flavor}".`);
  let config: Record<string, unknown>;
  try {
    config = parseSourceConfig(source.type, source.config) as Record<string, unknown>;
  } catch (err) {
    throw new ImportRefusedError('bad_source', `${SOURCES_ENTRY}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const [row] = await db
    .insert(documentSources)
    .values({
      projectId,
      type: source.type,
      name: source.name,
      label: source.label,
      flavor,
      config,
      secretEnc: null,
      webhookSecret: null,
      syncIntervalMinutes: null,
      nextSyncAt: null,
      webhookMinIntervalMinutes: source.webhookMinIntervalMinutes,
    })
    .returning({ id: documentSources.id, type: documentSources.type, config: documentSources.config });
  return row;
}

/**
 * Copies the carried `upload` trees into this instance's `DATA_DIR`, through `importTree`.
 *
 * The limits handed to it are this instance's own — `ARCHIVE_MAX_ENTRIES`, `ARCHIVE_MAX_TOTAL_BYTES`,
 * `UPLOAD_MAX_FILE_BYTES` — and the extension filter is the **destination source's** own
 * `config.extensions`, not the exporter's claim about them, so a tarball cannot widen what this
 * instance is willing to store by saying so in a file.
 */
async function carryUploadTrees(
  deps: ImportDeps,
  scratch: string,
  projectId: string,
  sources: ReadonlyArray<z.infer<typeof ImportedSource>>,
  created: Map<string, { id: string; type: SourceType; config: Record<string, unknown> }>,
): Promise<Map<string, number>> {
  const carried = new Map<string, number>();
  for (const source of sources) {
    if (source.type !== 'upload') continue;
    const target = created.get(source.name);
    if (!target) continue;
    const from = path.join(scratch, dataPrefixFor(source.name));
    if (!(await fs.stat(from).catch(() => null))) continue;
    const extensions = Array.isArray(target.config.extensions) ? (target.config.extensions as string[]) : [];
    const stats = await importTree(from, sourceCurrentDir(deps.config.DATA_DIR, projectId, target.id), {
      maxEntries: deps.config.ARCHIVE_MAX_ENTRIES,
      maxTotalBytes: deps.config.ARCHIVE_MAX_TOTAL_BYTES,
      maxFileBytes: deps.config.UPLOAD_MAX_FILE_BYTES,
      extensions,
      // `plain`, not the source's flavor: the tree in the tarball is the *materialised* tree, whose
      // paths a flavor has already been applied to once. Applying it twice would rename what the
      // documents in the same file point at.
      flavor: 'plain',
    });
    carried.set(source.name, stats.files);
  }
  return carried;
}

/**
 * Writes the documents, one line at a time, into generation 0.
 *
 * Through `replaceDocument` and not through a hand-written insert: it is the function the indexer uses,
 * it writes `content_tsv` with the source's own text search configuration
 * ([ADR-0041](../../../.ssot/ADR.md#adr-0041)) in the same statement as the row, and a second writer
 * would be a second place for the lexical half of retrieval to be forgotten. That also means the
 * tarball does not carry `content_tsv` at all: it is a pure function of two columns that are in the
 * file, and re-deriving it here is what makes an import into an instance with a different PostgreSQL
 * text search configuration land correctly rather than carrying the exporter's.
 */
async function writeDocuments(
  deps: ImportDeps,
  projectId: string,
  file: string,
  byName: Map<string, z.infer<typeof ImportedSource>>,
  created: Map<string, { id: string; type: SourceType; config: Record<string, unknown> }>,
): Promise<{ documents: number; chunks: number; perSource: Map<string, number> }> {
  let documents = 0;
  let chunks = 0;
  const perSource = new Map<string, number>();

  let lineNumber = 0;
  for await (const line of lines(file)) {
    lineNumber++;
    const result = ImportedDocument.safeParse(parseLine(DOCUMENTS_ENTRY, lineNumber, line));
    if (!result.success) throw new ImportRefusedError('bad_document', `${DOCUMENTS_ENTRY}:${lineNumber}: ${z.prettifyError(result.error)}`);
    const doc = result.data;

    for (const chunk of doc.chunks) {
      if (chunk.embedding.length !== deps.embeddings.dimensions) {
        throw new ImportRefusedError(
          'dimension_mismatch',
          `"${doc.relativePath}" carries a ${chunk.embedding.length}-dimensional vector and this instance stores ` +
            `${deps.embeddings.dimensions}-dimensional ones. The manifest said otherwise, which makes this file inconsistent with itself.`,
        );
      }
    }

    const source = doc.sourceName ? created.get(doc.sourceName) : undefined;
    if (doc.sourceName && !source) {
      throw new ImportRefusedError(
        'unknown_source',
        `"${doc.relativePath}" belongs to a source called "${doc.sourceName}", which ${SOURCES_ENTRY} does not list.`,
      );
    }
    const language = doc.sourceName ? (byName.get(doc.sourceName)?.config as { language?: unknown } | undefined)?.language : undefined;

    await replaceDocument(
      deps.db,
      {
        projectId,
        sourceId: source?.id ?? null,
        relativePath: doc.relativePath,
        title: doc.title,
        contentHash: doc.contentHash,
        sizeBytes: doc.sizeBytes,
        indexGeneration: 0,
        content: doc.content,
        contentTruncated: doc.contentTruncated,
      },
      doc.chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        headingPath: c.headingPath,
        content: c.content,
        tokenCount: c.tokenCount,
        embedding: c.embedding,
      })),
      textSearchConfigFor(language),
    );
    documents++;
    chunks += doc.chunks.length;
    if (doc.sourceName) perSource.set(doc.sourceName, (perSource.get(doc.sourceName) ?? 0) + 1);
  }

  return { documents, chunks, perSource };
}

/**
 * The lines of an NDJSON file, with a cap that is enforced **while** the line is being assembled.
 *
 * That is the point of writing the splitter rather than reaching for `readline`, which will happily
 * accumulate a "line" the size of the disk: a file whose first byte is `{` and which never carries a
 * newline is the cheapest denial of service an upload can express, and a cap checked after the line
 * exists is a cap that has already been paid.
 *
 * A missing file is an empty iteration — an export with no sources has an empty `sources.ndjson`, and
 * an export of a project that has never been indexed an empty `documents.ndjson`.
 */
async function* lines(file: string): AsyncGenerator<string> {
  if (!(await fs.stat(file).catch(() => null))) return;

  let pending = '';
  const stream = createReadStream(file, { encoding: 'utf8' });
  try {
    for await (const piece of stream) {
      pending += piece as string;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim() !== '') yield line;
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_LINE_BYTES) {
        throw new ImportRefusedError('line_too_long', `${path.basename(file)} has a line longer than ${MAX_LINE_BYTES} bytes.`);
      }
    }
  } finally {
    stream.destroy();
  }
  if (pending.trim() !== '') yield pending;
}

/** `JSON.parse`, with the file and the line number in the failure instead of `Unexpected token`. */
function parseLine(file: string, lineNumber: number, line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new ImportRefusedError('bad_line', `${file}:${lineNumber}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
}
