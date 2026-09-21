/**
 * The one HTTP surface the `web` driver has ([ADR-0070](../../../.ssot/ADR.md#adr-0070)), as an
 * interface the driver talks to and an implementation that makes the requests.
 *
 * **It is an interface for the same reason `confluence-client.ts` is one**, and for one more: three of
 * this connector's five ceilings — the pacing, the total budget, the per-request timeout — are
 * properties of *when a request is made* rather than of what is done with the answer, and the only way
 * to assert them without a network and without a clock is to be able to stand somewhere in the middle.
 * `test/web-driver.test.ts` counts requests and measures the gaps between them against a stub;
 * `test/integration/web-source.itest.ts` runs the real one against a server on loopback.
 *
 * **This is the only file in the product that reaches a host the operator named.** Every other
 * outbound call goes to a service with an account behind it — a git remote, Notion, Confluence, an
 * embedding API. What that costs, and what it does not protect against, is written down in
 * `README.md`'s security notes rather than left to be inferred from here.
 */

import type { Logger } from '../../context.js';
import { USER_AGENT } from './web-entry.js';

/** One answer, already read. `body` is absent exactly when the server said 304. */
export interface WebResponse {
  /** The URL the answer actually came from, after redirects. Not always the one that was asked for. */
  url: string;
  status: number;
  /** Lower-cased, parameters and all — `text/html; charset=utf-8`. `''` when the server sent none. */
  contentType: string;
  etag?: string;
  lastModified?: string;
  body?: string;
}

/** What a caller remembers about a page so the next request can ask for it conditionally. */
export interface Validators {
  etag?: string;
  lastModified?: string;
}

export interface WebClient {
  /** One GET. Throws for a transport failure or a timeout; a 4xx or 5xx comes back as a status. */
  get(url: string, validators?: Validators): Promise<WebResponse>;
  /**
   * Widen the gap between requests, for a site whose `robots.txt` asked for more than the instance
   * configured. It only ever widens: a `Crawl-delay: 0` is not permission to go faster than
   * `WEB_REQUEST_DELAY_MS`, which is this product's own promise rather than the site's.
   */
  raiseDelayTo(ms: number): void;
  /** Requests made so far, for the run's note. */
  readonly requestCount: number;
}

/**
 * A run that spent its time budget. Distinct from any other failure because the driver's answer to it
 * is different: it keeps everything it fetched, stops, and says why — where a transport failure is a
 * sync that failed.
 */
export class WebBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebBudgetExhaustedError';
  }
}

/**
 * How long one request may take, bounded again by whatever is left of the run's budget.
 *
 * **A constant rather than a sixth setting.** The thing an operator has a reason to tune is how long
 * the *run* may take, and they can: `WEB_CRAWL_BUDGET_MS`. A per-request timeout below that is a
 * detail of not letting one hung socket eat the whole of it, and 30 seconds is longer than any page
 * that is worth indexing takes to answer.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * What one page may weigh before it is refused unread.
 *
 * A local constant and not `MAX_CONVERTED_FILE_BYTES`, for the reason `confluence-render.ts` records
 * for its own: this bounds a string held whole in the process that also serves the dashboard and
 * `/mcp`, at the moment it arrives, and a documentation page is not 8 MiB of anything. The file the
 * driver writes is then subject to the instance-wide conversion ceiling like every other file.
 */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

/** Just enough of `fetch` to be replaceable without any of it reaching a network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' },
) => Promise<Response>;

export interface HttpWebClientOptions {
  /** `WEB_REQUEST_DELAY_MS`, possibly raised by the site's own `Crawl-delay`. */
  delayMs: number;
  /** `WEB_CRAWL_BUDGET_MS`. The clock starts on the first request, not on construction. */
  budgetMs: number;
}

/**
 * HTTPS (and HTTP) against a site, one request at a time, paced, and inside a deadline.
 *
 * **Serial is not an implementation detail here, it is the load model.** Two requests in flight is
 * twice the load on a host that never agreed to any of this, and it would also make the pacing below
 * meaningless. One at a time, `delayMs` apart, is a rate an operator can reason about: at the default
 * it is two requests a second, whatever the site's latency is.
 */
