import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchDeps } from '../src/services/search.js';

/**
 * Opt-in tracing: off means the OpenTelemetry modules are never loaded, on means one search is one
 * trace of six spans (five without a reranker). No database and no collector — the two seams
 * `searchProject` reaches are stubbed and the exporter is an in-memory one, so nothing leaves the process.
 *
 * The OpenTelemetry packages are optional dependencies (ADR-0119), so this file must not need them to be
 * loaded: they are imported inside the tests that use them, and those tests are skipped on an install
 * made with `--omit=optional`.
 */

const OTEL_PACKAGES = [
  '@opentelemetry/api',
  '@opentelemetry/core',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-trace-base',
] as const;

const otelInstalled = await import('@opentelemetry/sdk-trace-base').then(
  () => true,
  () => false,
);

const stubs = vi.hoisted(() => ({ backendLoads: 0, packageLoads: [] as string[] }));

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
  // Calls the rerank function it is given, as the real one does between its two round trips, so the
  // rerank span has something to wrap.
  searchChunks: async (_db: unknown, request: { rerank?: (query: string, passages: string[]) => Promise<number[]> }) => {
    await request.rerank?.('stub query', ['first passage', 'second passage']);
    return [];
  },
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
  for (const name of OTEL_PACKAGES) vi.doUnmock(name);
  stubs.backendLoads = 0;
  stubs.packageLoads.length = 0;
});

/** Every `.ts` file under `dir`, relative to the repository root. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

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

  it('loads none of the OpenTelemetry packages, the backend file aside, while tracing is off', async () => {
    // A factory runs only when something imports the module, so a counter in it is a record of every
    // import the graph below made. `tracing-otel.js` is left real: it is the file that would import them.
    for (const name of OTEL_PACKAGES) {
      vi.doMock(name, () => {
        stubs.packageLoads.push(name);
        return {};
      });
    }
    const { initTracing, searchProject } = await load();

    await initTracing({ endpoint: undefined, serviceName: 'contextator', version: '0.0.0' }, silent);
    await searchProject(deps, { projectId: 'project-1', query: 'anything' });

    expect(stubs.packageLoads).toEqual([]);
  });

  it('keeps every value import of an OpenTelemetry package inside tracing-otel.ts', () => {
    // The runtime test above proves the path a search takes; this one proves the rest of `src/`, which
    // no test reaches. A type-only import is erased by the compiler and loads nothing.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const valueImport =
      /\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s+['"]@opentelemetry\/|\bimport\s+['"]@opentelemetry\/|\b(?:import|require)\(\s*['"]@opentelemetry\//;
    const offenders = sourceFiles(root)
      .filter((file) => path.basename(file) !== 'tracing-otel.ts')
      .filter((file) => valueImport.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual([]);
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

describe.skipIf(!otelInstalled)('tracing on', () => {
  async function started(spanExporter?: unknown, log: { info(o: object, m: string): void; warn(o: object, m: string): void } = silent) {
    const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
    const exporter = new InMemorySpanExporter();
    const loaded = await load();
    await loaded.initTracing(
      { endpoint: 'http://collector:4318', serviceName: 'contextator', version: '0.0.0', spanExporter: spanExporter ?? exporter },
      log,
    );
    return { exporter, ...loaded };
  }

  const reranker = { id: 'stub-rerank', score: async (_query: string, passages: readonly string[]) => passages.map((_, index) => index) };
  const withRerank = { ...deps, rerank: reranker } as unknown as SearchDeps;

  it('turns one search into six spans under one trace, the rerank under the candidates', async () => {
    const { exporter, searchProject, tracing } = await started();
    expect(tracing().enabled).toBe(true);

    await searchProject(withRerank, { projectId: 'project-1', query: 'a query that must never become an attribute' });

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      'contextator.search.candidates',
      'contextator.search.embed',
      'contextator.search.fusion',
      'contextator.search.query',
      'contextator.search.rerank',
      'contextator.search.response',
    ]);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);

    const byName = (name: string) => spans.find((span) => span.name === `contextator.search.${name}`);
    const root = byName('query');
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.attributes['contextator.rerank']).toBe(true);
    for (const child of ['embed', 'candidates', 'fusion', 'response']) {
      expect(byName(child)?.parentSpanContext?.spanId, child).toBe(root?.spanContext().spanId);
    }
    // The rerank runs inside the candidate stage, between its two round trips (ADR-0041).
    expect(byName('rerank')?.parentSpanContext?.spanId).toBe(byName('candidates')?.spanContext().spanId);
    expect(byName('rerank')?.attributes).toEqual({ 'contextator.passages': 2 });
    expect(byName('embed')?.attributes).toEqual({});
    // ADR-0105 applied to traces: nothing the caller typed is an attribute value.
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('must never become');
  });

  it('has no rerank span when no reranker is configured', async () => {
    const { exporter, searchProject } = await started();

    await searchProject(deps, { projectId: 'project-1', query: 'anything' });

    const names = exporter.getFinishedSpans().map((span) => span.name);
    expect(names).toHaveLength(5);
    expect(names).not.toContain('contextator.search.rerank');
    expect(exporter.getFinishedSpans().find((span) => span.name === 'contextator.search.query')?.attributes['contextator.rerank']).toBe(false);
  });

  it('warns once, and without the error message, when exporting spans fails', async () => {
    const failing = {
      export: (_spans: unknown, done: (result: { code: number; error: Error }) => void) =>
        done({ code: 1, error: new Error('collector said: secret body') }),
      shutdown: async () => {},
    };
    const warnings: Array<{ o: object; m: string }> = [];
    const { searchProject } = await started(failing, { info: () => {}, warn: (o, m) => warnings.push({ o, m }) });

    // Six spans end, so six exports fail; the line is rate-limited to one a minute.
    await searchProject(withRerank, { projectId: 'project-1', query: 'anything' });

    await vi.waitFor(() => expect(warnings).toHaveLength(1));
    expect(warnings[0].m).toContain('exporting spans failed');
    expect(warnings[0].o).toMatchObject({ endpoint: 'http://collector:4318', error: 'Error' });
    expect(JSON.stringify(warnings)).not.toContain('secret body');
  });

  it('continues the trace a client sent in traceparent', async () => {
    const { exporter, searchProject, tracing } = await started();
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const parentId = 'b7ad6b7169203331';

    await tracing().withRemoteContext({ traceparent: `00-${traceId}-${parentId}-01` }, () =>
      searchProject(deps, { projectId: 'project-1', query: 'anything' }),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(5);
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(new Set([traceId]));
    expect(spans.find((span) => span.name === 'contextator.search.query')?.parentSpanContext?.spanId).toBe(parentId);
  });

  it('starts a new trace when the client sent a malformed traceparent', async () => {
    const { exporter, searchProject, tracing } = await started();

    await tracing().withRemoteContext({ traceparent: 'not-a-traceparent' }, () => searchProject(deps, { projectId: 'project-1', query: 'anything' }));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(5);
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
