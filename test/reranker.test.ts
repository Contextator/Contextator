import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createReranker } from '../src/services/reranker.js';

/**
 * The rerank is a spike that was measured and left off ([ROADMAP.md](../.ssot/ROADMAP.md) Item 12,
 * `eval/BASELINE.md`). Nothing here runs a model — the point of the file is the default, because the
 * default is the load-bearing part: the gated `eval` job measures the configuration the product ships,
 * and a rerank that switched itself on would make that job measure an experiment instead.
 */

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof createReranker>[1];

function config(env: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    SESSION_SECRET: 'x'.repeat(32),
    ...env,
  });
}

describe('the cross-encoder rerank', () => {
  it('is off unless an operator asks for it, and builds nothing when it is off', () => {
    const c = config();
    expect(c.SEARCH_RERANK).toBe('off');
    expect(createReranker(c, silent)).toBeNull();
  });

  it('names the model and the dtype in its id, so a reranked run is visibly a different run', () => {
    const reranker = createReranker(config({ SEARCH_RERANK: 'on' }), silent);
    expect(reranker).not.toBeNull();
    // The same shape as `provider.id`, and for the same reason: two runs that differ in the model are
    // two runs, and a report that printed neither could not say which one it was.
    expect(reranker?.id).toBe('local-rerank:Xenova/bge-reranker-base:q8');
  });

  it('carries the operator’s model and dtype into that id', () => {
    const reranker = createReranker(
      config({ SEARCH_RERANK: 'on', SEARCH_RERANK_MODEL: 'Xenova/bge-reranker-large', SEARCH_RERANK_DTYPE: 'fp16' }),
      silent,
    );
    expect(reranker?.id).toBe('local-rerank:Xenova/bge-reranker-large:fp16');
  });

  it('refuses a pair window narrower than a chunk would need', () => {
    expect(() => config({ SEARCH_RERANK_MAX_TOKENS: '8' })).toThrow();
  });
});
