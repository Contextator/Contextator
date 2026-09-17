import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { DocumentSourceRow } from '../db/schema.js';
import { cleanEntryPath, extractArchive, importTree, isArchiveName, type ImportLimits, type ImportStats } from './archives.js';
import { mergeDirectory, sourceCurrentDir, stagingDir, swapDirectory } from './data-dir.js';
import type { Flavor } from './flavors.js';
import { isInside, normalizeRelativePath } from './fs-scan.js';
import { NotFoundError, ValidationError } from './projects.js';

/**
 * Upload sessions: files arrive in `.staging/<session>/files/` (any number of requests), then `commit`
 * merges them into the source's `current/` tree (mode `add`) or replaces it (mode `replace`).
 * Staging lives in a dot-directory, so a running scan never sees half-uploaded files.
 */
export class UploadService {
  constructor(private readonly config: Pick<Config, 'DATA_DIR' | 'UPLOAD_MAX_FILE_BYTES' | 'UPLOAD_MAX_ARCHIVE_BYTES' | 'ARCHIVE_MAX_ENTRIES' | 'ARCHIVE_MAX_TOTAL_BYTES'>) {}

  private limitsFor(source: DocumentSourceRow): ImportLimits {
    const extensions = (source.config as { extensions?: string[] }).extensions ?? ['md', 'mdx', 'txt'];
    return {
      maxEntries: this.config.ARCHIVE_MAX_ENTRIES,
      maxTotalBytes: this.config.ARCHIVE_MAX_TOTAL_BYTES,
      maxFileBytes: this.config.UPLOAD_MAX_FILE_BYTES,
      extensions,
      flavor: source.flavor as Flavor,
    };
  }

  private filesDir(source: DocumentSourceRow, session: string): string {
    return path.join(stagingDir(this.config.DATA_DIR, source.projectId, source.id, session), 'files');
  }

  async createSession(source: DocumentSourceRow): Promise<string> {
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
    return dir;
  }

  /**
   * Stores one uploaded part. `relativePath` is the browser-supplied path (folder uploads keep their
   * structure). Archives are unpacked right away into the staging tree, next to where they were dropped.
   */
  async addFile(source: DocumentSourceRow, session: string, relativePath: string, stream: NodeJS.ReadableStream): Promise<ImportStats> {
    const filesDir = await this.requireSession(source, session);
    const limits = this.limitsFor(source);
    const stats: ImportStats = { files: 0, skipped: 0, bytes: 0 };
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
        await extractArchive(target, filesDir, limits, stats, 0, subdir.filter((s) => !s.startsWith('.')));
      } finally {
        await fs.rm(target, { force: true }).catch(() => undefined);
      }
      return stats;
    }

    const cleaned = cleanEntryPath(normalized, limits.flavor);
    if (!cleaned) {
      // Drain and ignore (dotfiles, non-portable names).
      await pipeline(stream, createWriteStream(path.join(filesDir, '..', 'discard')));
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
    return stats;
  }

  /** Moves the staged tree into `current/`. Callers hold the project lock. Returns the number of files now staged in. */
  async commit(source: DocumentSourceRow, session: string, mode: 'add' | 'replace'): Promise<number> {
    const filesDir = await this.requireSession(source, session);
    const current = sourceCurrentDir(this.config.DATA_DIR, source.projectId, source.id);
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
