import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { DocumentSourceRow } from '../db/schema.js';
import { cleanEntryPath, extractArchive, importTree, isArchiveName, type ImportLimits, type ImportStats } from './archives.js';
import { mergeDirectory, sourceCurrentDir, stagingDir, swapDirectory } from './data-dir.js';
import { QuotaExceededError } from './errors.js';
import { allowedExtensionsFor, type Flavor } from './flavors.js';
import { isInside, normalizeRelativePath } from './fs-scan.js';
import type { KeyedMutex } from './locks.js';
import { NotFoundError, ValidationError } from './projects.js';
import { directoryBytes, fileSize, overwrittenBytes, UPLOAD_SESSION_TTL_MS } from './quotas.js';

/**
 * The upload quota in force for one request ([ADR-0117](../../.ssot/ADR.md#adr-0117)). Only built when the
 * project's effective limit is above `0`, so an unlimited project never pays for the directory scan.
 */
export interface UploadQuota {
  limit: number;
  /**
   * What the project's upload sources store, staging of every live session included. For a commit it leaves out
   * the committing session, whose files are measured on their own.
   */
  used: number;
  /** The part of `used` that is the `current/` tree of the source being written to. */
  sourceCurrent: number;
}

/**
 * What the requests of one project that are in flight right now have added, net of the files they overwrite.
 * It exists so that concurrent `files` requests see each other: each measures the project from the disk when
 * it starts, and none of them could otherwise know about the bytes the others write afterwards. It lives only
 * while a request of the project does, and is dropped when the last one ends.
 */
interface ProjectReservation {
  /** Requests that have joined and not yet finished or been taken back. */
  active: number;
  /** The sum of `requestBytes` over every request that joined since the first of the current ones, including those that finished. */
  reserved: number;
}

/**
 * Tracks one `.../files` request against the quota. The request writes into a scratch directory of its own
 * beside the session's `files/`, so that a request the quota refuses is taken back by deleting that one
 * directory and cannot touch what earlier requests staged; `finishRequest` moves it into place.
 */
export class UploadRequestQuota {
  /** Bytes this request adds, net of the files it overwrites. */
  requestBytes = 0;
  /** What the request has written so far, by path relative to the scratch directory: a path sent twice is charged for its growth only. */
  readonly written = new Map<string, number>();
  /** Set once the request has finished or been taken back, so that it leaves the reservation once. */
  left = false;
  constructor(
    readonly limit: number,
    /** What the project stores when the request began, with the session's overwrites of `current/` counted once. */
    readonly baseUsed: number,
    readonly scratchDir: string,
    readonly filesDir: string,
    readonly currentDir: string,
    readonly reservation: ProjectReservation = { active: 1, reserved: 0 },
    /** `reservation.reserved` when the request joined, taken before the project was measured: what came after is not in `baseUsed`. */
    readonly reservedAtStart: number = 0,
    readonly projectId: string = '',
  ) {}

  /** What the project holds as far as this request can tell: the measurement plus everything requests have added since. */
  get projectedUsed(): number {
    return this.baseUsed + this.reservation.reserved - this.reservedAtStart;
  }
}

/** Moves every file of `from` into `to` (creating directories), overwriting what is there. */
async function moveTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await moveTree(src, dst);
    else if (entry.isFile()) await fs.rename(src, dst);
  }
}

/**
 * Upload sessions: files arrive in `.staging/<session>/files/` (any number of requests), then `commit`
 * merges them into the source's `current/` tree (mode `add`) or replaces it (mode `replace`).
 * Staging lives in a dot-directory, so a running scan never sees half-uploaded files.
 */
export class UploadService {
  constructor(
    private readonly config: Pick<
      Config,
      'DATA_DIR' | 'UPLOAD_MAX_FILE_BYTES' | 'UPLOAD_MAX_ARCHIVE_BYTES' | 'ARCHIVE_MAX_ENTRIES' | 'ARCHIVE_MAX_TOTAL_BYTES'
    >,
  ) {}

  /** Per project, the requests in flight (see `ProjectReservation`). */
  private readonly reservations = new Map<string, ProjectReservation>();

