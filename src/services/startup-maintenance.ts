import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
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
 * Each step's failure is logged and the next one still runs: a sweep that cannot read `DATA_DIR`
 * must not leave a project stuck in `indexing`.
 */
export async function runStartupMaintenance({ db, dataDir, locks, indexer, log }: StartupMaintenanceDeps): Promise<void> {
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

  try {
    const recovered = await recoverInterruptedRuns(db, (projectId) => indexer.enqueue(projectId, { trigger: 'scheduled' }), log);
    if (recovered.length > 0) log.warn({ projects: recovered.length }, 're-queued index runs interrupted by the last shutdown');
  } catch (err) {
    log.error({ err }, 'recovery of interrupted index runs failed');
  }
}
