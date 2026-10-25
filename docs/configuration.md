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

`TRUST_PROXY=1`/`true` ("trust every hop") was deprecated in 0.4.1 and is refused at startup since 0.5.0
(ADR-0122): the process exits with a message that names the value. Name the proxy instead (`loopback`, its
address or its CIDR block), or use `0` when nothing is in front. An upgrade from 0.4.x with `TRUST_PROXY=1` set
is therefore a one-line change to the environment, and it is needed before the new version will start.

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

`REINDEX_ON_MODEL_CHANGE=1` (off by default) removes the button press. On start-up the server queues one
re-index for every project that was indexed with a different model than the one it now runs and that has at
least one source, scheduled or not. A project that was never indexed, or has no source, is left alone. The
runs go through the normal queue, so the indexer's concurrency limit spreads them out, and each one is
logged with the reason; a run refused for lack of disk space is recorded in the project's run history like
any other. With the flag off, nothing changes: such a project answers `model_mismatch` until someone
re-indexes it.

A relevance floor is a number about one encoder, so a project's own floor (`PATCH
/api/projects/:id/score-floor`) stops meaning anything once its index is rebuilt with another model. When a
re-index finishes because the model changed, the server measures the project against its new index and
stores a **floor suggestion**: the highest floor, on a 0.001 grid from 0.6 to 0.99, that still answers
every probe, where a probe is the last eight words of a sentence (for Chinese and Japanese text, which has no spaces between words, the tail of the sentence that weighs 16, a character counting 1 and a Latin word 2, cut at a word boundary; other scripts written without spaces, such as Thai, Lao, Khmer and Burmese, are not recognised and give `insufficient_data`) taken from one of up to 100 of the
project's own chunks (never the chunk's heading, which the chunk is embedded with and would match too well).
A manager can also ask for one at any
time with `POST /api/projects/:id/score-floor/suggestions`, read them with `GET` on the same path, and adopt
one with `POST .../suggestions/:suggestionId/apply`. Nothing is applied automatically: the project keeps
the floor it had until a manager applies a suggestion, and a suggestion measured against an earlier model
or index generation is refused. A project that yields fewer than 20 probes (little prose, or little content)
is not measured and gets no suggestion; the response says so. The same arithmetic is what
`scripts/floor-calibration.ts` runs against labelled question sets.

**Treat a suggestion as an upper bound in most corpora, not as a guarantee.** A probe is a fragment of the
text it should find, which scores higher than a question a person would write about it, so the suggested
floor usually sits above the one that real questions would justify, and a floor set too high refuses
questions the project does answer. It is not always above: measured against the floor fitted from labelled
questions on the four reference corpora, prose documentation landed on either side of it, within 0.013
(the repository's synthetic documentation 0.791 and 0.804 against 0.804, in two runs; the product's user
wiki 0.805 and 0.817 against 0.811), while XQuAD stayed 0.027 to 0.045 above it (Turkish 0.820 and 0.802
against 0.775, English 0.782 and 0.774 against 0.738). Two runs over the same project differ as well,
because each samples other chunks: 0.018 on XQuAD Turkish, so a single run says less than its third
decimal suggests. Before applying one, look at what it would have refused among your logged searches with `GET
/api/projects/:id/score-floor/preview?floor=<n>`, and check it in both directions: lower it by a few
hundredths when it refuses something the project answers, and raise it when it lets through questions the
project cannot answer.

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

## MCP rate limits and token networks

`MCP_RATE_LIMIT_PER_MINUTE` (default `0`, off), `MCP_RATE_LIMIT_ANON_PER_MINUTE` (default `60`),
`MCP_RATE_LIMIT_TOOLS` (`name=count` pairs, default none) and `MCP_RATE_LIMIT_FAIL_OPEN` (default `1`; `0`
answers `503` when the counter is unreachable) limit how often a token, an anonymous address or a tool may be
called. How they count, what the `429` looks like and what an upgrade changes are in
[MCP access](mcp-access.md#limiting-how-much-a-client-may-ask-for). A per-token network allowlist depends on
`TRUST_PROXY` being exact: [the table](mcp-access.md#restricting-a-static-token-to-a-network) says what each value
trusts. `TRUST_PROXY=1` (refused at startup since 0.5.0) is not among them.

## Project quotas

Three caps limit how much one project may hold, so a runaway source or upload cannot fill the disk or the
database on behalf of everyone else:

| Variable | Caps | Checked |
| --- | --- | --- |
| `PROJECT_MAX_DOCUMENTS` | documents in the project | before a run writes anything |
| `PROJECT_MAX_CHUNKS` | chunks in the project | per document, before it is embedded |
| `PROJECT_MAX_UPLOAD_BYTES` | bytes stored for the project's upload sources, staging included | per upload request and at commit |

Each is an integer of at least `0`, and `0` (the default) is unlimited, so an upgrade changes nothing until you
write a number. They are the instance default: an instance admin can give one project its own value through
`PATCH /api/projects/:id/quotas`, which replaces the instance value for that project in both
directions, and `0` there exempts the project even when the instance sets a cap. Clearing a project's value
(`null`) makes it follow the instance again.

A breach never loses data that is already searchable:

- An upload that would go over the cap is refused with `413` and `quota_exceeded`; the files of that request
  are removed from staging and the files of the session's earlier requests stay.
- A run that would go over the document or chunk cap stops with the error `quota_exceeded`. A re-index
  (rebuild) publishes nothing, so the previous generation keeps answering; a normal run leaves the documents it
  had finished writing in place and does not remove any. Either way the project stays searchable, and the run
  is retried like any other failed run once the cap is raised or content is removed.
- If the size of an upload source cannot be measured, the upload is refused with `503` rather than let through.

What the upload cap counts:

- Everything the project's upload sources store: each source's `current/` tree plus the staging of every open
  upload session, the requesting session's own staging included once. A file that overwrites a stored or
  staged file of the same path counts once, as the difference.
- A session that nobody has touched for 24 hours (no `files` request, no commit) stops counting, and the
  server deletes it: a sweep that runs every quarter of an hour removes the session's staged files, so what the
  quota counts and what is on disk agree to within about a quarter of an hour. A removal that fails, or a project
  that is busy indexing or committing at that moment, is retried on the next tick; the quota ignores an expired
  session meanwhile. **An upload that was not committed within 24 hours of its
  last request is lost** and has to be uploaded again. This applies to every project, whether or not it has an
  upload quota.
- The cap is checked by walking the upload directories, so each `files` request pays one walk over the
  project's upload trees before it writes. With many thousands of staged files this is noticeable per request;
  an unlimited project (`0`) skips the walk entirely.

## Limits on converted files

`MAX_CONVERTED_FILE_BYTES` (default `33554432`, 32 MiB) bounds two things for every type that is converted
before indexing: what the file may weigh before it is parsed, and, for `.pptx`, `.xlsx`, `.ipynb`, `.rst` and
`.adoc`, what it may convert to. A small file can describe a lot of output, so the converters count the output
as they write it. A file over either limit is refused by name, with the reason on its source (for example
`renders to more than the 32 MiB`), and the run carries on. Raise it if your corpus genuinely holds bigger
documents and the host has the memory.

`MAX_DOCX_UNPACKED_BYTES` (default `268435456`, 256 MiB) bounds what an Office Open XML archive (`.docx`,
`.pptx`, `.xlsx`) may unpack to. The sizes the archive declares are checked before anything is inflated, and
each part is inflated through a counter, so an archive that lies about its sizes is still stopped at this limit.

`CONVERSION_WORKER_MAX_HEAP_MB` is unset by default, which means the conversion thread's heap has no cap of its own
and grows up to Node's default. Set it, in MiB, when Contextator runs in a memory-limited container: a file whose
conversion needs more becomes one refused document whose reason names the heap limit, the thread is replaced, and
the run carries on, instead of the kernel OOM-killing the whole process. Size it well below the container's limit.

### Sizing `CONVERSION_WORKER_MAX_HEAP_MB` against the container's memory limit

The product ships no default (ADR-0097): any number would refuse a file
that indexes today on somebody's host. What follows is how to choose one, and the measurements it rests on.

**Rule of thumb.** The cap counts the conversion thread's JavaScript heap only. The container sees more than that:
the rest of the server (about 800 MiB resident with the fp32 embedding model warm, see the Helm chart's *Resource
sizing*), the thread's own baseline, the file's bytes, and what the parser holds outside the heap. In the
three largest runs below, with a cap just high enough to convert, resident memory ended 160 to 390 MiB above the cap. So:

```
CONVERSION_WORKER_MAX_HEAP_MB  <=  container memory limit  -  800 MiB (server)  -  400 MiB (outside the heap)
```

| Container memory limit | Suggested `CONVERSION_WORKER_MAX_HEAP_MB` | What it converts, from the table below |
|---|---|---|
| under 1.5 GiB | the formula's result (`80` at 1.25 GiB); nothing at or under 1200 MiB | spreadsheets of a few tens of thousands of rows and PDFs of a few hundred pages; raise the limit for more |
| 2 GiB (the Helm chart's default `resources.limits.memory`) | `384` to `512` | every case measured, including a 2000-page PDF |
| 3 GiB | `768` | the same, with room for bigger spreadsheets |
| 4 GiB | `1024` to `1536` | the same; raising it further only helps files near `MAX_CONVERTED_FILE_BYTES` |

A cap that is too low costs one refused file, and the refusal's reason names the setting, so it is safe to start at
the low end and raise it when a refusal you care about appears. A cap higher than the formula allows is the case to
avoid: it is a cap the kernel reaches first.

**What the numbers are.** Each row is one file converted through `ConversionService` (the same thread the indexer
uses), in a fresh process, against a build of `dist/`. *Peak RSS* is `process.resourceUsage().maxRSS` of that
process with no cap set, which includes the thread, its libraries and the server-side client but not the rest of
the server. *Smallest cap that converts* is the lowest of a ladder (4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192,
256, 384, 512 MiB, whichever apply) at which the same file came back converted instead of refused, so it is an
upper bound within one step. Measured on macOS arm64 with Node 24.20 (the image runs Node 22; expect the same order
of magnitude, not the same digits).

| File | Input | Markdown out | Peak RSS (no cap) | Smallest cap that converts | Time (no cap) |
|---|---|---|---|---|---|
| `test/fixtures/doc-types/platform-roadmap.pptx` | 7 KiB | 444 B | 72 MiB | 16 MiB | 0.05 s |
| `test/fixtures/doc-types/warehouse-inventory.xlsx` | 4 KiB | 198 B | 72 MiB | 8 MiB | 0.03 s |
| `test/fixtures/doc-types/support-handbook.pdf` (3 pages) | 4 KiB | 945 B | 92 MiB | 16 MiB | 0.07 s |
| generated `.pptx`, 1000 slides | 0.55 MiB | 0.1 MiB | 100 MiB | 12 MiB | 0.07 s |
| generated `.xlsx`, 20,000 rows x 6 columns | 0.56 MiB | 1.1 MiB | 136 MiB | 32 MiB | 0.13 s |
| generated `.xlsx`, 200,000 rows x 6 columns | 5.7 MiB | 12 MiB | 517 MiB | 128 MiB | 0.9 s |
| generated `.pdf`, 200 pages of text | 1.3 MiB | 0.9 MiB | 322 MiB | 48 MiB | 0.8 s |
| generated `.pdf`, 2000 pages (`MAX_PDF_PAGES`) | 13 MiB | 9 MiB | 2089 MiB | 384 MiB | 44 s |

The fixtures are a few kilobytes, so their rows measure the floor, not the cost of a real document: a thread that
has loaded one converter sits at 70 to 90 MiB resident, and a cap under about 16 MiB refuses even them. The
generated rows are built from the fixtures' own parts, repeated (the slides are identical, so that row understates
a real deck; spreadsheet cells and PDF lines are varied text), to show how each type scales: PDFs are the expensive
type, spreadsheets scale with row count, presentations are cheap.

Two things in the measurements are worth knowing before choosing a number:

- **A cap also bounds the resident size, at the price of time.** The 2000-page PDF peaked at 2089 MiB with no cap
  and finished in 44 s; with the cap at 384 MiB it peaked at 640 MiB and took 75 s, because V8 collects far more
  often when it has no room. That is the setting working as intended in a small container, and it is also why
  `CONVERSION_TIMEOUT_MS` (default 120 s) matters more under a cap: on a slower host the same file can run into the
  timeout before it runs into the heap.
- **The cap does not bound everything.** Spreadsheet peaks were nearly the same capped at 128 MiB (514 MiB) as with
  no cap (517 MiB): most of that memory is the inflated archive and the buffers around it, outside the heap. That
  is what the 400 MiB allowance in the formula is for, and why a cap alone does not make a 512 MiB container safe.

[File types](file-types.md) lists what each type keeps and drops.
