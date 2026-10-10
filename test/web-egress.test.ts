import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { webEgress } from '../src/services/sources/confluence-egress.js';
import { HttpWebClient } from '../src/services/sources/web-client.js';
import { WebDriver } from '../src/services/sources/web.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, publicFixture, routeToLoopback } from './support/egress-seams.js';
import { page } from './support/web-stub.js';

/**
 * Every request of the web source goes through the egress guard
 * ([ADR-0088](../.ssot/ADR.md#adr-0088), [ADR-0107](../.ssot/ADR.md#adr-0107)): pages, `robots.txt`, the
 * sitemap and every redirect hop. The fixture is a real HTTP server on 127.0.0.1, which the guard
 * refuses, so a test reaches it only by a made-up host that `resolve` answers with a public test address
 * and `route` then dials on loopback (`support/egress-seams.ts`) — the assertions go through the check.
 *
 * **Mutation proof.** Put `redirect: 'follow'` and a bare `fetch` back in `web.ts`/`web-client.ts` and
 * every "refused" case below goes red: the fixture is hit, or the request succeeds.
 */

const SITE = 'docs.fixture.test';
const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const PROJECT_ID = '00000000-0000-4000-8000-000000000031';
const SOURCE_ID = '00000000-0000-4000-8000-000000000032';
const LIMITS = { WEB_MAX_PAGES: 100, WEB_MAX_DEPTH: 3, WEB_REQUEST_DELAY_MS: 0, WEB_CRAWL_BUDGET_MS: 60_000, WEB_RESPECT_ROBOTS: true };

interface Hit {
  path: string;
  acceptEncoding: string | undefined;
}

let server: http.Server;
let port: number;
const hits: Hit[] = [];
/** Answers by path; anything not listed is a 404. */
let routes: Record<string, (res: http.ServerResponse) => void> = {};

const text =
  (body: string, type = 'text/html') =>
  (res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': type }).end(body);
  };
const redirect =
  (to: string, status = 302) =>
  (res: http.ServerResponse) => {
    res.writeHead(status, { location: to }).end();
  };

let dataDir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    hits.push({ path: pathname, acceptEncoding: req.headers['accept-encoding'] });
    const answer = routes[pathname];
    if (answer) answer(res);
    else res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  hits.length = 0;
  routes = { '/robots.txt': text('User-agent: *\nAllow: /\n', 'text/plain') };
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-web-egress-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const site = (p = '/') => `http://${SITE}:${port}${p}`;

/** A real `HttpWebClient` on the real guard, as `WebDriver.client()` builds it. */
function client(options: { allowedHosts?: string[]; resolve?: ReturnType<typeof fakeResolver>; route?: (a: string) => string } = {}) {
  const seams = publicFixture(SITE);
  return new HttpWebClient(
    { delayMs: 0, budgetMs: 60_000 },
    webEgress({ allowedHosts: options.allowedHosts ?? [], resolve: options.resolve ?? seams.resolve, route: options.route ?? seams.route }),
  );
}

