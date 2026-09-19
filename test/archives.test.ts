import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArchiveLimitError,
  cleanEntryPath,
  extractArchive,
  importTree,
  isArchiveName,
  isPortableSegment,
  type ImportLimits,
} from '../src/services/archives.js';
import { SUPPORTED_EXTENSIONS } from '../src/services/fs-scan.js';

const FIXTURES = path.join(__dirname, 'fixtures');
const limits: ImportLimits = {
  maxEntries: 100,
  maxTotalBytes: 1024 * 1024,
  maxFileBytes: 64 * 1024,
  extensions: ['md', 'mdx', 'txt'],
  pathFlavor: 'plain',
  allowedExtensions: SUPPORTED_EXTENSIONS,
};

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-archives-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string[]) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(d, e.name), [...rel, e.name]);
      else out.push([...rel, e.name].join('/'));
    }
  }
  await walk(dir, []);
  return out.sort();
}

describe('entry path safety', () => {
  it('rejects traversal, absolute and non-portable names, drops dot-directories', () => {
    expect(cleanEntryPath('../evil.md', 'plain')).toBeNull();
    expect(cleanEntryPath('/etc/passwd.md', 'plain')).toBe('etc/passwd.md');
    expect(cleanEntryPath('a/../../b.md', 'plain')).toBeNull();
    expect(cleanEntryPath('.obsidian/app.md', 'plain')).toBeNull();
    expect(cleanEntryPath('dir/CON.md', 'plain')).toBeNull();
    expect(cleanEntryPath('dir/bad:name.md', 'plain')).toBeNull();
    expect(cleanEntryPath('guides\\install.md', 'plain')).toBe('guides/install.md');
    expect(isPortableSegment('trailing.')).toBe(false);
    expect(isArchiveName('x.tar.gz')).toBe(true);
    expect(isArchiveName('x.md')).toBe(false);
  });

  it('applies the notion-export flavor to paths', () => {
    expect(cleanEntryPath('Wiki 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Page 0123456789abcdef0123456789abcdef.md', 'notion-export')).toBe('Wiki/Page.md');
  });
});

describe('extractArchive', () => {
  it('unpacks a zip, keeps only document files and cleans Notion names', async () => {
    const dest = path.join(tmp, 'zip-out');
    const stats = await extractArchive(path.join(FIXTURES, 'docs.zip'), dest, { ...limits, pathFlavor: 'notion-export' });
    expect(await tree(dest)).toEqual(['README.md', 'Wiki/Getting started.md', 'notes.txt']);
    expect(stats.files).toBe(3);
    expect(stats.skipped).toBeGreaterThanOrEqual(1); // image.png
  });

  it('unpacks a tar.gz created with escaping paths without leaving the destination', async () => {
    const srcDir = path.join(tmp, 'tar-src');
    await fs.mkdir(path.join(srcDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(srcDir, 'docs', 'a.md'), '# A');
    await fs.writeFile(path.join(srcDir, 'docs', 'b.mdx'), '# B');
    const archive = path.join(tmp, 'docs.tgz');
    await tar.create({ gzip: true, file: archive, cwd: srcDir }, ['docs']);
    const dest = path.join(tmp, 'tar-out');
    const stats = await extractArchive(archive, dest, limits);
    expect(await tree(dest)).toEqual(['docs/a.md', 'docs/b.mdx']);
    expect(stats.files).toBe(2);
  });

  it('enforces entry and size limits', async () => {
    const dest = path.join(tmp, 'limited');
    await expect(extractArchive(path.join(FIXTURES, 'docs.zip'), dest, { ...limits, maxEntries: 1 })).rejects.toThrow(ArchiveLimitError);
    await expect(extractArchive(path.join(FIXTURES, 'docs.zip'), dest, { ...limits, maxTotalBytes: 5 })).rejects.toThrow(ArchiveLimitError);
  });

  it('importTree refuses files above the per-file limit', async () => {
    const from = path.join(tmp, 'big');
    await fs.mkdir(from, { recursive: true });
    await fs.writeFile(path.join(from, 'big.md'), 'x'.repeat(2000));
    await expect(importTree(from, path.join(tmp, 'big-out'), { ...limits, maxFileBytes: 100 })).rejects.toThrow(ArchiveLimitError);
  });
});
