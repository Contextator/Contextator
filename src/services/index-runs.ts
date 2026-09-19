import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { indexRuns, type IndexRunInsert, type IndexRunRow } from '../db/schema.js';
import type { IndexTrigger } from './indexer.js';

/** How many finished runs are kept per project; older ones are pruned after each insert. */
export const RUN_HISTORY_LIMIT = 20;

/** The subset of a job the run record is derived from (kept small so it can be unit-tested without the indexer). */
export interface FinishedJobSummary {
  projectId: string;
  force: boolean;
  /** What asked for the run ([ADR-0048](../../.ssot/ADR.md#adr-0048)). */
  trigger: IndexTrigger;
  phase: 'done' | 'error';
  /** The generation a rebuild wrote into; absent for an incremental run ([ADR-0039](../../.ssot/ADR.md#adr-0039)). */
  generation?: number;
  filesTotal: number;
  filesSkipped: number;
  filesRemoved: number;
  chunksDone: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** Pure: turns a finished job into the row stored in `index_runs`. */
export function buildRunRecord(job: FinishedJobSummary): IndexRunInsert {
  const finishedAt = job.finishedAt ? new Date(job.finishedAt) : new Date();
  const startedAt = job.startedAt ? new Date(job.startedAt) : finishedAt;
  return {
    projectId: job.projectId,
    mode: job.force ? 'force' : 'incremental',
    status: job.phase,
    filesTotal: job.filesTotal,
    filesSkipped: job.filesSkipped,
    filesUpdated: Math.max(0, job.filesTotal - job.filesSkipped),
    filesRemoved: job.filesRemoved,
    chunksWritten: job.chunksDone,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    // NULL for an incremental run, which writes into whichever generation happens to be live and so
    // does not identify one. A rebuild does: with this column, "which run produced the index being
    // served" is `index_runs.generation = projects.live_generation` and nothing else.
    generation: job.generation ?? null,
    // Never NULL from here on. NULL in this column means "recorded before the column existed", the
    // same contract `generation` above carries, so the code must not be able to produce one.
    trigger: job.trigger,
    error: job.phase === 'error' ? (job.error ?? 'unknown error').slice(0, 2000) : null,
  };
}

/** Inserts the run and prunes the project's history down to `RUN_HISTORY_LIMIT` rows. */
export async function recordIndexRun(db: Db, job: FinishedJobSummary): Promise<void> {
  await db.insert(indexRuns).values(buildRunRecord(job));
  const keep = await db
    .select({ id: indexRuns.id })
    .from(indexRuns)
    .where(eq(indexRuns.projectId, job.projectId))
    .orderBy(desc(indexRuns.startedAt))
    .limit(RUN_HISTORY_LIMIT);
  await db.delete(indexRuns).where(
    and(
      eq(indexRuns.projectId, job.projectId),
      notInArray(
        indexRuns.id,
        keep.map((r) => r.id),
      ),
    ),
  );
}

export async function listIndexRuns(db: Db, projectId: string, limit = RUN_HISTORY_LIMIT): Promise<IndexRunRow[]> {
  return db.select().from(indexRuns).where(eq(indexRuns.projectId, projectId)).orderBy(desc(indexRuns.startedAt)).limit(limit);
}
