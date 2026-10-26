import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { type EvalRunResult, type EvalRunRow, type EvalRunTrigger, evalRuns } from '../db/schema.js';
import { aggregate, byQuestionId, EVAL_SEARCH_LIMIT, type RowResult, scoreRow } from './eval-scoring.js';
import { Semaphore } from './locks.js';
import { listGoldenQuestions, partitionByExpectFile, toGoldenRow } from './golden-questions.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import type { EvalRunObserver } from './metrics.js';
import { getProjectById, NotFoundError } from './projects.js';
import { searchProject } from './search.js';
import type { HnswScan, ResultSelection } from './vector-store.js';

/**
 * The golden set, asked of the live index on the server's own initiative and kept
 * ([ADR-0124](../../.ssot/ADR.md#adr-0124)): after a swap, after an incremental run that changed the index,
 * after the set itself changed, and when a manager asks.
 *
 * What a run is, in the order the ADR decides it:
 *
 * - **Scored as the CLI scores.** `searchProject` with the floor off, no query log sink and no metrics, then
 *   `scoreRow` and `aggregate` from `eval-scoring.ts`, the module `npm run eval` also uses, with the results put
 *   in id order first because a mean is not associative (`assembleReport` does the same). The figure stored
 *   here and the figure the CLI prints for the same index are therefore one number.
 * - **Never in the indexer's way.** It does not take the project lock the indexer, uploads and source deletion
 *   share: a run is up to a thousand searches, and holding that lock for as long would stop the project's
 *   indexing. It has its own: one run and one waiting run per project, and one run at a time on the server.
 *   The price is that an incremental run can write while a run is asking; a swap cannot go unnoticed, because a
 *   run that finds the live generation changed records an `error` and the swap has already queued its successor.
 * - **A question about a page that is not there is skipped**, not failed and not lost: it leaves the
 *   denominator and is listed. A skipped question that the previous good run did score is listed again as
 *   newly skipped, so that a page which vanished stays visible without being read as a retrieval regression.
 * - **A regression is a lost question**, counted gross against the project's last `ok` run.
 * - **A run that cannot finish records why**, as an `error` row, and touches nothing else: the search path and
 *   the indexer never wait for it and never learn that it failed.
 *
 * Nothing here writes a query to the log (ADR-0047) or a label to `/metrics` (ADR-0105).
 */

/** Runs kept per project; the oldest are dropped when a new one is written. */
export const MAX_KEPT_EVAL_RUNS = 100;

/** The most one list call returns, and what it returns when nobody says: the panel's chart wants the lot, a script rarely does. */
export const MAX_EVAL_RUN_LIST = MAX_KEPT_EVAL_RUNS;
export const DEFAULT_EVAL_RUN_LIST = 30;

/**
 * How long the set must be left alone before a run asks it. Editing a set is many requests (a replace is one,
 * but a person adding questions is a request each), and a run of a thousand questions started by every one of
 * them would be a run of the set as it stood a second ago. Sixty seconds is the design's figure; the
 * 1000-question timing in the phase report is what it is measured against.
 */
export const GOLDEN_SET_DEBOUNCE_MS = 60_000;

/** A run asked for by a manager and the ones it can be refused for. */
export type EvalRunRequestOutcome =
  | { status: 'started'; runId: string }
  | { status: 'project_gone' }
  /** The project has no golden questions: nothing to ask, nothing recorded. */
  | { status: 'no_questions' }
  /** A run of this project is running or waiting, or the server is already running one. */
  | { status: 'busy'; reason: 'project' | 'server' };

/** Which of two triggers a waiting run keeps when both ask: the one that says the most about what changed. */
type AutomaticTrigger = Exclude<EvalRunTrigger, 'manual'>;
const TRIGGER_RANK: Record<EvalRunTrigger, number> = { manual: 3, index_rebuild: 2, index_incremental: 1, golden_set: 0 };

