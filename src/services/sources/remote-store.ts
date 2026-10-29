import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InsufficientDiskError, readDiskSpace, type DiskSpace } from '../disk-space.js';
import { sourceCurrentDir, sourceDir } from '../data-dir.js';
import { PROBE_TOKEN_KEY } from '../sources.js';

/**
 * The pattern every source that mirrors a remote file store follows — an S3 bucket, a Drive folder
 * ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decisions 4–6): **list, give each object
 * a version token, download only what changed, materialise under `DATA_DIR`, remove what the listing no
 * longer holds, and derive the probe token from the listing**.
 *
 * It knows nothing about any remote. A driver supplies a {@link RemoteStore} (its listing and its
 * download) and the knobs ({@link SyncRemoteTreeOptions}); this module owns what must be identical
 * across drivers and easy to get subtly wrong once:
 *
 * - **One token function.** {@link remoteRevisionToken} is called by {@link probeRemoteTree} and by
 *   {@link syncRemoteTree} on the same kind of listing, so "equal" can be trusted
 *   ([ADR-0048](../../../.ssot/ADR.md#adr-0048) rule 3). The sync returns it in `configPatch` under
 *   `PROBE_TOKEN_KEY`, which the indexer persists only after a run that succeeded: a failed run moves
 *   neither the token nor the manifest.
 * - **Paths are never trusted.** A remote key becomes a file under `<source>/current/`; a key that
 *   could leave it, or that no file system can hold, is skipped and counted, never written.
 * - **Downloads are written to a temporary file and renamed**, so the indexer never scans half a file,
 *   and nothing is deleted until every download of the run has succeeded.
 * - **Bounds are checked before bytes arrive**: the object ceiling, a per-object size limit (also
 *   enforced on the stream, since a listed size is the remote's claim) and the disk's free space.
 *
 * Conversion of what lands on disk (`.pdf`, `.docx`…) stays with `doc-types` and the conversion worker.
 */

/** One object in scope, as a listing reports it. */
export interface RemoteObject {
  /** The remote's own name for it, `/`-separated; becomes the path under `current/`. */
  key: string;
  /** The remote's version of it: an S3 ETag, a Drive `version` or `md5Checksum`. Compared for equality only. */
  version: string;
  /** Listed size in bytes. */
  size: number;
  /**
   * What the disk check counts for this object when the listing cannot say how big the download will be
   * (a Google-native file has no size until it is exported; [ADR-0127](../../../.ssot/ADR.md#adr-0127)
   * decision 7 counts it as its ceiling). Unset: {@link RemoteObject.size}. The size limit and the manifest
   * still use `size`.
   */
  reserveBytes?: number;
}

export interface RemoteDownload {
  body: AsyncIterable<Uint8Array> | Uint8Array;
  /** The version the download itself answered, when it says (S3's `GetObject` ETag); else the listed one is recorded. */
  version?: string;
}

/** What a driver supplies. Neither method touches `DATA_DIR`. */
export interface RemoteStore {
  /** Every object in scope, in any order. Throws when the listing cannot be completed: a partial listing would delete files. */
  list(): Promise<readonly RemoteObject[]>;
  download(object: RemoteObject): Promise<RemoteDownload>;
}

// ---------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------

export type SkipReason = 'folder_marker' | 'unsafe_name' | 'too_large' | 'path_conflict';

/**
 * Why a remote key cannot become a file under the source's root, or `null` when it can
 * ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 5): a key ending `/` is a folder marker, and a key with an
 * empty, `.` or `..` segment, a NUL, or a segment over 255 bytes is refused. No path is ever written outside the root.
 */
export function unusableKey(key: string): 'folder_marker' | 'unsafe_name' | null {
  if (key.endsWith('/')) return 'folder_marker';
  if (key.includes('\0')) return 'unsafe_name';
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'unsafe_name';
    if (Buffer.byteLength(segment, 'utf8') > 255) return 'unsafe_name';
  }
  return null;
}

const byKey = (a: RemoteObject, b: RemoteObject): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// ---------------------------------------------------------------------------------------------------
// The probe token
// ---------------------------------------------------------------------------------------------------

/**
 * `<prefix>:v1:<count>:<sha256>` over the sorted `key\tversion\tsize` lines of **every** object listed.
 * The caller passes the whole listing, not the part under a ceiling: the probe sees the whole listing,
 * and a token that dropped the objects past the ceiling would differ from the probe's on the first run
 * after it was reached.
 */
export function remoteRevisionToken(prefix: string, objects: readonly RemoteObject[]): string {
  const lines = [...objects].sort(byKey).map((o) => `${o.key}\t${o.version}\t${o.size}`);
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `${prefix}:v1:${objects.length}:${digest}`;
}

