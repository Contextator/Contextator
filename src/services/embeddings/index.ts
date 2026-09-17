import path from 'node:path';
import type { Config } from '../../config.js';
import type { Logger } from '../../context.js';
import { LocalEmbeddingProvider } from './local.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider } from './provider.js';

export type { EmbeddingProvider } from './provider.js';
export { EmbeddingDimensionError } from './provider.js';

export function createEmbeddingProvider(config: Config, log: Logger): EmbeddingProvider {
  if (config.EMBEDDING_PROVIDER === 'openai') {
    return new OpenAIEmbeddingProvider({
      apiKey: config.OPENAI_API_KEY ?? '',
      model: config.OPENAI_EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      log,
    });
  }
  return new LocalEmbeddingProvider({
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    cacheDir: path.resolve(config.MODEL_CACHE_DIR),
    dtype: config.EMBEDDING_DTYPE,
    offline: config.EMBEDDING_OFFLINE,
    log,
  });
}
