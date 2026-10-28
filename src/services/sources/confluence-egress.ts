import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';

import type { FetchLike } from './confluence-client.js';

/**
 * The only way a Confluence or web-source request leaves this process
 * ([ADR-0088](../../../.ssot/ADR.md#adr-0088), [ADR-0107](../../../.ssot/ADR.md#adr-0107)).
 *
 * A Confluence base URL or a web source's entry URL is typed by an editor and the server connects to
 * it, so without a bound it is a way to read the instance's loopback services, the cloud metadata
 * address or the internal network through a source's status and Test message. {@link egressFetch} is
 * the rule itself; {@link sourceEgress} is it for a host an operator names and an API answers on
 * (`SOURCE_ALLOWED_HOSTS`, [ADR-0126](../../../.ssot/ADR.md#adr-0126)), {@link confluenceEgress} is that with
 * Confluence's wording, and `webEgress` and `gitEgress` have their own allowlists (`WEB_ALLOWED_HOSTS`,
 * `GIT_ALLOWED_HOSTS`).
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
export type RefusedRule = 'loopback' | 'link-local' | 'unspecified' | 'multicast' | 'private' | 'reserved';

/** DNS as this module needs it. Production uses `dns.lookup`, so `/etc/hosts` and the system resolver apply. */
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface EgressOptions {
  /**
   * `SOURCE_ALLOWED_HOSTS` (with `CONFLUENCE_ALLOWED_HOSTS` for Confluence), `WEB_ALLOWED_HOSTS` or
   * `GIT_ALLOWED_HOSTS`: host names allowed to resolve to a **private**
   * address. It never lifts loopback, link-local, unspecified, multicast or reserved.
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
  /** How long a kept-alive connection waits in the pool for its next request before it is closed. */
  idleMs?: number;
  /**
   * Who is being reached, as errors name it. `Confluence` through {@link confluenceEgress}; another
   * caller of the same rule (the client ID metadata document fetch,
   * [ADR-0088](../../../.ssot/ADR.md#adr-0088); the web source) names itself.
   */
  label?: string;
  /**
   * The setting a private-address refusal points at, or `null` when there is none to point at.
   * `SOURCE_ALLOWED_HOSTS` through {@link sourceEgress} and {@link confluenceEgress}.
   */
  allowListName?: string | null;
  /**
   * What the first URL is called in a scheme refusal: "refused: <subject> a `ftp:` address". The
   * Confluence source types a base URL; a web source types an entry URL, and a redirect says
   * "the server redirected to" either way.
   */
  subject?: string;
  /** Refuse plain `http`, on the first request and on every redirect. Off by default. */
  httpsOnly?: boolean;
  /**
   * Methods this egress sends. `['GET']` unless stated: Confluence and the web source only read. The git
   * source adds `POST`, which smart HTTP uses for `git-upload-pack`
   * ([ADR-0107](../../../.ssot/ADR.md#adr-0107)).
   */
  methods?: readonly ('GET' | 'POST')[];
}

/**
 * The egress as a {@link FetchLike} that also takes a `signal`: aborting it destroys whatever is open
 * — the request in flight or the response being read — so a caller's deadline closes the socket rather
 * than only giving up on the promise. Assignable wherever a `FetchLike` is expected.
 */
export type EgressFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** Only with `POST`, and only when {@link EgressOptions.methods} lists it. Held whole so a 307/308 can send it again. */
    body?: Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<Response>;

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
/**
 * undici's keep-alive timeout, which is how long the `fetch` this replaces kept an idle connection.
 * Without one a pooled socket stays open until the server closes it, and every egress instance —
 * the scheduler builds one per probe — would hold its own until then.
 */
const DEFAULT_IDLE_MS = 4_000;
/** What `fetch` follows is 20; Confluence behind a proxy needs one or two. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Rule(octets: readonly number[]): RefusedRule | null {
  const [a, b] = octets as [number, number];
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  // 240.0.0.0/4 — the former class E and the limited broadcast address (255.255.255.255) — is
  // reserved: nothing public answers there, and the allowlist cannot open it ([ADR-0107](../../../.ssot/ADR.md#adr-0107)).
  if (a >= 240) return 'reserved';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  // Shared address space for carrier-grade NAT (100.64.0.0/10) and the benchmarking range (198.18.0.0/15)
  // are internal networks in practice, so they fall under the same rule as RFC 1918.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
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
  reserved: 'a reserved',
};

/**
 * The refusal as the source's status and Test show it. **An address is named only when it was
 * written as one** — in the base URL or in a redirect's `Location`. When a name resolved to it, the
 * message says which rule the answer fell under and stops there: what an internal name resolves to is
 * not something an editor learns from this product.
 */
