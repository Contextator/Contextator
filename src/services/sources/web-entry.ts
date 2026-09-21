/**
 * Everything the `web` driver knows how to read, as pure functions over strings
 * ([ADR-0070](../../../.ssot/ADR.md#adr-0070)): the three entry formats, `robots.txt`, the links of a
 * page, and the rule that turns a URL into a path on disk.
 *
 * **Nothing here touches a network, a clock or a filesystem**, which is why the awkward half of this
 * connector — a sitemap index that points at itself, a `robots.txt` whose longest rule wins, a URL
 * whose path segment is `..` — is asserted in a unit test rather than being reachable only through a
 * server. `web-client.ts` is the part that makes requests; `web.ts` is the part that decides which.
 *
 * **Pure JavaScript, and no XML parser.** A sitemap is a flat document of three element names and a
 * regex reads it exactly as reliably as a parser would, which matters more than it looks: the image
 * this ships in is built for two architectures, and a native parser is a dependency whose absence only
 * shows up on the `arm64` half of it — the same reason `doc-types/html.ts` records for turndown.
 */

/** The three shapes an operator can point a web source at. */
export type EntryKind = 'sitemap' | 'llms' | 'crawl';

/** One URL a listing offered, with whatever freshness the listing itself stated. */
export interface ListedUrl {
  url: string;
  /** `<lastmod>`, verbatim. Absent when the sitemap did not say — which `probe()` treats as "run it". */
  lastmod?: string;
}

