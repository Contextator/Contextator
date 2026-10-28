import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_CONVERTED_FILE_BYTES_DEFAULT, SOURCE_PAGE_LIMIT_DEFAULTS } from '../../config.js';
import type { DocumentSourceRow } from '../../db/schema.js';
import { decryptSecret, keyringOf } from '../crypto.js';
import { sourceCurrentDir, sourceDir } from '../data-dir.js';
import { ValidationError } from '../projects.js';
import { parseSourceConfig, PROBE_TOKEN_KEY, type GdriveConfig } from '../sources.js';
import { sourceEgress, type EgressOptions } from './confluence-egress.js';
import { registerDriver, type DocumentMeta, type DocumentMetaFile, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
import {
  EXPORT_FORMATS,
  EXPORT_LIMIT_BYTES,
  FOLDER_MIME,
  GDRIVE_SECRET,
  GOOGLE_HOSTS,
  GdriveClient,
  GdriveRequestError,
  isExportTooLarge,
  SHORTCUT_MIME,
  type DriveFile,
  type DriveFolder,
  type ExportFormat,
  type GdriveEndpoints,
} from './gdrive-client.js';
import { ObjectTooLarge, syncRemoteTree, type RemoteObject, type RemoteStore } from './remote-store.js';

/**
 * A Google Drive tree as a source ([ADR-0127](../../../.ssot/ADR.md#adr-0127)): the folders in `folderIds`,
 * shared with the source's service account, mirrored to `<source>/current/` and indexed like any other
 * directory. The pattern is `remote-store.ts`'s (list → version → download what changed → remove what is
 * gone); this class supplies the Drive half of it.
 *
 * **The probe is not the listing.** One `changes.list` request from the cursor the last successful sync
 * stored says whether anything the account can see has changed; the sync, by contrast, always walks the
 * whole tree (`files.list`, one listing per folder) and downloads only the files whose `version` (Google-native)
 * or `md5Checksum` moved. The change feed decides *whether* to walk and never *what* changed, because a move, an
 * unshare, a multi-parent file and an expired cursor are each a way for a feed-driven source to go
 * silently stale (decision 6, and the alternatives it records).
 *
 * **The cursor moves with a successful run only.** The sync takes a new cursor *first* and stores it as both
 * `changesCursor` and the probe token, so a change made during the walk is seen by the next probe; the
 * indexer persists `configPatch` after a run that succeeded, so a failed run moves neither.
 *
 * **Every request goes through the egress guard, pinned to Google's two hosts** (`pinnedHosts`): the token
 * endpoint and the API. A redirect to any other host is refused, and a key file's own `token_uri` is never
 * read. No allowlist applies; the hosts are not an operator setting.
 */

/** Seconds of silence after which a request is abandoned. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The sidecar beside `current/` that maps a path to the link and edit time the listing reported (ADR-0116). */
const META_FILE = 'gdrive-meta.json';

const NAMED_SKIPS = 5;

export interface GdriveDriverOptions {
  /** Test seam: shortens the retry back-off (production waits 500 ms × 2^(n-1), jittered). */
  retryDelayMs?: number;
  /**
   * Test seam: where the token and API requests go, with `https` no longer required (a fixture is plain
   * `http`), the pin following the endpoints’ host names. Production never sets it, and the registered
   * factory does not.
   */
  endpoints?: GdriveEndpoints;
}

/** One file in scope, with what the download needs. */
interface WalkEntry {
  object: RemoteObject;
  id: string;
  exportAs: ExportFormat | null;
  url: string | null;
  modifiedAt: string | null;
}

interface WalkStats {
  folders: number;
  shortcuts: number;
  /** Google-native types that are not a Doc, a Sheet or a Slides deck. */
  unsupportedNative: number;
  /** In-scope types that the source's file-type list leaves out, and dot-names the indexer never scans. */
  leftOut: number;
  /** Names that cannot be a path segment, with a folder's whole subtree behind it. */
  unusableNames: string[];
  /** The listing stopped at `GDRIVE_MAX_FILES`. */
  truncated: boolean;
}

interface Walk {
  entries: WalkEntry[];
  stats: WalkStats;
}

const byNameThenId = (a: DriveFile, b: DriveFile): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A Drive name as a path segment: `/` is the one character a segment cannot hold. */
const asSegment = (name: string): string => name.replaceAll('/', '_');

/** Whether a name can be a path segment at all, once `/` is replaced ([ADR-0127](../../../.ssot/ADR.md#adr-0127) decision 6). */
const usableName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !name.includes('\0');

const suffixOf = (id: string): string => ` (${id.slice(0, 8)})`;

const named = (items: readonly string[]): string =>
  items.slice(0, NAMED_SKIPS).join(', ') + (items.length > NAMED_SKIPS ? `, +${items.length - NAMED_SKIPS} more` : '');

/** The names that more than one sibling holds. */
function sharedNames(names: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const name of names) (seen.has(name) ? shared : seen).add(name);
  return shared;
}

