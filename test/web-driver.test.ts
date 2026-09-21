import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { HttpWebClient, type FetchLike, WebBudgetExhaustedError } from '../src/services/sources/web-client.js';
import {
  detectEntryKind,
  extractLinks,
  hasIndexableText,
  inCrawlScope,
  parseLlmsTxt,
  parseRobots,
  parseSitemap,
  pathForUrl,
} from '../src/services/sources/web-entry.js';
import { WebDriver } from '../src/services/sources/web.js';
import { page, StubWeb, type StubPage } from './support/web-stub.js';

/**
 * The web source against a stub of the network ([ADR-0070](../.ssot/ADR.md#adr-0070)).
 *
 * **Nothing in this file opens a socket.** The driver takes its client as a constructor parameter and
 * the HTTPS implementation takes `fetch` as one, so the five ceilings — pages, depth, pacing, budget
 * and `robots.txt` — are each asserted against the requests that *would* have been made. A crawler is
 * the one connector whose correctness is mostly about requests it does **not** make, and a test that
 * could only see the files it wrote would be blind to exactly that half.
 *
 * The end-to-end shape — a real HTTP server on loopback, indexed, searched and read — is
 * `test/integration/web-source.itest.ts`.
 */

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'web');
const fixture = (name: string): Promise<string> => fs.readFile(path.join(FIXTURES, name), 'utf8');

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;

const PROJECT_ID = '00000000-0000-4000-8000-000000000021';
const SOURCE_ID = '00000000-0000-4000-8000-000000000022';

const LIMITS = {
  WEB_MAX_PAGES: 100,
  WEB_MAX_DEPTH: 3,
  WEB_REQUEST_DELAY_MS: 0,
  WEB_CRAWL_BUDGET_MS: 60_000,
  WEB_RESPECT_ROBOTS: true,
};

let dataDir: string;

const source = (config: Record<string, unknown>): DocumentSourceRow =>
  ({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 'web',
    name: 'docs',
    label: '',
    config: { entryUrl: 'https://docs.example.com/sitemap.xml', extensions: ['html', 'md', 'txt'], ...config },
    secretEnc: null,
    webhookSecret: null,
    flavor: 'plain',
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    documentCount: 0,
    syncIntervalMinutes: null,
    nextSyncAt: null,
    webhookVerificationExpiresAt: null,
    webhookDueAt: null,
    webhookMinIntervalMinutes: null,
    createdAt: new Date(),
  }) as DocumentSourceRow;

function driver(pages: Record<string, StubPage>, config: Record<string, unknown> = {}, limits: Partial<typeof LIMITS> = {}) {
  const stub = new StubWeb(pages);
  const ctx = {
    db: null as never,
    log,
    config: { ...LIMITS, ...limits, ALLOWED_DOC_ROOTS: [dataDir], DATA_DIR: dataDir, SECRET_KEY: '', IGNORE_GLOBS: [] },
  };
  return { stub, web: new WebDriver(source(config), ctx, stub) };
}

