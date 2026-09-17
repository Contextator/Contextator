import type { Config } from '../../config.js';
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
  config: Pick<Config, 'ALLOWED_DOC_ROOTS' | 'DATA_DIR' | 'SECRET_KEY'>;
}

export interface SyncResult {
  /** Driver-owned config keys to persist (e.g. git `lastCommit`). */
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
