import type { QueryActor } from '../db/schema.js';

/**
 * The Prometheus exposition ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
 *
 * **Everything here is either a process counter or read at scrape time.** There is no background
 * aggregation, no sampling timer and no second copy of state that could drift from the thing it
 * describes: the queue depth is the queue's own length, the pool gauges are node-postgres's own
 * numbers, and the last index run is a row. A metric that had to be kept up to date by whoever changed
 * the thing it measures is a metric that is eventually wrong.
 *
 * **Counters are process-local and reset on restart, which is what a Prometheus counter is.** `rate()`
 * and `increase()` handle the reset; a counter persisted to the database would be a second write on
 * the search path to buy a number the scraper does not want.
 *
 * `renderPrometheus` is pure and takes a plain snapshot, so the format — the one part of this that an
 * external system parses and will complain about — is a unit test with no database and no server in it.
 */

/** What the metrics endpoint needs in order to count one search. Optional at every call site, like `QueryLogSink`. */
export interface SearchCounter {
  countSearch(actor: QueryActor): void;
}

/** node-postgres's own pool gauges, named as it names them. */
export interface PoolGauges {
  total: number;
  idle: number;
  waiting: number;
}

/** The index run most recently finished on this instance, whichever project it belonged to. */
export interface LastIndexRun {
  /** Seconds since the epoch, as Prometheus states a timestamp that is a value rather than a sample. */
  finishedAtSeconds: number;
  durationSeconds: number;
  /** `index_runs.status` is `done` or `error`; this is that, as the 1/0 a gauge can be alerted on. */
  ok: boolean;
}

/** Everything one scrape reports, gathered by the route and rendered by the function below. */
export interface MetricsSnapshot {
  version: string;
  uptimeSeconds: number;
  embeddingId: string;
  embeddingReady: boolean;
  /** `false` when the database did not answer this scrape; the rows that need it are then omitted. */
  dbUp: boolean;
  pool: PoolGauges | null;
  queue: { interactive: number; scheduled: number; running: number };
  lastIndexRun: LastIndexRun | null;
  searches: Record<QueryActor, number>;
  audit: { written: number; failed: number };
}

/**
 * The process counters, and the handle on the pool that lets a gauge be read rather than remembered.
 *
 * One per process, built in `server.ts`. It deliberately holds no database and no indexer: those are
 * read at scrape time by the route, which already has the composition root, and a registry that
 * reached for them would be a second place that knows how this application is wired.
 */
export class MetricsRegistry implements SearchCounter {
  private readonly searches: Record<QueryActor, number> = { mcp: 0, dashboard: 0 };
  private auditWritten = 0;
  private auditFailed = 0;

  constructor(private readonly pool?: { totalCount: number; idleCount: number; waitingCount: number }) {}

  countSearch(actor: QueryActor): void {
    this.searches[actor]++;
  }

  /**
   * Counted here rather than inferred from the table, because the number worth alerting on is the one
   * the table cannot contain: an audit event that could not be written leaves no row to count.
   */
  countAudit(outcome: 'written' | 'failed'): void {
    if (outcome === 'written') this.auditWritten++;
    else this.auditFailed++;
  }

  gauges(): { searches: Record<QueryActor, number>; audit: { written: number; failed: number }; pool: PoolGauges | null } {
    return {
      searches: { ...this.searches },
      audit: { written: this.auditWritten, failed: this.auditFailed },
      pool: this.pool ? { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount } : null,
    };
  }
}

/** Prometheus label values escape a backslash, a double quote and a newline, and nothing else. */
const labelValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** A gauge or counter whose value is `NaN` or `Infinity` would be a scrape error, so it is never emitted. */
const number = (value: number): string => (Number.isFinite(value) ? String(value) : '0');

