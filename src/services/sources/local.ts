import type { DocumentSourceRow } from '../../db/schema.js';
import { resolveProjectRoot } from '../fs-scan.js';
import { parseSourceConfig } from '../sources.js';
import type { DriverContext, SourceDriver, SyncResult } from './driver.js';

/** A directory mounted into the server (must live inside ALLOWED_DOC_ROOTS). Nothing to sync. */
export class LocalDriver implements SourceDriver {
  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
  ) {}

  async sync(): Promise<SyncResult> {
    await this.docRoot(); // validates that the directory still exists and is allowed
    return {};
  }

  docRoot(): Promise<string> {
    const config = parseSourceConfig('local', this.source.config);
    return resolveProjectRoot(config.path, this.ctx.config.ALLOWED_DOC_ROOTS);
  }

  async test(): Promise<string> {
    const root = await this.docRoot();
    return `Directory is accessible: ${root}`;
  }
}