/** What one `<urlset>` or `<sitemapindex>` document contained. */
export interface SitemapDocument {
  /** Pages, from a `<urlset>`. */
  urls: ListedUrl[];
  /**
   * Child sitemaps, from a `<sitemapindex>`, each with its own `<lastmod>` when the index stated one.
   *
   * The stamps matter as much as the URLs: an index that dates its children is what lets `probe()`
   * measure a site of a hundred thousand pages in one request, without fetching a single child.
   */
  sitemaps: ListedUrl[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** XML and HTML share the five predefined entities; a numeric reference is the rest of what appears here. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** `<![CDATA[…]]>` around a `<loc>` is legal and is what one generator in ten writes. */
function uncdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return match ? match[1] : value;
}

function textOf(raw: string): string {
  return decodeEntities(uncdata(raw)).trim();
}

/**
 * The first `<loc>` of a block, **preferring the one with no namespace prefix**.
 *
 * An image sitemap nests `<image:loc>` inside the `<url>` it belongs to, and a reader that took the
 * first `loc`-shaped element would index the JPEG instead of the page that shows it. Taking the
 * unprefixed one when there is one is the whole of the fix, and the prefixed fallback is there because
 * a document that puts the sitemap namespace on a prefix — `<sm:loc>` — is unusual but valid.
 */
function locOf(block: string): string {
  const plain = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(block);
  if (plain) return textOf(plain[1]);
  const prefixed = /<[a-z0-9]+:loc\b[^>]*>([\s\S]*?)<\/[a-z0-9]+:loc\s*>/i.exec(block);
  return prefixed ? textOf(prefixed[1]) : '';
}

function lastmodOf(block: string): string | undefined {
  const match = /<(?:[a-z0-9]+:)?lastmod\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?lastmod\s*>/i.exec(block);
  const value = match ? textOf(match[1]) : '';
  return value || undefined;
}

/**
 * Whether a string is an XML sitemap at all, read off its first few hundred characters.
 *
 * Used by the detection below and by the driver, which refuses a "sitemap" that turns out to be the
 * site's 404 page served with a 200 — a failure mode common enough that indexing nothing because of it
 * has to be a stated refusal rather than an empty result.
 */
export function looksLikeSitemap(body: string): boolean {
  return /<(?:[a-z0-9]+:)?(?:urlset|sitemapindex)\b/i.test(body.slice(0, 4096));
}

/**
 * One sitemap document. A `<urlset>` yields pages; a `<sitemapindex>` yields more sitemaps; a document
 * that is both — which nothing should write and something eventually does — yields both, and the
 * driver reads whichever it has room for.
 *
 * Relative `<loc>` values are not legal in a sitemap, but resolving them against the sitemap's own URL
 * costs one line and turns an invalid document into a working source instead of a silent zero.
 */
export function parseSitemap(xml: string, sitemapUrl: string): SitemapDocument {
  const urls: ListedUrl[] = [];
  const sitemaps: ListedUrl[] = [];
  for (const [, block] of xml.matchAll(/<(?:[a-z0-9]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?url\s*>/gi)) {
    const loc = absolute(locOf(block), sitemapUrl);
    if (!loc) continue;
    const lastmod = lastmodOf(block);
    urls.push(lastmod ? { url: loc, lastmod } : { url: loc });
  }
  for (const [, block] of xml.matchAll(/<(?:[a-z0-9]+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?sitemap\s*>/gi)) {
    const loc = absolute(locOf(block), sitemapUrl);
    if (!loc) continue;
    const lastmod = lastmodOf(block);
    sitemaps.push(lastmod ? { url: loc, lastmod } : { url: loc });
  }
  return { urls, sitemaps };
}

/**
 * `llms.txt`: the Markdown links in it, in order, de-duplicated.
 *
 * **Deliberately not a parser for the specification, because it is a draft.** `llms.txt` is a proposal
 * whose shape has already changed once — the section headings, the `>` summary line, the optional
 * section are all things a file may or may not have — and a reader that insisted on the current shape
 * would refuse files that are plainly the thing it is looking for. What every version of it agrees on,
 * and what this reads, is that the document is Markdown and the pages are its links.
 *
 * What it does **not** do is guess: a file with no links at all is not "an empty site", and the driver
 * says so by name rather than indexing nothing. An anchor-only or `mailto:` link is not a page.
 */
export function parseLlmsTxt(text: string, entryUrl: string): ListedUrl[] {
  const out: ListedUrl[] = [];
  const seen = new Set<string>();
  // Fenced code in an `llms.txt` is a usage example, and the links inside one are illustrations.
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '');
  for (const [, href] of prose.matchAll(/\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    const url = absolute(href, entryUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url });
  }
  return out;
}

/** Every `href` of an `<a>`, resolved against the page it was found on. Fragments and `mailto:` drop out. */
export function extractLinks(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const match of body.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const url = absolute(decodeEntities(raw), pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * A reference resolved against the document it appeared in, normalised, and `''` when it is not a page
 * this driver could ever fetch.
 *
 * **The fragment is dropped, and that is what keeps a crawl finite.** `#install` and `#usage` on one
 * page are one document; a crawler that kept them would fetch the same page once per heading it links
 * to, and a page that links to its own table of contents would do it dozens of times.
 */
export function absolute(reference: string, base: string): string {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith('#')) return '';
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return '';
  }
  // `mailto:`, `javascript:`, `tel:`, `data:` — everything this driver has no way to fetch.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.hash = '';
  return url.href;
}

/**
 * Which of the three formats a body is, or `null` when it is not decidable.
 *
 * **`null` is the answer this function exists for.** The entry format is guessable from a URL's
 * spelling nine times out of ten, and the tenth is a `sitemap.xml` that redirects to a landing page or
 * an `llms.txt` that a CDN serves as `text/html`. Guessing there produces a source that indexes one
 * page, or none, and reports success — so the driver turns `null` into a refusal naming the setting an
 * operator can set by hand, which is the only honest thing to do with an ambiguity.
 *
 * The body decides and the content type only breaks ties: a documentation site serving `sitemap.xml`
 * as `text/plain` is ordinary, and a `<urlset>` is a `<urlset>` whatever header came with it.
 */
export function detectEntryKind(contentType: string, body: string): EntryKind | null {
  if (looksLikeSitemap(body)) return 'sitemap';
  const head = body.slice(0, 4096);
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (/^\s*<(?:!doctype\s+html|html\b)/i.test(head) || mime === 'text/html' || mime === 'application/xhtml+xml') return 'crawl';
  // An XML document that is not a sitemap — an RSS feed, an Atom feed, somebody's API — is exactly the
  // case worth refusing rather than crawling as if it were a page.
  if (/^\s*<\?xml\b/i.test(head) || mime.endsWith('/xml') || mime.endsWith('+xml')) return null;
  if (mime === 'text/plain' || mime === 'text/markdown') return parseLlmsTxt(body, 'https://example.invalid/').length > 0 ? 'llms' : null;
  return null;
}

/** What a site's `robots.txt` says to this crawler, already narrowed to the group that applies to it. */
export interface RobotsRules {
  /** `true` when the path may be fetched. A site with no `robots.txt` allows everything. */
  allows(pathWithQuery: string): boolean;
  /** `Crawl-delay`, in milliseconds, or `0` when the site named none. */
  crawlDelayMs: number;
  /** `Sitemap:` lines, which are site-wide rather than per group. Not used to widen a source's scope. */
  sitemaps: string[];
}

/** The product identifies itself, so a site that wants to say something to it by name can. */
export const USER_AGENT = 'Contextator';

interface Rule {
  allow: boolean;
  pattern: RegExp;
  /** The rule's own length, which is how RFC 9309 breaks a tie between a matching Allow and Disallow. */
  length: number;
}

function ruleFor(allow: boolean, raw: string): Rule | null {
  if (!raw) return null;
  const anchored = raw.endsWith('$');
  const path = anchored ? raw.slice(0, -1) : raw;
  const escaped = path
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return { allow, pattern: new RegExp(`^${escaped}${anchored ? '$' : ''}`), length: raw.length };
}

const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelayMs: 0, sitemaps: [] };

/** A site that published no `robots.txt`, or an instance that was told not to read one. */
export function allowEverything(): RobotsRules {
  return ALLOW_ALL;
}

/**
 * `robots.txt` as RFC 9309 describes it, narrowed to the group that names this crawler.
 *
 * **The most specific group wins and the groups do not merge.** A file with a `Contextator` group and
 * a `*` group applies only the first to this product — which is the point of naming a user agent at
 * all, and the half a naive reader gets wrong by unioning every group it can see.
 *
 * **Within a group the longest matching rule wins, and a tie goes to `Allow`.** That ordering is what
 * makes `Disallow: /` plus `Allow: /docs/` mean "only the docs", which is how a site that wants to be
 * indexed in one place and left alone everywhere else writes it. Reading the rules in file order
 * instead — the obvious implementation — gets that exact case backwards.
 */
export function parseRobots(text: string, userAgent: string = USER_AGENT): RobotsRules {
  const agent = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; rules: Rule[]; crawlDelay: number }> = [];
  const sitemaps: string[] = [];
  let group: (typeof groups)[number] | null = null;
  // A run of `User-agent` lines with no rule between them is one group with several names.
  let startingGroup = false;

