import { describe, expect, it } from 'vitest';
import { SlidingWindow } from '../src/services/rate-limit.js';

/** A hand-cranked clock, so the window is a pure function of time rather than of the test's speed. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('SlidingWindow', () => {
  it('allows up to the limit and then reports how long to wait', () => {
    const c = clock();
    const window = new SlidingWindow(3, 60_000, c.now);
    expect(window.hit('ip')).toBe(0);
    expect(window.hit('ip')).toBe(0);
    expect(window.hit('ip')).toBe(0);
    expect(window.hit('ip')).toBe(60);
  });

  it('lets the oldest hit age out rather than resetting all at once', () => {
    const c = clock();
    const window = new SlidingWindow(2, 60_000, c.now);
    window.hit('ip');
    c.advance(30_000);
    window.hit('ip');
    expect(window.hit('ip')).toBe(30); // the first hit still has 30 s of the window left
    c.advance(31_000);
    expect(window.hit('ip')).toBe(0); // it has now aged out
  });

  it('counts each key on its own', () => {
    const window = new SlidingWindow(1, 60_000);
    expect(window.hit('a')).toBe(0);
    expect(window.hit('b')).toBe(0);
    expect(window.hit('a')).toBeGreaterThan(0);
  });

  it('clears a key on success and forgets idle ones on a sweep', () => {
    const c = clock();
    const window = new SlidingWindow(1, 60_000, c.now);
    window.hit('ip');
    window.reset('ip');
    expect(window.hit('ip')).toBe(0);

    c.advance(61_000);
    window.sweep();
    expect(window.size).toBe(0);
  });
});
