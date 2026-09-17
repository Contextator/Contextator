---
title: Getting started
---

# Getting started with Contextator

This guide walks through indexing your first documentation folder and connecting an AI agent.

## Prerequisites

You need Docker with Docker Compose. Nothing else has to be installed on the host: the
embedding model runs on the CPU inside the app container and is downloaded on first start.

## Start the stack

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f app
```

Wait for the log line `embedding model ready`. The first start downloads the model
(roughly 120 MB for the multilingual model) into the `model-cache` volume, so later starts are fast.

## Create a project

Open `http://localhost:3444/` in a browser. Fill in the form:

1. **Project name**: lowercase letters, digits, `-` or `_`. It becomes the URL segment.
2. **Documentation directory**: a path inside the container, for example `/docs/demo`.
   The host folder configured as `DOCS_HOST_PATH` is mounted at `/docs`.
3. Leave **Index now** checked and press **Create**.

The status pill turns from `indexing` to `idle` and shows how many documents and chunks were indexed.

## Connect an agent

Press **Connect** next to the project to see ready-made snippets. For Claude Code the
one-liner is:

```bash
claude mcp add --transport http demo-docs http://localhost:3444/mcp/demo
```

Then ask your agent something like *"how do I configure the embedding model?"* and watch it call `search_docs`.

## Keep the index fresh

Press **Re-index** after editing files. Only files whose content hash changed are
re-embedded, deleted files are removed, and unchanged files are skipped. **Force**
throws away every chunk and rebuilds the project from scratch.
