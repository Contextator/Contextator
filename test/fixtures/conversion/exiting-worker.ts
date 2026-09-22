/** A conversion thread that dies mid-file — the shape of an OOM kill or a native crash in a parser. */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => process.exit(3));
