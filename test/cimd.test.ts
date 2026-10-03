import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CIMD_DEFAULT_TTL_MS,
  CIMD_MAX_BYTES,
  CIMD_MAX_TTL_MS,
  cacheLifetimeMs,
  ClientMetadataError,
  ClientMetadataResolver,
  isClientIdUrl,
  metadataRedirectAllowed,
  parseClientIdUrl,
  redirectsOnlyToLoopback,
} from '../src/mcp/cimd.js';
import { confluenceEgress, EgressRefusedError } from '../src/services/sources/confluence-egress.js';
import { fixtureMetadataFetch, MetadataHost } from './support/cimd-fixture.js';
import { PUBLIC_FIXTURE_ADDRESS } from './support/egress-seams.js';

const HOST = 'client.example.test';
const CLIENT_ID = `https://${HOST}/oauth/client.json`;
const REDIRECT = 'https://client.example.test/callback';
const NAMES = { [HOST]: PUBLIC_FIXTURE_ADDRESS, 'internal.example.test': '10.0.0.5', 'rebind.example.test': '127.0.0.1' };

const validDocument = (overrides: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: 'Example Connector',
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: 'none',
  ...overrides,
});

describe('isClientIdUrl / parseClientIdUrl', () => {
  it('tells a registration id from a URL', () => {
    expect(isClientIdUrl('ctxc_0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isClientIdUrl(CLIENT_ID)).toBe(true);
    expect(isClientIdUrl('http://client.example.test/c')).toBe(true);
  });

  it('accepts an https URL with a path, and a query', () => {
    expect(parseClientIdUrl(CLIENT_ID).hostname).toBe(HOST);
    expect(parseClientIdUrl(`${CLIENT_ID}?v=2`).search).toBe('?v=2');
  });

  it.each([
    ['http://client.example.test/client.json', 'https'],
    ['https://client.example.test', 'path'],
    ['https://client.example.test/', 'path'],
    ['https://client.example.test/c#frag', 'fragment'],
    ['https://user:pw@client.example.test/c', 'username or password'],
    ['https://client.example.test/a/../c', '".."'],
    ['https://client.example.test/./c', '"."'],
    ['https://client.example.test/a/%2E%2E/c', '".."'],
    ['not a url:', 'not a valid URL'],
  ])('refuses %s', (raw, why) => {
    expect(() => parseClientIdUrl(raw)).toThrow(ClientMetadataError);
    expect(() => parseClientIdUrl(raw)).toThrow(why);
  });
});

describe('cacheLifetimeMs', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const h = (init: Record<string, string>) => new Headers(init);

  it('honours max-age, capped at the ceiling', () => {
    expect(cacheLifetimeMs(h({ 'cache-control': 'public, max-age=600' }), now)).toBe(600_000);
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=31536000' }), now)).toBe(CIMD_MAX_TTL_MS);
  });

  it('does not cache no-store, no-cache or max-age=0', () => {
    expect(cacheLifetimeMs(h({ 'cache-control': 'no-store' }), now)).toBe(0);
    expect(cacheLifetimeMs(h({ 'cache-control': 'no-cache, max-age=600' }), now)).toBe(0);
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=0' }), now)).toBe(0);
  });

  it('falls back to Expires against Date, and treats an invalid Expires as expired', () => {
    expect(cacheLifetimeMs(h({ date: 'Sat, 03 Oct 2026 12:00:00 GMT', expires: 'Sat, 03 Oct 2026 12:10:00 GMT' }), 0)).toBe(600_000);
    expect(cacheLifetimeMs(h({ expires: '0' }), now)).toBe(0);
  });

  it('uses the default when the document says nothing', () => {
    expect(cacheLifetimeMs(h({}), now)).toBe(CIMD_DEFAULT_TTL_MS);
  });

  it('subtracts the Age a cache in front already spent', () => {
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=86400', age: '86000' }), now)).toBe(400_000);
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=600', age: '600' }), now)).toBe(0);
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=600', age: '9000' }), now)).toBe(0);
    expect(cacheLifetimeMs(h({ age: '60' }), now)).toBe(CIMD_DEFAULT_TTL_MS - 60_000);
  });

  it('ignores an Age that is not a plain number of seconds', () => {
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=600', age: '-5' }), now)).toBe(600_000);
    expect(cacheLifetimeMs(h({ 'cache-control': 'max-age=600', age: '1.5' }), now)).toBe(600_000);
  });
});

describe('redirect checks', () => {
  const metadata = { clientId: CLIENT_ID, clientName: 'x', redirectUris: [REDIRECT, 'http://127.0.0.1:7777/cb'], applicationType: undefined };

  it('requires the exact string from the document', () => {
    expect(metadataRedirectAllowed(metadata, REDIRECT)).toBe(true);
    expect(metadataRedirectAllowed(metadata, `${REDIRECT}/`)).toBe(false);
    expect(metadataRedirectAllowed(metadata, 'https://client.example.test/other')).toBe(false);
  });

  it('still applies the registration rule for the application type', () => {
    const web = { ...metadata, applicationType: 'web' as const };
    expect(metadataRedirectAllowed(web, 'http://127.0.0.1:7777/cb')).toBe(false);
  });

  it('knows a loopback-only client', () => {
    expect(redirectsOnlyToLoopback(metadata)).toBe(false);
    expect(redirectsOnlyToLoopback({ ...metadata, redirectUris: ['http://localhost:1/cb', 'http://127.0.0.1:2/cb', 'http://[::1]:3/cb'] })).toBe(
      true,
    );
  });
});

describe('ClientMetadataResolver', () => {
  const host = new MetadataHost();
  let now = 0;
  const resolver = (opts: { timeoutMs?: number } = {}) =>
    new ClientMetadataResolver({ fetch: fixtureMetadataFetch(host, NAMES, opts.timeoutMs), now: () => now, ...opts });

  beforeEach(async () => {
    now = Date.parse('2026-10-03T12:00:00Z');
    host.hits.length = 0;
    await host.start();
  });
  afterEach(async () => {
    await host.stop();
  });

  it('accepts a valid document', async () => {
    host.serveJson(validDocument());
    const metadata = await resolver().resolve(CLIENT_ID);
    expect(metadata).toEqual({ clientId: CLIENT_ID, clientName: 'Example Connector', redirectUris: [REDIRECT], applicationType: undefined });
    expect(host.hits).toEqual(['/oauth/client.json']);
  });

  describe('SSRF (ADR-0088)', () => {
    it.each([
      ['https://169.254.169.254/latest/meta-data', 'link-local'],
      ['https://127.0.0.1/client.json', 'loopback'],
      ['https://[::1]/client.json', 'loopback'],
      ['https://10.0.0.5/client.json', 'private'],
      ['https://internal.example.test/client.json', 'private'],
      ['https://rebind.example.test/client.json', 'loopback'],
    ])('refuses %s', async (clientId, rule) => {
      host.serveJson(validDocument({ client_id: clientId }));
      const refusal = resolver().resolve(clientId);
      await expect(refusal).rejects.toThrow(ClientMetadataError);
      await expect(refusal).rejects.toThrow(rule);
      expect(host.hits).toEqual([]);
    });

    it('never offers an allow-list for a private address', async () => {
      const error = await resolver()
        .resolve('https://internal.example.test/client.json')
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(ClientMetadataError);
      expect((error as Error).message).not.toContain('ALLOWED_HOSTS');
    });

    it('rechecks a redirect hop', async () => {
      host.respond = (_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${host.port}/client.json` });
        res.end();
      };
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('redirected to `127.0.0.1`, which is loopback');
      expect(host.hits).toEqual(['/oauth/client.json']);
    });

    it.each(['http://client.example.test/client.json', 'https://client.example.test'])('refuses %s before any fetch', async (clientId) => {
      await expect(resolver().resolve(clientId)).rejects.toThrow(ClientMetadataError);
      expect(host.hits).toEqual([]);
    });

    it('the production egress refuses plain http', async () => {
      const egress = confluenceEgress({ allowedHosts: [], allowListName: null, httpsOnly: true, label: 'The client metadata host' });
      const refused = egress(`http://${HOST}/client.json`, { method: 'GET', headers: {} });
      await expect(refused).rejects.toBeInstanceOf(EgressRefusedError);
      await expect(refused).rejects.toThrow('only https is allowed');
    });
  });

  describe('document rules', () => {
    it('refuses a document that names another client_id', async () => {
      host.serveJson(validDocument({ client_id: 'https://evil.example.test/client.json' }));
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('different client_id');
    });

    it.each(['client_id', 'client_name', 'redirect_uris'])('refuses a document without %s', async (field) => {
      const doc: Record<string, unknown> = validDocument();
      delete doc[field];
      host.serveJson(doc);
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow(ClientMetadataError);
    });

    it('refuses invalid JSON and a non-object', async () => {
      host.serveJson('{not json');
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('not valid JSON');
      host.serveJson('[1,2]');
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('not a JSON object');
    });

    it('refuses a shared secret', async () => {
      host.serveJson(validDocument({ client_secret: 's3cret' }));
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('client_secret');
      host.serveJson(validDocument({ token_endpoint_auth_method: 'client_secret_basic' }));
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('token_endpoint_auth_method');
    });

    it('refuses a status other than 200', async () => {
      host.respond = (_req, res) => {
        res.writeHead(404);
        res.end();
      };
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow('HTTP 404');
    });
  });

  describe('limits', () => {
    it('refuses a body over the size limit, declared or streamed', async () => {
      host.serveJson(validDocument({ padding: 'x'.repeat(CIMD_MAX_BYTES) }));
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow(`larger than ${CIMD_MAX_BYTES} bytes`);

      host.respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        for (let i = 0; i < 8; i++) res.write('x'.repeat(1024));
        res.end();
      };
      await expect(resolver().resolve(CLIENT_ID)).rejects.toThrow(`larger than ${CIMD_MAX_BYTES} bytes`);
    });

    it('gives up on a host that does not answer in time', async () => {
      host.respond = () => undefined;
      await expect(resolver({ timeoutMs: 200 }).resolve(CLIENT_ID)).rejects.toThrow(ClientMetadataError);
    });

    it('gives up on a body that drips past the deadline, and closes the connection', async () => {
      let closedAt = 0;
      host.respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        const drip = setInterval(() => res.write(' '), 50);
        res.on('close', () => {
          clearInterval(drip);
          closedAt = Date.now();
        });
      };
      const started = Date.now();
      await expect(resolver({ timeoutMs: 300 }).resolve(CLIENT_ID)).rejects.toThrow('did not arrive within 0.3 s');
      await vi.waitFor(() => expect(closedAt).toBeGreaterThan(0), { timeout: 500, interval: 10 });
      expect(closedAt - started).toBeLessThan(800);
      await vi.waitFor(async () => expect(await host.connections()).toBe(0), { timeout: 500, interval: 10 });
    });

    it('closes the connection of a host that drips its headers past the deadline', async () => {
      // The egress's own idle timeout (2 s) is far past the 300 ms deadline and the drip keeps the socket
      // busy, so only the abort of the still-unanswered request can close this connection in time.
      let closedAt = 0;
      host.respond = (req) => {
        const socket = req.socket;
        socket.write('HTTP/1.1 200 OK\r\n');
        const drip = setInterval(() => socket.write('X-Padding: a\r\n'), 50);
        socket.on('close', () => {
          clearInterval(drip);
          closedAt = Date.now();
        });
      };
      const r = new ClientMetadataResolver({ fetch: fixtureMetadataFetch(host, NAMES, 2_000), now: () => now, timeoutMs: 300 });
      const started = Date.now();
      await expect(r.resolve(CLIENT_ID)).rejects.toThrow('did not arrive within 0.3 s');
      await vi.waitFor(() => expect(closedAt).toBeGreaterThan(0), { timeout: 500, interval: 10 });
      expect(closedAt - started).toBeLessThan(800);
      await vi.waitFor(async () => expect(await host.connections()).toBe(0), { timeout: 500, interval: 10 });
    });
  });

  describe('cache', () => {
    it('reuses a document for its max-age, then fetches again', async () => {
      host.serveJson(validDocument(), { 'cache-control': 'max-age=60' });
      const r = resolver();
      await r.resolve(CLIENT_ID);
      await r.resolve(CLIENT_ID);
      expect(host.hits).toHaveLength(1);
      expect(r.isCached(CLIENT_ID)).toBe(true);
      now += 61_000;
      expect(r.isCached(CLIENT_ID)).toBe(false);
      await r.resolve(CLIENT_ID);
      expect(host.hits).toHaveLength(2);
    });

    it('does not keep a no-store document, nor a refusal', async () => {
      host.serveJson(validDocument(), { 'cache-control': 'no-store' });
      const r = resolver();
      await r.resolve(CLIENT_ID);
      await r.resolve(CLIENT_ID);
      expect(host.hits).toHaveLength(2);

      host.serveJson(validDocument({ client_name: '' }));
      const refusing = resolver();
      await expect(refusing.resolve(CLIENT_ID)).rejects.toThrow(ClientMetadataError);
      expect(refusing.isCached(CLIENT_ID)).toBe(false);
    });
  });
});
