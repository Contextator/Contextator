/**
 * A `WebClient` answering out of a map of URL → response, shared by the unit suite and anything else
 * that needs a site without a server ([ADR-0070](../../.ssot/ADR.md#adr-0070)).
 *
 * **It records every request, which is half of what there is to assert about a crawler.** What a
 * connector *fetched* — and, just as much, what it did not fetch because `robots.txt` said so, or
 * because a ceiling stopped it — is not visible in the files it wrote. `requests` is.
 *
 * Conditional GETs are honoured the way a real server honours them, because the incremental path is
 * the one that silently stops working: a stub that always answered 200 would let a driver that never
 * sent a validator pass every test in the file.
 */

import type { Validators, WebClient, WebResponse } from '../../src/services/sources/web-client.js';

export interface StubPage {
  status?: number;
  /** Defaults to `text/html; charset=utf-8`. */
  contentType?: string;
  body?: string;
  etag?: string;
  lastModified?: string;
  /** Answer by throwing, the way a transport failure does. */
  error?: string;
}

export class StubWeb implements WebClient {
  readonly requests: Array<{ url: string; validators: Validators }> = [];
  /** What `robots.txt`'s `Crawl-delay` raised the pacing to, so a test can assert it was read. */
  delayMs = 0;

  constructor(public pages: Record<string, StubPage>) {}

  get requestCount(): number {
    return this.requests.length;
  }

  /** Every URL asked for, in order, so an assertion can be about the requests rather than the files. */
  get urls(): string[] {
    return this.requests.map((r) => r.url);
  }

  raiseDelayTo(ms: number): void {
    if (ms > this.delayMs) this.delayMs = ms;
  }

  async get(url: string, validators: Validators = {}): Promise<WebResponse> {
    this.requests.push({ url, validators });
    const page = this.pages[url];
    // A URL nothing was registered for is a 404, which is what a site answers for a link that rotted.
    if (!page) return { url, status: 404, contentType: 'text/html' };
    if (page.error) throw new Error(page.error);

    const headers: Pick<WebResponse, 'etag' | 'lastModified'> = {};
    if (page.etag) headers.etag = page.etag;
    if (page.lastModified) headers.lastModified = page.lastModified;
    const contentType = page.contentType ?? 'text/html; charset=utf-8';

    const matched =
      (page.etag !== undefined && validators.etag === page.etag) ||
      (page.etag === undefined && page.lastModified !== undefined && validators.lastModified === page.lastModified);
    if (matched) return { url, status: 304, contentType, ...headers };

    return { url, status: page.status ?? 200, contentType, body: page.body ?? '', ...headers };
  }
}

/** A minimal HTML page with real prose in it, for the many cases that only need "a page". */
export function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}
