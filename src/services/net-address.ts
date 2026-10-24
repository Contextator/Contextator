import net from 'node:net';

/** A client address as the MCP guards compare it: the family `net.BlockList` wants and the canonical text. */
export interface ClientAddress {
  family: 'ipv4' | 'ipv6';
  address: string;
}

/** The eight 16-bit groups of an IPv6 address, or `null` when `text` is not one. An embedded IPv4 tail is two groups. */
function ipv6Groups(text: string): number[] | null {
  if (!net.isIPv6(text)) return null;
  let head = text;
  const lastColon = head.lastIndexOf(':');
  const tail = head.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    head = `${head.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [left, right, ...extra] = head.split('::');
  if (extra.length > 0) return null;
  const leftGroups = left === '' ? [] : left.split(':');
  const rightGroups = right === undefined || right === '' ? [] : right.split(':');
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (right === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...leftGroups, ...Array<string>(right === undefined ? 0 : missing).fill('0'), ...rightGroups].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The address a request came from, in the one spelling both guards compare ([ADR-0112](../../.ssot/ADR.md#adr-0112),
 * [ADR-0118](../../.ssot/ADR.md#adr-0118)). An IPv4-mapped IPv6 address (`::ffff:10.0.0.5`, which a dual-stack
 * socket reports for an IPv4 client) is folded to IPv4, because the same client must not be a different
 * address to the allowlist and to the limiter depending on how the listener was bound. A zone id
 * (`fe80::1%eth0`) is dropped. Returns `null` for anything that is not an IP address.
 */
export function normalizeClientAddress(raw: string | undefined | null): ClientAddress | null {
  if (!raw) return null;
  const text = raw.split('%', 1)[0].toLowerCase();
  if (net.isIPv4(text)) return { family: 'ipv4', address: text };
  const groups = ipv6Groups(text);
  if (!groups) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    return { family: 'ipv4', address: `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}` };
  }
  return { family: 'ipv6', address: groups.map((g) => g.toString(16)).join(':') };
}

/**
 * The bucket an address belongs to in the anonymous rate limit: the IPv4 address itself, or an IPv6
 * address's /64. A single subscriber is handed a /64 (or larger), so counting the full address would let
 * one machine choose its own bucket by rotating the interface identifier, which is a free choice.
 * Anything that is not an address becomes `unknown`, one shared bucket, rather than a way around the limit.
 */
export function rateLimitAddressKey(raw: string | undefined | null): string {
  const client = normalizeClientAddress(raw);
  if (!client) return 'unknown';
  if (client.family === 'ipv4') return client.address;
  return `${client.address.split(':').slice(0, 4).join(':')}::/64`;
}

/** The address as one unsigned integer (32 or 128 bits), for the prefix arithmetic of a CIDR check. */
export function addressBits(client: ClientAddress): bigint {
  if (client.family === 'ipv4') return client.address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
  return client.address.split(':').reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}
