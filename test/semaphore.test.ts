import { describe, expect, it } from 'vitest';

import { Semaphore } from '../src/services/locks.js';

describe('Semaphore', () => {
  it('hands out `limit` slots and refuses the next tryAcquire', () => {
    const slots = new Semaphore(2);
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(false);
    slots.release();
    expect(slots.tryAcquire()).toBe(true);
  });

  it('wakes waiters in arrival order and keeps a released slot from tryAcquire while someone waits', async () => {
    const slots = new Semaphore(1);
    await slots.acquire();
    const order: string[] = [];
    const first = slots.acquire().then(() => order.push('first'));
    const second = slots.acquire().then(() => order.push('second'));
    slots.release();
    await first;
    expect(order).toEqual(['first']);
    expect(slots.tryAcquire()).toBe(false);
    slots.release();
    await second;
    expect(order).toEqual(['first', 'second']);
    slots.release();
    expect(slots.tryAcquire()).toBe(true);
  });
});
