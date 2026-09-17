import fs from 'node:fs/promises';
import type { DocumentSourceRow } from '../../db/schema.js';
import { sourceCurrentDir } from '../data-dir.js';
import type { DriverContext, SourceDriver, SyncResult } from './driver.js';

/** Files uploaded through the dashboard live under `<DATA_DIR>/projects/<p>/sources/<s>/current/`. */
export class UploadDriver implements SourceDriver {
  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
  ) {}

  async sync(): Promise<SyncResult> {
    await this.docRoot();
    return {};
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
}
