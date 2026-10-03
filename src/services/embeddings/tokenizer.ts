import { AutoTokenizer, env } from '@huggingface/transformers';
import type { Logger } from '../../context.js';

/**
 * Where transformers.js looks for and keeps model files, set the one way every loader in this directory
 * sets it: `MODEL_CACHE_DIR` as the cache, local files allowed, the Hub allowed unless
 * `EMBEDDING_OFFLINE` says otherwise. Shared so that a tokenizer named by `EMBEDDING_TOKENIZER`
 * (ADR-0101) lands in — and is found in — exactly the cache the local provider fills.
 */
export function configureModelRuntime(opts: { cacheDir: string; offline: boolean }): void {
  env.cacheDir = opts.cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = !opts.offline;
}

/**
 * What the chunker needs from a tokenizer, and nothing else. `encode` is synchronous once the tokenizer
 * has parsed, which is the fact ADR-0036 rests on.
 */
export interface TokenCounter {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
}

/** A tokenizer named by `EMBEDDING_TOKENIZER` could not be loaded. Startup stops on it (ADR-0101 §3). */
export class TokenizerLoadError extends Error {
  constructor(
    readonly tokenizer: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `EMBEDDING_TOKENIZER=${tokenizer} could not be loaded: ${reason}. ` +
        'Name a model repository that publishes tokenizer.json (e.g. Xenova/multilingual-e5-small), make it ' +
        'reachable (or present in MODEL_CACHE_DIR when EMBEDDING_OFFLINE=1), or unset EMBEDDING_TOKENIZER to ' +
        'count tokens as characters ÷ 4.',
      { cause },
    );
    this.name = 'TokenizerLoadError';
  }
}

export interface NamedTokenizerOptions {
  /** The model repository whose `tokenizer.json` is read. Only the tokenizer is fetched, never weights. */
  name: string;
  cacheDir: string;
  offline: boolean;
  log: Logger;
}

/**
 * Loads only the tokenizer of a named model (`tokenizer.json` + `tokenizer_config.json`) through the
 * transformers.js dependency the local provider already uses (ADR-0101). Fails loudly; there is no
 * fallback to the estimate, because a silent fallback would chunk with boundaries the operator did not
 * ask for under a provider id that says they did.
 */
export async function loadNamedTokenizer(opts: NamedTokenizerOptions): Promise<TokenCounter> {
  configureModelRuntime(opts);
  opts.log.info({ tokenizer: opts.name, cacheDir: opts.cacheDir }, 'loading embedding tokenizer');
  const started = Date.now();
  const seen = new Set<string>();
  let tokenizer: TokenCounter;
  try {
    tokenizer = (await AutoTokenizer.from_pretrained(opts.name, {
      progress_callback: (progress: { status?: string; file?: string }) => {
        if (progress.status === 'download' && progress.file && !seen.has(progress.file)) {
          seen.add(progress.file);
          opts.log.info({ file: progress.file }, 'downloading tokenizer file');
        }
      },
    })) as unknown as TokenCounter;
    // A repository can answer with a config and no usable vocabulary; one encode proves it parsed.
    if (typeof tokenizer?.encode !== 'function' || tokenizer.encode('ok', { add_special_tokens: false }).length === 0) {
      throw new Error('the loaded tokenizer encodes nothing');
    }
  } catch (err) {
    throw new TokenizerLoadError(opts.name, err);
  }
  opts.log.info({ tokenizer: opts.name, ms: Date.now() - started }, 'embedding tokenizer loaded');
  return tokenizer;
}
