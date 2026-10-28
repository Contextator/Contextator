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
   * `WEB_ALLOWED_HOSTS` and `GIT_ALLOWED_HOSTS` are optional and read the same way for the web and git
   * sources' egress.
   * `GIT_MAX_PACK_BYTES` is optional for the same reason; absent reads as `GIT_MAX_PACK_BYTES_DEFAULT`.
   * `CONFLUENCE_MAX_PAGES` and `NOTION_MAX_PAGES` are optional for the same reason; absent reads as
   * `SOURCE_PAGE_LIMIT_DEFAULTS`.
   */
  config: Pick<Config, 'ALLOWED_DOC_ROOTS' | 'DATA_DIR' | 'SECRET_KEY' | 'SECRET_KEY_PREVIOUS' | 'IGNORE_GLOBS'> &
    Partial<
      Pick<
        Config,
        | 'CONFLUENCE_ALLOWED_HOSTS'
        | 'WEB_ALLOWED_HOSTS'
        | 'GIT_ALLOWED_HOSTS'
        | 'GIT_MAX_PACK_BYTES'
        | 'CONFLUENCE_MAX_PAGES'
        | 'NOTION_MAX_PAGES'
        | 'NOTION_OAUTH_CLIENT_ID'
        | 'NOTION_OAUTH_CLIENT_SECRET'
      >
    > &
    WebLimits;
}

export interface SyncResult {
  /** Driver-owned config keys to persist (e.g. git `lastCommit`, and `syncProbeToken`). */
  configPatch?: Record<string, unknown>;
  /** Human-readable note for the run log (e.g. "already up to date"). */
  note?: string;
}

/** One scanned file, as the indexer hands it to `documentMeta`. */
export interface DocumentMetaFile {
  /** Relative to `docRoot()`, `/`-separated, without the source-name prefix. */
  path: string;
  absolutePath: string;
  /** The file's modification time, taken by the scan that found it. */
  mtimeMs: number;
}

/**
 * Where a document lives at its origin and when the origin last changed it
 * ([ADR-0116](../../../.ssot/ADR.md#adr-0116)). Either half may be unknown, and unknown is `null` — never a
 * guess and never the time of the sync.
 */
export interface DocumentMeta {
  url: string | null;
  modifiedAt: Date | null;
  /**
   * `true` when the values describe the moment the document was **observed** rather than a property the
   * origin keeps for it (git: a shallow clone has one commit, so the date is the head's, not the file's).
   * The indexer then stamps them when a document is new or its content changed and leaves a stored value
   * alone otherwise, so an unrelated commit does not make every document in the repository look edited today.
   */
  stampOnChange?: boolean;
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
  /**
   * The origin address and last-modified date of the scanned files, keyed by `DocumentMetaFile.path`
   * ([ADR-0116](../../../.ssot/ADR.md#adr-0116)). Called once per run after `sync()` and the scan.
   *
   * It reads what `sync()` left on disk and **never calls the remote** — a run must not cost another request
   * per page for a link. A file missing from the map has neither value. The indexer treats a throw as "no
   * metadata this run", so a driver may let an unexpected error escape; it never fails the run.
   */
  documentMeta?(files: readonly DocumentMetaFile[]): Promise<Map<string, DocumentMeta>>;
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