/** Every file the driver wrote, as `/`-joined relative paths. */
async function written(): Promise<string[]> {
  const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
  const out: string[] = [];
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), [...rel, entry.name]);
      else out.push([...rel, entry.name].join('/'));
    }
  };
  await walk(root, []);
  return out.sort();
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-web-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the three entry formats, read off a fixture', () => {
  it('takes the pages of a sitemap, its lastmods, and the page rather than the image beside it', async () => {
    const { urls } = parseSitemap(await fixture('sitemap.xml'), 'https://docs.example.com/sitemap.xml');
    expect(urls.map((u) => u.url)).toEqual([
      'https://docs.example.com/guide/',
      'https://docs.example.com/guide/install.html',
      'https://docs.example.com/guide/api?version=3&lang=en',
      'https://other.example.com/elsewhere',
    ]);
    expect(urls[1].lastmod).toBe('2026-09-12T11:30:00.000Z');
    // The third has no <lastmod> at all, which is the case `probe()` has to notice.
    expect(urls[2].lastmod).toBeUndefined();
    // `<image:loc>` is a picture on the page, not a page. Taking the first `loc`-shaped element would
    // have indexed the PNG and lost the page it belongs to.
    expect(urls.some((u) => u.url.endsWith('.png'))).toBe(false);
  });

  it('follows a sitemap index and keeps the lastmod the index states for each child', async () => {
    const { urls, sitemaps } = parseSitemap(await fixture('sitemap-index.xml'), 'https://docs.example.com/sitemap.xml');
    expect(urls).toEqual([]);
    expect(sitemaps).toEqual([
      { url: 'https://docs.example.com/sitemap-guide.xml', lastmod: '2026-09-12T11:30:00.000Z' },
      { url: 'https://docs.example.com/sitemap-reference.xml', lastmod: '2026-08-02T09:00:00.000Z' },
    ]);
  });

  it('takes the links of an llms.txt, resolves the relative one, and drops what is not a page', async () => {
    const listed = parseLlmsTxt(await fixture('llms.txt'), 'https://docs.example.com/llms.txt');
    expect(listed.map((l) => l.url)).toEqual([
      'https://www.example.com/',
      'https://docs.example.com/guide/index.md',
      'https://docs.example.com/guide/install.md',
    ]);
    // `mailto:` and a bare `#anchor` are not pages; a link inside a fenced block is an example; and the
    // duplicate at the bottom is the same page, listed twice.
    expect(listed.some((l) => l.url.includes('never.md'))).toBe(false);
    expect(listed).toHaveLength(3);
  });

  it('decides the format from the body, and refuses rather than guessing when it cannot', async () => {
    expect(detectEntryKind('text/plain', await fixture('sitemap.xml'))).toBe('sitemap');
    // A CDN serving a sitemap as HTML is still a sitemap; the body decides.
    expect(detectEntryKind('text/html', await fixture('sitemap-index.xml'))).toBe('sitemap');
    expect(detectEntryKind('text/plain; charset=utf-8', await fixture('llms.txt'))).toBe('llms');
    expect(detectEntryKind('text/html', '<!doctype html><html><body>hi</body></html>')).toBe('crawl');
    // An RSS feed is XML and is not a sitemap; a JSON API is neither. Both are the case that asks.
    expect(detectEntryKind('application/rss+xml', '<?xml version="1.0"?><rss><channel/></rss>')).toBeNull();
    expect(detectEntryKind('application/json', '{"pages":[]}')).toBeNull();
    expect(detectEntryKind('text/plain', 'a plain file with no links at all')).toBeNull();
  });
});

describe('robots.txt, as a crawler has to read it', () => {
  it('applies the group that names nobody and not the one that names another bot', async () => {
    const rules = parseRobots(await fixture('robots.txt'));
    expect(rules.allows('/guide/install.html')).toBe(true);
    expect(rules.allows('/internal/secrets')).toBe(false);
    // The `BadBot` group disallows everything and must not be the group this crawler reads.
    expect(rules.allows('/')).toBe(true);
    expect(rules.crawlDelayMs).toBe(2000);
    expect(rules.sitemaps).toEqual(['https://docs.example.com/sitemap.xml']);
  });

  it('lets the longest rule win, which is what makes an Allow inside a Disallow mean anything', async () => {
    const rules = parseRobots(await fixture('robots.txt'));
    expect(rules.allows('/internal/public/changelog')).toBe(true);
    expect(rules.allows('/internal/public')).toBe(false);
    // `Disallow: /*.pdf$` — a wildcard in the middle and an end anchor.
    expect(rules.allows('/guide/manual.pdf')).toBe(false);
    expect(rules.allows('/guide/manual.pdf.html')).toBe(true);
  });

  it('reads "only the docs" the way a site writes it, which file order gets backwards', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /docs/\n');
    expect(rules.allows('/docs/guide')).toBe(true);
    expect(rules.allows('/pricing')).toBe(false);
  });

  it('treats an empty Disallow as permission and a group naming this product as the one that applies', () => {
    expect(parseRobots('User-agent: *\nDisallow:\n').allows('/anything')).toBe(true);
    const named = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: Contextator\nDisallow: /private/\n');
    expect(named.allows('/guide')).toBe(true);
    expect(named.allows('/private/x')).toBe(false);
  });
});

