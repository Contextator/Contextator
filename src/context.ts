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
import type { AuditWriter } from './services/audit.js';
import type { MetricsRegistry } from './services/metrics.js';
import type { QueryLog } from './services/query-log.js';
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
  /**
   * Where searches are written down ([ADR-0047](../../.ssot/ADR.md#adr-0047)), or **undefined**, which
   * is what `SEARCH_QUERY_LOG=0` produces: there is then no sink for a caller to pass, so nothing in
   * the search path has anything to write to. Optional for that reason and not for convenience.
   */
  queryLog?: QueryLog;
  /**
   * The process counters `/metrics` exposes ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
   *
   * **Not optional, unlike `queryLog` above.** That one is absent when the feature is off, and its
   * absence *is* the switch. This one has no switch: the counters exist whether or not anybody scrapes
   * them, and `/metrics` being credentialed is a question about who may read the numbers rather than
   * about whether they are kept.
   */
  metrics: MetricsRegistry;
  /**
   * Where a state-changing admin action is written down ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
   *
   * Not optional either, and for a stronger reason than `metrics` above: an instance that could be
   * configured not to record who changed it would be an instance whose audit log proves nothing. The
   * retention window is the setting; whether there is a record is not.
   */
  audit: AuditWriter;
  version: string;
  startedAt: number;
}
