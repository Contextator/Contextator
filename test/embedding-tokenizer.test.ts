import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AutoTokenizer } from '@huggingface/transformers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, EnvSchema } from '../src/config.js';
import type { Logger } from '../src/context.js';
import { chunkReserveTokens } from '../src/services/chunk-budget.js';
import { chunkMarkdown, estimateTokens } from '../src/services/chunker.js';
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  loadEmbeddingTokenizer,
  prefixAdvisory,
  resolvePrefixes,
  TokenizerLoadError,
} from '../src/services/embeddings/index.js';
import { LocalEmbeddingProvider } from '../src/services/embeddings/local.js';
import { OpenAIEmbeddingProvider, tokenizerIdSegment } from '../src/services/embeddings/openai.js';
import { MODEL_CACHE_DIR, modelCacheGate } from './support/model-cache.js';
import { type OpenAIStub, startOpenAIStub } from './support/openai-stub.js';

/**
 * ADR-0101: `EMBEDDING_TOKENIZER` lets the OpenAI-compatible provider count with a real tokenizer.
 * Unset, nothing changes — not the count, not the id. Set, it is part of the id and it must load, or
 * startup stops.
 */

const silentLog = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => silentLog,
} as unknown as Logger;

const recordingLog = () => {
  const lines: { level: string; msg: string }[] = [];
  const log = {
    ...silentLog,
    info: (_obj: unknown, msg?: string) => lines.push({ level: 'info', msg: msg ?? '' }),
    warn: (_obj: unknown, msg?: string) => lines.push({ level: 'warn', msg: msg ?? '' }),
    child: () => log,
  } as unknown as Logger;
  return { log, lines };
};

const TOKENIZER = 'Xenova/multilingual-e5-small';
const ENV = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ALLOWED_DOC_ROOTS: '/docs' };

const config = (overrides: Record<string, string>): Config => EnvSchema.parse({ ...ENV, ...overrides });

const SAMPLE = 'Kubernetes üzerinde PostgreSQL yedeklemesi nasıl yapılır? pg_dump ile günlük yedek alınır.';

describe('without EMBEDDING_TOKENIZER (today’s behaviour)', () => {
  const base = { apiKey: 'sk-x', model: 'text-embedding-3-small', dimensions: 1536, log: silentLog };

  it('keeps the provider id byte for byte', () => {
    expect(tokenizerIdSegment(undefined)).toBe('');
    expect(new OpenAIEmbeddingProvider(base).id).toBe('openai:text-embedding-3-small:1536');
    const fromConfig = createEmbeddingProvider(config({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }), silentLog);
    expect(fromConfig.id).toBe('openai:text-embedding-3-small:384');
  });

  it('counts with the estimate, before and after warm-up alike', async () => {
    const provider = new OpenAIEmbeddingProvider(base);
    expect(provider.countTokens(SAMPLE)).toBe(estimateTokens(SAMPLE));
    await provider.loadTokenizer(); // a no-op without a name
    await loadEmbeddingTokenizer(provider);
    expect(provider.countTokens(SAMPLE)).toBe(estimateTokens(SAMPLE));
    expect(provider.tokenizerName).toBeUndefined();
  });
});

describe('the setting itself', () => {
  it('accepts a Hugging Face model id', () => {
    expect(config({ EMBEDDING_TOKENIZER: TOKENIZER }).EMBEDDING_TOKENIZER).toBe(TOKENIZER);
    expect(config({ EMBEDDING_TOKENIZER: 'bert-base-uncased' }).EMBEDDING_TOKENIZER).toBe('bert-base-uncased');
  });

  it('refuses anything that could walk out of the model cache', () => {
    for (const bad of ['../etc', 'a/../b', 'a/b/c', '/abs/path', 'a b', '.hidden/x']) {
      expect(EnvSchema.safeParse({ ...ENV, EMBEDDING_TOKENIZER: bad }).success, bad).toBe(false);
    }
  });

  it('enters the provider id, after every other segment', () => {
    expect(tokenizerIdSegment(TOKENIZER)).toBe(`:tokenizer=${TOKENIZER}`);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '',
      model: 'intfloat/multilingual-e5-small',
      dimensions: 384,
      baseURL: 'http://127.0.0.1:8080/v1',
      prefixes: resolvePrefixes('intfloat/multilingual-e5-small', {}),
      tokenizer: { name: TOKENIZER, cacheDir: MODEL_CACHE_DIR, offline: true },
      log: silentLog,
    });
    expect(provider.id.endsWith(`:tokenizer=${TOKENIZER}`)).toBe(true);
    expect(provider.id.startsWith('openai:intfloat/multilingual-e5-small:384')).toBe(true);
  });

  it('is ignored, with a warning, by the local provider', () => {
    const { log, lines } = recordingLog();
    const provider = createEmbeddingProvider(config({ EMBEDDING_TOKENIZER: TOKENIZER, EMBEDDING_OFFLINE: '1' }), log);
    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider.id).not.toContain('tokenizer=');
    expect(lines).toContainEqual({ level: 'warn', msg: expect.stringContaining('EMBEDDING_PROVIDER=openai only') });
  });
});

