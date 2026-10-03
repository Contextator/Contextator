import { describe, expect, it } from 'vitest';

import { Histogram, MetricsRegistry, type MetricsSnapshot, renderPrometheus, SECONDS_BUCKETS } from '../src/services/metrics.js';

/**
 * The histogram helper and the families the registry declares with it. Pure: no database and no
 * server, because the part an external system parses is the text, and the text is a function.
 */

const BASE: MetricsSnapshot = {
  version: '0.3.0-test',
  uptimeSeconds: 1,
  embeddingId: 'local:stub:fp32',
  embeddingReady: true,
  dbUp: true,
  pool: null,
  queue: { interactive: 0, scheduled: 0, running: 0 },
  lastIndexRun: null,
  searches: { mcp: 0, dashboard: 0 },
  audit: { written: 0, failed: 0 },
};

const render = (histograms: MetricsSnapshot['histograms']): string => renderPrometheus({ ...BASE, histograms });

describe('Histogram', () => {
  it('counts cumulatively: an observation lands in every bucket whose bound it does not exceed', () => {
    const h = new Histogram('t_seconds', 'test', [0.1, 1, 10]);
    h.observe(0.05);
    h.observe(0.1); // on the bound: Prometheus buckets are `<=`
    h.observe(2);
    h.observe(50);
    const [series] = h.snapshot().series;
    expect(series.counts).toEqual([2, 2, 3]);
    expect(series.count).toBe(4);
    expect(series.sum).toBeCloseTo(52.15);
  });

  it('keeps one series per label set, in the declared label order', () => {
    const h = new Histogram('t_seconds', 'test', [1], ['phase', 'indexing']);
    h.observe(0.5, { indexing: 'false', phase: 'embed' });
    h.observe(0.5, { phase: 'embed', indexing: 'false' });
    h.observe(0.5, { phase: 'embed', indexing: 'true' });
    const series = h.snapshot().series;
    expect(series).toHaveLength(2);
    expect(Object.keys(series[0].labels)).toEqual(['phase', 'indexing']);
    expect(series[0].count).toBe(2);
  });

  it('drops a value that is not a finite number instead of poisoning _sum', () => {
    const h = new Histogram('t_seconds', 'test');
    h.observe(Number.NaN);
    h.observe(Number.POSITIVE_INFINITY);
    expect(h.snapshot().series).toEqual([]);
  });

  it('refuses buckets that are empty, unordered or not finite, a reserved label and an undeclared one', () => {
    expect(() => new Histogram('a', 'x', [])).toThrow(/at least one/);
    expect(() => new Histogram('a', 'x', [1, 1])).toThrow(/strictly increasing/);
    expect(() => new Histogram('a', 'x', [1, Number.POSITIVE_INFINITY])).toThrow(/finite/);
    expect(() => new Histogram('a', 'x', [1], ['le'])).toThrow(/reserved/);
    expect(() => new Histogram('a', 'x', [1], ['phase']).observe(1, { project: 'p' })).toThrow(/unknown label/);
  });

  it('hands out a snapshot that later observations do not change', () => {
    const h = new Histogram('t_seconds', 'test', [1]);
    h.observe(0.5);
    const snap = h.snapshot();
    h.observe(0.5);
    expect(snap.series[0].count).toBe(1);
  });
});