describe('a URL as a path on disk', () => {
  it('keeps the site’s own shape, because the path is what an agent is shown', () => {
    expect(pathForUrl('https://docs.example.com/guide/install.html', 'html')).toBe('guide/install.html');
    expect(pathForUrl('https://docs.example.com/guide/', 'html')).toBe('guide/index.html');
    expect(pathForUrl('https://docs.example.com/', 'html')).toBe('index.html');
    expect(pathForUrl('https://docs.example.com/guide/index.md', 'md')).toBe('guide/index.md');
  });

  it('cannot be talked out of the source directory by a link on somebody else’s site', () => {
    for (const nasty of [
      'https://docs.example.com/../../etc/passwd',
      'https://docs.example.com/a/%2e%2e/%2e%2e/b',
      'https://docs.example.com/a/%2Fetc%2Fpasswd',
    ]) {
      const relative = pathForUrl(nasty, 'html');
      expect(relative.split('/')).not.toContain('..');
      expect(path.resolve('/root', relative).startsWith('/root/')).toBe(true);
    }
  });

  it('gives two query strings two files, because they are two pages', () => {
    const a = pathForUrl('https://docs.example.com/api?version=3', 'html');
    const b = pathForUrl('https://docs.example.com/api?version=2', 'html');
    expect(a).not.toBe(b);
    expect(a.startsWith('api--')).toBe(true);
  });

  it('keeps a crawl inside the host and the path prefix the entry point names', () => {
    const entry = 'https://docs.example.com/guide/intro.html';
    expect(inCrawlScope('https://docs.example.com/guide/install', entry)).toBe(true);
    // Same host, outside the prefix: a documentation source is not an attempt to index the company.
    expect(inCrawlScope('https://docs.example.com/pricing', entry)).toBe(false);
    expect(inCrawlScope('https://blog.example.com/guide/x', entry)).toBe(false);
    // The scheme is deliberately not compared; a site linking to itself over http is one site.
    expect(inCrawlScope('http://docs.example.com/guide/x', entry)).toBe(true);
  });
});

describe('a page whose content cannot be extracted', () => {
  it('is not text just because it has bytes', () => {
    expect(hasIndexableText(page('Install', '<p>Run npm ci.</p>'))).toBe(true);
    // The shape a single-page documentation app serves to everything that is not a browser.
    expect(
      hasIndexableText('<!doctype html><html><head><title>Docs</title></head><body><div id="root"></div><script>boot()</script></body></html>'),
    ).toBe(false);
    expect(hasIndexableText('<html><body><style>.a{color:red}</style><noscript>enable js</noscript></body></html>')).toBe(false);
  });

  it('is refused by name on the run, and its file is never written', async () => {
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/sitemap.xml': {
          contentType: 'application/xml',
          body: '<urlset><url><loc>https://docs.example.com/real</loc></url><url><loc>https://docs.example.com/spa</loc></url></urlset>',
        },
        'https://docs.example.com/real': { body: page('Real', '<p>Words.</p>') },
        'https://docs.example.com/spa': { body: '<html><body><div id="app"></div><script>render()</script></body></html>' },
      },
      { entryUrl: 'https://docs.example.com/sitemap.xml' },
    );

    const result = await web.sync();
    expect(await written()).toEqual(['real.html']);
    expect(result.note).toContain('refused:');
    expect(result.note).toContain('https://docs.example.com/spa');
    expect(result.note).toContain('rendered in the browser by JavaScript');
    expect(stub.urls).toContain('https://docs.example.com/spa');
  });

  it('is refused when it is not a page at all, naming what was served instead', async () => {
    const { web } = driver({
      'https://docs.example.com/robots.txt': { status: 404 },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>https://docs.example.com/ok</loc></url><url><loc>https://docs.example.com/manual.pdf</loc></url></urlset>',
      },
      'https://docs.example.com/ok': { body: page('Ok', '<p>Words.</p>') },
      'https://docs.example.com/manual.pdf': { contentType: 'application/pdf', body: '%PDF-1.7' },
    });
    const result = await web.sync();
    expect(await written()).toEqual(['ok.html']);
    expect(result.note).toContain('served as application/pdf');
  });
});

