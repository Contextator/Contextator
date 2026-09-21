import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { cqlFor, HttpConfluenceClient } from '../src/services/sources/confluence-client.js';
import { storageToHtml, storageToMarkdown } from '../src/services/sources/confluence-render.js';
import { ConfluenceDriver, MAX_PAGES } from '../src/services/sources/confluence.js';
import { toSourceView } from '../src/services/sources.js';
import { CAMPAIGN, HANDBOOK, LONG_TITLE, ROTATION, SPACE, StubConfluence, type StubPage } from './support/confluence-stub.js';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';

/**
 * The Confluence source against a stub of the REST API ([ADR-0059](../.ssot/ADR.md#adr-0059)).
 *
 * **Nothing in this file reaches a network, and there is no credential in it that is real.** Both the
 * driver and the HTTPS client take their transport as a constructor parameter — the client's is a
 * `fetch` stand-in — so the query strings, the headers and the redaction are all asserted against the
 * request that would have been made rather than against one that was.
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;

const PROJECT_ID = '00000000-0000-4000-8000-000000000011';
const SOURCE_ID = '00000000-0000-4000-8000-000000000012';

const source = (config: Record<string, unknown>, secretEnc: string | null = null): DocumentSourceRow =>
  ({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 'confluence',
    name: 'wiki',
    label: '',
    config: { baseUrl: 'https://acme.atlassian.net/wiki', email: 'docs@example.com', spaceKeys: [SPACE], extensions: ['md'], ...config },
    secretEnc,
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

describe('confluence storage format, through the shared HTML transform', () => {
  it('keeps a code macro, whose body an HTML parser would throw away', () => {
    // CDATA is a bogus comment in HTML: hand storage format straight to turndown and every code block
    // in the wiki disappears silently. This is the assertion that says the preparation pass is doing
    // the one job it exists for.
    const md = storageToMarkdown(ROTATION.storage, ROTATION.title);
    expect(md).toContain('npm ci && npm run build');
    expect(md).toContain('```bash');
    expect(md).toContain('**kurulum**');
    expect(md.split('\n')[0]).toBe('# Kurulum Rehberi');
  });

  it('turns an admonition into a quote that still says which kind it was', () => {
    const md = storageToMarkdown(
      '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Do not skip this.</p></ac:rich-text-body></ac:structured-macro>',
      'Upgrade',
    );
    expect(md).toContain('**Warning:**');
    expect(md).toContain('Do not skip this.');
  });

  it('drops a macro’s configuration and keeps a macro’s prose', () => {
    const html = storageToHtml(
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Click me</ac:parameter>' +
        '<ac:rich-text-body><p>Folded detail.</p></ac:rich-text-body></ac:structured-macro>',
    );
    expect(html).toContain('Folded detail.');
    expect(html).not.toContain('Click me');
    // Nothing namespaced survives into the converter's input.
    expect(html).not.toMatch(/<\/?(?:ac|ri):/);
  });

  it('gives a link and an image a target the converter can render', () => {
    const md = storageToMarkdown(
      '<p><ac:link><ri:page ri:content-title="Runbook" /><ac:plain-text-link-body><![CDATA[the runbook]]></ac:plain-text-link-body></ac:link></p>' +
        '<p><ac:image ac:alt="Topology"><ri:attachment ri:filename="net.png" /></ac:image></p>',
      'Links',
    );
    expect(md).toContain('[the runbook](Runbook)');
    expect(md).toContain('![Topology](net.png)');
  });

  it('renders a task list as a task list', () => {
    const md = storageToMarkdown(
      '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Rotate the key</ac:task-body></ac:task>' +
        '<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Tell the team</ac:task-body></ac:task></ac:task-list>',
      'Checklist',
    );
    expect(md).toContain('[x] Rotate the key');
    expect(md).toContain('[ ] Tell the team');
    // The ids and the statuses are machinery, not prose, and must not be indexed as words.
    expect(md).not.toContain('complete');
  });

  it('refuses a body larger than one page may be, rather than parsing it', () => {
    const huge = `<p>${'x'.repeat(9 * 1024 * 1024)}</p>`;
    expect(() => storageToMarkdown(huge, 'Everything')).toThrow(/over the 8 MiB one page may be/);
  });
});

describe('the CQL scope', () => {
  it('names every space when none is configured, and only the configured ones otherwise', () => {
    expect(cqlFor([])).toBe('type = page');
    expect(cqlFor(['ENG'])).toBe('type = page and space in ("ENG")');
    // Sorted and de-duplicated, so the same scope is the same string — the probe token compares by
    // equality and a scope that reordered itself would look like a change that never happened.
    expect(cqlFor(['MKT', 'ENG', 'ENG'])).toBe('type = page and space in ("ENG","MKT")');
  });

  it('drops a key the config schema would never have accepted, instead of quoting it into the query', () => {
    expect(cqlFor(['ENG', 'X") or type = blogpost and space in ("Y'])).toBe('type = page and space in ("ENG")');
  });
});

describe('confluence source', () => {
  let dataDir: string;
  const currentDir = (): string => sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);

  const listFiles = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), [...rel, e.name]);
        else out.push([...rel, e.name].join('/'));
      }
    };
    await walk(currentDir(), []);
    return out.sort();
  };

  const driverFor = (stub: StubConfluence, config: Record<string, unknown> = {}): ConfluenceDriver =>
    new ConfluenceDriver(
      source(config),
      {
        db: null as never,
        log,
        config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] },
      },
      stub,
    );

  beforeEach(async () => {
    await fs.rm(currentDir(), { recursive: true, force: true });
  });

  beforeAll(async () => {
    dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-confluence-')));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('writes the page tree as <space>/<parent page>/<page>.md', async () => {
    const stub = new StubConfluence([HANDBOOK, ROTATION, CAMPAIGN]);
    stub.pageSize = 1; // one result per response, so the cursor is really followed
    const result = await driverFor(stub).sync();

    expect(result.note).toContain('2 pages');
    expect(await listFiles()).toEqual(['eng/engineering-handbook--100001.md', 'eng/engineering-handbook--100001/kurulum-rehberi--100002.md'].sort());

    const child = await fs.readFile(path.join(currentDir(), 'eng', 'engineering-handbook--100001', 'kurulum-rehberi--100002.md'), 'utf8');
    expect(child).toContain('title: "Kurulum Rehberi"');
    expect(child).toContain('confluence_id: "100002"');
    expect(child).toContain('space: "ENG"');
    expect(child).toContain('confluence_version: "2"');
    expect(child).toContain('# Kurulum Rehberi');
    expect(child).toContain('npm ci && npm run build');

    // The page in the space this source does not name was never even read.
    expect(stub.calls).not.toContain(`storage:${CAMPAIGN.id}`);
    // Two in-scope pages at one per response: a first request, a cursor, and then the last response
    // that offers no cursor. The third space's page is never listed at all.
    expect(stub.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:first', 'list:1']);
  });

  it('fetches only the body of the page whose version moved', async () => {
    const stub = new StubConfluence([HANDBOOK, ROTATION]);
    await driverFor(stub).sync();

    const second = new StubConfluence([
      HANDBOOK,
      { ...ROTATION, version: 3, lastModified: '2026-09-09T12:00:00.000Z', storage: '<p>Guncellendi.</p>' },
    ]);
    const result = await driverFor(second).sync();

    expect(result.note).toContain('1 rendered');
    expect(second.calls.filter((c) => c.startsWith('storage:'))).toEqual([`storage:${ROTATION.id}`]);
    expect(await fs.readFile(path.join(currentDir(), 'eng', 'engineering-handbook--100001', 'kurulum-rehberi--100002.md'), 'utf8')).toContain(
      'Guncellendi.',
    );
  });

  /**
   * **The incremental skip is the connector's cost, and this is the case that used to defeat it
   * silently.** The version was the fifth front-matter key, behind a percent-encoded copy of the
   * title, so a page titled like the one below pushed it past the fixed read; `storedVersion` answered
   * `null`, `null === page.version` is false, and the body was pulled again on every single sync. It
   * fails *green*: the note says "rendered" and every assertion about content still holds.
   */
  it('skips a page whose title is long enough to have pushed the version out of the read', async () => {
    const first = new StubConfluence([HANDBOOK, LONG_TITLE]);
    expect((await driverFor(first).sync()).note).toContain('2 rendered');

    // **The claim, and it is about cost rather than content.** Nothing is re-read on a second sync of
    // a wiki nobody touched. Asserted before the arithmetic below, so that a regression fails on the
    // behaviour it is about and not only on a byte offset.
    const second = new StubConfluence([HANDBOOK, LONG_TITLE]);
    expect((await driverFor(second).sync()).note).toContain('0 rendered');
    expect(second.calls.filter((c) => c.startsWith('storage:'))).toEqual([]);

    // And why it holds, measured rather than assumed: the version is the first thing in the file, at
    // byte 4, while the URL that used to sit in front of it is 300-odd characters of percent-encoding.
    const stem = (await listFiles()).find((f) => f.includes('uretim-ortaminda'))!;
    const written = await fs.readFile(path.join(currentDir(), ...stem.split('/')), 'utf8');
    expect(Buffer.byteLength(written.slice(0, written.indexOf('confluence_version')), 'utf8')).toBe(4);
    const urlLine = /^url: "(.*)"$/m.exec(written)![1];
    expect(urlLine).toContain(encodeURIComponent('Üretim').replace(/%20/g, '+'));
    expect(urlLine.length).toBeGreaterThan(300);
  });

  it('removes the file of a page that is gone', async () => {
    const stub = new StubConfluence([HANDBOOK, ROTATION]);
    await driverFor(stub).sync();

    const second = new StubConfluence([HANDBOOK]);
    const result = await driverFor(second).sync();
    expect(result.note).toContain('1 removed');
    expect(await listFiles()).toEqual(['eng/engineering-handbook--100001.md']);
  });

  /**
   * **The ceiling has to be in the sentence an operator reads.** A wiki larger than `MAX_PAGES`
   * otherwise indexes its first five thousand pages and reports a perfectly ordinary success, after
   * which `search_docs` answers "not in the documentation" about pages that exist — which is the one
   * answer this product is built not to give.
   */
  it('says out loud that it stopped at the ceiling, instead of reporting a wiki as fully indexed', async () => {
    const many: StubPage[] = Array.from({ length: MAX_PAGES + 1 }, (_, i) => ({
      ...HANDBOOK,
      id: `9${String(i).padStart(6, '0')}`,
      title: `Page ${i}`,
      ancestors: [],
      storage: '<p>x</p>',
    }));
    const stub = new StubConfluence(many);
    stub.pageSize = 1000;
    const result = await driverFor(stub).sync();

    expect(result.note).toContain(`STOPPED AT THE ${MAX_PAGES}-PAGE CEILING`);
    expect(result.note).toContain('are NOT indexed');
    expect(result.note).toContain(`${MAX_PAGES} pages`);
    // And the probe still reports the real total, so the two numbers sit beside each other.
    expect(await driverFor(new StubConfluence(many)).probe()).toBe(`pages=${MAX_PAGES + 1};modified=${HANDBOOK.lastModified}`);
  }, 120_000);

  /**
   * The subset of the empty-scope case that a count cannot see: two spaces configured, one of them
   * renamed. The listing is not empty, so the guard on `pages.length` is satisfied, and the removal
   * pass would delete every document of the space that went away while the run reports success.
   */
  it('refuses when one configured space goes quiet, not only when all of them do', async () => {
    const both = { spaceKeys: [SPACE, 'MKT'] };
    await driverFor(new StubConfluence([HANDBOOK, ROTATION, CAMPAIGN]), both).sync();
    expect(await listFiles()).toHaveLength(3);

    // ENG still answers; MKT does not. Nothing may be deleted on the strength of that.
    await expect(driverFor(new StubConfluence([HANDBOOK, ROTATION]), both).sync()).rejects.toThrow(/no pages for space\(s\) MKT/);
    expect(await listFiles()).toHaveLength(3);
  });

  it('refuses to empty a source that Confluence has answered nothing about', async () => {
    // The dangerous shape: a renamed space, a revoked permission or a corrected key all answer 200
    // with no results, and the removal pass would then delete every document while reporting success.
    await driverFor(new StubConfluence([HANDBOOK, ROTATION])).sync();
    await expect(driverFor(new StubConfluence([])).sync()).rejects.toThrow(/Refusing to delete them/);
    expect(await listFiles()).toHaveLength(2);
  });

  it('fails loudly when the credential is rejected, instead of reporting an empty wiki', async () => {
    await driverFor(new StubConfluence([HANDBOOK, ROTATION])).sync();
    const stub = new StubConfluence([HANDBOOK, ROTATION]);
    stub.failWith = 'Current user not permitted to use Confluence';
    await expect(driverFor(stub).sync()).rejects.toThrow('Current user not permitted to use Confluence');
    expect(await listFiles()).toHaveLength(2); // nothing was deleted
  });

  /**
   * **A request that failed is a sync that failed, and only a render failure is a complaint.** These
   * were one `catch` once, and a rate limit during a first large pull then put every throttled page
   * into the note while the sync returned successfully — `indexer.ts` writes `lastError: null` over a
   * source that synced, so a third of a wiki could be missing from the index with nothing on the
   * source row saying so.
   */
  it('fails the sync when a page body cannot be read, instead of reporting it as a page it could not render', async () => {
    const stub = new StubConfluence([HANDBOOK, ROTATION]);
    stub.storageFailures.add(ROTATION.id);
    await expect(driverFor(stub).sync()).rejects.toThrow(/429/);
  });

  it('reports a page it could not render without failing the source or losing the old file', async () => {
    const broken: StubPage = {
      ...ROTATION,
      version: 9,
      // More nested macros than the expander will pass over — a body that is not a document.
      storage: '<ac:structured-macro ac:name="x">'.repeat(2005) + '</ac:structured-macro>'.repeat(2005),
    };
    await driverFor(new StubConfluence([HANDBOOK, ROTATION])).sync();
    const result = await driverFor(new StubConfluence([HANDBOOK, broken])).sync();
    expect(result.note).toContain('skipped:');
    expect(result.note).toContain('Kurulum Rehberi');
    // The page that could render still did, and the one that could not kept the file it already had.
    expect(await listFiles()).toHaveLength(2);
  });
});