function refusal(host: string, rule: RefusedRule, literal: boolean, redirected: boolean, allowListName: string | null): string {
  const verdict = literal ? `is ${rule}` : `resolves to ${ARTICLE[rule]} address`;
  const what = redirected ? `the server redirected to \`${host}\`, which ${verdict}` : `\`${host}\` ${verdict}`;
  const hint = rule === 'private' && allowListName ? `; list \`${host}\` in ${allowListName} to allow it` : '';
  return `refused: ${what}${hint}`;
}

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * The hosts a Confluence source may reach on a private address: `SOURCE_ALLOWED_HOSTS` and the deprecated
 * `CONFLUENCE_ALLOWED_HOSTS`, joined ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 7). The old list
 * admits its hosts for Confluence only, which is why this union is taken here and not in the config:
 * an `s3` or `github` source reads {@link SourceHostsConfig.SOURCE_ALLOWED_HOSTS} alone.
 */
export function confluenceAllowedHosts(config: SourceHostsConfig): string[] {
  return [...(config.SOURCE_ALLOWED_HOSTS ?? []), ...(config.CONFLUENCE_ALLOWED_HOSTS ?? [])];
}

/** The slice of `Config` that names egress hosts; every key is optional so a context built for another driver need not carry it. */
export interface SourceHostsConfig {
  SOURCE_ALLOWED_HOSTS?: readonly string[];
  CONFLUENCE_ALLOWED_HOSTS?: readonly string[];
}

/**
 * A `fetch` for a source whose host an operator names and which calls an API (`s3`, the GitHub
 * Enterprise Server host of `github`): {@link egressFetch} with the shared allowlist,
 * `SOURCE_ALLOWED_HOSTS` ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 7). A refusal names it.
 * `label` and `subject` default to wording that fits any such source; a driver passes its own
 * (`label: 'The S3 endpoint'`, `subject: 'the endpoint'`) so that an editor reads what was refused.
 */
export function sourceEgress(options: EgressOptions): EgressFetch {
  return egressFetch({ label: 'the host', allowListName: 'SOURCE_ALLOWED_HOSTS', subject: 'the URL', ...options });
}

/**
 * A `fetch` for Confluence that connects only to addresses ADR-0088 allows: {@link sourceEgress} with
 * Confluence's name and its "base URL" wording. A refusal names `SOURCE_ALLOWED_HOSTS`; pass
 * {@link confluenceAllowedHosts} as `allowedHosts` so the deprecated list keeps working.
 */
export function confluenceEgress(options: EgressOptions): EgressFetch {
  return sourceEgress({ label: 'Confluence', subject: 'the base URL', ...options });
}

/**
 * A `fetch` for a web source that connects only to addresses ADR-0088 and ADR-0107 allow: the pages,
 * `robots.txt`, the sitemap and `llms.txt` all go through it. A refusal names `WEB_ALLOWED_HOSTS`.
 */
export function webEgress(options: EgressOptions): EgressFetch {
  return egressFetch({ label: 'the site', allowListName: 'WEB_ALLOWED_HOSTS', subject: 'the URL', ...options });
}

/**
 * A `fetch` for a git source that connects only to addresses ADR-0088 and ADR-0107 allow: every
 * request isomorphic-git makes (`info/refs`, `git-upload-pack`, each redirect hop) goes through it.
 * A refusal names `GIT_ALLOWED_HOSTS`. Smart HTTP posts its `want`/`have` lines, so `POST` is on.
 */
export function gitEgress(options: EgressOptions): EgressFetch {
  return egressFetch({
    label: 'the git remote',
    allowListName: 'GIT_ALLOWED_HOSTS',
    subject: 'the remote URL',
    methods: ['GET', 'POST'],
    ...options,
  });
}

/**
 * A `fetch` that connects only to addresses ADR-0088 allows.
 *
 * GET only unless {@link EgressOptions.methods} says otherwise, which is all Confluence and the web source send. Redirects are followed here rather than by the
 * platform, up to five, each hop checked again; the credential is dropped on a hop to another origin,
 * as `fetch` does. The `Response` it returns carries the URL it finally came from in `url` and
 * `redirected`, which the platform's own `Response` would hold but one built by hand does not.
 * Connections are kept alive on an agent of this instance's own, so a pooled socket is always one this
 * module's `lookup` opened, and closed after `idleMs` without a request, so an instance nobody calls
 * again lets go of its sockets and is collected.
 */
