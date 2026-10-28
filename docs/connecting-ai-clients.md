# Connecting AI clients

Point Claude Code, Cursor, Claude Desktop or any other MCP client at `http://localhost:3444/mcp/<project>`
— the dashboard's **Connect** panel prints the exact snippet, token header included when the project
requires one. Four read-only tools are exposed: `search_docs` (hybrid search, ranked excerpts),
`list_topics` (the indexed document list), `read_document` (one file's Markdown, by path or heading
range) and `whats_new` (what was added, changed or removed since a point in time). A fifth, `report_gap`, lets an
agent tell the maintainers what the documentation did not answer; it writes to its own table (`reported_gaps`) under the query log's
retention and purge, never to documentation, and is absent while the query log is off. See [MCP access](mcp-access.md) for the auth modes and the tools' arguments.

Beside the tools, each project publishes its documents as MCP resources and two read-only **prompts**,
`answer_from_docs` (argument `question`) and `explore_topic` (argument `topic`). A prompt reads nothing and
changes nothing: it returns one user message telling the model which tools to call and to cite file paths.

**Two protocol eras on one URL.** `/mcp/<project>` serves MCP 2025-11-25 and 2026-07-28 side by side. A request
whose body carries the 2026 `_meta` envelope is answered statelessly — no `initialize`, no `Mcp-Session-Id`,
nothing held in the session registry — and a 2026 client can ask `server/discover` for the protocol versions and
capabilities the server offers before it calls `tools/call search_docs`. Every other request, an `initialize`
included, takes the session path as before, so a 1.x SDK client and a legacy SSE client keep working; 0.3.0 does change three things they can see (see the `CHANGELOG.md` **Breaking** entries): a missing resource is `-32602` where it was `-32002`, each tool's input schema is JSON Schema draft 2020-12 where it was draft-07 and no longer carries `execution.taskSupport`, and an input-validation error reads `Input validation error: Invalid arguments for tool search_docs: query: …`.
A 2026 request must repeat the protocol version in `MCP-Protocol-Version`, the method in `Mcp-Method` and, on
`tools/call`, `resources/read` and `prompts/get`, the tool name, URI or prompt name in `Mcp-Name`; the SDK
refuses one that does not. A 2025-11-25 request is asked for none of these.

**What differs for a 2026-07-28 client.** Its answers always carry each tool's `outputSchema` and
`structuredContent` beside the text, whatever `MCP_STRUCTURED_OUTPUT` says; that flag now governs 2025-11-25
clients only and is still off by default, so with it off a legacy answer gains no `outputSchema` or `structuredContent`. Its `tools/list`,
`resources/list` and `resources/read` carry a per-project cache hint: `ttlMs` is a tenth of the time since the
project's last successful index, capped at an hour and `0` while the project is indexing, before its first
index or after a failed index run, and `cacheScope` is `public` only for an `open` project and `private` otherwise. Deleting a source or
changing a project's MCP access does not reset the hint, so a client can see the earlier answer for up to an
hour. A legacy answer gains none of this.

Ready-to-paste config for every client, structured output, MCP resources and the relevance floor:
[Connecting AI Clients](https://contextator.com/en/docs/connecting-ai-clients/) and
[MCP Tools](https://contextator.com/en/docs/mcp-tools/).
