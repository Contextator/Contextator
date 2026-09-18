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
   * `maxInputTokens` everywhere, because the two commonly differ — 128 against 512 for
   * `paraphrase-multilingual-MiniLM-L12-v2`, though they are both 512 for the model shipped since
   * ADR-0037 — and an operator told the window is 128 who then watches a 400-token chunk be accepted
   * without complaint has been told something that looks false.
   */
  readonly truncatesAtTokens: number | null;
  readonly windowSource: EmbeddingWindowSource;
  /** True once the model has produced at least one embedding. */
  readonly ready: boolean;
  /**
   * The instruction prefix this model was trained to see in front of a search query, or `''` for a model
   * that is symmetric (ADR-0038). Read-only and read-only from outside: a caller never prepends it — the
   * provider does, inside `embedQuery`. It is exposed because `/api/health` reports it and because
   * `provider.id` is built from it, not so that anybody can apply it themselves.
   */
  readonly queryPrefix: string;
  /**
   * The same for an indexed passage. It is part of the string the model reads, so it is also part of the
   * chunk budget: `chunkReserveTokens` charges `countTokens(passagePrefix)` against `CHUNK_MAX_TOKENS`.
   */
  readonly passagePrefix: string;
  /**
   * How many tokens `text` costs this model, **not counting the special tokens** the model adds around
   * an input — those are the chunker's `reserveTokens` (ADR-0036), and counting them here would count
   * them twice.
   *
   * Exact once the tokenizer has loaded, which for the local provider is once `ready`; before that it
   * is `estimateTokens`, because the alternative is to make the chunker asynchronous. Synchronous by
   * contract: the chunker is a pure function and the whole point of injecting this is to keep it one.
   */
  countTokens(text: string): number;
  /** Loads the model (downloading it on first use) and runs one embedding, through `embedPassages`. */
  warmup(): Promise<void>;
  /**
   * Indexing side: one L2-normalised vector per input, each of length `dimensions`, each text encoded
   * behind `passagePrefix`.
   *
   * There is deliberately no symmetric `embed()` and no alias for one (ADR-0038). The two sides of an
   * asymmetric model are different functions, and a call site that picked the wrong one would produce
   * vectors that are wrong, plausible and silent.
   */
  embedPassages(texts: string[]): Promise<number[][]>;
  /** Retrieval side: one vector for one query, encoded behind `queryPrefix`. */
  embedQuery(text: string): Promise<number[]>;
}

export class EmbeddingDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingDimensionError';
  }
}
