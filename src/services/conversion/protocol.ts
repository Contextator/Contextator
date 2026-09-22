/**
 * The wire between the indexer and the thread that converts files
 * ([ADR-0071](../../../.ssot/ADR.md#adr-0071)).
 *
 * **Two kinds of failure cross this boundary, and keeping them apart is the whole reason there is a
 * protocol here rather than a cloned `Error`.** `DocumentExtractionError` means *this file is not
 * indexable* — the indexer writes the reason onto the owning source and the run carries on
 * ([ADR-0056](../../../.ssot/ADR.md#adr-0056)). Anything else means *the run is broken*, and the
 * indexer rethrows it. Structured clone does not preserve a custom `Error` subclass — the name of
 * anything that is not one of the eight standard error types comes back as `"Error"` — so an
 * `instanceof` check on the far side would quietly turn every refusal into a failed run, which is
 * exactly the defect ADR-0056's boundary was built to close. The kind is therefore carried as a
 * field, not inferred from a type.
 *
 * Bytes travel as a **transferred** `ArrayBuffer`: a file at `MAX_CONVERTED_FILE_BYTES` would
 * otherwise be resident twice while it is being handed over, which is memory the move off the main
 * thread was supposed to save rather than spend.
 */

import type { ExtractLimits } from '../doc-types/index.js';
import type { Flavor } from '../flavors.js';
import type { DerivedDocument, SpecLimits } from '../openapi.js';

/** Bytes → the Markdown that is both chunked and stored (ADR-0043): extraction and then the flavor. */
export interface ConvertRequest {
  id: number;
  kind: 'convert';
  relativePath: string;
  flavor: Flavor;
  bytes: ArrayBuffer;
  limits: ExtractLimits;
}

/**
 * Bytes → an open expansion ([ADR-0057](../../../.ssot/ADR.md#adr-0057)): the specification is parsed
 * and validated, and the object graph it parses into **stays in the worker**. Nothing but one rendered
 * document at a time ever comes back, which is the property the in-process generator had and the one
 * this phase must not give away.
 */
export interface ExpandRequest {
  id: number;
  kind: 'expand';
  relativePath: string;
  bytes: ArrayBuffer;
  limits: SpecLimits;
}

/** One document out of an open expansion. `session` is the id of the `expand` that opened it. */
export interface NextRequest {
  id: number;
  kind: 'next';
  session: number;
}

/** Drop an expansion the indexer stopped reading — a failed embed, a pool that went away. */
export interface CloseRequest {
  id: number;
  kind: 'close';
  session: number;
}

export type ConversionRequest = ConvertRequest | ExpandRequest | NextRequest | CloseRequest;

export interface ConvertedReply {
  id: number;
  ok: true;
  kind: 'converted';
  markdown: string;
}

export interface OpenedReply {
  id: number;
  ok: true;
  kind: 'opened';
  count: number;
}

export interface DocumentReply {
  id: number;
  ok: true;
  kind: 'document';
  document: DerivedDocument;
}

export interface EndReply {
  id: number;
  ok: true;
  kind: 'end';
}

export interface ClosedReply {
  id: number;
  ok: true;
  kind: 'closed';
}

/**
 * Something went wrong, and `refusal` says which sentence the indexer is reading.
 *
 * `true` — a `DocumentExtractionError`: the file is refused by name, the reason goes on its source,
 * the run finishes. `false` — anything else the worker managed to catch: a failed run, rethrown.
 */
export interface FailureReply {
  id: number;
  ok: false;
  refusal: boolean;
  message: string;
}

/** Every reply that is an answer rather than a failure — what a request resolves to. */
export type ConversionSuccess = ConvertedReply | OpenedReply | DocumentReply | EndReply | ClosedReply;

export type ConversionReply = ConversionSuccess | FailureReply;
