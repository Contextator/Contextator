import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathNotAllowedError, isInside, normalizeRelativePath, resolveProjectRoot, walkMarkdown } from '../src/services/fs-scan.js';

describe('isInside', () => {
  it('accepts the directory itself and descendants', () => {
    expect(isInside('/docs', '/docs')).toBe(true);
    expect(isInside('/docs', '/docs/a/b.md')).toBe(true);
  });

  it('rejects siblings that merely share a prefix and parent traversal', () => {
    expect(isInside('/docs/a', '/docs/ab')).toBe(false);
    expect(isInside('/docs', '/docs/../etc')).toBe(false);
    expect(isInside('/docs', '/etc')).toBe(false);
  });

  it('is case-insensitive on Windows only', () => {
    const result = isInside('/Docs', '/docs/x');
    expect(result).toBe(process.platform === 'win32');
  });
});

describe('normalizeRelativePath', () => {
  it('normalises separators and strips leading ./ and /', () => {
    expect(normalizeRelativePath('.\\guides\\install.md')).toBe('guides/install.md');
    expect(normalizeRelativePath('/guides/install.md')).toBe('guides/install.md');
    expect(normalizeRelativePath('  ./a/b.md ')).toBe('a/b.md');
  });

  it('rejects traversal and empty paths', () => {
    expect(normalizeRelativePath('../secret.md')).toBeNull();
    expect(normalizeRelativePath('a/../../b.md')).toBeNull();
    expect(normalizeRelativePath('')).toBeNull();
    expect(normalizeRelativePath('a//b.md')).toBeNull();
  });
});

describe('resolveProjectRoot + walkMarkdown', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-root-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-outside-'));
    await fs.mkdir(path.join(root, 'proj', 'guides'), { recursive: true });
    await fs.mkdir(path.join(root, 'proj', 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(root, 'proj', '.hidden'), { recursive: true });
    await fs.writeFile(path.join(root, 'proj', 'README.md'), '# Readme');
    await fs.writeFile(path.join(root, 'proj', 'guides', 'install.MDX'), '# Install');
    await fs.writeFile(path.join(root, 'proj', 'guides', 'CHANGELOG.md'), '# Changes');
    await fs.writeFile(path.join(root, 'proj', 'guides', 'notes.txt'), 'not markdown');
    await fs.writeFile(path.join(root, 'proj', 'node_modules', 'pkg', 'README.md'), '# dep');
    await fs.writeFile(path.join(root, 'proj', '.hidden', 'secret.md'), '# hidden');
    await fs.writeFile(path.join(outside, 'leak.md'), '# leak');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('resolves a directory inside an allowed root', async () => {
    const real = await resolveProjectRoot(path.join(root, 'proj'), [root]);
    expect(isInside(root, real)).toBe(true);
  });

  it('rejects directories outside the allowed roots, traversal and missing paths', async () => {
    await expect(resolveProjectRoot(outside, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(resolveProjectRoot(path.join(root, 'proj', '..', '..'), [root])).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(resolveProjectRoot(path.join(root, 'does-not-exist'), [root])).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(resolveProjectRoot(path.join(root, 'proj', 'README.md'), [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it('walks only markdown files, skipping node_modules, dotfiles and ignored globs', async () => {
    const found: string[] = [];
    for await (const f of walkMarkdown(path.join(root, 'proj'), { ignoreGlobs: ['**/CHANGELOG.md'] })) found.push(f.relativePath);
    expect([...found].sort()).toEqual(['README.md', 'guides/install.MDX']);
  });
});
