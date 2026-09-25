import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { checkDataCenterVersion, cqlFor, HttpConfluenceClient } from '../src/services/sources/confluence-client.js';
import { ConfluenceDriver } from '../src/services/sources/confluence.js';
import { parseSourceConfig } from '../src/services/sources.js';
import { DataCenterServer } from './support/confluence-dc-server.js';
import { CAMPAIGN, HANDBOOK, ROTATION, SPACE } from './support/confluence-stub.js';

/**
 * Confluence **Data Center** as the second transport of one contract ([ADR-0059](../.ssot/ADR.md#adr-0059)).
 *
 * The driver here is not handed a stub client: it decrypts a stored token and builds the HTTPS client
 * itself, and that client talks to `DataCenterServer` on 127.0.0.1. So what is asserted is the request
 * a Data Center instance would receive — the context path, the bearer, the offset paging — and that the
 * cost thesis of ADR-0059 holds on it: the probe counts the scope the sync lists, and a page whose
 * version did not move is never fetched.
 *
 * **No network beyond the loopback interface, and no credential that is real.**
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;

const PROJECT_ID = '00000000-0000-4000-8000-000000000021';
const SOURCE_ID = '00000000-0000-4000-8000-000000000022';
const TOKEN = 'NjY0-not-a-real-personal-access-token';
const KEY = 'k'.repeat(64);

describe('confluence data center, against a fixture server', () => {
  let dataDir: string;
  let server: DataCenterServer;

  const row = (config: Record<string, unknown> = {}): DocumentSourceRow =>
    ({
      id: SOURCE_ID,
      projectId: PROJECT_ID,
      type: 'confluence',
      name: 'dc-wiki',
      label: '',
      config: { baseUrl: server.baseUrl, deployment: 'datacenter', email: '', spaceKeys: [SPACE], extensions: ['md'], ...config },
      secretEnc: encryptSecret(TOKEN, { current: KEY }),
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

  const driver = (config: Record<string, unknown> = {}): ConfluenceDriver =>
    new ConfluenceDriver(row(config), {
      db: null as never,
      log,
      config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] },
    });

  const currentDir = (): string => sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
  /** The search requests that list pages — a sync also ends with one probe-shaped request for its token. */
  const listings = () => server.apiCalls().filter((r) => r.path === '/rest/api/search' && r.params.cql?.endsWith('order by created asc'));
  const contentCalls = (): string[] =>
    server
      .apiCalls()
      .filter((r) => r.path.startsWith('/rest/api/content/'))
      .map((r) => r.path);

  beforeAll(async () => {
    dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-confluence-dc-')));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await fs.rm(currentDir(), { recursive: true, force: true });
    server = new DataCenterServer([HANDBOOK, ROTATION, CAMPAIGN], TOKEN);
    server.pageSize = 50;
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it('syncs the page tree through the context path, with a bearer token and offset paging', async () => {
    server.pageSize = 1; // one result per response, so the `start` in the next link is really followed
    const result = await driver().sync();

    expect(result.note).toContain('2 pages');
    const child = await fs.readFile(path.join(currentDir(), 'eng', 'engineering-handbook--100001', 'kurulum-rehberi--100002.md'), 'utf8');
    expect(child).toContain('confluence_version: "2"');
    expect(child).toContain('npm ci && npm run build');
    await expect(fs.stat(path.join(currentDir(), 'eng', 'engineering-handbook--100001.md'))).resolves.toBeTruthy();

    // Every API request carried the personal access token as a bearer, and nothing went to `/wiki`.
    for (const call of server.apiCalls()) expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(server.requests.every((r) => !r.path.startsWith('/wiki'))).toBe(true);
    // Two in-scope pages at one per response: the first request, then `start=1`, then nothing more.
    const searches = listings();
    expect(searches.map((r) => r.params.start)).toEqual([undefined, '1']);
    // The page in the space this source does not name was never read.
    expect(contentCalls()).not.toContain(`/rest/api/content/${CAMPAIGN.id}`);
  });

  it('follows a cursor when the next link carries one instead of an offset', async () => {
    server.pageSize = 1;
    server.paging = 'cursor';
    const result = await driver().sync();

    expect(result.note).toContain('2 pages');
    const searches = listings();
    expect(searches).toHaveLength(2);
    expect(searches[1].params.cursor).toBeTruthy();
    expect(searches[1].params.start).toBeUndefined();
  });

  it('asks the version manifest without the credential', async () => {
    await driver().sync();
    const manifest = server.requests.filter((r) => r.path === '/rest/applinks/1.0/manifest');
    expect(manifest).toHaveLength(1);
    expect(manifest[0].authorization).toBeUndefined();
  });

  it('does not fetch a page whose version did not move', async () => {
    await driver().sync();
    expect(contentCalls().sort()).toEqual([`/rest/api/content/${HANDBOOK.id}`, `/rest/api/content/${ROTATION.id}`].sort());

    server.requests.length = 0;
    server.setPages([HANDBOOK, { ...ROTATION, version: 3, lastModified: '2026-09-09T12:00:00.000Z', storage: '<p>Guncellendi.</p>' }, CAMPAIGN]);
    const result = await driver().sync();

    expect(result.note).toContain('1 rendered');
    expect(contentCalls()).toEqual([`/rest/api/content/${ROTATION.id}`]);
    expect(await fs.readFile(path.join(currentDir(), 'eng', 'engineering-handbook--100001', 'kurulum-rehberi--100002.md'), 'utf8')).toContain(
      'Guncellendi.',
    );

    server.requests.length = 0;
    expect((await driver().sync()).note).toContain('0 rendered');
    expect(contentCalls()).toEqual([]);
  });

  it('probes with one request over the scope the sync lists, and moves on an edit and on a deletion', async () => {
    const before = await driver().probe();
    expect(before).toBe(`pages=2;modified=${ROTATION.lastModified}`);
    // The probe is one request and does not ask the manifest: its cost is the point of it.
    expect(server.requests.map((r) => r.path)).toEqual(['/rest/api/search']);
    expect(server.requests[0].params.limit).toBe('1');
    expect(server.requests[0].authorization).toBe(`Bearer ${TOKEN}`);

    await driver().sync();
    const cqls = server
      .apiCalls()
      .filter((r) => r.path === '/rest/api/search')
      .map((r) => r.params.cql);
    // Same scope, two orders: ADR-0059's single CQL, carried by the second transport unchanged.
    const scope = cqlFor([SPACE]);
    // The sync lists, then records the probe token it ends on with the probe's own request.
    expect(cqls).toEqual([`${scope} order by lastmodified desc`, `${scope} order by created asc`, `${scope} order by lastmodified desc`]);

    server.setPages([HANDBOOK, { ...ROTATION, version: 3, lastModified: '2026-09-10T08:00:00.000Z' }, CAMPAIGN]);
    const edited = await driver().probe();
    expect(edited).toBe('pages=2;modified=2026-09-10T08:00:00.000Z');

    server.setPages([{ ...ROTATION, version: 3, lastModified: '2026-09-10T08:00:00.000Z' }, CAMPAIGN]);
    const deleted = await driver().probe();
    expect(deleted).toBe('pages=1;modified=2026-09-10T08:00:00.000Z');
    expect(new Set([before, edited, deleted]).size).toBe(3);
  });

  it('reads the modified time from version.when when lastModified is not a timestamp', async () => {
    server.friendlyLastModified = true;
    expect(await driver().probe()).toBe(`pages=2;modified=${ROTATION.lastModified}`);
  });

  it('refuses to answer a probe from a response that carries no count', async () => {
    // A missing count is not zero: `pages=0` would compare equal to every later `pages=0`.
    server.omitTotalSize = true;
    await expect(driver().probe()).rejects.toThrow(/did not report totalSize/);
  });

  it('refuses an unsupported release by name, on Test and on sync, before the credential is sent', async () => {
    server.version = '7.4.11';
    await expect(driver().test()).rejects.toThrow('Confluence 7.4.11 is not supported: Data Center 7.9 or later is required');
    await expect(driver().sync()).rejects.toThrow(/Confluence 7\.4\.11 is not supported/);
    expect(server.apiCalls()).toEqual([]);
  });

  it('refuses a server that is not Confluence', async () => {
    server.product = 'jira';
    await expect(driver().test()).rejects.toThrow(/reports itself as "jira", not Confluence/);
    expect(server.apiCalls()).toEqual([]);
  });

  it('names the release it connected to on Test', async () => {
    expect(await driver().test()).toMatch(/^Connected to Confluence Data Center 8\.5\.6 as Docs Bot/);
  });

  it('points a wrong token at the personal access token, not at an e-mail', async () => {
    const wrong = new DataCenterServer([HANDBOOK], 'some-other-token');
    await wrong.start();
    try {
      const client = new HttpConfluenceClient({ baseUrl: wrong.baseUrl, deployment: 'datacenter', email: '', token: TOKEN });
      const failure = client.revision(cqlFor([SPACE]));
      await expect(failure).rejects.toThrow(/Confluence answered 401.*personal access token/);
      await expect(client.revision(cqlFor([SPACE]))).rejects.toThrow(expect.not.stringContaining(TOKEN) as unknown as string);
    } finally {
      await wrong.stop();
    }
  });

  it('does not ask for an e-mail, and says "personal access token" when none is stored', async () => {
    const noSecret = { ...row(), secretEnc: null } as DocumentSourceRow;
    const d = new ConfluenceDriver(noSecret, {
      db: null as never,
      log,
      config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] },
    });
    await expect(d.sync()).rejects.toThrow('This Confluence source has no personal access token stored');
  });
});

