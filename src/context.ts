import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { EmbeddingProvider } from './services/embeddings/provider.js';
import type { ChunkBudgetState } from './services/chunk-budget.js';
import type { Indexer } from './services/indexer.js';
import type { KeyedMutex } from './services/locks.js';
import type { UploadService } from './services/uploads.js';
import type { SessionRegistry } from './mcp/sessions.js';
import type { SetupGate } from './services/auth/setup.js';
import type { SlidingWindow } from './services/rate-limit.js';

/** pino-compatible logger (Fastify's). Services receive it instead of importing a global. */
export type Logger = FastifyBaseLogger;

/** Composition root output: everything route plugins and MCP tools need, wired once in server.ts. */
export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  embeddings: EmbeddingProvider;
  /** Whether CHUNK_MAX_TOKENS fits the model's window, filled in after warmup and sticky (ADR-0035). */
  chunkBudget: ChunkBudgetState;
  indexer: Indexer;
  /** Per-project mutex shared by the indexer, upload commits and source deletion. */
  locks: KeyedMutex;
  uploads: UploadService;
  sessions: SessionRegistry;
  /** First-run state: whether any account exists and, until one does, the one-time code. */
  setup: SetupGate;
  /** Per-IP budget for sign-in and setup attempts. */
  loginLimiter: SlidingWindow;
  version: string;
  startedAt: number;
}
