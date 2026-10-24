import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mcpRateLimits } from '../db/schema.js';
import type { RateLimitScope } from './metrics.js';

/**
 * In-memory sliding window, one bucket per key (an IP, usually). Small enough to stay honest:
 * this bounds how fast a single host can guess, while the per-account lock in services/auth/users.ts
 * bounds how fast one account can be guessed from many hosts.
 *
 * The clock is a parameter so the whole thing is a pure unit test.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt. Returns 0 when it is allowed, or the seconds to wait when it is not. */
  hit(key: string): number {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.ceil((recent[0] + this.windowMs - t) / 1000);
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }

  /** A successful sign-in clears the host's budget. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Drops buckets whose every hit has aged out; called by the session reaper. */
  sweep(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= cutoff)) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/** One counter an MCP request is held against: the bucket, its ceiling, what exceeding it is called, and how many hits this request is. */
export interface RateLimitCheck {
  key: string;
  limit: number;
  scope: RateLimitScope;
  /** A batch of n JSON-RPC requests is n hits; always at least 1. */
  cost: number;
  /** Set on a per-tool check, so a refusal can name the tool. */
  tool?: string;
}

/** The first counter a request went over. */
export interface RateLimitDenial {
  retryAfterSec: number;
  scope: RateLimitScope;
  limit: number;
  /** The tool whose own ceiling was hit, for a `tool` scope. */
  tool?: string;
}

/** How long a counter row is kept after its window closed. Far longer than any window, so a late write from a replica with a slow clock still finds its row. */
export const MCP_RATE_LIMIT_RETAIN_MINUTES = 10;

/**
 * The MCP rate limiter's counter ([ADR-0112](../../.ssot/ADR.md#adr-0112)): a fixed window per key, one
 * row in `mcp_rate_limits` and one upsert per check, so every replica of the server counts into the same
 * place and nothing is held in memory. It answers the way `SlidingWindow` does: `0` when the request may
 * go on, otherwise what it was refused for and the seconds until the window closes.
 *
 * The window start comes from this process (`now`), not from the database: the clock is a parameter for
 * the same reason it is on `SlidingWindow`, so a test steps through windows without waiting. Two replicas
 * whose clocks disagree by less than a window put a request in adjacent windows at worst, and `greatest`
 * in the statement means an older clock can never move a row backwards.
 *
 * A fixed window admits up to twice the limit across a window boundary. That is the price of one cheap
 * statement, and it is stated in `docs/mcp-access.md` rather than discovered.
 */
export class McpRateLimiter {
  constructor(
    private readonly db: Db,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Counts the request against each check in order and stops at the first one it is over, so a request
   * refused by its token's ceiling does not also spend the tool's. A refused request still counts: the
   * window is a measure of what was asked, not of what was served. Throws when the statement fails; the
   * caller decides between serving the request and refusing it (`MCP_RATE_LIMIT_FAIL_OPEN`).
   */
  async hit(checks: readonly RateLimitCheck[]): Promise<0 | RateLimitDenial> {
    const t = this.now();
    const windowStartMs = Math.floor(t / this.windowMs) * this.windowMs;
    const windowStart = new Date(windowStartMs);
    for (const check of checks) {
      const [row] = await this.db
        .insert(mcpRateLimits)
        .values({ key: check.key, windowStart, count: check.cost })
        .onConflictDoUpdate({
          target: mcpRateLimits.key,
          set: {
            count: sql`case when ${mcpRateLimits.windowStart} < excluded.window_start then excluded.count else ${mcpRateLimits.count} + excluded.count end`,
            windowStart: sql`greatest(${mcpRateLimits.windowStart}, excluded.window_start)`,
          },
        })
        .returning({ count: mcpRateLimits.count });
      if (row.count > check.limit) {
        return {
          retryAfterSec: Math.max(1, Math.ceil((windowStartMs + this.windowMs - t) / 1000)),
          scope: check.scope,
          limit: check.limit,
          ...(check.tool ? { tool: check.tool } : {}),
        };
      }
    }
    return 0;
  }

  /** Drops counters whose window closed long ago; run from the scheduler tick. Returns how many rows went. */
  async sweep(): Promise<number> {
    const removed = await this.db
      .delete(mcpRateLimits)
      .where(lt(mcpRateLimits.windowStart, sql`now() - ${`${MCP_RATE_LIMIT_RETAIN_MINUTES} minutes`}::interval`))
      .returning({ key: mcpRateLimits.key });
    return removed.length;
  }
}