/** The probe: list, hash, download nothing. The same function the sync derives its token with. */
export async function probeRemoteTree(store: RemoteStore, tokenPrefix: string): Promise<string> {
  return remoteRevisionToken(tokenPrefix, await store.list());
}

// ---------------------------------------------------------------------------------------------------
// The per-type ceiling
// ---------------------------------------------------------------------------------------------------

export interface Ceiling {
  /** The env setting that moves it, named in the note (`S3_MAX_OBJECTS`). */
  setting: string;
  /** What is counted, singular (`object`, `file`). */
  noun: string;
  max: number;
}

export interface Capped<T> {
  kept: T[];
  truncated: boolean;
}

/**
 * The first `ceiling.max` of `sorted`, and whether anything was left out. What a driver does with
 * `truncated` is {@link ceilingNote}'s job: a partial index that looks complete is the failure this exists
 * to prevent, the same one `CONFLUENCE_MAX_PAGES` guards.
 */
export function applyCeiling<T>(sorted: readonly T[], ceiling: Ceiling): Capped<T> {
  return sorted.length > ceiling.max ? { kept: sorted.slice(0, ceiling.max), truncated: true } : { kept: [...sorted], truncated: false };
}

/** The sentence a truncated run's note carries; it names the ceiling's setting and says, in capitals, that the rest is not indexed. */
export function ceilingNote(ceiling: Ceiling, total: number): string {
  return (
    `STOPPED AT THE ${ceiling.max}-${ceiling.noun.toUpperCase()} CEILING (${ceiling.setting}): this source holds ${total} ${ceiling.noun}s, ` +
    `and the rest are NOT indexed. Narrow its scope, split it across several sources, or raise ${ceiling.setting}.`
  );
}

// ---------------------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------------------

const MANIFEST_FILE = 'remote-manifest.json';
const TMP_DIR = '.remote-tmp';

interface Manifest {
  v: 1;
  /** What the listing was a listing of (bucket + prefix + endpoint); a manifest of another scope is not trusted. */
  scope: string;
  objects: Record<string, { version: string; size: number }>;
}

/** Beside `current/`, so the indexer never scans it and it goes with the source's directory. */
export function remoteManifestPath(dataDir: string, projectId: string, sourceId: string): string {
  return path.join(sourceDir(dataDir, projectId, sourceId), MANIFEST_FILE);
}

async function readManifest(file: string, scope: string): Promise<Manifest['objects']> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Manifest>;
    if (parsed.v === 1 && parsed.scope === scope && typeof parsed.objects === 'object' && parsed.objects !== null) return parsed.objects;
  } catch {
    // Missing, unreadable or corrupt: losing the manifest costs one full download, never a wrong tree.
  }
  return {};
}

async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------------------------------

export interface SyncRemoteTreeOptions {
  store: RemoteStore;
  dataDir: string;
  projectId: string;
  sourceId: string;
  /** The probe token's type prefix (`s3`). */
  tokenPrefix: string;
  /** Identity of what is listed; a manifest written for another scope is ignored. */
  scope: string;
  ceiling: Ceiling;
  /** An object listed over this, or streaming past it, is refused by name and not kept (`MAX_CONVERTED_FILE_BYTES`). */
  maxObjectBytes: number;
  /** Free space `DATA_DIR` must keep after the downloads (`DATA_DIR_MIN_FREE_BYTES`); `0` or unset disables the check. */
  minFreeBytes?: number;
  /** Test seam; production reads the real file system. */
  readDisk?: (dir: string) => Promise<DiskSpace>;
}

export interface RemoteSyncResult {
  /** Objects present on disk after the run. */
  kept: number;
  /** Objects listed, ceiling or not, usable or not. */
  total: number;
  downloaded: string[];
  unchanged: number;
  removed: string[];
  skipped: Record<SkipReason, string[]>;
  truncated: boolean;
  /** For the driver's `SyncResult`: carries the probe token, advancing only with this successful run. */
  configPatch: Record<string, unknown>;
  /** The run's note: counts, what was skipped, and the ceiling sentence when it applies. */
  note: string;
}

/**
 * Thrown by the stream the sync writes, and by a store's `download` that learns the object is over the limit
 * before any byte arrives (Drive refuses an export over 10 MB): either way the object is named in the note
 * as over the size limit and the run goes on.
 */
export class ObjectTooLarge extends Error {}

function targetFor(root: string, key: string): string | null {
  const target = path.join(root, ...key.split('/'));
  // `unusableKey` already refused `..`; this is the belt over those braces.
  return target.startsWith(root + path.sep) ? target : null;
}

