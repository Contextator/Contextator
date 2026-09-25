import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvSchema, WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { HttpConfluenceClient } from '../src/services/sources/confluence-client.js';
import { confluenceEgress, EgressRefusedError, refusedRule, type EgressOptions } from '../src/services/sources/confluence-egress.js';
import { ConfluenceDriver } from '../src/services/sources/confluence.js';
import { DataCenterServer } from './support/confluence-dc-server.js';
import { HANDBOOK, SPACE } from './support/confluence-stub.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, publicFixture, renamed, routeToLoopback } from './support/egress-seams.js';

/**
 * The SSRF guard on every Confluence request ([ADR-0088](../.ssot/ADR.md#adr-0088)).
 *
 * The fixtures are real HTTP servers on 127.0.0.1, which the guard refuses; a test reaches one only by
 * naming it with a host that `resolve` answers with a public test address, after which `route` dials the
 * loopback interface (`support/egress-seams.ts`). So every assertion here goes through the check itself.
 *
 * **Mutation proof.** Make `refusedRule` return `null` for every address and every refusal case below
 * goes red — the fixture is hit, or the request succeeds, where the test says nothing was sent.
 */

interface Hit {
  path: string;
  authorization: string | undefined;
}

/** A fixture that records what reached it and answers with what `respond` says. */
class Fixture {
  readonly hits: Hit[] = [];
  private server?: http.Server;
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };

  get port(): number {
    if (!this.server) throw new Error('fixture not started');
    return (this.server.address() as AddressInfo).port;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.hits.push({ path: req.url ?? '/', authorization: req.headers.authorization });
      this.respond(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const GET = { method: 'GET', headers: { authorization: 'Bearer secret-token', accept: 'application/json' } };

describe('refusedRule', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['febf::1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['ff02::1', 'multicast'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fec0::1', 'private'],
    // IPv6 that carries an IPv4 address is judged as that IPv4 address.
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:10.1.2.3', 'private'],
    ['::ffff:0:10.1.2.3', 'private'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::169.254.169.254', 'link-local'],
    ['not-an-address', 'unspecified'],
  ])('refuses %s as %s', (address, rule) => {
    expect(refusedRule(address)).toBe(rule);
  });

  it.each([
    '8.8.8.8',
    '203.0.113.7',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '169.253.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8',
  ])('lets %s through', (address) => {
    expect(refusedRule(address)).toBeNull();
  });
});

