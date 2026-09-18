import type OpenAI from 'openai';
import type { Logger } from '../../context.js';
import { estimateTokens } from '../chunker.js';
import { type EmbeddingPrefixes, NO_PREFIXES, prefixIdSegment } from './prefixes.js';
import { EmbeddingDimensionError, type EmbeddingProvider, type EmbeddingWindowSource } from './provider.js';

/**
 * `text-embedding-3-small`, `text-embedding-3-large` and `text-embedding-ada-002` all take 8191 tokens,
 * and the API rejects a longer input rather than truncating it. **This is not discovered.** There is no
 * endpoint that states a model's context, so unlike the local provider (ADR-0035) this number is written
 * down, is only true for the models named above, and goes stale without anything noticing. An operator
 * on a model with a different window states it in `EMBEDDING_MAX_INPUT_TOKENS`.
 */
const OPENAI_WINDOW_TOKENS = 8191;

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  /** `EMBEDDING_MAX_INPUT_TOKENS`. The only way this provider learns about a model it does not know. */
  maxInputTokens?: number;
  /**
   * Empty for every model this provider is likely to see — no OpenAI embedding model is documented as
   * taking an instruction prefix — but the two variables still reach here, because the abstraction costs
   * nothing when the strings are empty and an operator on a self-hosted OpenAI-compatible endpoint may
   * well be running an e5 behind it (ADR-0038).
   */
  prefixes?: EmbeddingPrefixes;
  log: Logger;
}

/** OpenAI embeddings. The SDK is imported lazily so the local-only deployment never loads it. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly id: string;
  readonly maxInputTokens: number;
  /** The API refuses an over-long input instead of silently cutting it, so the two limits coincide here. */
  readonly truncatesAtTokens: number;
  readonly windowSource: EmbeddingWindowSource;
  readonly queryPrefix: string;
  readonly passagePrefix: string;
  private client: OpenAI | undefined;
  private isReady = false;

  constructor(private readonly opts: OpenAIEmbeddingOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    const prefixes = opts.prefixes ?? NO_PREFIXES;
    this.queryPrefix = prefixes.query;
    this.passagePrefix = prefixes.passage;
    this.id = `openai:${opts.model}:${opts.dimensions}${prefixIdSegment(prefixes)}`;
    this.maxInputTokens = opts.maxInputTokens ?? OPENAI_WINDOW_TOKENS;
    this.truncatesAtTokens = this.maxInputTokens;
    this.windowSource = opts.maxInputTokens === undefined ? 'known-model' : 'configured';
  }

  get ready(): boolean {
    return this.isReady;
  }

  /**
   * The characters ÷ 4 estimate, and deliberately so. Counting exactly would mean `tiktoken` — the
   * dependency [ADR-0008](../../../.ssot/ADR.md#adr-0008) rejected and ADR-0036 does not reopen, because
   * the argument for reopening it is a window this provider never comes close to: 8191 tokens against a
   * budget in the hundreds. The asymmetry is real and documented rather than papered over — an operator
   * on OpenAI gets approximate chunk boundaries, and nothing they can observe depends on them.
   */
  countTokens(text: string): number {
    return estimateTokens(text);
  }

  private async getClient(): Promise<OpenAI> {
    if (!this.client) {
      const { default: OpenAIClient } = await import('openai');
      this.client = new OpenAIClient({ apiKey: this.opts.apiKey });
    }
    return this.client;
  }

  async warmup(): Promise<void> {
    await this.embedPassages(['warmup']);
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return this.encode(texts.map((text) => this.passagePrefix + text));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.encode([this.queryPrefix + text]);
    return vector;
  }

  /** The one API call both sides share. Private: the prefix is applied above it, never around it. */
  private async encode(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = await this.getClient();
    // Only the text-embedding-3 family accepts a custom `dimensions` value.
    const supportsDimensions = this.model.startsWith('text-embedding-3');
    const res = await client.embeddings.create({
      model: this.model,
      input: texts,
      ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
    });
    const rows = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const row of rows) {
      if (row.length !== this.dimensions) {
        throw new EmbeddingDimensionError(
          `OpenAI model ${this.model} returned ${row.length}-dimensional vectors but EMBEDDING_DIMENSIONS=${this.dimensions}.`,
        );
      }
    }
    this.isReady = true;
    return rows;
  }
}
