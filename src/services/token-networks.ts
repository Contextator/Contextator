import net from 'node:net';
import { addressBits, normalizeClientAddress } from './net-address.js';
import { ValidationError } from './projects.js';

/**
 * The network allowlist of a static MCP token ([ADR-0118](../../.ssot/ADR.md#adr-0118)): which client
 * addresses may present it. Stored as `mcp_tokens.allowed_cidrs cidr[]`; `NULL` means unrestricted.
 *
 * Validation happens here, before the database, so a bad entry is a 400 the operator can read and not
 * a Postgres error; the column's own `cidr` type is the second line and refuses what slips through.
 */

/** The most entries one token may carry. A longer list is a network policy that belongs in front of the server. */
export const MAX_ALLOWED_CIDRS = 32;

/**
 * A list the operator sent that cannot be stored; the message says which entry and why, and is safe to
 * show. A `ValidationError`, so the admin API answers it `400 invalid_request` like every other refusal.
 */
export class InvalidNetworkListError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNetworkListError';
  }
}

const bitsOf = (family: 'ipv4' | 'ipv6'): number => (family === 'ipv4' ? 32 : 128);

/**
 * Turns what an operator typed into what is stored: one explicit `address/prefix` per entry.
 *
 * - A bare address becomes `/32` or `/128`.
 * - `/0` is refused: it allows the whole internet and would read as a restriction, which is worse than
 *   leaving the list empty.
 * - Host bits must be zero (`10.1.2.3/8` is refused rather than silently widened to `10.0.0.0/8`).
 * - An IPv4-mapped IPv6 entry is refused: requests are folded to IPv4 before they are compared, so such
 *   an entry could never match; the IPv4 spelling is the one that works.
 * - `null`, `undefined` and an empty list all mean "no restriction" and come back as `null`.
 */
export function parseAllowedCidrs(input: readonly string[] | null | undefined): string[] | null {
  if (!input || input.length === 0) return null;
  if (input.length > MAX_ALLOWED_CIDRS) throw new InvalidNetworkListError(`At most ${MAX_ALLOWED_CIDRS} networks may be listed for one token.`);

  const out = new Set<string>();
  for (const entry of input) {
    const text = entry.trim();
    const [addressText, prefixText, ...extra] = text.split('/');
    const client = extra.length === 0 && !addressText.includes('%') ? normalizeClientAddress(addressText) : null;
    if (!client || !net.isIP(addressText)) throw new InvalidNetworkListError(`"${text}" is not an IP address or a CIDR block.`);
    if (client.family === 'ipv4' && addressText.includes(':')) {
      throw new InvalidNetworkListError(`"${text}" is an IPv4-mapped IPv6 address; write the IPv4 address instead.`);
    }
    const width = bitsOf(client.family);
    let prefix = width;
    if (prefixText !== undefined) {
      if (!/^\d{1,3}$/.test(prefixText)) throw new InvalidNetworkListError(`"${text}" has an invalid prefix length.`);
      prefix = Number(prefixText);
      if (prefix > width) throw new InvalidNetworkListError(`"${text}" has a prefix length longer than the address.`);
    }
    if (prefix === 0)
      throw new InvalidNetworkListError('A /0 network allows every address and is not accepted; leave the list empty to remove the restriction.');
    const hostMask = (1n << BigInt(width - prefix)) - 1n;
    if ((addressBits(client) & hostMask) !== 0n) {
      throw new InvalidNetworkListError(`"${text}" has host bits set; use the network address of the block.`);
    }
    out.add(`${client.address}/${prefix}`);
  }
  if (out.size > MAX_ALLOWED_CIDRS) throw new InvalidNetworkListError(`At most ${MAX_ALLOWED_CIDRS} networks may be listed for one token.`);
  return [...out];
}

/**
 * Whether `rawAddress` (a `req.ip`) falls inside one of the stored blocks. An address that is not an IP
 * at all is outside every block. Built per call on purpose: the list is at most 32 entries and a cache
 * would have to learn when a PATCH changed it.
 */
export function isAddressAllowed(cidrs: readonly string[], rawAddress: string | undefined | null): boolean {
  const client = normalizeClientAddress(rawAddress);
  if (!client) return false;
  const list = new net.BlockList();
  for (const entry of cidrs) {
    const [address, prefix] = entry.split('/');
    const parsed = normalizeClientAddress(address);
    if (!parsed || prefix === undefined) continue;
    list.addSubnet(parsed.address, Number(prefix), parsed.family);
  }
  return list.check(client.address, client.family);
}
