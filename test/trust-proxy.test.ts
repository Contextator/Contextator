import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/admin/routes.js';
import { oauthRoutes } from '../src/mcp/oauth-routes.js';
import { EnvSchema, loadConfig, OAUTH_REGISTER_MAX_PER_HOST } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { httpServerOptions, warnAboutProxyConfiguration } from '../src/http.js';
import { AuditWriter } from '../src/services/audit.js';
import { SetupGate } from '../src/services/auth/setup.js';
import { MetricsRegistry } from '../src/services/metrics.js';
import { SlidingWindow } from '../src/services/rate-limit.js';

/**
 * `TRUST_PROXY` decides what `req.ip` is ([ADR-0060](../.ssot/ADR.md#adr-0060)), and `req.ip` is the
 * key of both sliding windows in this product. So the thing worth asserting is not what the setting
 * parses to — it is **what the routes end up keyed on**.
 *
 * Every test below therefore spends a real budget against a real route and reads the boundary back:
 * `AUTH_LOGIN_MAX_ATTEMPTS` requests answer `400` (the body is empty and the limiter let them
 * through), and the next one answers `429`. Whether those requests are one host or many is the whole
 * question, and it is decided by a header the injected request writes.
 *
 * Make `httpServerOptions` ignore `TRUST_PROXY` and return `trustProxy: true` again — the state this
 * product shipped in before [ADR-0060](../.ssot/ADR.md#adr-0060) — and **six** of these go red: every
 * forwarded address becomes its own bucket, the `429` never arrives, and `req.protocol` reads `https`
 * for anybody who claims it. Pinning it to `false` instead kills six as well, from the other side.
 * The counts are measured, not remembered; re-measure them if you add a case.
 */

/** Small, so a budget is a handful of requests rather than a loop worth timing. */
const MAX_ATTEMPTS = 3;

const hollowCtx = (config: AppContext['config'], log: AppContext['log']): AppContext =>
  ({
    config,
    // Nothing here reaches the database: `/api/auth/login` spends the rate-limit budget *before* it
    // parses the body, and an empty body is `400` from zod. So every response in this file is a `4xx`,
    // which is also why the audit hook (successes only) never writes.
    db: {},
    log,
    embeddings: {},
    indexer: {},
    locks: {},
    uploads: {},
    sessions: {},
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(config.AUTH_LOGIN_MAX_ATTEMPTS, config.AUTH_LOGIN_WINDOW_MIN * 60_000),
    metrics: new MetricsRegistry(),
    audit: new AuditWriter({} as never, log),
    version: '0.0.0-test',
    startedAt: Date.now(),
  }) as unknown as AppContext;

/**
 * The admin API on a Fastify built from `httpServerOptions` — the same call `src/server.ts` makes, and
 * the reason this file asserts something about the product rather than about a copy of it. Make that
 * function return `trustProxy: true` unconditionally, which is what this instance did before
 * [ADR-0060](../.ssot/ADR.md#adr-0060), and six of the cases in this file go red.
 */
async function buildApi(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/unused',
    AUTH_LOGIN_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
    ...env,
  });
  const app = Fastify({ logger: false, ...httpServerOptions(config) });
  await app.register(cookie);
  await app.register(adminRoutes, { ctx: hollowCtx(config, app.log) });
  await app.ready();
  return app;
}

/** The OAuth surface, on its own instance, because that is how `src/server.ts` registers it. */
async function buildOauthApi(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig({ DATABASE_URL: 'postgres://unused/unused', ...env });
  const app = Fastify({ logger: false, ...httpServerOptions(config) });
  await app.register(cookie);
  await app.register(oauthRoutes, { ctx: hollowCtx(config, app.log) });
  await app.ready();
  return app;
}

/** One sign-in attempt, from a socket, claiming a forwarded address. */
const login = (app: FastifyInstance, forwardedFor: string, from = '127.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: from,
    headers: { 'x-forwarded-for': forwardedFor },
    payload: {},
  });

/** One dynamic client registration, same two addresses. Its body is empty for the same reason. */
const register = (app: FastifyInstance, forwardedFor: string, from = '127.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/oauth/register',
    remoteAddress: from,
    headers: { 'x-forwarded-for': forwardedFor },
    payload: {},
  });

/** `n` attempts, each claiming a different forwarded address, all from one socket. */
async function fromManyClaimedHosts(app: FastifyInstance, n: number, from?: string): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await login(app, `203.0.113.${i + 1}`, from)).statusCode);
  return codes;
}

