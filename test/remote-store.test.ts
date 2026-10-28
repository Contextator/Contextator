import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceCurrentDir, sourceDir } from '../src/services/data-dir.js';
import { InsufficientDiskError } from '../src/services/disk-space.js';
import { PROBE_TOKEN_KEY } from '../src/services/sources.js';
import {
  applyCeiling,
  ceilingNote,
  probeRemoteTree,
  remoteManifestPath,
  remoteRevisionToken,
  syncRemoteTree,
  unusableKey,
  type RemoteDownload,
  type RemoteObject,
  type RemoteStore,
} from '../src/services/sources/remote-store.js';

/**
 * The list → version → download-what-changed → materialise → remove-what-is-gone pattern that the
 * S3, Drive and SharePoint drivers share ([ADR-0126](../.ssot/ADR.md#adr-0126)), against an in-memory remote.
 */

const PROJECT = '00000000-0000-4000-8000-000000000041';
const SOURCE = '00000000-0000-4000-8000-000000000042';

/** A remote that records every call, so "nothing was downloaded" is a count and not an inference. */
class MemoryRemote implements RemoteStore {
  objects = new Map<string, { version: string; body: string; listedSize?: number }>();
  lists = 0;
  downloads: string[] = [];
  failOn: string | null = null;
  streamExtra = 0;
  answeredVersion: string | undefined;

  put(key: string, body: string, version = `v-${body}`, listedSize?: number): this {
    this.objects.set(key, { version, body, ...(listedSize === undefined ? {} : { listedSize }) });
    return this;
  }

  async list(): Promise<RemoteObject[]> {
    this.lists++;
    return [...this.objects.entries()].map(([key, o]) => ({ key, version: o.version, size: o.listedSize ?? Buffer.byteLength(o.body) }));
  }

  async download(object: RemoteObject): Promise<RemoteDownload> {
    this.downloads.push(object.key);
    if (this.failOn === object.key) throw new Error(`download of ${object.key} failed`);
    const body = this.objects.get(object.key)?.body ?? '';
    const bytes = Buffer.from(body + 'x'.repeat(this.streamExtra));
    return { body: bytes, ...(this.answeredVersion ? { version: this.answeredVersion } : {}) };
  }
}

let dataDir: string;
let remote: MemoryRemote;

beforeEach(async () => {
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-remote-store-')));
  remote = new MemoryRemote();
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const root = () => sourceCurrentDir(dataDir, PROJECT, SOURCE);
const run = (overrides: Partial<Parameters<typeof syncRemoteTree>[0]> = {}) =>
  syncRemoteTree({
    store: remote,
    dataDir,
    projectId: PROJECT,
    sourceId: SOURCE,
    tokenPrefix: 'fake',
    scope: 'bucket-a/docs',
    ceiling: { setting: 'FAKE_MAX_OBJECTS', noun: 'object', max: 100 },
    maxObjectBytes: 1024,
    ...overrides,
  });
const read = (key: string) => fs.readFile(path.join(root(), ...key.split('/')), 'utf8');
const files = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root(), full).split(path.sep).join('/'));
    }
  };
  await walk(root());
  return out.sort();
};

