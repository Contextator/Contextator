# Contextator demo documentation

This folder is a small sample documentation set that ships with Contextator so the
quick start works without any configuration. Create a project in the dashboard with the
directory `/docs/demo` and these files get indexed.

## What is Contextator?

Contextator is a self-hosted, multi-tenant MCP (Model Context Protocol) documentation
server. It indexes Markdown and MDX files from folders on your machine into PostgreSQL with
the pgvector extension and exposes every project as its own MCP endpoint:

```
http://localhost:3444/mcp/<project-name>
```

AI coding agents such as Cursor, Claude Code and Claude Desktop connect to that URL and get
three tools: `search_docs`, `list_topics` and `read_document`.

## Why one endpoint per project?

Each project has an isolated document collection and its own vector embeddings. An agent
connected to `/mcp/billing-api` can never see chunks that belong to `/mcp/mobile-app`.
This makes it safe to host documentation for many teams or customers on one server.

## Where to go next

- `guides/getting-started.md` explains the first steps in English.
- `guides/kurulum.md` is the Turkish installation guide.
- `reference/tools.mdx` documents the MCP tools.
- `reference/configuration.md` lists every environment variable.
