import type { DocumentSourceRow } from '../../db/schema.js';
import { resolveProjectRoot } from '../fs-scan.js';
import { PROBE_TOKEN_KEY, parseSourceConfig } from '../sources.js';
import type { DriverContext, SourceDriver, SyncResult } from './driver.js';
import { directoryRevision } from './revision.js';

/** A directory mounted into the server (must live inside ALLOWED_DOC_ROOTS). Nothing to sync. */
export class LocalDriver implements SourceDriver {
  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
  ) {}

  async sync(): Promise<SyncResult> {
    await this.docRoot(); // validates that the directory still exists and is allowed
    // The token is taken *before* the indexer scans, so it describes a state no newer than the one
    // that gets indexed. A file written during the run therefore moves the token next time rather
    // than being recorded as already seen ([ADR-0048](../../../.ssot/ADR.md#adr-0048)).
    const token = await this.probe();
    return token === null ? {} : { configPatch: { [PROBE_TOKEN_KEY]: token } };
  }

  docRoot(): Promise<string> {
    const config = parseSourceConfig('local', this.source.config);
    return resolveProjectRoot(config.path, this.ctx.config.ALLOWED_DOC_ROOTS);
  }

  /** File count and newest mtime under the directory: one `stat` per file, no file read, no hash. */
  async probe(): Promise<string | null> {
    const config = parseSourceConfig('local', this.source.config);
    const root = await this.docRoot();
    return directoryRevision(root, { ignoreGlobs: this.ctx.config.IGNORE_GLOBS, extensions: config.extensions });
  }

  async test(): Promise<string> {
    const root = await this.docRoot();
    return `Directory is accessible: ${root}`;
  }
}
