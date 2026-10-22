import fs from 'node:fs/promises';
import type { DocumentSourceRow } from '../../db/schema.js';
import { sourceCurrentDir } from '../data-dir.js';
import { allowedExtensionsFor, type Flavor } from '../flavors.js';
import { PROBE_TOKEN_KEY, parseSourceConfig } from '../sources.js';
import type { DocumentMeta, DocumentMetaFile, DriverContext, SourceDriver, SyncResult } from './driver.js';
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
   * Neither an address nor a date ([ADR-0116](../../../.ssot/ADR.md#adr-0116)): a file's mtime here is the moment the
   * upload was swapped in ([ADR-0016](../../../.ssot/ADR.md#adr-0016)), not when its author last changed it, so it would say
   * "edited today" about a document that may be years old.
   */
  async documentMeta(files: readonly DocumentMetaFile[]): Promise<Map<string, DocumentMeta>> {
    return new Map(files.map((f) => [f.path, { url: null, modifiedAt: null }]));
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
    return directoryRevision(root, {
      ignoreGlobs: this.ctx.config.IGNORE_GLOBS,
      extensions: config.extensions,
      // The same widening the run's own scan does, or the token would not count the files it indexes
      // ([ADR-0057](../../../.ssot/ADR.md#adr-0057)).
      allowedExtensions: allowedExtensionsFor(this.source.flavor as Flavor),
    });
  }
}