  private join(projectId: string): { reservation: ProjectReservation; reservedAtStart: number } {
    let reservation = this.reservations.get(projectId);
    if (!reservation) {
      reservation = { active: 0, reserved: 0 };
      this.reservations.set(projectId, reservation);
    }
    reservation.active++;
    return { reservation, reservedAtStart: reservation.reserved };
  }

  private leave(projectId: string, reservation: ProjectReservation): void {
    reservation.active--;
    if (reservation.active <= 0 && this.reservations.get(projectId) === reservation) this.reservations.delete(projectId);
  }

  private limitsFor(source: DocumentSourceRow): ImportLimits {
    const extensions = (source.config as { extensions?: string[] }).extensions ?? ['md', 'mdx', 'txt'];
    return {
      maxEntries: this.config.ARCHIVE_MAX_ENTRIES,
      maxTotalBytes: this.config.ARCHIVE_MAX_TOTAL_BYTES,
      maxFileBytes: this.config.UPLOAD_MAX_FILE_BYTES,
      extensions,
      pathFlavor: source.flavor as Flavor,
      // A live upload source: the tree being built *is* the source's own, so its content type decides
      // both the path cleanup and which extensions may land ([ADR-0057](../../.ssot/ADR.md#adr-0057)).
      allowedExtensions: allowedExtensionsFor(source.flavor as Flavor),
    };
  }

  private filesDir(source: DocumentSourceRow, session: string): string {
    return path.join(stagingDir(this.config.DATA_DIR, source.projectId, source.id, session), 'files');
  }

  async createSession(source: DocumentSourceRow, quota?: UploadQuota): Promise<string> {
    // A project already at its cap gets no session at all: the transfer that would follow is certain to be
    // refused, and refusing now saves the sender the upload.
    if (quota && quota.used >= quota.limit) throw new QuotaExceededError('max_upload_bytes', quota.limit, quota.used, 0);
    const session = randomBytes(16).toString('hex');
    await fs.mkdir(this.filesDir(source, session), { recursive: true });
    return session;
  }

