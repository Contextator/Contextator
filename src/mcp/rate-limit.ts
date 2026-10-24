import type { Config } from '../config.js';
import type { McpAuthMode } from '../db/schema.js';
import type { RateLimitCheck, RateLimitDenial } from '../services/rate-limit.js';
import { rateLimitAddressKey } from '../services/net-address.js';
import { MCP_TOOL_NAMES } from './tool-names.js';
import type { McpCredential } from './access.js';

/**
 * The request-side half of MCP rate limiting ([ADR-0112](../../.ssot/ADR.md#adr-0112)): which messages of
 * a POST body count, which counters they are held against, and what a refusal says. Pure, so the
 * decisions are unit tests; the counting itself is `McpRateLimiter` and the replying is the router's.
 */

/**
 * JSON-RPC methods that are never a hit. `initialize` and `ping` are how a client connects and stays
 * connected, and a limit that can starve them turns "too busy" into "cannot connect"; notifications
 * (`notifications/*`) are not requests at all.
 */
export const METHODS_EXEMPT: ReadonlySet<string> = new Set(['initialize', 'ping']);

/** What one POST body costs: the requests that count, and how many of those call each limited tool. */
export interface MessageCost {
  requests: number;
  tools: ReadonlyMap<string, number>;
}

/**
 * Counts the JSON-RPC **requests** in a body, a batch message by message. A message is a request when it
 * names a method and carries an id; a notification (no id), a posted response (no method) and anything
 * that is not JSON-RPC at all cost nothing, and neither do the exempt methods. The tool is read from
 * `params.name` of a `tools/call` and only counted when it is one of ours: the `Mcp-Name` header is a
 * convenience of the 2026 envelope that a legacy client never sends, so the body is the one source both
 * eras share.
 */
export function messageCost(body: unknown): MessageCost {
  let requests = 0;
  const tools = new Map<string, number>();
  for (const message of Array.isArray(body) ? body : [body]) {
    if (message === null || typeof message !== 'object') continue;
    const { method, id, params } = message as { method?: unknown; id?: unknown; params?: unknown };
    if (typeof method !== 'string' || id === undefined) continue;
    if (METHODS_EXEMPT.has(method) || method.startsWith('notifications/')) continue;
    requests += 1;
    if (method !== 'tools/call') continue;
    const name = params !== null && typeof params === 'object' ? (params as { name?: unknown }).name : undefined;
    if (typeof name === 'string' && MCP_TOOL_NAMES.includes(name)) tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return { requests, tools };
}

type RateLimitConfig = Pick<Config, 'MCP_RATE_LIMIT_PER_MINUTE' | 'MCP_RATE_LIMIT_ANON_PER_MINUTE' | 'MCP_RATE_LIMIT_TOOLS'>;

/**
 * The counters one request is held against, in the order they are tried: the caller's own ceiling first,
 * then each limited tool it called.
 *
 * **Whose bucket.** A request that resolved to a token or an account is `tok:<tokenId>`. Anything else
 * that was served is anonymous, and only an `open` project serves an anonymous request, so that bucket is
 * `ip:<projectId>:<address>` — an IPv6 address by its /64. A credential that did not resolve to a live
 * token or account (a wrong Bearer on an `open` project, a disabled account's token) is anonymous too:
 * counting it under its own key would let a junk `Authorization` header step around the anonymous limit.
 * A request that fails authentication never gets here at all, so it is never counted.
 *
 * A limit of `0` is off. With every limit off the list is empty and the caller skips the database.
 */
export function rateLimitChecks(input: {
  config: RateLimitConfig;
  projectId: string;
  mcpAuth: McpAuthMode;
  credential: McpCredential;
  tokenId: string | null;
  ip: string | undefined;
  cost: MessageCost;
}): RateLimitCheck[] {
  const { config, cost } = input;
  if (cost.requests === 0) return [];

  const identified = (input.credential.kind === 'bearer' || input.credential.kind === 'account') && input.tokenId !== null;
  let base: string;
  let limit: number;
  let scope: 'token' | 'anonymous';
  if (identified) {
    base = `tok:${input.tokenId}`;
    limit = config.MCP_RATE_LIMIT_PER_MINUTE;
    scope = 'token';
  } else if (input.mcpAuth === 'open') {
    base = `ip:${input.projectId}:${rateLimitAddressKey(input.ip)}`;
    limit = config.MCP_RATE_LIMIT_ANON_PER_MINUTE;
    scope = 'anonymous';
  } else {
    return [];
  }

  const checks: RateLimitCheck[] = [];
  if (limit > 0) checks.push({ key: base, limit, scope, cost: cost.requests });
  for (const [name, calls] of cost.tools) {
    const toolLimit = config.MCP_RATE_LIMIT_TOOLS[name];
    if (toolLimit !== undefined && toolLimit > 0)
      checks.push({ key: `${base}:tool:${name}`, limit: toolLimit, scope: 'tool', cost: calls, tool: name });
  }
  return checks;
}

/** The sentence a refused client reads: whose limit, how big, and when to come back. */
export function rateLimitMessage(denial: RateLimitDenial): string {
  const subject = denial.scope === 'token' ? 'this token' : denial.scope === 'anonymous' ? 'this address' : `the tool "${denial.tool ?? 'unknown'}"`;
  const seconds = denial.retryAfterSec;
  return `Rate limit exceeded for ${subject}: ${denial.limit} requests per minute. Retry after ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}
