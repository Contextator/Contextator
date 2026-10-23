# Configuration

The variables most installs touch are in the table in the [README](../README.md#configuration); the annotated list of every variable is [`.env.example`](../.env.example). This page holds the longer setups.

## Running behind a reverse proxy

Nothing is in front of this by default. Put nginx, Caddy, Traefik or a cloud load balancer in front and
**three settings have to move together**, or sign-in rate limiting, MCP OAuth and the session cookie each
break in a way that does not announce itself:

```bash
TRUST_PROXY=172.18.0.0/16        # the proxy's address or CIDR, or `loopback` if it is on the host
PUBLIC_BASE_URL=https://docs.example.com
AUTH_COOKIE_SECURE=1
```

Full reasoning for each of the three, what breaks without them, and the "name the proxy, not the
network your clients are on" rule for `TRUST_PROXY`: [Configuration](https://contextator.com/en/docs/configuration/#running-behind-a-reverse-proxy).

## Embedding with a server of your own

`EMBEDDING_PROVIDER=openai` speaks to any server that offers an OpenAI-compatible `/embeddings` endpoint.
Point `EMBEDDING_BASE_URL` at it, with the path, and name the model that server serves in
`OPENAI_EMBEDDING_MODEL`. `OPENAI_API_KEY` is optional with a base URL; when set it is sent as a bearer
token. `EMBEDDING_DIMENSIONS` must match the model's vector size.

```bash
# Ollama
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://localhost:11434/v1
OPENAI_EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768

# LM Studio: its local server
EMBEDDING_BASE_URL=http://localhost:1234/v1

# Text Embeddings Inference, started with -p 8080:80
EMBEDDING_BASE_URL=http://localhost:8080/v1

# vLLM: the host and port you started `vllm serve` on
EMBEDDING_BASE_URL=http://gpu-box:<port>/v1
EMBEDDING_REQUEST_DIMENSIONS=always   # only for a model that shortens its vectors on request
```

Inside the Contextator container, `localhost` is the container, not your machine: use an address the
container can reach the server on, such as `host.docker.internal` where your Docker provides it, or the
server's service name on a shared network. Set the model name and `EMBEDDING_DIMENSIONS` to the model you
loaded in every case; the lines above show only what differs. `RESET_VECTORS=1` is needed only when the database already records a vector dimension and the new one differs from it, as moving a 384-dimension install to a 768-dimension model does; a first install needs none.
It is set for one start only; see [Changing the embedding model](#changing-the-embedding-model). `EMBEDDING_REQUEST_DIMENSIONS` is `auto` by default and sends `dimensions` only for
`text-embedding-3-*`; use `always` for a model that accepts it and `never` for a server that rejects it. The
endpoint's host and port become part of the model id every project is stamped with, so pointing at another
server re-indexes every project. The annotated list is in [`.env.example`](../.env.example); the model
guidance is in [Embedding Models](https://contextator.com/en/docs/embedding-models/).

**Instruction prefixes follow the model name.** `query: ` / `passage: ` are added only when
`OPENAI_EMBEDDING_MODEL` names a family that needs them (`multilingual-e5-*`). A server that serves an e5
under another name (`e5`, `embed`, a local path) gets no prefixes and quietly loses a little recall;
Contextator says so once at startup, at `info`. Use the model's real name, or set
`EMBEDDING_QUERY_PREFIX` / `EMBEDDING_PASSAGE_PREFIX` yourself.

**Counting tokens with the model's own tokenizer.** Chunks are sized by an estimate (characters ÷ 4)
unless `EMBEDDING_TOKENIZER` names a Hugging Face model whose `tokenizer.json` matches the served model.
Only the tokenizer is downloaded, into `MODEL_CACHE_DIR`; startup stops if it cannot be loaded. With it,
an endpoint cuts the same chunks the local provider cuts from the same model. It is part of the model id,
so setting or changing it re-indexes every project once.

```bash
# multilingual-e5-small behind TEI or vLLM: these five lines, only the URL differs
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://localhost:8080/v1        # TEI; vLLM: http://gpu-box:<port>/v1
OPENAI_EMBEDDING_MODEL=intfloat/multilingual-e5-small   # the real name, so the e5 prefixes apply
EMBEDDING_DIMENSIONS=384
EMBEDDING_TOKENIZER=Xenova/multilingual-e5-small
```

If your server serves the model under another name (a local alias, a path), the name matches no family: the model
runs without prefixes and recall quietly drops. The server says so once at startup, at `info` level, unless you have
set either prefix variable. Either put the model's real name in `OPENAI_EMBEDDING_MODEL`, or keep your own name and
set the prefixes yourself; either change re-indexes every project once:

```bash
# Ollama, the model kept under its own tag: these lines replace their namesakes above, keep the rest
EMBEDDING_BASE_URL=http://localhost:11434/v1
OPENAI_EMBEDDING_MODEL=<your-tag>
EMBEDDING_QUERY_PREFIX="query: "
EMBEDDING_PASSAGE_PREFIX="passage: "
```

## Changing the embedding model

Changing `EMBEDDING_MODEL` (same dimension) triggers an automatic full re-index once you press
`Re-index now` on each project; a different-dimension model (e.g. OpenAI's `text-embedding-3-small`)
needs `RESET_VECTORS=1` on one restart first. Full procedure for both cases, plus upgrading across a
default-model change: [Embedding Models](https://contextator.com/en/docs/embedding-models/#changing-the-model).

## Tracing (OpenTelemetry)

Tracing is off by default and switches on with one variable. Nothing else changes: with it unset the
OpenTelemetry packages are never loaded, so a server that does not trace pays nothing for the feature.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (off) | Base URL of an OTLP/HTTP collector, for example `http://otel-collector:4318`. Spans go to `<endpoint>/v1/traces`. Must be an `http(s)` URL. |
| `OTEL_SERVICE_NAME` | `contextator` | The `service.name` resource attribute on every span. Only read when tracing is on. |

Contextator reads these two itself and hands the address to the exporter. The OpenTelemetry SDK also reads
some `OTEL_*` variables from the environment on its own, which Contextator does not stop (headers, timeout,
compression and TLS files for the exporter, batching, sampler and span limits): this is the one exception
to "the environment is read only in `config.ts`", and a host-wide `OTEL_TRACES_SAMPLER=always_off` would
silently record nothing. The list, checked against the pinned versions, is in
[Observability](observability.md#variables-the-opentelemetry-sdk-reads-itself), which also describes the
spans, the trace-context propagation and the dashboard that goes with `/metrics`.

## Source links and the "unchanged for a long time" mark

Search and `read_document` answers carry the link to the original document (`sourceUrl`) and the date it last
changed there (`sourceModifiedAt`) when the source knows them: a git source links to the file at the indexed
commit, Notion and Confluence to the page, a web source to the final URL after redirects. A local directory has a
modification time but no link, and an upload has neither. Credentials in a git remote are never stored or shown.

A git repository has no per-file date in a shallow clone, so the date of a git document is the committer date of
the HEAD commit at the run in which the indexer first saw the file's current text. It stays while the text is
unchanged, including through a rebuild (`Re-index now` or a model change), and moves to the new HEAD date when the
text changes. The link is recomputed on every run, so it always points at the commit just indexed. Links are built
for GitHub, GitLab, Gitea/Forgejo and Bitbucket Cloud (`bitbucket.org`); a self-hosted Bitbucket has no link.

`SOURCE_STALE_AFTER_DAYS` (default `365`, `0` turns it off) sets how old `sourceModifiedAt` must be before an
answer marks the passage as unchanged for a long time (`stale: true`). It is a hint to the reader, never a filter.

Documents indexed before this feature have neither value until their source runs again.