export class GdriveDriver implements SourceDriver {
  private readonly cfg: GdriveConfig;
  private readonly extensions: ReadonlySet<string>;
  private built?: GdriveClient;
  /** Throttling answers this driver’s client saw; named in the sync’s note. */
  private throttled = 0;
  /** The files the last listing found, for the sidecar and for `download`. */
  private lastWalk?: Walk;
  private byKey = new Map<string, WalkEntry>();

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
    /**
     * Test seams for the egress guard: which address a name resolves to, and where an address that has
     * passed the check is dialled. Production passes neither; the check itself cannot be replaced.
     */
    private readonly egress?: Pick<EgressOptions, 'resolve' | 'route'>,
    private readonly options: GdriveDriverOptions = {},
  ) {
    this.cfg = parseSourceConfig('gdrive', source.config);
    this.extensions = new Set(this.cfg.extensions.map((e) => e.toLowerCase()));
  }

  private client(): GdriveClient {
    if (this.built) return this.built;
    if (!this.source.secretEnc) {
      throw new ValidationError(
        'This Google Drive source has no service account key stored; paste the JSON key file of the account the folders are shared with.',
      );
    }
    const secret = GDRIVE_SECRET.parse(decryptSecret(this.source.secretEnc, keyringOf(this.ctx.config)));
    const endpoints = this.options.endpoints;
    const hosts = endpoints ? [new URL(endpoints.tokenUrl).hostname, new URL(endpoints.apiBase).hostname] : [...GOOGLE_HOSTS];
    this.built = new GdriveClient(secret, {
      fetch: sourceEgress({
        // No allowlist applies: the hosts are fixed, and a private address is never one of them.
        allowedHosts: [],
        pinnedHosts: hosts,
        label: 'Google Drive',
        subject: 'the address',
        httpsOnly: !endpoints,
        methods: ['GET', 'POST'],
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...this.egress,
      }),
      ...(endpoints ? { endpoints } : {}),
      ...(this.options.retryDelayMs === undefined ? {} : { retryDelayMs: this.options.retryDelayMs }),
      onThrottled: () => {
        this.throttled++;
        this.ctx.metrics?.countSourceThrottled?.('gdrive');
      },
    });
    return this.built;
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  // -- the walk ---------------------------------------------------------------------------------------

  /** A root folder, or the error that tells the editor what to do about it. */
  private async rootFolder(client: GdriveClient, id: string): Promise<DriveFolder> {
    let folder: DriveFolder;
    try {
      folder = await client.folder(id);
    } catch (err) {
      if (
        err instanceof GdriveRequestError &&
        (err.status === 404 || (err.status === 403 && err.reason !== undefined && /forbidden|insufficient/i.test(err.reason)))
      ) {
        throw new ValidationError(
          `\`${id}\` is not shared with ${client.serviceAccountEmail}; share the folder with that address (Viewer is enough)`,
        );
      }
      throw err;
    }
    if (folder.mimeType !== FOLDER_MIME) throw new ValidationError(`\`${id}\` is not a folder; give the id of a Drive folder`);
    if (folder.trashed) throw new ValidationError(`\`${id}\` is in the trash`);
    return folder;
  }

  /**
   * Every file in scope, named by its path under the roots, in walk order: the roots in the order of
   * `folderIds`, then depth first, each folder's children by name and then by id (sorted here, whatever
   * order the API answered in). **The one listing the sync and `list()` read.** Stops at the first file past
   * `GDRIVE_MAX_FILES`, so the files kept are the first N of the walk.
   */
  private async walk(): Promise<Walk> {
    const client = this.client();
    const max = this.maxFiles;
    const stats: WalkStats = { folders: 0, shortcuts: 0, unsupportedNative: 0, leftOut: 0, unusableNames: [], truncated: false };
    const entries: WalkEntry[] = [];
    const keys = new Set<string>();
    const visited = new Set<string>();

    // Sibling names are compared as segments: a root is a sibling of the other roots.
    const roots: DriveFolder[] = [];
    for (const id of this.cfg.folderIds) roots.push(await this.rootFolder(client, id));
    const sharedRoots = sharedNames(roots.map((r) => asSegment(r.name)));

    const walkFolder = async (folderId: string, prefix: string[]): Promise<void> => {
      if (visited.has(folderId)) return;
      visited.add(folderId);
      stats.folders++;
      const children: DriveFile[] = [];
      for await (const page of client.listChildren(folderId)) children.push(...page);
      children.sort(byNameThenId);
      const shared = sharedNames(children.map((c) => asSegment(c.name)));

      // First pass: the segment each child would take, and whether it keeps it. Second pass, below, walks.
      interface Planned {
        child: DriveFile;
        segment: string;
        entry?: WalkEntry;
      }
      const planned: Planned[] = [];
      for (const child of children) {
        const segmentName = asSegment(child.name);
        if (child.mimeType === SHORTCUT_MIME) {
          stats.shortcuts++;
          continue;
        }
        if (!usableName(child.name)) {
          stats.unusableNames.push(child.name === '' ? '(empty name)' : child.name);
          continue;
        }
        if (child.name.startsWith('.')) {
          // The indexer's scan never enters a name that starts with a dot, so fetching it would be for nothing.
          stats.leftOut++;
          continue;
        }
        const suffix = shared.has(segmentName) ? suffixOf(child.id) : '';
        if (child.mimeType === FOLDER_MIME) {
          const segment = `${segmentName}${suffix}`;
          if (Buffer.byteLength(segment, 'utf8') > 255) stats.unusableNames.push(child.name);
          else planned.push({ child, segment });
          continue;
        }
        const exportAs = EXPORT_FORMATS[child.mimeType] ?? null;
        let stem: string;
        let extension: string;
        if (child.mimeType.startsWith('application/vnd.google-apps.')) {
          if (!exportAs) {
            stats.unsupportedNative++;
            continue;
          }
          if (!this.extensions.has(exportAs.extension)) {
            stats.leftOut++;
            continue;
          }
          extension = exportAs.extension;
          // A Doc already called "notes.md" is not "notes.md.md".
          stem = segmentName.toLowerCase().endsWith(`.${extension}`) ? segmentName.slice(0, -(extension.length + 1)) : segmentName;
        } else {
          const dot = segmentName.lastIndexOf('.');
          if (dot <= 0 || !this.extensions.has(segmentName.slice(dot + 1).toLowerCase())) {
            stats.leftOut++;
            continue;
          }
          extension = segmentName.slice(dot + 1);
          stem = segmentName.slice(0, dot);
        }
        const segment = `${stem}${suffix}.${extension}`;
        if (Buffer.byteLength(segment, 'utf8') > 255) {
          stats.unusableNames.push(child.name);
          continue;
        }
        planned.push({ child, segment, entry: this.entryFor(child, exportAs) });
      }

      // A Doc called "a" and a stored "a.md" share no name but would share a path: both take the suffix.
      const clashing = sharedNames(planned.map((p) => p.segment));
      for (const item of planned) {
        if (!clashing.has(item.segment) || item.segment.includes(suffixOf(item.child.id))) continue;
        const dot = item.entry ? item.segment.lastIndexOf('.') : -1;
        item.segment =
          dot > 0 ? `${item.segment.slice(0, dot)}${suffixOf(item.child.id)}${item.segment.slice(dot)}` : `${item.segment}${suffixOf(item.child.id)}`;
      }

      // The suffix above can push a segment past the limit the first pass checked.
      for (let i = planned.length - 1; i >= 0; i--) {
        const over = planned[i];
        if (over && Buffer.byteLength(over.segment, 'utf8') > 255) {
          stats.unusableNames.push(over.child.name);
          planned.splice(i, 1);
        }
      }

      for (const item of planned) {
        if (stats.truncated) return;
        if (item.child.mimeType === FOLDER_MIME) {
          await walkFolder(item.child.id, [...prefix, item.segment]);
          continue;
        }
        const entry = item.entry as WalkEntry;
        const key = [...prefix, item.segment].join('/');
        if (keys.has(key)) {
          // Two ids sharing their first eight characters and a name: vanishingly rare, and a path never has two owners.
          stats.unusableNames.push(`${item.child.name} (duplicate path)`);
          continue;
        }
        if (entries.length >= max) {
          stats.truncated = true;
          return;
        }
        keys.add(key);
        entry.object.key = key;
        entries.push(entry);
      }
    };

    for (const root of roots) {
      if (stats.truncated) break;
      const segmentName = asSegment(root.name);
      if (!usableName(root.name) || root.name.startsWith('.')) {
        stats.unusableNames.push(root.name === '' ? '(empty name)' : root.name);
        continue;
      }
      const segment = `${segmentName}${sharedRoots.has(segmentName) ? suffixOf(root.id) : ''}`;
      if (Buffer.byteLength(segment, 'utf8') > 255) {
        stats.unusableNames.push(root.name);
        continue;
      }
      await walkFolder(root.id, [segment]);
    }
    return { entries, stats };
  }

  private entryFor(file: DriveFile, exportAs: ExportFormat | null): WalkEntry {
    // Google-native files have a `version` and no size or checksum; a stored file has both of the last two.
    const version = exportAs
      ? `v${file.version ?? `m:${file.modifiedTime ?? ''}`}`
      : file.md5Checksum
        ? `md5:${file.md5Checksum}`
        : `v${file.version ?? `m:${file.modifiedTime ?? ''}`}`;
    return {
      object: {
        key: '',
        version,
        size: exportAs ? 0 : (file.size ?? 0),
        // An export has no listed size; the disk check counts it as the most Google will return.
        ...(exportAs ? { reserveBytes: EXPORT_LIMIT_BYTES } : {}),
      },
      id: file.id,
      exportAs,
      url: file.webViewLink,
      modifiedAt: file.modifiedTime,
    };
  }

  private store(): RemoteStore {
    return {
      list: async () => {
        const walk = await this.walk();
        this.lastWalk = walk;
        this.byKey = new Map(walk.entries.map((e) => [e.object.key, e]));
        return walk.entries.map((e) => e.object);
      },
      download: async (object) => {
        const entry = this.byKey.get(object.key);
        if (!entry) throw new Error(`Google Drive file ${object.key} is not in the listing this run took`);
        const client = this.client();
        if (!entry.exportAs) return { body: await client.downloadFile(entry.id) };
        try {
          return { body: await client.exportFile(entry.id, entry.exportAs) };
        } catch (err) {
          // Over Google's 10 MB export limit: this file is refused by name and the run goes on (decision 6).
          if (isExportTooLarge(err)) throw new ObjectTooLarge();
          throw err;
        }
      },
    };
  }

  private get maxFiles(): number {
    return this.ctx.config.GDRIVE_MAX_FILES ?? SOURCE_PAGE_LIMIT_DEFAULTS.GDRIVE_MAX_FILES;
  }

  // -- SourceDriver -----------------------------------------------------------------------------------

  async test(): Promise<string> {
    const client = this.client();
    const names: string[] = [];
    for (const id of this.cfg.folderIds) names.push((await this.rootFolder(client, id)).name.slice(0, 80));
    return `Signed in as ${client.serviceAccountEmail} — ${names.length} folder(s) shared with it: ${named(names)}`;
  }

  async sync(): Promise<SyncResult> {
    const client = this.client();
    // Taken before anything is read, so a change made during the walk is seen by the next probe.
    const cursor = await client.startPageToken();
    const result = await syncRemoteTree({
      store: this.store(),
      dataDir: this.ctx.config.DATA_DIR,
      projectId: this.source.projectId,
      sourceId: this.source.id,
      tokenPrefix: 'gdrive',
      scope: JSON.stringify(['gdrive', ...this.cfg.folderIds]),
      // The walk already stopped at the ceiling, in walk order; this one only names the unit.
      ceiling: { setting: 'GDRIVE_MAX_FILES', noun: 'file', max: this.maxFiles },
      maxObjectBytes: this.ctx.config.MAX_CONVERTED_FILE_BYTES ?? MAX_CONVERTED_FILE_BYTES_DEFAULT,
      minFreeBytes: this.ctx.config.DATA_DIR_MIN_FREE_BYTES ?? 0,
    });
    const walk = this.lastWalk;
    await this.writeMeta(walk?.entries ?? []);

    const extras: string[] = [];
    const stats = walk?.stats;
    if (stats) {
      extras.push(`${stats.folders} folder(s) walked`);
      if (stats.unsupportedNative)
        extras.push(`${stats.unsupportedNative} Google file(s) of a type that cannot be exported to a readable format skipped`);
      if (stats.shortcuts) extras.push(`${stats.shortcuts} shortcut(s) not followed`);
      if (stats.leftOut) extras.push(`${stats.leftOut} file(s) left out by the file types or a leading dot`);
      if (stats.unusableNames.length) {
        extras.push(
          `${stats.unusableNames.length} with a name that cannot be a file path, and everything under a folder of that name (${named(stats.unusableNames)})`,
        );
      }
    }
    if (this.throttled > 0) extras.push(`${this.throttled} throttling answer(s) from Google`);
    let note = `${result.note} [${extras.join('; ')}]`;
    if (stats?.truncated) {
      this.ctx.log.warn(
        { source: this.source.name, maxFiles: this.maxFiles },
        'gdrive source reached GDRIVE_MAX_FILES; the files past the ceiling are not indexed',
      );
      note += ` — STOPPED AT THE ${this.maxFiles}-FILE CEILING (GDRIVE_MAX_FILES): this source holds more files than that, and the rest are NOT indexed. Narrow its folders, split it across several sources, or raise GDRIVE_MAX_FILES.`;
    }
    // The cursor is the probe token too: "unchanged" is "the feed has nothing after the position this run took".
    return { note, configPatch: { changesCursor: cursor, [PROBE_TOKEN_KEY]: cursor } };
  }

  /**
   * One `changes.list` request from the stored cursor — the same cursor the sync stored as the probe token, so
   * nothing changed returns it unchanged and the scheduler skips the run. A change returns a different value;
   * no cursor yet, or an error (an expired cursor is Google's `400`), is "run it"
   * ([ADR-0048](../../../.ssot/ADR.md#adr-0048) rule 1).
   */
  async probe(): Promise<string | null> {
    const cursor = this.cfg.changesCursor;
    if (!cursor) return null;
    const client = this.client();
    const changed = await client.changedSince(cursor);
    this.ctx.log.debug({ source: this.source.name, requests: client.requests, changed }, 'gdrive probe');
    return changed ? `changed:${cursor}` : cursor;
  }

  // -- source links (ADR-0116) ------------------------------------------------------------------------

  private metaPath(): string {
    return path.join(sourceDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id), META_FILE);
  }

  private async writeMeta(entries: readonly WalkEntry[]): Promise<void> {
    const files: Record<string, { url: string | null; modifiedAt: string | null }> = {};
    for (const e of entries) files[e.object.key] = { url: e.url, modifiedAt: e.modifiedAt };
    const file = this.metaPath();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ v: 1, files }), 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      // A document without a link is a lesser result than a failed run: the files are in place and indexed.
      this.ctx.log.warn(
        { source: this.source.name, err: err instanceof Error ? err.message : String(err) },
        'gdrive source could not write its link map',
      );
    }
  }

  /** `webViewLink` and `modifiedTime`, as the last sync's listing reported them; never a remote call. */
  async documentMeta(files: readonly DocumentMetaFile[]): Promise<Map<string, DocumentMeta>> {
    const out = new Map<string, DocumentMeta>();
    let parsed: { v?: unknown; files?: Record<string, { url?: unknown; modifiedAt?: unknown }> };
    try {
      parsed = JSON.parse(await fs.readFile(this.metaPath(), 'utf8')) as typeof parsed;
    } catch {
      return out;
    }
    if (parsed.v !== 1 || typeof parsed.files !== 'object' || parsed.files === null) return out;
    for (const file of files) {
      const known = parsed.files[file.path];
      if (!known) continue;
      const url = typeof known.url === 'string' ? known.url : null;
      const time = typeof known.modifiedAt === 'string' ? new Date(known.modifiedAt) : null;
      out.set(file.path, { url, modifiedAt: time && !Number.isNaN(time.getTime()) ? time : null });
    }
    return out;
  }
}

registerDriver('gdrive', (source, ctx) => new GdriveDriver(source, ctx));
