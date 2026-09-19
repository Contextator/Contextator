# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

**Before `1.0.0`, a minor version may change a public contract** — the HTTP and MCP APIs, the MCP
tool names and their parameters, environment variable names — without a major bump. Once `1.0.0`
ships, that stops.

## [Unreleased]

## [0.1.0] - 2026-09-19

First published release. `0.1.0` describes what the product does, not what changed to get there.

### Added

- A self-hosted, multi-tenant MCP documentation server: give a project its document sources and it
  becomes its own `/mcp/<project-name>` endpoint that AI agents can search.
- Source types: local directories, git repositories, uploaded files and archives (`.zip`, `.tar`,
  `.tar.gz`, `.rar`), Notion workspaces and Confluence Cloud sites.
- Document conversion to Markdown for `.html`, `.docx`, `.csv` and `.pdf` files, so an agent reads
  them the way it reads a page of documentation.
- An OpenAPI/Swagger content type: a specification is indexed as one document per operation, not
  as a single file, so a hit is the endpoint rather than the whole spec.
- Hybrid search: vector similarity and keyword search fused with reciprocal rank fusion, over
  chunks that carry a heading breadcrumb.
- Local embeddings on the CPU by default (`multilingual-e5-small`, covering 100 languages), with
  `EMBEDDING_DTYPE` to trade model size against precision (fp32/fp16/q8), or OpenAI embeddings as
  an alternative. Search within a language is strong; cross-language search is a known limit and
  is documented as one in the README rather than fixed.
- An admin dashboard and REST API to manage projects, sources and members — the normal way to add
  a source and trigger a re-index.
- MCP access on one URL per project, both transports: Streamable HTTP and legacy HTTP+SSE. Tools:
  `search_docs`, `list_topics`, `read_document`.
- Three settings for an MCP endpoint: open, a static bearer token, or account-backed access through
  OAuth 2.1 — the last so browser-based connectors can sign in.
- Accounts, roles and per-project memberships, with `ADMIN_TOKEN` for scripts and CI.
- An audit log and a per-query log of what agents asked and what they were told.
- Incremental indexing: files are hashed, only changed files are re-embedded, removed files are
  deleted from the index.
- One Docker image, `contextator/contextator`, for `linux/amd64` and `linux/arm64`, holding both
  PostgreSQL and the app. The schema updates itself on startup, and `npm run reset-password` ships
  inside the image as a last-resort recovery tool.

[Unreleased]: https://github.com/Contextator/Contextator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Contextator/Contextator/releases/tag/v0.1.0
