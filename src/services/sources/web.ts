import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentSourceRow } from '../../db/schema.js';
import { sourceCurrentDir, sourceDir } from '../data-dir.js';
import { ValidationError } from '../projects.js';
import { PROBE_TOKEN_KEY, parseSourceConfig, type WebConfig } from '../sources.js';
import { registerDriver, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
import { HttpWebClient, WebBudgetExhaustedError, type WebClient, type WebResponse } from './web-client.js';
import {
  allowEverything,
  detectEntryKind,
  type EntryKind,
  extractLinks,
  hasIndexableText,
  inCrawlScope,
  type ListedUrl,
  looksLikeSitemap,
  parseLlmsTxt,
  parseRobots,
  parseSitemap,
  pathForUrl,
  type RobotsRules,
  shortHash,
} from './web-entry.js';

/**
 * A published documentation site as a source ([ADR-0070](../../../.ssot/ADR.md#adr-0070)): the pages a
 * `sitemap.xml`, an `llms.txt` or a walk from one start URL names, fetched and written under
 * `<source>/<the site's own path>`.
 *
 * **The driver fetches and converts nothing.** `.html` has been a document type since
 * [ADR-0056](../../../.ssot/ADR.md#adr-0056) and `doc-types/html.ts` is where a page becomes Markdown,
 * for every source type at once. A connector that produced Markdown itself would be a second HTML
 * converter in the product, differing from the first on the day somebody fixed one of them — which is
 * why `sources/confluence.ts` reaches for the shared transform too, from the other direction.
 *
 * **It is the only driver that reaches a host nobody here has an account with**, and that is what the
 * five ceilings in `config.ts` are for. Every one of them is enforced in this file or the client
 * beneath it: the page count and the depth here, the pacing and the time budget inside `HttpWebClient`,
 * and `robots.txt` at the top of every entry point below. A crawler that carried them as documentation
 * rather than as code would be a product that knocks over its operator's own documentation site on a
 * timer.
 *
 * **Out of scope, stated rather than discovered:** sites behind a login — this type holds no credential
 * at all, by design — and pages a browser renders from JavaScript, for which see `hasIndexableText`,
 * which refuses such a page *by name* instead of indexing a blank document.
 */
export class WebDriver implements SourceDriver {
  private readonly cfg: WebConfig;
  private built?: WebClient;

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
    /** Stands in for the network in tests; in production one is built from the instance's ceilings. */
    private readonly injectedClient?: WebClient,
  ) {
    this.cfg = parseSourceConfig('web', source.config);
  }

  /**
   * The client this call uses, built once per driver.
   *
   * **Once per driver and not once per process**, which is what makes the time budget mean what it
   * says: the clock starts at a client's first request, a driver is constructed fresh for every sync
   * and every probe (`driverFor`), and so `sync()` and the `probe()` that follows it are two separate
   * budgets. Sharing one would hand an exhausted budget to the probe that exists to make the *next*
   * run cheap — the source would stop minting tokens exactly when it most needed one.
   */
  private client(): WebClient {
    if (this.injectedClient) return this.injectedClient;
    this.built ??= new HttpWebClient(
      { delayMs: this.ctx.config.WEB_REQUEST_DELAY_MS, budgetMs: this.ctx.config.WEB_CRAWL_BUDGET_MS },
      undefined,
      this.ctx.log.child({ source: this.source.name, type: 'web' }),
    );
    return this.built;
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Where this driver remembers each page's `ETag` and `Last-Modified`.
   *
   * **Beside `current/` and deliberately not inside it.** The indexer walks that directory for exactly
   * the file types this driver writes; a JSON file living among them would either be scanned as a
   * document or need the walk taught an exception. One directory up it is simply not in the tree the
   * scan reads — the same reason `data-dir.ts` puts upload staging in a dot-directory.
   *
   * It also cannot be front matter, which is how the Notion and Confluence drivers carry a page's
   * version. Front matter in an HTML file is not front matter, it is a line of text above the page, and
   * `doc-types/html.ts` would index it as prose.
   */
  private statePath(): string {
    return path.join(sourceDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id), 'web-state.json');
  }

  private async readState(): Promise<WebState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath(), 'utf8')) as WebState;
      if (parsed?.version === STATE_VERSION && parsed.pages && typeof parsed.pages === 'object') return parsed;
    } catch {
      // No state, unreadable state, or state of a shape this build does not know: re-fetch everything.
      // That is a slower run, never a wrong one, and it is the direction every uncertainty in this
      // connector resolves toward.
    }
    return { version: STATE_VERSION, pages: {} };
  }

  /**
   * `robots.txt` for the entry point's origin.
   *
   * **A file that could not be read is not permission.** RFC 9309 §2.3.1.4 separates *unavailable* — a
   * 4xx, meaning the site published no rules, so there are none — from *unreachable*, a 5xx or a
   * transport failure, meaning the site has rules and this crawler could not see them. The first allows
   * everything; the second fails the sync by name, because crawling a site whose wishes could not be
   * read is the one thing this driver must not do quietly. `WEB_RESPECT_ROBOTS=0` is the documented way
   * past it and exists for an operator crawling a site they own.
   */
  private async robotsFor(client: WebClient): Promise<RobotsRules> {
    if (!this.ctx.config.WEB_RESPECT_ROBOTS) return allowEverything();
    const url = new URL('/robots.txt', this.cfg.entryUrl).href;
    let response: WebResponse;
    try {
      response = await client.get(url);
    } catch (err) {
      if (err instanceof WebBudgetExhaustedError) throw err;
      throw new ValidationError(
        `${url} could not be read, so this source cannot know what the site allows: ${err instanceof Error ? err.message : String(err)}. ` +
          'Fix the site, or set WEB_RESPECT_ROBOTS=0 on this instance if the site is yours.',
      );
    }
    if (response.status >= 500) {
      throw new ValidationError(
        `${url} answered ${response.status}, so this source cannot know what the site allows. A server error is not permission. ` +
          'Try again later, or set WEB_RESPECT_ROBOTS=0 on this instance if the site is yours.',
      );
    }
    if (response.status !== 200 || !response.body) return allowEverything();
    const rules = parseRobots(response.body);
    client.raiseDelayTo(rules.crawlDelayMs);
    return rules;
  }

  /** The entry document, fetched once, with the kind it turned out to be. Throws when it cannot say. */
  private async readEntry(client: WebClient, robots: RobotsRules): Promise<{ kind: EntryKind; response: WebResponse }> {
    const entry = new URL(this.cfg.entryUrl);
    if (!robots.allows(`${entry.pathname}${entry.search}`)) {
      throw new ValidationError(`${this.cfg.entryUrl} is disallowed by the site's robots.txt, so this source has no entry point to read.`);
    }
    const response = await client.get(this.cfg.entryUrl);
    if (response.status !== 200 || !response.body) {
      throw new ValidationError(`${this.cfg.entryUrl} answered ${response.status}; a web source needs an entry point it can read.`);
    }

    if (this.cfg.entryKind === 'sitemap' && !looksLikeSitemap(response.body)) {
      throw new ValidationError(
        `${this.cfg.entryUrl} is set to be read as a sitemap but contains no <urlset> or <sitemapindex>. ` +
          'Check the URL, or change this source\'s "Entry format" setting.',
      );
    }
    if (this.cfg.entryKind !== 'auto') return { kind: this.cfg.entryKind, response };

    const detected = detectEntryKind(response.contentType, response.body);
    // **The refusal the "Entry format" setting exists for.** Guessing here produces a source that
    // indexes one page, or none, and reports success. An entry point that does not say what it is gets
    // asked about rather than assumed — the only honest answer to an ambiguity, and the reason this
    // connector has a setting it expects almost nobody to touch.
    if (!detected) {
      throw new ValidationError(
        `${this.cfg.entryUrl} answered ${response.contentType || 'no content type'} and is not recognisably a sitemap, an llms.txt or an HTML page. ` +
          'Set this source\'s "Entry format" to Sitemap, llms.txt or Crawl to say which it is; it is not guessed.',
      );
    }
    return { kind: detected, response };
  }

  async test(): Promise<string> {
    const client = this.client();
    const robots = await this.robotsFor(client);
    const { kind, response } = await this.readEntry(client, robots);
    const body = response.body ?? '';
    const pacing = `one request every ${Math.max(this.ctx.config.WEB_REQUEST_DELAY_MS, robots.crawlDelayMs)} ms`;
    const ceiling = `at most ${this.ctx.config.WEB_MAX_PAGES} page(s), ${pacing}`;

    if (kind === 'sitemap') {
      const { urls, sitemaps } = parseSitemap(body, response.url);
      const nested = sitemaps.length ? `, ${sitemaps.length} nested sitemap(s)` : '';
      return `Read a sitemap: ${urls.length} page(s)${nested}. A run would index ${ceiling}.`;
    }
    if (kind === 'llms') {
      const listed = parseLlmsTxt(body, response.url);
      if (listed.length === 0)
        throw new Error(`${response.url} was read as an llms.txt but holds no links; there is nothing for this source to index.`);
      return `Read an llms.txt: ${listed.length} page(s). A run would index ${ceiling}.`;
    }
    const links = extractLinks(body, response.url).filter((link) => inCrawlScope(link, this.cfg.entryUrl));
    return (
      `Read the page: ${links.length} link(s) inside ${scopeOf(this.cfg.entryUrl)}. ` +
      `A crawl would follow them up to ${this.ctx.config.WEB_MAX_DEPTH} level(s) and index ${ceiling}.`
    );
  }

  async sync(): Promise<SyncResult> {
    const client = this.client();
    const root = await this.docRoot();
    const previous = await this.readState();
    const existingFiles = await walkFiles(root);
    const run = new RunState(this.ctx.config.WEB_MAX_PAGES);

    // **Both of these happen before a single page is fetched, and in this order.** `robots.txt` first,
    // because the entry point itself is a path the site may have disallowed and asking for it before
    // reading the rules would be the one thing this driver must not do; the entry point second,
    // because what it turns out to be decides which of the two walkers below runs.
    const robots = await this.robotsFor(client);
    const { kind, response } = await this.readEntry(client, robots);

    const fetch = (url: string, prefetched?: WebResponse): Promise<string | undefined> =>
      this.fetchPage({ client, robots, run, root, previous, existingFiles, url, prefetched });

    try {
      if (kind === 'crawl') await this.crawl(run, response, fetch);
      else await this.fetchListing(run, this.listedUrls(kind, response), fetch);
    } catch (err) {
      // **A spent budget stops the run; it does not fail it.** Everything already written stays, the
      // removal pass below is skipped — pages this run never reached are not deletions — and the note
      // says what happened. Anything else is a sync that failed, and it leaves.
      if (!(err instanceof WebBudgetExhaustedError)) throw err;
      run.stop(err.message);
    }

    // **A site that answered nothing is a failure, not an empty site** — the refusal
    // `sources/confluence.ts` makes, for the same reason. A sitemap behind a CDN that briefly serves a
    // landing page, or an `llms.txt` that was renamed, both look like "no pages" with a 200, and the
    // removal pass below would delete every document this source ever contributed while reporting
    // complete success.
    if (run.indexed === 0 && existingFiles.size > 0) {
      throw new ValidationError(
        `${this.cfg.entryUrl} yielded no page this source could index, but it already holds ${existingFiles.size} document(s). Refusing to delete them. ` +
          (run.failures.length ? `The pages it tried: ${run.failures.slice(0, 5).join('; ')}` : 'Check that the entry point is still correct.'),
      );
    }

    let removed = 0;
    if (!run.stopped) {
      for (const file of existingFiles) {
        if (run.keptPaths.has(file)) continue;
        await fs.rm(path.join(root, ...file.split('/')), { force: true });
        removed++;
      }
    }
    await this.writeState({ version: STATE_VERSION, pages: run.pages });

    // One more request at the end of a run that just made many, buying every future consideration of
    // this source the chance to cost exactly one ([ADR-0048](../../../.ssot/ADR.md#adr-0048)). It is
    // `probe()` itself rather than a token computed from what was just listed, so that both sides of
    // the scheduler's comparison are the same function of the same source.
    const token = await this.probe().catch((err: unknown) => {
      this.ctx.log.warn({ err, source: this.source.name }, 'web probe failed after a successful sync; the next scheduled run will not be skipped');
      return null;
    });
    return {
      note: run.note(kind, removed, client.requestCount, this.ctx.config.WEB_RESPECT_ROBOTS),
      ...(token === null ? {} : { configPatch: { [PROBE_TOKEN_KEY]: token } }),
    };
  }

  /**
   * The pages a `sitemap.xml` or an `llms.txt` names, with the nested-sitemap walk folded in.
   *
   * A `<sitemapindex>` is a tree and nothing stops it being a cyclic one, so `seen` and the depth
   * ceiling are both load-bearing. The ceiling is `WEB_MAX_DEPTH` rather than a number of its own
   * because it answers the same question a crawl's depth does: how far from the entry point this
   * source is willing to go.
   */
  private async *listedUrls(kind: Exclude<EntryKind, 'crawl'>, entry: WebResponse): AsyncGenerator<ListedUrl> {
    const body = entry.body ?? '';
    if (kind === 'llms') {
      const listed = parseLlmsTxt(body, entry.url);
      if (listed.length === 0) {
        throw new ValidationError(
          `${entry.url} was read as an llms.txt but holds no links. llms.txt is a draft standard and this reader is deliberately loose, ` +
            "so this means the file really has no Markdown links in it — check the URL, or point this source at the site's sitemap.xml instead.",
        );
      }
      yield* listed;
      return;
    }

    const host = new URL(this.cfg.entryUrl).host;
    const seen = new Set<string>([entry.url, this.cfg.entryUrl]);
    let frontier: Array<{ url: string; xml: string }> = [{ url: entry.url, xml: body }];
    for (let depth = 0; depth <= this.ctx.config.WEB_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: Array<{ url: string; xml: string }> = [];
      for (const { url, xml } of frontier) {
        const doc = parseSitemap(xml, url);
        yield* doc.urls;
        if (depth === this.ctx.config.WEB_MAX_DEPTH) continue;
        for (const child of doc.sitemaps) {
          if (seen.has(child.url) || new URL(child.url).host !== host) continue;
          seen.add(child.url);
          const response = await this.client().get(child.url);
          if (response.status === 200 && response.body && looksLikeSitemap(response.body)) next.push({ url: response.url, xml: response.body });
          else this.ctx.log.warn({ child: child.url, status: response.status }, 'nested sitemap could not be read; its pages are not indexed');
        }
      }
      frontier = next;
    }
  }

  private async fetchListing(run: RunState, listing: AsyncGenerator<ListedUrl>, fetch: Fetch): Promise<void> {
    const host = new URL(this.cfg.entryUrl).host;
    for await (const listed of listing) {
      if (run.full()) return run.stopAtPageCeiling();
      // A sitemap index may legitimately span subdomains; this source is one host, and the ones it
      // dropped are counted rather than quietly ignored.
      if (new URL(listed.url).host !== host) {
        run.offSite++;
        continue;
      }
      await fetch(listed.url);
    }
  }

  /** One start URL, breadth-first, inside the host and path prefix `inCrawlScope` derives from it. */
  private async crawl(run: RunState, entry: WebResponse, fetch: Fetch): Promise<void> {
    const maxDepth = this.ctx.config.WEB_MAX_DEPTH;
    const queued = new Set<string>([entry.url, this.cfg.entryUrl]);
    // The entry page arrives with its body already read: the request that decided the entry format is
    // the same request that fetched it, and asking twice would be a wasted round trip against somebody
    // else's server on every single sync.
    let frontier: Array<{ url: string; prefetched?: WebResponse }> = [{ url: entry.url, prefetched: entry }];

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: Array<{ url: string; prefetched?: WebResponse }> = [];
      for (const page of frontier) {
        if (run.full()) return run.stopAtPageCeiling();
        const body = await fetch(page.url, page.prefetched);
        if (!body) continue;
        for (const link of extractLinks(body, page.url)) {
          if (queued.has(link) || !inCrawlScope(link, this.cfg.entryUrl)) continue;
          queued.add(link);
          // At the ceiling the links are still *counted* — so the run can say pages were left behind —
          // but they are not queued. A depth limit nobody is told about is a site that looks indexed.
          if (depth === maxDepth) run.beyondDepth++;
          else next.push({ url: link });
        }
      }
      frontier = next;
    }
    if (run.beyondDepth > 0) run.stopAtDepthCeiling(maxDepth);
  }

  /**
   * One page: asked for conditionally, checked, and written — or refused **by name and with a reason**.
   *
   * Returns the page's text when there is any, so a crawl can read its links; `undefined` when the page
   * was skipped, unchanged or refused. A refusal never fails the run: it joins `failures`, the note
   * carries it onto the source's row, and the page's previous file — if it had one — is left alone.
   */
  private async fetchPage(args: {
    client: WebClient;
    robots: RobotsRules;
    run: RunState;
    root: string;
    previous: WebState;
    existingFiles: ReadonlySet<string>;
    url: string;
    prefetched?: WebResponse;
  }): Promise<string | undefined> {
    const { client, robots, run, root, previous, existingFiles, url } = args;
    const parsed = new URL(url);
    if (!robots.allows(`${parsed.pathname}${parsed.search}`)) {
      run.skippedByRobots++;
      return undefined;
    }

    const known = previous.pages[url];
    let response: WebResponse;
    if (args.prefetched) response = args.prefetched;
    else {
      // A validator is only worth sending while the file it belongs to is still on disk; otherwise a
      // 304 would keep a document whose bytes are gone.
      const conditional = known && existingFiles.has(known.path) ? { etag: known.etag, lastModified: known.lastModified } : {};
      try {
        response = await client.get(url, conditional);
      } catch (err) {
        if (err instanceof WebBudgetExhaustedError) throw err;
        run.failures.push(`${url} (${err instanceof Error ? err.message : String(err)})`);
        return undefined;
      }
    }

    if (response.status === 304 && known) {
      run.keep(known.path, url, known);
      run.unchanged++;
      return undefined;
    }
    if (response.status !== 200) {
      run.failures.push(`${url} (HTTP ${response.status})`);
      return undefined;
    }

    const body = response.body ?? '';
    const extension = extensionFor(response.contentType, url);
    if (!extension) {
      run.failures.push(
        `${url} (served as ${response.contentType.split(';')[0].trim() || 'no content type'}, which is not a page this source can read)`,
      );
      return undefined;
    }
    // **A page whose content could not be extracted is refused, not indexed empty.** For HTML that
    // means: no text outside the scripts and styles, which is what a site rendered in the browser
    // serves to everything that is not a browser. There is no headless browser in this product and the
    // alternative is a document that exists, matches nothing and reads as blank — the failure
    // [ADR-0056](../../../.ssot/ADR.md#adr-0056) refused for a PDF with no text layer, one layer
    // earlier and with the real cause named.
    const empty = extension === 'html' ? !hasIndexableText(body) : body.trim() === '';
    if (empty) {
      run.failures.push(
        extension === 'html'
          ? `${url} (no text outside its scripts and styles — a page rendered in the browser by JavaScript needs a headless browser, which this product does not have)`
          : `${url} (the response had no text in it)`,
      );
      return undefined;
    }

    const relative = run.claimPath(pathForUrl(url, extension), url);
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body, 'utf8');
    const state: PageState = { path: relative };
    if (response.etag) state.etag = response.etag;
    if (response.lastModified) state.lastModified = response.lastModified;
    run.keep(relative, url, state);
    run.written++;
    return body;
  }

  private async writeState(state: WebState): Promise<void> {
    const file = this.statePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state), 'utf8');
  }

  /**
   * How fresh the site is, in one request — but only when the site is in a position to say.
   *
   * **`null` for two of the three entry formats, and that is the honest answer rather than a gap.** The
   * interface's first rule is that `null` means "run it" and that every uncertainty resolves toward the
   * run; this connector has a real uncertainty in two of its three shapes:
   *
   * - A **crawl** has no listing at all. The entry page's own `ETag` moves when the entry page changes,
   *   which says nothing about the hundred pages below it. A token built from it would answer
   *   "unchanged" about a site that had been rewritten, and the source would go quiet in the way that
   *   looks exactly like a source with nothing to do.
   * - An **`llms.txt`** is a list of links. Its validators move when the *list* changes, not when a page
   *   on it does. Same failure, same answer.
   * - A **sitemap** whose entries carry `<lastmod>` is the case that works, and the case the format was
   *   designed for: one request says how many pages there are and when the newest of them was touched.
   *   Both halves, for the reason `directoryRevision` and the Confluence probe both record — a
   *   timestamp alone cannot see a deletion, and a count alone cannot see an edit.
   *
   * A sitemap carrying **no** `lastmod` anywhere gets `null` too. `pages=N;lastmod=none` would be a
   * token that never moves on an edit, which is not an optimisation; it is a source that has silently
   * stopped syncing, dressed as a working one.
   */
  async probe(): Promise<string | null> {
    // **The cheapest probe is the one that makes no request at all.** A source whose entry format is
    // set to `crawl` or `llms` can never answer anything but `null`, so asking the site is pure cost —
    // a scheduled tick would fetch `robots.txt` and the entry point every interval, for every such
    // source, to arrive at a foregone conclusion. Only `sitemap` and `auto` have to look.
    if (this.cfg.entryKind === 'crawl' || this.cfg.entryKind === 'llms') return null;
    const client = this.client();
    const robots = await this.robotsFor(client);
    const { kind, response } = await this.readEntry(client, robots);
    if (kind !== 'sitemap') return null;

    const { urls, sitemaps } = parseSitemap(response.body ?? '', response.url);
    // An index states each child's `<lastmod>`, which is that element's whole purpose; measuring off it
    // is what lets a site of a hundred thousand pages be probed without fetching one child.
    const entries = urls.length > 0 ? urls : sitemaps;
    const newest = entries
      .map((entry) => entry.lastmod)
      .filter((stamp): stamp is string => Boolean(stamp))
      .sort()
      .pop();
    if (!newest) return null;
    return `pages=${entries.length};lastmod=${newest}`;
  }
}

