/** A conversion thread that never answers — a parser in a loop, which nothing outside it can interrupt. */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => {
  // Deliberately nothing. The point is that the promise on the far side still settles.
});
