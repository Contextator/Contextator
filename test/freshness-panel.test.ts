import { describe, expect, it } from 'vitest';
import {
  MANUAL_STALE_DAYS,
  sourceFreshness,
  // @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
} from '../public/freshness.js';

/**
 * **A source is "current" only against its own schedule.** The panel reads the admin API's
 * `lastSyncedAt` and `syncIntervalMinutes`; it never reads a metric (ADR-0119, decision 7).
 */

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('sourceFreshness', () => {
  it('flags a source that never synced, scheduled or not', () => {
    expect(sourceFreshness({ lastSyncedAt: null, syncIntervalMinutes: 60 }, NOW)).toMatchObject({ tone: 'warn', label: 'never synced' });
    expect(sourceFreshness({ lastSyncedAt: null, syncIntervalMinutes: null }, NOW)).toMatchObject({ tone: 'warn', label: 'never synced' });
  });

  it('calls a scheduled source current until it has missed two intervals', () => {
    expect(sourceFreshness({ lastSyncedAt: ago(90), syncIntervalMinutes: 60 }, NOW)).toMatchObject({ tone: 'ok', label: 'current' });
    expect(sourceFreshness({ lastSyncedAt: ago(121), syncIntervalMinutes: 60 }, NOW)).toMatchObject({ tone: 'warn', label: 'overdue' });
  });

  it('names the schedule and the age in the tooltip', () => {
    const { title } = sourceFreshness({ lastSyncedAt: ago(300), syncIntervalMinutes: 60 }, NOW);
    expect(title).toContain('every 1 h');
    expect(title).toContain('5 h ago');
  });

  it('leaves a manual source alone until it is a month old', () => {
    expect(sourceFreshness({ lastSyncedAt: ago(60 * 24 * 3), syncIntervalMinutes: null }, NOW)).toMatchObject({ tone: 'muted', label: 'manual' });
    expect(sourceFreshness({ lastSyncedAt: ago(60 * 24 * (MANUAL_STALE_DAYS + 1)), syncIntervalMinutes: null }, NOW)).toMatchObject({
      tone: 'warn',
      label: 'not refreshed',
    });
  });

  it('treats a missing interval field like a manual source', () => {
    expect(sourceFreshness({ lastSyncedAt: ago(10) }, NOW).label).toBe('manual');
  });
});
