import type { Config, WebLimits } from '../../config.js';
import type { Logger } from '../../context.js';
import type { Db } from '../../db/client.js';
import type { DocumentSourceRow } from '../../db/schema.js';
import { ValidationError } from '../projects.js';
import type { SourceType } from '../sources.js';
import { LocalDriver } from './local.js';
import { UploadDriver } from './upload.js';

export interface DriverContext {
  db: Db;
  log: Logger;
  /**
   * `CONFLUENCE_ALLOWED_HOSTS` is optional here only so that a context built for another driver need not
   * carry it; absent reads as the empty list, which is the strictest the Confluence egress can be.
   */
  config: Pick<Config, 'ALLOWED_DOC_ROOTS' | 'DATA_DIR' | 'SECRET_KEY' | 'SECRET_KEY_PREVIOUS' | 'IGNORE_GLOBS'> &
    Partial<Pick<Config, 'CONFLUENCE_ALLOWED_HOSTS'>> &
    WebLimits;
}

export interface SyncResult {
  /** Driver-owned config keys to persist (e.g. git `lastCommit`, and `syncProbeToken`). */
  configPatch?: Record<string, unknown>;
  /** Human-readable note for the run log (e.g. "already up to date"). */
  note?: string;
}

/**
 * One implementation per source type. `sync` brings the materialised copy up to date (no-op for local
 * and upload sources); `docRoot` is the directory the indexer scans afterwards.
 */
export interface SourceDriver {
  sync(): Promise<SyncResult>;
  docRoot(): Promise<string>;
  /** Optional connectivity check for the dashboard's "Test" button. */
  test?(): Promise<string>;
  /**
   * A **cheap** revision token for the source as it stands right now, compared by the scheduler
   * against the one the last successful sync stored ([ADR-0048](../../../.ssot/ADR.md#adr-0048)).
   * Equal means the run would find nothing and is not queued.
   *
   * Three rules hold this together, and each of them is load-bearing:
   *
   * 1. **`null`, a throw, or no `probe` at all means "run it".** Never "skip it". A probe is an
   *    optimisation, and an optimisation that can silently stop a source syncing is a bug that looks
   *    like a working product for weeks. Every uncertainty resolves toward the run.
   * 2. **Cheap is measured against `sync()`, not against zero.** `git ls-remote` beside a fetch, one
   *    `search` beside hundreds of throttled page reads, a `stat` walk beside reading and hashing
   *    every byte. A probe that costs most of the run it avoids is the proposal this entry rejected.
   * 3. **The token a sync stores is produced by this same method**, returned in the sync's
   *    `configPatch` under `PROBE_TOKEN_KEY` (`services/sources.ts`). Both sides of the comparison are therefore the same
   *    function of the same source, which is the only reason "equal" can be trusted — a token derived
   *    one way on the way in and another on the way out drifts on the first edge case.
   */
  probe?(): Promise<string | null>;
}

type DriverFactory = (source: DocumentSourceRow, ctx: DriverContext) => SourceDriver;

const factories: Partial<Record<SourceType, DriverFactory>> = {
  local: (source, ctx) => new LocalDriver(source, ctx),
  upload: (source, ctx) => new UploadDriver(source, ctx),
};

/** Later phases (git, notion) register themselves here at import time. */
export function registerDriver(type: SourceType, factory: DriverFactory): void {
  factories[type] = factory;
}

export function isDriverAvailable(type: SourceType): boolean {
  return Boolean(factories[type]);
}

export function driverFor(source: DocumentSourceRow, ctx: DriverContext): SourceDriver {
  const factory = factories[source.type as SourceType];
  if (!factory) throw new ValidationError(`Source type "${source.type}" is not supported by this server`);
  return factory(source, ctx);
}