/** Whether the file a manifest entry stands for is still there; a manifest that outlived its file must not skip the download. */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function writeDownload(download: RemoteDownload, tmp: string, limit: number): Promise<void> {
  const handle = await fs.open(tmp, 'w');
  let written = 0;
  try {
    const chunks = download.body instanceof Uint8Array ? [download.body] : download.body;
    for await (const chunk of chunks) {
      written += chunk.byteLength;
      if (written > limit) throw new ObjectTooLarge();
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(root);
  return out;
}

async function pruneEmptyDirectories(root: string): Promise<void> {
  const prune = async (dir: string): Promise<boolean> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory() && (await prune(path.join(dir, entry.name)))) continue;
      empty = false;
    }
    if (empty && dir !== root) {
      await fs.rmdir(dir).catch(() => undefined);
      return true;
    }
    return false;
  };
  await prune(root);
}

/** `a/b/c.md` → `a`, `a/b`: the paths that must be directories for the key to be a file. */
function ancestorsOf(key: string): string[] {
  const segments = key.split('/');
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'));
}

/**
 * Of the keys that will be on disk, the ones that cannot be: `a` and `a/b` cannot both exist. Keys come in
 * key order, which puts an ancestor before its descendants, so the one that sorts first wins and the
 * descendant is named in the note. This is a property of the *listing*, so it is stable run to run; what
 * an earlier run left on disk is not a conflict and is cleared by {@link clearObstacles}.
 */
function dropPathConflicts(wanted: readonly RemoteObject[], skipped: Record<SkipReason, string[]>): RemoteObject[] {
  const accepted = new Set<string>();
  const placeable: RemoteObject[] = [];
  for (const object of wanted) {
    if (ancestorsOf(object.key).some((ancestor) => accepted.has(ancestor))) {
      skipped.path_conflict.push(object.key);
      continue;
    }
    accepted.add(object.key);
    placeable.push(object);
  }
  return placeable;
}

/**
 * Removes what an earlier run left where `key` is about to be written: a file standing where one of its
 * directories must be, or a directory standing where the file must be. By the time this runs the listing has
 * settled that no wanted key needs the old entry ({@link dropPathConflicts}), so it is stale by definition.
 * Without it a bucket that turns `docs` into `docs/index.md` would skip the new object, advance the probe
 * token and hide it until the maximum-age run ([ADR-0048](../../../.ssot/ADR.md#adr-0048) rule 1).
 * Returns the keys of the files it removed.
 */