export interface EvalRunnerDeps {
  db: Db;
  embeddings: EmbeddingProvider;
  /** The server's own scan and selection settings: a run that measured others would measure something nobody searches with. */
  scan: HnswScan;
  selection: ResultSelection;
  log: Logger;
  metrics?: EvalRunObserver;
  /** Overridable so a test need not wait a minute; the product uses {@link GOLDEN_SET_DEBOUNCE_MS}. */
  goldenSetDebounceMs?: number;
}

/** A run that the process shutting down cut short: nothing is written, because a row that was never written claims nothing. */
class RunAbandoned extends Error {}

interface ProjectState {
  /** What the run in this state will be recorded as. Raised, never lowered, by a trigger that arrives before the run has started. */
  trigger: EvalRunTrigger;
  /**
   * The run has the server's slot and is reading the index. Until then it is only queued for the slot, has read
   * nothing, and will see everything that changed before it starts: a trigger that arrives now is already
   * covered by it and must not queue a second run of the same index behind it.
   */
  started: boolean;
  /** The trigger of the one run waiting behind it; a third request coalesces into this one. A manual request never waits: it is refused. */
  waiting: AutomaticTrigger | null;
}

/** What a run knows when it fails, so the `error` row can say which set it failed on. */
interface RunFacts {
  generation: number;
  embeddingModel: string;
  questionCount: number;
  skippedKeys: string[];
}

