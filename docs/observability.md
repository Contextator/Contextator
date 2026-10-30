# Observability

Contextator exposes three things for the people who run it: Prometheus metrics at `GET /metrics`, a
ready-made Grafana dashboard for them, and OpenTelemetry traces that you switch on yourself.

## Metrics and the Helm ServiceMonitor

`GET /metrics` is on the same port as everything else and is not public: it answers `401` without
`METRICS_TOKEN` (decision record ADR-0055). With the Helm chart, `metrics.serviceMonitor.enabled: true`
renders a `ServiceMonitor` that scrapes it with that same token; the setup, including the Secret, is in the
[chart README](../charts/contextator/README.md#prometheus-operator-servicemonitor). `/metrics` keeps
answering `200` while the database is down, and `contextator_db_up` is the series that says so.

Label values come from closed sets only, never from a project, a document, a query or a token (ADR-0105).
That is why no metric carries a `project` or `source` label.

### Source freshness

| Metric | Type | Meaning |
|--------|------|---------|
| `contextator_source_last_sync_timestamp_seconds` | gauge | Unix time of the last successful sync of the scheduled source that has gone longest without one. |
| `contextator_source_freshness_lag_seconds` | gauge | Seconds since that moment, measured by the database clock. |
| `contextator_sources_never_synced` | gauge | Scheduled sources that have never completed a sync. |

All three are single, unlabeled series for the whole instance: they describe the worst case, which is the
number an alert needs, and they cannot grow with the number of projects or sources. To find out which
source is behind, open the project in the dashboard; each source shows its own last sync time there.

### Source throttling

| Metric | Type | Meaning |
|--------|------|---------|
| `contextator_source_throttled_total{source_type}` | counter | Throttling answers a source's remote gave, counted per answer whether or not a retry then succeeded. `s3` counts `503 SlowDown`; `gdrive` counts `429` and `403` with `rateLimitExceeded` or `userRateLimitExceeded`. |

The `source_type` label is a closed set (`s3`, `gdrive`) and both values are exported from start at `0`, so a rate
that has not happened yet is a flat line and not a missing series (ADR-0126). A rising `s3` rate means the bucket's
request-rate limit is being hit: narrow the source's prefix, lengthen its sync interval, or spread its keys.

Things worth knowing before you pick a threshold:

- Only **scheduled** sources count (those with a sync interval). A manual-only source is never expected to
  move on its own and would keep any alert firing.
- The timestamp moves only when a sync **succeeds**. A source whose last attempts failed keeps getting
  older, which is the signal.
- A scheduled source whose content has not changed is probed and skipped, not re-synced, for up to
  `SYNC_MAX_SKIP_HOURS` (24 by default). A healthy source can therefore read about `SYNC_MAX_SKIP_HOURS`
  plus its own interval. Set the threshold above that.
- **`SYNC_MAX_SKIP_HOURS=0` does not mean "never skip".** It removes the upper bound: an unchanged source
  is then probed and skipped indefinitely and its last-sync time never moves, so the lag grows without
  limit and the stale-source alert below fires for a healthy instance. If you run with `0`, do not alert
  on `contextator_source_freshness_lag_seconds`; keep `contextator_sources_never_synced` and the sync
  failures in the dashboard instead.
- The two timestamp/lag series are absent until some scheduled source has synced once. An absent series is
  not "fresh"; `contextator_sources_never_synced` covers that case, and `absent()` can cover a restart.

### Example alert rules

```yaml
groups:
  - name: contextator-freshness
    rules:
      - alert: ContextatorSourcesStale
        # 24 h SYNC_MAX_SKIP_HOURS + a 6 h interval + margin. Raise it if you run longer intervals.
        expr: contextator_source_freshness_lag_seconds > 36 * 3600
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "A scheduled source has not synced for {{ $value | humanizeDuration }}"
          description: "Open the projects in the dashboard and look for a source with a failed or stuck sync."
      - alert: ContextatorSourceNeverSynced
        expr: contextator_sources_never_synced > 0
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} scheduled source(s) have never completed a sync"
      - alert: ContextatorDatabaseDown
        expr: contextator_db_up == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Contextator cannot reach its database"
```

## Grafana dashboard

[`observability/grafana-dashboard.json`](observability/grafana-dashboard.json) charts the series above and
the existing histograms: MCP requests by method, tool and protocol era; MCP tool latency; search request
latency, with and without an index run in progress; search phase latency (embed, retrieve, rerank); source
freshness; index queue depth, run wait and embedding batches. Every panel queries only series that
`/metrics` renders.

To import it, use **Dashboards → New → Import**, upload the file and pick your Prometheus data source for
`DS_PROMETHEUS`. The `Job` variable at the top filters by the scrape job Prometheus gave the target; with a
ServiceMonitor that is the Service name. Pointing it at several jobs (several instances) sums the series.

## Traces (opt-in OpenTelemetry)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector's base URL (`http://otel-collector:4318`) and
restart. With the variable unset, the OpenTelemetry modules are not loaded at all; there is no tracing code
on the request path beyond a function that does nothing. On the Helm chart, put it under `env:`:

```yaml
env:
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector.observability:4318
  OTEL_SERVICE_NAME: contextator
```

The packages are optional dependencies. If they are missing from an install (for example a build made with
`npm install --omit=optional`) or the exporter cannot be set up, the server logs one warning at startup and
carries on without tracing.

Startup does not contact the collector, so `tracing enabled` in the log does not prove spans arrive. When
an export fails (collector down, rejected, timed out) the server logs `tracing: exporting spans failed`
with the collector's origin, the error class and its code, at most once a minute, and drops that batch.
The error message is deliberately left out of the line.

### Variables the OpenTelemetry SDK reads itself

Contextator's own rule is that the environment is read in one place, `src/config.ts`, and it reads only
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` there. The OpenTelemetry packages, however, read some
`OTEL_*` variables from the process environment on their own, and Contextator does not stop them. This was
checked against the pinned versions (`@opentelemetry/sdk-trace-base` and `core` 2.11.0,
`otlp-exporter-base` 0.222.0; paths are under `node_modules/@opentelemetry/`). If the host exports any of
these for other services, they apply here too, silently.

| Variable | Effect | Where it is read |
|----------|--------|------------------|
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Extra HTTP headers on every export (the usual place for a collector's API key). | `otlp-exporter-base/build/src/configuration/otlp-node-http-env-configuration.js:16-17` |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | Export timeout in milliseconds; an invalid value is ignored without a message. | `otlp-exporter-base/build/src/configuration/shared-env-configuration.js:10-24` |
| `OTEL_EXPORTER_OTLP_COMPRESSION`, `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION` | `gzip` or `none`. | `shared-env-configuration.js:25-37` |
| `OTEL_EXPORTER_OTLP_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_KEY` (and `_TRACES_` forms) | Files read at startup for TLS to an `https` collector. | `otlp-node-http-env-configuration.js:76-100` |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_EXPORT_TIMEOUT` | Batching of exported spans. | `sdk-trace-base/build/src/BatchSpanProcessor-shim.js:19-32` |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Which traces are recorded. **`always_off` or a low ratio silently records nothing or little**, even though the endpoint is set. | `sdk-trace-base/build/src/config.js:31,51-91` (an invalid value is replaced by the default, again without a message) |
| `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`, `OTEL_ATTRIBUTE_COUNT_LIMIT`, `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`, `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` (and the event and link count limits) | Span size limits. | `sdk-trace-base/build/src/config.js:33-43`, `utility.js:16-37` |

Variables that look relevant and are **not** applied:

- `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` are read by the exporter too
  (`otlp-node-http-env-configuration.js:63,70`), but the URL Contextator passes explicitly takes
  precedence (`otlp-http-configuration.js:50`). The address Contextator reads is the one used.
- `OTEL_RESOURCE_ATTRIBUTES` and the SDK's handling of `OTEL_SERVICE_NAME`: the resource is built from fixed
  attributes and no resource detector runs. `OTEL_SERVICE_NAME` is honoured only because `config.ts`
  reads it.
- `OTEL_SDK_DISABLED` (nothing in the pinned packages reads it) and `OTEL_PROPAGATORS` (the W3C
  propagator is constructed directly).

The packages are pinned in `package.json`; after any upgrade of them this list needs re-checking.

### What a search produces

One `tools/call` that searches yields one trace of up to six spans:

| Span | Covers |
|------|--------|
| `contextator.search.query` | The whole search; the root. Attributes: `contextator.rerank`, `contextator.hits`, `contextator.below_floor`. |
| `contextator.search.embed` | Embedding the query (a call to the embedding provider). No attributes. |
| `contextator.search.candidates` | Retrieval: the whole of the candidate search. Attribute: `contextator.hits`. |
| `contextator.search.rerank` | A child of `candidates`; present only when the reranker is enabled and retrieval found at least one candidate to score (with none, the reranker is not called). The reranker's forward pass. Attribute: `contextator.passages`, the number of candidates it scored. |
| `contextator.search.fusion` | The verdict on the fused result: whether it clears the score floor. Attribute: `contextator.below_floor`. |
| `contextator.search.response` | Handing the answer off: the query log write and the metrics. |

Be aware of two things about where the lines fall. The dense and lexical candidate lists and the
reciprocal-rank fusion are **one SQL statement** (ADR-0041), so there is no point inside it at which Node
could start a span: `candidates` times the whole retrieval, and `fusion` is named for the stage of the
search it closes, but what it times is the score-floor decision that comes after the fusion. The
reranker is not in that statement either. With it enabled, retrieval is two round trips with the
reranker's forward pass in Node between them, and the `rerank` span covers that pass, so `candidates`
minus `rerank` is the database time. The `contextator_search_duration_seconds{phase}` histogram gives the
same split in aggregate.

Span names and attribute names are fixed. Nothing from the query text, the project, a document or a token
is put on a span, and a failed span records only the error's class name (`error.type`), never its message.

### Trace context from the client

If the request carries a W3C `traceparent` header (and optionally `tracestate`), the spans join that trace
as children of the caller's span. A missing or malformed header starts a new trace. Contextator does not
add a header to anything it sends elsewhere.
