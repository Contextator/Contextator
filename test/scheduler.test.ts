import { describe, expect, it, vi } from 'vitest';
import { EnvSchema, SYNC_MAX_INTERVAL_MINUTES, SYNC_MIN_INTERVAL_MINUTES } from '../src/config.js';
import type { Logger } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { pastMaxSkipAge, runSyncTick, type SchedulerDeps } from '../src/services/scheduler.js';
import { firstSyncDueAt, PROBE_TOKEN_KEY } from '../src/services/sources.js';

// The probe is the one outbound edge of a tick; here it answers whatever the test put in `probeAnswer`.
const probeAnswer = vi.hoisted(() => ({ token: 'T1' as string | null, calls: 0 }));
vi.mock('../src/services/sources/driver.js', () => ({
  driverFor: () => ({
    probe: async () => {
      probeAnswer.calls++;
      return probeAnswer.token;
    },
  }),
}));

/**
 * The half of [ADR-0048](../.ssot/ADR.md#adr-0048) that is arithmetic rather than a database: where
 * the jitter goes, and what the settings will and will not accept — plus the decisions of one tick
 * against a stand-in database ([ADR-0095](../.ssot/ADR.md#adr-0095)'s age bound and its precedence).
 * The tick's SQL, the hot loop and the two lanes need a real PostgreSQL and live in
 * `test/integration/scheduled-sync.itest.ts`.
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

describe('the max skip age setting', () => {
  it('defaults to a day', () => {
    expect(EnvSchema.parse(env).SYNC_MAX_SKIP_HOURS).toBe(24);
  });

  it('accepts 0, which switches the bound off, and the 30-day ceiling', () => {
    expect(EnvSchema.parse({ ...env, SYNC_MAX_SKIP_HOURS: '0' }).SYNC_MAX_SKIP_HOURS).toBe(0);
    expect(EnvSchema.parse({ ...env, SYNC_MAX_SKIP_HOURS: '720' }).SYNC_MAX_SKIP_HOURS).toBe(720);
  });

  it('refuses a negative value and one past 720', () => {
    expect(EnvSchema.safeParse({ ...env, SYNC_MAX_SKIP_HOURS: '-1' }).success).toBe(false);
    expect(EnvSchema.safeParse({ ...env, SYNC_MAX_SKIP_HOURS: '721' }).success).toBe(false);
  });
});

describe('pastMaxSkipAge', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000);

  it('is past the age only strictly beyond it', () => {
    expect(pastMaxSkipAge(hoursAgo(23), 24, now)).toBe(false);
    expect(pastMaxSkipAge(hoursAgo(24), 24, now)).toBe(false);
    expect(pastMaxSkipAge(hoursAgo(25), 24, now)).toBe(true);
  });

  it('treats a source that never synced as past any age that is switched on', () => {
    expect(pastMaxSkipAge(null, 24, now)).toBe(true);
  });

  it('is never past anything when switched off', () => {
    expect(pastMaxSkipAge(null, 0, now)).toBe(false);
    expect(pastMaxSkipAge(hoursAgo(10_000), 0, now)).toBe(false);
  });
});

/**
 * The tick's max-skip-age branch, against a stand-in for the three statements a tick issues (the due
 * `SELECT`, the `next_sync_at` advance, the webhook-claim take). The SQL itself is exercised against a
 * real PostgreSQL in `test/integration/scheduled-sync.itest.ts`; what is asserted here is the decision.
 */
describe('a due source whose probe token has not moved', () => {
  const STORED = 'T1';

  /**
   * A query builder that answers the select with `rows`, the `next_sync_at` advance with nothing, and the
   * webhook-claim take (the only `.returning()`) with the ids in `claimed`.
   */
  function fakeDb(rows: DocumentSourceRow[], claimed: string[] = []): Db {
    const chain = (result: unknown[]): unknown =>
      new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
            if (prop === 'returning') return () => Promise.resolve(claimed.map((id) => ({ id })));
            return () => chain(result);
          },
        },
      );
    return { select: () => chain(rows), update: () => chain([]) } as unknown as Db;
  }

  const info = vi.fn();
  const log = { info, warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

  function source(lastSyncedAt: Date | null): DocumentSourceRow {
    return {
      id: 'source-1',
      projectId: 'project-1',
      name: 'notion',
      type: 'notion',
      config: { [PROBE_TOKEN_KEY]: STORED },
      lastSyncedAt,
    } as unknown as DocumentSourceRow;
  }

  async function tick(lastSyncedAt: Date | null, maxSkipHours: number, opts: { busy?: boolean; claimed?: boolean } = {}) {
    probeAnswer.token = STORED;
    probeAnswer.calls = 0;
    info.mockClear();
    const enqueued: { projectId: string; trigger: string }[] = [];
    const indexer = {
      isBusy: () => opts.busy === true,
      enqueue: (projectId: string, opts: { trigger: string }) => {
        enqueued.push({ projectId, trigger: opts.trigger });
      },
    } as unknown as SchedulerDeps['indexer'];
    const config = { SYNC_PROBES_PER_TICK: 10, SYNC_MAX_SKIP_HOURS: maxSkipHours } as unknown as SchedulerDeps['config'];
    const result = await runSyncTick({ db: fakeDb([source(lastSyncedAt)], opts.claimed ? ['source-1'] : []), indexer, log, config });
    return { result, enqueued, probes: probeAnswer.calls };
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  it('runs when its last sync is older than SYNC_MAX_SKIP_HOURS, in the scheduled lane, without a probe', async () => {
    const { result, enqueued, probes } = await tick(hoursAgo(25), 24);
    expect(result).toMatchObject({ considered: 1, stale: 1, unchanged: 0, probed: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId: 'project-1', trigger: 'scheduled' }]);
    expect(probes).toBe(0);
  });

  it('is skipped when its last sync is fresh', async () => {
    const { result, enqueued } = await tick(hoursAgo(1), 24);
    expect(result).toMatchObject({ considered: 1, stale: 0, probed: 1, unchanged: 1, enqueued: 0 });
    expect(enqueued).toEqual([]);
  });

  it('runs when it has never synced', async () => {
    const { result, enqueued } = await tick(null, 24);
    expect(result).toMatchObject({ stale: 1, unchanged: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId: 'project-1', trigger: 'scheduled' }]);
  });

  it('is skipped exactly as before when SYNC_MAX_SKIP_HOURS is 0', async () => {
    for (const lastSyncedAt of [hoursAgo(10_000), null]) {
      const { result, enqueued } = await tick(lastSyncedAt, 0);
      expect(result).toMatchObject({ stale: 0, probed: 1, unchanged: 1, enqueued: 0 });
      expect(enqueued).toEqual([]);
    }
  });

  it('says why in the log, with its own message', async () => {
    await tick(hoursAgo(25), 24);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'source-1' }), 'scheduled sync queued a run (max skip age)');
    expect(info).not.toHaveBeenCalledWith(expect.anything(), 'scheduled sync queued a run');
  });

  it('leaves a busy project to the run already in flight, however old the source', async () => {
    const { result, enqueued } = await tick(hoursAgo(25), 24, { busy: true });
    expect(result).toMatchObject({ busy: 1, stale: 0, probed: 0, enqueued: 0 });
    expect(enqueued).toEqual([]);
  });

  it('lets a webhook claim outrank the age, so the run stays in the webhook lane', async () => {
    const { result, enqueued } = await tick(hoursAgo(25), 24, { claimed: true });
    expect(result).toMatchObject({ claimed: 1, stale: 0, probed: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId: 'project-1', trigger: 'webhook' }]);
  });
});
