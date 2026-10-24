/**
 * Per-key async mutex. The indexer holds a project's lock while syncing and scanning its sources;
 * upload commits and source deletion take the same lock so they never race with a running scan.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}

/**
 * Counting semaphore: at most `limit` holders at once. {@link acquire} waits for a slot in arrival order;
 * {@link tryAcquire} takes one only when it is free right now, and never jumps the queue — a slot that is
 * released while someone waits is handed to that waiter, so `tryAcquire` finds it still taken.
 */
export class Semaphore {
  private held = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.held >= this.limit) return false;
    this.held++;
    return true;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.held--;
  }
}