export class EvalRunner {
  private readonly states = new Map<string, ProjectState>();
  private readonly slot = new Semaphore(1);
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: EvalRunnerDeps) {}

  /**
   * An index trigger or a settled golden-set change. Fire and forget, and never throws: it is called from
   * inside the indexer's run, after the swap has been committed, and must not hold or fail it.
   *
   * At most one run executes per project and one waits; a request that finds both taken is already covered by
   * the waiting run, which reads the index when it starts and so sees everything that came before it.
   */
  request(projectId: string, trigger: AutomaticTrigger): void {
    if (this.stopped) return;
    const state = this.states.get(projectId);
    if (!state) {
      this.launch(projectId, trigger, false);
      return;
    }
    if (!state.started) {
      if (TRIGGER_RANK[state.trigger] < TRIGGER_RANK[trigger]) state.trigger = trigger;
      return;
    }
    const waiting = state.waiting;
    if (waiting === null || TRIGGER_RANK[waiting] < TRIGGER_RANK[trigger]) state.waiting = trigger;
  }

  /**
   * The golden set changed. The run follows `goldenSetDebounceMs` after the last change, so a person adding
   * questions one by one is measured once, on the set they ended up with.
   */
  notifyGoldenSetChanged(projectId: string): void {
    if (this.stopped) return;
    const pending = this.debounce.get(projectId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.debounce.delete(projectId);
      this.request(projectId, 'golden_set');
    }, this.deps.goldenSetDebounceMs ?? GOLDEN_SET_DEBOUNCE_MS);
    timer.unref();
    this.debounce.set(projectId, timer);
  }

  /**
   * A manager's request. Refused (`busy`) rather than queued when the project already has a run going or
   * waiting, or the server is already running one: a repeated click must not stack runs up behind search. The
   * run itself goes on in the background; `runId` is the row it writes. Not every run does write one: a project
   * deleted while it ran, a shutdown, or a row that could not be stored leave the id unwritten for good, so a
   * caller that polls for it needs a limit.
   */
  async requestManual(projectId: string): Promise<EvalRunRequestOutcome> {
    if (this.stopped) return { status: 'busy', reason: 'server' };
    const project = await getProjectById(this.deps.db, projectId);
    if (!project) return { status: 'project_gone' };
    const [first] = await listGoldenQuestions(this.deps.db, projectId);
    if (!first) return { status: 'no_questions' };
    // From here to `launch` there is no `await`, so two requests cannot both pass these checks.
    if (this.states.has(projectId)) return { status: 'busy', reason: 'project' };
    if (!this.slot.tryAcquire()) return { status: 'busy', reason: 'server' };
    const runId = randomUUID();
    this.launch(projectId, 'manual', true, runId);
    return { status: 'started', runId };
  }

  /** Resolves when every run started so far has finished; for tests and shutdown, never for a request. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Shutdown: no new run starts, the ones asking stop at their next question, and none of them writes a row.
   * The next trigger asks again, which is why no `interrupted` status exists.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    await this.settled();
  }

  private launch(projectId: string, trigger: EvalRunTrigger, holdsSlot: boolean, runId: string = randomUUID()): void {
    const state: ProjectState = { trigger, started: false, waiting: null };
    this.states.set(projectId, state);
    const run = (async () => {
      try {
        if (!holdsSlot) await this.slot.acquire();
        try {
          state.started = true;
          if (!this.stopped) await this.execute(projectId, state.trigger, runId);
        } finally {
          this.slot.release();
        }
      } catch (err) {
        if (!(err instanceof RunAbandoned))
          this.deps.log.error({ err, projectId, trigger: state.trigger }, 'eval run failed outside its own error handling');
      }
      // Cleared and the waiting run started from here, after the slot is released, so that it queues for it like any other.
      const next = state.waiting;
      this.states.delete(projectId);
      if (next !== null && !this.stopped) this.launch(projectId, next, false);
    })();
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** One run, from reading the set to writing the row. An error row is written for anything that goes wrong after the set is known. */
  private async execute(projectId: string, trigger: EvalRunTrigger, runId: string): Promise<void> {
    const { db, embeddings } = this.deps;
    const startedAt = new Date();
    const project = await getProjectById(db, projectId);
    if (!project) return;
    const rows = await listGoldenQuestions(db, projectId);
    const facts: RunFacts = {
      generation: project.liveGeneration,
      embeddingModel: project.embeddingModel ?? embeddings.id,
      questionCount: rows.length,
      skippedKeys: [],
    };
    if (rows.length === 0) {
      // A project with no questions does nothing and records nothing, except for a manager's request: that one
      // was answered `202` with the id of the row this run writes, and the set was emptied after it was accepted.
      if (trigger === 'manual')
        await this.recordError(projectId, trigger, runId, startedAt, facts, new RunFailed('The golden set was emptied before the run started'));
      return;
    }
    try {
      if (project.embeddingModel === null || project.chunkCount === 0)
        throw new RunFailed('The project has nothing indexed, so there is nothing to ask');
      if (project.embeddingModel !== embeddings.id) {
        throw new RunFailed(
          `The project was indexed with ${project.embeddingModel} and this server embeds with ${embeddings.id}; its vectors cannot be compared with this model's queries`,
        );
      }

      const golden = rows.map(toGoldenRow);
      const { scorable, skipped } = await partitionByExpectFile(db, projectId, project.liveGeneration, golden);
      facts.skippedKeys = skipped.map((r) => r.id).sort(compareCodeUnits);
      if (scorable.length === 0) throw new RunFailed(`No question can be scored: all ${golden.length} expect a file the live index does not hold`);

      const scored: RowResult[] = [];
      const fingerprints = new Map<string, string>();
      for (const row of scorable) {
        if (this.stopped) throw new RunAbandoned();
        const outcome = await searchProject(
          // The floor off, and no log and no counters: the product asking itself, not an agent asking (ADR-0047).
          { db, embeddings, scan: this.deps.scan, selection: this.deps.selection, scoreFloor: 0, queryLog: undefined, metrics: undefined },
          { projectId, query: row.query, limit: EVAL_SEARCH_LIMIT },
        );
        if (outcome.status !== 'ok') throw new RunFailed(`Question ${row.id} could not be scored: the search answered ${outcome.status}`);
        scored.push(
          scoreRow(
            row,
            outcome.hits.map((hit) => ({ file: hit.file, headingPath: hit.headingPath, score: hit.score })),
          ),
        );
        fingerprints.set(row.id, fingerprint(row));
      }
      if (this.stopped) throw new RunAbandoned();

      // The index moved under the run: the answers describe no single index. The swap that moved it has queued
      // a run of its own, which is the one worth reading.
      const after = await getProjectById(db, projectId);
      if (!after) return;
      if (after.liveGeneration !== project.liveGeneration || after.embeddingModel !== project.embeddingModel) {
        throw new RunFailed(
          `The index changed during the run (generation ${project.liveGeneration} to ${after.liveGeneration}); the swap has queued a new run`,
        );
      }

      const sorted = [...scored].sort(byQuestionId);
      const metrics = aggregate(sorted);
      const results: EvalRunResult[] = sorted.map((r) => ({ key: r.row.id, fp: fingerprints.get(r.row.id) as string, rank: r.rank }));

      const previous = await lastOkRun(db, projectId);
      const comparison = previous === null ? null : compareRuns(previous.results ?? [], results, facts.skippedKeys);
      await this.record({
        id: runId,
        projectId,
        trigger,
        status: 'ok',
        error: null,
        generation: project.liveGeneration,
        embeddingModel: project.embeddingModel,
        questionCount: rows.length,
        scoredCount: scorable.length,
        recall5: metrics.recall5,
        mrr: metrics.mrr,
        regressed: comparison !== null && comparison.lostKeys.length > 0,
        comparedTo: previous?.id ?? null,
        lostKeys: comparison?.lostKeys ?? [],
        skippedKeys: facts.skippedKeys,
        newlySkippedKeys: comparison?.newlySkippedKeys ?? [],
        results,
        startedAt,
        finishedAt: new Date(),
      });
    } catch (err) {
      if (err instanceof RunAbandoned) throw err;
      await this.recordError(projectId, trigger, runId, startedAt, facts, err);
    }
  }

  private async recordError(
    projectId: string,
    trigger: EvalRunTrigger,
    runId: string,
    startedAt: Date,
    facts: RunFacts,
    err: unknown,
  ): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000) || 'The run failed';
    // The log carries the whole error; the row, which every viewer of the project reads, carries its message only.
    if (!(err instanceof RunFailed)) this.deps.log.warn({ err, projectId, trigger }, 'eval run failed');
    await this.record({
      id: runId,
      projectId,
      trigger,
      status: 'error',
      error: message,
      generation: facts.generation,
      embeddingModel: facts.embeddingModel,
      questionCount: facts.questionCount,
      scoredCount: 0,
      recall5: null,
      mrr: null,
      regressed: false,
      comparedTo: null,
      lostKeys: [],
      skippedKeys: facts.skippedKeys,
      newlySkippedKeys: [],
      results: null,
      startedAt,
      finishedAt: new Date(),
    });
  }

  /** Writes the row and prunes in one transaction, then counts it. A write that fails is logged: it cannot have a caller to tell. */
  private async record(values: typeof evalRuns.$inferInsert): Promise<void> {
    try {
      await this.deps.db.transaction(async (tx) => {
        await tx.insert(evalRuns).values(values);
        await tx.execute(sql`
          delete from eval_runs
          where project_id = ${values.projectId}
            and id not in (
              select id from eval_runs where project_id = ${values.projectId} order by started_at desc, id desc limit ${MAX_KEPT_EVAL_RUNS}
            )
        `);
      });
    } catch (err) {
      // Most often the project was deleted while the run was asking; either way there is nothing to attach a row to.
      this.deps.log.warn({ err, projectId: values.projectId, trigger: values.trigger }, 'eval run could not be recorded');
      return;
    }
    this.deps.metrics?.countEvalRun(values.status as 'ok' | 'error', values.regressed ?? false);
    this.deps.log.info(
      {
        projectId: values.projectId,
        trigger: values.trigger,
        status: values.status,
        scored: values.scoredCount,
        skipped: values.skippedKeys?.length ?? 0,
        lost: values.lostKeys?.length ?? 0,
        regressed: values.regressed,
      },
      'eval run recorded',
    );
  }
}