describe('the histogram exposition', () => {
  it('writes _bucket per bound with le last, then +Inf, _sum and _count', () => {
    const h = new Histogram('t_seconds', 'A test histogram.', [0.5, 1], ['phase']);
    h.observe(0.25, { phase: 'embed' });
    h.observe(0.75, { phase: 'embed' });
    const text = render([h.snapshot()]);
    const block = text.slice(text.indexOf('# HELP t_seconds'));
    expect(block.trimEnd().split('\n')).toEqual([
      '# HELP t_seconds A test histogram.',
      '# TYPE t_seconds histogram',
      't_seconds_bucket{phase="embed",le="0.5"} 1',
      't_seconds_bucket{phase="embed",le="1"} 2',
      't_seconds_bucket{phase="embed",le="+Inf"} 2',
      't_seconds_sum{phase="embed"} 1',
      't_seconds_count{phase="embed"} 2',
    ]);
  });

  it('writes an unlabelled series without empty braces', () => {
    const h = new Histogram('t_size', 'Sizes.', [8]);
    h.observe(3);
    const text = render([h.snapshot()]);
    expect(text).toContain('t_size_bucket{le="8"} 1\n');
    expect(text).toContain('t_size_sum 3\n');
    expect(text).toContain('t_size_count 1\n');
  });

  it('escapes a label value, as the counters do', () => {
    const h = new Histogram('t_seconds', 'x', [1], ['lane']);
    h.observe(0.1, { lane: 'a"b' });
    expect(render([h.snapshot()])).toContain('t_seconds_count{lane="a\\"b"} 1');
  });
});

describe('the registry histograms', () => {
  const NAMES = [
    'contextator_search_duration_seconds',
    'contextator_search_request_duration_seconds',
    'contextator_embedding_batch_duration_seconds',
    'contextator_embedding_batch_size',
    'contextator_index_run_wait_seconds',
  ];

  it('declares every family, observed or not, and each exactly once', () => {
    const text = render(new MetricsRegistry().histograms());
    for (const name of NAMES) {
      expect(text).toContain(`# TYPE ${name} histogram\n`);
    }
    const declared = text.split('\n').filter((line) => line.startsWith('# TYPE'));
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('refuses a second family under a name already registered', () => {
    const metrics = new MetricsRegistry();
    expect(() => metrics.histogram('contextator_search_duration_seconds', 'again')).toThrow(/already registered/);
    const custom = metrics.histogram('contextator_custom_seconds', 'A family another module adds.');
    custom.observe(0.2);
    expect(render(metrics.histograms())).toContain('contextator_custom_seconds_count 1');
  });

  it('observes each phase of a search once, rerank only when it ran, and labels them with the indexing probe', () => {
    const metrics = new MetricsRegistry();
    metrics.observeSearch({ embed: 0.01, retrieve: 0.02, total: 0.04 });
    metrics.watchIndexing(() => true);
    metrics.observeSearch({ embed: 0.01, retrieve: 0.02, rerank: 0.3, total: 0.4 });
    const text = render(metrics.histograms());

    expect(text).toContain('contextator_search_duration_seconds_count{phase="embed",indexing="false"} 1');
    expect(text).toContain('contextator_search_duration_seconds_count{phase="retrieve",indexing="false"} 1');
    expect(text).not.toContain('phase="rerank",indexing="false"');
    expect(text).toContain('contextator_search_duration_seconds_count{phase="rerank",indexing="true"} 1');
    expect(text).toContain('contextator_search_request_duration_seconds_count{indexing="true"} 1');
    expect(text).toContain(`contextator_search_request_duration_seconds_bucket{indexing="false",le="${SECONDS_BUCKETS[0]}"} 0`);
  });

  it('observes embedding batches and queue waits by lane', () => {
    const metrics = new MetricsRegistry();
    metrics.observeEmbeddingBatch(64, 1.2);
    metrics.observeEmbeddingBatch(5, 0.1);
    metrics.observeIndexRunWait('scheduled', 400);
    const text = render(metrics.histograms());
    expect(text).toContain('contextator_embedding_batch_size_bucket{le="64"} 2');
    expect(text).toContain('contextator_embedding_batch_size_bucket{le="4"} 0');
    expect(text).toContain('contextator_embedding_batch_size_sum 69');
    expect(text).toContain('contextator_embedding_batch_duration_seconds_count 2');
    expect(text).toContain('contextator_index_run_wait_seconds_bucket{lane="scheduled",le="300"} 0');
    expect(text).toContain('contextator_index_run_wait_seconds_bucket{lane="scheduled",le="600"} 1');
  });
});
