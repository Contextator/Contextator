import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import type { DocumentSourceRow, ProjectRow } from '../db/schema.js';
import { sweepOrphanDirs } from './data-dir.js';
import { recoverInterruptedRuns } from './index-runs.js';
import type { Indexer } from './indexer.js';
import type { KeyedMutex } from './locks.js';
import { listProjects } from './projects.js';
import { listAllSources } from './sources.js';
import { sweepGenerations } from './vector-store.js';

export interface StartupMaintenanceDeps {
  db: Db;
  dataDir: string;
  locks: Pick<KeyedMutex, 'runExclusive'>;
  indexer: Pick<Indexer, 'enqueue'>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /**
   * `REINDEX_ON_MODEL_CHANGE` ([ADR-0113](../../.ssot/ADR.md#adr-0113)): present, the third step below
   * runs against this model id (the server's `embeddings.id`, the value every project is stamped with).
   * Absent is off, which is also the default, so a caller that does not know about the flag behaves as
   * it did before it existed.
   */
  reindexOnModelChange?: { embeddingModelId: string };
}

/**
 * The projects whose stored vectors are from another model than `embeddingModelId` **and** that have
 * something to re-index from ([ADR-0113](../../.ssot/ADR.md#adr-0113)).
 *
 * A project with no stamp has never been indexed, so there is nothing stale; one with no source has
 * nothing to rebuild from, and a run would only fail. A source counts whether or not it is scheduled:
 * the point of the flag is the project that no timer would ever pick up.
 */
export function projectsNeedingModelReindex(
  projectRows: readonly Pick<ProjectRow, 'id' | 'embeddingModel'>[],
  sourceRows: readonly Pick<DocumentSourceRow, 'projectId'>[],
  embeddingModelId: string,
): { id: string; indexedWith: string }[] {
  const withSources = new Set(sourceRows.map((source) => source.projectId));
  const stale: { id: string; indexedWith: string }[] = [];
  for (const project of projectRows) {
    if (project.embeddingModel !== null && project.embeddingModel !== embeddingModelId && withSources.has(project.id)) {
      stale.push({ id: project.id, indexedWith: project.embeddingModel });
    }
  }
  return stale;
}

/**
 * What the process tidies before it serves anything: what a previous process left half-done.
 *
 * Its own function, and not inline in `main`, so that the order and the failure isolation below are
 * tested rather than only read ([ADR-0024](../../.ssot/ADR.md#adr-0024), [ADR-0039](../../.ssot/ADR.md#adr-0039)).
 *
 * 1. Source directories under `DATA_DIR` whose project or source rows are gone are removed.
 * 2. Generations a killed rebuild never made live are collected, under each project's mutex, because
 *    the indexer's queue starts the moment a route is hit.
 * 3. Runs the previous process did not live to finish are recorded as `interrupted` and re-queued.
 *    After the sweeps, so the re-run starts from a clean project; called before the scheduler, so it is
 *    the first thing queued.
 *
 * 4. With `REINDEX_ON_MODEL_CHANGE` on, one run per project whose vectors are from another model
 *    ({@link projectsNeedingModelReindex}). Last, so that a project step 3 already queued is not queued
 *    twice, and so that a refusal here can never stand between a project and its recovery.
 *
 * Each step's failure is logged and the next one still runs: a sweep that cannot read `DATA_DIR`
 * must not leave a project stuck in `indexing`.
 */
export async function runStartupMaintenance({ db, dataDir, locks, indexer, log, reindexOnModelChange }: StartupMaintenanceDeps): Promise<void> {
  try {
    const [projectRows, sourceRows] = await Promise.all([listProjects(db), listAllSources(db)]);
    const removed = await sweepOrphanDirs(dataDir, {
      projectIds: new Set(projectRows.map((p) => p.id)),
      sourceIds: new Set(sourceRows.map((s) => s.id)),
    });
    if (removed.length) log.info({ removed }, 'removed orphan source directories');

    let reclaimed = 0;
    for (const row of projectRows) {
      reclaimed += await locks.runExclusive(row.id, () => sweepGenerations(db, row.id, row.liveGeneration));
    }
    if (reclaimed > 0) log.info({ reclaimed }, 'reclaimed documents of abandoned index generations');
  } catch (err) {
    log.warn({ err }, 'orphan sweep of DATA_DIR failed');
  }

  let recovered: string[] = [];
  try {
    recovered = await recoverInterruptedRuns(db, (projectId) => indexer.enqueue(projectId, { trigger: 'scheduled' }), log);
    if (recovered.length > 0) log.warn({ projects: recovered.length }, 're-queued index runs interrupted by the last shutdown');
  } catch (err) {
    log.error({ err }, 'recovery of interrupted index runs failed');
  }

  if (!reindexOnModelChange) return;
  try {
    // Re-read rather than reuse the sweep's rows: that read happened before recovery changed statuses,
    // and it is skipped altogether when the sweep failed.
    const [projectRows, sourceRows] = await Promise.all([listProjects(db), listAllSources(db)]);
    const alreadyQueued = new Set(recovered);
    const stale = projectsNeedingModelReindex(projectRows, sourceRows, reindexOnModelChange.embeddingModelId).filter(
      (project) => !alreadyQueued.has(project.id),
    );
    const names = new Map(projectRows.map((p) => [p.id, p.name]));
    let queued = 0;
    for (const project of stale) {
      try {
        indexer.enqueue(project.id, { trigger: 'scheduled' });
        queued += 1;
        log.info(
          {
            projectId: project.id,
            project: names.get(project.id),
            indexedWith: project.indexedWith,
            serverUses: reindexOnModelChange.embeddingModelId,
          },
          'embedding model changed since this project was indexed; full re-index queued (REINDEX_ON_MODEL_CHANGE)',
        );
      } catch (err) {
        log.warn(
          { err, projectId: project.id, project: names.get(project.id) },
          'could not queue a re-index after the embedding model changed; trigger one manually',
        );
      }
    }
    if (queued > 0) log.warn({ projects: queued }, 'queued re-indexes for projects indexed with a different embedding model');
  } catch (err) {
    log.error({ err }, 'queueing re-indexes after an embedding model change failed');
  }
}