  private async requireSession(source: DocumentSourceRow, session: string): Promise<string> {
    const dir = this.filesDir(source, session);
    try {
      if (!(await fs.stat(dir)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new NotFoundError('Upload session not found or already committed');
    }
    // Any use of a session renews it: a session untouched for `UPLOAD_SESSION_TTL_MS` stops counting against
    // the quota (see `projectUploadUsage`), and a person still uploading must not lose their share.
    const now = new Date();
    await fs.utimes(path.dirname(dir), now, now).catch(() => undefined);
    return dir;
  }

  /**
   * Marks `session` as in use, so a request measures the quota with its own session counted even when it had
   * been idle for longer than the expiry. Fails with `NotFoundError` for a session that does not exist.
   */
  async renew(source: DocumentSourceRow, session: string): Promise<void> {
    await this.requireSession(source, session);
  }

  /**
   * Starts quota tracking for a request on `session`. The session's earlier files are already in `quota.used`;
   * a file of them that overwrites one in `current/` is counted once, because that is what `add` leaves behind.
   */
  async beginRequest(source: DocumentSourceRow, session: string, quota: UploadQuota): Promise<UploadRequestQuota> {
    const { reservation, reservedAtStart } = this.join(source.projectId);
    return this.openRequest(source, session, quota, reservation, reservedAtStart);
  }

  /**
   * `beginRequest` for a request that has not measured the project yet. `measure` returns the quota in force, or
   * `undefined` when there is none, and then no tracking happens. The request joins the project's reservation
   * **before** `measure` runs: bytes another request writes while the project is being measured may be counted
   * twice, never missed, so concurrent requests cannot together carry the project past the limit.
   */
  async startRequest(
    source: DocumentSourceRow,
    session: string,
    measure: () => Promise<UploadQuota | undefined>,
  ): Promise<UploadRequestQuota | undefined> {
    const { reservation, reservedAtStart } = this.join(source.projectId);
    try {
      const quota = await measure();
      if (!quota) {
        this.leave(source.projectId, reservation);
        return undefined;
      }
      return await this.openRequest(source, session, quota, reservation, reservedAtStart);
    } catch (err) {
      this.leave(source.projectId, reservation);
      throw err;
    }
  }

  private async openRequest(
    source: DocumentSourceRow,
    session: string,
    quota: UploadQuota,
    reservation: ProjectReservation,
    reservedAtStart: number,
  ): Promise<UploadRequestQuota> {
    try {
      const filesDir = await this.requireSession(source, session);
      const currentDir = sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id);
      const baseUsed = Math.max(0, quota.used - (await overwrittenBytes(filesDir, currentDir)));
      const scratchDir = path.join(path.dirname(filesDir), `request-${randomBytes(8).toString('hex')}`);
      await fs.mkdir(scratchDir, { recursive: true });
      return new UploadRequestQuota(quota.limit, baseUsed, scratchDir, filesDir, currentDir, reservation, reservedAtStart, source.projectId);
    } catch (err) {
      this.leave(source.projectId, reservation);
      throw err;
    }
  }

  private release(tracker: UploadRequestQuota): void {
    if (tracker.left) return;
    tracker.left = true;
    this.leave(tracker.projectId, tracker.reservation);
  }

  /** Throws away everything a request wrote. The session's earlier files are untouched. */
  async rollbackRequest(tracker: UploadRequestQuota): Promise<void> {
    await fs.rm(tracker.scratchDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    tracker.reservation.reserved -= tracker.requestBytes;
    tracker.requestBytes = 0;
    this.release(tracker);
  }

  /** Puts what a request wrote into the session's `files/`, over any file of the same path, and drops the scratch directory. */
  async finishRequest(tracker: UploadRequestQuota): Promise<void> {
    try {
      await moveTree(tracker.scratchDir, tracker.filesDir);
      await fs.rm(tracker.scratchDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    } finally {
      // A finished request stays in the reservation's total for the requests still running: its bytes are on disk
      // now, but those requests measured the project before they got there.
      this.release(tracker);
    }
  }

  /**
   * Stores one uploaded part. `relativePath` is the browser-supplied path (folder uploads keep their
   * structure). Archives are unpacked right away into the staging tree, next to where they were dropped.
   */
  async addFile(
    source: DocumentSourceRow,
    session: string,
    relativePath: string,
    stream: NodeJS.ReadableStream,
    tracker?: UploadRequestQuota,
  ): Promise<ImportStats> {
    const sessionFilesDir = await this.requireSession(source, session);
    // With a quota the request writes beside the session's files, not into them (see `UploadRequestQuota`).
    const filesDir = tracker ? tracker.scratchDir : sessionFilesDir;
    const limits = this.limitsFor(source);
    const stats: ImportStats = { files: 0, skipped: 0, bytes: 0, ...(tracker ? { added: [] } : {}) };
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new ValidationError(`Invalid file path "${relativePath}"`);
    const name = normalized.split('/').pop()!;
    const subdir = normalized.split('/').slice(0, -1);

    if (isArchiveName(name)) {
      const archivesDir = path.join(stagingDir(this.config.DATA_DIR, source.projectId, source.id, session), 'archives');
      await fs.mkdir(archivesDir, { recursive: true });
      const target = path.join(archivesDir, `${Date.now()}-${name}`);
      await pipeline(stream, createWriteStream(target));
      const { size } = await fs.stat(target);
      if (size > this.config.UPLOAD_MAX_ARCHIVE_BYTES) {
        await fs.rm(target, { force: true });
        throw new ValidationError(`Archive "${name}" exceeds the limit of ${this.config.UPLOAD_MAX_ARCHIVE_BYTES} bytes`);
      }
      try {
        await extractArchive(
          target,
          filesDir,
          limits,
          stats,
          0,
          subdir.filter((s) => !s.startsWith('.')),
        );
      } finally {
        await fs.rm(target, { force: true }).catch(() => undefined);
      }
      await this.charge(tracker, stats);
      return stats;
    }

    const cleaned = cleanEntryPath(normalized, limits.pathFlavor);
    if (!cleaned) {
      // Drain and ignore (dotfiles, non-portable names).
      await pipeline(stream, createWriteStream(path.join(sessionFilesDir, '..', 'discard')));
      stats.skipped++;
      return stats;
    }
    const target = path.resolve(filesDir, ...cleaned.split('/'));
    if (!isInside(filesDir, target)) throw new ValidationError(`"${relativePath}" escapes the upload directory`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(stream, createWriteStream(target));
    const { size } = await fs.stat(target);
    stats.files++;
    stats.bytes += size;
    stats.added?.push(target);
    await this.charge(tracker, stats);
    return stats;
  }

  /**
   * Counts what `addFile` just stored against the request's quota, after the fact: the file or the unpacked
   * archive is already on disk by the time its size is known. The overshoot is at most one request, which
   * `UPLOAD_MAX_*` already bounds, and the caller takes the request back when this throws.
   *
   * A stored file that replaces one already staged in the session, or else one in `current/`, adds only the
   * difference: `add` overwrites by path, so the old bytes are gone once the session is committed.
   */
  private async charge(tracker: UploadRequestQuota | undefined, stats: ImportStats): Promise<void> {
    if (!tracker) return;
    // The difference between what is on disk now and what the path held before this write: the request's own
    // earlier write if there was one, else the session's staged file, else the committed one. Measured on disk,
    // so a path repeated within one request or one archive is not subtracted twice.
    for (const written of new Set(stats.added ?? [])) {
      const relative = path.relative(tracker.scratchDir, written);
      const now = (await fileSize(written)) ?? 0;
      const before =
        tracker.written.get(relative) ??
        (await fileSize(path.join(tracker.filesDir, relative))) ??
        (await fileSize(path.join(tracker.currentDir, relative))) ??
        0;
      tracker.requestBytes += now - before;
      tracker.reservation.reserved += now - before;
      tracker.written.set(relative, now);
    }
    if (tracker.projectedUsed > tracker.limit) {
      // What the project held before this request wrote, as far as anyone could tell: the other requests' share included.
      const requested = Math.max(0, tracker.requestBytes);
      throw new QuotaExceededError('max_upload_bytes', tracker.limit, tracker.projectedUsed - tracker.requestBytes, requested);
    }
  }

  /**
   * Moves the staged tree into `current/`. Callers hold the project lock. Returns the number of files now staged in.
   *
   * With a `quota`, this is the authoritative check ([ADR-0117](../../.ssot/ADR.md#adr-0117)): other sessions
   * may have committed since this one began. `replace` first subtracts what the source stores now, because
   * that is what the swap removes, and `add` what the staged files overwrite. `quota.used` leaves this session
   * out, since its files are the `staged` bytes. A refusal leaves `current/` and the session as they were.
   */
  async commit(source: DocumentSourceRow, session: string, mode: 'add' | 'replace', quota?: UploadQuota): Promise<number> {
    const filesDir = await this.requireSession(source, session);
    const current = sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id);
    if (quota) {
      const staged = await directoryBytes(filesDir);
      // `replace` drops everything the source stores now; `add` drops only the files it overwrites.
      const dropped = mode === 'replace' ? quota.sourceCurrent : await overwrittenBytes(filesDir, current);
      const kept = Math.max(0, quota.used - dropped);
      if (kept + staged > quota.limit) throw new QuotaExceededError('max_upload_bytes', quota.limit, kept, staged);
    }
    // Files that were not archives may carry names the flavor should clean up; importTree re-validates everything.
    let count: number;
    if (mode === 'replace') {
      const next = `${current}.next-${Date.now()}`;
      count = (await importTree(filesDir, next, this.limitsFor(source))).files;
      await swapDirectory(current, next);
    } else {
      await fs.mkdir(current, { recursive: true });
      count = await mergeDirectory(filesDir, current);
    }
    await this.abort(source, session);
    return count;
  }

  async abort(source: DocumentSourceRow, session: string): Promise<void> {
    await fs.rm(stagingDir(this.config.DATA_DIR, source.projectId, source.id, session), { recursive: true, force: true, maxRetries: 5 });
  }

  /** Files currently materialised for the source (relative posix paths + sizes). */
  async listFiles(source: DocumentSourceRow): Promise<Array<{ path: string; sizeBytes: number }>> {
    const current = sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id);
    const out: Array<{ path: string; sizeBytes: number }> = [];
    async function walk(dir: string, rel: string[]): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs, [...rel, e.name]);
        else if (e.isFile()) out.push({ path: [...rel, e.name].join('/'), sizeBytes: (await fs.stat(abs)).size });
      }
    }
    await walk(current, []);
    return out;
  }

  /** Deletes one materialised file. Callers hold the project lock. */
  async deleteFile(source: DocumentSourceRow, relativePath: string): Promise<void> {
    const current = sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id);
    const rel = normalizeRelativePath(relativePath);
    if (!rel) throw new ValidationError('Invalid path');
    const target = path.resolve(current, ...rel.split('/'));
    if (!isInside(current, target)) throw new ValidationError('Path escapes the source directory');
    try {
      await fs.rm(target, { force: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError('File not found');
      throw err;
    }
  }

  /** Empties the source's materialised tree. Callers hold the project lock. */
  async clear(source: DocumentSourceRow): Promise<void> {
    await fs.rm(sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id), { recursive: true, force: true, maxRetries: 5 });
  }
}