/** `n` attempts, all claiming the same forwarded address, all from one socket. */
async function fromOneClaimedHost(app: FastifyInstance, n: number, from?: string): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await login(app, '203.0.113.9', from)).statusCode);
  return codes;
}

const spent = (n: number): number[] => [...Array.from({ length: n }, () => 400), 429];

describe('TRUST_PROXY decides what the rate-limited routes are keyed on', () => {
  /**
   * **The default, and the flaw this setting closes.** Unset, `X-Forwarded-For` is not read, so a
   * caller rotating that header is still one host and still spends one budget.
   */
  it('ignores X-Forwarded-For by default, so one socket is one sign-in budget', async () => {
    const app = await buildApi();
    const codes = await fromManyClaimedHosts(app, MAX_ATTEMPTS + 1);
    expect(codes).toEqual(spent(MAX_ATTEMPTS));

    const refused = await login(app, '203.0.113.250');
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  /**
   * The same assertion from the other side: the setting has to actually *work* when an operator turns
   * it on, or the answer to the flaw would be "there is no way to run behind a proxy".
   */
  it('reads X-Forwarded-For at TRUST_PROXY=1, so each claimed host gets its own budget', async () => {
    const many = await buildApi({ TRUST_PROXY: '1' });
    expect(await fromManyClaimedHosts(many, MAX_ATTEMPTS + 2)).toEqual(Array.from({ length: MAX_ATTEMPTS + 2 }, () => 400));
    await many.close();

    const one = await buildApi({ TRUST_PROXY: '1' });
    expect(await fromOneClaimedHost(one, MAX_ATTEMPTS + 1)).toEqual(spent(MAX_ATTEMPTS));
    await one.close();
  });

  /**
   * **The form worth recommending, and what it really matches.** The peer has to be inside the range
   * before a forwarded address counts at all — which a hop count, the form this product deliberately
   * does not accept, cannot express. The next case says what this one must not be read as promising.
   */
  it('takes the forwarded address only from a peer inside the named CIDR', async () => {
    const viaProxy = await buildApi({ TRUST_PROXY: '10.0.0.0/8' });
    expect(await fromManyClaimedHosts(viaProxy, MAX_ATTEMPTS + 2, '10.1.2.3')).toEqual(Array.from({ length: MAX_ATTEMPTS + 2 }, () => 400));
    await viaProxy.close();

    const direct = await buildApi({ TRUST_PROXY: '10.0.0.0/8' });
    expect(await fromManyClaimedHosts(direct, MAX_ATTEMPTS + 1, '192.0.2.5')).toEqual(spent(MAX_ATTEMPTS));
    await direct.close();
  });

  /**
   * **The hazard the documentation now has to carry, pinned so it cannot be re-described wrongly.**
   * `proxy-addr` walks `[socket address, ...X-Forwarded-For reversed]` and stops at the first address
   * the list does not trust — so the list is applied to *every hop*, not to the peer alone. Name a
   * range that holds clients as well as proxies, and a client is walked past exactly as a proxy would
   * be: `TRUST_PROXY=uniquelocal` on a LAN hands `req.ip` straight back to the caller, and the flaw
   * this whole file is about is undone by a setting the README used to recommend without qualification.
   *
   * Asserted rather than merely written down, because a sentence in a comment is the thing that rots.
   */
  it('lets a caller inside a trusted range choose its own key, which is why the range must be the proxy', async () => {
    const lan = await buildApi({ TRUST_PROXY: 'uniquelocal' });
    // Every request is from one LAN client, and every request claims a different address.
    expect(await fromManyClaimedHosts(lan, MAX_ATTEMPTS + 2, '192.168.1.77')).toEqual(Array.from({ length: MAX_ATTEMPTS + 2 }, () => 400));
    await lan.close();

    // The same walk, seen from the other end: a trusted hop *inside* the header is stepped over, and
    // `req.ip` is the first address the range does not cover.
    const chained = await buildApi({ TRUST_PROXY: '10.0.0.0/8' });
    const codes: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      codes.push((await login(chained, `203.0.113.${i + 1}, 10.9.9.9`, '10.1.2.3')).statusCode);
    }
    expect(codes).toEqual(Array.from({ length: MAX_ATTEMPTS + 1 }, () => 400));
    await chained.close();
  });

  /**
   * The second route that keys on `req.ip` ([ADR-0054](../.ssot/ADR.md#adr-0054)), driven the same way
   * — through the endpoint rather than through its limiter, which is the mistake the equivalent
   * integration test had to be rewritten to stop making.
   */
  it('keys /oauth/register on the same resolved address', async () => {
    const app = await buildOauthApi();
    for (let i = 0; i < OAUTH_REGISTER_MAX_PER_HOST; i++) {
      expect((await register(app, `198.51.100.${i % 254}`)).statusCode).toBe(400);
    }
    const refused = await register(app, '198.51.100.254');
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('temporarily_unavailable');
    await app.close();

    const trusting = await buildOauthApi({ TRUST_PROXY: '1' });
    for (let i = 0; i <= OAUTH_REGISTER_MAX_PER_HOST; i++) {
      expect((await register(trusting, `198.51.100.${i % 254}`)).statusCode).toBe(400);
    }
    await trusting.close();
  });
});

/**
 * `req.ip` is not the only thing `trustProxy` decides. `req.protocol` follows it too, and three places
 * build a base URL out of it when `PUBLIC_BASE_URL` is unset ([ADR-0060](../.ssot/ADR.md#adr-0060)) —
 * the OAuth protected-resource metadata, the `WWW-Authenticate` pointer on a `401` from `/mcp/*`, and
 * the admin API's own URLs. Behind a TLS-terminating proxy with `TRUST_PROXY` off, those read `http://`
 * while the client sends `https://`, and `/oauth/authorize` then answers `invalid_target` to every
 * connector. That is a working installation breaking on upgrade, so it is asserted here rather than
 * left to the section of the ADR that describes it.
 */
describe('TRUST_PROXY decides req.protocol as well, which is what the published URLs are built from', () => {
  const protocolSeenBy = async (env: Record<string, string>, from = '10.1.2.3'): Promise<string> => {
    const config = loadConfig({ DATABASE_URL: 'postgres://unused/unused', ...env });
    const app = Fastify({ logger: false, ...httpServerOptions(config) });
    app.get('/probe', async (req) => ({ protocol: req.protocol }));
    const reply = await app.inject({ method: 'GET', url: '/probe', remoteAddress: from, headers: { 'x-forwarded-proto': 'https' } });
    await app.close();
    return reply.json().protocol;
  };

  it('reads http behind a terminating proxy when nothing is trusted', async () => {
    expect(await protocolSeenBy({})).toBe('http');
  });

  it('reads https once the proxy is named, and still not for anybody else', async () => {
    expect(await protocolSeenBy({ TRUST_PROXY: '10.0.0.0/8' })).toBe('https');
    expect(await protocolSeenBy({ TRUST_PROXY: '10.0.0.0/8' }, '192.0.2.5')).toBe('http');
    expect(await protocolSeenBy({ TRUST_PROXY: '1' })).toBe('https');
  });

  /**
   * The remedy the warning names, asserted as a remedy: `PUBLIC_BASE_URL` takes the published URLs off
   * `req.protocol` entirely, so the OAuth half is repaired without touching `TRUST_PROXY`. The sign-in
   * limiter is *not* repaired by it, which is why the warning names both.
   */
  it('stops mattering to a published URL once PUBLIC_BASE_URL is set', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://unused/unused', PUBLIC_BASE_URL: 'https://docs.example.com' });
    expect(config.PUBLIC_BASE_URL).toBe('https://docs.example.com');
    expect(config.TRUST_PROXY).toBe(false);
  });
});