describe('a tokenizer that cannot be loaded', () => {
  it('stops startup with an error that names the setting', async () => {
    const provider = createEmbeddingProvider(
      config({
        EMBEDDING_PROVIDER: 'openai',
        EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_EMBEDDING_MODEL: 'nomic-embed-text',
        EMBEDDING_TOKENIZER: 'Xenova/does-not-exist',
        EMBEDDING_OFFLINE: '1',
        MODEL_CACHE_DIR,
      }),
      silentLog,
    );
    const failure = loadEmbeddingTokenizer(provider);
    await expect(failure).rejects.toBeInstanceOf(TokenizerLoadError);
    await expect(loadEmbeddingTokenizer(provider)).rejects.toThrow(/EMBEDDING_TOKENIZER=Xenova\/does-not-exist could not be loaded/);
    // No silent fallback: the provider still says it has no tokenizer, and warm-up fails the same way.
    await expect(provider.warmup()).rejects.toBeInstanceOf(TokenizerLoadError);
  });
});

describe('prefix advisory for self-hosted endpoints', () => {
  const openai = (overrides: Record<string, string>) =>
    config({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'http://tei:8080/v1', ...overrides });

  it('speaks when a self-hosted model name matches no known family', () => {
    expect(prefixAdvisory(openai({ OPENAI_EMBEDDING_MODEL: 'e5' }))).toContain('OPENAI_EMBEDDING_MODEL=e5');
    const legacy = config({ EMBEDDING_PROVIDER: 'openai', OPENAI_EMBEDDING_MODEL: 'e5', OPENAI_BASE_URL: 'http://vllm:8000/v1' });
    expect(prefixAdvisory(legacy)).not.toBeNull();
  });

  it('logs it once at info when the provider is built', () => {
    const { log, lines } = recordingLog();
    createEmbeddingProvider(openai({ OPENAI_EMBEDDING_MODEL: 'embed' }), log);
    expect(lines.filter((l) => l.level === 'info' && l.msg.includes('no model family'))).toHaveLength(1);
  });

  it('stays silent for a known family, for OpenAI itself, and once the operator set a prefix', () => {
    expect(prefixAdvisory(openai({ OPENAI_EMBEDDING_MODEL: 'intfloat/multilingual-e5-small' }))).toBeNull();
    expect(prefixAdvisory(config({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }))).toBeNull();
    expect(prefixAdvisory(openai({ OPENAI_EMBEDDING_MODEL: 'e5', EMBEDDING_QUERY_PREFIX: 'query: ' }))).toBeNull();
    expect(prefixAdvisory(config({}))).toBeNull();
  });
});

const tokenizerGate = modelCacheGate(TOKENIZER, 'tokenizer.json');

