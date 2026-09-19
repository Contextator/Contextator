import { describe, expect, it } from 'vitest';
import { EnvSchema, SYNC_MAX_INTERVAL_MINUTES, SYNC_MIN_INTERVAL_MINUTES } from '../src/config.js';
import { firstSyncDueAt } from '../src/services/sources.js';

/**
 * The half of [ADR-0048](../.ssot/ADR.md#adr-0048) that is arithmetic rather than a database: where
 * the jitter goes, and what the two settings will and will not accept. The tick itself, the hot loop
 * and the two lanes need a real PostgreSQL and live in `test/integration/scheduled-sync.itest.ts`.
 */

const env = { DATABASE_URL: 'postgres://x/y' };

describe('the first due time of a scheduled source', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const interval = 60;

  it('lands inside the first interval, never beyond it and never in the past', () => {
    for (let i = 0; i < 500; i++) {
      const due = firstSyncDueAt(interval, now).getTime();
      expect(due).toBeGreaterThanOrEqual(now.getTime());
      expect(due).toBeLessThanOrEqual(now.getTime() + interval * 60_000);
    }
  });

  it('spreads a population that was created in the same instant', () => {
    // The thundering herd this exists against: a hundred sources written by one import script. With
    // the jitter at the *write*, they land on different minutes and — because every later advance
    // adds a whole interval — they stay on different minutes for as long as the rows live.
    const minutes = new Set<number>();
    for (let i = 0; i < 100; i++) minutes.add(Math.floor((firstSyncDueAt(interval, now).getTime() - now.getTime()) / 60_000));
    // 100 draws over 60 buckets: the chance of fewer than 20 distinct buckets is far past vanishing,
    // and a rewrite that dropped the randomness would produce exactly one.
    expect(minutes.size).toBeGreaterThan(20);
  });

  it('is a fraction of the interval it was given, not a fixed offset', () => {
    const short = Array.from({ length: 200 }, () => firstSyncDueAt(SYNC_MIN_INTERVAL_MINUTES, now).getTime() - now.getTime());
    expect(Math.max(...short)).toBeLessThanOrEqual(SYNC_MIN_INTERVAL_MINUTES * 60_000);
  });
});

describe('the scheduler settings', () => {
  it('defaults to an hour for new sources and ten probes a tick', () => {
    const config = EnvSchema.parse(env);
    expect(config.SYNC_DEFAULT_INTERVAL_MINUTES).toBe(60);
    expect(config.SYNC_PROBES_PER_TICK).toBe(10);
  });

  it('accepts 0 as "create new sources unscheduled", which is how an instance opts out', () => {
    expect(EnvSchema.parse({ ...env, SYNC_DEFAULT_INTERVAL_MINUTES: '0' }).SYNC_DEFAULT_INTERVAL_MINUTES).toBe(0);
  });

  it('refuses a default the API would then refuse on the source it created', () => {
    // Anything between 1 and the floor would mint sources the dashboard cannot save back.
    const result = EnvSchema.safeParse({ ...env, SYNC_DEFAULT_INTERVAL_MINUTES: '3' });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0].message).toContain(String(SYNC_MIN_INTERVAL_MINUTES));
  });

  it('refuses an interval past the ceiling, so that "off" stays expressible only as off', () => {
    expect(EnvSchema.safeParse({ ...env, SYNC_DEFAULT_INTERVAL_MINUTES: String(SYNC_MAX_INTERVAL_MINUTES + 1) }).success).toBe(false);
  });
});
