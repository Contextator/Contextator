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