  for (const line of text.split(/\r?\n/)) {
    const content = line.split('#')[0].trim();
    if (!content) continue;
    const colon = content.indexOf(':');
    if (colon < 0) continue;
    const field = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!group || !startingGroup) {
        group = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(group);
        startingGroup = true;
      }
      group.agents.push(value.toLowerCase());
      continue;
    }
    if (!group) continue;
    startingGroup = false;
    if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) group.crawlDelay = Math.min(seconds, 300) * 1000;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      // `Disallow:` with nothing after it is the documented way to allow everything, and is not a rule.
      const rule = ruleFor(field === 'allow', value);
      if (rule) group.rules.push(rule);
      else if (field === 'disallow') group.rules.push({ allow: true, pattern: /^/, length: 0 });
    }
  }

  const named = groups.find((g) => g.agents.some((a) => a !== '*' && (agent.includes(a) || a.includes(agent))));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = named ?? wildcard;
  if (!chosen) return ALLOW_ALL;

  const rules = chosen.rules;
  return {
    crawlDelayMs: chosen.crawlDelay,
    sitemaps,
    allows(pathWithQuery: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.pattern.test(pathWithQuery)) continue;
        // Longest wins; equal lengths go to Allow, which is the tie-break the RFC names.
        if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

/**
 * Whether the page has any text at all once the elements that are never prose are taken out.
 *
 * **This is where a JavaScript-rendered page is refused, and it is refused by name.** A single-page
 * documentation app serves `<div id="root"></div>` and a bundle to every client that is not a browser;
 * there is no headless browser in this product and there is not going to be one, so the honest
 * outcomes are "say so" and "index a blank document that matches nothing and reads as empty". The
 * second is the failure [ADR-0056](../../../.ssot/ADR.md#adr-0056) refused for a PDF with no text layer
 * and this is the same refusal one layer earlier — earlier, because the driver can name the actual
 * cause (the page is rendered in a browser) where the extractor downstream can only say the body was
 * all script.
 *
 * It is deliberately a *weaker* test than the one `doc-types/index.ts` applies after conversion, and
 * both stay: this one stops the file being written at all, and that one still catches a page whose
 * only surviving text was an image's alt attribute. Neither of them is silent.
 */
export function hasIndexableText(html: string): boolean {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).trim().length > 0;
}

