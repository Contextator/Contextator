import { describe, expect, it, vi } from 'vitest';

import { CHUNK_BUDGET_RESERVE_TOKENS, type Config, EnvSchema } from '../src/config.js';
import type { Logger } from '../src/context.js';
import { checkChunkBudget, chunkBudgetMessage, newChunkBudgetState, verifyChunkBudget } from '../src/services/chunk-budget.js';
import { estimateTokens } from '../src/services/chunker.js';
import { DEFAULT_UNKNOWN_WINDOW_TOKENS, MODEL_WINDOWS, resolveWindow } from '../src/services/embeddings/local.js';
import type { EmbeddingProvider } from '../src/services/embeddings/provider.js';

/**
 * The check is in two halves and they are tested as two halves (ADR-0035): `superRefine` can only speak
 * when the operator has stated a window, and `verifyChunkBudget` only ever sees a window that had to be
 * discovered. Nothing here loads a model — the point of `resolveWindow` being a pure function is that
 * the decision can be asserted without 470 MB of ONNX.
 */

const ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ALLOWED_DOC_ROOTS: '/docs',
};

const parse = (overrides: Record<string, string>) => EnvSchema.safeParse({ ...ENV, ...overrides });

const issuesFor = (result: ReturnType<typeof parse>, field: string): string[] =>
  result.success ? [] : result.error.issues.filter((i) => i.path[0] === field).map((i) => i.message);

describe('the half that runs over process.env', () => {
  it('says nothing about the window when EMBEDDING_MAX_INPUT_TOKENS is unset', () => {
    // 400 against a 128-token model was the shipped defect until ADR-0036 moved the default to 112, and
    // this half still cannot know it: `process.env` does not carry a tokenizer. Silence here is the
    // requirement, not an omission.
    const result = parse({ CHUNK_MAX_TOKENS: '400' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.EMBEDDING_MAX_INPUT_TOKENS).toBeUndefined();
  });

  it('refuses a budget the operator has themselves declared impossible', () => {
    const result = parse({ CHUNK_MAX_TOKENS: '400', EMBEDDING_MAX_INPUT_TOKENS: '128' });
    expect(result.success).toBe(false);
    expect(issuesFor(result, 'CHUNK_MAX_TOKENS')).toEqual([expect.stringContaining('EMBEDDING_MAX_INPUT_TOKENS=128')]);
    // The message carries the value to set, not just the complaint.
    expect(issuesFor(result, 'CHUNK_MAX_TOKENS')[0]).toContain(`set it to ${128 - CHUNK_BUDGET_RESERVE_TOKENS}`);
  });

  it('counts the reserve, so a budget that exactly equals the window is still refused', () => {
    expect(parse({ CHUNK_MAX_TOKENS: '128', EMBEDDING_MAX_INPUT_TOKENS: '128' }).success).toBe(false);
    expect(parse({ CHUNK_MAX_TOKENS: String(128 - CHUNK_BUDGET_RESERVE_TOKENS), EMBEDDING_MAX_INPUT_TOKENS: '128' }).success).toBe(true);
  });

  it('accepts a budget that fits, and leaves the existing overlap rule alone', () => {
    expect(parse({ CHUNK_MAX_TOKENS: '400', EMBEDDING_MAX_INPUT_TOKENS: '512' }).success).toBe(true);
    const both = parse({ CHUNK_MAX_TOKENS: '400', CHUNK_OVERLAP_TOKENS: '400', EMBEDDING_MAX_INPUT_TOKENS: '128' });
    expect(issuesFor(both, 'CHUNK_OVERLAP_TOKENS')).toEqual(['must be smaller than CHUNK_MAX_TOKENS']);
    expect(issuesFor(both, 'CHUNK_MAX_TOKENS')).toHaveLength(1);
  });
});

describe('resolving the window from what the runtime can see', () => {
  it('lowers the tokenizer ceiling to the training window for a model in the table', () => {
    // The defect in one assertion: transformers.js truncates at 512, the model was distilled at 128.
    expect(resolveWindow('Xenova/paraphrase-multilingual-MiniLM-L12-v2', 512)).toEqual({
      effective: 128,
      truncatesAt: 512,
      source: 'known-model',
    });
  });

  it('matches the table regardless of how the model id was capitalised', () => {
    expect(resolveWindow('xenova/ALL-MiniLM-L6-v2', 512).effective).toBe(MODEL_WINDOWS['xenova/all-minilm-l6-v2']);
  });

  it('takes the tokenizer at its word for a model the table does not know', () => {
    expect(resolveWindow('some-org/unknown-encoder', 512)).toEqual({ effective: 512, truncatesAt: 512, source: 'tokenizer' });
  });

  it('never reports Infinity, which would make the check a no-op that always passes', () => {
    const w = resolveWindow('some-org/unknown-encoder', Number.POSITIVE_INFINITY);
    expect(w).toEqual({ effective: DEFAULT_UNKNOWN_WINDOW_TOKENS, truncatesAt: null, source: 'default' });
    expect(Number.isFinite(w.effective)).toBe(true);
  });

  it('prefers the table over the documented default when the tokenizer states nothing', () => {
    expect(resolveWindow('Xenova/paraphrase-multilingual-MiniLM-L12-v2', Number.POSITIVE_INFINITY)).toEqual({
      effective: 128,
      truncatesAt: null,
      source: 'known-model',
    });
  });

  it('lets EMBEDDING_MAX_INPUT_TOKENS overrule both, in either direction', () => {
    expect(resolveWindow('Xenova/paraphrase-multilingual-MiniLM-L12-v2', 512, 256)).toEqual({
      effective: 256,
      truncatesAt: 512,
      source: 'configured',
    });
    expect(resolveWindow('some-org/unknown-encoder', Number.POSITIVE_INFINITY, 8192)).toEqual({
      effective: 8192,
      truncatesAt: null,
      source: 'configured',
    });
  });
});

const stubProvider = (over: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
  id: 'local:stub:fp32',
  provider: 'local',
  model: 'stub/encoder',
  dimensions: 384,
  maxInputTokens: 128,
  truncatesAtTokens: 512,
  windowSource: 'known-model',
  ready: true,
  countTokens: estimateTokens,
  warmup: async () => {},
  embed: async () => [],
  ...over,
});

