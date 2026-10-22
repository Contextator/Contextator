import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchDeps } from '../src/services/search.js';

/**
 * Opt-in tracing: off means the OpenTelemetry modules are never loaded, on means one search is one
 * trace of four spans. No database and no collector — the two seams `searchProject` reaches are stubbed
 * and the exporter is an in-memory one, so nothing leaves the process.
 */

const stubs = vi.hoisted(() => ({ backendLoads: 0 }));

vi.mock('../src/services/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/projects.js')>()),
  getProjectById: async () => ({
    id: 'project-1',
    chunkCount: 3,
    embeddingModel: null,
    liveGeneration: 1,
    scoreFloor: null,
    queryLogEnabled: false,
  }),
}));

vi.mock('../src/services/vector-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vector-store.js')>()),
  searchChunks: async () => [],
}));

const silent = { info: () => {}, warn: () => {} };

const deps = {
  db: {},
  embeddings: { id: 'stub', embedQuery: async () => [0, 1] },
  scan: undefined,
  selection: undefined,
} as unknown as SearchDeps;

/** Fresh module instances, so each test starts from the no-op default and its own import counter. */
async function load() {
  vi.resetModules();
  const tracing = await import('../src/services/tracing.js');
  const search = await import('../src/services/search.js');
  return { ...tracing, searchProject: search.searchProject };
}

afterEach(() => {
  vi.doUnmock('../src/services/tracing-otel.js');
  stubs.backendLoads = 0;
});

describe('tracing off', () => {
  it('does not load the OpenTelemetry backend when no endpoint is set', async () => {
    vi.doMock('../src/services/tracing-otel.js', () => {
      stubs.backendLoads += 1;
      return { createOtelBackend: () => ({}) };
    });
    const { initTracing, tracing, searchProject } = await load();

    const started = await initTracing({ endpoint: undefined, serviceName: 'contextator', version: '0.0.0' }, silent);
    const outcome = await searchProject(deps, { projectId: 'project-1', query: 'anything' });

    expect(stubs.backendLoads).toBe(0);
    expect(started.enabled).toBe(false);
    expect(tracing().enabled).toBe(false);
    expect(outcome.status).toBe('ok');
  });

  it('carries on untraced when the endpoint is set but the backend cannot start', async () => {
    vi.doMock('../src/services/tracing-otel.js', () => {
      throw new Error('Cannot find package');
    });
    const { initTracing, tracing } = await load();
    const warnings: string[] = [];

    await initTracing(
      { endpoint: 'http://collector:4318', serviceName: 'contextator', version: '0.0.0' },
      { info: () => {}, warn: (_o, message) => warnings.push(message) },
    );

    expect(tracing().enabled).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe('tracing on', () => {
  async function started() {
    const exporter = new InMemorySpanExporter();
    const loaded = await load();
    await loaded.initTracing({ endpoint: 'http://collector:4318', serviceName: 'contextator', version: '0.0.0', spanExporter: exporter }, silent);
    return { exporter, ...loaded };
  }

  it('turns one search into four spans under one trace', async () => {
    const { exporter, searchProject, tracing } = await started();
    expect(tracing().enabled).toBe(true);

    await searchProject(deps, { projectId: 'project-1', query: 'a query that must never become an attribute' });

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      'contextator.search.candidates',
      'contextator.search.fusion',
      'contextator.search.query',
      'contextator.search.response',
    ]);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);

    const root = spans.find((span) => span.name === 'contextator.search.query');
    expect(root?.parentSpanContext).toBeUndefined();
    for (const span of spans.filter((s) => s !== root)) {
      expect(span.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    // ADR-0105 applied to traces: nothing the caller typed is an attribute value.
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('must never become');
  });

  it('continues the trace a client sent in traceparent', async () => {
    const { exporter, searchProject, tracing } = await started();
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const parentId = 'b7ad6b7169203331';

    await tracing().withRemoteContext({ traceparent: `00-${traceId}-${parentId}-01` }, () =>
      searchProject(deps, { projectId: 'project-1', query: 'anything' }),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(new Set([traceId]));
    expect(spans.find((span) => span.name === 'contextator.search.query')?.parentSpanContext?.spanId).toBe(parentId);
  });

  it('starts a new trace when the client sent a malformed traceparent', async () => {
    const { exporter, searchProject, tracing } = await started();

    await tracing().withRemoteContext({ traceparent: 'not-a-traceparent' }, () => searchProject(deps, { projectId: 'project-1', query: 'anything' }));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    expect(spans.find((span) => span.name === 'contextator.search.query')?.parentSpanContext).toBeUndefined();
  });

  it('records a failing stage on its span and still ends every span', async () => {
    const { exporter, searchProject } = await started();
    const failing = {
      ...deps,
      embeddings: { id: 'stub', embedQuery: async () => Promise.reject(new TypeError('secret detail')) },
    } as unknown as SearchDeps;

    await expect(searchProject(failing, { projectId: 'project-1', query: 'anything' })).rejects.toThrow('secret detail');

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === 'contextator.search.query');
    expect(root?.status.code).toBe(2);
    expect(root?.attributes['error.type']).toBe('TypeError');
    // The message can carry user text; only the class name is exported.
    expect(JSON.stringify(spans.map((span) => [span.attributes, span.status, span.events]))).not.toContain('secret detail');
  });
});
