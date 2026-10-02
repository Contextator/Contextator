/**
 * The real conversion thread, plus a parser that keeps allocating on one file type — the shape of a
 * file built to exhaust the heap (ADR-0097).
 *
 * Same arrangement as `pdf-crashing-worker.ts`: the static import registers the real handler first and
 * the listener below is added in the same synchronous evaluation. A `.pdf` reaches the real handler and
 * then this loop, which never yields, so the thread dies at the heap cap before it can answer; every
 * other file is converted normally. That lets one service show a refusal and a recovery in sequence.
 */
import { parentPort } from 'node:worker_threads';

import '../../../src/services/conversion/worker.js';
import type { ConversionRequest } from '../../../src/services/conversion/protocol.js';

parentPort?.on('message', (request: ConversionRequest) => {
  if (!('relativePath' in request) || !request.relativePath.endsWith('.pdf')) return;
  const held: number[][] = [];
  for (;;) held.push(new Array<number>(1_000_000).fill(held.length));
});
