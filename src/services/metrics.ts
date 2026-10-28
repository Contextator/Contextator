import type { QueryActor } from '../db/schema.js';
import { PII_RULES, type PiiRule } from './pii-rules.js';

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

/** Which protocol generation an MCP message arrived in ([ADR-0098](../../.ssot/ADR.md#adr-0098)). */
export type McpRequestEra = 'legacy' | 'modern';

/**
 * The MCP methods `contextator_mcp_requests_total` names by their own name. Anything else — a typo, a
 * method from a revision this build does not know, a client inventing one — is counted as `other`: the
 * label is peer-supplied, and a label taken verbatim from the wire is a series per attacker.
 */
export const KNOWN_MCP_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'ping',
  'server/discover',
  'subscriptions/listen',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
  'tasks/get',
  'tasks/list',
  'tasks/result',
  'tasks/cancel',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

/** The label value for a method or tool name that is not on its allow-list. */
export const OTHER_LABEL = 'other';

/** Counts one inbound MCP message by method, tool and era. Callers hand in labels already reduced to their allow-lists. */
export interface McpRequestCounter {
  countMcpRequest(method: string, tool: string, era: McpRequestEra): void;
}

/** Why the MCP rate limiter refused a request; a closed set, so the counter's label cannot grow (ADR-0112). */
export type RateLimitScope = 'token' | 'anonymous' | 'tool';

/** Why a credential was refused before its access decision; a closed set (ADR-0118). */
export type AccessDeniedReason = 'network';

/** The two things the MCP rate limiter and the token allowlist report, and nothing that identifies a caller. */
export interface McpGuardCounter {
  countRateLimited(scope: RateLimitScope): void;
  /** The counter statement failed; the request was served or refused according to `MCP_RATE_LIMIT_FAIL_OPEN`. */
  countRateLimitError(): void;
  countAccessDenied(reason: AccessDeniedReason): void;
}

/**
 * What the eval runner reports about a run it has recorded ([ADR-0124](../../.ssot/ADR.md#adr-0124)). No
 * project, no score and no key goes with it: the counters are the instance's, and a score per project would
 * be a label per project ([ADR-0105](../../.ssot/ADR.md#adr-0105)). Optional wherever it is taken, like the
 * other observers.
 */
export interface EvalRunObserver {
  countEvalRun(status: 'ok' | 'error', regressed: boolean): void;
}

/** The `contextator_eval_runs_total`, `contextator_eval_run_errors_total` and `contextator_eval_regressions_total` values. */
export interface EvalRunSample {
  runs: number;
  errors: number;
  regressions: number;
}

/**
 * What happened to one `report_gap` call ([ADR-0125](../../.ssot/ADR.md#adr-0125)): the closed set of
 * `contextator_mcp_gap_reports_total{outcome}` ([ADR-0105](../../.ssot/ADR.md#adr-0105)). `disabled` is a
 * project whose query log was switched off after the session began, `limited` a report over
 * `MCP_REPORT_GAP_PER_HOUR`, `failed` one that could not be stored.
 */
export const GAP_REPORT_OUTCOMES = ['accepted', 'limited', 'disabled', 'failed'] as const;
export type GapReportOutcome = (typeof GAP_REPORT_OUTCOMES)[number];

/** Counts one `report_gap` call by outcome. Optional wherever it is taken, like the other observers. */
export interface GapReportObserver {
  countGapReport(outcome: GapReportOutcome): void;
}

/**
 * The source types that report a throttling answer from their remote
 * ([ADR-0126](../../.ssot/ADR.md#adr-0126) decision 9): the closed set of the `source_type` label of
 * `contextator_source_throttled_total` ([ADR-0105](../../.ssot/ADR.md#adr-0105)). `s3` counts `503 SlowDown`,
 * `gdrive` counts `429` and `403` with `rateLimitExceeded`/`userRateLimitExceeded`
 * ([ADR-0127](../../.ssot/ADR.md#adr-0127) decision 9). Another source type joins the set only through its own entry.
 */
export const SOURCE_THROTTLE_TYPES = ['s3', 'gdrive'] as const;
export type SourceThrottleType = (typeof SOURCE_THROTTLE_TYPES)[number];

/** Counts one throttling answer a source's remote gave, retried or not. Optional wherever it is taken, like the other observers. */
export interface SourceThrottleObserver {
  countSourceThrottled(type: SourceThrottleType): void;
}

/**
 * What happened to one document the PII scan looked at ([ADR-0130](../../.ssot/ADR.md#adr-0130)): the closed set of
 * `contextator_document_scans_total{outcome}` ([ADR-0105](../../.ssot/ADR.md#adr-0105)). `no_content` is a document
 * whose text is not stored, `failed` one the scanner could not scan or could not write.
 */