const source = (entryUrl: string, config: Record<string, unknown> = {}): DocumentSourceRow =>
  ({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 'web',
    name: 'docs',
    label: '',
    config: { entryUrl, extensions: ['html', 'md', 'txt'], ...config },
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

function driver(
  entryUrl: string,
  extra: { allowed?: string[]; robots?: boolean; seams?: Parameters<typeof webEgress>[0] extends infer O ? Partial<O> : never } = {},
) {
  const ctx = {
    db: null as never,
    log,
    config: {
      ...LIMITS,
      WEB_RESPECT_ROBOTS: extra.robots ?? true,
      WEB_ALLOWED_HOSTS: extra.allowed ?? [],
      ALLOWED_DOC_ROOTS: [dataDir],
      DATA_DIR: dataDir,
      SECRET_KEY: '',
      IGNORE_GLOBS: [],
    },
  };
  const seams = extra.seams ?? publicFixture(SITE);
  return new WebDriver(source(entryUrl), ctx, undefined, { resolve: seams.resolve, route: seams.route });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('the web client behind the guard', () => {
  it('fetches a page through the guard and reads it', async () => {
    routes['/guide'] = text(page('Guide', '<p>Words.</p>'));
    const res = await client().get(site('/guide'));
    expect(res.status).toBe(200);
    expect(res.body).toContain('Words.');
    expect(res.url).toBe(site('/guide'));
    expect(hits.map((h) => h.path)).toEqual(['/guide']);
  });

  it.each(['br', 'deflate', 'gzip, br'])(
    'names a content-encoding it does not decode (%s) instead of passing compressed bytes on',
    async (encoding) => {
      routes['/odd'] = (res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding }).end(Buffer.from([0x8b, 0x1f, 0x00, 0x01]));
      };
      const err = await rejection(client().get(site('/odd')));
      expect(err.message).toContain(`The site answered with content-encoding \`${encoding}\`, which this instance does not decode`);
    },
  );

  it('asks for gzip only, which is the one encoding the guard decodes', async () => {
    routes['/zipped'] = (res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(zlib.gzipSync(page('Zipped', '<p>Compressed words.</p>')));
    };
    const res = await client().get(site('/zipped'));
    expect(res.body).toContain('Compressed words.');
    expect(hits[0].acceptEncoding).toBe('gzip');
  });

  it('refuses the cloud metadata address written into the URL, without a request', async () => {
    const err = await rejection(client().get('http://169.254.169.254/latest/meta-data/'));
    expect(err.message).toContain('refused: `169.254.169.254` is link-local');
    expect(hits).toEqual([]);
  });

  it('refuses a loopback address written into the URL, and no setting lifts it', async () => {
    const err = await rejection(client({ allowedHosts: ['127.0.0.1'] }).get(`http://127.0.0.1:${port}/guide`));
    expect(err.message).toContain('refused: `127.0.0.1` is loopback');
    expect(hits).toEqual([]);
  });

  it('refuses a private address written into the URL and names WEB_ALLOWED_HOSTS', async () => {
    const err = await rejection(client().get(`http://10.0.4.12:${port}/guide`));
    expect(err.message).toContain('refused: `10.0.4.12` is private');
    expect(err.message).toContain('WEB_ALLOWED_HOSTS');
    expect(err.message).not.toContain('CONFLUENCE_ALLOWED_HOSTS');
    expect(hits).toEqual([]);
  });

  it('refuses a name that resolves to an internal address, and says which rule and which setting', async () => {
    const internal = client({ resolve: fakeResolver({ [SITE]: '10.0.4.12' }), route: routeToLoopback('10.0.4.12') });
    const err = await rejection(internal.get(site('/guide')));
    expect(err.message).toContain(`refused: \`${SITE}\` resolves to a private address`);
    expect(err.message).toContain(`list \`${SITE}\` in WEB_ALLOWED_HOSTS to allow it`);
    // The internal address itself is not told to whoever typed the URL.
    expect(err.message).not.toContain('10.0.4.12');
    expect(hits).toEqual([]);
  });

  it('lets WEB_ALLOWED_HOSTS open a private address for the host that is listed', async () => {
    routes['/guide'] = text(page('Guide', '<p>Intranet words.</p>'));
    const internal = client({ allowedHosts: [SITE], resolve: fakeResolver({ [SITE]: '10.0.4.12' }), route: routeToLoopback('10.0.4.12') });
    const res = await internal.get(site('/guide'));
    expect(res.body).toContain('Intranet words.');
  });

  it.each(['100.64.0.1', '198.18.0.1'])('treats %s as private: refused until listed', async (address) => {
    const resolve = fakeResolver({ [SITE]: address });
    const route = routeToLoopback(address);
    routes['/guide'] = text(page('Guide', '<p>Words.</p>'));
    expect((await rejection(client({ resolve, route }).get(site('/guide')))).message).toContain('WEB_ALLOWED_HOSTS');
    expect((await client({ allowedHosts: [SITE], resolve, route }).get(site('/guide'))).status).toBe(200);
  });

  it.each(['240.0.0.1', '255.255.255.254', '::ffff:240.0.0.1', '64:ff9b::240.0.0.1'])(
    'refuses %s as reserved even when the host is listed',
    async (address) => {
      const resolve = fakeResolver({ [SITE]: address });
      const err = await rejection(client({ allowedHosts: [SITE], resolve, route: () => '127.0.0.1' }).get(site('/guide')));
      expect(err.message).toContain('a reserved address');
      expect(hits).toEqual([]);
    },
  );

  describe('redirects', () => {
    it('refuses a redirect from a public host to the metadata address, after the first hop only', async () => {
      routes['/old'] = redirect('http://169.254.169.254/latest/meta-data/');
      const err = await rejection(client().get(site('/old')));
      expect(err.message).toContain('the server redirected to `169.254.169.254`, which is link-local');
      expect(hits.map((h) => h.path)).toEqual(['/old']);
    });

    it('refuses a redirect to a name that resolves to an internal address', async () => {
      routes['/old'] = redirect(`http://intranet.fixture.test:${port}/secret`);
      const resolve = fakeResolver({ [SITE]: PUBLIC_FIXTURE_ADDRESS, 'intranet.fixture.test': '10.9.8.7' });
      const err = await rejection(client({ resolve, route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS, '10.9.8.7') }).get(site('/old')));
      expect(err.message).toContain('the server redirected to `intranet.fixture.test`, which resolves to a private address');
      expect(err.message).toContain('WEB_ALLOWED_HOSTS');
      expect(hits.map((h) => h.path)).toEqual(['/old']);
    });

    it('refuses a redirect to a scheme that is not http or https', async () => {
      routes['/old'] = redirect('file:///etc/passwd');
      const err = await rejection(client().get(site('/old')));
      expect(err.message).toContain('the server redirected to a `file:` address; only http and https are allowed');
    });

    it('follows a redirect to a public address and reports the URL the page finally came from', async () => {
      routes['/old'] = redirect('/new/place.html', 301);
      routes['/new/place.html'] = text(page('Moved', '<p>Moved words.</p>'));
      const res = await client().get(site('/old'));
      expect(res.status).toBe(200);
      expect(res.url).toBe(site('/new/place.html'));
      expect(res.body).toContain('Moved words.');
      expect(hits.map((h) => h.path)).toEqual(['/old', '/new/place.html']);
    });

    it('stops after five redirects', async () => {
      for (let i = 0; i < 8; i++) routes[`/hop${i}`] = redirect(`/hop${i + 1}`);
      const err = await rejection(client().get(site('/hop0')));
      expect(err.message).toContain('redirected more than 5 times');
      expect(hits.filter((h) => h.path.startsWith('/hop'))).toHaveLength(6);
    });
  });
});

