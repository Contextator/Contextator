import { and, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import { documentSources, type DocumentSourceRow } from '../db/schema.js';
import type { Indexer } from './indexer.js';
import { driverFor } from './sources/driver.js';
import { storedProbeToken } from './sources.js';

/**
 * The scheduler ([ADR-0048](../../.ssot/ADR.md#adr-0048)). Without it a mounted folder or a Notion
 * workspace stays stale until somebody presses a button, which is the product's own roadmap
 * describing it as "a demo of itself".
 *
 * **What it does not do is rescan.** The roadmap proposed skipping a run when the source's content
 * hash set is unchanged; that hash set *is* the scan — `readAndHash` reads every file to compute it,
 * and [ADR-0010](../../.ssot/ADR.md#adr-0010) already makes the embedding free for unchanged files —
 * so hashing in order to decide costs most of the run it avoids. What is expensive is the **sync**: a
 * git fetch, and above all a Notion pull at 350 ms per request. So each driver answers a cheap
 * `probe()` instead, and the tick compares that one token.
 *
 * Shaped like `startSessionReaper` in `services/auth/sessions.ts` — `setInterval`, `unref`, a stop
 * function — rather than as a third kind of background thing.
 */

/**
 * The two questions the scheduler ever asks the indexer, and deliberately the whole of its coupling to
 * it: is this project already busy, and here is one to run. Narrow enough that a test can answer both
 * without starting a queue, which is what lets the probe decisions be asserted without four real
 * index runs happening underneath them.
 */
export type SchedulerIndexer = Pick<Indexer, 'isBusy' | 'enqueue'>;

export interface SchedulerDeps {
  db: Db;
  indexer: SchedulerIndexer;
  log: Logger;
  config: Pick<Config, 'ALLOWED_DOC_ROOTS' | 'DATA_DIR' | 'SECRET_KEY' | 'IGNORE_GLOBS' | 'SYNC_PROBES_PER_TICK'>;
}

/** How often the timer fires. A minute is the resolution a per-source interval is stated in. */
export const SYNC_TICK_MS = 60_000;

/** What one tick did, so the caller — a test, or a log line — can say so without reading the rows back. */
export interface SyncTickResult {
  /** Sources that were switched on and due. May exceed `considered` when the per-tick cap bites. */
  due: number;
  /** Sources this tick actually took, and therefore advanced. */
  considered: number;
  /** Probes that ran. Lower than `considered` when a project was already indexing. */
  probed: number;
  /** Probes whose token equalled the stored one: the whole point, and the runs that did not happen. */
  unchanged: number;
  /** Projects handed to `Indexer.enqueue`. Lower than the source count when several share a project. */
  enqueued: number;
  /** Considered while their project was already running, so the run in flight will sync them anyway. */
  busy: number;
  /** Probes that threw. Counted, logged, and treated as "run it" — never as "skip it". */
  failed: number;
}

const EMPTY_TICK: SyncTickResult = { due: 0, considered: 0, probed: 0, unchanged: 0, enqueued: 0, busy: 0, failed: 0 };

/**
 * The sources that are switched on and whose time has come, oldest first, capped.
 *
 * `next_sync_at IS NULL` counts as due and sorts first: that is a source whose interval was set by
 * hand in SQL, or one restored from a dump taken before the column was written. Ordering by
 * `next_sync_at` ascending is what makes the per-tick cap a queue rather than a lottery — the sources
 * the cap left behind are, by construction, the oldest due ones next time.
 */
async function dueSources(db: Db, limit: number): Promise<DocumentSourceRow[]> {
  return (
    db
      .select()
      .from(documentSources)
      .where(and(isNotNull(documentSources.syncIntervalMinutes), or(isNull(documentSources.nextSyncAt), sql`${documentSources.nextSyncAt} <= now()`)))
      // `NULLS FIRST` is not PostgreSQL's default for an ascending column, so it is said here and said
      // the same way on `document_sources_due_idx` — otherwise the one query this index exists for
      // would sort instead of scanning it.
      .orderBy(sql`${documentSources.nextSyncAt} asc nulls first`)
      .limit(limit)
  );
}

/**
 * **The one statement that makes the hot loop impossible.**
 *
 * `next_sync_at` advances whenever a source is *considered* — before the probe, before any decision,
 * and whether or not anything is enqueued. The bug it is written against is specific: a run that
 * outlives its own interval leaves `next_sync_at` in the past, the next tick re-probes, `enqueue`
 * returns the still-active job, nothing advances, and the tick after that does it again — a probe
 * loop against somebody's git host for as long as the run takes.
 *
 * `now() + interval`, computed in SQL and from **now** rather than from the due time it missed. A
 * source that was due during an outage does not owe the scheduler the ticks it slept through, and
 * `next_sync_at + interval` on a row a day overdue would still be in the past, which is the same bug
 * wearing a different expression. The value this writes is strictly greater than `now()` for every
 * interval the API allows, so the row cannot be due again on the same tick or on the next one.
 *
 * No jitter here: the jitter was spent once, when the row was created or switched on
 * (`firstSyncDueAt`), and adding a whole interval preserves the phase it bought. Re-randomising each
 * cycle would scatter a herd that is already scattered, and re-collect it just as often.
 */
async function advanceDueTimes(db: Db, sources: DocumentSourceRow[]): Promise<void> {
  await db
    .update(documentSources)
    // Each row by its own interval, in one statement, and with `now()` read by the database rather
    // than by this process — the reason `user_sessions` compares its deadlines in SQL too.
    .set({ nextSyncAt: sql`now() + make_interval(mins => ${documentSources.syncIntervalMinutes})` })
    .where(
      and(
        inArray(
          documentSources.id,
          sources.map((s) => s.id),
        ),
        isNotNull(documentSources.syncIntervalMinutes),
      ),
    );
}

/**
 * One pass of the scheduler, separated from the timer so that a test can drive it without waiting a
 * minute and without a clock to stub. Never throws: a tick that fails is a tick, not an outage.
 */
export async function runSyncTick(deps: SchedulerDeps): Promise<SyncTickResult> {
  const { db, indexer, log, config } = deps;
  const result: SyncTickResult = { ...EMPTY_TICK };

  // One more than the cap, so "there were more due than this tick took" is knowable without a second
  // count over a table nobody else is querying.
  const found = await dueSources(db, config.SYNC_PROBES_PER_TICK + 1);
  result.due = found.length;
  const batch = found.slice(0, config.SYNC_PROBES_PER_TICK);
  if (batch.length === 0) return result;
  result.considered = batch.length;

  // Before anything can decide not to, and before the first probe can be slow.
  await advanceDueTimes(db, batch);

  const enqueued = new Set<string>();
  for (const source of batch) {
    // A project whose run is already in flight or queued needs nothing from this tick: that run syncs
    // every source of the project when it gets there. Skipping the probe here is not only an
    // optimisation — it is what keeps a long run from being shadowed by a probe per minute.
    if (indexer.isBusy(source.projectId)) {
      result.busy++;
      continue;
    }

    let token: string | null = null;
    try {
      const driver = driverFor(source, { db, log, config });
      if (driver.probe) {
        result.probed++;
        token = await driver.probe();
      }
    } catch (err) {
      result.failed++;
      // Deliberately not a source error on the row: the probe failing says nothing about the source
      // that the run about to happen will not say better, with the real message.
      log.warn({ err, source: source.name, sourceId: source.id }, 'sync probe failed; indexing anyway');
      token = null;
    }

    const stored = storedProbeToken(source.config);
    // Equal, and both present. `null` — no probe, a probe that could not answer, a probe that threw —
    // falls through to the run, always.
    if (token !== null && stored !== undefined && token === stored) {
      result.unchanged++;
      continue;
    }

    if (!enqueued.has(source.projectId)) {
      enqueued.add(source.projectId);
      indexer.enqueue(source.projectId, { trigger: 'scheduled' });
    }
    log.info({ source: source.name, sourceId: source.id, projectId: source.projectId }, 'scheduled sync queued a run');
  }
  result.enqueued = enqueued.size;
  return result;
}

/**
 * Starts the timer and returns the function that stops it — the shape `startSessionReaper` uses, and
 * wired beside it in `server.ts`.
 *
 * `unref()` for the same reason it does: a background timer must not be the reason a process that has
 * finished its work refuses to exit. `onTick` exists for the tests, which would otherwise have to
 * wait a real minute to observe anything.
 */
export function startSyncScheduler(deps: SchedulerDeps, intervalMs = SYNC_TICK_MS, onTick?: (result: SyncTickResult) => void): () => void {
  let running = false;
  const timer = setInterval(() => {
    // One tick at a time. The probes inside a tick are sequential and a Notion probe can take a
    // second, so two overlapping ticks would double-consider nothing (the due times have already
    // advanced) but would double the outbound requests for no gain.
    if (running) return;
    running = true;
    void runSyncTick(deps)
      .then((result) => {
        if (result.considered > 0) {
          deps.log.debug(result, 'sync scheduler tick');
        }
        onTick?.(result);
      })
      .catch((err: unknown) => deps.log.warn({ err }, 'sync scheduler tick failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