describe('the data center version check', () => {
  it('accepts 7.9 and every later release', () => {
    for (const version of ['7.9.0', '7.19.26', '8.0', '8.9.4', '9.2.1', '10.0.0']) {
      expect(() => checkDataCenterVersion({ version, product: 'confluence' })).not.toThrow();
    }
  });

  it('refuses a release before 7.9 by its version', () => {
    expect(() => checkDataCenterVersion({ version: '7.8.3', product: 'confluence' })).toThrow('Confluence 7.8.3 is not supported');
    expect(() => checkDataCenterVersion({ version: '6.15.10', product: 'Confluence' })).toThrow('Confluence 6.15.10 is not supported');
  });

  it('refuses a version it cannot read rather than assuming one', () => {
    expect(() => checkDataCenterVersion({ version: '', product: 'confluence' })).toThrow(/Could not read a Confluence version/);
    expect(() => checkDataCenterVersion({ version: 'latest', product: null })).toThrow(/Could not read a Confluence version/);
  });

  it('parses the XML manifest older releases answer with', async () => {
    const client = new HttpConfluenceClient(
      { baseUrl: 'https://wiki.acme.internal/confluence', deployment: 'datacenter', email: '', token: TOKEN },
      async () =>
        new Response('<manifest><id>x</id><typeId>confluence</typeId><version>7.13.20</version></manifest>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    );
    expect(await client.serverInfo()).toEqual({ version: '7.13.20', product: 'confluence' });
  });

  it('blames what sits in front of Confluence, not the token, when the anonymous manifest is refused', async () => {
    const client = new HttpConfluenceClient(
      { baseUrl: 'https://wiki.acme.internal/confluence', deployment: 'datacenter', email: '', token: TOKEN },
      async () => new Response('Unauthorized', { status: 401 }),
    );
    const failure = client.serverInfo();
    await expect(failure).rejects.toThrow(/401 for \/rest\/applinks\/1\.0\/manifest.*carries no credential.*proxy, SSO/);
    await expect(client.serverInfo()).rejects.not.toThrow(/personal access token/);
  });
});

/**
 * Cloud is unchanged: the same URL, the same Basic header, and an absent `deployment` still means
 * Cloud — which is what every source stored before this change carries.
 */
describe('confluence cloud, after data center', () => {
  it('reads a stored config without a deployment as cloud', () => {
    const cfg = parseSourceConfig('confluence', { baseUrl: 'https://acme.atlassian.net/wiki', email: 'docs@example.com', spaceKeys: ['ENG'] });
    expect(cfg.deployment).toBe('cloud');
  });

  it('sends the requests it always sent', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new HttpConfluenceClient(
      { baseUrl: 'https://acme.atlassian.net/wiki', email: 'docs@example.com', token: TOKEN },
      async (url, init) => {
        seen.push({ url, headers: init.headers });
        return new Response('{"results":[],"totalSize":0,"_links":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );

    await client.listPages(cqlFor(['ENG']));
    expect(await client.revision(cqlFor(['ENG']))).toEqual({ total: 0, newest: null });
    await client.whoAmI();

    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/wiki/rest/api/search', '/wiki/rest/api/search', '/wiki/rest/api/user/current']);
    for (const s of seen) {
      expect(s.headers).toEqual({
        authorization: `Basic ${Buffer.from(`docs@example.com:${TOKEN}`).toString('base64')}`,
        accept: 'application/json',
      });
    }
    // No start, no manifest: Cloud never takes a Data Center branch.
    expect(seen.every((s) => !new URL(s.url).searchParams.has('start'))).toBe(true);
  });
});
