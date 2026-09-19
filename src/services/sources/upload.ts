import fs from 'node:fs/promises';
import type { DocumentSourceRow } from '../../db/schema.js';
import { sourceCurrentDir } from '../data-dir.js';
import { PROBE_TOKEN_KEY, parseSourceConfig } from '../sources.js';
import type { DriverContext, SourceDriver, SyncResult } from './driver.js';
import { directoryRevision } from './revision.js';

/** Files uploaded through the dashboard live under `<DATA_DIR>/projects/<p>/sources/<s>/current/`. */
export class UploadDriver implements SourceDriver {
  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
  ) {}

  async sync(): Promise<SyncResult> {
    await this.docRoot();
    const token = await this.probe();
    return token === null ? {} : { configPatch: { [PROBE_TOKEN_KEY]: token } };
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * The same directory revision the local driver uses, over `current/`.
   *
   * [ADR-0048](../../../.ssot/ADR.md#adr-0048) considered a counter bumped by `UploadService.commit`
   * instead, and this is the same answer for less machinery: an upload's content changes only through
   * a commit or a delete, both of which stage into a fresh tree and swap it in ([ADR-0016](../../../.ssot/ADR.md#adr-0016)),
   * so every file the swap brings carries a new mtime. A counter would additionally have to be written
   * from a service that holds no database handle, and it would be blind to anything that touched
   * `DATA_DIR` from outside the product — a restored backup, an operator with `rsync`.
   *
   * A scheduled run of an upload source is a belt-and-braces path in any case: both write paths
   * already enqueue a run themselves, so the schedule exists to notice what they missed.
   */
  async probe(): Promise<string | null> {
    const config = parseSourceConfig('upload', this.source.config);
    const root = await this.docRoot();
    return directoryRevision(root, { ignoreGlobs: this.ctx.config.IGNORE_GLOBS, extensions: config.extensions });
  }
}
