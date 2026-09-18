import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHUNK_TOKENIZER_RESERVE_TOKENS, type Config } from '../src/config.js';
import type { Logger } from '../src/context.js';
import { chunkReserveTokens } from '../src/services/chunk-budget.js';
import { estimateTokens } from '../src/services/chunker.js';
import { configuredPrefixes } from '../src/services/embeddings/index.js';
import { LocalEmbeddingProvider } from '../src/services/embeddings/local.js';
import { OpenAIEmbeddingProvider } from '../src/services/embeddings/openai.js';
import { NO_PREFIX_SENTINEL, prefixesForModel, prefixIdSegment, resolvePrefixes } from '../src/services/embeddings/prefixes.js';
import type { EmbeddingProvider } from '../src/services/embeddings/provider.js';

/** ADR-0038: which prefixes a model gets, who may change them, and what that does to `provider.id`. */

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

const localProvider = (model: string, prefixes: ReturnType<typeof resolvePrefixes>, log = silentLog) =>
  new LocalEmbeddingProvider({
    model,
    dimensions: 384,
    cacheDir: path.resolve('.cache/models'),
    dtype: 'fp32',
    offline: true,
    prefixes,
    log,
  });

describe('the table', () => {
  it('gives the multilingual-e5 family the two prefixes its model card requires', () => {
    for (const model of ['Xenova/multilingual-e5-small', 'intfloat/multilingual-e5-base', 'intfloat/multilingual-e5-large']) {
      expect(prefixesForModel(model)).toEqual({ query: 'query: ', passage: 'passage: ' });
    }
  });

  it('keeps the trailing space, which is the part that is easy to lose', () => {
    expect(prefixesForModel('Xenova/multilingual-e5-small').passage).toBe('passage: ');
  });

  it('gives everything else nothing at all, so the two methods are the same function', () => {
    for (const model of ['Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'Xenova/all-MiniLM-L6-v2', 'text-embedding-3-small']) {
      expect(prefixesForModel(model)).toEqual({ query: '', passage: '' });
    }
  });
});

describe('the operator overrides', () => {
  it('replaces one side without disturbing the other', () => {
    expect(resolvePrefixes('Xenova/multilingual-e5-small', { query: 'soru: ' })).toEqual({ query: 'soru: ', passage: 'passage: ' });
    expect(resolvePrefixes('Xenova/multilingual-e5-small', { passage: 'metin: ' })).toEqual({ query: 'query: ', passage: 'metin: ' });
  });

  it('adds a prefix to a model the table does not know', () => {
    expect(resolvePrefixes('some-org/e5-like', { query: 'query: ', passage: 'passage: ' })).toEqual({ query: 'query: ', passage: 'passage: ' });
  });

  /**
   * The trap this sentinel exists for: `loadConfig` drops empty-string values so `.env.example`'s
   * placeholders read as unset, so `EMBEDDING_QUERY_PREFIX=` never reaches here and cannot mean
   * "no prefix". Without the sentinel an operator on an e5 has no way to turn the prefixes off.
   */
  it('turns a prefix off with the sentinel, which an empty value cannot do', () => {
    expect(resolvePrefixes('Xenova/multilingual-e5-small', { query: NO_PREFIX_SENTINEL, passage: NO_PREFIX_SENTINEL })).toEqual({
      query: '',
      passage: '',
    });
    expect(resolvePrefixes('Xenova/multilingual-e5-small', { query: '  NONE  ' }).query).toBe('');
    // An absent variable is the table's answer, which is the case an empty value collapses into.
    expect(resolvePrefixes('Xenova/multilingual-e5-small', {}).query).toBe('query: ');
  });

  it('reads both variables off the configured model, local or OpenAI', () => {
    const base = { EMBEDDING_MODEL: 'Xenova/multilingual-e5-small', OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small' };
    expect(configuredPrefixes({ ...base, EMBEDDING_PROVIDER: 'local' } as Config)).toEqual({ query: 'query: ', passage: 'passage: ' });
    expect(configuredPrefixes({ ...base, EMBEDDING_PROVIDER: 'openai' } as Config)).toEqual({ query: '', passage: '' });
    expect(configuredPrefixes({ ...base, EMBEDDING_PROVIDER: 'openai', EMBEDDING_PASSAGE_PREFIX: 'passage: ' } as Config)).toEqual({
      query: '',
      passage: 'passage: ',
    });
  });
});

describe('the provider id', () => {
  it('grows a segment only when the prefixes are not empty', () => {
    expect(prefixIdSegment({ query: '', passage: '' })).toBe('');
    expect(prefixIdSegment({ query: 'query: ', passage: 'passage: ' })).toBe(':"query: "+"passage: "');
  });

  /** ADR-0007's re-index guard only works if a corpus indexed with prefixes is a different id. */
  it('changes when an operator changes a prefix, and not otherwise', () => {
    const plain = localProvider('Xenova/all-MiniLM-L6-v2', resolvePrefixes('Xenova/all-MiniLM-L6-v2')).id;
    expect(plain).toBe('local:Xenova/all-MiniLM-L6-v2:fp32');

    const e5 = localProvider('Xenova/multilingual-e5-small', resolvePrefixes('Xenova/multilingual-e5-small')).id;
    expect(e5).toBe('local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: "');

    const off = localProvider('Xenova/multilingual-e5-small', resolvePrefixes('Xenova/multilingual-e5-small', { query: 'none', passage: 'none' })).id;
    expect(off).toBe('local:Xenova/multilingual-e5-small:fp32');
    expect(off).not.toBe(e5);

    const tweaked = localProvider('Xenova/multilingual-e5-small', resolvePrefixes('Xenova/multilingual-e5-small', { query: 'soru: ' })).id;
    expect(tweaked).not.toBe(e5);
  });

  it('does the same on the OpenAI side', () => {
    const opts = { apiKey: '', model: 'text-embedding-3-small', dimensions: 1536, log: silentLog };
    expect(new OpenAIEmbeddingProvider({ ...opts, prefixes: { query: '', passage: '' } }).id).toBe('openai:text-embedding-3-small:1536');
    expect(new OpenAIEmbeddingProvider({ ...opts, prefixes: { query: 'query: ', passage: 'passage: ' } }).id).toBe(
      'openai:text-embedding-3-small:1536:"query: "+"passage: "',
    );
  });
});

describe('what the passage prefix costs the chunk budget', () => {
  const stub = (passagePrefix: string): Pick<EmbeddingProvider, 'passagePrefix' | 'countTokens'> => ({
    passagePrefix,
    countTokens: estimateTokens,
  });

  it('is only the tokenizer specials when there is no prefix', () => {
    expect(chunkReserveTokens(stub(''))).toBe(CHUNK_TOKENIZER_RESERVE_TOKENS);
  });

  it("adds the prefix, counted with the model's own counter", () => {
    expect(chunkReserveTokens(stub('passage: '))).toBe(CHUNK_TOKENIZER_RESERVE_TOKENS + estimateTokens('passage: '));
  });
});

/**
 * The cheapest proof that the wiring is real rather than merely well-typed: a query and a passage of the
 * same text have to be two different vectors when prefixes are configured, and the same one when they
 * are not. It needs the model itself and not only its tokenizer, so it is gated on the cache exactly as
 * the tokenizer test in `chunker.test.ts` is, rather than downloading 470 MB into `npm test`.
 */
const MODEL = 'Xenova/multilingual-e5-small';
const CACHE_DIR = path.resolve('.cache/models');
const cached = existsSync(path.join(CACHE_DIR, MODEL, 'onnx', 'model.onnx'));

describe.skipIf(!cached)('the real model, both sides of the same sentence', () => {
  const TEXT = 'Webhook imzası nasıl doğrulanır?';

  it('encodes a query and a passage differently when the model has prefixes', async () => {
    const provider = localProvider(MODEL, resolvePrefixes(MODEL));
    expect(provider.queryPrefix).toBe('query: ');

    const query = await provider.embedQuery(TEXT);
    const [passage] = await provider.embedPassages([TEXT]);

    expect(query).toHaveLength(384);
    expect(passage).toHaveLength(384);
    expect(query).not.toEqual(passage);
    // Not merely unequal in the last decimal: the two encodings are visibly apart.
    const cosine = query.reduce((sum, x, i) => sum + x * passage[i], 0);
    expect(cosine).toBeLessThan(0.999);
  }, 120_000);

  it('encodes them identically when it does not', async () => {
    const provider = localProvider(MODEL, resolvePrefixes(MODEL, { query: NO_PREFIX_SENTINEL, passage: NO_PREFIX_SENTINEL }));
    expect(provider.queryPrefix).toBe('');

    const query = await provider.embedQuery(TEXT);
    const [passage] = await provider.embedPassages([TEXT]);

    expect(query).toEqual(passage);
  }, 120_000);
});
