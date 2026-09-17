export type EmbeddingProviderKind = 'local' | 'openai';

export interface EmbeddingProvider {
  /** Stable identity recorded on each project (e.g. `local:Xenova/all-MiniLM-L6-v2:fp32`). A change forces a full re-index. */
  readonly id: string;
  readonly provider: EmbeddingProviderKind;
  readonly model: string;
  readonly dimensions: number;
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
