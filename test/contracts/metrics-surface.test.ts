import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetricsRegistry, type MetricsSnapshot, renderPrometheus } from '../../src/services/metrics.js';

/**
 * **The `/metrics` families as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 2, with
 * [ADR-0055](../../.ssot/ADR.md#adr-0055) and [ADR-0105](../../.ssot/ADR.md#adr-0105)): the name and type of
 * every metric family and the names of its labels, which is what a dashboard or an alert rule is written
 * against. A family added, removed or renamed, a type changed, or a label added or dropped changes
 * `__snapshots__/metrics.txt`. Values, label *values* and the HELP text (Tier 3) are not recorded.
 *
 * Each line is `name type label,label` (`-` for a family with no labels), sorted. A histogram is one family
 * (`_bucket`, `_sum`, `_count` and the `le` label are the format's, not the family's).
 *
 * **Read from the render, not from a list.** The snapshot is the text `renderPrometheus` writes for a
 * snapshot that has every optional section the `/metrics` route fills in (`src/admin/routes.ts`), taken
 * from a `MetricsRegistry` that has been told about one event of each kind, so every family and every label
 * set exists. The route itself needs a database; this is its render path, as `test/metrics.test.ts` and
 * `test/mcp-metrics.test.ts` take it. A family that is only rendered conditionally and that this snapshot
 * does not reach would be missing from it, which is what the guards below are for.
 *
 * Re-record after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * Outside CI a missing snapshot file is written silently; run with `CI=1` to check rather than extend.
 */

const SNAPSHOT = path.join(import.meta.dirname, '__snapshots__', 'metrics.txt');

/** A registry that has seen one event of every kind, rendered with every section the route fills in. */
function fullRender(): { text: string; registry: MetricsRegistry } {
  const registry = new MetricsRegistry({ totalCount: 4, idleCount: 3, waitingCount: 0 });
  registry.watchIndexing(() => false);
  registry.countSearch('mcp');
  registry.countSearch('dashboard');
  registry.observeSearch({ embed: 0.01, retrieve: 0.02, rerank: 0.03, total: 0.07 });
  registry.observeEmbeddingBatch(8, 0.2);
  registry.observeIndexRunWait('interactive', 1);
  registry.observeIndexRunWait('scheduled', 2);
  registry.observeToolDuration('search_docs', 0.05);
  registry.countMcpRequest('tools/call', 'search_docs', 'modern');
  registry.countRateLimited('token');
  registry.countRateLimitError();
  registry.countAccessDenied('network');
  registry.countAudit('written');
  registry.countAudit('failed');
  registry.countEvalRun('ok', false);
  registry.countGapReport('accepted');
  registry.countSourceThrottled('s3');
  registry.countDocumentScan('scanned');
  registry.countDocumentFindings('jwt', 1);
  const gauges = registry.gauges();
  const snapshot: MetricsSnapshot = {
    version: '0.0.0-contract',
    uptimeSeconds: 1,
    embeddingId: 'local:contract:fp32',
    embeddingReady: true,
    dbUp: true,
    pool: gauges.pool,
    queue: { interactive: 1, scheduled: 1, running: 1 },
    lastIndexRun: { finishedAtSeconds: 1_700_000_000, durationSeconds: 1, ok: true },
    sourceFreshness: { oldestSyncedAtSeconds: 1_700_000_000, lagSeconds: 60, neverSynced: 0 },
    searches: gauges.searches,
    audit: gauges.audit,
    mcpRequests: registry.mcpRequests(),
    mcpGuard: registry.mcpGuard(),
    evalRuns: registry.evalRuns(),
    gapReports: registry.gapReports(),
    sourceThrottled: registry.sourceThrottled(),
    piiScan: registry.piiScan(),
    histograms: registry.histograms(),
  };
  return { text: renderPrometheus(snapshot), registry };
}

/** `name type labels` for every family of an exposition, sorted. */
function families(text: string): string[] {
  const types = new Map<string, string>();
  const labels = new Map<string, Set<string>>();
  for (const line of text.split('\n')) {
    const declared = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (declared) {
      types.set(declared[1] as string, declared[2] as string);
      labels.set(declared[1] as string, new Set());
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? /.exec(line);
    if (!sample) throw new Error(`not a sample line: ${line}`);
    const name = sample[1] as string;
    // A histogram's samples carry the suffixes of the format; they belong to the family that declared the type.
    const family = types.has(name) ? name : name.replace(/_(bucket|sum|count)$/, '');
    const owner = labels.get(family);
    if (!owner) throw new Error(`sample of a family with no TYPE line: ${line}`);
    for (const pair of (sample[3] ?? '').match(/[a-zA-Z_][a-zA-Z0-9_]*(?==")/g) ?? []) {
      if (!(types.get(family) === 'histogram' && pair === 'le')) owner.add(pair);
    }
  }
  return [...types.keys()].map((name) => `${name} ${types.get(name)} ${[...(labels.get(name) as Set<string>)].sort().join(',') || '-'}`).sort();
}

describe('the metrics families are a contract', () => {
  it('records every family, its type and the names of its labels', async () => {
    const { text, registry } = fullRender();
    const lines = families(text);

    // Guard the walk itself: a render that silently left a section out would record itself as the contract.
    expect(lines.length).toBeGreaterThan(30);
    expect(new Set(lines.map((line) => line.split(' ')[0])).size).toBe(lines.length);
    // Every histogram the registry holds is in the render and has the label names of an observed series
    // (a family nobody observed would be recorded without its labels).
    for (const histogram of registry.histograms()) {
      expect(histogram.series.length, `${histogram.name} was never observed`).toBeGreaterThan(0);
      expect(lines.some((line) => line.startsWith(`${histogram.name} histogram `))).toBe(true);
    }
    for (const expected of [
      'contextator_build_info gauge ',
      'contextator_searches_total counter actor',
      'contextator_search_duration_seconds histogram indexing,phase',
    ]) {
      expect(
        lines.some((line) => line.startsWith(expected)),
        expected,
      ).toBe(true);
    }

    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(SNAPSHOT);
  });

  it('writes the same families for the same registry, however often it is asked', () => {
    expect(families(fullRender().text)).toEqual(families(fullRender().text));
  });
});
