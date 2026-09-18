# Configuration reference

All settings are environment variables read from `.env` (or the container environment).

## Server

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3444` | HTTP port for the dashboard and MCP endpoints |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_TOKEN` | empty | When set, `/api/*` requires `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call `/mcp/*` |
| `PUBLIC_BASE_URL` | empty | Base URL used in the MCP URLs shown by the dashboard |
| `SESSION_IDLE_TTL_MS` | `1800000` | Idle Streamable HTTP sessions are closed after this long |

## Documents

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALLOWED_DOC_ROOTS` | `/docs` | Comma-separated directories a project root may live in |
| `DOCS_HOST_PATH` | `./docs` | Host folder mounted at `/docs` by docker-compose |
| `IGNORE_GLOBS` | empty | Comma-separated globs of files to skip while indexing |

## Embeddings

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMBEDDING_PROVIDER` | `local` | `local` (transformers.js on CPU) or `openai` |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Hugging Face model id for the local provider |
| `EMBEDDING_DIMENSIONS` | `384` | Vector size; must match the model (1536 for `text-embedding-3-small`) |
| `EMBEDDING_DTYPE` | `fp32` | `fp32`, `fp16` or `q8` (quantized, smallest download) |
| `EMBEDDING_BATCH_SIZE` | `16` | Chunks embedded per model call |
| `MODEL_CACHE_DIR` | `.cache/models` | Where downloaded models are stored |
| `OPENAI_API_KEY` | empty | Required when the provider is `openai` |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI model id |

Changing `EMBEDDING_DIMENSIONS` after data exists requires starting once with
`RESET_VECTORS=1`, which drops every chunk so projects can be re-indexed.

## Chunking

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHUNK_MAX_TOKENS` | `96` | Target chunk size, counted with the embedding model's own tokenizer |
| `CHUNK_OVERLAP_TOKENS` | `24` | Overlap between consecutive chunks of one section |

Chunks are split at Markdown headings first. Sections that are still too long are split at
paragraph boundaries, and fenced code blocks are kept intact whenever possible.