/** A failure the run expects and states in its own words; anything else is logged in full as well. */
class RunFailed extends Error {}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A digest of what a question asks and what it expects. A question whose digest changed since the last good
 * run is a different question and is not compared with it: otherwise rewriting a question would read as a
 * retrieval regression ([ADR-0124](../../.ssot/ADR.md#adr-0124) rule 6).
 */
export function fingerprint(row: { query: string; expectFile: string; expectHeading?: string | undefined }): string {
  return createHash('sha256')
    .update(JSON.stringify([row.query, row.expectFile, row.expectHeading ?? null]))
    .digest('hex')
    .slice(0, 16);
}

const inTopFive = (rank: number | null): boolean => rank !== null && rank < 5;

/**
 * What changed between the last good run and this one ([ADR-0124](../../.ssot/ADR.md#adr-0124) rules 5 and 6).
 *
 * `lostKeys`: in the top five then, scored now with the same fingerprint, and not in the top five now. The
 * count is gross: a question gained elsewhere cancels nothing. `newlySkippedKeys`: skipped now, scored then.
 * Both in code-unit order, the same on every machine.
 */
export function compareRuns(
  previous: readonly EvalRunResult[],
  current: readonly EvalRunResult[],
  skippedKeys: readonly string[],
): { lostKeys: string[]; newlySkippedKeys: string[] } {
  const before = new Map(previous.map((r) => [r.key, r]));
  const lostKeys = current
    .filter((now) => {
      const then = before.get(now.key);
      return then !== undefined && then.fp === now.fp && inTopFive(then.rank) && !inTopFive(now.rank);
    })
    .map((r) => r.key)
    .sort(compareCodeUnits);
  const newlySkippedKeys = skippedKeys.filter((key) => before.has(key)).sort(compareCodeUnits);
  return { lostKeys, newlySkippedKeys };
}

/** The project's most recent `ok` run, the one a new run is compared with. */
async function lastOkRun(db: Db, projectId: string): Promise<EvalRunRow | null> {
  const [row] = await db
    .select()
    .from(evalRuns)
    .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.status, 'ok')))
    .orderBy(desc(evalRuns.startedAt), desc(evalRuns.id))
    .limit(1);
  return row ?? null;
}

