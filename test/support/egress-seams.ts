/**
 * How a test reaches a fixture on 127.0.0.1 **through** the Confluence egress guard rather than around it.
 *
 * The guard refuses loopback, so a fixture server on the loopback interface cannot be named by its own
 * address. Instead a test names it by a made-up host, `resolve` answers that host with an address from a
 * documentation range, and only after the guard has judged that address does `route` dial the loopback
 * interface in its place. The check sees exactly what it would see in production; the socket just lands
 * somewhere a test can listen.
 *
 * `203.0.113.0/24` (TEST-NET-3) is public as far as the classifier is concerned and routes nowhere.
 */

import type { EgressOptions, Resolver } from '../../src/services/sources/confluence-egress.js';

/** A stand-in public address; nothing answers on it, `route` sends it to the fixture instead. */
export const PUBLIC_FIXTURE_ADDRESS = '203.0.113.7';

/** A resolver that knows only the names it is given, and fails the way DNS does for everything else. */
export function fakeResolver(names: Record<string, string>): Resolver {
  return async (hostname) => {
    const address = names[hostname.toLowerCase()];
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  };
}

/** Dials the loopback interface for the addresses listed, and anything else as itself. */
export function routeToLoopback(...addresses: string[]): (address: string) => string {
  return (address) => (addresses.includes(address) ? '127.0.0.1' : address);
}

/** The seams for one fixture reached as `host`, which resolves to a public-looking address. */
export function publicFixture(host: string): Pick<EgressOptions, 'resolve' | 'route'> {
  return { resolve: fakeResolver({ [host]: PUBLIC_FIXTURE_ADDRESS }), route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS) };
}

/** A fixture URL with its `127.0.0.1` host replaced by `host`, port and path kept. */
export function renamed(url: string, host: string): string {
  const u = new URL(url);
  u.hostname = host;
  return u.href.replace(/\/$/, url.endsWith('/') ? '/' : '');
}