/** Extensions a documentation site spells its pages with; the stem survives and `.html` replaces them. */
const PAGE_EXTENSION = /\.(?:html?|php|aspx?|jsp|md|txt)$/i;

/** What a path segment may be once it is a file name: no separators, no `..`, nothing shell-shaped. */
function segment(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A percent sequence that is not valid UTF-8 stays as it was written; it is sanitised below either way.
  }
  const cleaned = decoded
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || '_';
}

/** Eight hex characters of FNV-1a. Enough to separate two URLs that want one path, and short enough to read. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The file a URL is written to, relative to the source root — its own path, as a path.
 *
 * **The URL's shape is kept, because the path is what an agent is shown.** `search_docs` answers with
 * `<source>/guide/install.html` and a person reading that should be able to find the page it came
 * from; a content hash or a serial number would be correct, indexable and useless to read. Every
 * segment is sanitised rather than trusted — `..`, a `/` smuggled in as `%2F` and a NUL are all
 * reachable from a link on somebody else's site, and this is the only place that decides.
 *
 * A query string becomes eight characters of hash on the end rather than part of the name: `?v=2` and
 * `?lang=tr` are different pages and have to be different files, and no ordering of a query's
 * parameters is stable enough to put in a file name.
 *
 * The extension is the caller's, taken from what the server actually sent rather than from what the URL
 * was spelled with: `/guide/install` served as HTML is `guide/install.html`, and the same path served
 * as Markdown — which is what an `llms.txt` site publishes — is `guide/install.md`, because those are
 * two different document types to [ADR-0056](../../../.ssot/ADR.md#adr-0056) and only one of them wants
 * converting.
 */
export function pathForUrl(url: string, extension: string): string {
  const parsed = new URL(url);
  const raw = parsed.pathname.split('/').filter((part) => part.length > 0);
  const directoryLike = raw.length === 0 || parsed.pathname.endsWith('/');
  const parts = raw.map(segment);
  if (directoryLike) parts.push('index');
  else {
    const last = parts[parts.length - 1];
    parts[parts.length - 1] = segment(last.replace(PAGE_EXTENSION, '')) || 'index';
  }
  if (parsed.search) parts[parts.length - 1] = `${parts[parts.length - 1]}--${shortHash(parsed.search)}`;
  return `${parts.join('/')}.${extension}`;
}

/**
 * Whether a URL is inside the scope a single start URL defines: the same host, and at or below the
 * directory the entry point sits in.
 *
 * **Both halves, and the second is the one that keeps a crawl from becoming a web crawl.** A start URL
 * of `https://acme.example/docs/` means the documentation, not `https://acme.example/blog` and not the
 * pricing page; without the prefix the first link to the site's own home page turns a documentation
 * source into an attempt to index the company.
 *
 * The scheme is deliberately **not** compared: a site that links to itself over `https` from a page
 * served over `http`, or the reverse, is one site, and treating it as two would silently halve a crawl.
 */
export function inCrawlScope(candidate: string, entryUrl: string): boolean {
  let url: URL;
  let entry: URL;
  try {
    url = new URL(candidate);
    entry = new URL(entryUrl);
  } catch {
    return false;
  }
  if (url.host !== entry.host) return false;
  const prefix = entry.pathname.endsWith('/') ? entry.pathname : `${entry.pathname.slice(0, entry.pathname.lastIndexOf('/') + 1)}`;
  return url.pathname.startsWith(prefix);
}
