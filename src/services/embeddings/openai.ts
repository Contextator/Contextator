import type OpenAI from 'openai';
import type { Logger } from '../../context.js';
import { EmbeddingDimensionError, type EmbeddingProvider } from './provider.js';

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  log: Logger;
}

/** OpenAI embeddings. The SDK is imported lazily so the local-only deployment never loads it. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly id: string;
  private client: OpenAI | undefined;
  private isReady = false;

  constructor(private readonly opts: OpenAIEmbeddingOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.id = `openai:${opts.model}:${opts.dimensions}`;
  }

  get ready(): boolean {
    return this.isReady;
  }

  private async getClient(): Promise<OpenAI> {
    if (!this.client) {
      const { default: OpenAIClient } = await import('openai');
      this.client = new OpenAIClient({ apiKey: this.opts.apiKey });
    }
    return this.client;
  }

  async warmup(): Promise<void> {
    await this.embed(['warmup']);
  }

  async embed(texts: string[]): Promise<number[][]> {
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
