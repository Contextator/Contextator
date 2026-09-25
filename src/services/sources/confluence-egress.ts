import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';

import type { FetchLike } from './confluence-client.js';

/**
 * The only way a Confluence request leaves this process ([ADR-0088](../../../.ssot/ADR.md#adr-0088)).
 *
 * A Confluence base URL is typed by an editor and the server connects to it with the source's
 * credential, so without a bound it is a way to read the instance's loopback services, the cloud
 * metadata address or the internal network through a source's status and Test message.
 *
 * **The check runs on the address the socket is opened to.** Node's `lookup` option is the hook: the
 * connection asks it for the address, it resolves, judges every address it got, and hands back only
 * addresses that passed. There is no "resolve, check, then connect again by name" gap for a rebinding
 * answer to slip through, and because the request is still made **by host name**, TLS SNI, certificate
 * verification and the `Host` header are exactly what they would be without it. A host that is already
 * an IP literal never reaches `lookup` (`net.connect` dials it directly), so it is judged before the
 * request is made. Every redirect hop goes through the same two checks.
 */

/** The rule a refused address falls under, named as it is in the refusal. */
export type RefusedRule = 'loopback' | 'link-local' | 'unspecified' | 'multicast' | 'private';

/** DNS as this module needs it. Production uses `dns.lookup`, so `/etc/hosts` and the system resolver apply. */
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface EgressOptions {
  /**
   * `CONFLUENCE_ALLOWED_HOSTS`: host names allowed to resolve to a **private** address. It never lifts
   * loopback, link-local, unspecified or multicast.
   */
  allowedHosts: readonly string[];
  /** Replaces DNS. Tests use it to make a name answer an address; production leaves it unset. */
  resolve?: Resolver;
  /**
   * Where an address that **has already passed the check** is dialled. Identity in production; tests
   * use it to deliver a connection meant for a public test address to a fixture on the loopback
   * interface. It runs after the check and cannot change what the check saw.
   */
  route?: (address: string) => string;
  /** How long a connection may sit without a byte in either direction. */
  timeoutMs?: number;
}

/** A refusal: the request was not sent, so no credential left. */
export class EgressRefusedError extends Error {
  constructor(
    message: string,
    readonly rule: RefusedRule | 'scheme',
  ) {
    super(message);
    this.name = 'EgressRefusedError';
  }
}

/** undici's own header and body timeouts, which is what the `fetch` this replaces waited. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** What `fetch` follows is 20; Confluence behind a proxy needs one or two. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Rule(octets: readonly number[]): RefusedRule | null {
  const [a, b] = octets as [number, number];
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  return null;
}

/** The eight 16-bit words of an IPv6 address, including one written with a dotted IPv4 tail or a zone. */
function ipv6Words(address: string): number[] | null {
  let s = address;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const words = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return words.length === 8 ? words.map((w) => Number.parseInt(w, 16)) : null;
}