describe('syncRemoteTree', () => {
  it('materialises every object on the first run', async () => {
    remote.put('readme.md', 'hello').put('guide/intro.md', 'intro').put('guide/deep/more.md', 'more');
    const result = await run();

    expect(result.downloaded.sort()).toEqual(['guide/deep/more.md', 'guide/intro.md', 'readme.md']);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toEqual([]);
    expect(await read('readme.md')).toBe('hello');
    expect(await read('guide/deep/more.md')).toBe('more');
    expect(result.note).toBe('3 objects, 3 downloaded, 0 unchanged, 0 removed');
  });

  it('downloads nothing when nothing changed', async () => {
    remote.put('a.md', 'A').put('b.md', 'B');
    await run();
    remote.downloads = [];

    const second = await run();

    expect(remote.downloads).toEqual([]);
    expect(second.downloaded).toEqual([]);
    expect(second.unchanged).toBe(2);
    expect(second.removed).toEqual([]);
    expect(await files()).toEqual(['a.md', 'b.md']);
  });

  it('downloads only the object whose version changed', async () => {
    remote.put('a.md', 'A').put('b.md', 'B');
    await run();
    remote.downloads = [];
    remote.put('b.md', 'B2');

    const result = await run();

    expect(remote.downloads).toEqual(['b.md']);
    expect(result.downloaded).toEqual(['b.md']);
    expect(result.unchanged).toBe(1);
    expect(await read('a.md')).toBe('A');
    expect(await read('b.md')).toBe('B2');
  });

  it('downloads an object whose size changed under the same version', async () => {
    remote.put('a.md', 'A', 'same');
    await run();
    remote.downloads = [];
    remote.put('a.md', 'AAAA', 'same');

    await run();

    expect(remote.downloads).toEqual(['a.md']);
    expect(await read('a.md')).toBe('AAAA');
  });

  it('downloads an added object and leaves the rest alone', async () => {
    remote.put('a.md', 'A');
    await run();
    remote.downloads = [];
    remote.put('new/c.md', 'C');

    const result = await run();

    expect(remote.downloads).toEqual(['new/c.md']);
    expect(result.unchanged).toBe(1);
    expect(await files()).toEqual(['a.md', 'new/c.md']);
  });

  it('removes a file whose object is gone, and the directory it leaves empty', async () => {
    remote.put('a.md', 'A').put('gone/deep/b.md', 'B');
    await run();
    remote.objects.delete('gone/deep/b.md');
    remote.downloads = [];

    const result = await run();

    expect(result.removed).toEqual(['gone/deep/b.md']);
    expect(remote.downloads).toEqual([]);
    expect(await files()).toEqual(['a.md']);
    await expect(fs.stat(path.join(root(), 'gone'))).rejects.toThrow();
    expect(result.note).toContain('1 removed');
  });

  it('records the version the download answered, and so downloads again when the listing disagrees with it', async () => {
    remote.put('a.md', 'A', 'listed-1');
    remote.answeredVersion = 'answered-1';
    await run();
    remote.downloads = [];

    // The listing still says `listed-1`; the manifest holds `answered-1`. The two differ, so it is fetched again.
    await run();
    expect(remote.downloads).toEqual(['a.md']);
  });

  it('downloads everything again when the manifest is lost, corrupt or from another scope, and when a file went missing', async () => {
    remote.put('a.md', 'A').put('b.md', 'B');
    await run();

    await fs.rm(remoteManifestPath(dataDir, PROJECT, SOURCE));
    remote.downloads = [];
    await run();
    expect(remote.downloads.sort()).toEqual(['a.md', 'b.md']);

    await fs.writeFile(remoteManifestPath(dataDir, PROJECT, SOURCE), '{not json');
    remote.downloads = [];
    await run();
    expect(remote.downloads.sort()).toEqual(['a.md', 'b.md']);

    remote.downloads = [];
    await run({ scope: 'bucket-b/other' });
    expect(remote.downloads.sort()).toEqual(['a.md', 'b.md']);

    await fs.rm(path.join(root(), 'a.md'));
    remote.downloads = [];
    await run({ scope: 'bucket-b/other' });
    expect(remote.downloads).toEqual(['a.md']);
  });

  it('keeps the manifest beside current/, where the indexer never looks', async () => {
    remote.put('a.md', 'A');
    await run();
    expect(path.dirname(remoteManifestPath(dataDir, PROJECT, SOURCE))).toBe(sourceDir(dataDir, PROJECT, SOURCE));
    expect(await files()).toEqual(['a.md']);
    expect(await fs.readdir(sourceDir(dataDir, PROJECT, SOURCE))).not.toContain('.remote-tmp');
  });

  describe('the probe token', () => {
    it('is the same function of the same listing for the probe and the sync', async () => {
      remote.put('a.md', 'A').put('b/c.md', 'C');
      const result = await run();
      expect(result.configPatch).toEqual({ [PROBE_TOKEN_KEY]: await probeRemoteTree(remote, 'fake') });
    });

    it('advances with the listing: a changed, added or removed object moves it, a repeat does not', async () => {
      remote.put('a.md', 'A').put('b.md', 'B');
      const first = (await run()).configPatch[PROBE_TOKEN_KEY];
      expect((await run()).configPatch[PROBE_TOKEN_KEY]).toBe(first);

      remote.put('b.md', 'B2');
      const changed = (await run()).configPatch[PROBE_TOKEN_KEY];
      expect(changed).not.toBe(first);

      remote.put('c.md', 'C');
      const added = (await run()).configPatch[PROBE_TOKEN_KEY];
      expect(added).not.toBe(changed);

      remote.objects.delete('a.md');
      expect((await run()).configPatch[PROBE_TOKEN_KEY]).not.toBe(added);
    });

    it('costs the probe one listing and no download', async () => {
      remote.put('a.md', 'A');
      await probeRemoteTree(remote, 'fake');
      expect(remote.lists).toBe(1);
      expect(remote.downloads).toEqual([]);
    });

    it('does not depend on the order a listing arrives in, and has the documented shape', () => {
      const a = { key: 'a', version: '1', size: 1 };
      const b = { key: 'b', version: '2', size: 2 };
      expect(remoteRevisionToken('s3', [a, b])).toBe(remoteRevisionToken('s3', [b, a]));
      expect(remoteRevisionToken('s3', [a, b])).toMatch(/^s3:v1:2:[0-9a-f]{64}$/);
      expect(remoteRevisionToken('s3', [])).toMatch(/^s3:v1:0:[0-9a-f]{64}$/);
    });
  });

  describe('the ceiling', () => {
    it('keeps the first objects in key order, says so in capitals, and names the setting', async () => {
      for (const key of ['d.md', 'a.md', 'c.md', 'b.md', 'e.md']) remote.put(key, key);
      const result = await run({ ceiling: { setting: 'FAKE_MAX_OBJECTS', noun: 'object', max: 3 } });

      expect(result.truncated).toBe(true);
      expect(await files()).toEqual(['a.md', 'b.md', 'c.md']);
      expect(result.note).toContain('STOPPED AT THE 3-OBJECT CEILING (FAKE_MAX_OBJECTS)');
      expect(result.note).toContain('holds 5 objects');
      expect(result.note).toContain('NOT indexed');
    });

    it('takes its token over the whole listing, so the probe agrees with it', async () => {
      for (const key of ['a.md', 'b.md', 'c.md']) remote.put(key, key);
      const result = await run({ ceiling: { setting: 'FAKE_MAX_OBJECTS', noun: 'object', max: 1 } });
      expect(result.configPatch[PROBE_TOKEN_KEY]).toBe(await probeRemoteTree(remote, 'fake'));
    });

    it('removes a file that fell past a lowered ceiling', async () => {
      remote.put('a.md', 'A').put('b.md', 'B');
      await run();
      const result = await run({ ceiling: { setting: 'FAKE_MAX_OBJECTS', noun: 'object', max: 1 } });
      expect(result.removed).toEqual(['b.md']);
      expect(await files()).toEqual(['a.md']);
    });

    it('applyCeiling and ceilingNote are usable on their own', () => {
      const ceiling = { setting: 'X_MAX_FILES', noun: 'file', max: 2 };
      expect(applyCeiling([1, 2, 3], ceiling)).toEqual({ kept: [1, 2], truncated: true });
      expect(applyCeiling([1, 2], ceiling)).toEqual({ kept: [1, 2], truncated: false });
      expect(ceilingNote(ceiling, 9)).toContain('2-FILE CEILING (X_MAX_FILES)');
    });
  });

  describe('keys that cannot be files', () => {
    it.each([
      ['', 'unsafe_name'],
      ['a//b.md', 'unsafe_name'],
      ['/abs.md', 'unsafe_name'],
      ['../escape.md', 'unsafe_name'],
      ['a/../escape.md', 'unsafe_name'],
      ['a/./b.md', 'unsafe_name'],
      ['nul\0.md', 'unsafe_name'],
      [`${'x'.repeat(256)}.md`, 'unsafe_name'],
      ['docs/', 'folder_marker'],
      ['fine/ok.md', null],
      [`${'x'.repeat(250)}.md`, null],
    ])('judges %j as %s', (key, expected) => {
      expect(unusableKey(key)).toBe(expected);
    });

    it('skips them, names them in the note, writes nothing outside the root, and still indexes the rest', async () => {
      remote.put('ok.md', 'ok').put('../escape.md', 'bad').put('a//b.md', 'bad').put('folder/', '').put('nul\0.md', 'bad');
      const result = await run();

      expect(result.downloaded).toEqual(['ok.md']);
      expect(result.skipped.unsafe_name.sort()).toEqual(['../escape.md', 'a//b.md', 'nul\0.md']);
      expect(result.skipped.folder_marker).toEqual(['folder/']);
      expect(result.note).toContain('3 with a name that cannot be a file path');
      expect(result.note).toContain('1 folder markers ignored');
      expect(await files()).toEqual(['ok.md']);
      await expect(fs.stat(path.join(sourceDir(dataDir, PROJECT, SOURCE), 'escape.md'))).rejects.toThrow();
      expect(remote.downloads).toEqual(['ok.md']);
    });

    it('does not count them against the ceiling', async () => {
      remote.put('folder/', '').put('a.md', 'A').put('b.md', 'B');
      const result = await run({ ceiling: { setting: 'FAKE_MAX_OBJECTS', noun: 'object', max: 2 } });
      expect(result.truncated).toBe(false);
      expect(await files()).toEqual(['a.md', 'b.md']);
    });

    // What an earlier run left on disk is not a conflict: the listing no longer holds it, so it goes, and the
    // new object is written. Skipping it would leave the probe token ahead of the tree (ADR-0048 rule 1).
    const manifestKeys = async (): Promise<string[]> =>
      Object.keys(JSON.parse(await fs.readFile(remoteManifestPath(dataDir, PROJECT, SOURCE), 'utf8')).objects).sort();

    it('replaces a file an earlier run left with the directory the new listing needs', async () => {
      remote.put('docs', 'old file').put('keep.md', 'K');
      await run();
      remote.objects.delete('docs');
      remote.put('docs/index.md', 'new index');

      const result = await run();

      expect(result.skipped.path_conflict).toEqual([]);
      expect(result.downloaded).toEqual(['docs/index.md']);
      expect(result.removed).toEqual(['docs']);
      expect(await read('docs/index.md')).toBe('new index');
      expect(await files()).toEqual(['docs/index.md', 'keep.md']);
      expect(await manifestKeys()).toEqual(['docs/index.md', 'keep.md']);
      expect(result.configPatch[PROBE_TOKEN_KEY]).toBe(await probeRemoteTree(remote, 'fake'));
    });

    it('replaces a directory an earlier run left with the file the new listing needs', async () => {
      remote.put('docs/index.md', 'old index').put('docs/deep/more.md', 'more').put('keep.md', 'K');
      await run();
      remote.objects.delete('docs/index.md');
      remote.objects.delete('docs/deep/more.md');
      remote.put('docs', 'now a file');

      const result = await run();

      expect(result.skipped.path_conflict).toEqual([]);
      expect(result.downloaded).toEqual(['docs']);
      expect(result.removed.sort()).toEqual(['docs/deep/more.md', 'docs/index.md']);
      expect(await read('docs')).toBe('now a file');
      expect(await files()).toEqual(['docs', 'keep.md']);
      expect(await manifestKeys()).toEqual(['docs', 'keep.md']);
    });

    it('replaces a file standing several directories up', async () => {
      remote.put('a', 'file');
      await run();
      remote.objects.delete('a');
      remote.put('a/b/c.md', 'deep');

      const result = await run();

      expect(result.skipped.path_conflict).toEqual([]);
      expect(await read('a/b/c.md')).toBe('deep');
      expect(result.removed).toEqual(['a']);
    });

    it('leaves the stale entry alone when the download that would replace it fails', async () => {
      remote.put('docs', 'old file');
      await run();
      remote.objects.delete('docs');
      remote.put('docs/index.md', 'new index');
      remote.failOn = 'docs/index.md';

      await expect(run()).rejects.toThrow('download of docs/index.md failed');
      expect(await read('docs')).toBe('old file');

      remote.failOn = null;
      await run();
      expect(await files()).toEqual(['docs/index.md']);
    });

    it('names the key that lost when two keys want one path', async () => {
      remote.put('a', 'file').put('a/b.md', 'nested');
      const result = await run();
      expect(result.skipped.path_conflict).toEqual(['a/b.md']);
      expect(await files()).toEqual(['a']);
      expect(result.note).toContain('whose path another key occupies (a/b.md)');
    });
  });

  describe('the size limit', () => {
    it('refuses an object listed over it by name and downloads nothing for it', async () => {
      remote.put('small.md', 'ok').put('huge.pdf', 'p', 'v-huge', 5000);
      const result = await run();

      expect(remote.downloads).toEqual(['small.md']);
      expect(result.skipped.too_large).toEqual(['huge.pdf']);
      expect(result.note).toContain('1 over the size limit and not indexed (huge.pdf)');
      expect(await files()).toEqual(['small.md']);
    });

    it('also stops a body that streams past it, and leaves no partial file', async () => {
      remote.put('liar.md', 'x'.repeat(100), 'v-liar', 100);
      remote.streamExtra = 5000;
      const result = await run();

      expect(result.skipped.too_large).toEqual(['liar.md']);
      expect(await files()).toEqual([]);
      expect(await fs.readdir(sourceDir(dataDir, PROJECT, SOURCE))).not.toContain('.remote-tmp');
    });

    it('removes the file of an object that has since grown past the limit', async () => {
      remote.put('a.md', 'A');
      await run();
      remote.put('a.md', 'A'.repeat(50), 'v-grown');
      const result = await run({ maxObjectBytes: 10 });
      expect(result.removed).toEqual(['a.md']);
      expect(await files()).toEqual([]);
    });
  });

  describe('the disk', () => {
    it('fails with insufficient_disk, downloads nothing and deletes nothing, when the downloads would not leave the minimum free', async () => {
      remote.put('keep.md', 'K');
      await run();
      remote.put('big.md', 'x'.repeat(600));
      remote.objects.delete('keep.md');
      remote.downloads = [];

      const attempt = run({ minFreeBytes: 1000, readDisk: async () => ({ freeBytes: 1500, totalBytes: 10_000 }) });

      await expect(attempt).rejects.toBeInstanceOf(InsufficientDiskError);
      await expect(attempt).rejects.toMatchObject({ code: 'insufficient_disk' });
      expect(remote.downloads).toEqual([]);
      expect(await files()).toEqual(['keep.md']);
    });

    it('runs when the downloads leave exactly the minimum, and when nothing is to be downloaded at all', async () => {
      remote.put('a.md', 'x'.repeat(500));
      await run({ minFreeBytes: 1000, readDisk: async () => ({ freeBytes: 1500, totalBytes: 10_000 }) });
      expect(await files()).toEqual(['a.md']);

      const result = await run({ minFreeBytes: 1_000_000, readDisk: async () => ({ freeBytes: 1, totalBytes: 10_000 }) });
      expect(result.unchanged).toBe(1);
    });

    it('does not refuse when the disk cannot be read', async () => {
      remote.put('a.md', 'A');
      await run({
        minFreeBytes: 1000,
        readDisk: async () => {
          throw new Error('statfs unavailable');
        },
      });
      expect(await files()).toEqual(['a.md']);
    });
  });

  describe('a failure', () => {
    it('propagates, deletes nothing, and moves neither the manifest nor the token', async () => {
      remote.put('a.md', 'A').put('b.md', 'B');
      const first = await run();
      remote.objects.delete('a.md');
      remote.put('b.md', 'B2').put('c.md', 'C');
      remote.failOn = 'c.md';
      remote.downloads = [];

      await expect(run()).rejects.toThrow('download of c.md failed');

      // `a.md` is gone from the remote but not from disk: nothing is removed by a run that did not finish.
      expect(await files()).toContain('a.md');
      expect(await fs.readdir(sourceDir(dataDir, PROJECT, SOURCE))).not.toContain('.remote-tmp');

      // The next run, with the remote healthy, converges.
      remote.failOn = null;
      const second = await run();
      expect(await files()).toEqual(['b.md', 'c.md']);
      expect(await read('b.md')).toBe('B2');
      expect(second.configPatch[PROBE_TOKEN_KEY]).not.toBe(first.configPatch[PROBE_TOKEN_KEY]);
    });

    it('lets a listing failure through before touching the disk', async () => {
      remote.list = async () => {
        throw new Error('listing failed');
      };
      await expect(run()).rejects.toThrow('listing failed');
      expect(await files()).toEqual([]);
    });
  });
});