describe('the web driver behind the guard', () => {
  it('guards robots.txt: a loopback entry URL is refused on the first request, which sends nothing', async () => {
    const err = await rejection(driver(`http://127.0.0.1:${port}/sitemap.xml`).test());
    expect(err.message).toContain('/robots.txt was not requested: refused: `127.0.0.1` is loopback');
    expect(err.message).not.toContain('WEB_RESPECT_ROBOTS');
    expect(hits).toEqual([]);
  });

  it('guards the entry URL as well when robots.txt is not read', async () => {
    const err = await rejection(driver(`http://127.0.0.1:${port}/sitemap.xml`, { robots: false }).test());
    expect(err.message).toContain('refused: `127.0.0.1` is loopback');
    expect(hits).toEqual([]);
  });

  it('refuses a site on a private address until WEB_ALLOWED_HOSTS lists it, then reads it', async () => {
    routes['/sitemap.xml'] = text(`<urlset><url><loc>${site('/a')}</loc></url></urlset>`, 'application/xml');
    const seams = { resolve: fakeResolver({ [SITE]: '10.0.4.12' }), route: routeToLoopback('10.0.4.12') };

    const refused = await rejection(driver(site('/sitemap.xml'), { seams }).test());
    expect(refused.message).toContain('refused:');
    expect(refused.message).toContain('WEB_ALLOWED_HOSTS');
    expect(hits).toEqual([]);

    const note = await driver(site('/sitemap.xml'), { seams, allowed: [SITE] }).test();
    expect(note).toContain('Read a sitemap: 1 page(s)');
    expect(hits.map((h) => h.path)).toEqual(['/robots.txt', '/sitemap.xml']);
  });

  it('records a page that redirects to the metadata address as a failure, and writes nothing', async () => {
    routes['/sitemap.xml'] = text(`<urlset><url><loc>${site('/ok')}</loc></url><url><loc>${site('/trap')}</loc></url></urlset>`, 'application/xml');
    routes['/ok'] = text(page('Ok', '<p>Words.</p>'));
    routes['/trap'] = redirect('http://169.254.169.254/latest/meta-data/');

    const result = await driver(site('/sitemap.xml')).sync();
    expect(result.note).toContain(site('/trap'));
    expect(result.note).toContain('the server redirected to `169.254.169.254`, which is link-local');
    const written = await fs.readdir(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID));
    expect(written).toEqual(['ok.html']);
  });

  it('crawls on the URL a redirected entry page came from, not the one that was typed', async () => {
    // The relative link `next.html` is `/next.html` against the typed URL and `/docs/next.html` against
    // the one the page came from; both are inside the scope `/` defines, so the only thing that tells
    // them apart is which one the driver requests.
    routes['/start'] = redirect('/docs/index.html');
    routes['/docs/index.html'] = text(page('Index', '<p>Start.</p><a href="next.html">next</a>'));
    routes['/docs/next.html'] = text(page('Next', '<p>Second page.</p>'));

    await driver(site('/start')).sync();
    const requested = hits.map((h) => h.path);
    expect(requested).toContain('/docs/next.html');
    expect(requested).not.toContain('/next.html');
  });
});

describe('WEB_ALLOWED_HOSTS as configuration', () => {
  const parse = (value?: string) =>
    EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', ...(value === undefined ? {} : { WEB_ALLOWED_HOSTS: value }) });

  it('defaults to allowing no private host', () => {
    const result = parse();
    expect(result.success && result.data.WEB_ALLOWED_HOSTS).toEqual([]);
  });

  it('reads a comma-separated list of names and addresses', () => {
    const result = parse(' Docs.Corp.Example. , 10.0.4.12,[fd00::1]');
    expect(result.success && result.data.WEB_ALLOWED_HOSTS).toEqual(['docs.corp.example', '10.0.4.12', 'fd00::1']);
  });

  it('is independent of CONFLUENCE_ALLOWED_HOSTS', () => {
    const result = EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', CONFLUENCE_ALLOWED_HOSTS: 'wiki.corp' });
    expect(result.success && result.data.WEB_ALLOWED_HOSTS).toEqual([]);
  });

  it.each(['https://docs.corp', 'docs.corp:8080', 'docs.corp/guide', '*'])('rejects %s rather than silently allowing nothing', (value) => {
    const result = parse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('without scheme, port or path');
  });
});