/** A run as the API states it. `results` is left out of the list and present on the single read. */
export interface EvalRunView {
  id: string;
  trigger: EvalRunTrigger;
  status: 'ok' | 'error';
  error: string | null;
  generation: number;
  embeddingModel: string;
  questionCount: number;
  scoredCount: number;
  recall5: number | null;
  mrr: number | null;
  regressed: boolean;
  comparedTo: string | null;
  lostKeys: string[];
  skippedKeys: string[];
  newlySkippedKeys: string[];
  startedAt: string;
  finishedAt: string;
  results?: EvalRunResult[];
}

export function toEvalRunView(row: EvalRunRow, withResults: boolean): EvalRunView {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    error: row.error,
    generation: row.generation,
    embeddingModel: row.embeddingModel,
    questionCount: row.questionCount,
    scoredCount: row.scoredCount,
    recall5: row.recall5,
    mrr: row.mrr,
    regressed: row.regressed,
    comparedTo: row.comparedTo,
    lostKeys: row.lostKeys,
    skippedKeys: row.skippedKeys,
    newlySkippedKeys: row.newlySkippedKeys,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    ...(withResults ? { results: row.results ?? [] } : {}),
  };
}

/** The project's runs, newest first, without their per-question ranks. */
export async function listEvalRuns(db: Db, projectId: string, limit: number = DEFAULT_EVAL_RUN_LIST): Promise<EvalRunView[]> {
  const rows = await db
    .select()
    .from(evalRuns)
    .where(eq(evalRuns.projectId, projectId))
    .orderBy(desc(evalRuns.startedAt), desc(evalRuns.id))
    .limit(Math.min(Math.max(1, limit), MAX_EVAL_RUN_LIST));
  return rows.map((row) => toEvalRunView(row, false));
}

/** One run with its per-question ranks; `NotFoundError` for a run that is not this project's or has been pruned. */
export async function getEvalRun(db: Db, projectId: string, runId: string): Promise<EvalRunView> {
  const [row] = await db
    .select()
    .from(evalRuns)
    .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.id, runId)))
    .limit(1);
  if (!row) throw new NotFoundError('No such eval run');
  return toEvalRunView(row, true);
}