describe('the five ceilings, each of them enforced rather than documented', () => {
  it('stops at the page ceiling and says on the run why it stopped', async () => {
    const pages: Record<string, StubPage> = {
      'https://docs.example.com/robots.txt': { status: 404 },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body: `<urlset>${Array.from({ length: 20 }, (_, i) => `<url><loc>https://docs.example.com/p${i}</loc></url>`).join('')}</urlset>`,
      },
    };
    for (let i = 0; i < 20; i++) pages[`https://docs.example.com/p${i}`] = { body: page(`P${i}`, '<p>Body.</p>') };

    const { web, stub } = driver(pages, {}, { WEB_MAX_PAGES: 5 });
    const result = await web.sync();

    expect(await written()).toHaveLength(5);
    expect(stub.urls.filter((u) => /\/p\d+$/.test(u))).toHaveLength(5);
    expect(result.note).toContain('STOPPED AT THE 5-PAGE CEILING (WEB_MAX_PAGES)');
    expect(result.note).toContain('is NOT indexed');
  });

  /**
   * **The ceiling counts what the site served, not what this product kept — and it was measured the
   * other way round before this case existed.**
   *
   * With the ceiling counting only *indexed* pages, a site whose pages this driver refuses is a site
   * with no ceiling at all: twenty pages of a JavaScript-rendered docs app were all twenty fetched at
   * a ceiling of three, and the run said nothing, because by its own counting it had never reached
   * one. The worse the site behaved, the less the ceiling bounded — exactly backwards for the one
   * setting that exists to protect a host nobody here has an account with. `.env.example` and
   * `README.md` both say *fetch*; this is the case that holds the code to the word.
   */
  it('counts the pages it fetched and not the pages it kept, so a site of refusals still stops', async () => {
    const pages: Record<string, StubPage> = {
      'https://docs.example.com/robots.txt': { status: 404 },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body: `<urlset>${Array.from({ length: 20 }, (_, i) => `<url><loc>https://docs.example.com/p${i}</loc></url>`).join('')}</urlset>`,
      },
    };
    // Every page is a single-page-app shell: fetched from the site, refused here, indexed never.
    for (let i = 0; i < 20; i++) {
      pages[`https://docs.example.com/p${i}`] = { body: '<!doctype html><html><body><div id="root"></div><script>boot()</script></body></html>' };
    }

    const { web, stub } = driver(pages, {}, { WEB_MAX_PAGES: 3 });
    const result = await web.sync();

    // Three page requests, not twenty. The whole of the claim.
    expect(stub.urls.filter((u) => /\/p\d+$/.test(u))).toHaveLength(3);
    // The whole run, counted: robots.txt, the sitemap, three pages, and the two the trailing probe
    // spends. Twenty-two of the twenty-five requests the old counting would have made are not made.
    expect(stub.requestCount).toBe(7);
    expect(await written()).toEqual([]);
    // And it says so, rather than stopping quietly: a run that indexed nothing and reported success
    // hides from the operator that the site is not indexed.
    expect(result.note).toContain('STOPPED AT THE 3-PAGE CEILING (WEB_MAX_PAGES)');
    expect(result.note).toContain('3 page(s) were fetched, 0 of them could be indexed');
  });

  it('charges the ceiling for a page that answered 404, because the site served it too', async () => {
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/sitemap.xml': {
          contentType: 'application/xml',
          body: `<urlset>${Array.from({ length: 10 }, (_, i) => `<url><loc>https://docs.example.com/gone${i}</loc></url>`).join('')}</urlset>`,
        },
      },
      {},
      { WEB_MAX_PAGES: 2 },
    );
    // Nothing is registered for the ten URLs, so the stub answers 404 the way a site does for a link
    // that rotted — a stale sitemap, which is the ordinary version of the case above.
    const result = await web.sync();

    expect(stub.urls.filter((u) => u.includes('/gone'))).toHaveLength(2);
    expect(result.note).toContain('STOPPED AT THE 2-PAGE CEILING (WEB_MAX_PAGES)');
  });

  it('does not charge the ceiling for a URL it decided not to fetch', async () => {
    // A robots.txt-disallowed URL and an off-site one never left this process, so spending ceiling on
    // them would make a well-behaved run stop early — the opposite error to the one above, and just
    // as wrong.
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /internal/\n' },
        'https://docs.example.com/sitemap.xml': {
          contentType: 'application/xml',
          body:
            '<urlset>' +
            '<url><loc>https://docs.example.com/internal/a</loc></url>' +
            '<url><loc>https://other.example.com/b</loc></url>' +
            '<url><loc>https://docs.example.com/real1</loc></url>' +
            '<url><loc>https://docs.example.com/real2</loc></url>' +
            '</urlset>',
        },
        'https://docs.example.com/real1': { body: page('One', '<p>Body.</p>') },
        'https://docs.example.com/real2': { body: page('Two', '<p>Body.</p>') },
      },
      {},
      { WEB_MAX_PAGES: 2 },
    );
    const result = await web.sync();

    expect(await written()).toEqual(['real1.html', 'real2.html']);
    expect(stub.urls).not.toContain('https://docs.example.com/internal/a');
    expect(result.note).not.toContain('CEILING');
  });

  it('does not fetch a path robots.txt disallows, and counts what it skipped', async () => {
    const { web, stub } = driver({
      'https://docs.example.com/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /internal/\n' },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body:
          '<urlset><url><loc>https://docs.example.com/guide</loc></url>' + '<url><loc>https://docs.example.com/internal/runbook</loc></url></urlset>',
      },
      'https://docs.example.com/guide': { body: page('Guide', '<p>Body.</p>') },
      'https://docs.example.com/internal/runbook': { body: page('Runbook', '<p>Secret.</p>') },
    });

    const result = await web.sync();
    // The assertion that matters is about the request, not about the file: a driver that fetched the
    // page and then declined to write it would still have taken it from a site that said not to.
    expect(stub.urls).not.toContain('https://docs.example.com/internal/runbook');
    expect(await written()).toEqual(['guide.html']);
    expect(result.note).toContain('1 skipped by robots.txt');
  });

  it('fails the sync when robots.txt cannot be read, because that is not permission', async () => {
    const { web, stub } = driver({
      'https://docs.example.com/robots.txt': { status: 503 },
      'https://docs.example.com/sitemap.xml': { contentType: 'application/xml', body: '<urlset/>' },
    });
    await expect(web.sync()).rejects.toThrow(/robots\.txt answered 503/);
    expect(stub.urls).toEqual(['https://docs.example.com/robots.txt']);
  });

  it('raises its own pacing to the Crawl-delay the site asked for, and never lowers it', async () => {
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nCrawl-delay: 5\n' },
        'https://docs.example.com/sitemap.xml': { contentType: 'application/xml', body: '<urlset/>' },
      },
      {},
      { WEB_REQUEST_DELAY_MS: 100 },
    );
    await web.sync().catch(() => undefined);
    expect(stub.delayMs).toBe(5000);
  });

  it('stops at the depth ceiling on a crawl and says how many links it left behind', async () => {
    const chain: Record<string, StubPage> = { 'https://docs.example.com/docs/robots.txt': { status: 404 } };
    chain['https://docs.example.com/robots.txt'] = { status: 404 };
    for (let i = 0; i < 6; i++) {
      chain[`https://docs.example.com/docs/p${i}`] = { body: page(`P${i}`, `<p>Body.</p><a href="/docs/p${i + 1}">next</a>`) };
    }

    const { web } = driver({ ...chain }, { entryUrl: 'https://docs.example.com/docs/p0', entryKind: 'crawl' }, { WEB_MAX_DEPTH: 2 });
    const result = await web.sync();

    // depth 0 is the entry, so a ceiling of 2 reaches p0, p1 and p2 and stops.
    expect(await written()).toEqual(['docs/p0.html', 'docs/p1.html', 'docs/p2.html']);
    expect(result.note).toContain('STOPPED AT THE 2-LEVEL DEPTH CEILING (WEB_MAX_DEPTH)');
  });

  /**
   * **`robots.txt` covers a sitemap, and the nested-sitemap walk was the one place that did not ask.**
   *
   * The same class of defect the page ceiling had, in the other setting: a limit that does not cover
   * everything it is documented to cover. A `<sitemapindex>` child is a URL on somebody's site like
   * any other, and a site that disallows the part of its tree one sits in had it fetched anyway.
   */
  it('does not fetch a nested sitemap robots.txt disallows', async () => {
    const { web, stub } = driver({
      'https://docs.example.com/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body:
          '<sitemapindex>' +
          '<sitemap><loc>https://docs.example.com/private/sitemap-internal.xml</loc></sitemap>' +
          '<sitemap><loc>https://docs.example.com/sitemap-guide.xml</loc></sitemap>' +
          '</sitemapindex>',
      },
      'https://docs.example.com/private/sitemap-internal.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>https://docs.example.com/private/secret</loc></url></urlset>',
      },
      'https://docs.example.com/sitemap-guide.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>https://docs.example.com/guide/ok</loc></url></urlset>',
      },
      'https://docs.example.com/guide/ok': { body: page('OK', '<p>Body.</p>') },
    });
    const result = await web.sync();

    expect(stub.urls).not.toContain('https://docs.example.com/private/sitemap-internal.xml');
    expect(stub.urls).toContain('https://docs.example.com/sitemap-guide.xml');
    expect(await written()).toEqual(['guide/ok.html']);
    expect(result.note).toContain('skipped by robots.txt');
  });

  /**
   * **Depth bounds a tree's height and nothing bounded its width.**
   *
   * A `<sitemapindex>` naming fifty thousand children at one level is fifty thousand requests before a
   * single page URL is yielded, so the page ceiling — which only advances as pages are fetched — is
   * never consulted. The same number is reused rather than a sixth setting: a source allowed to fetch
   * N pages may read at most N listings to find them.
   */
  it('stops reading nested sitemaps at the same ceiling, and says the site was never fully listed', async () => {
    const pages: Record<string, StubPage> = {
      'https://docs.example.com/robots.txt': { status: 404 },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body: `<sitemapindex>${Array.from({ length: 30 }, (_, i) => `<sitemap><loc>https://docs.example.com/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
      },
    };
    // Every child is a valid but empty sitemap, so not one page URL is ever yielded and the page
    // ceiling can never be the thing that stops this.
    for (let i = 0; i < 30; i++) pages[`https://docs.example.com/s${i}.xml`] = { contentType: 'application/xml', body: '<urlset/>' };

    const { web, stub } = driver(pages, {}, { WEB_MAX_PAGES: 4 });
    const result = await web.sync();

    expect(stub.urls.filter((u) => /\/s\d+\.xml$/.test(u))).toHaveLength(4);
    expect(result.note).toContain('STOPPED AT THE 4-LISTING CEILING (WEB_MAX_PAGES)');
  });
});

