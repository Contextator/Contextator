/**
 * Where a static MCP token's source scope applies, name by name ([ADR-0133](../../.ssot/ADR.md#adr-0133),
 * decision 4). **The guard against a forgotten read path**: `test/mcp-token-scope.test.ts` holds these two
 * tables equal to `MCP_TOOL_NAMES` and to the handlers `registerResources` installs, so a tool or a resource
 * method added later fails a test until it is listed here, and `test/integration/token-scope.itest.ts` then
 * demands a negative assertion for every entry that says `applies: true`.
 *
 * A `false` entry carries the reason the decision table gives, in the table's words. The reason is the claim
 * under test as much as the flag is: "reads no document, path or source name" is checked by reading the code
 * path, and the day the path starts to, this entry is the one to change.
 */
export type ScopeDisposition = { applies: true } | { applies: false; reason: string };

/** Keyed by the name `registerTools` registers. */
export const TOOL_SCOPE: Readonly<Record<string, ScopeDisposition>> = {
  search_docs: { applies: true },
  list_topics: { applies: true },
  read_document: { applies: true },
  whats_new: { applies: true },
  report_gap: { applies: false, reason: 'only writes a report under the token id; it reads no document, path or source name' },
};

/** Keyed by the JSON-RPC method `registerResources` installs a handler for. */
export const RESOURCE_METHOD_SCOPE: Readonly<Record<string, ScopeDisposition>> = {
  'resources/list': { applies: true },
  'resources/read': { applies: true },
  'resources/templates/list': { applies: false, reason: 'reads no document, path or source name; it names the project and a URI template' },
};

/**
 * The surfaces that are not a tool or a resource method, each with its disposition. They are not enumerable
 * from code, so the itest asserts them by name, and this is their one list.
 */
export const OTHER_SCOPE: Readonly<Record<string, ScopeDisposition>> = {
  prompts: { applies: false, reason: 'reads no table and runs no search' },
  initialize: { applies: false, reason: 'names the project and general guidance; it names no source' },
  'server/discover': { applies: false, reason: "the 2026-07-28 era's initialize: it names the project and general guidance, no source" },
  'tools/list': { applies: false, reason: 'names the tools; it names no source' },
  'dashboard search': { applies: false, reason: 'a ctxm_ token does not reach /api/*: 401' },
  export: { applies: false, reason: 'a ctxm_ token does not reach /api/*: 401' },
  'query-log panel': { applies: false, reason: 'a ctxm_ token does not reach /api/*: 401' },
};
