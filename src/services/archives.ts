import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import * as tar from 'tar';
import { transformPath, type Flavor } from './flavors.js';
import { extensionMatcher, isInside, normalizeRelativePath } from './fs-scan.js';
import { ValidationError } from './projects.js';

/**
 * Archive extraction for uploads. Every format is first unpacked into a scratch directory with the
 * library's own path protection, then `importTree` copies only acceptable document files into the
 * destination (extension filter, flavor path cleanup, dot-directories skipped, Windows-portable names,
 * entry/size caps). Nested archives (Notion exports ship `Part-1.zip` inside the zip) are unpacked one level deep.
 */

export const ARCHIVE_RE = /\.(zip|tar|tgz|tar\.gz|rar)$/i;
export const isArchiveName = (name: string): boolean => ARCHIVE_RE.test(name);

export interface ImportLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  extensions: readonly string[];
  flavor: Flavor;
}

export interface ImportStats {
  files: number;
  skipped: number;
  bytes: number;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;

/** Rejects names that cannot be created on every platform the data directory may live on. */
export function isPortableSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 255 && !BAD_CHARS.test(segment) && !WINDOWS_RESERVED.test(segment) && !/[. ]$/.test(segment);
}

/**
 * Validates and cleans an uploaded/extracted entry path: normalises separators, rejects traversal and
 * non-portable names, drops dot-directories (`.obsidian/`, `.git/`), applies the flavor's path cleanup.
 * Returns null when the entry should be skipped.
 */
export function cleanEntryPath(raw: string, flavor: Flavor): string | null {
  const normalized = normalizeRelativePath(raw);
  if (!normalized) return null;
  const cleaned = transformPath(flavor, normalized);
  const segments = cleaned.split('/');
  if (segments.some((s) => s.startsWith('.') || !isPortableSegment(s))) return null;
  return segments.join('/');
}

export class ArchiveLimitError extends ValidationError {}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-extract-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/** Copies acceptable files from `from` into `dest` (both absolute), returning what was imported. */
export async function importTree(from: string, dest: string, limits: ImportLimits, stats: ImportStats = { files: 0, skipped: 0, bytes: 0 }, depth = 0): Promise<ImportStats> {
  const matchesExt = extensionMatcher(limits.extensions);
  const destReal = path.resolve(dest);

  async function walk(dirAbs: string, relParts: string[]): Promise<void> {
    for (const entry of await fs.readdir(dirAbs, { withFileTypes: true })) {
      const abs = path.join(dirAbs, entry.name);
      const relRaw = [...relParts, entry.name].join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        await walk(abs, [...relParts, entry.name]);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isArchiveName(entry.name) && depth < 1) {
        // Nested archive: unpack next to where it sat.
        await extractArchive(abs, dest, limits, stats, depth + 1, relParts);
        continue;
      }
      if (!matchesExt.test(entry.name)) {
        stats.skipped++;
        continue;
      }
      const rel = cleanEntryPath(relRaw, limits.flavor);
      if (!rel) {
        stats.skipped++;
        continue;
      }
      const { size } = await fs.stat(abs);
      if (size > limits.maxFileBytes) throw new ArchiveLimitError(`"${relRaw}" exceeds the per-file limit of ${limits.maxFileBytes} bytes`);
      if (stats.files + 1 > limits.maxEntries) throw new ArchiveLimitError(`Too many files (limit ${limits.maxEntries})`);
      if (stats.bytes + size > limits.maxTotalBytes) throw new ArchiveLimitError(`Total size exceeds ${limits.maxTotalBytes} bytes`);
      const target = path.resolve(destReal, ...rel.split('/'));
      if (!isInside(destReal, target)) throw new ArchiveLimitError(`"${relRaw}" escapes the destination directory`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(abs, target);
      stats.files++;
      stats.bytes += size;
    }
  }

  await walk(from, []);
  return stats;
}

