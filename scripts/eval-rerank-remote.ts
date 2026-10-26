import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Reranker } from '../src/services/reranker.js';
import type { Report, RowResult } from '../src/services/eval-scoring.js';

/**
 * The remote-rerank arm of the eval harness, and the gate it is judged by (K-22, the 0.5.0 measurement
 * gate).
 *
 * **It is the harness's client, not the product's.** `src/services/reranker.ts` is the local ONNX path
 * and does not change; whether a remote cross-encoder earns a place in the product is exactly what this
 * file exists to find out, so nothing here may leak into `src/` before the answer is in. The client
 * speaks the Hugging Face Text Embeddings Inference `/rerank` shape (`{ query, texts }` in,
 * `[{ index, score }]` out) over `fetch`, which is what a self-hosted `bge-reranker-v2-m3` is served
 * through.
 *
 * **Two things are deliberately loud.** A response that does not score every passage exactly once is an
 * error and not a ranking with holes in it — TEI returns the list sorted by score, and a client that
 * trusted the order instead of the `index` field would measure the sort rather than the model. And the
 * client never falls back to the unreranked order on a failure: a measurement whose arm silently did
 * nothing reads as "the rerank did not help", which is a different and wrong conclusion.
 *
 * It is also a CLI: `tsx scripts/eval-rerank-remote.ts --off off.json --on on.json` takes the two
 * `npm run eval -- --json=<file>` reports of one index — one without the remote rerank, one with — and
 * says whether the gate passed.
 */

/** TEI's default `--max-client-batch-size` is 32; a larger request is refused by the server, not truncated. */
export const DEFAULT_REMOTE_BATCH = 32;
export const DEFAULT_REMOTE_TIMEOUT_MS = 120_000;

export interface RemoteRerankerOptions {
  /** The server's base URL, or its `/rerank` endpoint — both name the same thing. */
  url: string;
  /**
   * Passages per request. A pool of 50 to 94 chunks is several requests; the scores are raw logits, so they merge.
   * TEI takes one permit per passage, so the server's `--max-concurrent-requests` must be at least this
   * number or it answers 429 "Model is overloaded" to a request it could have served.
   */
  batchSize?: number;
  timeoutMs?: number;
  /** Injected by tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The base URL of a rerank server, from what an operator would type: `http://host:8080` or `http://host:8080/rerank`. */
export function parseRerankUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--rerank-url ${JSON.stringify(value)} is not a URL, e.g. --rerank-url http://127.0.0.1:8089`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--rerank-url takes an http or https URL, got ${url.protocol}`);
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/rerank$/, '');
  return url;
}

/**
 * The scores of a `/rerank` response, back in the order the passages were sent.
 *
 * TEI answers in score order with the original position in `index`, so the position is read from the
 * field. Every passage must appear exactly once: a missing or repeated index means the server did not
 * score what was sent, and a gate computed over that would be about something else.
 */
export function parseRerankResponse(body: unknown, count: number): number[] {
  if (!Array.isArray(body)) throw new Error('The rerank server answered something other than a list of { index, score }');
  if (body.length !== count) throw new Error(`The rerank server scored ${body.length} passages of ${count} sent`);
  const scores = new Array<number>(count);
  const seen = new Set<number>();
  for (const item of body as unknown[]) {
    const entry = item as { index?: unknown; score?: unknown } | null;
    const index = entry?.index;
    const score = entry?.score;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`The rerank server returned an index outside 0..${count - 1}: ${JSON.stringify(index)}`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error(`The rerank server returned a non-numeric score for index ${index}`);
    if (seen.has(index)) throw new Error(`The rerank server returned index ${index} twice`);
    seen.add(index);
    scores[index] = score;
  }
  return scores;
}

