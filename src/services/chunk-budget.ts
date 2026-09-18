import { CHUNK_BUDGET_RESERVE_TOKENS, CHUNK_MAX_TOKENS_MIN, CHUNK_TOKENIZER_RESERVE_TOKENS, type Config } from '../config.js';
import type { Logger } from '../context.js';
import type { EmbeddingProvider, EmbeddingWindowSource } from './embeddings/provider.js';

/**
 * The runtime half of the chunk-budget check (ADR-0035). The other half is in `config.ts`, and it can
 * only run when the operator has stated the window themselves: `superRefine` sees `process.env` at
 * process start, while the window is knowable only after the model has downloaded and its tokenizer has
 * parsed. This half runs from the warmup `.then()` in `server.ts`, the one place where a loaded
 * tokenizer and the configuration are both in hand.
 *
 * It never exits. Warmup is a background promise, so a `process.exit` here would turn a tuning mistake
 * on a running instance into a crash loop that takes the dashboard, the sources and every already-indexed
 * project down with it — over a model that has not embedded anything yet. It is loud instead, and the
 * flag it leaves behind is sticky, because a line printed into a container log at startup is
 * indistinguishable from no line at all by the time anybody wonders why search is poor.
 */

export interface ChunkBudgetWarning {
  model: string;
  /** Provider-qualified id, so a log collector can tell two configurations apart. */
  providerId: string;
  /** What the model reads usefully. */
  maxInputTokens: number;
  /** Where the runtime actually cuts, or `null` where nothing discovered it. */
  truncatesAtTokens: number | null;
  windowSource: EmbeddingWindowSource;
  chunkMaxTokens: number;
  suggestedChunkMaxTokens: number;
}

/** Lives on `AppContext`, so a mutable holder rather than a field the composition root would have to reassign. */
export interface ChunkBudgetState {
  /** False until the model has loaded: until then there is no window to check against. */
  checked: boolean;
  /** `null` once checked and fitting. Never cleared afterwards — nothing re-reads the model. */
  warning: ChunkBudgetWarning | null;
}

export const newChunkBudgetState = (): ChunkBudgetState => ({ checked: false, warning: null });

/**
 * What the chunker holds back per chunk, on top of the breadcrumb it counts for itself: the tokenizer's
 * special tokens (ADR-0036) plus the provider's passage prefix (ADR-0038), measured with the model's own
 * tokenizer because an operator can change it and `passage: ` does not cost the same in every vocabulary.
 *
 * The indexer and the eval harness both call this rather than each summing it. A second copy of the sum
 * is a second place to forget the prefix, and forgetting it is a chunk that overruns the window by
 * exactly as much as the prefix costs — which nothing would report.
 *
 * It does not touch `checkChunkBudget` below: a larger reserve makes chunks smaller, so the window check
 * stays true without knowing about it.
 */
export function chunkReserveTokens(embeddings: Pick<EmbeddingProvider, 'passagePrefix' | 'countTokens'>): number {
  if (embeddings.passagePrefix === '') return CHUNK_TOKENIZER_RESERVE_TOKENS;
  return CHUNK_TOKENIZER_RESERVE_TOKENS + embeddings.countTokens(embeddings.passagePrefix);
}

/** The largest budget that still leaves the reserve inside the window, floored at what the schema accepts. */
export const suggestChunkMaxTokens = (maxInputTokens: number): number => Math.max(CHUNK_MAX_TOKENS_MIN, maxInputTokens - CHUNK_BUDGET_RESERVE_TOKENS);

/** Pure: the same comparison `config.ts` makes, against a window that had to be discovered. */
export function checkChunkBudget(config: Config, embeddings: EmbeddingProvider): ChunkBudgetWarning | null {
  if (config.CHUNK_MAX_TOKENS + CHUNK_BUDGET_RESERVE_TOKENS <= embeddings.maxInputTokens) return null;
  return {
    model: embeddings.model,
    providerId: embeddings.id,
    maxInputTokens: embeddings.maxInputTokens,
    truncatesAtTokens: embeddings.truncatesAtTokens,
    windowSource: embeddings.windowSource,
    chunkMaxTokens: config.CHUNK_MAX_TOKENS,
    suggestedChunkMaxTokens: suggestChunkMaxTokens(embeddings.maxInputTokens),
  };
}

/**
 * Both numbers, always. An operator told "the window is 128" who then watches transformers.js accept a
 * 400-token chunk without complaining will conclude the product is wrong about one of them, and discount
 * the next thing it says.
 */
export function chunkBudgetMessage(w: ChunkBudgetWarning): string {
  const truncation =
    w.truncatesAtTokens === null
      ? ''
      : w.truncatesAtTokens > w.maxInputTokens
        ? ` (the tokenizer truncates at ${w.truncatesAtTokens}, so tokens ${w.maxInputTokens + 1}-${w.truncatesAtTokens} are read but were never trained for)`
        : ` (the tokenizer truncates there too, so everything past it is discarded)`;
  return (
    `CHUNK_MAX_TOKENS=${w.chunkMaxTokens} exceeds what ${w.model} reads: it represents the first ` +
    `${w.maxInputTokens} tokens${truncation}. Set CHUNK_MAX_TOKENS=${w.suggestedChunkMaxTokens} and re-index.`
  );
}

/** Runs the check, reports it, and records it where `/api/health` and the dashboard can read it. */
export function verifyChunkBudget(ctx: {
  config: Config;
  embeddings: EmbeddingProvider;
  log: Logger;
  chunkBudget: ChunkBudgetState;
}): ChunkBudgetWarning | null {
  const warning = checkChunkBudget(ctx.config, ctx.embeddings);
  ctx.chunkBudget.checked = true;
  ctx.chunkBudget.warning = warning;
  if (warning) ctx.log.error(warning, chunkBudgetMessage(warning));
  return warning;
}
