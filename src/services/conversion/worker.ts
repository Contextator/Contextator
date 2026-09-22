/**
 * The thread every file is converted on ([ADR-0071](../../../.ssot/ADR.md#adr-0071)).
 *
 * **Nothing in here is new logic.** `extractDocument`, `transformContent` and `readOpenApi` are the
 * same functions they have always been, doing the same work in the same order and producing the same
 * bytes; what changed is which thread they run on. That is deliberate: a phase that both moved the
 * work and rewrote it could not tell a conversion defect from a threading one.
 *
 * Two things this file is careful about.
 *
 * **Every reply is a reply.** A request that throws answers with a `FailureReply` rather than letting
 * the exception reach `uncaughtException` — an unanswered request is a promise on the other side that
 * never settles, and the indexer would hang on one bad file instead of refusing it. The one exception
 * is a failure this thread cannot catch (an OOM, a native crash, `process.exit` from inside a
 * parser): the client watches `error` and `exit` for exactly that, because a boundary that only
 * handles the failures it can see is not an isolation boundary.
 *
 * **An expansion's object graph never leaves.** `readOpenApi` parses a specification into a graph
 * about fifty-five times the size of the file ([ADR-0057](../../../.ssot/ADR.md#adr-0057)); the
 * generator it returns is held here and stepped one document at a time, so the main process sees one
 * rendered operation and never the graph. Copying the whole expansion back would hand the memory
 * straight back to the process this exists to protect.
 */

import { parentPort } from 'node:worker_threads';

import { DocumentExtractionError, extractDocument } from '../doc-types/index.js';
import { transformContent } from '../flavors.js';
import { type DerivedDocument, readOpenApi } from '../openapi.js';
import type { ConversionReply, ConversionRequest } from './protocol.js';

if (!parentPort) throw new Error('conversion worker started outside a worker thread');
const port = parentPort;

/** Expansions that have been opened and not yet exhausted, keyed by the id of the `expand` that opened them. */
const sessions = new Map<number, Generator<DerivedDocument>>();

function reply(message: ConversionReply): void {
  port.postMessage(message);
}

function failure(id: number, err: unknown): void {
  const refusal = err instanceof DocumentExtractionError;
  reply({ id, ok: false, refusal, message: err instanceof Error ? err.message : String(err) });
}

async function handle(request: ConversionRequest): Promise<void> {
  switch (request.kind) {
    case 'convert': {
      // `Buffer.from(arrayBuffer)` is a view, not a copy: the bytes were transferred into this thread
      // and nothing else holds them.
      const bytes = Buffer.from(request.bytes);
      // **One string, used twice, and that is the point of ADR-0043** — the same value the indexer
      // chunks is the one it stores, so `read_document` cannot come to disagree with `search_docs`.
      // The flavor runs here rather than on the far side for the same reason the extraction does: its
      // transforms are regular expressions over a whole document, which is work on a thread.
      const markdown = transformContent(request.flavor, await extractDocument(request.relativePath, bytes, request.limits));
      reply({ id: request.id, ok: true, kind: 'converted', markdown });
      return;
    }
    case 'expand': {
      const bytes = Buffer.from(request.bytes);
      const expansion = readOpenApi(request.relativePath, bytes, request.limits);
      sessions.set(request.id, expansion.documents());
      reply({ id: request.id, ok: true, kind: 'opened', count: expansion.count });
      return;
    }
    case 'next': {
      const documents = sessions.get(request.session);
      if (!documents) {
        // Not a refusal: a `next` for a session nobody opened means the two sides disagree about
        // state, which is a broken run rather than a bad file.
        reply({ id: request.id, ok: false, refusal: false, message: `conversion session ${request.session} is not open` });
        return;
      }
      const step = documents.next();
      if (step.done) {
        sessions.delete(request.session);
        reply({ id: request.id, ok: true, kind: 'end' });
        return;
      }
      reply({ id: request.id, ok: true, kind: 'document', document: step.value });
      return;
    }
    case 'close': {
      const documents = sessions.get(request.session);
      sessions.delete(request.session);
      // Runs the generator's own `finally`, and — the part that matters — drops the last reference to
      // the parsed specification so the graph can be collected before the next file is read.
      documents?.return(undefined as never);
      reply({ id: request.id, ok: true, kind: 'closed' });
      return;
    }
  }
}

port.on('message', (request: ConversionRequest) => {
  handle(request).catch((err: unknown) => {
    // A session that threw is dead: its generator has already run its `finally` and stepping it again
    // would answer `done` for ever. Dropping it here is what keeps a failed render from leaking the
    // specification's object graph until the thread is replaced.
    if (request.kind === 'expand') sessions.delete(request.id);
    if (request.kind === 'next') sessions.delete(request.session);
    failure(request.id, err);
  });
});
