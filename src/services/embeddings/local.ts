import { env, pipeline } from '@huggingface/transformers';
import type { Logger } from '../../context.js';
import { EmbeddingDimensionError, type EmbeddingProvider, type EmbeddingWindowSource } from './provider.js';

export type LocalDtype = 'fp32' | 'fp16' | 'q8';

export interface LocalEmbeddingOptions {
  model: string;
  dimensions: number;
  cacheDir: string;
  dtype: LocalDtype;
  offline: boolean;
  /** `EMBEDDING_MAX_INPUT_TOKENS`. Overrules both the table below and the tokenizer. */
  maxInputTokens?: number;
  log: Logger;
}

/**
 * The window each model was **trained** at, where that is narrower than the truncation point its
 * tokenizer_config.json states. transformers.js never reads the file this comes from — sentence-transformers
 * publishes it as `sentence_bert_config.json` → `max_seq_length`, and the library requests `config.json`,
 * `tokenizer.json` and `tokenizer_config.json` and nothing else — so it cannot be discovered at runtime
 * and has to be written down (ADR-0035).
 *
 * Deliberately short: the models this product ships, the ones its documentation names as alternatives,
 * and Phase 1's candidate. Every entry cites the file it came from. The table only ever *lowers* the
 * runtime ceiling, so an entry that is merely absent costs an optimistic check rather than a wrong one.
 */
export const MODEL_WINDOWS: Readonly<Record<string, number>> = {
  // sentence_bert_config.json: max_seq_length 128, while tokenizer_config.json says model_max_length 512.
  'xenova/paraphrase-multilingual-minilm-l12-v2': 128,
  'sentence-transformers/paraphrase-multilingual-minilm-l12-v2': 128,
  // sentence_bert_config.json: max_seq_length 256, tokenizer_config.json: 512.
  'xenova/all-minilm-l6-v2': 256,
  'sentence-transformers/all-minilm-l6-v2': 256,
  'xenova/all-minilm-l12-v2': 256,
  // sentence_bert_config.json: max_seq_length 512, which is also the tokenizer's limit — the table
  // changes nothing for this family and is here so the absence is not read as an oversight.
  'xenova/multilingual-e5-small': 512,
  'intfloat/multilingual-e5-small': 512,
};

/**
 * Assumed when nothing states a window: neither the operator, nor the table, nor the tokenizer, whose
 * `model_max_length` getter answers `Infinity` when `tokenizer_config.json` omits the key. Narrow on
 * purpose. A guess that is too small costs a warning an operator can dismiss; a guess that is too large
 * is the silent truncation this whole mechanism exists to end.
 */
export const DEFAULT_UNKNOWN_WINDOW_TOKENS = 256;

/** The tokenizer's own `<s>`/`</s>` and a heading breadcrumb `embeddingText` prepends are not free either. */
const MIN_WINDOW_TOKENS = 16;

/** Minimal view of the feature-extraction pipeline we rely on (keeps us independent of upstream type churn). */
type Extractor = ((texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ dims: number[]; data: ArrayLike<number> }>) & {
  /** `PreTrainedTokenizer.model_max_length`, which falls back to `Infinity` when the config omits it. */
  readonly tokenizer: { readonly model_max_length: number };
};

export interface DiscoveredWindow {
  effective: number;
  truncatesAt: number | null;
  source: EmbeddingWindowSource;
}

/**
 * Narrowest wins, and the provider says which source it used. Split out of `loadExtractor` because it
 * is the whole of the decision and deserves to be tested without a model.
 */
export function resolveWindow(model: string, tokenizerMaxLength: number, configured?: number): DiscoveredWindow {
  const truncatesAt = Number.isFinite(tokenizerMaxLength) ? tokenizerMaxLength : null;
  if (configured !== undefined) return { effective: configured, truncatesAt, source: 'configured' };

  const known = MODEL_WINDOWS[model.toLowerCase()];
  if (known !== undefined) return { effective: truncatesAt === null ? known : Math.min(known, truncatesAt), truncatesAt, source: 'known-model' };
  if (truncatesAt !== null) return { effective: Math.max(truncatesAt, MIN_WINDOW_TOKENS), truncatesAt, source: 'tokenizer' };
  return { effective: DEFAULT_UNKNOWN_WINDOW_TOKENS, truncatesAt: null, source: 'default' };
}

