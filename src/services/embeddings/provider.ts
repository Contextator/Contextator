export type EmbeddingProviderKind = 'local' | 'openai';

/**
 * Where `maxInputTokens` came from, because the four differ in how much they should be trusted
 * (ADR-0035): an operator's statement, this product's table, the loaded tokenizer (which states the
 * truncation point rather than the training window, so it is the optimistic answer), or nothing at all.
 */
export type EmbeddingWindowSource = 'configured' | 'known-model' | 'tokenizer' | 'default';

export interface EmbeddingProvider {
  /** Stable identity recorded on each project (e.g. `local:Xenova/all-MiniLM-L6-v2:fp32`). A change forces a full re-index. */
  readonly id: string;
  readonly provider: EmbeddingProviderKind;
  readonly model: string;
  readonly dimensions: number;
  /**
   * How much of an input the model actually **reads usefully** — the window it was trained and
   * distilled at. This, not `truncatesAtTokens`, is what the chunk budget is checked against: text
   * beyond it is encoded by weights that were never trained to represent that much, which produces a
   * confident vector for a passage nobody can point at (ADR-0035).
   *
   * Only meaningful once `ready`; before the model has loaded it is the fallback the provider started
   * with. Never `Infinity` — a provider that reported no limit would turn the check into a no-op.
   */
  readonly maxInputTokens: number;
  /**
   * Where the runtime actually cuts the input, or `null` when nothing discovered it. Reported next to
   * `maxInputTokens` everywhere, because the two commonly differ — 128 against 512 for the default
   * model — and an operator told the window is 128 who then watches a 400-token chunk be accepted
   * without complaint has been told something that looks false.
   */
  readonly truncatesAtTokens: number | null;
  readonly windowSource: EmbeddingWindowSource;
  /** True once the model has produced at least one embedding. */
  readonly ready: boolean;
  /** Loads the model (downloading it on first use) and runs one embedding. */
  warmup(): Promise<void>;
  /** Returns one L2-normalised vector per input, each of length `dimensions`. */
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingDimensionError';
  }
}
