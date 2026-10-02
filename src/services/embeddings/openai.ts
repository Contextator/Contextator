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

/** What the SDK talks to when nothing else is configured. Stated here so that it never reads `process.env` itself. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_HOST = new URL(OPENAI_DEFAULT_BASE_URL).host;

/** Satisfies the SDK's constructor for an endpoint that takes no key; never sent (see `getClient`). */
const KEYLESS_PLACEHOLDER = 'keyless';

/** `EMBEDDING_REQUEST_DIMENSIONS`: whether the request carries `dimensions`. */
export type RequestDimensions = 'auto' | 'always' | 'never';

/**
 * The segment `provider.id` grows when the requests go somewhere other than OpenAI, and **nothing when
 * they do not**.
 *
 * Two servers answering to the same model name are not guaranteed to be the same weights — an Ollama
 * tag, a vLLM build and OpenAI's own model can share a string and disagree on every vector — so the
 * endpoint belongs inside the re-index guard of [ADR-0007](../../../.ssot/ADR.md#adr-0007). The host
 * (with its port, without its path or credentials) is what identifies the server; `api.openai.com`
 * adds nothing, so every installation that never set a base URL keeps the id it had.
 *
 * Only `EMBEDDING_BASE_URL` reaches this function. The legacy `OPENAI_BASE_URL` routes requests but
 * never enters the id: installations that relied on it before this segment existed keep the id their
 * projects are stamped with, and moving to the new name is the deliberate step that re-indexes.
 */
export function endpointIdSegment(baseURL: string): string {
  const host = new URL(baseURL).host;
  return host === OPENAI_HOST ? '' : `@${host}`;
}

export interface OpenAIEmbeddingOptions {
  /** Empty for an endpoint that takes no key; the request then carries no `Authorization` header. */
  apiKey: string;
  model: string;
  /** `EMBEDDING_BASE_URL`: where the requests go, and the host `provider.id` names. */
  baseURL?: string;
  /**
   * `OPENAI_BASE_URL`, the legacy name: where the requests go when `baseURL` is unset, and **never part
   * of `provider.id`**, so an installation that set it before 0.2.1 keeps its id and is not re-indexed.
   */
  legacyBaseURL?: string;
  /** `EMBEDDING_REQUEST_DIMENSIONS`. `auto` when absent. */
  requestDimensions?: RequestDimensions;
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
  readonly baseURL: string;
  private readonly sendDimensions: boolean;
  /** The requests go somewhere other than `api.openai.com`, through either name. */
  private readonly selfHosted: boolean;
  private client: OpenAI | undefined;
  private isReady = false;

  constructor(private readonly opts: OpenAIEmbeddingOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.baseURL = opts.baseURL ?? opts.legacyBaseURL ?? OPENAI_DEFAULT_BASE_URL;
    this.selfHosted = endpointIdSegment(this.baseURL) !== '';
    const idSegment = opts.baseURL === undefined ? '' : endpointIdSegment(opts.baseURL);
    const requestDimensions = opts.requestDimensions ?? 'auto';
    // `auto` is what this provider always did: only the text-embedding-3 family accepts `dimensions`.
    this.sendDimensions = requestDimensions === 'always' || (requestDimensions === 'auto' && opts.model.startsWith('text-embedding-3'));
    const prefixes = opts.prefixes ?? NO_PREFIXES;
    this.queryPrefix = prefixes.query;
    this.passagePrefix = prefixes.passage;
    this.id = `openai:${opts.model}:${opts.dimensions}${idSegment}${prefixIdSegment(prefixes)}`;
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
      // Base URL and key stated explicitly, so the SDK never falls back to `OPENAI_BASE_URL` /
      // `OPENAI_API_KEY` from the process environment behind the configuration's back. The SDK refuses
      // to construct without a credential, so a keyless endpoint gets a placeholder that never leaves
      // the process: the `Authorization: null` default header strips it from every request.
      //
      // The SDK also reads `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` from the environment and sends them as
      // `OpenAI-Organization` / `OpenAI-Project` on every request. That is OpenAI's own business, and an
      // installation on OpenAI keeps it; a self-hosted or third-party endpoint is not told either.
      const keyless = this.opts.apiKey === '';
      this.client = new OpenAIClient({
        baseURL: this.baseURL,
        apiKey: keyless ? KEYLESS_PLACEHOLDER : this.opts.apiKey,
        ...(this.selfHosted ? { organization: null, project: null } : {}),
        ...(keyless ? { defaultHeaders: { Authorization: null } } : {}),
      });
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
    const res = await client.embeddings.create({
      model: this.model,
      input: texts,
      // The SDK asks for base64 unless told otherwise, and not every compatible server implements it.
      // OpenAI itself keeps the SDK's default, so nothing changes for an installation that never set a
      // base URL.
      ...(this.selfHosted ? { encoding_format: 'float' as const } : {}),
      ...(this.sendDimensions ? { dimensions: this.dimensions } : {}),
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
