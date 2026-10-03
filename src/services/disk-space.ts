import { statfs } from 'node:fs/promises';
import path from 'node:path';

/**
 * Free-space checks before work that writes a lot to one disk, so that the common case — a disk that
 * was already nearly full — becomes a refusal with a reason instead of a failure half-way.
 *
 * - **Uploads** write under `DATA_DIR`, so `DATA_DIR`'s file system is checked.
 * - **A forced re-index** writes a second generation as rows in PostgreSQL (ADR-0039), not into
 *   `DATA_DIR`. Its disk is the database's. With the embedded database the image's entrypoint passes
 *   its data directory in `CONTEXTATOR_EMBEDDED_PGDATA` and that file system is checked. With an
 *   external database (`DATABASE_URL`) its disk cannot be measured from here, and no check is made.
 *
 * The check is advisory, not a reservation: another writer can still fill the disk after it passes,
 * and a rebuild larger than the threshold can still run out. It does not promise the run will fit.
 */

export interface DiskSpace {
  /** Bytes an unprivileged process may still write (`bavail`, not `bfree`: root's reserve is not ours). */
  freeBytes: number;
  totalBytes: number;
}

export class InsufficientDiskError extends Error {
  readonly code = 'insufficient_disk';
  readonly freeBytes: number;
  readonly minFreeBytes: number;
  constructor(freeBytes: number, minFreeBytes: number, where = 'the data directory', requirement = 'DATA_DIR_MIN_FREE_BYTES') {
    super(
      `Not enough free disk space in ${where}: ${formatBytes(freeBytes)} free, ` +
        `${formatBytes(minFreeBytes)} required (${requirement}). Free some space and try again.`,
    );
    this.name = 'InsufficientDiskError';
    this.freeBytes = freeBytes;
    this.minFreeBytes = minFreeBytes;
  }
}

/** Reads the file system `dir` lives on. `DATA_DIR` may not exist yet, so the nearest existing ancestor answers for it. */
export async function readDiskSpace(dir: string): Promise<DiskSpace> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const s = await statfs(current);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch (err) {
      const parent = path.dirname(current);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw err;
      current = parent;
    }
  }
}

/**
 * Throws `InsufficientDiskError` when `dir`'s file system has fewer than `minFreeBytes` free. A
 * threshold of `0` (or unset) disables the check without touching the disk. A file system that cannot be
 * read is not a reason to refuse work: the error propagates only from the comparison, never from statfs.
 */
export async function assertDiskSpace(
  dir: string,
  minFreeBytes: number | undefined,
  read: (dir: string) => Promise<DiskSpace> = readDiskSpace,
  where?: string,
  requirement?: string,
): Promise<void> {
  if (!minFreeBytes || minFreeBytes <= 0) return;
  let space: DiskSpace;
  try {
    space = await read(dir);
  } catch {
    return;
  }
  if (space.freeBytes < minFreeBytes) throw new InsufficientDiskError(space.freeBytes, minFreeBytes, where, requirement);
}

/** The settings the rebuild check reads. */
export interface RebuildDiskSettings {
  /** Set by the image's entrypoint to the embedded PostgreSQL's data directory; unset with an external database. */
  CONTEXTATOR_EMBEDDED_PGDATA?: string;
  DATA_DIR_MIN_FREE_BYTES?: number;
}

/**
 * The check before a rebuild (a forced re-index, or a model change): the database's file system, which
 * is where the new generation is written. Only possible with the embedded database; with an external
 * one the database's disk is not measurable from this process and this returns without checking.
 */
export async function assertRebuildDiskSpace(
  settings: RebuildDiskSettings,
  read: (dir: string) => Promise<DiskSpace> = readDiskSpace,
): Promise<void> {
  if (!settings.CONTEXTATOR_EMBEDDED_PGDATA) return;
  await assertDiskSpace(settings.CONTEXTATOR_EMBEDDED_PGDATA, settings.DATA_DIR_MIN_FREE_BYTES, read, "the embedded database's data directory");
}

/**
 * How many bytes a project import is expected to land per byte of its `.tar.gz`.
 *
 * An export is NDJSON — document text, and every chunk's embedding written out as decimal floats —
 * plus the upload trees, gzipped. Text and JSON of that shape compress about three to five times, and
 * `4` — the middle of that range, not a bound — estimates the unpacked size. That size is written twice:
 * first to a scratch directory under the OS temp dir (not checked here), then for good — the upload
 * trees into `DATA_DIR`, the documents and chunks as rows (with their full-text and vector indexes)
 * into the database. The estimate covers only that second, lasting write. Like every check in this
 * module it is advisory; `unpackTar`'s `ARCHIVE_MAX_TOTAL_BYTES` cap is what actually limits the
 * expansion.
 */
export const IMPORT_EXPANSION_FACTOR = 4;

/** The settings the import check reads. */
export interface ImportDiskSettings extends RebuildDiskSettings {
  DATA_DIR: string;
}

/**
 * The check before a project import: the threshold, **plus** an estimate of what the import will
 * write — `archiveBytes × IMPORT_EXPANSION_FACTOR` — against `DATA_DIR` (where the upload trees land)
 * and, with the embedded database, against its data directory (where the rows land). With an external
 * database only `DATA_DIR` is checked, for the reason `assertRebuildDiskSpace` gives.
 *
 * `archiveBytes` of `0` (a size not known yet) reduces this to the plain threshold. A threshold of `0`
 * turns the check off entirely, estimate included: that setting is how an operator says "never refuse
 * for disk", and an import is not an exception to it.
 */
export async function assertImportDiskSpace(
  settings: ImportDiskSettings,
  archiveBytes: number,
  read: (dir: string) => Promise<DiskSpace> = readDiskSpace,
): Promise<void> {
  const minFree = settings.DATA_DIR_MIN_FREE_BYTES;
  if (!minFree || minFree <= 0) return;
  const estimate = Math.max(0, Math.ceil(archiveBytes)) * IMPORT_EXPANSION_FACTOR;
  const required = minFree + estimate;
  const requirement =
    estimate > 0
      ? `DATA_DIR_MIN_FREE_BYTES plus ${IMPORT_EXPANSION_FACTOR} × the ${formatBytes(archiveBytes)} archive this import unpacks`
      : 'DATA_DIR_MIN_FREE_BYTES';
  await assertDiskSpace(settings.DATA_DIR, required, read, 'the data directory', requirement);
  if (settings.CONTEXTATOR_EMBEDDED_PGDATA) {
    await assertDiskSpace(settings.CONTEXTATOR_EMBEDDED_PGDATA, required, read, "the embedded database's data directory", requirement);
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
