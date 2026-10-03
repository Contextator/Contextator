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

/**
 * Upper bounds, in seconds, for a latency histogram: 5 ms to 10 s, the client libraries' own default.
 * One search is tens of milliseconds and a slow one is seconds, so both ends land inside a bucket.
 */
export const SECONDS_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** One label set's buckets: `counts[i]` is how many observations were `<= buckets[i]`, already cumulative. */
export interface HistogramSeries {
  labels: Record<string, string>;
  counts: number[];
  count: number;
  sum: number;
}

/** A histogram as the renderer needs it: its family, its bounds and every label set observed so far. */
export interface HistogramSnapshot {
  name: string;
  help: string;
  buckets: readonly number[];
  series: HistogramSeries[];
}

/**
 * A Prometheus histogram, kept in the process like the counters below and reset on restart like them.
 *
 * Written here rather than taken from `prom-client` because the exposition is already hand-rendered
 * (see `renderPrometheus`) and a histogram is twenty lines of it: a fixed set of upper bounds, a count
 * per bound, a sum and a total. The bounds are fixed at construction, so a series is a few numbers and
 * observing one is an increment — nothing on the search path allocates or waits for this.
 *
 * Label values are not free text. Every caller passes values from a closed set (a phase, a lane,
 * `true`/`false`), never a project, a document or a query ([ADR-0055](../../.ssot/ADR.md#adr-0055)):
 * a series per value is what a label is, and an open set of them is a cardinality leak.
 */
export class Histogram {
  private readonly series = new Map<string, { labels: Record<string, string>; counts: number[]; count: number; sum: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = SECONDS_BUCKETS,
    readonly labelNames: readonly string[] = [],
  ) {
    if (buckets.length === 0) throw new Error(`histogram ${name}: needs at least one bucket`);
    for (let i = 0; i < buckets.length; i++) {
      if (!Number.isFinite(buckets[i]) || (i > 0 && buckets[i] <= buckets[i - 1])) {
        throw new Error(`histogram ${name}: buckets must be finite and strictly increasing`);
      }
    }
    // `le` is the bucket's own label, and a caller's `le` would make two samples of one series.
    if (labelNames.includes('le')) throw new Error(`histogram ${name}: "le" is reserved`);
  }

  /**
   * Records one observation. A value that is not a finite number is dropped rather than recorded: a
   * `NaN` in `_sum` would poison every rate computed from it, for the rest of the process's life.
   */
  observe(value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value)) return;
    for (const key of Object.keys(labels)) {
      if (!this.labelNames.includes(key)) throw new Error(`histogram ${this.name}: unknown label "${key}"`);
    }
    const values = this.labelNames.map((label) => labels[label] ?? '');
    const key = values.join('\u0000');
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels: Object.fromEntries(this.labelNames.map((label, i) => [label, values[i]])),
        counts: new Array<number>(this.buckets.length).fill(0),
        count: 0,
        sum: 0,
      };
      this.series.set(key, entry);
    }
    // Cumulative at write time: an observation is in every bucket whose bound it does not exceed.
    for (let i = this.buckets.length - 1; i >= 0 && value <= this.buckets[i]; i--) entry.counts[i]++;
    entry.count++;
    entry.sum += value;
  }

  /** A copy, so a scrape that is being rendered does not move under an observation made meanwhile. */
  snapshot(): HistogramSnapshot {
    return {
      name: this.name,
      help: this.help,
      buckets: this.buckets,
      series: [...this.series.values()].map((entry) => ({
        labels: { ...entry.labels },
        counts: [...entry.counts],
        count: entry.count,
        sum: entry.sum,
      })),
    };
  }
}

/** A stopwatch in seconds, on the monotonic clock: a wall-clock adjustment mid-search is not latency. */
export function startTimer(): () => number {
  const start = performance.now();
  return () => (performance.now() - start) / 1000;
}

/**
 * The parts of a search that are timed separately. `retrieve` is the hybrid statement as a whole —
 * dense, lexical, fusion, cap and page are one SQL statement by design
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)), so the database is the only thing that could split it.
 * `rerank` is only observed when a reranker ran.
 */
export type SearchPhase = 'embed' | 'retrieve' | 'rerank';

/** One answered search's timings, in seconds. */
export interface SearchTimings {
  embed: number;
  retrieve: number;
  /** Absent when no reranker was configured, so the `rerank` series only counts searches that reranked. */
  rerank?: number;
  total: number;
}

/** What `searchProject` reports to. Optional, like `QueryLogSink`: unset, nothing is measured. */
export interface SearchObserver {
  observeSearch(timings: SearchTimings): void;
}

/** The two queues the indexer drains (ADR-0048), named as `contextator_index_queue_depth` names them. */
export type IndexLane = 'interactive' | 'scheduled';

/** What the indexer reports to. Optional in `IndexerDeps` for the same reason. */
export interface IndexerObserver {
  /** One `embedPassages` call: how many passages it carried and how long the provider took. */
  observeEmbeddingBatch(size: number, seconds: number): void;
  /**
   * How long a run waited between `enqueue` and the worker picking it up, by the lane it left from. A
   * scheduled run promoted by a button press counts as interactive, wait in the slow lane included.
   */
  observeIndexRunWait(lane: IndexLane, seconds: number): void;
  /**
   * Hands over the indexer's own "is a run in progress" answer, so the search histograms can carry
   * `indexing`. The indexer calls it once, from its constructor, which is what keeps the label from
   * depending on a line in the composition root that nothing tests.
   */
  watchIndexing(probe: () => boolean): void;
}

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
  /** `index_runs.status` is `done`, `error` or `interrupted`; this is whether it was `done`, as the 1/0 a gauge can be alerted on. */
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
  /** Rendered after the gauges and counters, in the order given. Optional so a snapshot without any is still one. */
  histograms?: HistogramSnapshot[];
}