/** What `sync()` hands its two walkers so neither of them has to know how a page is fetched. */
type Fetch = (url: string, prefetched?: WebResponse) => Promise<string | undefined>;

const STATE_VERSION = 1;

/** What the driver remembers about one page between runs, so the next request can be conditional. */
interface PageState {
  /** Where its file lives, relative to the source root. */
  path: string;
  etag?: string;
  lastModified?: string;
}

interface WebState {
  version: number;
  pages: Record<string, PageState>;
}

/**
 * The extension a response is written with, or `null` when it is not something this source reads.
 *
 * **Three types and not one, because an `llms.txt` is a list of Markdown files.** That is the format's
 * entire purpose — a documentation site publishing the plain-text version of each page beside the
 * rendered one — and a connector that wrote every answer as `.html` would hand Markdown to turndown,
 * which would strip the `#` off every heading it was given. The content type decides, and the URL's own
 * suffix breaks the tie that `text/plain` leaves, because that is what a static host serves a `.md` as.
 */
export function extensionFor(contentType: string, url: string): 'html' | 'md' | 'txt' | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'md';
  if (mime === 'text/plain' || mime === '') return /\.(?:md|markdown|mdx)(?:$|\?)/i.test(new URL(url).pathname) ? 'md' : 'txt';
  return null;
}