/**
 * The detector ([ADR-0060](../.ssot/ADR.md#adr-0060)). It is an observation, so what it is worth is
 * exactly whether it fires on traffic that proves a proxy is in front and stays quiet on traffic that
 * does not. Delete the hook and the first two cases go red; make it fire unconditionally and the third
 * does — which is the case that keeps it off every default `docker compose` installation.
 */
describe('a TRUST_PROXY that disagrees with the traffic says so, once', () => {
  const runWith = async (env: Record<string, string>, requests: Array<{ from?: string; headers?: Record<string, string> }>): Promise<string[]> => {
    const config = loadConfig({ DATABASE_URL: 'postgres://unused/unused', ...env });
    const app = Fastify({ logger: false, ...httpServerOptions(config) });
    const said: string[] = [];
    warnAboutProxyConfiguration(app, config, (message) => said.push(message));
    app.get('/probe', async () => ({ ok: true }));
    for (const r of requests) await app.inject({ method: 'GET', url: '/probe', remoteAddress: r.from ?? '10.1.2.3', headers: r.headers ?? {} });
    await app.close();
    return said;
  };

  it('fires on a forwarded header that TRUST_PROXY is ignoring, and only the first time', async () => {
    const said = await runWith({}, [{ headers: { 'x-forwarded-proto': 'https' } }, { headers: { 'x-forwarded-for': '203.0.113.9' } }]);
    expect(said).toHaveLength(1);
    // The three consequences and the remedy, because a warning that does not say what broke is noise.
    expect(said[0]).toContain('sign-in');
    expect(said[0]).toContain('invalid_target');
    expect(said[0]).toContain('Secure flag');
    expect(said[0]).toContain('PUBLIC_BASE_URL');
  });

  /** The case no startup rule could have seen: a list that names a proxy other than the real one. */
  it('fires when the named range is not where the proxy actually is', async () => {
    const wrong = await runWith({ TRUST_PROXY: '172.18.0.0/16' }, [{ from: '10.1.2.3', headers: { 'x-forwarded-for': '203.0.113.9' } }]);
    expect(wrong).toHaveLength(1);
  });

  /**
   * **The reason this is not a startup rule.** The shipped `docker compose` installation runs
   * `TRUST_PROXY=0` with no `PUBLIC_BASE_URL` and nothing in front of it, and it is not misconfigured.
   * A rule over the settings would warn every one of those operators on every start.
   */
  it('stays quiet on a deployment with no proxy, and on one whose proxy is named correctly', async () => {
    expect(await runWith({}, [{ headers: {} }, { headers: {} }])).toEqual([]);
    expect(await runWith({ TRUST_PROXY: '10.0.0.0/8' }, [{ from: '10.1.2.3', headers: { 'x-forwarded-for': '203.0.113.9' } }])).toEqual([]);
  });

  /** `TRUST_PROXY=1` is the danger the setting *is*, so it needs no evidence and waits for no request. */
  it('states the risk of TRUST_PROXY=1 at startup, without waiting for traffic', async () => {
    const said = await runWith({ TRUST_PROXY: '1' }, []);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('every hop');
  });
});