/**
 * The process counters, and the handle on the pool that lets a gauge be read rather than remembered.
 *
 * One per process, built in `server.ts`. It deliberately holds no database and no indexer: those are
 * read at scrape time by the route, which already has the composition root, and a registry that
 * reached for them would be a second place that knows how this application is wired.
 */
export class MetricsRegistry implements SearchCounter, SearchObserver, IndexerObserver {
  private readonly searches: Record<QueryActor, number> = { mcp: 0, dashboard: 0 };
  private auditWritten = 0;
  private auditFailed = 0;
  private readonly histogramFamilies = new Map<string, Histogram>();
  /** Read once per search, at the moment it is observed; see `watchIndexing`. */
  private indexingNow: () => boolean = () => false;

  // The search histograms carry `indexing` so that one PromQL comparison answers the question K-09
  // waits on: does a search get slower while the single indexer is working (ADR-0009)?
  private readonly searchPhases = this.histogram(
    'contextator_search_duration_seconds',
    'Time spent in one phase of an answered search: embed the query, retrieve (the hybrid statement), rerank.',
    SECONDS_BUCKETS,
    ['phase', 'indexing'],
  );
  private readonly searchRequests = this.histogram(
    'contextator_search_request_duration_seconds',
    'Wall time of an answered search, guards included, by whether an index run was in progress.',
    SECONDS_BUCKETS,
    ['indexing'],
  );
  private readonly embeddingBatchDuration = this.histogram(
    'contextator_embedding_batch_duration_seconds',
    'Time the embedding provider took for one batch of passages while indexing.',
    [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  );
  private readonly embeddingBatchSize = this.histogram(
    'contextator_embedding_batch_size',
    'Passages per embedding batch; the last batch of a document is usually short.',
    [1, 2, 4, 8, 16, 32, 64, 128, 256],
  );
  private readonly indexRunWait = this.histogram(
    'contextator_index_run_wait_seconds',
    'Time an index run waited in its lane before the indexer started it.',
    [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    ['lane'],
  );

  constructor(private readonly pool?: { totalCount: number; idleCount: number; waitingCount: number }) {}

  /**
   * Registers a histogram that `/metrics` will render. Names are unique: a second family under one
   * name is a scrape error, and failing at construction is the cheapest place to find that out.
   */
  histogram(name: string, help: string, buckets: readonly number[] = SECONDS_BUCKETS, labelNames: readonly string[] = []): Histogram {
    if (this.histogramFamilies.has(name)) throw new Error(`metric ${name} is already registered`);
    const created = new Histogram(name, help, buckets, labelNames);
    this.histogramFamilies.set(name, created);
    return created;
  }

  /**
   * How a search learns whether the indexer is busy, without the registry holding the indexer: the
   * indexer hands over a function when it is built with this registry, and the registry calls it once
   * per observed search.
   */
  watchIndexing(probe: () => boolean): void {
    this.indexingNow = probe;
  }

  observeSearch(timings: SearchTimings): void {
    // One reading for the whole search, so its phases never disagree about which side they fell on.
    const indexing = this.indexingNow() ? 'true' : 'false';
    this.searchPhases.observe(timings.embed, { phase: 'embed', indexing });
    this.searchPhases.observe(timings.retrieve, { phase: 'retrieve', indexing });
    if (timings.rerank !== undefined) this.searchPhases.observe(timings.rerank, { phase: 'rerank', indexing });
    this.searchRequests.observe(timings.total, { indexing });
  }

  observeEmbeddingBatch(size: number, seconds: number): void {
    this.embeddingBatchSize.observe(size);
    this.embeddingBatchDuration.observe(seconds);
  }

  observeIndexRunWait(lane: IndexLane, seconds: number): void {
    this.indexRunWait.observe(seconds, { lane });
  }

  /** Every registered histogram, in registration order — which is the order they are rendered in. */
  histograms(): HistogramSnapshot[] {
    return [...this.histogramFamilies.values()].map((histogram) => histogram.snapshot());
  }

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

  // Histograms: `_bucket` per bound with `le` last, then `+Inf`, `_sum` and `_count` per label set. A
  // family with no observations yet still states its HELP and TYPE, so a dashboard built on it finds
  // the series name before the first search rather than an error.
  for (const histogram of snapshot.histograms ?? []) {
    lines.push(`# HELP ${histogram.name} ${histogram.help}`, `# TYPE ${histogram.name} histogram`);
    for (const series of histogram.series) {
      const pairs = Object.entries(series.labels).map(([label, value]) => `${label}="${labelValue(value)}"`);
      const braces = (extra: string[]): string => (pairs.length + extra.length > 0 ? `{${[...pairs, ...extra].join(',')}}` : '');
      histogram.buckets.forEach((bound, i) => {
        lines.push(`${histogram.name}_bucket${braces([`le="${bound}"`])} ${number(series.counts[i])}`);
      });
      lines.push(`${histogram.name}_bucket${braces(['le="+Inf"'])} ${number(series.count)}`);
      lines.push(`${histogram.name}_sum${braces([])} ${number(series.sum)}`);
      lines.push(`${histogram.name}_count${braces([])} ${number(series.count)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