describe('the time budget and the pacing, on the client that actually makes the requests', () => {
  const answer = (): Response => new Response('<html><body><p>hi</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

  it('waits at least the configured gap between two requests', async () => {
    const at: number[] = [];
    const fetchImpl: FetchLike = async () => {
      at.push(Date.now());
      return answer();
    };
    const client = new HttpWebClient({ delayMs: 60, budgetMs: 10_000 }, fetchImpl);
    await client.get('https://docs.example.com/a');
    await client.get('https://docs.example.com/b');
    await client.get('https://docs.example.com/c');
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(55);
    expect(client.requestCount).toBe(3);
  });

  it('refuses to make a request once the run has spent its budget', async () => {
    const client = new HttpWebClient({ delayMs: 0, budgetMs: 40 }, async () => answer());
    await client.get('https://docs.example.com/a');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(client.get('https://docs.example.com/b')).rejects.toBeInstanceOf(WebBudgetExhaustedError);
  });

  it('sends the validator it was given, which is the whole of the incremental path', async () => {
    let seen: Record<string, string> = {};
    const client = new HttpWebClient({ delayMs: 0, budgetMs: 10_000 }, async (_url, init) => {
      seen = init.headers;
      return new Response(null, { status: 304 });
    });
    const result = await client.get('https://docs.example.com/a', { etag: 'W/"v1"' });
    expect(seen['if-none-match']).toBe('W/"v1"');
    expect(result.status).toBe(304);
    expect(result.body).toBeUndefined();
  });
});

describe('what a second run costs, and what the probe decides', () => {
  const site = (): Record<string, StubPage> => ({
    'https://docs.example.com/robots.txt': { status: 404 },
    'https://docs.example.com/sitemap.xml': {
      contentType: 'application/xml',
      body:
        '<urlset><url><loc>https://docs.example.com/a</loc><lastmod>2026-09-10</lastmod></url>' +
        '<url><loc>https://docs.example.com/b</loc><lastmod>2026-09-12</lastmod></url></urlset>',
    },
    'https://docs.example.com/a': { body: page('A', '<p>Alpha.</p>'), etag: 'W/"a1"' },
    'https://docs.example.com/b': { body: page('B', '<p>Beta.</p>'), etag: 'W/"b1"' },
  });

  it('mints a token out of the sitemap’s own count and newest lastmod', async () => {
    const { web } = driver(site());
    const result = await web.sync();
    expect(result.configPatch).toEqual({ syncProbeToken: 'pages=2;lastmod=2026-09-12' });
  });

  it('answers "unchanged" from one listing, without fetching a single page', async () => {
    const { web, stub } = driver(site());
    const token = await web.probe();
    expect(token).toBe('pages=2;lastmod=2026-09-12');
    // robots.txt and the sitemap. That is the whole cost of a scheduled consideration.
    expect(stub.urls).toEqual(['https://docs.example.com/robots.txt', 'https://docs.example.com/sitemap.xml']);
    expect(stub.urls).not.toContain('https://docs.example.com/a');
  });

  it('moves the token when a page is edited, and when one is deleted', async () => {
    const edited = site();
    edited['https://docs.example.com/sitemap.xml'].body =
      '<urlset><url><loc>https://docs.example.com/a</loc><lastmod>2026-09-10</lastmod></url>' +
      '<url><loc>https://docs.example.com/b</loc><lastmod>2026-09-30</lastmod></url></urlset>';
    expect(await driver(edited).web.probe()).toBe('pages=2;lastmod=2026-09-30');

    // A deletion moves nobody's lastmod; the count is the half that sees it.
    const deleted = site();
    deleted['https://docs.example.com/sitemap.xml'].body =
      '<urlset><url><loc>https://docs.example.com/b</loc><lastmod>2026-09-12</lastmod></url></urlset>';
    expect(await driver(deleted).web.probe()).toBe('pages=1;lastmod=2026-09-12');
  });

  it('answers null — "run it" — for every shape that cannot see a page change', async () => {
    // A sitemap with no lastmod anywhere: a token would never move on an edit, which is a source that
    // has silently stopped syncing, dressed as a working one.
    const bare = site();
    bare['https://docs.example.com/sitemap.xml'].body = '<urlset><url><loc>https://docs.example.com/a</loc></url></urlset>';
    expect(await driver(bare).web.probe()).toBeNull();

    // A crawl has no listing at all, and an llms.txt is a list of links whose validators move when the
    // *list* changes rather than when a page on it does.
    const crawl = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/docs/': { body: page('Docs', '<p>Body.</p>') },
      },
      { entryUrl: 'https://docs.example.com/docs/' },
    );
    expect(await crawl.web.probe()).toBeNull();
  });

  it('asks conditionally on the second run and keeps the file the server said was unchanged', async () => {
    const pages = site();
    const first = driver(pages);
    await first.web.sync();
    expect(await written()).toEqual(['a.html', 'b.html']);

    const second = driver(pages);
    const result = await second.web.sync();
    expect(second.stub.requests.find((r) => r.url.endsWith('/a'))?.validators).toEqual({ etag: 'W/"a1"', lastModified: undefined });
    expect(result.note).toContain('2 page(s) fetched, 0 written, 2 unchanged');
    expect(await written()).toEqual(['a.html', 'b.html']);
  });

  it('removes the file of a page the site dropped', async () => {
    const pages = site();
    await driver(pages).web.sync();

    pages['https://docs.example.com/sitemap.xml'].body =
      '<urlset><url><loc>https://docs.example.com/b</loc><lastmod>2026-09-12</lastmod></url></urlset>';
    const result = await driver(pages).web.sync();
    expect(await written()).toEqual(['b.html']);
    expect(result.note).toContain('1 removed');
  });
});