/** The prefix a session directory gets while the sweep deletes it (`.trash-<session>`): never a session name. */
const SWEPT_SESSION_PREFIX = '.trash-';

/**
 * Deletes every upload session nobody has touched for `UPLOAD_SESSION_TTL_MS`, in every project, so that what the
 * quota counts (live sessions only, see `projectUploadUsage`) and what is on disk agree. A session is touched
 * by each `files` request and by its commit, so only an abandoned one is old. Returns how many it removed.
 *
 * A commit must never import a tree that is half deleted, so a session leaves its place in one step: under
 * the project lock (a project whose lock is held, by a commit or a scan, is skipped until the next tick) the
 * modification time is read again and the directory is renamed to `.trash-<session>`; only then is it
 * removed. A commit that arrives after the rename finds no session and answers 404. A removal that fails
 * leaves the `.trash-` directory, which the next tick removes. Nothing here throws on a path it cannot read.
 */
export async function sweepExpiredUploadSessions(dataDir: string, now: number = Date.now(), locks?: KeyedMutex): Promise<number> {
  const entries = async (dir: string): Promise<string[]> => fs.readdir(dir).catch(() => []);
  const idleSince = async (dir: string): Promise<number | null> => {
    const stat = await fs.stat(dir).catch(() => null);
    return stat?.isDirectory() ? stat.mtimeMs : null;
  };
  const remove = async (dir: string): Promise<boolean> => {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
      return true;
    } catch {
      return false; // Left for the next tick.
    }
  };
  let removed = 0;
  const projectsRoot = path.join(dataDir, 'projects');
  for (const projectId of await entries(projectsRoot)) {
    const sourcesRoot = path.join(projectsRoot, projectId, 'sources');
    for (const sourceId of await entries(sourcesRoot)) {
      const stagingRoot = path.join(sourcesRoot, sourceId, '.staging');
      for (const name of await entries(stagingRoot)) {
        const dir = path.join(stagingRoot, name);
        if (name.startsWith(SWEPT_SESSION_PREFIX)) {
          await remove(dir);
          continue;
        }
        if (!/^[0-9a-f]{32}$/.test(name)) continue;
        const touched = await idleSince(dir);
        if (touched === null || now - touched <= UPLOAD_SESSION_TTL_MS) continue;
        if (locks?.isLocked(projectId)) continue;
        const detach = async (): Promise<string | null> => {
          if ((await idleSince(dir)) !== touched) return null;
          const trash = path.join(stagingRoot, `${SWEPT_SESSION_PREFIX}${name}`);
          try {
            await fs.rename(dir, trash);
            return trash;
          } catch {
            return null;
          }
        };
        const trash = locks ? await locks.runExclusive(projectId, detach) : await detach();
        if (trash !== null && (await remove(trash))) removed++;
      }
    }
  }
  return removed;
}