/** Nearest-rank percentile: the smallest value with at least `p` of the sample at or below it. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export interface LatencySummary {
  /** How many `score()` calls — one per search — the figures are over. */
  searches: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export class RemoteReranker implements Reranker {
  private readonly endpoint: URL;
  private readonly infoEndpoint: URL;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private modelId: string | null = null;
  /** Wall clock of every `score()` call after warm-up: all the requests one search made, end to end. */
  readonly latenciesMs: number[] = [];

  constructor(options: RemoteRerankerOptions) {
    const base = parseRerankUrl(options.url);
    const prefix = base.pathname.replace(/\/+$/, '');
    this.endpoint = new URL(`${prefix}/rerank`, base);
    this.infoEndpoint = new URL(`${prefix}/info`, base);
    this.batchSize = options.batchSize ?? DEFAULT_REMOTE_BATCH;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new Error('The remote rerank batch size must be a positive integer');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `remote-rerank:<model>` once warm-up has asked the server which model it serves, so a report names it. */
  get id(): string {
    return `remote-rerank:${this.modelId ?? this.endpoint.host}`;
  }

  /**
   * Asks the server for its model name and sends one real pair, so the first search does not pay the
   * server's first-request cost and read as latency every search pays. Not counted in `latenciesMs`.
   */
  async warmup(): Promise<void> {
    try {
      const response = await this.fetchImpl(this.infoEndpoint, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.ok) {
        const info = (await response.json()) as { model_id?: unknown };
        if (typeof info.model_id === 'string' && info.model_id !== '') this.modelId = info.model_id.split('/').filter(Boolean).pop() ?? null;
      }
    } catch {
      // `/info` is TEI's own; a compatible server without it is still measurable, just less self-describing.
    }
    await this.scoreBatches('warmup', ['warmup']);
  }

  async score(query: string, passages: readonly string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    const started = performance.now();
    const scores = await this.scoreBatches(query, passages);
    this.latenciesMs.push(performance.now() - started);
    return scores;
  }

  latencySummary(): LatencySummary | null {
    if (this.latenciesMs.length === 0) return null;
    const total = this.latenciesMs.reduce((a, b) => a + b, 0);
    return {
      searches: this.latenciesMs.length,
      meanMs: total / this.latenciesMs.length,
      p50Ms: percentile(this.latenciesMs, 0.5),
      p95Ms: percentile(this.latenciesMs, 0.95),
      maxMs: Math.max(...this.latenciesMs),
    };
  }

  /** The line the report's `Rerank` row carries: what reordered the pool, and what it cost. */
  describe(): string {
    const latency = this.latencySummary();
    const cost = latency ? `, ${latency.searches} searches p50 ${latency.p50Ms.toFixed(0)} ms p95 ${latency.p95Ms.toFixed(0)} ms` : '';
    return `${this.id} at ${this.endpoint.origin}, batch=${this.batchSize}${cost}`;
  }

  private async scoreBatches(query: string, passages: readonly string[]): Promise<number[]> {
    const scores: number[] = [];
    for (let start = 0; start < passages.length; start += this.batchSize) {
      const batch = passages.slice(start, start + this.batchSize);
      // `raw_scores` keeps the logit: the sigmoid saturates near 1 and would tie the confident passages,
      // and a tie is broken by position, which is not a ranking.
      const body = await this.post({ query, texts: batch, raw_scores: true, truncate: true });
      scores.push(...parseRerankResponse(body, batch.length));
    }
    return scores;
  }

  private async post(payload: object): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`The rerank server answered ${response.status} ${response.statusText}: ${text}`);
    }
    return response.json();
  }
}

export function createRemoteReranker(options: RemoteRerankerOptions): RemoteReranker {
  return new RemoteReranker(options);
}

/** The tag that marks the thirty questions asked in one language about a page written in the other. */
export const CROSS_LINGUAL_TAG = 'cross-lingual';

/** The gate's bar for the cross-lingual slice, in thousandths so that 12 of 30 (exactly 40.0 %) is not "more than 40". */
export const CROSS_LINGUAL_FLOOR_PER_MILLE = 400;

export interface SliceComparison {
  questions: number;
  /** Questions whose answer file is in the top five, without and with the rerank. */
  offHits: number;
  onHits: number;
  /** Ids that entered and left the top five. A net figure hides a trade; these do not. */
  gained: string[];
  lost: string[];
  /**
   * The same two counts with every question the relevance floor would refuse (`belowFloor`) taken out of
   * the hits, because a question the product answers "no good match" is not one its user sees answered.
   * Information beside the gate, not a condition of it: the gate reads the harness's own `recall@5`, which
   * does not look at the floor.
   */
  offHitsPastFloor: number;
  onHitsPastFloor: number;
}

export interface RerankGate {
  passed: boolean;
  crossLingual: SliceComparison;
  others: SliceComparison;
  /**
   * How many of the other questions left the top five: the **gross** loss, which is what the gate's second
   * condition reads. A question gained elsewhere does not pay for one lost — `lost` is counted, never netted.
   */
  othersLost: number;
  crossLingualPassed: boolean;
}

const inTopFive = (result: RowResult): boolean => result.rank !== null && result.rank < 5;

function compareSlice(off: ReadonlyMap<string, RowResult>, on: ReadonlyMap<string, RowResult>, ids: readonly string[]): SliceComparison {
  const gained: string[] = [];
  const lost: string[] = [];
  let offHits = 0;
  let onHits = 0;
  let offHitsPastFloor = 0;
  let onHitsPastFloor = 0;
  for (const id of ids) {
    const offResult = off.get(id) as RowResult;
    const onResult = on.get(id) as RowResult;
    const before = inTopFive(offResult);
    const after = inTopFive(onResult);
    if (before) offHits++;
    if (after) onHits++;
    if (before && !offResult.belowFloor) offHitsPastFloor++;
    if (after && !onResult.belowFloor) onHitsPastFloor++;
    if (!before && after) gained.push(id);
    if (before && !after) lost.push(id);
  }
  return { questions: ids.length, offHits, onHits, gained, lost, offHitsPastFloor, onHitsPastFloor };
}

/**
 * The gate, over the same questions asked twice of the same index: **more than 40.0 %** `recall@5` on the
 * cross-lingual slice, **and no loss** of `recall@5` over every other question — read gross: one question
 * leaving the top five fails the gate, whatever else entered it.
 *
 * The two arms must be one measurement apart and no more — same question ids, same corpus, `off` really
 * off and `on` really remote — and anything else is refused, because a gate that compared two different
 * indexes would pass or fail on the index.
 */
