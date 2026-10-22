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

Things worth knowing before you pick a threshold:

- Only **scheduled** sources count (those with a sync interval). A manual-only source is never expected to
  move on its own and would keep any alert firing.
- The timestamp moves only when a sync **succeeds**. A source whose last attempts failed keeps getting
  older, which is the signal.
- A scheduled source whose content has not changed is probed and skipped, not re-synced, for up to
  `SYNC_MAX_SKIP_HOURS` (24 by default, `0` switches this off). A healthy source can therefore read about
  `SYNC_MAX_SKIP_HOURS` plus its own interval. Set the threshold above that.
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
`npm install --omit=optional`) or the collector cannot be set up, the server logs one warning at startup and
carries on without tracing.

### What a search produces

One `tools/call` that searches yields one trace of four spans:

| Span | Covers |
|------|--------|
| `contextator.search.query` | The whole search; the root. Attributes: `contextator.rerank`, `contextator.hits`, `contextator.below_floor`. |
| `contextator.search.candidates` | Retrieval: the dense and lexical candidate lists. Attribute: `contextator.hits`. |
| `contextator.search.fusion` | The verdict on the fused result: whether it clears the score floor. Attribute: `contextator.below_floor`. |
| `contextator.search.response` | Handing the answer off: the query log write and the metrics. |

Be aware that candidates and fusion are **one SQL statement** (ADR-0041: both candidate lists and the
reciprocal-rank fusion run inside PostgreSQL, with the reranker, when enabled, called from inside it).
There is no point between them at which Node could start and end a span, so `candidates` times that whole
statement and `fusion` times the score-floor decision that follows it. To see how the time splits between
embedding, retrieval and reranking, use the `contextator_search_duration_seconds{phase}` histogram.

Span names and attribute names are fixed. Nothing from the query text, the project, a document or a token
is put on a span, and a failed span records only the error's class name (`error.type`), never its message.

### Trace context from the client

If the request carries a W3C `traceparent` header (and optionally `tracestate`), the spans join that trace
as children of the caller's span. A missing or malformed header starts a new trace. Contextator does not
add a header to anything it sends elsewhere.
