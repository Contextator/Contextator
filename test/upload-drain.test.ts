import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { drainPart } from '../src/admin/upload-routes.js';

/** Resolves false when the promise is still pending after a beat — i.e. the request would hang. */
async function settles(promise: Promise<void>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
}

const sink = (): Writable => new Writable({ write: (_chunk, _enc, cb) => cb() });

describe('drainPart', () => {
  it('returns at once for a part the handler already consumed', async () => {
    // What addFile does with an archive before unpacking it; unpacking is what then fails.
    const part = Readable.from(['archive bytes']);
    await pipeline(part, sink());
    expect(await settles(drainPart(part))).toBe(true);
  });

  it('drains a part that was never read', async () => {
    const part = Readable.from(['one', 'two']);
    expect(await settles(drainPart(part))).toBe(true);
    expect(part.readableEnded).toBe(true);
  });

  it('returns for a destroyed part', async () => {
    const part = Readable.from(['x']);
    part.destroy();
    expect(await settles(drainPart(part))).toBe(true);
  });
});
