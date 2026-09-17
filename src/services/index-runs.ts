import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { indexRuns, type IndexRunInsert, type IndexRunRow } from '../db/schema.js';

/** How many finished runs are kept per project; older ones are pruned after each insert. */
export const RUN_HISTORY_LIMIT = 20;

/** The subset of a job the run record is derived from (kept small so it can be unit-tested without the indexer). */
export interface FinishedJobSummary {
  projectId: string;
  force: boolean;
  phase: 'done' | 'error';
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
