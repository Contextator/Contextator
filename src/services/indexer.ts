import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { projects, type DocumentSourceRow } from '../db/schema.js';
import { chunkReserveTokens } from './chunk-budget.js';
import { chunkMarkdown, embeddingText } from './chunker.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { transformContent, type Flavor } from './flavors.js';
import { readAndHash, walkMarkdown } from './fs-scan.js';
import { recordIndexRun } from './index-runs.js';
import type { KeyedMutex } from './locks.js';
import { getProjectById } from './projects.js';
import { driverFor } from './sources/driver.js';
import { listSources, recountSources, setSourceStatus, sourceVersion } from './sources.js';
import { textSearchConfigFor, type TextSearchConfig } from './text-search.js';
import {
  deleteDocuments,
  getExistingDocuments,
  recountProject,
  replaceDocument,
  storedDocumentContent,
  sweepGenerations,
  type NewChunk,
} from './vector-store.js';

export type JobPhase = 'queued' | 'syncing' | 'scanning' | 'embedding' | 'finalizing' | 'done' | 'error';

/**
 * What asked for a run, and — because the two are the same question — which of the queue's two lanes
 * it waits in ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
 *
 * `manual` and `webhook` are **interactive**: somebody or something is waiting for the answer. A
 * person pressed a button, edited a source, committed an upload, or pushed to a branch and expects
 * the index to follow within the minute. `scheduled` is not: nothing is waiting, and a scheduled run
 * that starts twenty minutes late is a run that started.
 */
export type IndexTrigger = 'manual' | 'webhook' | 'scheduled';

export interface EnqueueOptions {
  /** A rebuild: write a new generation beside the live one ([ADR-0039](../../.ssot/ADR.md#adr-0039)). */
  force?: boolean;
  /** Defaults to `manual`, which is what every caller that does not say is. */
  trigger?: IndexTrigger;
}

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
  /** What asked for this run; also the lane it queued in. Promoted when a person overtakes a timer. */
  trigger: IndexTrigger;
  phase: JobPhase;
  /**
   * The generation a **rebuild** writes into, set once the run knows it is one; `undefined` for an
   * incremental run, which writes into whatever generation is already live (ADR-0039).
   */
  generation?: number;
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
    | 'ALLOWED_DOC_ROOTS'
    | 'IGNORE_GLOBS'
    | 'CHUNK_MAX_TOKENS'
    | 'CHUNK_OVERLAP_TOKENS'
    | 'EMBEDDING_BATCH_SIZE'
    | 'DATA_DIR'
    | 'SECRET_KEY'
    | 'MAX_STORED_DOCUMENT_BYTES'
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
  /**
   * The PostgreSQL text search configuration this file's chunks are indexed with — its source's
   * optional `language`, `simple` when unset ([ADR-0041](../../.ssot/ADR.md#adr-0041)). It is carried
   * on the file rather than looked up at write time because a run holds files from several sources and
   * `replaceDocument` is given one document at a time.
   */
  textSearchConfig: TextSearchConfig;
  /**
   * The release label this file's document is stamped with — its source's `config.version`, `''` when
   * the source carries none ([ADR-0058](../../.ssot/ADR.md#adr-0058)). Carried on the file for
   * `textSearchConfig`'s reason, one field up: a run holds files from several sources and each of them
   * may be a different release of the same product, which is the situation this exists for.
   */
  version: string;
}

/**
 * In-process indexing queue. Projects are processed one at a time (embedding is CPU bound).
 * Each run first syncs every source of the project (git fetch, Notion pull; no-op for local and
 * upload sources), then scans all of them. Incremental: unchanged files (same sha256) are skipped,
 * changed files are re-chunked and re-embedded, files removed from disk are deleted — all of it
 * inside the project's live generation, exactly as before ([ADR-0010](../../.ssot/ADR.md#adr-0010)).
 *
 * `force` (or a changed embedding model) is a **rebuild**: it writes a new generation beside the live
 * one and makes it live in one row update when it is complete ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
 * Nothing is deleted first, so a client talking to the project is served the previous index for the
 * whole of the run, and a run that dies halfway leaves that index serving.
 */