function ipv6Rule(w: readonly number[]): RefusedRule | null {
  const zeros = (from: number, to: number): boolean => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return 'unspecified';
  if (zeros(0, 7) && w[7] === 1) return 'loopback';
  // An IPv6 address that carries an IPv4 one is judged as that IPv4 address: mapped (`::ffff:a.b.c.d`),
  // translated (`::ffff:0:a.b.c.d`), the deprecated compatible form (`::a.b.c.d`) and the NAT64
  // well-known prefix (`64:ff9b::a.b.c.d`), each of which a network can deliver to the IPv4 host.
  const carriesIPv4 =
    (zeros(0, 5) && w[5] === 0xffff) ||
    (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) ||
    zeros(0, 6) ||
    (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6));
  if (carriesIPv4) {
    const hi = w[6] as number;
    const lo = w[7] as number;
    return ipv4Rule([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  const first = w[0] as number;
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  if ((first & 0xfe00) === 0xfc00) return 'private';
  // Deprecated site-local (`fec0::/10`): nothing public answers there, and some networks still route it inside.
  if ((first & 0xffc0) === 0xfec0) return 'private';
  return null;
}

/**
 * The rule an address falls under, or `null` for an address a Confluence request may reach. Anything
 * that is not an IP address at all is `unspecified`: this is asked only about addresses, and an answer
 * that cannot be read is not one to connect to.
 */
export function refusedRule(address: string): RefusedRule | null {
  if (net.isIPv4(address)) return ipv4Rule(address.split('.').map(Number));
  const words = ipv6Words(address);
  return words ? ipv6Rule(words) : 'unspecified';
}

/** A host as it is compared: lower case, no trailing dot, an IPv6 literal without its brackets. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

const ARTICLE: Record<RefusedRule, string> = {
  loopback: 'a loopback',
  'link-local': 'a link-local',
  unspecified: 'an unspecified',
  multicast: 'a multicast',
  private: 'a private',
};

/**
 * The refusal as the source's status and Test show it. **An address is named only when it was
 * written as one** — in the base URL or in a redirect's `Location`. When a name resolved to it, the
 * message says which rule the answer fell under and stops there: what an internal name resolves to is
 * not something an editor learns from this product.
 */
function refusal(host: string, rule: RefusedRule, literal: boolean, redirected: boolean): string {
  const verdict = literal ? `is ${rule}` : `resolves to ${ARTICLE[rule]} address`;
  const what = redirected ? `the server redirected to \`${host}\`, which ${verdict}` : `\`${host}\` ${verdict}`;
  const hint = rule === 'private' ? `; list \`${host}\` in CONFLUENCE_ALLOWED_HOSTS to allow it` : '';
  return `refused: ${what}${hint}`;
}

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A `fetch` for Confluence that connects only to addresses ADR-0088 allows.
 *
 * GET only, which is all the Confluence client sends. Redirects are followed here rather than by the
 * platform, up to five, each hop checked again; the credential is dropped on a hop to another origin,
 * as `fetch` does. Connections are kept alive on an agent of this instance's own, so a pooled socket
 * is always one this module's `lookup` opened.
 */
export function confluenceEgress(options: EgressOptions): FetchLike {
  const allowed = new Set(options.allowedHosts.map(normalizeHost));
  const resolve = options.resolve ?? systemResolver;
  const route = options.route ?? ((address: string) => address);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

  const judge = (host: string, address: string): RefusedRule | null => {
    const rule = refusedRule(address);
    return rule === 'private' && allowed.has(host) ? null : rule;
  };

  const send = (url: URL, headers: Record<string, string>, redirected: boolean): Promise<http.IncomingMessage> => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      const where = redirected ? 'the server redirected to' : 'the base URL is';
      return Promise.reject(new EgressRefusedError(`refused: ${where} a \`${url.protocol}\` address; only http and https are allowed`, 'scheme'));
    }
    const host = normalizeHost(url.hostname);
    if (net.isIP(host)) {
      const rule = judge(host, host);
      if (rule) return Promise.reject(new EgressRefusedError(refusal(host, rule, true, redirected), rule));
    }

    const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
      resolve(hostname).then(
        (answers) => {
          if (answers.length === 0) {
            callback(Object.assign(new Error(`${hostname} does not resolve`), { code: 'ENOTFOUND' }), '', 0);
            return;
          }
          // Every answer is judged, not only the one that would be dialled first: with more than one,
          // which one the connection ends up on is the platform's choice, not this check's.
          for (const answer of answers) {
            const rule = judge(host, answer.address);
            if (rule) {
              callback(new EgressRefusedError(refusal(host, rule, false, redirected), rule), '', 0);
              return;
            }
          }
          const dialled = answers
            .map((a) => {
              const address = route(a.address);
              return { address, family: net.isIP(address) || a.family };
            })
            .filter((a) => !lookupOptions.family || lookupOptions.family === a.family);
          const first = dialled[0];
          if (!first) {
            callback(Object.assign(new Error(`${hostname} has no address of the family asked for`), { code: 'ENOTFOUND' }), '', 0);
          } else if (lookupOptions.all) {
            callback(null, dialled);
          } else {
            callback(null, first.address, first.family);
          }
        },
        (err: unknown) => callback(err as NodeJS.ErrnoException, '', 0),
      );
    };

    const secure = url.protocol === 'https:';
    return new Promise((resolveResponse, reject) => {
      const req = (secure ? https : http).request({
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { ...headers, 'accept-encoding': 'gzip' },
        agent: secure ? agents.https : agents.http,
        lookup,
        timeout: timeoutMs,
      });
      req.on('timeout', () => req.destroy(new Error(`Confluence at \`${host}\` did not answer within ${timeoutMs / 1000} s`)));
      req.on('error', (err: NodeJS.ErrnoException) => {
        // A system error's own message names the address it dialled ("connect ECONNREFUSED 10.1.2.3:8090");
        // the code alone says what went wrong without saying where the name led.
        reject(
          err.code && !(err instanceof EgressRefusedError)
            ? new Error(`Could not reach Confluence at \`${host}\`: ${err.code}`, { cause: err })
            : err,
        );
      });
      req.on('response', resolveResponse);
      req.end();
    });
  };

  return async (input, init) => {
    if (init.method !== 'GET') throw new Error(`The Confluence egress sends GET only, not ${init.method}`);
    let url = new URL(input);
    let headers = { ...init.headers };
    for (let hop = 0; ; hop++) {
      const res = await send(url, headers, hop > 0);
      const location = res.headers.location;
      if (!REDIRECT_STATUSES.has(res.statusCode ?? 0) || !location) return toResponse(res);
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new Error(`Confluence redirected more than ${MAX_REDIRECTS} times`);
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
      }
      url = next;
    }
  };
}

/** The Node response as the `Response` the client reads, decompressed if it was gzipped. */
function toResponse(res: http.IncomingMessage): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.destroy();
    throw new Error(`Confluence answered with an invalid status ${status}`);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  if (status === 204 || status === 205 || status === 304) {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers });
  }
  let body: Readable = res;
  const encoding = (res.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    body = pipeline(res, zlib.createGunzip(), () => undefined);
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage, headers });
}