describe('the refusals an operator is meant to act on', () => {
  it('will not guess an entry format it cannot recognise', async () => {
    const { web } = driver({
      'https://docs.example.com/robots.txt': { status: 404 },
      'https://docs.example.com/sitemap.xml': { contentType: 'application/json', body: '{"urls":[]}' },
    });
    await expect(web.sync()).rejects.toThrow(/not recognisably a sitemap, an llms\.txt or an HTML page/);
  });

  it('will not read a document as a sitemap just because it was told to', async () => {
    const { web } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/sitemap.xml': { contentType: 'text/html', body: page('Not found', '<p>404.</p>') },
      },
      { entryKind: 'sitemap' },
    );
    await expect(web.sync()).rejects.toThrow(/contains no <urlset> or <sitemapindex>/);
  });

  it('says an llms.txt holds no links rather than indexing nothing', async () => {
    const { web } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/llms.txt': { contentType: 'text/plain', body: '# Docs\n\nNo links here at all.\n' },
      },
      { entryUrl: 'https://docs.example.com/llms.txt', entryKind: 'llms' },
    );
    await expect(web.sync()).rejects.toThrow(/holds no links/);
  });

  it('refuses to delete every document because the site briefly answered nothing', async () => {
    const pages = site();
    await driver(pages).web.sync();
    expect(await written()).toHaveLength(2);

    pages['https://docs.example.com/sitemap.xml'].body = '<urlset></urlset>';
    await expect(driver(pages).web.sync()).rejects.toThrow(/Refusing to delete them/);
    expect(await written()).toHaveLength(2);
  });

  function site(): Record<string, StubPage> {
    return {
      'https://docs.example.com/robots.txt': { status: 404 },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>https://docs.example.com/a</loc></url><url><loc>https://docs.example.com/b</loc></url></urlset>',
      },
      'https://docs.example.com/a': { body: page('A', '<p>Alpha.</p>') },
      'https://docs.example.com/b': { body: page('B', '<p>Beta.</p>') },
    };
  }
});

