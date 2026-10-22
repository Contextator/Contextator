import { type Attributes, type Context, ROOT_CONTEXT, type Span, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { BackendSpan, SpanAttributeValue, TracingBackend, TracingOptions } from './tracing.js';

/**
 * The OpenTelemetry half of tracing. **Reached only through `initTracing`'s dynamic import**, which runs
 * only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; nothing else imports this file.
 *
 * It uses the SDK's tracer provider directly and keeps the active span in `tracing.ts`'s own
 * `AsyncLocalStorage`, so no global tracer provider, propagator or context manager is registered: this
 * process shares its runtime with nothing else that could be surprised by one.
 */
export function createOtelBackend(options: TracingOptions): TracingBackend {
  // The exporter is given the full signal URL: with an explicit `url` the SDK uses it verbatim, and the
  // variable is documented as a base endpoint (the OTLP/HTTP convention), so `/v1/traces` is added here.
  const inner =
    (options.spanExporter as SpanExporter | undefined) ?? new OTLPTraceExporter({ url: `${(options.endpoint ?? '').replace(/\/+$/, '')}/v1/traces` });
  const exporter = reportingExportFailures(inner, options.onExportError);
  // An injected exporter is the test's, and a batch processor would hold its spans back for five seconds.
  const processor = options.spanExporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName, 'service.version': options.version }),
    spanProcessors: [processor],
  });
  const tracer: Tracer = provider.getTracer('contextator', options.version);
  const propagator = new W3CTraceContextPropagator();

  return {
    start(name, parent, attributes): BackendSpan {
      const parentContext = (parent as Context | undefined) ?? ROOT_CONTEXT;
      const span: Span = tracer.startSpan(name, { attributes: attributes as Attributes | undefined }, parentContext);
      return {
        context: trace.setSpan(parentContext, span),
        setAttribute: (key: string, value: SpanAttributeValue) => {
          span.setAttribute(key, value);
        },
        recordError: (err) => {
          // The error class and nothing else: a message can carry the query or a path, and a span
          // is exported off the machine (ADR-0105's rule, applied to traces).
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute('error.type', err instanceof Error ? err.name : 'unknown');
        },
        end: () => span.end(),
      };
    },
    extract(headers) {
      return propagator.extract(ROOT_CONTEXT, headers, {
        get: (carrier, key) => {
          const value = (carrier as Record<string, string | string[] | undefined>)[key];
          return Array.isArray(value) ? value[0] : value;
        },
        keys: (carrier) => Object.keys(carrier as object),
      });
    },
    shutdown: () => provider.shutdown(),
  };
}

/**
 * Hands a failed export to `onFail`, then passes the result on untouched.
 *
 * The SDK reports an export that failed only through its `diag` channel, and that has no logger until
 * something registers one globally. Registering one would reach every OpenTelemetry user in the process
 * and is process-wide state this file otherwise avoids; wrapping the one exporter this file owns reports
 * the same failure to the server's own log without it. Without this, an endpoint nobody listens on
 * looks identical to a working one: `tracing enabled` is logged without connecting.
 */
function reportingExportFailures(inner: SpanExporter, onFail: ((err: unknown) => void) | undefined): SpanExporter {
  if (!onFail) return inner;
  return {
    export(spans, resultCallback) {
      inner.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          try {
            onFail(result.error);
          } catch {
            // A logging fault must not turn into an export fault.
          }
        }
        resultCallback(result);
      });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: inner.forceFlush ? () => (inner.forceFlush as () => Promise<void>)() : undefined,
  };
}