export class Indexer {
  private readonly jobs = new Map<string, JobState>();
  /**
   * **Two lanes, not two queues with a scheduler between them** ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
   *
   * The serial queue's failure mode under a timer is not length — `enqueue` already collapses to one
   * job per project, so the queue can never be longer than the number of projects — it is *ordering*.
   * A person pressing "Re-index" behind fifty scheduled runs waits for fifty runs, and that is the
   * whole of what makes a scheduler feel like a regression.
   *
   * So the drain is `interactive` first, `scheduled` only when `interactive` is empty. It is strict
   * priority and not a weighted share, because there is no starvation to weigh against: interactive
   * work arrives when a human does something, and scheduled work that waits an hour is scheduled work
   * that ran. The pathological case — a person re-indexing continuously for hours — is a person who
   * is, by construction, keeping the index fresher than the timer would have.
   */
  private readonly interactive: string[] = [];
  private readonly scheduled: string[] = [];
  private running = false;
  /** Project whose job is being processed right now. */
  private current: string | null = null;

  constructor(private readonly deps: IndexerDeps) {}

  enqueue(projectId: string, opts: EnqueueOptions = {}): JobState {
    const trigger = opts.trigger ?? 'manual';
    const existing = this.jobs.get(projectId);
    if (existing && ACTIVE_PHASES.has(existing.phase)) {
      if (opts.force && existing.phase === 'queued') existing.force = true;
      // **Promotion, and it is the reason collapsing is safe.** Without it the collapse would be a
      // trap: a scheduled run queued a minute ago behind forty others would swallow the button press
      // that was supposed to overtake them and return a job that still waits in the slow lane. A
      // queued scheduled job therefore moves lanes when a person or a push asks for the same project.
      // One direction only — nothing ever demotes an interactive job — and only while it is `queued`,
      // because a job that has started is already at the front of everything.
      if (existing.phase === 'queued' && trigger !== 'scheduled' && existing.trigger === 'scheduled') {
        const at = this.scheduled.indexOf(projectId);
        if (at !== -1) {
          this.scheduled.splice(at, 1);
          this.interactive.push(projectId);
        }
        existing.trigger = trigger;
      }
      return existing;
    }
    const job: JobState = {
      projectId,
      force: Boolean(opts.force),
      trigger,
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
    this.laneFor(trigger).push(projectId);
    void this.runLoop();
    return job;
  }

  private laneFor(trigger: IndexTrigger): string[] {
    return trigger === 'scheduled' ? this.scheduled : this.interactive;
  }

  getJob(projectId: string): JobState | undefined {
    return this.jobs.get(projectId);
  }

  /**
   * Only meaningful while the project's job is `queued`; `undefined` otherwise.
   *
   * The position is over both lanes as the drain will actually take them, so the dashboard's "3 jobs
   * ahead of you" stays a count of jobs that really do run first.
   */
  queueInfo(projectId: string): QueueInfo | undefined {
    const interactiveAt = this.interactive.indexOf(projectId);
    if (interactiveAt !== -1) return { position: interactiveAt, runningProjectId: this.current };
    const scheduledAt = this.scheduled.indexOf(projectId);
    if (scheduledAt === -1) return undefined;
    return { position: this.interactive.length + scheduledAt, runningProjectId: this.current };
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
      for (;;) {
        // Re-read both lanes on every iteration rather than snapshotting: a promotion can move a
        // project between them while the run before it is still going.
        const projectId = this.interactive.shift() ?? this.scheduled.shift();
        if (projectId === undefined) break;
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
   * Drops every generation of a project that is not `liveGeneration` — the one a swap superseded, and
   * any that were abandoned. Always best effort: reclaiming disk is not what a run is for, and a
   * failure here must never turn a successful index into a failed one ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
   *
   * Always called with the project's mutex held, so it cannot race the run that is writing.
   */
  private async sweep(projectId: string, liveGeneration: number, log: Logger): Promise<void> {
    try {
      const removed = await sweepGenerations(this.deps.db, projectId, liveGeneration);
      if (removed > 0) log.info({ removed, liveGeneration }, 'reclaimed documents of superseded index generations');
    } catch (err) {
      log.warn({ err, liveGeneration }, 'could not reclaim superseded index generations; the next run will try again');
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
    const textSearchConfig = textSearchConfigFor((source.config as { language?: unknown }).language);
    const version = sourceVersion(source.config);
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
          textSearchConfig,
          version,
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
    // Bound once: the local provider answers off the tokenizer it holds, so the method needs its
    // receiver, and the chunker wants a plain function it can memoise.
    const countTokens = (text: string): number => embeddings.countTokens(text);
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
      // Re-read under the lock. `live_generation` is the one field this run both reads and writes, and
      // the row above was fetched before the mutex was held.
      const current = (await getProjectById(db, project.id)) ?? project;
      const live = current.liveGeneration;

      // Housekeeping before anything else, and under the same mutex: a previous run that was killed
      // between writing rows and swapping left a generation nobody will ever serve, and this is what
      // collects it (ADR-0039). Best effort — a project that cannot be tidied can still be indexed.
      await this.sweep(project.id, live, log);

      await db.update(projects).set({ status: 'indexing', lastError: null }).where(eq(projects.id, project.id));

      const modelChanged = current.embeddingModel !== null && current.embeddingModel !== embeddings.id;
      const rebuild = job.force || modelChanged;
      // A rebuild writes beside the live index; an incremental run writes into it. That single
      // choice is the whole of ADR-0039 at this layer — everything below reads `generation`.
      const generation = rebuild ? live + 1 : live;
      if (rebuild) job.generation = generation;
      if (modelChanged) log.warn({ from: current.embeddingModel, to: embeddings.id }, 'embedding model changed; full re-index');
      log.info({ project: project.name, force: job.force, rebuild, live, generation }, 'indexing started');

      try {
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

        // 1b. A rebuild that cannot see one of its sources cannot be published, so it is abandoned
        // here rather than embedded and then thrown away. The swap is all-or-nothing: the new
        // generation is the whole corpus, and a generation missing a source would go live as a
        // silent deletion of it. Copying the missing source's documents forward was considered and
        // rejected — it copies every vector, and it publishes stale content under a fresh generation
        // number that the run counters cannot describe (ADR-0039).
        //
        // `protectedSources` keeps its ADR-0010 meaning on the incremental path below, untouched.
        if (rebuild && protectedSources.size > 0) {
          const unscannable = sources.filter((source) => protectedSources.has(source.id)).map((source) => source.name);
          throw new Error(
            `Full re-index abandoned: ${unscannable.length} of ${sources.length} sources could not be read ` +
              `(${unscannable.join(', ')}). The previous index is still being served; fix the source and re-index.`,
          );
        }

        // 2. Incremental embedding, within the generation this run writes to. On a rebuild that
        // generation is empty, so nothing is skipped and every file is re-embedded — "force means
        // re-embed everything" falls out of the generation rather than being a branch.
        job.phase = 'scanning';
        const existing = await getExistingDocuments(db, project.id, generation);
        job.filesTotal = files.length;

        // The chunker counts with the model's own tokenizer (ADR-0036) and chunking happens before the
        // first `embed`, so the model has to be loaded before the loop rather than by it — otherwise the
        // first document of a run that beat the background warmup would be chunked against the estimate.
        // Idempotent: the pipeline is a process-wide singleton and this is one forward pass over one word.
        await embeddings.warmup();
        job.phase = 'embedding';

        // After warmup, so the prefix is counted by the model's tokenizer rather than estimated, and
        // once for the run rather than once per document.
        const reserveTokens = chunkReserveTokens(embeddings);

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

          // **One string, used twice, and that is the point of ADR-0043.** What is chunked and what is
          // stored are the same value — the flavor-transformed text — so `read_document` cannot come
          // to disagree with `search_docs` about what an Obsidian note says. Deriving it twice, or
          // storing `content` instead, is how that drift starts.
          const transformed = transformContent(file.flavor, content);
          const { title, chunks } = chunkMarkdown(transformed, file.relativePath, {
            maxTokens: config.CHUNK_MAX_TOKENS,
            overlapTokens: config.CHUNK_OVERLAP_TOKENS,
            // The model's own tokenizer, exact by the time this runs — nothing is indexed before the
            // pipeline has loaded — and the reserve for the special tokens it adds (ADR-0036) plus the
            // provider's passage prefix, which `embedPassages` will prepend (ADR-0038).
            countTokens,
            reserveTokens,
          });

          if (chunks.length === 0) {
            // Empty document: make sure no stale row lingers (`seen.delete` makes it count as removed below).
            if (previous) await deleteDocuments(db, project.id, generation, [file.relativePath]);
            seen.delete(file.relativePath);
            job.filesDone++;
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
              projectId: project.id,
              sourceId: file.sourceId,
              relativePath: file.relativePath,
              title,
              contentHash: hash,
              sizeBytes,
              indexGeneration: generation,
              version: file.version,
              ...storedDocumentContent(transformed, config.MAX_STORED_DOCUMENT_BYTES),
            },
            rows,
            file.textSearchConfig,
          );
          job.filesDone++;
          job.chunksDone += rows.length;
          log.debug({ file: file.relativePath, chunks: rows.length }, 'document indexed');
        }

        // 3. Delete what disappeared, except documents of sources that could not be scanned at all.
        // On a rebuild `existing` is empty by construction, so this whole step is a no-op there.
        const removed = [...existing.entries()].filter(([p, d]) => !seen.has(p) && !(d.sourceId && protectedSources.has(d.sourceId))).map(([p]) => p);
        job.filesRemoved = removed.length;
        if (removed.length > 0) {
          await deleteDocuments(db, project.id, generation, removed);
          log.info({ count: removed.length }, 'removed documents no longer on disk');
        }

        // 4. Finalize — and, on a rebuild, publish.
        job.phase = 'finalizing';
        const counts = await recountProject(db, project.id, generation);
        await recountSources(db, project.id, generation);
        const error = failures.length ? `${job.sources.length - failures.length}/${job.sources.length} sources synced; ${failures.join('; ')}` : null;
        // **One row, one statement, and that is the entire atomicity mechanism** (ADR-0039). Under
        // read-committed a concurrent reader either sees this row before the update or after it, so it
        // reads the old generation or the new one and never a project between the two. `live_generation`
        // and the counters that describe it move together because they are in the same `SET`.
        await db
          .update(projects)
          .set({
            status: error ? 'error' : 'idle',
            chunkCount: counts.chunkCount,
            documentCount: counts.documentCount,
            lastIndexedAt: new Date(),
            embeddingModel: embeddings.id,
            liveGeneration: generation,
            lastError: error ? error.slice(0, 2000) : null,
          })
          .where(eq(projects.id, project.id));

        // 5. Reclaim what the swap superseded — after it, outside its transaction, in batches. A
        // failure here costs disk and nothing else, so it is logged and never fails the run.
        if (generation !== live) await this.sweep(project.id, generation, log);

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
            generation,
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
        log.error({ err, project: project.name, rebuild, generation }, 'indexing failed');
        // `live_generation` is deliberately not in this `SET`. A rebuild that failed leaves the
        // generation it was building behind and the previous one live, so every client connected to
        // the project keeps being served the index it was being served before the run started.
        await db
          .update(projects)
          .set({ status: 'error', lastError: message.slice(0, 2000) })
          .where(eq(projects.id, project.id))
          .catch((updateErr: unknown) => log.error({ err: updateErr }, 'failed to record indexing error'));
        // Drop the half-built generation now rather than leaving it for the next run's sweep. Same
        // best-effort contract: if this fails the rows stay, and the next run collects them.
        if (generation !== live) await this.sweep(project.id, live, log);
        await this.recordRun(job, log);
      }
    });
  }
}
