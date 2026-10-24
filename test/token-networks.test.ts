import { describe, expect, it } from 'vitest';

import { InvalidNetworkListError, isAddressAllowed, MAX_ALLOWED_CIDRS, parseAllowedCidrs } from '../src/services/token-networks.js';

/** What a static MCP token's network allowlist accepts, stores and matches (ADR-0118). */
describe('parseAllowedCidrs', () => {
  it('treats null, undefined and an empty list as no restriction', () => {
    expect(parseAllowedCidrs(null)).toBeNull();
    expect(parseAllowedCidrs(undefined)).toBeNull();
    expect(parseAllowedCidrs([])).toBeNull();
  });

  it('turns a bare address into a host route and keeps a block as written', () => {
    expect(parseAllowedCidrs(['203.0.113.7', '10.0.0.0/8', '2001:db8::1', '2001:db8::/32'])).toEqual([
      '203.0.113.7/32',
      '10.0.0.0/8',
      '2001:db8:0:0:0:0:0:1/128',
      '2001:db8:0:0:0:0:0:0/32',
    ]);
  });

  it('drops duplicates and trims whitespace', () => {
    expect(parseAllowedCidrs([' 10.0.0.1 ', '10.0.0.1/32'])).toEqual(['10.0.0.1/32']);
  });

  it('refuses /0 in both families', () => {
    expect(() => parseAllowedCidrs(['0.0.0.0/0'])).toThrow(InvalidNetworkListError);
    expect(() => parseAllowedCidrs(['::/0'])).toThrow(/\/0/);
  });

  it('refuses host bits that a prefix would silently widen', () => {
    expect(() => parseAllowedCidrs(['10.1.2.3/8'])).toThrow(/host bits/);
  });

  it('refuses entries that are not addresses or prefixes', () => {
    for (const bad of ['example.com', '10.0.0.0/33', '10.0.0.0/abc', '10.0.0.0/8/8', '::1/129', '', 'fe80::1%eth0']) {
      expect(() => parseAllowedCidrs([bad])).toThrow(InvalidNetworkListError);
    }
  });

  it('refuses an IPv4-mapped IPv6 entry, which no folded request could match', () => {
    expect(() => parseAllowedCidrs(['::ffff:10.0.0.5'])).toThrow(/IPv4-mapped/);
  });

  it('accepts exactly the maximum and refuses one more', () => {
    const entry = (i: number) => `10.0.${i}.0/24`;
    expect(parseAllowedCidrs(Array.from({ length: MAX_ALLOWED_CIDRS }, (_, i) => entry(i)))).toHaveLength(MAX_ALLOWED_CIDRS);
    expect(() => parseAllowedCidrs(Array.from({ length: MAX_ALLOWED_CIDRS + 1 }, (_, i) => entry(i)))).toThrow(/At most/);
  });

  it('does not put the entries it refuses into anything but the message for that entry', () => {
    expect(() => parseAllowedCidrs(['10.0.0.0/8', 'nope'])).toThrow('"nope" is not an IP address or a CIDR block.');
  });
});

describe('isAddressAllowed', () => {
  const list = ['10.0.0.0/8', '203.0.113.7/32', '2001:db8:0:0:0:0:0:0/32'];

  it('matches an address inside a block and a host route', () => {
    expect(isAddressAllowed(list, '10.20.30.40')).toBe(true);
    expect(isAddressAllowed(list, '203.0.113.7')).toBe(true);
    expect(isAddressAllowed(list, '2001:db8:ffff::5')).toBe(true);
  });

  it('refuses an address outside every block', () => {
    expect(isAddressAllowed(list, '203.0.113.8')).toBe(false);
    expect(isAddressAllowed(list, '2001:db9::1')).toBe(false);
    expect(isAddressAllowed(list, '11.0.0.1')).toBe(false);
  });

  it('compares an IPv4-mapped client address as IPv4', () => {
    expect(isAddressAllowed(list, '::ffff:10.1.1.1')).toBe(true);
    expect(isAddressAllowed(list, '::ffff:192.0.2.1')).toBe(false);
  });

  it('refuses what is not an address', () => {
    expect(isAddressAllowed(list, undefined)).toBe(false);
    expect(isAddressAllowed(list, 'garbage')).toBe(false);
  });
});