async function unpackZip(archive: string, scratch: string, limits: ImportLimits): Promise<void> {
  // Entry names are validated by us below (normalizeRelativePath + isInside); the library's own check
  // would reject the backslash separators that Windows-made zips contain.
  const zip = new StreamZip.async({ file: archive, skipEntryNameValidation: true });
  try {
    const entries = Object.values(await zip.entries());
    let total = 0;
    let count = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      count++;
      total += e.size;
      if (count > limits.maxEntries) throw new ArchiveLimitError(`Archive has too many entries (limit ${limits.maxEntries})`);
      if (total > limits.maxTotalBytes) throw new ArchiveLimitError(`Archive expands beyond ${limits.maxTotalBytes} bytes`);
    }
    for (const e of entries) {
      if (e.isDirectory) continue;
      // Windows-made zips use backslashes; normalise ourselves and stream to a path we validated.
      const rel = normalizeRelativePath(e.name);
      if (!rel || rel.split('/').some((s) => !isPortableSegment(s) && !s.startsWith('.'))) continue;
      const target = path.resolve(scratch, ...rel.split('/'));
      if (!isInside(scratch, target)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await zip.stream(e), createWriteStream(target));
    }
  } finally {
    await zip.close();
  }
}

async function unpackTar(archive: string, scratch: string, limits: ImportLimits): Promise<void> {
  let count = 0;
  let total = 0;
  await tar.extract({
    file: archive,
    cwd: scratch,
    preservePaths: false, // strips absolute paths and `..` segments
    filter: (_p, entry) => {
      const e = entry as { type?: string; size?: number };
      if (e.type && e.type !== 'File') return false;
      count++;
      total += e.size ?? 0;
      if (count > limits.maxEntries) throw new ArchiveLimitError(`Archive has too many entries (limit ${limits.maxEntries})`);
      if (total > limits.maxTotalBytes) throw new ArchiveLimitError(`Archive expands beyond ${limits.maxTotalBytes} bytes`);
      return true;
    },
  });
}

async function unpackRar(archive: string, scratch: string, limits: ImportLimits): Promise<void> {
  const { createExtractorFromFile } = await import('node-unrar-js');
  const sanitize = (name: string): string => {
    const rel = normalizeRelativePath(name);
    return rel ?? `_rejected_/${Date.now()}`;
  };
  const extractor = await createExtractorFromFile({ filepath: archive, targetPath: scratch, filenameTransform: sanitize });
  const list = extractor.getFileList();
  if (list.arcHeader.flags.volume) throw new ValidationError('Multi-volume RAR archives are not supported; upload a single-volume archive');
  let count = 0;
  let total = 0;
  for (const h of list.fileHeaders) {
    if (h.flags.directory) continue;
    if (h.flags.encrypted) throw new ValidationError('Password-protected RAR archives are not supported');
    count++;
    total += h.unpSize;
    if (count > limits.maxEntries) throw new ArchiveLimitError(`Archive has too many entries (limit ${limits.maxEntries})`);
    if (total > limits.maxTotalBytes) throw new ArchiveLimitError(`Archive expands beyond ${limits.maxTotalBytes} bytes`);
  }
  // The generator must be consumed to the end so the WASM side frees its objects.
  for (const _file of extractor.extract({ files: (h) => !h.flags.directory }).files) void _file;
  await fs.rm(path.join(scratch, '_rejected_'), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Unpacks `archive` and imports its acceptable files into `dest` (under `subdir` parts when the archive
 * itself sat in a subdirectory of an upload).
 */
export async function extractArchive(
  archive: string,
  dest: string,
  limits: ImportLimits,
  stats: ImportStats = { files: 0, skipped: 0, bytes: 0 },
  depth = 0,
  subdir: string[] = [],
): Promise<ImportStats> {
  const lower = archive.toLowerCase();
  await withScratch(async (scratch) => {
    if (lower.endsWith('.zip')) await unpackZip(archive, scratch, limits);
    else if (lower.endsWith('.tar') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) await unpackTar(archive, scratch, limits);
    else if (lower.endsWith('.rar')) await unpackRar(archive, scratch, limits);
    else throw new ValidationError(`Unsupported archive type: ${path.basename(archive)}`);
    await importTree(scratch, subdir.length ? path.join(dest, ...subdir) : dest, limits, stats, depth);
  });
  return stats;
}