describe('confluenceEgress', () => {
  const fixture = new Fixture();
  const other = new Fixture();

  beforeAll(async () => {
    await fixture.start();
    await other.start();
  });
  afterAll(async () => {
    await fixture.stop();
    await other.stop();
  });
  beforeEach(() => {
    fixture.hits.length = 0;
    other.hits.length = 0;
    fixture.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
  });

  const guarded = (options: Partial<EgressOptions> = {}) => confluenceEgress({ allowedHosts: [], ...options });
  const refusal = async (promise: Promise<unknown>): Promise<EgressRefusedError> => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressRefusedError);
    return err as EgressRefusedError;
  };

  describe('an address written into the URL', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['[::1]', 'loopback'],
      ['169.254.169.254', 'link-local'],
      ['10.0.4.12', 'private'],
      ['[::ffff:127.0.0.1]', 'loopback'],
      ['[::ffff:169.254.169.254]', 'link-local'],
      ['[fc00::1]', 'private'],
      ['0.0.0.0', 'unspecified'],
      ['224.0.0.1', 'multicast'],
    ])('refuses %s as %s without resolving or connecting', async (host, rule) => {
      let resolved = 0;
      const fetch = guarded({
        resolve: async () => {
          resolved++;
          return [{ address: PUBLIC_FIXTURE_ADDRESS, family: 4 }];
        },
      });
      const err = await refusal(fetch(`http://${host}:${fixture.port}/rest/api/space`, GET));
      expect(err.rule).toBe(rule);
      expect(err.message).toMatch(new RegExp(`^refused: \`.+\` is ${rule}`));
      expect(resolved).toBe(0);
      expect(fixture.hits).toEqual([]);
    });

    it('names the metadata address the way the API contract spells it', async () => {
      const err = await refusal(guarded()('http://169.254.169.254/latest/meta-data/', GET));
      expect(err.message).toBe('refused: `169.254.169.254` is link-local');
    });

    it('reaches the fixture on 127.0.0.1 when the guard is not asked, which is what the refusals above are measured against', async () => {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/control`);
      expect(res.status).toBe(200);
      expect(fixture.hits).toHaveLength(1);
    });
  });

  describe('a name that resolves to an internal address', () => {
    it.each([
      ['10.1.2.3', 'private'],
      ['169.254.169.254', 'link-local'],
      ['127.0.0.1', 'loopback'],
      ['::ffff:10.1.2.3', 'private'],
      ['fd00::5', 'private'],
    ])('refuses a name that resolves to %s, without saying the address', async (address, rule) => {
      const fetch = guarded({ resolve: fakeResolver({ 'wiki.internal.example': address }), route: routeToLoopback(address) });
      const err = await refusal(fetch(`http://wiki.internal.example:${fixture.port}/rest/api/space`, GET));
      expect(err.rule).toBe(rule);
      expect(err.message).toContain('`wiki.internal.example` resolves to');
      expect(err.message).toContain(rule);
      expect(err.message).not.toContain(address);
      expect(fixture.hits).toEqual([]);
    });

    it('refuses when any one of several answers is internal, not only the first', async () => {
      const fetch = guarded({
        resolve: async () => [
          { address: PUBLIC_FIXTURE_ADDRESS, family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
        route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS, '169.254.169.254'),
      });
      const err = await refusal(fetch(`http://mixed.example:${fixture.port}/`, GET));
      expect(err.rule).toBe('link-local');
      expect(fixture.hits).toEqual([]);
    });

    it('tells the operator which setting allows a private host', async () => {
      const fetch = guarded({ resolve: fakeResolver({ 'wiki.corp': '10.20.30.40' }), route: routeToLoopback('10.20.30.40') });
      const err = await refusal(fetch(`http://wiki.corp:${fixture.port}/`, GET));
      expect(err.message).toBe('refused: `wiki.corp` resolves to a private address; list `wiki.corp` in CONFLUENCE_ALLOWED_HOSTS to allow it');
    });
  });

  describe('CONFLUENCE_ALLOWED_HOSTS', () => {
    it('lets a listed host reach its private address', async () => {
      const fetch = guarded({
        allowedHosts: ['Wiki.Corp.'],
        resolve: fakeResolver({ 'wiki.corp': '10.20.30.40' }),
        route: routeToLoopback('10.20.30.40'),
      });
      const res = await fetch(`http://wiki.corp:${fixture.port}/rest/api/space`, GET);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(fixture.hits).toEqual([{ path: '/rest/api/space', authorization: 'Bearer secret-token' }]);
    });

    it('lets a listed host reach a private IPv6 address', async () => {
      const fetch = guarded({ allowedHosts: ['wiki.corp'], resolve: fakeResolver({ 'wiki.corp': 'fd00::5' }), route: () => '127.0.0.1' });
      const res = await fetch(`http://wiki.corp:${fixture.port}/`, GET);
      expect(res.status).toBe(200);
    });

    it('never lifts loopback, link-local, unspecified or multicast', async () => {
      for (const address of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
        const fetch = guarded({ allowedHosts: ['wiki.corp'], resolve: fakeResolver({ 'wiki.corp': address }), route: () => '127.0.0.1' });
        const err = await refusal(fetch(`http://wiki.corp:${fixture.port}/`, GET));
        expect(err.rule).not.toBe('private');
      }
      expect(fixture.hits).toEqual([]);
    });

    it('allows a listed name, not every name that resolves to the same address', async () => {
      const resolve = fakeResolver({ 'wiki.corp': '10.20.30.40', 'other.corp': '10.20.30.40' });
      const fetch = guarded({ allowedHosts: ['wiki.corp'], resolve, route: routeToLoopback('10.20.30.40') });
      const err = await refusal(fetch(`http://other.corp:${fixture.port}/`, GET));
      expect(err.rule).toBe('private');
      expect(fixture.hits).toEqual([]);
    });
  });

  describe('redirects', () => {
    const seams = (extra: Record<string, string> = {}) => ({
      resolve: fakeResolver({ 'public.test': PUBLIC_FIXTURE_ADDRESS, 'other.test': PUBLIC_FIXTURE_ADDRESS, ...extra }),
      route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS, ...Object.values(extra)),
    });
    const redirectTo = (location: string) => {
      fixture.respond = (_req, res) => {
        res.writeHead(302, { location });
        res.end();
      };
    };

    it('refuses a redirect from an external host to the metadata address', async () => {
      redirectTo('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
      const err = await refusal(guarded(seams())(`http://public.test:${fixture.port}/rest/api/space`, GET));
      expect(err.rule).toBe('link-local');
      expect(err.message).toBe('refused: the server redirected to `169.254.169.254`, which is link-local');
      expect(fixture.hits).toHaveLength(1);
    });

    it('refuses a redirect from an external host to the loopback interface', async () => {
      redirectTo(`http://127.0.0.1:${other.port}/admin`);
      const err = await refusal(guarded(seams())(`http://public.test:${fixture.port}/`, GET));
      expect(err.rule).toBe('loopback');
      expect(fixture.hits).toHaveLength(1);
      expect(other.hits).toEqual([]);
    });

    it('refuses a redirect to a name that resolves inside, without saying the address', async () => {
      redirectTo(`http://db.internal:${other.port}/`);
      const err = await refusal(guarded(seams({ 'db.internal': '10.9.8.7' }))(`http://public.test:${fixture.port}/`, GET));
      expect(err.rule).toBe('private');
      expect(err.message).toContain('the server redirected to `db.internal`, which resolves to a private address');
      expect(err.message).not.toContain('10.9.8.7');
      expect(other.hits).toEqual([]);
    });

    it('refuses a redirect to a scheme other than http and https', async () => {
      redirectTo('file:///etc/passwd');
      const err = await refusal(guarded(seams())(`http://public.test:${fixture.port}/`, GET));
      expect(err.rule).toBe('scheme');
    });

    it('follows a redirect to an allowed host, and drops the credential when the origin changes', async () => {
      redirectTo(`http://other.test:${other.port}/landing`);
      const res = await guarded(seams())(`http://public.test:${fixture.port}/start`, GET);
      expect(res.status).toBe(200);
      expect(fixture.hits).toEqual([{ path: '/start', authorization: 'Bearer secret-token' }]);
      expect(other.hits).toEqual([{ path: '/landing', authorization: undefined }]);
    });

    it('keeps the credential on a redirect within the same origin', async () => {
      fixture.respond = (req, res) => {
        if (req.url === '/start') {
          res.writeHead(301, { location: '/confluence/start' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      };
      const res = await guarded(seams())(`http://public.test:${fixture.port}/start`, GET);
      expect(res.status).toBe(200);
      expect(fixture.hits.map((h) => h.authorization)).toEqual(['Bearer secret-token', 'Bearer secret-token']);
    });

    it('stops after five hops', async () => {
      fixture.respond = (req, res) => {
        res.writeHead(302, { location: `${req.url}x` });
        res.end();
      };
      await expect(guarded(seams())(`http://public.test:${fixture.port}/r`, GET)).rejects.toThrow('Confluence redirected more than 5 times');
      expect(fixture.hits).toHaveLength(6);
    });
  });

  describe('what comes back', () => {
    const fetch = () => guarded(publicFixture('public.test'));

    it('decodes a gzipped body, as fetch did', async () => {
      fixture.respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from('{"results":[1,2,3]}')));
      };
      const res = await fetch()(`http://public.test:${fixture.port}/`, GET);
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(await res.json()).toEqual({ results: [1, 2, 3] });
    });

    it('passes an error status and its body through for the client to explain', async () => {
      fixture.respond = (_req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('nope');
      };
      const res = await fetch()(`http://public.test:${fixture.port}/`, GET);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('nope');
    });

    it('says a host could not be reached without the address it resolved to', async () => {
      const closed = new Fixture();
      await closed.start();
      const port = closed.port;
      await closed.stop();
      const guardedFetch = guarded({ allowedHosts: ['wiki.corp'], resolve: fakeResolver({ 'wiki.corp': '10.20.30.40' }), route: () => '127.0.0.1' });
      const err = (await guardedFetch(`http://wiki.corp:${port}/`, GET).catch((e: unknown) => e)) as Error;
      expect(err.message).toBe('Could not reach Confluence at `wiki.corp`: ECONNREFUSED');
      expect(err.message).not.toMatch(/10\.20\.30\.40|127\.0\.0\.1/);
    });

    it('times out a server that never answers', async () => {
      fixture.respond = () => undefined;
      const slow = guarded({ ...publicFixture('public.test'), timeoutMs: 100 });
      await expect(slow(`http://public.test:${fixture.port}/`, GET)).rejects.toThrow('Confluence at `public.test` did not answer within 0.1 s');
    });
  });

  /**
   * The scheduler builds an egress per probe, so a pooled socket nobody asks for again must close on
   * the client's side rather than wait for the server. **Mutation proof:** drop the agent's `timeout`
   * and the first case goes red — the server below keeps an idle connection for ten seconds.
   */
  describe('kept-alive connections', () => {
    let server: http.Server;
    let connections = 0;
    let closed: Promise<void>;
    let answerAfterMs = 0;

    beforeEach(async () => {
      connections = 0;
      answerAfterMs = 0;
      let markClosed: () => void = () => undefined;
      closed = new Promise((resolve) => {
        markClosed = resolve;
      });
      server = http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }, answerAfterMs);
      });
      server.keepAliveTimeout = 10_000;
      server.on('connection', (socket) => {
        connections++;
        socket.once('close', () => markClosed());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const url = () => `http://public.test:${(server.address() as AddressInfo).port}/`;
    const settlesWithin = (promise: Promise<void>, ms: number): Promise<boolean> =>
      Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

    it('closes a connection that has waited idle in the pool for idleMs', async () => {
      const fetch = guarded({ ...publicFixture('public.test'), idleMs: 100 });
      expect(await (await fetch(url(), GET)).json()).toEqual({ ok: true });
      expect(await settlesWithin(closed, 2_000)).toBe(true);
    });

    it('reuses a connection for a request that comes before idleMs', async () => {
      const fetch = guarded({ ...publicFixture('public.test'), idleMs: 2_000 });
      await (await fetch(url(), GET)).text();
      await (await fetch(url(), GET)).text();
      expect(connections).toBe(1);
    });

    it('does not cut a request whose answer takes longer than idleMs, on a fresh socket or a pooled one', async () => {
      const fetch = guarded({ ...publicFixture('public.test'), idleMs: 100 });
      expect(await (await fetch(url(), GET)).json()).toEqual({ ok: true });
      // The pool has just put idleMs on that socket; the next request takes it back and has to run on
      // its own timeout again, or a sync that pages through one connection is cut after the first page.
      answerAfterMs = 400;
      expect(await (await fetch(url(), GET)).json()).toEqual({ ok: true });
      expect(connections).toBe(1);
    });
  });
});