/**
 * **What `probe()` actually counts**, asserted rather than assumed.
 *
 * A probe that answers about a different set from the one the run indexes is the failure mode of this
 * whole mechanism: it reports "unchanged" about pages that did change, the scheduler queues nothing,
 * and a source that has silently stopped syncing is indistinguishable from one with nothing to do.
 * These four cases are the measurement.
 */
describe('what the confluence probe measures', () => {
  let dataDir: string;
  const driverFor = (stub: StubConfluence, config: Record<string, unknown> = {}): ConfluenceDriver =>
    new ConfluenceDriver(
      source(config),
      {
        db: null as never,
        log,
        config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] },
      },
      stub,
    );

  beforeAll(async () => {
    dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-confluence-probe-')));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('asks the listing and the probe the same question', async () => {
    const stub = new StubConfluence([HANDBOOK, ROTATION, CAMPAIGN]);
    await driverFor(stub).sync();
    const listed = stub.queries.filter((q) => q.call === 'list').map((q) => q.cql);
    const probed = stub.queries.filter((q) => q.call === 'revision').map((q) => q.cql);
    expect(probed).toHaveLength(1);
    expect(new Set([...listed, ...probed]).size).toBe(1);
    expect(probed[0]).toBe('type = page and space in ("ENG")');
  });

  it('moves when a page in scope is edited', async () => {
    const before = await driverFor(new StubConfluence([HANDBOOK, ROTATION, CAMPAIGN])).probe();
    const after = await driverFor(
      new StubConfluence([HANDBOOK, { ...ROTATION, version: 3, lastModified: '2026-09-20T09:00:00.000Z' }, CAMPAIGN]),
    ).probe();
    expect(before).toBe('pages=2;modified=2026-09-02T10:00:00.000Z');
    expect(after).toBe('pages=2;modified=2026-09-20T09:00:00.000Z');
  });

  it('does not move when the only edit was in a space this source does not name', async () => {
    // The failure this guards is the one a probe fails by: counting a set the run does not index. The
    // marketing page is the newest thing on the site and must not reach this token.
    const before = await driverFor(new StubConfluence([HANDBOOK, ROTATION, CAMPAIGN])).probe();
    const after = await driverFor(
      new StubConfluence([HANDBOOK, ROTATION, { ...CAMPAIGN, version: 7, lastModified: '2026-12-31T23:59:59.000Z' }]),
    ).probe();
    expect(after).toBe(before);
  });

  it('moves when a page is deleted, which no timestamp on its own can see', async () => {
    const before = await driverFor(new StubConfluence([HANDBOOK, ROTATION])).probe();
    // ROTATION is the newest page in scope, so deleting HANDBOOK leaves the maximum exactly where it
    // was. The count is the half that notices, and it is why the token carries two numbers.
    const after = await driverFor(new StubConfluence([ROTATION])).probe();
    expect(before).toBe('pages=2;modified=2026-09-02T10:00:00.000Z');
    expect(after).toBe('pages=1;modified=2026-09-02T10:00:00.000Z');
  });

  it('answers for an empty scope rather than refusing to answer', async () => {
    expect(await driverFor(new StubConfluence([CAMPAIGN])).probe()).toBe('pages=0;modified=none');
  });

  it('stores the token it just minted, so both sides of the comparison are this method', async () => {
    const stub = new StubConfluence([HANDBOOK, ROTATION]);
    const result = await driverFor(stub).sync();
    expect(result.configPatch).toEqual({ syncProbeToken: 'pages=2;modified=2026-09-02T10:00:00.000Z' });
  });
});