export function judgeRerankGate(off: Pick<Report, 'context' | 'results'>, on: Pick<Report, 'context' | 'results'>): RerankGate {
  if (off.context.rerank !== 'off')
    throw new Error(`The "off" report was not run with the rerank off (its rerank row is ${JSON.stringify(off.context.rerank)})`);
  if (!on.context.rerank.startsWith('remote-rerank:')) {
    throw new Error(`The "on" report was not run with --rerank-url (its rerank row is ${JSON.stringify(on.context.rerank)})`);
  }
  if (off.context.documents !== on.context.documents || off.context.chunks !== on.context.chunks) {
    throw new Error('The two reports were run over different indexes (their document or chunk counts differ)');
  }
  const offById = new Map(off.results.map((r) => [r.row.id, r]));
  const onById = new Map(on.results.map((r) => [r.row.id, r]));
  const ids = [...offById.keys()].sort();
  if (ids.length !== onById.size || ids.some((id) => !onById.has(id))) throw new Error('The two reports were run over different question sets');

  const crossLingualIds = ids.filter((id) => (offById.get(id) as RowResult).row.tags.includes(CROSS_LINGUAL_TAG));
  const otherIds = ids.filter((id) => !crossLingualIds.includes(id));
  const crossLingual = compareSlice(offById, onById, crossLingualIds);
  const others = compareSlice(offById, onById, otherIds);
  const crossLingualPassed = crossLingual.questions > 0 && crossLingual.onHits * 1000 > crossLingual.questions * CROSS_LINGUAL_FLOOR_PER_MILLE;
  const othersLost = others.lost.length;
  return { passed: crossLingualPassed && othersLost === 0, crossLingual, others, othersLost, crossLingualPassed };
}

const percent = (hits: number, of: number): string => `${((hits / of) * 100).toFixed(1)} %`;

/** The verdict as plain lines, the first of which is the one a person reads. */
export function formatGate(gate: RerankGate, latency: LatencySummary | null): string {
  const { crossLingual: xl, others } = gate;
  const lines = [
    `GATE: ${gate.passed ? 'PASSED' : 'FAILED'}  cross-lingual recall@5 ${percent(xl.onHits, xl.questions)} (bar: more than 40.0 %), ` +
      `other questions lost from the top five ${gate.othersLost} (gross, gains do not offset; bar: 0)`,
    `cross-lingual (${xl.questions}) recall@5: off ${percent(xl.offHits, xl.questions)} (${xl.offHits}) -> on ${percent(xl.onHits, xl.questions)} (${xl.onHits})`,
    `the other ${others.questions} recall@5: off ${percent(others.offHits, others.questions)} (${others.offHits}) -> on ${percent(others.onHits, others.questions)} (${others.onHits})`,
    `with the relevance floor applied (information, not a gate): cross-lingual on ${xl.onHitsPastFloor}/${xl.questions} (${percent(xl.onHitsPastFloor, xl.questions)}), ` +
      `off ${xl.offHitsPastFloor}/${xl.questions}; the other ${others.questions} on ${others.onHitsPastFloor}, off ${others.offHitsPastFloor}`,
    `gained in the top five: ${[...xl.gained, ...others.gained].join(', ') || 'none'}`,
    `lost from the top five: ${[...xl.lost, ...others.lost].join(', ') || 'none'}`,
  ];
  if (latency) {
    lines.push(
      `rerank latency per search (information, not a gate): p50 ${latency.p50Ms.toFixed(0)} ms, p95 ${latency.p95Ms.toFixed(0)} ms, ` +
        `max ${latency.maxMs.toFixed(0)} ms over ${latency.searches} searches`,
    );
  }
  return lines.join('\n');
}

const USAGE = `Usage: tsx scripts/eval-rerank-remote.ts --off <report.json> --on <report.json> [--latency <file>]

  --off <file>      A report from "npm run eval -- --json=<file>" with no remote rerank.
  --on <file>       A report of the same index from "npm run eval -- --rerank-url <url> --json=<file>".
  --latency <file>  The latency file that run wrote with --rerank-latency=<file>. Printed, never gated.

  Exits 0 when the gate passes, 2 when it does not, 1 when the two reports cannot be compared.
`;

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '-h' || flag === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (flag !== '--off' && flag !== '--on' && flag !== '--latency') throw new Error(`Unknown option ${JSON.stringify(flag)}\n\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) throw new Error(`${flag} takes a file`);
    values.set(flag, path.resolve(process.env.INIT_CWD ?? process.cwd(), value));
    i++;
  }
  const offFile = values.get('--off');
  const onFile = values.get('--on');
  if (!offFile || !onFile) throw new Error(`--off and --on are both required\n\n${USAGE}`);
  const gate = judgeRerankGate((await readJson(offFile)) as Report, (await readJson(onFile)) as Report);
  const latencyFile = values.get('--latency');
  const latency = latencyFile ? ((await readJson(latencyFile)) as LatencySummary) : null;
  process.stdout.write(`${formatGate(gate, latency)}\n`);
  return gate.passed ? 0 : 2;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`eval-rerank-remote failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
