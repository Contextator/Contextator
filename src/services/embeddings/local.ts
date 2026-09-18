import { env, pipeline } from '@huggingface/transformers';
import type { Logger } from '../../context.js';
import { EmbeddingDimensionError, type EmbeddingProvider } from './provider.js';

export type LocalDtype = 'fp32' | 'fp16' | 'q8';

export interface LocalEmbeddingOptions {
  model: string;
  dimensions: number;
  cacheDir: string;
  dtype: LocalDtype;
  offline: boolean;
  log: Logger;
}

/** Minimal view of the feature-extraction pipeline we rely on (keeps us independent of upstream type churn). */
type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ dims: number[]; data: ArrayLike<number> }>;

let extractorPromise: Promise<Extractor> | null = null;

function loadExtractor(opts: LocalEmbeddingOptions): Promise<Extractor> {
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
      return p as unknown as Extractor;
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

  constructor(private readonly opts: LocalEmbeddingOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.id = `local:${opts.model}:${opts.dtype}`;
  }

  get ready(): boolean {
    return this.isReady;
  }

  async warmup(): Promise<void> {
    await loadExtractor(this.opts);
    await this.embed(['warmup']);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await loadExtractor(this.opts);
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
