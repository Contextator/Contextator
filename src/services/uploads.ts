import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { DocumentSourceRow } from '../db/schema.js';
import { cleanEntryPath, extractArchive, importTree, isArchiveName, type ImportLimits, type ImportStats } from './archives.js';
import { isSessionName, mergeDirectory, sourceCurrentDir, stagingDir, swapDirectory } from './data-dir.js';
import { QuotaExceededError } from './errors.js';
import { allowedExtensionsFor, type Flavor } from './flavors.js';
import { isInside, normalizeRelativePath } from './fs-scan.js';
import { KeyedMutex } from './locks.js';
import { NotFoundError, ValidationError } from './projects.js';
import { directoryBytes, fileSize, overwrittenBytes, SWEPT_SESSION_PREFIX, UPLOAD_SESSION_TTL_MS } from './quotas.js';

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
  /** The requests that hold a scratch directory right now: they are counted from `requestBytes`, never from the disk. */
  requests: Set<UploadRequestQuota>;
  /** The sum of `requestBytes` over every request that joined since the first of the current ones, including those that finished. */
  reserved: number;
}

/** What `join` hands a request: the reservation and the figures it took before measuring the project. */
interface Joined {
  reservation: ProjectReservation;
  reservedAtStart: number;
  inflightAtStart: number;
  skipDirs: ReadonlySet<string>;
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
    readonly reservation: ProjectReservation = { active: 1, requests: new Set(), reserved: 0 },
    /** `reservation.reserved` when the request joined, taken before the project was measured: what came after is not in `baseUsed`. */
    readonly reservedAtStart: number = 0,
    readonly projectId: string = '',
    /**
     * What the requests running when this one joined had added, net of overwrites. The measurement leaves their
     * scratch directories out (a file still being written has no size a scan can trust), so this stands for them:
     * it is in `reservedAtStart` too, and so is not counted again in what came after.
     */
    readonly inflightAtStart: number = 0,
    /**
     * Where an archive is held while it is unpacked, and where a part that is dropped is drained to: bytes that
     * are not stored and not counted, so a measurement leaves the directory out like `scratchDir`.
     */
    readonly tempDir: string = '',
  ) {}

  /** What the project holds as far as this request can tell: the measurement plus everything requests have added since. */
  get projectedUsed(): number {
    return this.baseUsed + this.inflightAtStart + this.reservation.reserved - this.reservedAtStart;
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

  /**
   * Serializes, per project, measuring the disk and a request landing its files in the session. Without it a
   * request measuring the project could see another's files half moved, and the reservation and the disk would
   * disagree about which of them holds those bytes (ADR-0117). Both are short: a directory scan and renames.
   */
  private readonly accounting = new KeyedMutex();

  /**
   * Joins the project's reservation. Called with the accounting lock held and **before** the project is measured:
   * everything the running requests have added so far is taken here (`reservedAtStart`, `inflightAtStart`) and
   * the measurement leaves their scratch directories out (`skipDirs`), so each byte is counted once, from the
   * request that holds it, until that request lands it in the session where the measurement finds it.
   */
  private join(projectId: string): Joined {
    let reservation = this.reservations.get(projectId);
    if (!reservation) {
      reservation = { active: 0, requests: new Set(), reserved: 0 };
      this.reservations.set(projectId, reservation);
    }
    reservation.active++;
    let inflightAtStart = 0;
    const skipDirs = new Set<string>();
    for (const request of reservation.requests) {
      inflightAtStart += request.requestBytes;
      skipDirs.add(path.resolve(request.scratchDir));
      if (request.tempDir) skipDirs.add(path.resolve(request.tempDir));
    }
    return { reservation, reservedAtStart: reservation.reserved, inflightAtStart, skipDirs };
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
   *
   * @internal For callers that measured the project themselves, which is only the tests: nothing here hands the
   * measurement the directories to leave out, so `quota.used` must not include the scratch directories of the
   * requests running now, or their bytes are counted twice. The upload route goes through `startRequest`.
   */
  async beginRequest(source: DocumentSourceRow, session: string, quota: UploadQuota): Promise<UploadRequestQuota> {
    return this.openRequest(source, session, quota, this.join(source.projectId));
  }

  /**
   * `beginRequest` for a request that has not measured the project yet. `measure` returns the quota in force, or
   * `undefined` when there is none, and then no tracking happens. `measure` is handed the scratch directories of
   * the requests running now, to leave out of the measurement. The request joins the project's reservation
   * **before** `measure` runs, under the accounting lock: what the running requests have added is taken first
   * and the measurement does not see their scratch directories, so a byte is counted exactly once and
   * concurrent requests can neither together carry the project past the limit nor refuse what would fit.
   */
  async startRequest(
    source: DocumentSourceRow,
    session: string,
    measure: (skipDirs: ReadonlySet<string>) => Promise<UploadQuota | undefined>,
  ): Promise<UploadRequestQuota | undefined> {
    return this.accounting.runExclusive(source.projectId, async () => {
      const joined = this.join(source.projectId);
      let quota: UploadQuota | undefined;
      try {
        quota = await measure(joined.skipDirs);
      } catch (err) {
        this.leave(source.projectId, joined.reservation);
        throw err;
      }
      if (!quota) {
        this.leave(source.projectId, joined.reservation);
        return undefined;
      }
      // `openRequest` leaves the reservation itself when it fails.
      return this.openRequest(source, session, quota, joined);
    });
  }

  private async openRequest(
    source: DocumentSourceRow,
    session: string,
    quota: UploadQuota,
    { reservation, reservedAtStart, inflightAtStart }: Joined,
  ): Promise<UploadRequestQuota> {
    try {
      const filesDir = await this.requireSession(source, session);
      const currentDir = sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id);
      const baseUsed = Math.max(0, quota.used - (await overwrittenBytes(filesDir, currentDir)));
      const scratchDir = path.join(path.dirname(filesDir), `request-${randomBytes(8).toString('hex')}`);
      await fs.mkdir(scratchDir, { recursive: true });
      const tempDir = path.join(path.dirname(filesDir), `${path.basename(scratchDir)}.tmp`);
      const tracker = new UploadRequestQuota(
        quota.limit,
        baseUsed,
        scratchDir,
        filesDir,
        currentDir,
        reservation,
        reservedAtStart,
        source.projectId,
        inflightAtStart,
        tempDir,
      );
      reservation.requests.add(tracker);
      return tracker;
    } catch (err) {
      this.leave(source.projectId, reservation);
      throw err;
    }
  }

  private release(tracker: UploadRequestQuota): void {
    if (tracker.left) return;
    tracker.left = true;
    tracker.reservation.requests.delete(tracker);
    this.leave(tracker.projectId, tracker.reservation);
  }

  /** Throws away everything a request wrote. The session's earlier files are untouched. */
  async rollbackRequest(tracker: UploadRequestQuota): Promise<void> {
    // The bytes leave the reservation first and the request stays in it until its directories are gone: a request
    // joining while they are deleted then reads no bytes from it and still leaves its scratch out of the scan.
    tracker.reservation.reserved -= tracker.requestBytes;
    tracker.requestBytes = 0;
    await this.removeRequestDirs(tracker);
    this.release(tracker);
  }

  private async removeRequestDirs(tracker: UploadRequestQuota): Promise<void> {
    for (const dir of [tracker.scratchDir, tracker.tempDir]) {
      if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }

  /** Puts what a request wrote into the session's `files/`, over any file of the same path, and drops the scratch directory. */
  async finishRequest(tracker: UploadRequestQuota): Promise<void> {
    // Under the accounting lock, so a measurement sees the files either all still in the scratch directory (and
    // counts them from the request) or all in the session (and counts them from the disk), never half of each.
    await this.accounting.runExclusive(tracker.projectId, async () => {
      try {
        await moveTree(tracker.scratchDir, tracker.filesDir);
        await this.removeRequestDirs(tracker);
      } finally {
        // A finished request stays in the reservation's total for the requests still running: its bytes are on disk
        // now, but those requests measured the project before they got there.
        this.release(tracker);
      }
    });
  }

  /**
   * Stores one uploaded part. `relativePath` is the browser-supplied path (folder uploads keep their
   * structure). Archives are unpacked right away: without a quota into the staging tree, next to where they were
   * dropped; with one the archive is held in the request's temporary directory and its content is unpacked into
   * the request's scratch directory, which `finishRequest` moves into the session.
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
      // A tracked request holds the archive in its own temporary directory, which measurements leave out: what
      // counts is the unpacked content, charged below, and the archive is gone by then.
      const archivesDir = tracker
        ? path.join(tracker.tempDir, 'archives')
        : path.join(stagingDir(this.config.DATA_DIR, source.projectId, source.id, session), 'archives');
      await fs.mkdir(archivesDir, { recursive: true });
      const target = path.join(archivesDir, `${Date.now()}-${name}`);
      await pipeline(stream, createWriteStream(target));
      const { size } = await fs.stat(target);
      if (size > this.config.UPLOAD_MAX_ARCHIVE_BYTES) {
        await fs.rm(target, { force: true });
        throw new ValidationError(`Archive "${name}" exceeds the limit of ${this.config.UPLOAD_MAX_ARCHIVE_BYTES} bytes`);
      }
      // An archive that stops part-way (`ArchiveLimitError`: a file's size, the entry count, the total size)
      // leaves what it had unpacked in the request's scratch directory, and the route keeps going and moves
      // those files into the session. They are charged either way, so the request, the reservation and the
      // requests that start after it see their bytes; the error is thrown again once they are counted. A quota
      // error from the charge wins over it: the request is then taken back whole (ADR-0117).
      let extractionError: unknown;
      try {
        await extractArchive(
          target,
          filesDir,
          limits,
          stats,
          0,
          subdir.filter((s) => !s.startsWith('.')),
        );
      } catch (error) {
        extractionError = error;
      } finally {
        await fs.rm(target, { force: true }).catch(() => undefined);
      }
      await this.charge(tracker, stats);
      if (extractionError !== undefined) throw extractionError;
      return stats;
    }

    const cleaned = cleanEntryPath(normalized, limits.pathFlavor);
    if (!cleaned) {
      // Drain and ignore (dotfiles, non-portable names).
      const discard = tracker ? path.join(tracker.tempDir, 'discard') : path.join(sessionFilesDir, '..', 'discard');
      await fs.mkdir(path.dirname(discard), { recursive: true });
      await pipeline(stream, createWriteStream(discard));
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
      const error = new QuotaExceededError('max_upload_bytes', tracker.limit, tracker.projectedUsed - tracker.requestBytes, requested);
      // The request is refused and will be taken back: its bytes leave the reservation now, not when the rest of
      // the part has been drained and the directories deleted, so they cannot refuse a request that would fit.
      tracker.reservation.reserved -= tracker.requestBytes;
      tracker.requestBytes = 0;
      throw error;
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

/**
 * Deletes every upload session nobody has touched for `UPLOAD_SESSION_TTL_MS`, in every project, so that what the
 * quota counts (live sessions only, see `projectUploadUsage`; a `.trash-` directory is never counted, whatever its
 * modification time) and what is on disk agree. A session is touched
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
        if (!isSessionName(name)) continue;
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