/** Everything one run accumulates, and the sentence it turns into on the source's row. */
class RunState {
  written = 0;
  unchanged = 0;
  skippedByRobots = 0;
  offSite = 0;
  /** In-scope links found at the depth ceiling and therefore never queued. */
  beyondDepth = 0;
  readonly failures: string[] = [];
  readonly pages: Record<string, PageState> = {};
  readonly keptPaths = new Set<string>();
  private stopReason: string | null = null;

  constructor(private readonly maxPages: number) {}

  /** Pages this run holds, whether it fetched them or kept them on a 304. */
  get indexed(): number {
    return this.written + this.unchanged;
  }

  /** Set when a ceiling stopped the run early; suppresses the removal pass and is said on the row. */
  get stopped(): boolean {
    return this.stopReason !== null;
  }

  full(): boolean {
    return this.indexed >= this.maxPages;
  }

  stop(reason: string): void {
    this.stopReason ??= reason;
  }

  /**
   * **Reaching a ceiling is said out loud**, for the reason `MAX_PAGES` in `sources/confluence.ts`
   * states at length: a site that looks indexed and is two thirds indexed answers "not in the
   * documentation" about pages that exist, which is the worst answer this product can give.
   */
  stopAtPageCeiling(): void {
    this.stop(
      `STOPPED AT THE ${this.maxPages}-PAGE CEILING (WEB_MAX_PAGES): this site holds more pages than that and the rest are NOT indexed. ` +
        'Point this source at a narrower part of the site, split it across several sources, or raise the ceiling.',
    );
  }

