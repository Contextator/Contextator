import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Opt-in tracing, and the only half of it that is always loaded.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the switch. Unset (the default) nothing from OpenTelemetry is ever
 * imported: this file has no `@opentelemetry/*` import and the real backend, `tracing-otel.ts`, is
 * reached through a dynamic `import()` that runs only when the endpoint is set. A server that does not
 * trace therefore pays neither the module load at startup nor, per request, anything beyond one call
 * into a no-op object that runs the function it is given. The packages are `optionalDependencies` for the
 * same reason: an install that cannot fetch them still starts, and `initTracing` says so once and goes on
 * untraced instead of failing a boot over telemetry.
 *
 * **Span names are a closed set** and attribute values never come from the wire or the data: no span
 * carries a query, a project name, a path or a token. This is the rule [ADR-0105](../../.ssot/ADR.md#adr-0105)
 * sets for metric labels, applied to the other place a label-shaped value can leak.
 */

export type SpanAttributeValue = string | number | boolean;

/** What the instrumented code may do to the span it is running in. */
export interface TraceSpan {
  setAttribute(key: string, value: SpanAttributeValue): void;
}

/** One started span as the backend returns it; `context` is opaque here and handed back as `parent`. */
export interface BackendSpan extends TraceSpan {
  readonly context: unknown;
  recordError(err: unknown): void;
  end(): void;
}

/** The seam `tracing-otel.ts` implements. Kept free of OpenTelemetry types so this file never needs them. */
export interface TracingBackend {
  start(name: string, parent: unknown, attributes?: Record<string, SpanAttributeValue>): BackendSpan;
  /** Reads W3C `traceparent`/`tracestate` from request headers; the result is a valid `parent` for `start`. */
  extract(headers: IncomingHttpHeaders): unknown;
  shutdown(): Promise<void>;
}

export interface Tracing {
  readonly enabled: boolean;
  /** Runs `fn` inside a new span that is a child of the span (or remote context) already in scope. */
  span<T>(name: string, attributes: Record<string, SpanAttributeValue> | undefined, fn: (span: TraceSpan) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` with the caller's trace context (W3C Trace Context headers) as the parent of every span
   * started inside it. A request without the headers is simply a new trace.
   */
  withRemoteContext<T>(headers: IncomingHttpHeaders, fn: () => T): T;
  shutdown(): Promise<void>;
}

const NOOP_SPAN: TraceSpan = { setAttribute: () => undefined };

const NOOP_TRACING: Tracing = {
  enabled: false,
  span: (_name, _attributes, fn) => fn(NOOP_SPAN),
  withRemoteContext: (_headers, fn) => fn(),
  shutdown: async () => undefined,
};

/** The scope is an `AsyncLocalStorage` of the backend's own context rather than OTel's context manager, so no global state is installed. */
export function createTracing(backend: TracingBackend): Tracing {
  const scope = new AsyncLocalStorage<unknown>();
  return {
    enabled: true,
    async span(name, attributes, fn) {
      const span = backend.start(name, scope.getStore(), attributes);
      try {
        return await scope.run(span.context, () => fn(span));
      } catch (err) {
        span.recordError(err);
        throw err;
      } finally {
        span.end();
      }
    },
    withRemoteContext(headers, fn) {
      return scope.run(backend.extract(headers), fn);
    },
    shutdown: () => backend.shutdown(),
  };
}

let active: Tracing = NOOP_TRACING;

/** The process's tracer: a no-op until `initTracing` finds an endpoint. */
export function tracing(): Tracing {
  return active;
}

/** Test seam: installs `next`, or the no-op when omitted, and returns what it replaced. */
export function setTracing(next: Tracing = NOOP_TRACING): Tracing {
  const previous = active;
  active = next;
  return previous;
}

export interface TracingOptions {
  endpoint: string | undefined;
  serviceName: string;
  version: string;
  /** Replaces the OTLP exporter; the tracing test hands an in-memory one so nothing leaves the process. */
  spanExporter?: unknown;
}

/**
 * Starts tracing when `endpoint` is set. The dynamic import is the whole of the "off means off"
 * guarantee, so it stays inside this branch.
 *
 * Never throws: a missing optional package or an exporter that cannot be built is logged and the process
 * carries on untraced, because a telemetry fault must not be a reason the documentation server is down.
 */
export async function initTracing(
  options: TracingOptions,
  log: { info(o: object, m: string): void; warn(o: object, m: string): void },
): Promise<Tracing> {
  if (!options.endpoint) {
    setTracing();
    return NOOP_TRACING;
  }
  try {
    const { createOtelBackend } = await import('./tracing-otel.js');
    const next = createTracing(createOtelBackend(options));
    setTracing(next);
    log.info({ endpoint: new URL(options.endpoint).origin, service: options.serviceName }, 'tracing enabled');
    return next;
  } catch (err) {
    log.warn(
      { err },
      'OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing could not start; continuing without it (are the optional @opentelemetry packages installed?)',
    );
    setTracing();
    return NOOP_TRACING;
  }
}
