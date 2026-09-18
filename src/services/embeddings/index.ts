import path from 'node:path';
import type { Config } from '../../config.js';
import type { Logger } from '../../context.js';
import { LocalEmbeddingProvider } from './local.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import { type EmbeddingPrefixes, resolvePrefixes } from './prefixes.js';
import type { EmbeddingProvider } from './provider.js';

export type { EmbeddingProvider, EmbeddingWindowSource } from './provider.js';
export { EmbeddingDimensionError } from './provider.js';
export type { EmbeddingPrefixes } from './prefixes.js';
export { MODEL_PREFIXES, NO_PREFIX_SENTINEL, prefixesForModel, prefixIdSegment, resolvePrefixes } from './prefixes.js';

/** The table for the model actually configured, with the operator's two variables laid over it (ADR-0038). */
export function configuredPrefixes(config: Config): EmbeddingPrefixes {
  const model = config.EMBEDDING_PROVIDER === 'openai' ? config.OPENAI_EMBEDDING_MODEL : config.EMBEDDING_MODEL;
  return resolvePrefixes(model, { query: config.EMBEDDING_QUERY_PREFIX, passage: config.EMBEDDING_PASSAGE_PREFIX });
}

export function createEmbeddingProvider(config: Config, log: Logger): EmbeddingProvider {
  const prefixes = configuredPrefixes(config);
  if (config.EMBEDDING_PROVIDER === 'openai') {
    return new OpenAIEmbeddingProvider({
      apiKey: config.OPENAI_API_KEY ?? '',
      model: config.OPENAI_EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      maxInputTokens: config.EMBEDDING_MAX_INPUT_TOKENS,
      prefixes,
      log,
    });
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