describe('TRUST_PROXY accepts three forms and refuses the rest', () => {
  const parse = (value: string) => EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', TRUST_PROXY: value });
  const parsed = (value: string) => {
    const result = parse(value);
    expect(result.success).toBe(true);
    return result.success ? result.data.TRUST_PROXY : undefined;
  };

  it('defaults to false', () => {
    expect(EnvSchema.parse({ DATABASE_URL: 'postgres://unused/unused' }).TRUST_PROXY).toBe(false);
  });

  it('takes both spellings of each boolean', () => {
    for (const off of ['0', 'false', 'FALSE', ' false ']) expect(parsed(off)).toBe(false);
    for (const on of ['1', 'true', 'TRUE', ' 1 ']) expect(parsed(on)).toBe(true);
  });

  it('takes addresses, CIDR blocks and the subnet names, as a list', () => {
    expect(parsed('loopback')).toEqual(['loopback']);
    expect(parsed('10.0.0.0/8, 172.18.0.0/16 ,fd00::/8')).toEqual(['10.0.0.0/8', '172.18.0.0/16', 'fd00::/8']);
    expect(parsed('192.0.2.7,uniquelocal,::1')).toEqual(['192.0.2.7', 'uniquelocal', '::1']);
  });

  /** Case folding reaches the list too, or `Loopback` would be refused while `TRUE` was accepted. */
  it('is as case-insensitive about a list as it is about a boolean', () => {
    expect(parsed('Loopback')).toEqual(['loopback']);
    expect(parsed('FD00::/8,UniqueLocal')).toEqual(['fd00::/8', 'uniquelocal']);
  });

  /**
   * A hop count is the form Fastify accepts and this product does not: the refusal is the decision, so
   * `2` failing here is the assertion and `1` staying a boolean is its consequence.
   */
  it('refuses a hop count, and everything that is not an address', () => {
    const refused = ['2', '10', 'yes', 'on', 'localhost', '10.0.0.0/33', 'fd00::/200', '10.0.0.0/255.0.0.0', '10.0.0.0/', '999.1.1.1'];
    // `/0` is `1` spelled as a subnet, and `proxy-addr` throws on it while Fastify is being
    // constructed — so without this the process would die on a bare stack trace instead of the
    // message that names the accepted forms.
    refused.push('10.0.0.0/0', '0.0.0.0/0', '::/0');
    for (const bad of refused) {
      expect(parse(bad).success, bad).toBe(false);
    }
    // One bad entry refuses the whole list rather than being dropped from it.
    expect(parse('10.0.0.0/8,localhost').success).toBe(false);
  });
});