export function egressFetch(options: EgressOptions): EgressFetch {
  const allowed = new Set(options.allowedHosts.map(normalizeHost));
  const resolve = options.resolve ?? systemResolver;
  const route = options.route ?? ((address: string) => address);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? 'Confluence';
  const subject = options.subject ?? 'the base URL';
  const allowListName = options.allowListName === undefined ? 'SOURCE_ALLOWED_HOSTS' : options.allowListName;
  // The agent's `timeout` is what a socket gets while it waits in the pool; a request in flight
  // runs on its own `timeout` below, which Node sets on the socket when it hands it to the request.
  const pool = { keepAlive: true, timeout: options.idleMs ?? DEFAULT_IDLE_MS };
  const agents = { http: new http.Agent(pool), https: new https.Agent(pool) };

  const judge = (host: string, address: string): RefusedRule | null => {
    const rule = refusedRule(address);
    return rule === 'private' && allowed.has(host) ? null : rule;
  };

  const methods = new Set<string>(options.methods ?? ['GET']);

  const send = (
    url: URL,
    method: string,
    body: Uint8Array | undefined,
    headers: Record<string, string>,
    redirected: boolean,
    opened: (req: http.ClientRequest) => void,
  ): Promise<http.IncomingMessage> => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      const where = redirected ? 'the server redirected to' : `${subject} is`;
      return Promise.reject(new EgressRefusedError(`refused: ${where} a \`${url.protocol}\` address; only http and https are allowed`, 'scheme'));
    }
    if (options.httpsOnly && url.protocol !== 'https:') {
      const where = redirected ? 'the server redirected to' : 'the URL is';
      return Promise.reject(new EgressRefusedError(`refused: ${where} a \`${url.protocol}\` address; only https is allowed`, 'scheme'));
    }
    const host = normalizeHost(url.hostname);
    if (net.isIP(host)) {
      const rule = judge(host, host);
      if (rule) return Promise.reject(new EgressRefusedError(refusal(host, rule, true, redirected, allowListName), rule));
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
              callback(new EgressRefusedError(refusal(host, rule, false, redirected, allowListName), rule), '', 0);
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
        method,
        headers: { ...headers, 'accept-encoding': 'gzip', ...(body ? { 'content-length': String(body.byteLength) } : {}) },
        agent: secure ? agents.https : agents.http,
        lookup,
        timeout: timeoutMs,
      });
      req.on('timeout', () => req.destroy(new Error(`${capitalised(label)} at \`${host}\` did not answer within ${timeoutMs / 1000} s`)));
      req.on('error', (err: NodeJS.ErrnoException) => {
        // A system error's own message names the address it dialled ("connect ECONNREFUSED 10.1.2.3:8090");
        // the code alone says what went wrong without saying where the name led.
        reject(
          err.code && !(err instanceof EgressRefusedError) ? new Error(`Could not reach ${label} at \`${host}\`: ${err.code}`, { cause: err }) : err,
        );
      });
      req.on('response', resolveResponse);
      opened(req);
      req.end(body);
    });
  };

  return async (input, init) => {
    if (!methods.has(init.method)) {
      throw new Error(`The ${label.replace(/^the /, '')} egress sends ${[...methods].join(' and ')} only, not ${init.method}`);
    }
    const { signal } = init;
    signal?.throwIfAborted();
    // Whatever is open right now — the request until it answers, then its response — is what an abort
    // destroys, together with its socket, so nothing outlives the caller's deadline.
    let open: { destroy(error?: Error): unknown } | undefined;
    const onAbort = () => open?.destroy(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const release = () => signal?.removeEventListener('abort', onAbort);
    try {
      let url = new URL(input);
      let headers = { ...init.headers };
      let method = init.method;
      let body = method === 'POST' ? init.body : undefined;
      for (let hop = 0; ; hop++) {
        const res = await send(url, method, body, headers, hop > 0, (req) => {
          open = req;
        });
        open = res;
        signal?.throwIfAborted();
        const location = res.headers.location;
        if (!REDIRECT_STATUSES.has(res.statusCode ?? 0) || !location) {
          const response = toResponse(res, label);
          // A `Response` built by hand has an empty `url` and is never `redirected`; the client reads
          // both to resolve relative links against where the page really came from.
          Object.defineProperty(response, 'url', { value: url.href, configurable: true });
          if (hop > 0) Object.defineProperty(response, 'redirected', { value: true, configurable: true });
          if (signal) {
            if (res.closed) release();
            else res.once('close', release);
          }
          return response;
        }
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new Error(`${capitalised(label)} redirected more than ${MAX_REDIRECTS} times`);
        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
        }
        // As `fetch` does: 301/302/303 turn a POST into a GET without its body; 307/308 send it again.
        if (method === 'POST' && ![307, 308].includes(res.statusCode ?? 0)) {
          method = 'GET';
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !['content-type', 'content-length'].includes(name.toLowerCase())));
        }
        url = next;
      }
    } catch (err) {
      release();
      open?.destroy();
      throw err;
    }
  };
}

/** Why `signal` was aborted, as an `Error` a rejected request carries. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('The request was aborted');
}

/** A label that starts a sentence: "the site" -> "The site"; "Confluence" is unchanged. */
function capitalised(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The Node response as the `Response` the client reads, decompressed if it was gzipped. */
function toResponse(res: http.IncomingMessage, label: string): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.destroy();
    throw new Error(`${capitalised(label)} answered with an invalid status ${status}`);
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
  } else if (encoding !== '' && encoding !== 'identity') {
    // Only gzip was asked for, so anything else is a server ignoring `Accept-Encoding`. Passing the bytes
    // on with the header in place would index compressed noise as text; say what happened instead.
    res.destroy();
    throw new Error(`${capitalised(label)} answered with content-encoding \`${encoding}\`, which this instance does not decode`);
  }
  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage, headers });
}
