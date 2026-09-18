import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { projects, type DocumentSourceRow } from '../db/schema.js';
import { chunkMarkdown, embeddingText } from './chunker.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { transformContent, type Flavor } from './flavors.js';
import { readAndHash, walkMarkdown } from './fs-scan.js';
import { recordIndexRun } from './index-runs.js';
import type { KeyedMutex } from './locks.js';
import { getProjectById } from './projects.js';
import { driverFor } from './sources/driver.js';
import { listSources, recountSources, setSourceStatus } from './sources.js';
import { deleteAllDocuments, deleteDocuments, getExistingDocuments, recountProject, replaceDocument, type NewChunk } from './vector-store.js';

export type JobPhase = 'queued' | 'syncing' | 'scanning' | 'embedding' | 'finalizing' | 'done' | 'error';

export interface JobSourceState {
  id: string;
  name: string;
  type: string;
  status: 'pending' | 'syncing' | 'synced' | 'error';
  error?: string;
  note?: string;
}

export interface JobState {
  projectId: string;
  force: boolean;
  phase: JobPhase;
  filesTotal: number;
  filesDone: number;
  filesSkipped: number;
  /** Documents deleted because their file disappeared or became empty. */
  filesRemoved: number;
  chunksDone: number;
  /** Per-source sync outcome of this run. */
  sources: JobSourceState[];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** Where a queued job stands: `position` 0 = next up; `runningProjectId` = the job it waits for, if any. */
export interface QueueInfo {
  position: number;
  runningProjectId: string | null;
}

export interface IndexerDeps {
  db: Db;
  embeddings: EmbeddingProvider;
  config: Pick<
    Config,
    'ALLOWED_DOC_ROOTS' | 'IGNORE_GLOBS' | 'CHUNK_MAX_TOKENS' | 'CHUNK_OVERLAP_TOKENS' | 'EMBEDDING_BATCH_SIZE' | 'DATA_DIR' | 'SECRET_KEY'
  >;
  log: Logger;
  locks: KeyedMutex;
}

const ACTIVE_PHASES: ReadonlySet<JobPhase> = new Set(['queued', 'syncing', 'scanning', 'embedding', 'finalizing']);

interface SourceFile {
  /** `<source>/<path inside the source>` */
  relativePath: string;
  absolutePath: string;
  sourceId: string;
  flavor: Flavor;
}

/**
 * In-process indexing queue. Projects are processed one at a time (embedding is CPU bound).
 * Each run first syncs every source of the project (git fetch, Notion pull; no-op for local and
 * upload sources), then scans all of them. Incremental: unchanged files (same sha256) are skipped,
 * changed files are re-chunked and re-embedded, files removed from disk are deleted. `force`
 * (or a changed embedding model) wipes the project first.
 */
export class Indexer {
  private readonly jobs = new Map<string, JobState>();
  private readonly queue: string[] = [];
  private running = false;
  /** Project whose job is being processed right now. */
  private current: string | null = null;

  constructor(private readonly deps: IndexerDeps) {}

  enqueue(projectId: string, opts: { force?: boolean } = {}): JobState {
    const existing = this.jobs.get(projectId);
    if (existing && ACTIVE_PHASES.has(existing.phase)) {
      if (opts.force && existing.phase === 'queued') existing.force = true;
      return existing;
    }
    const job: JobState = {
      projectId,
      force: Boolean(opts.force),
      phase: 'queued',
      filesTotal: 0,
      filesDone: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      chunksDone: 0,
      sources: [],
      queuedAt: new Date().toISOString(),
    };
    this.jobs.set(projectId, job);
    this.queue.push(projectId);
    void this.runLoop();
    return job;
  }

  getJob(projectId: string): JobState | undefined {
    return this.jobs.get(projectId);
  }

  /** Only meaningful while the project's job is `queued`; `undefined` otherwise. */
  queueInfo(projectId: string): QueueInfo | undefined {
    const position = this.queue.indexOf(projectId);
    if (position === -1) return undefined;
    return { position, runningProjectId: this.current };
  }

