/** A conversion thread whose failure is an uncaught exception rather than an exit. */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => {
  throw new Error('the parser took the thread with it');
});
