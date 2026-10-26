/**
 * The tools the server knows, by name. `contextator_mcp_requests_total` takes its `tool` label from this
 * list and nothing else (`toolLabel`), and `MCP_RATE_LIMIT_TOOLS` validates its keys against it
 * ([ADR-0112](../../.ssot/ADR.md#adr-0112)); `test/mcp-metrics.test.ts` holds it equal to the names
 * `registerTools` can register, so a further tool cannot be added without it being counted by name.
 *
 * **`tools/list` is a conditional subset of this list, not the list**
 * ([ADR-0125](../../.ssot/ADR.md#adr-0125), decision 8). `report_gap` is registered only while the query
 * log is on, for the instance and for the project, so the two are equal while the log is on and differ by
 * exactly `report_gap` while it is off. `test/integration/mcp-headers-metrics.itest.ts` holds them to that.
 *
 * It lives in a module of its own so that `config.ts` can read it without importing the tool handlers.
 */
export const MCP_TOOL_NAMES: readonly string[] = ['search_docs', 'list_topics', 'read_document', 'whats_new', 'report_gap'];
