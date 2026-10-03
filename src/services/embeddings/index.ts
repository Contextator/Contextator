import path from 'node:path';
import type { Config } from '../../config.js';
import type { Logger } from '../../context.js';
import { LocalEmbeddingProvider } from './local.js';
import { endpointIdSegment, OPENAI_DEFAULT_BASE_URL, OpenAIEmbeddingProvider } from './openai.js';
import { type EmbeddingPrefixes, prefixesForModel, resolvePrefixes } from './prefixes.js';
import type { EmbeddingProvider } from './provider.js';

export type { EmbeddingProvider, EmbeddingWindowSource } from './provider.js';
export { EmbeddingDimensionError } from './provider.js';
export { TokenizerLoadError } from './tokenizer.js';
export type { EmbeddingPrefixes } from './prefixes.js';
export { MODEL_PREFIXES, NO_PREFIX_SENTINEL, prefixesForModel, prefixIdSegment, resolvePrefixes } from './prefixes.js';

/** The table for the model actually configured, with the operator's two variables laid over it (ADR-0038). */
export function configuredPrefixes(config: Config): EmbeddingPrefixes {
  const model = config.EMBEDDING_PROVIDER === 'openai' ? config.OPENAI_EMBEDDING_MODEL : config.EMBEDDING_MODEL;
  return resolvePrefixes(model, { query: config.EMBEDDING_QUERY_PREFIX, passage: config.EMBEDDING_PASSAGE_PREFIX });
}

/**
 * The line an operator on a self-hosted OpenAI-compatible endpoint reads when the configured model name
 * matches no family the prefix table knows, or `null` when there is nothing to say.
 *
 * The prefixes are resolved from the model *name* (ADR-0038), and a server can serve an e5 under any
 * name it likes — `e5`, `embed`, a local path. The result is not an error: the model runs, symmetric,
 * and a few points of recall go missing without a trace (the 0.2.1 TEI evaluation measured rec@1
 * 62.0 % → 60.9 %). So it is said once, at startup, at `info`: OpenAI's own endpoint is never told,
 * and an operator who set either prefix variable has already decided.
 */
export function prefixAdvisory(config: Config): string | null {
  if (config.EMBEDDING_PROVIDER !== 'openai') return null;
  const baseURL = config.EMBEDDING_BASE_URL ?? config.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL;
  if (!URL.canParse(baseURL) || endpointIdSegment(baseURL) === '') return null;
  if (config.EMBEDDING_QUERY_PREFIX !== undefined || config.EMBEDDING_PASSAGE_PREFIX !== undefined) return null;
  const table = prefixesForModel(config.OPENAI_EMBEDDING_MODEL);
  if (table.query !== '' || table.passage !== '') return null;
  return (
    `OPENAI_EMBEDDING_MODEL=${config.OPENAI_EMBEDDING_MODEL} matches no model family with known instruction prefixes, ` +
    'so queries and passages are embedded without one. If this endpoint serves an asymmetric model under another ' +
    'name (e.g. multilingual-e5 behind TEI, vLLM or Ollama), set OPENAI_EMBEDDING_MODEL to its real name or set ' +
    'EMBEDDING_QUERY_PREFIX / EMBEDDING_PASSAGE_PREFIX; either re-indexes every project once.'
  );
}

export function createEmbeddingProvider(config: Config, log: Logger): EmbeddingProvider {
  const prefixes = configuredPrefixes(config);
  if (config.EMBEDDING_PROVIDER === 'openai') {
    const advisory = prefixAdvisory(config);
    if (advisory) log.info({ model: config.OPENAI_EMBEDDING_MODEL }, advisory);
    return new OpenAIEmbeddingProvider({
      apiKey: config.OPENAI_API_KEY ?? '',
      model: config.OPENAI_EMBEDDING_MODEL,
      // Two names, kept apart: only the new one is part of `provider.id` (see `endpointIdSegment`).
      baseURL: config.EMBEDDING_BASE_URL,
      legacyBaseURL: config.OPENAI_BASE_URL,
      requestDimensions: config.EMBEDDING_REQUEST_DIMENSIONS,
      dimensions: config.EMBEDDING_DIMENSIONS,
      maxInputTokens: config.EMBEDDING_MAX_INPUT_TOKENS,
      prefixes,
      tokenizer:
        config.EMBEDDING_TOKENIZER === undefined
          ? undefined
          : { name: config.EMBEDDING_TOKENIZER, cacheDir: path.resolve(config.MODEL_CACHE_DIR), offline: config.EMBEDDING_OFFLINE },
      log,
    });
  }
  if (config.EMBEDDING_TOKENIZER !== undefined) {
    // The local provider counts with its own model's tokenizer; a second one would only disagree with it.
    log.warn({ tokenizer: config.EMBEDDING_TOKENIZER }, 'EMBEDDING_TOKENIZER applies to EMBEDDING_PROVIDER=openai only and is ignored');
  }
  return new LocalEmbeddingProvider({
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    cacheDir: path.resolve(config.MODEL_CACHE_DIR),
    dtype: config.EMBEDDING_DTYPE,
    offline: config.EMBEDDING_OFFLINE,
    maxInputTokens: config.EMBEDDING_MAX_INPUT_TOKENS,
    prefixes,
    log,
  });
}

/**
 * The startup half of ADR-0101: loads the tokenizer `EMBEDDING_TOKENIZER` names before the server
 * accepts anything, and rejects with `TokenizerLoadError` when it cannot — the caller lets that stop the
 * process. A no-op for the local provider and for an OpenAI provider without the setting.
 */
export async function loadEmbeddingTokenizer(embeddings: EmbeddingProvider): Promise<void> {
  if (embeddings instanceof OpenAIEmbeddingProvider) await embeddings.loadTokenizer();
}
