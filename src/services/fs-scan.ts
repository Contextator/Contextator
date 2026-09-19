import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNotAllowedError';
  }
}

export interface ScannedFile {
  /** posix-style path relative to the project root, e.g. `guides/install.md` */
  relativePath: string;
  absolutePath: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', '__pycache__']);
const MARKDOWN_EXT = /\.(md|mdx)$/i;

/**
 * File extensions a source may index (lower-case, without the dot).
 *
 * **Every one of them is a Markdown document by the time the chunker sees it**
 * ([ADR-0056](../../.ssot/ADR.md#adr-0056)). The list is the registry's key set — `services/doc-types`
 * holds one transform per entry and the compiler checks the two agree — so adding a type here without
 * a transform for it does not compile.
 */
export const SUPPORTED_EXTENSIONS = ['md', 'mdx', 'txt', 'html', 'htm', 'csv', 'docx', 'pdf'] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];
export const DEFAULT_EXTENSIONS: SupportedExtension[] = ['md', 'mdx'];

export function extensionMatcher(extensions: readonly string[]): RegExp {
  const list = extensions.filter((e) => (SUPPORTED_EXTENSIONS as readonly string[]).includes(e));
  return new RegExp(`\\.(${(list.length ? list : DEFAULT_EXTENSIONS).join('|')})$`, 'i');
}

function comparable(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or lives underneath it. Prefix-safe (`/docs/a` is not inside `/docs/ab`). */
export function isInside(parent: string, child: string): boolean {
  const p = comparable(parent);
  const c = comparable(child);
  if (c === p) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/**
 * Resolves a user-supplied project root to its real path and verifies it lies inside one of
 * the allowed roots. Rejects `..` escapes, symlinks pointing elsewhere, and non-directories.
 */
export async function resolveProjectRoot(rootPath: string, allowedRoots: string[]): Promise<string> {
  if (!rootPath || !rootPath.trim()) throw new PathNotAllowedError('A directory path is required');
  const resolved = path.resolve(rootPath.trim());

  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch {
    throw new PathNotAllowedError(`Directory does not exist or is not accessible: ${rootPath}`);
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new PathNotAllowedError(`Not a directory: ${rootPath}`);

  for (const allowed of allowedRoots) {
    let allowedReal: string;
    try {
      allowedReal = await fs.realpath(path.resolve(allowed));
    } catch {
      continue; // allowed root itself is missing; skip it
    }
    if (isInside(allowedReal, real)) return real;
  }
  throw new PathNotAllowedError(`Directory is outside the allowed document roots (${allowedRoots.join(', ')}): ${rootPath}`);
}

/** Yields document files (`.md` / `.mdx` by default) under `rootReal`, skipping dotfiles, build dirs, symlinks and ignored globs. */
export async function* walkMarkdown(
  rootReal: string,
  opts: { ignoreGlobs: string[]; extensions?: readonly string[] } = { ignoreGlobs: [] },
): AsyncGenerator<ScannedFile> {
  const isIgnored: (p: string) => boolean = opts.ignoreGlobs.length ? picomatch(opts.ignoreGlobs, { dot: true }) : () => false;
  const matchesExt = opts.extensions ? extensionMatcher(opts.extensions) : MARKDOWN_EXT;

  async function* walk(dirAbs: string, relParts: string[]): AsyncGenerator<ScannedFile> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = [...relParts, entry.name];
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        yield* walk(abs, rel);
        continue;
      }
      if (!entry.isFile() || !matchesExt.test(entry.name)) continue;
      const relativePath = rel.join('/');
      if (isIgnored(relativePath)) continue;
      yield { relativePath, absolutePath: abs };
    }
  }

  yield* walk(rootReal, []);
}

/**
 * The file's bytes, its sha256 and its size.
 *
 * **Bytes and not a string, since [ADR-0056](../../.ssot/ADR.md#adr-0056).** Half the types a source
 * may now index — `.pdf`, `.docx` — are not text at all, and `buf.toString('utf8')` on one of them is
 * a lossy decode that the extractor then has to undo. The hash is over the raw bytes exactly as
 * before, because that is what decides whether a file changed ([ADR-0014](../../.ssot/ADR.md#adr-0014));
 * what those bytes *say* is `extractDocument`'s question, and it is asked after this one.
 */
export async function readAndHash(absolutePath: string): Promise<{ bytes: Buffer; hash: string; sizeBytes: number }> {
  const buf = await fs.readFile(absolutePath);
  return {
    bytes: buf,
    hash: createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.byteLength,
  };
}

/**
 * Normalises a client-supplied document path to the posix form stored in the database.
 * Returns null for anything that is empty or tries to traverse (`..`).
 */
export function normalizeRelativePath(input: string): string | null {
  let p = input.trim().replace(/\\/g, '/');
  p = p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!p) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments.join('/');
}
