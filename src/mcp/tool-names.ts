/**
 * The tools `registerTools` registers, by name. `contextator_mcp_requests_total` takes its `tool` label
 * from this list and nothing else (`toolLabel`), and `MCP_RATE_LIMIT_TOOLS` validates its keys against
 * it ([ADR-0112](../../.ssot/ADR.md#adr-0112)); `test/mcp-metrics.test.ts` holds it equal to the names
 * `registerTools` registers, and `test/integration/mcp-headers-metrics.itest.ts` to what `tools/list`
 * answers, so a further tool cannot be added without it being counted by name.
 *
 * It lives in a module of its own so that `config.ts` can read it without importing the tool handlers.
 */
export const MCP_TOOL_NAMES: readonly string[] = ['search_docs', 'list_topics', 'read_document', 'whats_new'];