describe('CONFLUENCE_ALLOWED_HOSTS as configuration', () => {
  const parse = (value: string) => EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', CONFLUENCE_ALLOWED_HOSTS: value });

  it('defaults to allowing no private host', () => {
    const result = EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused' });
    expect(result.success && result.data.CONFLUENCE_ALLOWED_HOSTS).toEqual([]);
  });

  it('reads a comma-separated list of names and addresses', () => {
    const result = parse(' Wiki.Corp.Example. , 10.0.4.12,[fd00::1]');
    expect(result.success && result.data.CONFLUENCE_ALLOWED_HOSTS).toEqual(['wiki.corp.example', '10.0.4.12', 'fd00::1']);
  });

  it.each(['https://wiki.corp', 'wiki.corp:8090', 'wiki.corp/confluence', '*'])('rejects %s rather than silently allowing nothing', (value) => {
    const result = parse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('without scheme, port or path');
  });
});

describe('the Confluence driver behind the guard', () => {
  const KEY = 'k'.repeat(64);
  const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
  let dataDir: string;
  let server: DataCenterServer;

  const driver = (baseUrl: string, allowed: string[] | undefined, egress?: Pick<EgressOptions, 'resolve' | 'route'>) =>
    new ConfluenceDriver(
      {
        id: '00000000-0000-4000-8000-000000000031',
        projectId: '00000000-0000-4000-8000-000000000032',
        type: 'confluence',
        name: 'guarded',
        config: { baseUrl, deployment: 'datacenter', email: '', spaceKeys: [SPACE], extensions: ['md'] },
        secretEnc: encryptSecret('not-a-real-token', { current: KEY }),
      } as unknown as DocumentSourceRow,
      {
        db: null as never,
        log,
        config: {
          ...WEB_LIMIT_DEFAULTS,
          DATA_DIR: dataDir,
          SECRET_KEY: KEY,
          ALLOWED_DOC_ROOTS: [],
          IGNORE_GLOBS: [],
          ...(allowed ? { CONFLUENCE_ALLOWED_HOSTS: allowed } : {}),
        },
      },
      undefined,
      egress,
    );

  beforeAll(async () => {
    dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-confluence-egress-')));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    server = new DataCenterServer([HANDBOOK], 'not-a-real-token');
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it('refuses a base URL on the loopback interface on Test, probe and sync, before any request', async () => {
    const d = driver(server.baseUrl, undefined);
    await expect(d.test()).rejects.toThrow('refused: `127.0.0.1` is loopback');
    await expect(d.probe()).rejects.toThrow('refused: `127.0.0.1` is loopback');
    await expect(d.sync()).rejects.toThrow('refused: `127.0.0.1` is loopback');
    expect(server.requests).toEqual([]);
  });

  it('refuses a Data Center on a private address until its host is listed, then connects', async () => {
    const seams = { resolve: fakeResolver({ 'wiki.corp': '10.20.30.40' }), route: routeToLoopback('10.20.30.40') };
    const baseUrl = renamed(server.baseUrl, 'wiki.corp');

    await expect(driver(baseUrl, undefined, seams).test()).rejects.toThrow(
      'refused: `wiki.corp` resolves to a private address; list `wiki.corp` in CONFLUENCE_ALLOWED_HOSTS to allow it',
    );
    await expect(driver(baseUrl, ['other.corp'], seams).sync()).rejects.toThrow(/resolves to a private address/);
    expect(server.requests).toEqual([]);

    expect(await driver(baseUrl, ['wiki.corp'], seams).test()).toMatch(/^Connected to Confluence Data Center/);
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('guards a client built without an explicit fetch', async () => {
    const client = new HttpConfluenceClient({ baseUrl: server.baseUrl, deployment: 'datacenter', email: '', token: 'not-a-real-token' });
    await expect(client.whoAmI()).rejects.toThrow('refused: `127.0.0.1` is loopback');
    expect(server.requests).toEqual([]);
  });
});