describe('the dashboard’s Test button', () => {
  it('reports what the entry point holds and the ceilings a run would be held to', async () => {
    const { web } = driver({
      'https://docs.example.com/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nCrawl-delay: 1\n' },
      'https://docs.example.com/sitemap.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>https://docs.example.com/a</loc></url></urlset>',
      },
    });
    const message = await web.test();
    expect(message).toContain('Read a sitemap: 1 page(s)');
    expect(message).toContain('at most 100 page(s)');
    expect(message).toContain('one request every 1000 ms');
  });

  it('says what a crawl would reach, in the scope the start URL defines', async () => {
    const { web } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/docs/': { body: page('Docs', '<a href="/docs/a">a</a><a href="/pricing">out of scope</a>') },
      },
      { entryUrl: 'https://docs.example.com/docs/' },
    );
    const message = await web.test();
    expect(message).toContain('1 link(s) inside docs.example.com/docs/');
    expect(message).toContain('up to 3 level(s)');
  });
});

describe('a crawl from one start URL', () => {
  it('follows links inside the scope, writes the site’s own shape, and never leaves it', async () => {
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/docs/': {
          body: page('Docs', '<a href="guide/install.html">install</a><a href="/pricing">pricing</a><a href="https://elsewhere.example/x">off</a>'),
        },
        'https://docs.example.com/docs/guide/install.html': { body: page('Install', '<p>Run it.</p><a href="../">home</a>') },
        'https://docs.example.com/pricing': { body: page('Pricing', '<p>Money.</p>') },
      },
      { entryUrl: 'https://docs.example.com/docs/' },
    );

    await web.sync();
    expect(await written()).toEqual(['docs/guide/install.html', 'docs/index.html']);
    expect(stub.urls).not.toContain('https://docs.example.com/pricing');
    expect(stub.urls).not.toContain('https://elsewhere.example/x');
  });

  it('fetches the entry page once, not once to identify it and again to index it', async () => {
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/docs/': { body: page('Docs', '<p>Only page.</p>') },
      },
      { entryUrl: 'https://docs.example.com/docs/', entryKind: 'crawl' },
    );
    await web.sync();
    expect(stub.urls.filter((u) => u === 'https://docs.example.com/docs/')).toHaveLength(1);
    // And the probe that follows a crawl costs nothing: it can only ever answer `null`, so it does
    // not ask the site to tell it so.
    expect(stub.urls).toEqual(['https://docs.example.com/robots.txt', 'https://docs.example.com/docs/']);
  });
});