async function clearObstacles(root: string, key: string): Promise<string[]> {
  const removed: string[] = [];
  const asKey = (file: string) => path.relative(root, file).split(path.sep).join('/');
  for (const ancestor of ancestorsOf(key)) {
    const full = path.join(root, ...ancestor.split('/'));
    let st: import('node:fs').Stats;
    try {
      st = await fs.lstat(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return removed;
      throw err;
    }
    if (st.isDirectory()) continue;
    await fs.rm(full, { force: true });
    removed.push(asKey(full));
    return removed;
  }
  const target = path.join(root, ...key.split('/'));
  try {
    if ((await fs.lstat(target)).isDirectory()) {
      for (const file of await listFiles(target)) removed.push(asKey(file));
      await fs.rm(target, { recursive: true, force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return removed;
}

/**
 * Brings `<source>/current/` up to date with the remote's listing and returns the token the next probe
 * will be compared with. See the module comment for the order of operations and why.
 *
 * Throws the store's own error when a listing or a download fails: the run ends as an error, `current/`
 * keeps every file it had that this run did not replace, and neither the manifest nor the token moves.
 * An object that is merely unusable (a bad name, too large, a path another listed key needs) is skipped,
 * counted and named in the note, and the run goes on. Anything a previous run left in the way of a new
 * object is removed, never a reason to skip it: a skip the listing does not explain would leave the probe
 * token ahead of the tree.
 */
export async function syncRemoteTree(options: SyncRemoteTreeOptions): Promise<RemoteSyncResult> {
  const { store, dataDir, projectId, sourceId, ceiling } = options;
  const root = sourceCurrentDir(dataDir, projectId, sourceId);
  const manifestFile = remoteManifestPath(dataDir, projectId, sourceId);
  const tmpDir = path.join(sourceDir(dataDir, projectId, sourceId), TMP_DIR);

  const listed = await store.list();
  const token = remoteRevisionToken(options.tokenPrefix, listed);

  const skipped: Record<SkipReason, string[]> = { folder_marker: [], unsafe_name: [], too_large: [], path_conflict: [] };
  const usable: RemoteObject[] = [];
  for (const object of [...listed].sort(byKey)) {
    const reason = unusableKey(object.key);
    if (reason) skipped[reason].push(object.key);
    else usable.push(object);
  }
  // The ceiling counts objects in scope, which a folder marker or a refused name is not.
  const { kept, truncated } = applyCeiling(usable, ceiling);

  const sized: RemoteObject[] = [];
  for (const object of kept) {
    if (object.size > options.maxObjectBytes) skipped.too_large.push(object.key);
    else sized.push(object);
  }
  const wanted = dropPathConflicts(sized, skipped);

  const previous = await readManifest(manifestFile, options.scope);
  const changed: RemoteObject[] = [];
  const next: Manifest['objects'] = {};
  let unchanged = 0;
  for (const object of wanted) {
    const target = targetFor(root, object.key);
    const before = previous[object.key];
    if (target && before && before.version === object.version && before.size === object.size && (await isRegularFile(target))) {
      unchanged++;
      next[object.key] = before;
    } else changed.push(object);
  }

  // Before a byte is fetched: the run that would fill the disk fails here, downloading nothing.
  const toDownload = changed.reduce((sum, o) => sum + (o.reserveBytes ?? o.size), 0);
  if (options.minFreeBytes && changed.length > 0) {
    const space = await (options.readDisk ?? readDiskSpace)(dataDir).catch(() => null);
    if (space && space.freeBytes - toDownload < options.minFreeBytes) {
      throw new InsufficientDiskError(
        Math.max(0, space.freeBytes - toDownload),
        options.minFreeBytes,
        'the data directory after this sync’s downloads',
      );
    }
  }

  const downloaded: string[] = [];
  const removed: string[] = [];
  if (changed.length > 0) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
  }
  try {
    for (const object of changed) {
      const target = targetFor(root, object.key);
      if (!target) {
        skipped.unsafe_name.push(object.key);
        continue;
      }
      const tmp = path.join(tmpDir, randomBytes(8).toString('hex'));
      let download: RemoteDownload;
      try {
        download = await store.download(object);
        await writeDownload(download, tmp, options.maxObjectBytes);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        if (err instanceof ObjectTooLarge) {
          skipped.too_large.push(object.key);
          continue;
        }
        throw err;
      }
      try {
        // Only after the download succeeded, so a failed one leaves the stale entry in place.
        removed.push(...(await clearObstacles(root, object.key)));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        // Whatever this is, it is not a skip the listing explains: the run fails and the token does not move.
        throw err;
      }
      downloaded.push(object.key);
      next[object.key] = { version: download.version ?? object.version, size: object.size };
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // Only now, with every download behind us: whatever the listing does not hold is gone.
  const keep = new Set(Object.keys(next));
  for (const file of await listFiles(root)) {
    const key = path.relative(root, file).split(path.sep).join('/');
    if (keep.has(key)) continue;
    await fs.rm(file, { force: true });
    removed.push(key);
  }
  await pruneEmptyDirectories(root);

  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFileAtomic(manifestFile, JSON.stringify({ v: 1, scope: options.scope, objects: next } satisfies Manifest));

  const presentCount = Object.keys(next).length;
  const note = describeRun({ ceiling, total: usable.length, kept: presentCount, downloaded, unchanged, removed, skipped, truncated });
  return {
    kept: presentCount,
    total: listed.length,
    downloaded,
    unchanged,
    removed,
    skipped,
    truncated,
    configPatch: { [PROBE_TOKEN_KEY]: token },
    note,
  };
}

const NAMED_SKIPS = 5;

function describeRun(input: {
  ceiling: Ceiling;
  total: number;
  kept: number;
  downloaded: string[];
  unchanged: number;
  removed: string[];
  skipped: Record<SkipReason, string[]>;
  truncated: boolean;
}): string {
  const { ceiling, skipped } = input;
  const base = `${input.kept} ${ceiling.noun}s, ${input.downloaded.length} downloaded, ${input.unchanged} unchanged, ${input.removed.length} removed`;
  const notes: string[] = [];
  const named = (keys: string[]): string =>
    keys.slice(0, NAMED_SKIPS).join(', ') + (keys.length > NAMED_SKIPS ? `, +${keys.length - NAMED_SKIPS} more` : '');
  if (skipped.too_large.length) notes.push(`${skipped.too_large.length} over the size limit and not indexed (${named(skipped.too_large)})`);
  if (skipped.unsafe_name.length) notes.push(`${skipped.unsafe_name.length} with a name that cannot be a file path (${named(skipped.unsafe_name)})`);
  if (skipped.path_conflict.length) notes.push(`${skipped.path_conflict.length} whose path another key occupies (${named(skipped.path_conflict)})`);
  if (skipped.folder_marker.length) notes.push(`${skipped.folder_marker.length} folder markers ignored`);
  const head = notes.length ? `${base} (skipped: ${notes.join('; ')})` : base;
  return input.truncated ? `${head} — ${ceilingNote(ceiling, input.total)}` : head;
}