/**
 * The text exposition format, version 0.0.4 — the one `text/plain; version=0.0.4` names and every
 * Prometheus-compatible scraper reads.
 *
 * Each family is `# HELP`, `# TYPE`, then its samples, and every family appears exactly once: a
 * duplicated family is an ingestion error rather than a cosmetic problem, which is why the families
 * are written out here in one place instead of being appended by whoever adds a number.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  const family = (name: string, help: string, type: 'gauge' | 'counter', samples: Array<[string, number]>): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${number(value)}`);
  };

  family('contextator_build_info', 'Always 1; the version and embedding model are the labels.', 'gauge', [
    [`{version="${labelValue(snapshot.version)}",embedding_id="${labelValue(snapshot.embeddingId)}"}`, 1],
  ]);
  family('contextator_uptime_seconds', 'Seconds since this process started serving.', 'gauge', [['', snapshot.uptimeSeconds]]);
  family('contextator_embedding_ready', '1 once the embedding model has loaded; searches fail until it has.', 'gauge', [
    ['', snapshot.embeddingReady ? 1 : 0],
  ]);

  // The database, and the reason `contextator_db_up` leads it: every gauge below is meaningless
  // without it, and an alert on a missing pool gauge cannot tell "the pool is empty" from "the scrape
  // could not reach the database".
  family('contextator_db_up', '1 while the database answers `select 1`.', 'gauge', [['', snapshot.dbUp ? 1 : 0]]);
  if (snapshot.pool) {
    family('contextator_db_pool_connections', "node-postgres's own pool gauges, by state.", 'gauge', [
      ['{state="total"}', snapshot.pool.total],
      ['{state="idle"}', snapshot.pool.idle],
      // The one to alert on: a request waiting for a connection is a request nothing is working on.
      ['{state="waiting"}', snapshot.pool.waiting],
    ]);
  }

  // The indexing queue, by lane, because that is how the queue actually drains (ADR-0048): a person
  // waiting behind fifty scheduled runs is a different situation from fifty people waiting, and one
  // number for both would show them as the same.
  family('contextator_index_queue_depth', 'Projects waiting to be indexed, by the lane they queued in.', 'gauge', [
    ['{lane="interactive"}', snapshot.queue.interactive],
    ['{lane="scheduled"}', snapshot.queue.scheduled],
  ]);
  family('contextator_index_running', '1 while a project is being indexed right now.', 'gauge', [['', snapshot.queue.running]]);

  if (snapshot.lastIndexRun) {
    family('contextator_last_index_run_timestamp_seconds', 'When the most recent index run finished, across every project.', 'gauge', [
      ['', snapshot.lastIndexRun.finishedAtSeconds],
    ]);
    family('contextator_last_index_run_duration_seconds', 'How long that run took.', 'gauge', [['', snapshot.lastIndexRun.durationSeconds]]);
    // Deliberately a 1/0 gauge and not a `status="done"` label: an alert is "the last run failed",
    // and a label would make that `absent()` arithmetic over two series instead of one comparison.
    family('contextator_last_index_run_ok', '1 if the most recent index run finished, 0 if it errored.', 'gauge', [
      ['', snapshot.lastIndexRun.ok ? 1 : 0],
    ]);
  }

  // Counted in the process rather than read from `search_queries`: the query log can be switched off
  // per instance and per project, and a search that happened is a search that happened.
  family('contextator_searches_total', 'Searches that reached the index, by where they came from.', 'counter', [
    ['{actor="mcp"}', snapshot.searches.mcp],
    ['{actor="dashboard"}', snapshot.searches.dashboard],
  ]);

  family('contextator_audit_events_total', 'Audit events since start, by whether the row was written.', 'counter', [
    ['{outcome="written"}', snapshot.audit.written],
    // Non-zero here means an action changed the instance and left no record of who did it, which is
    // the one failure of this subsystem worth waking somebody for.
    ['{outcome="failed"}', snapshot.audit.failed],
  ]);

  return `${lines.join('\n')}\n`;
}
