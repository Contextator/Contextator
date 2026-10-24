import { describe, expect, it } from 'vitest';

import { addressBits, normalizeClientAddress, rateLimitAddressKey } from '../src/services/net-address.js';

/** The one spelling both MCP guards compare addresses in (ADR-0112, ADR-0118). */
describe('normalizeClientAddress', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(normalizeClientAddress('203.0.113.7')).toEqual({ family: 'ipv4', address: '203.0.113.7' });
  });

  it('folds an IPv4-mapped IPv6 address to IPv4, in both spellings', () => {
    expect(normalizeClientAddress('::ffff:10.0.0.5')).toEqual({ family: 'ipv4', address: '10.0.0.5' });
    expect(normalizeClientAddress('::ffff:0a00:0005')).toEqual({ family: 'ipv4', address: '10.0.0.5' });
  });

  it('spells an IPv6 address in full lower-case groups and drops a zone id', () => {
    expect(normalizeClientAddress('2001:DB8::1')).toEqual({ family: 'ipv6', address: '2001:db8:0:0:0:0:0:1' });
    expect(normalizeClientAddress('fe80::1%eth0')).toEqual({ family: 'ipv6', address: 'fe80:0:0:0:0:0:0:1' });
  });

  it('returns null for anything that is not an address', () => {
    for (const value of [undefined, null, '', 'localhost', '10.0.0', '10.0.0.256', '2001:db8::1::2']) {
      expect(normalizeClientAddress(value)).toBeNull();
    }
  });
});

describe('rateLimitAddressKey', () => {
  it('is the IPv4 address itself, mapped or not', () => {
    expect(rateLimitAddressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitAddressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('is the /64 for IPv6, so rotating the interface identifier does not change the bucket', () => {
    const a = rateLimitAddressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = rateLimitAddressKey('2001:db8:1:2::1');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddressKey('2001:db8:1:3::1')).not.toBe(a);
  });

  it('puts everything that is not an address in one shared bucket', () => {
    expect(rateLimitAddressKey(undefined)).toBe('unknown');
    expect(rateLimitAddressKey('not-an-ip')).toBe('unknown');
  });
});

describe('addressBits', () => {
  it('reads an IPv4 address as a 32-bit integer', () => {
    expect(addressBits({ family: 'ipv4', address: '1.2.3.4' })).toBe(0x01020304n);
  });

  it('reads an IPv6 address as a 128-bit integer', () => {
    expect(addressBits({ family: 'ipv6', address: '0:0:0:0:0:0:0:1' })).toBe(1n);
    expect(addressBits({ family: 'ipv6', address: 'ffff:0:0:0:0:0:0:0' })).toBe(0xffffn << 112n);
  });
});