export class HttpWebClient implements WebClient {
  private lastRequestAt = 0;
  private deadlineAt = 0;
  private count = 0;
  private delayMs: number;

  constructor(
    private readonly options: HttpWebClientOptions,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly log?: Logger,
  ) {
    this.delayMs = options.delayMs;
  }

  get requestCount(): number {
    return this.count;
  }

  raiseDelayTo(ms: number): void {
    if (ms > this.delayMs) this.delayMs = ms;
  }

  /** What is left of the run's budget, in milliseconds; `Infinity` before the first request. */
  private remainingMs(): number {
    return this.deadlineAt === 0 ? Number.POSITIVE_INFINITY : this.deadlineAt - Date.now();
  }

  async get(url: string, validators: Validators = {}): Promise<WebResponse> {
    if (this.deadlineAt === 0) this.deadlineAt = Date.now() + this.options.budgetMs;

    // **Checked before the wait and again after it.** The pacing delay can be the thing that spends
    // the last of the budget, and a run that slept past its deadline and then made the request anyway
    // would have a budget that is advice.
    this.assertBudget();
    const wait = Math.min(this.lastRequestAt + this.delayMs - Date.now(), this.remainingMs());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.assertBudget();

    this.lastRequestAt = Date.now();
    this.count++;

    const headers: Record<string, string> = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-encoding': 'gzip, deflate',
      'user-agent': `${USER_AGENT}/1.0 (+https://github.com/contextator)`,
    };
    if (validators.etag) headers['if-none-match'] = validators.etag;
    else if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;

    const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, this.remainingMs()));
    this.log?.debug({ url, timeout }, 'web request');

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    } catch (err) {
      // An abort is the timeout above, and saying which one it was is the difference between "the site
      // is slow" and "this run ran out of time" — two different things for an operator to do.
      const aborted = (err as { name?: string })?.name === 'TimeoutError' || (err as { name?: string })?.name === 'AbortError';
      if (aborted && this.remainingMs() <= 0) this.assertBudget();
      throw new Error(aborted ? `${url} did not answer within ${Math.round(timeout / 1000)}s` : `${url} could not be reached: ${message(err)}`);
    }

    const result: WebResponse = {
      url: response.url || url,
      status: response.status,
      contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
    };
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (etag) result.etag = etag;
    if (lastModified) result.lastModified = lastModified;
    // 304 has no body by definition, and asking for one on a `fetch` Response that has none is a hang
    // waiting to happen on some runtimes.
    if (response.status === 304) return result;
    result.body = await readCapped(response, url);
    return result;
  }

  private assertBudget(): void {
    if (this.remainingMs() > 0) return;
    throw new WebBudgetExhaustedError(
      `the ${Math.round(this.options.budgetMs / 1000)}s crawl budget (WEB_CRAWL_BUDGET_MS) ran out after ${this.count} request(s)`,
    );
  }
}

function message(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const inner = cause instanceof Error ? `${cause.message}` : '';
  const outer = err instanceof Error ? err.message : String(err);
  return inner && inner !== outer ? `${outer} (${inner})` : outer;
}

/**
 * The body, read through a counter and refused at `MAX_PAGE_BYTES`.
 *
 * **`Content-Length` is not trusted and is not even consulted**: a chunked response does not carry one,
 * and one that does carries whatever the server wrote. Streaming the body and stopping at the ceiling
 * is the only bound that holds for both — and it stops *before* the memory is spent rather than
 * reporting afterwards that too much of it was, which is the same distinction `checkFileSize` draws in
 * `doc-types/index.ts`.
 */
async function readCapped(response: Response, url: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) {
        throw new Error(`${url} is over the ${Math.round(MAX_PAGE_BYTES / (1024 * 1024))} MiB one page may be; it is not a documentation page`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}