/**
 * [ADR-0017](../.ssot/ADR.md#adr-0017): the credential is stored encrypted, is not returned by the API
 * and does not reach a log line. `toSourceView` is the precedent and this is the same assertion for a
 * fifth source type.
 */
describe('the confluence credential', () => {
  const TOKEN = 'ATATT-not-a-real-token-4f2a9c';
  const KEY = '0'.repeat(64);

  it('is absent from the view the API returns', () => {
    const row = source({}, encryptSecret(TOKEN, KEY));
    const view = toSourceView(row);
    expect(view.hasSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    // Nor the ciphertext: a view carrying it would move the secret to anywhere the dashboard is read.
    expect(JSON.stringify(view)).not.toContain(row.secretEnc);
    // And a type with no webhook is not given one.
    expect(view.webhookSecret).toBeNull();
    expect(view.hasWebhookSecret).toBe(false);
  });

  it('is not in the request a failing call reports, and not in what the client logs', async () => {
    const lines: unknown[] = [];
    const recording = {
      warn: (...args: unknown[]) => lines.push(args),
      info: (...args: unknown[]) => lines.push(args),
      debug: (...args: unknown[]) => lines.push(args),
      error: (...args: unknown[]) => lines.push(args),
      child: () => recording,
    } as never;

    let sentAuthorization = '';
    const client = new HttpConfluenceClient(
      { baseUrl: 'https://acme.atlassian.net/wiki', email: 'docs@example.com', token: TOKEN },
      async (_url, init) => {
        sentAuthorization = init.headers.authorization;
        return new Response('{"message":"Unauthorized"}', { status: 401 });
      },
      recording,
    );

    await expect(client.revision(cqlFor(['ENG']))).rejects.toThrow(/Confluence answered 401/);
    // The token did go out, in the one place it belongs.
    expect(Buffer.from(sentAuthorization.replace('Basic ', ''), 'base64').toString('utf8')).toBe(`docs@example.com:${TOKEN}`);
    // And nowhere else: not in the message an operator reads off `last_error`, not in a log line.
    await expect(client.revision(cqlFor(['ENG']))).rejects.toThrow(expect.not.stringContaining(TOKEN) as unknown as string);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0); // it really did log, so the assertion above is not vacuous
  });

  it('sends the scope it was given, ordered for paging and for the probe', async () => {
    const urls: string[] = [];
    const client = new HttpConfluenceClient({ baseUrl: 'https://acme.atlassian.net/wiki/', email: 'docs@example.com', token: TOKEN }, async (url) => {
      urls.push(url);
      return new Response('{"results":[],"totalSize":0}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await client.listPages(cqlFor(['ENG']));
    await client.revision(cqlFor(['ENG']));

    const cqls = urls.map((u) => new URL(u).searchParams.get('cql'));
    // `created` is a documented CQL sort field and never moves for a page, which is what paging a
    // cursor over a wiki somebody is editing needs. `id` is neither documented nor refusable by a stub.
    expect(cqls).toEqual(['type = page and space in ("ENG") order by created asc', 'type = page and space in ("ENG") order by lastmodified desc']);
    // The trailing slash on the configured site URL does not become a double slash in the path.
    expect(urls[0].startsWith('https://acme.atlassian.net/wiki/rest/api/search?')).toBe(true);
    expect(new URL(urls[1]).searchParams.get('limit')).toBe('1');
  });
});
