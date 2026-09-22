/**
 * The real conversion thread, plus a parser that takes the thread down on one file type.
 *
 * The static import registers the real handler first; the listener below is added in the same
 * synchronous module evaluation, so both are in place before the port can deliver anything. A `.pdf`
 * therefore reaches the real handler and then kills the thread before it can answer — which is what an
 * OOM kill or a native crash inside a parser looks like from the main process.
 */
import { parentPort } from 'node:worker_threads';

import '../../../src/services/conversion/worker.js';
import type { ConversionRequest } from '../../../src/services/conversion/protocol.js';

parentPort?.on('message', (request: ConversionRequest) => {
  if ('relativePath' in request && request.relativePath.endsWith('.pdf')) process.exit(3);
});