  stopAtDepthCeiling(maxDepth: number): void {
    this.stop(
      `STOPPED AT THE ${maxDepth}-LEVEL DEPTH CEILING (WEB_MAX_DEPTH): ${this.beyondDepth} link(s) further than that from the entry point are NOT indexed.`,
    );
  }

  keep(relativePath: string, url: string, state: PageState): void {
    this.keptPaths.add(relativePath);
    this.pages[url] = state;
  }

  /**
   * The path this URL gets, with a collision resolved rather than silently overwritten.
   *
   * Two URLs can want one file name — `/Guide` and `/guide`, or two paths differing only in characters
   * the sanitiser folds. Whichever arrived second would otherwise overwrite the first, and the run
   * would report two pages where one file exists.
   */
  claimPath(candidate: string, url: string): string {
    if (!this.keptPaths.has(candidate)) return candidate;
    const dot = candidate.lastIndexOf('.');
    return `${candidate.slice(0, dot)}--${shortHash(url)}${candidate.slice(dot)}`;
  }

  note(kind: EntryKind, removed: number, requests: number, respectsRobots: boolean): string {
    const parts = [`${kind}: ${this.written} fetched, ${this.unchanged} unchanged, ${removed} removed, ${requests} request(s)`];
    if (this.skippedByRobots > 0) parts.push(`${this.skippedByRobots} skipped by robots.txt`);
    else if (!respectsRobots) parts.push('robots.txt not consulted (WEB_RESPECT_ROBOTS=0)');
    if (this.offSite > 0) parts.push(`${this.offSite} off-site URL(s) skipped`);
    if (this.failures.length > 0) {
      const shown = this.failures.slice(0, 10).join('; ');
      parts.push(`refused: ${shown}${this.failures.length > 10 ? ` (+${this.failures.length - 10} more)` : ''}`);
    }
    if (this.stopReason) parts.push(this.stopReason);
    return parts.join(' — ');
  }
}

/** The host and path prefix a single start URL defines, as a sentence for the "Test" button. */
function scopeOf(entryUrl: string): string {
  const url = new URL(entryUrl);
  const prefix = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  return `${url.host}${prefix}`;
}

/** Every file under `root`, as `/`-joined relative paths. The set both the skip and the removal read. */
async function walkFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), [...rel, entry.name]);
      else if (entry.isFile()) out.add([...rel, entry.name].join('/'));
    }
  };
  await walk(root, []);
  return out;
}

registerDriver('web', (source, ctx) => new WebDriver(source, ctx));
