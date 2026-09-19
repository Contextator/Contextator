import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';
import type { Config } from '../config.js';
import type { Logger } from '../context.js';

/**
 * A cross-encoder that reads a question and a passage **together** and scores the pair, placed between
 * the fusion and the truncation of `searchChunks` ([ROADMAP.md](../../.ssot/ROADMAP.md) Item 12,
 * ADR-0041's last paragraph). It is the one thing a bi-encoder cannot do, and the reason it has no
 * same-language bias to inherit: nothing in it embeds the question on its own, so nothing in it can
 * prefer a passage for being written in the question's language.
 *
 * **It is off by default and it is a spike.** `SEARCH_RERANK=off` is what the gated `eval` job
 * measures, because a measurement that quietly included an experiment would stop describing the
 * product. Nothing here changes a default, a floor, or the shape of a result.
 *
 * The interface is a function of strings and not a model, for `vector-store.ts`'s reason: that file
 * takes a query *vector* rather than an embedding provider, so the model lives at the edge and the
 * query path stays testable without one.
 */
export interface Reranker {
  /** `local-rerank:<model>:<dtype>`, so a run that used one is visibly a different run. */
  readonly id: string;
  /**
   * One score per passage, higher better, in the order the passages were given. The scale is the
   * model's own logit and is comparable only within one call — which is all a reordering needs, and
   * is why nothing here normalises it into something that looks like a probability.
   */
  score(query: string, passages: readonly string[]): Promise<number[]>;
}

export interface LocalRerankerOptions {
  model: string;
  dtype: 'fp32' | 'fp16' | 'q8';
  cacheDir: string;
  offline: boolean;
  /**
   * Where a (question, passage) pair is truncated. 128 rather than the model's 512: a chunk is
   * `CHUNK_MAX_TOKENS` — 96 since ADR-0037 — so a pair is a question plus ninety-six tokens and a
   * larger window would pad rather than read. This is the real number, not a saving.
   */
  maxLength: number;
  /** Pairs per forward pass. The pool is at most a hundred, so this is about memory, not throughput. */
  batchSize: number;
  log: Logger;
}

/** Minimal views of the two upstream objects, so this file does not depend on their type churn. */
type LoadedTokenizer = (
  text: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
) => Record<string, unknown>;
type LoadedModel = (inputs: Record<string, unknown>) => Promise<{ logits: { dims: number[]; data: ArrayLike<number> } }>;

interface Loaded {
  tokenizer: LoadedTokenizer;
  model: LoadedModel;
}

let loadPromise: Promise<Loaded> | null = null;

function load(opts: LocalRerankerOptions): Promise<Loaded> {
  if (!loadPromise) {
    env.cacheDir = opts.cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = !opts.offline;
    opts.log.info({ model: opts.model, dtype: opts.dtype, cacheDir: opts.cacheDir }, 'loading rerank model');
    const started = Date.now();
    const seen = new Set<string>();
    const progress_callback = (progress: { status?: string; file?: string }) => {
      if (progress.status === 'download' && progress.file && !seen.has(progress.file)) {
        seen.add(progress.file);
        opts.log.info({ file: progress.file }, 'downloading rerank model file');
      }
    };
    loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(opts.model, { progress_callback }),
      // `AutoModelForSequenceClassification` and not `pipeline('text-classification')`: the pipeline
      // signature in transformers.js v4 is `(texts, options)` with no `text_pair`, so it cannot express
      // a pair at all. The tokenizer can — `text_pair` must match the shape of `text` — which is why
      // the two are assembled here by hand rather than through a task.
      AutoModelForSequenceClassification.from_pretrained(opts.model, { dtype: opts.dtype, progress_callback }),
    ]).then(([tokenizer, model]) => {
      opts.log.info({ model: opts.model, ms: Date.now() - started }, 'rerank model loaded');
      return { tokenizer: tokenizer as unknown as LoadedTokenizer, model: model as unknown as LoadedModel };
    });
    loadPromise.catch(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

/**
 * A cross-encoder reranker on the CPU, through the same ONNX runtime the embedding provider uses. The
 * loaded pair is a process-wide singleton for `local.ts`'s reason: a second copy is a second few
 * hundred megabytes resident, and the indexer is already competing for this core.
 *
 * **`num_labels` is 1 on every model this is meant for**, so the logit is the score and there is no
 * softmax to apply. Softmaxing a one-column output returns 1.0 for every row, which would silently
 * replace the ranking with the order the rows arrived in — a failure that looks like "the rerank did
 * nothing" rather than like a bug.
 */
export class LocalReranker implements Reranker {
  readonly id: string;

  constructor(private readonly opts: LocalRerankerOptions) {
    this.id = `local-rerank:${opts.model}:${opts.dtype}`;
  }

  async warmup(): Promise<void> {
    await this.score('warmup', ['warmup']);
  }

  async score(query: string, passages: readonly string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    const { tokenizer, model } = await load(this.opts);
    const scores: number[] = [];
    for (let start = 0; start < passages.length; start += this.opts.batchSize) {
      const batch = passages.slice(start, start + this.opts.batchSize);
      const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
        text_pair: batch as string[],
        padding: true,
        truncation: true,
        max_length: this.opts.maxLength,
      });
      const { logits } = await model(inputs);
      // [batch, 1] for a one-label cross-encoder; the second dimension is read rather than assumed so
      // that a two-label model produces a wrong answer loudly instead of a plausible one quietly.
      const width = logits.dims[1] ?? 1;
      if (width !== 1) {
        throw new Error(`Rerank model ${this.opts.model} produced ${width} labels; this path expects a single relevance logit.`);
      }
      for (let i = 0; i < batch.length; i++) scores.push(logits.data[i]);
    }
    return scores;
  }
}

/** `null` when `SEARCH_RERANK=off`, which is the default and what the product ships. */
export function createReranker(config: Config, log: Logger): LocalReranker | null {
  if (config.SEARCH_RERANK === 'off') return null;
  return new LocalReranker({
    model: config.SEARCH_RERANK_MODEL,
    dtype: config.SEARCH_RERANK_DTYPE,
    cacheDir: config.MODEL_CACHE_DIR,
    offline: config.EMBEDDING_OFFLINE,
    maxLength: config.SEARCH_RERANK_MAX_TOKENS,
    batchSize: config.SEARCH_RERANK_BATCH,
    log,
  });
}
