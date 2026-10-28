import { describe, expect, it } from 'vitest';
import { MetricsRegistry, renderPrometheus, SOURCE_THROTTLE_TYPES } from '../src/services/metrics.js';

/**
 * `contextator_source_throttled_total{source_type}` ([ADR-0126](../.ssot/ADR.md#adr-0126) decision 9): one
 * counter, a closed label set (`s3`, `gdrive`) each exported from start at 0 ([ADR-0105](../.ssot/ADR.md#adr-0105)).
 * The S3 driver's side of it (a `503 SlowDown` is counted per answer, retried or not) is in `s3-driver.test.ts`.
 */

const SNAPSHOT = {
  version: '0.0.0',
  uptimeSeconds: 1,
  embeddingId: 'x',
  embeddingReady: true,
  dbUp: true,
  pool: null,
  queue: { interactive: 0, scheduled: 0, running: 0 },
  lastIndexRun: null,
  searches: { mcp: 0, dashboard: 0 },
  audit: { written: 0, failed: 0 },
};
const lines = (text: string) => text.split('\n').filter((l) => l.startsWith('contextator_source_throttled_total'));

describe('contextator_source_throttled_total', () => {
  it('states every source type of the closed set at 0 before anything has been throttled', () => {
    const registry = new MetricsRegistry();
    expect(lines(renderPrometheus({ ...SNAPSHOT, sourceThrottled: registry.sourceThrottled() }))).toEqual([
      'contextator_source_throttled_total{source_type="s3"} 0',
      'contextator_source_throttled_total{source_type="gdrive"} 0',
    ]);
    expect([...SOURCE_THROTTLE_TYPES]).toEqual(['s3', 'gdrive']);
  });

  it('counts each throttling answer under its own source type and nothing else', () => {
    const registry = new MetricsRegistry();
    registry.countSourceThrottled('s3');
    registry.countSourceThrottled('s3');
    registry.countSourceThrottled('s3');
    registry.countSourceThrottled('gdrive');
    const text = renderPrometheus({ ...SNAPSHOT, sourceThrottled: registry.sourceThrottled() });
    expect(lines(text)).toEqual([
      'contextator_source_throttled_total{source_type="s3"} 3',
      'contextator_source_throttled_total{source_type="gdrive"} 1',
    ]);
    expect(text).toContain('# TYPE contextator_source_throttled_total counter');
  });

  it('hands out a copy, so a caller cannot move the counters', () => {
    const registry = new MetricsRegistry();
    registry.sourceThrottled().s3 = 99;
    expect(registry.sourceThrottled().s3).toBe(0);
  });

  it('is not stated by a snapshot that carries none', () => {
    expect(renderPrometheus(SNAPSHOT)).not.toContain('contextator_source_throttled_total');
  });
});