const stubLog = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

describe('the half that runs after warmup', () => {
  it('flags a budget that does not fit and says what to set instead', () => {
    const config = { CHUNK_MAX_TOKENS: 400 } as Config;
    const log = stubLog();
    const chunkBudget = newChunkBudgetState();
    const warning = verifyChunkBudget({ config, embeddings: stubProvider(), log: log as unknown as Logger, chunkBudget });

    expect(warning).toMatchObject({ maxInputTokens: 128, truncatesAtTokens: 512, chunkMaxTokens: 400 });
    expect(warning?.suggestedChunkMaxTokens).toBe(128 - CHUNK_BUDGET_RESERVE_TOKENS);
    expect(chunkBudget).toEqual({ checked: true, warning });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1]).toContain('CHUNK_MAX_TOKENS=400');
  });

  it('stays quiet, and records that it looked, when the budget fits', () => {
    const config = { CHUNK_MAX_TOKENS: 400 } as Config;
    const log = stubLog();
    const chunkBudget = newChunkBudgetState();
    const warning = verifyChunkBudget({
      config,
      embeddings: stubProvider({ maxInputTokens: 8191, truncatesAtTokens: 8191, windowSource: 'known-model' }),
      log: log as unknown as Logger,
      chunkBudget,
    });

    expect(warning).toBeNull();
    // `checked` is the difference between "fits" and "nobody has looked yet", which is what the
    // dashboard needs to know before it renders anything.
    expect(chunkBudget).toEqual({ checked: true, warning: null });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('is never fatal — it returns, and the caller is a background promise', () => {
    const exit = vi.spyOn(process, 'exit');
    verifyChunkBudget({
      config: { CHUNK_MAX_TOKENS: 4000 } as Config,
      embeddings: stubProvider(),
      log: stubLog() as unknown as Logger,
      chunkBudget: newChunkBudgetState(),
    });
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('holds the budget to the same reserve the environment half applies', () => {
    const fits = { CHUNK_MAX_TOKENS: 128 - CHUNK_BUDGET_RESERVE_TOKENS } as Config;
    const overBy1 = { CHUNK_MAX_TOKENS: 128 - CHUNK_BUDGET_RESERVE_TOKENS + 1 } as Config;
    expect(checkChunkBudget(fits, stubProvider())).toBeNull();
    expect(checkChunkBudget(overBy1, stubProvider())).not.toBeNull();
  });
});

describe('the message an operator reads', () => {
  const warn = (over: Partial<EmbeddingProvider>) => checkChunkBudget({ CHUNK_MAX_TOKENS: 400 } as Config, stubProvider(over));

  it('names both limits when they differ, because accepting 400 tokens would otherwise look like a denial', () => {
    const message = chunkBudgetMessage(warn({ maxInputTokens: 128, truncatesAtTokens: 512 })!);
    expect(message).toContain('the first 128 tokens');
    expect(message).toContain('truncates at 512');
    expect(message).toContain('tokens 129-512 are read but were never trained for');
    expect(message).toContain(`Set CHUNK_MAX_TOKENS=${128 - CHUNK_BUDGET_RESERVE_TOKENS}`);
  });

  it('says the text is discarded when the two limits coincide', () => {
    const message = chunkBudgetMessage(warn({ maxInputTokens: 256, truncatesAtTokens: 256 })!);
    expect(message).toContain('everything past it is discarded');
  });

  it('claims nothing about truncation when nothing discovered it', () => {
    const message = chunkBudgetMessage(warn({ maxInputTokens: 256, truncatesAtTokens: null })!);
    expect(message).not.toContain('truncat');
  });
});
