import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_CIDRS,
  describeNetworks,
  parseNetworkList,
  // @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
} from '../public/mcp.js';

/**
 * **An allowlist the panel sends is the list the person typed.** The textarea becomes the
 * `allowedCidrs` array the routes take; an empty box is `null` (no restriction), and whether an entry is
 * a real range is the server's to judge (ADR-0118).
 */

describe('parseNetworkList', () => {
  it('reads one range per line, and accepts commas and spaces too', () => {
    expect(parseNetworkList('10.0.0.0/8\n203.0.113.7/32')).toEqual({ ok: true, value: ['10.0.0.0/8', '203.0.113.7/32'] });
    expect(parseNetworkList('10.0.0.0/8, 192.168.1.0/24  2001:db8::/32')).toEqual({
      ok: true,
      value: ['10.0.0.0/8', '192.168.1.0/24', '2001:db8::/32'],
    });
  });

  it('treats an empty box as no restriction', () => {
    expect(parseNetworkList('')).toEqual({ ok: true, value: null });
    expect(parseNetworkList(' \n , \n')).toEqual({ ok: true, value: null });
    expect(parseNetworkList(null)).toEqual({ ok: true, value: null });
  });

  it('drops repeats', () => {
    expect(parseNetworkList('10.0.0.1\n10.0.0.1\n10.0.0.2')).toEqual({ ok: true, value: ['10.0.0.1', '10.0.0.2'] });
  });

  it('refuses more ranges than the route takes, before sending', () => {
    const many = Array.from({ length: MAX_ALLOWED_CIDRS + 1 }, (_, i) => `10.0.0.${i}`).join('\n');
    const result = parseNetworkList(many);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(String(MAX_ALLOWED_CIDRS));
  });
});

describe('describeNetworks', () => {
  it('says plainly when a token works from anywhere', () => {
    expect(describeNetworks({ allowedCidrs: [] })).toEqual({ restricted: false, text: 'works from any address' });
    expect(describeNetworks({ allowedCidrs: null })).toEqual({ restricted: false, text: 'works from any address' });
    expect(describeNetworks({})).toEqual({ restricted: false, text: 'works from any address' });
  });

  it('names the ranges, and counts the rest when there are many', () => {
    expect(describeNetworks({ allowedCidrs: ['10.0.0.0/8'] })).toEqual({ restricted: true, text: 'only from 10.0.0.0/8' });
    expect(describeNetworks({ allowedCidrs: ['a', 'b', 'c', 'd'] }).text).toBe('only from a, b +2 more');
  });
});