describe('an llms.txt whose links are Markdown, which is the point of the format', () => {
  it('writes .md for the Markdown and .html for the page, because they are two document types', async () => {
    const { web } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/llms.txt': {
          contentType: 'text/plain',
          body: '# Docs\n\n- [Install](/guide/install.md): how\n- [Overview](/guide/overview.html): what\n',
        },
        'https://docs.example.com/guide/install.md': { contentType: 'text/plain', body: '# Install\n\nRun it.\n' },
        'https://docs.example.com/guide/overview.html': { body: page('Overview', '<p>What it is.</p>') },
      },
      { entryUrl: 'https://docs.example.com/llms.txt' },
    );

    const result = await web.sync();
    expect(await written()).toEqual(['guide/install.md', 'guide/overview.html']);
    expect(result.note).toContain('llms: 2 page(s) fetched, 2 written');
  });

  it('skips a link that points at another host, and counts it', async () => {
    const { web, stub } = driver(
      {
        'https://docs.example.com/robots.txt': { status: 404 },
        'https://docs.example.com/llms.txt': {
          contentType: 'text/plain',
          body: '# Docs\n\n- [Here](/a.html): ours\n- [There](https://www.example.com/b): not ours\n',
        },
        'https://docs.example.com/a.html': { body: page('A', '<p>Alpha.</p>') },
      },
      { entryUrl: 'https://docs.example.com/llms.txt' },
    );
    const result = await web.sync();
    expect(stub.urls).not.toContain('https://www.example.com/b');
    expect(result.note).toContain('1 off-site URL(s) skipped');
  });
});

describe('extractLinks', () => {
  it('reads every quoting style and drops what is not a page', () => {
    const html = `<a href="/a">a</a><a href='/b'>b</a><a href=/c>c</a><a href="#top">t</a>
      <a href="mailto:x@y.z">m</a><!-- <a href="/commented">c</a> --><a href="/a">dup</a>`;
    expect(extractLinks(html, 'https://docs.example.com/index.html')).toEqual([
      'https://docs.example.com/a',
      'https://docs.example.com/b',
      'https://docs.example.com/c',
    ]);
  });
});
