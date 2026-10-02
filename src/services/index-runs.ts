import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { indexRuns, projects, type IndexRunInsert, type IndexRunRow } from '../db/schema.js';
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
  await pruneRunHistory(db, job.projectId);
}

/** What `index_runs.error` and `projects.last_error` say about a run a restart cut short. */
export const INTERRUPTED_RUN_MESSAGE =
  'Indexing was interrupted by a server restart; an incremental run has been queued in its place. If you had asked for a full rebuild, force a re-index again.';

/**
 * Picks up the runs the previous process did not live to finish. Called once at startup, before
 * anything can enqueue.
 *
 * `index_runs` is written when a run **finishes** ([ADR-0024](../../.ssot/ADR.md#adr-0024)), so a run killed by a restart, an OOM
 * kill or a pulled plug leaves no row at all. What it does leave is `projects.status = 'indexing'`,
 * which it set when it started and nothing else resets — and that status blocks source edits and
 * deletion forever, and shows a spinner nobody is behind. The queue is in-process (ADR-0009), so at
 * startup no project can legitimately be indexing: every such row is a run that died.
 *
 * For each one: an `interrupted` row goes into the history, so the operator sees that a run was lost
 * and when; the project leaves `indexing` with the reason in `last_error`; and the project is queued
 * again. What is queued is an incremental run whatever the lost run was: nothing records whether a
 * rebuild was asked for, so the message says so and leaves forcing it again to the operator.
 * ADR-0009 already counts on that last step being cheap — an incremental run skips every file
 * whose hash it already has, and a rebuild that was cut short left a generation the next run's sweep
 * collects (ADR-0039). The re-run goes in the scheduled lane: nobody pressed a button for it.
 *
 * The status change is one `UPDATE … RETURNING`, so a project is recovered once even if this ran twice.
 * Each project is isolated from the others, and within a project the re-run is queued before the
 * history row is written, each step under its own guard: a failed history write still leaves the run
 * queued, and a failure on one project never stops the next. Returns the ids it re-queued.
 */
export async function recoverInterruptedRuns(db: Db, enqueue: (projectId: string) => void, log: Pick<Logger, 'warn'>): Promise<string[]> {
  const stuck = await db
    .update(projects)
    .set({ status: 'error', lastError: INTERRUPTED_RUN_MESSAGE })
    .where(eq(projects.status, 'indexing'))
    .returning({ id: projects.id, name: projects.name });
  const now = new Date();
  const requeued: string[] = [];
  for (const project of stuck) {
    // Re-queueing is the recovery; the history row is bookkeeping (ADR-0024 treats history writes as
    // best-effort). So the run is queued first and the row is written after, each under its own guard:
    // a failed history write must not leave the project without the run `last_error` says is queued.
    try {
      enqueue(project.id);
      requeued.push(project.id);
      log.warn({ projectId: project.id, project: project.name }, 'index run was interrupted by a restart; an incremental run was queued');
    } catch (err) {
      // The project already left `indexing`, so it is usable, but nothing will re-index it on its own
      // unless its source has a sync interval or a pending webhook — the scheduler picks up nothing else.
      // The operator has to trigger it; the log line is what says so.
      log.warn(
        { err, projectId: project.id, project: project.name },
        'could not queue a re-run for an interrupted index run; trigger a re-index for this project manually',
      );
    }
    try {
      // The start of the lost run was never written anywhere, so the row says when it was found instead
      // of inventing a duration.
      await db.insert(indexRuns).values({
        projectId: project.id,
        mode: 'incremental',
        status: 'interrupted',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        trigger: 'scheduled',
        error: INTERRUPTED_RUN_MESSAGE,
      });
      await pruneRunHistory(db, project.id);
    } catch (err) {
      log.warn({ err, projectId: project.id, project: project.name }, 'could not record an interrupted index run in the history');
    }
  }
  return requeued;
}

async function pruneRunHistory(db: Db, projectId: string): Promise<void> {
  const keep = await db
    .select({ id: indexRuns.id })
    .from(indexRuns)
    .where(eq(indexRuns.projectId, projectId))
    .orderBy(desc(indexRuns.startedAt))
    .limit(RUN_HISTORY_LIMIT);
  await db.delete(indexRuns).where(
    and(
      eq(indexRuns.projectId, projectId),
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

/**
 * The run that finished most recently on this instance, whichever project it belonged to — what
 * `/metrics` reports as "the last index run" ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
 *
 * Ordered by `finished_at` and not by `started_at`: the question a scrape asks is "when did indexing
 * last complete, and did it work", and a long run that started before a short one still finishes after
 * it. It has no index of its own and needs none — this table is capped at `RUN_HISTORY_LIMIT` rows per
 * project by `recordIndexRun`, so the whole of it is a handful of pages on any installation.
 */
export async function latestIndexRun(db: Db): Promise<IndexRunRow | undefined> {
  const [row] = await db.select().from(indexRuns).orderBy(desc(indexRuns.finishedAt)).limit(1);
  return row;
}