  isBusy(projectId: string): boolean {
    const job = this.jobs.get(projectId);
    return Boolean(job && ACTIVE_PHASES.has(job.phase));
  }

  forget(projectId: string): void {
    this.jobs.delete(projectId);
  }

  private async runLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const projectId = this.queue.shift()!;
        const job = this.jobs.get(projectId);
        if (!job) continue;
        this.current = projectId;
        try {
          await this.indexProject(job);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Persists a finished job to `index_runs`; failures are logged and never affect the indexing result. */
  private async recordRun(job: JobState, log: Logger): Promise<void> {
    if (job.phase !== 'done' && job.phase !== 'error') return;
    try {
      await recordIndexRun(this.deps.db, { ...job, phase: job.phase });
    } catch (err) {
      log.error({ err }, 'failed to record index run');
    }
  }

  /**
   * Syncs one source and collects its files. A failed sync still scans whatever is materialised
   * (e.g. the previous git checkout); only when nothing can be scanned are the source's documents
   * protected from deletion, so a transient error never wipes a source.
   */
  private async collectSource(source: DocumentSourceRow, state: JobSourceState, files: SourceFile[], log: Logger): Promise<{ scanned: boolean }> {
    const { db, config } = this.deps;
    const flavor = source.flavor as Flavor;
    const extensions = (source.config as { extensions?: string[] }).extensions;
    const driver = driverFor(source, { db, log, config });

    let syncError: string | undefined;
    let configPatch: Record<string, unknown> | undefined;
    state.status = 'syncing';
    await setSourceStatus(db, source.id, { status: 'syncing' });
    try {
      const result = await driver.sync();
      configPatch = result.configPatch;
      state.note = result.note;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      log.error({ err, source: source.name }, 'source sync failed');
    }

    let scanned = false;
    try {
      const root = await driver.docRoot();
      for await (const f of walkMarkdown(root, { ignoreGlobs: config.IGNORE_GLOBS, extensions })) {
        // Stored paths always equal on-disk paths (flavor path cleanup happens when files are written, see uploads.ts).
        files.push({
          relativePath: `${source.name}/${f.relativePath}`,
          absolutePath: f.absolutePath,
          sourceId: source.id,
          flavor,
        });
      }
      scanned = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      syncError = syncError ? `${syncError}; ${message}` : message;
      log.error({ err, source: source.name }, 'source scan failed');
    }

    if (syncError) {
      state.status = 'error';
      state.error = syncError;
      await setSourceStatus(db, source.id, { status: 'error', lastError: syncError.slice(0, 2000) }).catch(() => undefined);
    } else {
      state.status = 'synced';
      await setSourceStatus(db, source.id, {
        status: 'idle',
        lastError: null,
        lastSyncedAt: new Date(),
        ...(configPatch ? { config: { ...source.config, ...configPatch } } : {}),
      });
    }
    return { scanned };
  }

  private async indexProject(job: JobState): Promise<void> {
    const { db, embeddings, config, locks } = this.deps;
    const log = this.deps.log.child({ projectId: job.projectId });
    job.phase = 'syncing';
    job.startedAt = new Date().toISOString();

    const project = await getProjectById(db, job.projectId);
    if (!project) {
      job.phase = 'error';
      job.error = 'Project no longer exists';
      job.finishedAt = new Date().toISOString();
      return;
    }

    await locks.runExclusive(project.id, async () => {
      await db.update(projects).set({ status: 'indexing', lastError: null }).where(eq(projects.id, project.id));
      log.info({ project: project.name, force: job.force }, 'indexing started');

      try {
        const modelChanged = project.embeddingModel !== null && project.embeddingModel !== embeddings.id;
        if (job.force || modelChanged) {
          if (modelChanged) log.warn({ from: project.embeddingModel, to: embeddings.id }, 'embedding model changed; full re-index');
          await deleteAllDocuments(db, project.id);
        }

        // 1. Sync every source and collect its files under the `<source>/` prefix.
        const sources = await listSources(db, project.id);
        job.sources = sources.map((s) => ({ id: s.id, name: s.name, type: s.type, status: 'pending' as const }));
        const files: SourceFile[] = [];
        const protectedSources = new Set<string>();
        for (const source of sources) {
          const state = job.sources.find((s) => s.id === source.id)!;
          const { scanned } = await this.collectSource(source, state, files, log);
          if (!scanned) protectedSources.add(source.id);
        }
        const failures = job.sources.filter((s) => s.status === 'error').map((s) => `${s.name}: ${s.error}`);

        // 2. Incremental embedding.
        job.phase = 'scanning';
        const existing = await getExistingDocuments(db, project.id);
        job.filesTotal = files.length;
        job.phase = 'embedding';

        const seen = new Set<string>();
        for (const file of files) {
          seen.add(file.relativePath);
          const { content, hash, sizeBytes } = await readAndHash(file.absolutePath);
          const previous = existing.get(file.relativePath);
          if (previous && previous.contentHash === hash && previous.sourceId === file.sourceId) {
            job.filesSkipped++;
            job.filesDone++;
            continue;
          }

          const { title, chunks } = chunkMarkdown(transformContent(file.flavor, content), file.relativePath, {
            maxTokens: config.CHUNK_MAX_TOKENS,
            overlapTokens: config.CHUNK_OVERLAP_TOKENS,
          });

          if (chunks.length === 0) {
            // Empty document: make sure no stale row lingers (`seen.delete` makes it count as removed below).
            if (previous) await deleteDocuments(db, project.id, [file.relativePath]);
            seen.delete(file.relativePath);
            job.filesDone++;
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

          await replaceDocument(
            db,
            { projectId: project.id, sourceId: file.sourceId, relativePath: file.relativePath, title, contentHash: hash, sizeBytes },
            rows,
          );
          job.filesDone++;
          job.chunksDone += rows.length;
          log.debug({ file: file.relativePath, chunks: rows.length }, 'document indexed');
        }

        // 3. Delete what disappeared, except documents of sources that could not be scanned at all.
        const removed = [...existing.entries()].filter(([p, d]) => !seen.has(p) && !(d.sourceId && protectedSources.has(d.sourceId))).map(([p]) => p);
        job.filesRemoved = removed.length;
        if (removed.length > 0) {
          await deleteDocuments(db, project.id, removed);
          log.info({ count: removed.length }, 'removed documents no longer on disk');
        }

        // 4. Finalize.
        job.phase = 'finalizing';
        const counts = await recountProject(db, project.id);
        await recountSources(db, project.id);
        const error = failures.length ? `${job.sources.length - failures.length}/${job.sources.length} sources synced; ${failures.join('; ')}` : null;
        await db
          .update(projects)
          .set({
            status: error ? 'error' : 'idle',
            chunkCount: counts.chunkCount,
            documentCount: counts.documentCount,
            lastIndexedAt: new Date(),
            embeddingModel: embeddings.id,
            lastError: error ? error.slice(0, 2000) : null,
          })
          .where(eq(projects.id, project.id));

        job.phase = error ? 'error' : 'done';
        if (error) job.error = error;
        job.finishedAt = new Date().toISOString();
        log.info(
          {
            project: project.name,
            sources: job.sources.length,
            failedSources: failures.length,
            files: job.filesTotal,
            skipped: job.filesSkipped,
            removed: job.filesRemoved,
            chunksWritten: job.chunksDone,
            ...counts,
          },
          error ? 'indexing finished with source errors' : 'indexing finished',
        );
        await this.recordRun(job, log);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.phase = 'error';
        job.error = message;
        job.finishedAt = new Date().toISOString();
        log.error({ err, project: project.name }, 'indexing failed');
        await db
          .update(projects)
          .set({ status: 'error', lastError: message.slice(0, 2000) })
          .where(eq(projects.id, project.id))
          .catch((updateErr: unknown) => log.error({ err: updateErr }, 'failed to record indexing error'));
        await this.recordRun(job, log);
      }
    });
  }
}