/** What the singleton hands back: the pipeline, and the one tokenizer fact the window is derived from. */
interface LoadedPipeline {
  extractor: Extractor;
  tokenizerMaxLength: number;
}

let extractorPromise: Promise<LoadedPipeline> | null = null;

function loadExtractor(opts: LocalEmbeddingOptions): Promise<LoadedPipeline> {
  if (!extractorPromise) {
    env.cacheDir = opts.cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = !opts.offline;
    opts.log.info({ model: opts.model, dtype: opts.dtype, cacheDir: opts.cacheDir }, 'loading embedding model');
    const started = Date.now();
    const seen = new Set<string>();
    extractorPromise = pipeline('feature-extraction', opts.model, {
      dtype: opts.dtype,
      progress_callback: (progress: { status?: string; file?: string }) => {
        if (progress.status === 'download' && progress.file && !seen.has(progress.file)) {
          seen.add(progress.file);
          opts.log.info({ file: progress.file }, 'downloading model file');
        }
      },
    }).then((p) => {
      opts.log.info({ model: opts.model, ms: Date.now() - started }, 'embedding model loaded');
      const extractor = p as unknown as Extractor;
      return { extractor, tokenizerMaxLength: extractor.tokenizer.model_max_length };
    });
    // Allow a retry after a failed download instead of caching the rejection forever.
    extractorPromise.catch(() => {
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

/** Local CPU embeddings via transformers.js (ONNX runtime). The pipeline is a process-wide singleton. */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'local' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly id: string;
  private isReady = false;
  /**
   * The window is a runtime fact (ADR-0035), so this starts as the best answer available without a
   * tokenizer and is replaced once the pipeline resolves. `verifyChunkBudget` runs after warmup, so it
   * never reads the placeholder.
   */
  private window: DiscoveredWindow;
  private windowDiscovered = false;

  constructor(private readonly opts: LocalEmbeddingOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.id = `local:${opts.model}:${opts.dtype}`;
    this.window = resolveWindow(opts.model, Number.POSITIVE_INFINITY, opts.maxInputTokens);
  }

  /** Once, on the first load: the tokenizer's answer replaces the placeholder the constructor set. */
  private adoptWindow(loaded: LoadedPipeline): Extractor {
    if (this.windowDiscovered) return loaded.extractor;
    this.windowDiscovered = true;
    this.window = resolveWindow(this.model, loaded.tokenizerMaxLength, this.opts.maxInputTokens);
    if (this.window.source === 'default') {
      this.opts.log.warn(
        { model: this.model, assumedMaxInputTokens: this.window.effective },
        `${this.model} states no input limit anywhere this runtime can read; assuming ${this.window.effective} tokens. ` +
          "Set EMBEDDING_MAX_INPUT_TOKENS to the model card's max_seq_length to replace the assumption.",
      );
    }
    return loaded.extractor;
  }

  get ready(): boolean {
    return this.isReady;
  }

  get maxInputTokens(): number {
    return this.window.effective;
  }

  get truncatesAtTokens(): number | null {
    return this.window.truncatesAt;
  }

  get windowSource(): EmbeddingWindowSource {
    return this.window.source;
  }

  async warmup(): Promise<void> {
    this.adoptWindow(await loadExtractor(this.opts));
    await this.embed(['warmup']);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = this.adoptWindow(await loadExtractor(this.opts));
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    if (d !== this.dimensions) {
      throw new EmbeddingDimensionError(
        `Model ${this.model} produces ${d}-dimensional vectors but EMBEDDING_DIMENSIONS=${this.dimensions}. ` +
          `Set EMBEDDING_DIMENSIONS=${d} (and RESET_VECTORS=1 once if chunks already exist).`,
      );
    }
    const rows: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = new Array<number>(d);
      for (let j = 0; j < d; j++) row[j] = out.data[i * d + j];
      rows[i] = row;
    }
    this.isReady = true;
    return rows;
  }
}