describe.skipIf(tokenizerGate.skip)('with EMBEDDING_TOKENIZER loaded', () => {
  beforeAll(tokenizerGate.assertPresent);

  it('counts exactly, without special tokens, once loaded', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: '',
      model: 'e5',
      dimensions: 384,
      baseURL: 'http://127.0.0.1:9/v1',
      tokenizer: { name: TOKENIZER, cacheDir: MODEL_CACHE_DIR, offline: true },
      log: silentLog,
    });
    expect(provider.countTokens(SAMPLE)).toBe(estimateTokens(SAMPLE));
    await loadEmbeddingTokenizer(provider);
    await loadEmbeddingTokenizer(provider); // idempotent
    expect(provider.tokenizerName).toBe(TOKENIZER);
    const reference = await AutoTokenizer.from_pretrained(TOKENIZER);
    expect(provider.countTokens(SAMPLE)).toBe(reference.encode(SAMPLE, { add_special_tokens: false }).length);
    const dense = 'Ünlü'.repeat(40); // where characters ÷ 4 and the vocabulary disagree
    expect(provider.countTokens(dense)).toBe(reference.encode(dense, { add_special_tokens: false }).length);
    expect(provider.countTokens(dense)).not.toBe(estimateTokens(dense));
    expect(provider.countTokens('')).toBe(0);
  });
});

const modelGate = modelCacheGate(TOKENIZER, 'onnx', 'model.onnx');

/**
 * The acceptance criterion: on the eval corpus, an OpenAI-compatible endpoint serving e5 with
 * `EMBEDDING_TOKENIZER` set cuts exactly the chunks the local provider cuts from the same model.
 */
describe.skipIf(modelGate.skip)('the eval corpus, local vs openai + EMBEDDING_TOKENIZER', () => {
  const corpusRoot = path.resolve('eval/corpus');
  const files = (readdirSync(corpusRoot, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).sort();
  let stub: OpenAIStub;

  beforeAll(async () => {
    modelGate.assertPresent();
    stub = await startOpenAIStub({ dims: 384 });
  });

  afterAll(async () => {
    await stub?.close();
  });

  const chunkCount = (provider: EmbeddingProvider): number => {
    const reserveTokens = chunkReserveTokens(provider);
    let total = 0;
    for (const file of files) {
      const content = readFileSync(path.join(corpusRoot, file), 'utf8');
      total += chunkMarkdown(content, file, {
        maxTokens: 96,
        overlapTokens: 24,
        countTokens: (t) => provider.countTokens(t),
        reserveTokens,
      }).chunks.length;
    }
    return total;
  };

  it('produces the same number of chunks', async () => {
    expect(files.length).toBeGreaterThan(0);
    const local = new LocalEmbeddingProvider({
      model: TOKENIZER,
      dimensions: 384,
      cacheDir: MODEL_CACHE_DIR,
      dtype: 'fp32',
      offline: true,
      prefixes: resolvePrefixes(TOKENIZER, {}),
      log: silentLog,
    });
    await local.warmup();

    const remote = new OpenAIEmbeddingProvider({
      apiKey: '',
      model: 'intfloat/multilingual-e5-small',
      dimensions: 384,
      baseURL: stub.baseURL,
      prefixes: resolvePrefixes('intfloat/multilingual-e5-small', {}),
      tokenizer: { name: TOKENIZER, cacheDir: MODEL_CACHE_DIR, offline: true },
      log: silentLog,
    });
    await remote.warmup();
    expect(stub.requests.length).toBeGreaterThan(0); // the embedding call went to the stub, nowhere else

    const remoteCount = chunkCount(remote);
    expect(remoteCount).toBe(chunkCount(local));

    // And without the setting the count is today's estimate-driven one.
    const unset = new OpenAIEmbeddingProvider({
      apiKey: '',
      model: 'intfloat/multilingual-e5-small',
      dimensions: 384,
      baseURL: stub.baseURL,
      prefixes: resolvePrefixes('intfloat/multilingual-e5-small', {}),
      log: silentLog,
    });
    await unset.warmup();
    const estimateProvider = { passagePrefix: unset.passagePrefix, countTokens: estimateTokens } as EmbeddingProvider;
    expect(chunkCount(unset)).toBe(chunkCount(estimateProvider));
    // Pinned to the count measured before EMBEDDING_TOKENIZER existed, so the lock is a number rather than
    // the implementation checked against itself. A change to eval/corpus or the chunker moves it on purpose.
    expect(files).toHaveLength(26);
    expect(chunkCount(unset)).toBe(494);
    expect(remoteCount).not.toBe(494); // the tokenizer really changed the boundaries
  }, 120_000);
});