export const DOCUMENT_SCAN_OUTCOMES = ['scanned', 'no_content', 'failed'] as const;
export type DocumentScanOutcome = (typeof DOCUMENT_SCAN_OUTCOMES)[number];

/**
 * What the PII scanner reports. The labels are the two closed sets (`rule` from `PII_RULES`, `outcome` above) and
 * no project, document or value goes with a count (ADR-0105). Optional wherever it is taken, like the other observers.
 */
export interface PiiScanObserver {
  countDocumentScan(outcome: DocumentScanOutcome): void;
  countDocumentFindings(rule: PiiRule, count: number): void;
}

/** Times one tool call, handler start to answer. */
export interface McpToolObserver {
  observeToolDuration(tool: string, seconds: number): void;
}

/** One `contextator_mcp_requests_total` series. */
export interface McpRequestSample {
  method: string;
  tool: string;
  era: McpRequestEra;
  count: number;
}

/** The `contextator_mcp_rate_limited_total`, `contextator_mcp_rate_limit_errors_total` and `contextator_mcp_access_denied_total` values. */
export interface McpGuardSample {
  rateLimited: Record<RateLimitScope, number>;
  rateLimitErrors: number;
  accessDenied: Record<AccessDeniedReason, number>;
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

/**
 * How stale the scheduled sources are, instance-wide. Unlabeled by rule: a project, a source or a
 * path is a label value from the data, which ADR-0105 forbids, so this is the worst case across all
 * of them and not a series per source.
 */
export interface SourceFreshnessSample {
  /** Epoch seconds of the oldest successful sync among scheduled sources; null while none has synced. */
  oldestSyncedAtSeconds: number | null;
  /** Seconds since that sync; null while none has synced. */
  lagSeconds: number | null;
  /** Scheduled sources that have never completed a sync. */
  neverSynced: number;
}

/** The `contextator_document_scans_total` and `contextator_document_findings_total` values. */
export interface PiiScanSample {
  scans: Record<DocumentScanOutcome, number>;
  findings: Record<PiiRule, number>;
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
  /** Absent while the database is down, like the other rows that need it. */
  sourceFreshness?: SourceFreshnessSample;
  searches: Record<QueryActor, number>;
  audit: { written: number; failed: number };
  /** Rate-limited MCP requests by scope, access denials by reason, and counter failures. Optional like `mcpRequests`. */
  mcpGuard?: McpGuardSample;
  /** MCP messages by method, tool and era. Optional so a snapshot built before it existed is still one. */
  mcpRequests?: McpRequestSample[];
  /** Eval runs recorded since start, unlabelled (ADR-0124). Optional like `mcpGuard`. */
  evalRuns?: EvalRunSample;
  /** `report_gap` calls since start by outcome (ADR-0125). Optional like `mcpGuard`. */
  gapReports?: Record<GapReportOutcome, number>;
  /** Throttling answers from a source's remote since start, by source type (ADR-0126). Optional like `mcpGuard`. */
  sourceThrottled?: Record<SourceThrottleType, number>;
  /** PII scan results since start (ADR-0130): documents by outcome and findings by rule. Optional like `mcpGuard`. */
  piiScan?: PiiScanSample;
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
export class MetricsRegistry
  implements
    SearchCounter,
    SearchObserver,
    IndexerObserver,
    McpRequestCounter,
    McpToolObserver,
    McpGuardCounter,
    EvalRunObserver,
    GapReportObserver,
    SourceThrottleObserver,
    PiiScanObserver
{
  private readonly searches: Record<QueryActor, number> = { mcp: 0, dashboard: 0 };
  private readonly mcpRequestCounts = new Map<string, McpRequestSample>();
  private readonly rateLimited: Record<RateLimitScope, number> = { token: 0, anonymous: 0, tool: 0 };
  private rateLimitErrors = 0;
  private readonly accessDenied: Record<AccessDeniedReason, number> = { network: 0 };
  private auditWritten = 0;
  private auditFailed = 0;
  private evalRunCount = 0;
  private evalRunErrors = 0;
  private evalRegressions = 0;
  private readonly gapReportCounts: Record<GapReportOutcome, number> = { accepted: 0, limited: 0, disabled: 0, failed: 0 };
  private readonly sourceThrottledCounts: Record<SourceThrottleType, number> = { s3: 0, gdrive: 0 };
  private readonly documentScanCounts: Record<DocumentScanOutcome, number> = { scanned: 0, no_content: 0, failed: 0 };
  private readonly documentFindingCounts: Record<PiiRule, number> = { aws_access_key: 0, github_token: 0, private_key: 0, jwt: 0, tckn: 0, iban: 0 };
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
  private readonly toolDuration = this.histogram(
    'contextator_mcp_tool_duration_seconds',
    'Time one MCP tool call took, from its handler starting to its answer, by tool.',
    SECONDS_BUCKETS,
    ['tool'],
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
   * Counts one inbound MCP message. `method` is reduced to `KNOWN_MCP_METHODS` here as well as by the
   * caller, so that no call site can open an unbounded label by forgetting to; `tool` is the caller's to
   * reduce, because only the MCP layer knows which tools exist.
   */
  countMcpRequest(method: string, tool: string, era: McpRequestEra): void {
    const label = KNOWN_MCP_METHODS.has(method) ? method : OTHER_LABEL;
    const key = `${label}\u0000${tool}\u0000${era}`;
    const entry = this.mcpRequestCounts.get(key);
    if (entry) entry.count++;
    else this.mcpRequestCounts.set(key, { method: label, tool, era, count: 1 });
  }

  observeToolDuration(tool: string, seconds: number): void {
    this.toolDuration.observe(seconds, { tool });
  }

  countRateLimited(scope: RateLimitScope): void {
    this.rateLimited[scope]++;
  }

  countRateLimitError(): void {
    this.rateLimitErrors++;
  }

  countAccessDenied(reason: AccessDeniedReason): void {
    this.accessDenied[reason]++;
  }

  /** The guard counters as they stand; copied, so a caller cannot move them. */
  mcpGuard(): McpGuardSample {
    return { rateLimited: { ...this.rateLimited }, rateLimitErrors: this.rateLimitErrors, accessDenied: { ...this.accessDenied } };
  }

  /** The `contextator_mcp_requests_total` series seen so far, in the order they first appeared. */
  mcpRequests(): McpRequestSample[] {
    return [...this.mcpRequestCounts.values()].map((sample) => ({ ...sample }));
  }

  /**
   * Counted here rather than inferred from the table, because the number worth alerting on is the one
   * the table cannot contain: an audit event that could not be written leaves no row to count.
   */
  countAudit(outcome: 'written' | 'failed'): void {
    if (outcome === 'written') this.auditWritten++;
    else this.auditFailed++;
  }

  /** One recorded eval run; an `error` run counts in both the total and the error counter, a regression only when the run was `ok`. */
  countEvalRun(status: 'ok' | 'error', regressed: boolean): void {
    this.evalRunCount++;
    if (status === 'error') this.evalRunErrors++;
    else if (regressed) this.evalRegressions++;
  }

  countGapReport(outcome: GapReportOutcome): void {
    this.gapReportCounts[outcome]++;
  }

  countSourceThrottled(type: SourceThrottleType): void {
    this.sourceThrottledCounts[type]++;
  }

  /** The throttling counters as they stand; copied, so a caller cannot move them. */
  sourceThrottled(): Record<SourceThrottleType, number> {
    return { ...this.sourceThrottledCounts };
  }

  countDocumentScan(outcome: DocumentScanOutcome): void {
    this.documentScanCounts[outcome]++;
  }

  countDocumentFindings(rule: PiiRule, count: number): void {
    this.documentFindingCounts[rule] += count;
  }

  /** The PII scan counters as they stand; copied, so a caller cannot move them. */
  piiScan(): PiiScanSample {
    return { scans: { ...this.documentScanCounts }, findings: { ...this.documentFindingCounts } };
  }

  /** The `report_gap` counters as they stand; copied, so a caller cannot move them. */
  gapReports(): Record<GapReportOutcome, number> {
    return { ...this.gapReportCounts };
  }

  /** The eval counters as they stand. */
  evalRuns(): EvalRunSample {
    return { runs: this.evalRunCount, errors: this.evalRunErrors, regressions: this.evalRegressions };
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

  // Source freshness, one number for the instance (ADR-0105: no project or source label exists, so
  // the worst case is the series). The two timestamp/lag gauges are stated only once some scheduled
  // source has synced: a 0 for "no data" would read as "perfectly fresh" and silence the alert it
  // exists to fire, while `contextator_sources_never_synced` carries the other case.
  if (snapshot.sourceFreshness) {
    const freshness = snapshot.sourceFreshness;
    if (freshness.oldestSyncedAtSeconds !== null && freshness.lagSeconds !== null) {
      family(
        'contextator_source_last_sync_timestamp_seconds',
        'When the scheduled source that has gone longest without a successful sync last synced, across every project.',
        'gauge',
        [['', freshness.oldestSyncedAtSeconds]],
      );
      family(
        'contextator_source_freshness_lag_seconds',
        'Seconds since the least recently synced scheduled source last synced successfully, across every project.',
        'gauge',
        [['', freshness.lagSeconds]],
      );
    }
    family('contextator_sources_never_synced', 'Scheduled sources that have never completed a sync.', 'gauge', [['', freshness.neverSynced]]);
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

  // The server's own eval runs (ADR-0124). Three counters with no label: the instance's, and never a score per
  // project, which would be a label per project (ADR-0105). A regression is a lost question, so the number
  // worth alerting on is `regressions`, and `errors` says the measurement itself did not complete.
  if (snapshot.evalRuns) {
    family('contextator_eval_runs_total', 'Golden-set eval runs recorded since start, errors included.', 'counter', [['', snapshot.evalRuns.runs]]);
    family('contextator_eval_run_errors_total', 'Eval runs that recorded an error instead of figures.', 'counter', [['', snapshot.evalRuns.errors]]);
    family('contextator_eval_regressions_total', 'Eval runs that lost at least one question the previous good run answered.', 'counter', [
      ['', snapshot.evalRuns.regressions],
    ]);
  }

  // `report_gap` calls by what became of them (ADR-0125). A closed set of four and no project, token or
  // text: ADR-0105 allows none of those as a label, and who reported what is in the table. `limited` and
  // `disabled` are answered to the agent as a success, so this counter is the only place they are seen.
  if (snapshot.gapReports) {
    family(
      'contextator_mcp_gap_reports_total',
      'report_gap calls by outcome: accepted, limited (over MCP_REPORT_GAP_PER_HOUR), disabled (query log off for the project) or failed.',
      'counter',
      GAP_REPORT_OUTCOMES.map((outcome): [string, number] => [`{outcome="${outcome}"}`, snapshot.gapReports?.[outcome] ?? 0]),
    );
  }

  // Throttling answers a source's remote gave (ADR-0126 decision 9), counted per answer whether or not a retry
  // then succeeded. The label is the closed set of source types that report one and every value is stated from
  // the start at 0, so a rate that has not happened yet is a flat line and not a missing series (ADR-0105).
  if (snapshot.sourceThrottled) {
    family(
      'contextator_source_throttled_total',
      'Throttling answers a source remote gave (S3 503 SlowDown, Drive 429 and rate-limit 403), by source type, retried or not.',
      'counter',
      SOURCE_THROTTLE_TYPES.map((type): [string, number] => [`{source_type="${type}"}`, snapshot.sourceThrottled?.[type] ?? 0]),
    );
  }

  // The PII scan (ADR-0130). Two closed sets and no project, document or value: ADR-0105 allows none of those as a
  // label, and where a finding is lives in the table the dashboard reads. `failed` is documents the scanner
  // could not scan or write, which is the number worth looking at when the dashboard's pending count does not move.
  if (snapshot.piiScan) {
    const pii = snapshot.piiScan;
    family(
      'contextator_document_scans_total',
      'Documents the PII scan has looked at since start, by outcome: scanned, no_content (text not stored) or failed.',
      'counter',
      DOCUMENT_SCAN_OUTCOMES.map((outcome): [string, number] => [`{outcome="${outcome}"}`, pii.scans[outcome]]),
    );
    family(
      'contextator_document_findings_total',
      'Findings the PII scan has recorded since start, by rule. A document that is rescanned counts again.',
      'counter',
      PII_RULES.map((rule): [string, number] => [`{rule="${rule}"}`, pii.findings[rule]]),
    );
  }

  // Every MCP message by what it asked for and which protocol generation asked it: the `era` split is
  // what says when the last 2025-era client is gone (ADR-0098). The family is stated even before the
  // first message, for the histograms' reason below.
  if (snapshot.mcpRequests) {
    family(
      'contextator_mcp_requests_total',
      'MCP messages received, by method, tool (tools/call only) and protocol era.',
      'counter',
      snapshot.mcpRequests.map((sample) => [
        `{method="${labelValue(sample.method)}",tool="${labelValue(sample.tool)}",era="${labelValue(sample.era)}"}`,
        sample.count,
      ]),
    );
  }

  // The MCP guards. Labels are closed sets and carry neither a token id nor an address (ADR-0112, ADR-0118):
  // who was limited is in the `info` log line, how often is here.
  if (snapshot.mcpGuard) {
    const guard = snapshot.mcpGuard;
    family('contextator_mcp_rate_limited_total', 'MCP requests refused with 429 by the rate limiter, by the limit that was hit.', 'counter', [
      ['{scope="token"}', guard.rateLimited.token],
      ['{scope="anonymous"}', guard.rateLimited.anonymous],
      ['{scope="tool"}', guard.rateLimited.tool],
    ]);
    // Non-zero means the limiter could not count and (by default) let requests through: the limit is not being enforced.
    family('contextator_mcp_rate_limit_errors_total', 'Rate limit checks whose counter statement failed.', 'counter', [['', guard.rateLimitErrors]]);
    family('contextator_mcp_access_denied_total', 'MCP requests refused before the access decision, by reason.', 'counter', [
      ['{reason="network"}', guard.accessDenied.network],
    ]);
  }

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
