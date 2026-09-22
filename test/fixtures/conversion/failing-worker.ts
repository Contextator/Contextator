/** A conversion thread reporting a failure that is *not* a refusal: a broken run, not a bad file. */
import { parentPort } from 'node:worker_threads';

import type { ConversionRequest } from '../../../src/services/conversion/protocol.js';

parentPort?.on('message', (request: ConversionRequest) => {
  parentPort?.postMessage({ id: request.id, ok: false, refusal: false, message: 'the connection pool is gone' });
});
