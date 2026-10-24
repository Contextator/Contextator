import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { projects, type ProjectRow } from '../db/schema.js';
import { isSessionName, sourceCurrentDir, stagingRootDir } from './data-dir.js';
import { QuotaUsageUnavailableError } from './errors.js';
import { listSources } from './sources.js';

/**
 * Per-project quotas ([ADR-0117](../../.ssot/ADR.md#adr-0117)): how the effective limit is worked out, how the
 * stored upload bytes are measured, and how a project's own values are written.
 *
 * The effective limit is the project's own column when it has one and the instance's `PROJECT_MAX_*`
 * otherwise (`project.maxX ?? config.PROJECT_MAX_X`); `0` at either level means unlimited. Because the
 * project's own `0` wins over a non-zero instance value, "exempt this project" and "follow the instance"
 * (`null`) stay two different things.
 */

export type QuotaDefaults = Pick<Config, 'PROJECT_MAX_DOCUMENTS' | 'PROJECT_MAX_CHUNKS' | 'PROJECT_MAX_UPLOAD_BYTES'>;
type QuotaColumns = Pick<ProjectRow, 'maxDocuments' | 'maxChunks' | 'maxUploadBytes'>;

export interface EffectiveQuota {
  /** `0` means unlimited. */
  limit: number;
  /** True when `limit` is the instance's value because the project has none of its own. */
  inherited: boolean;
}

export interface EffectiveQuotas {
  documents: EffectiveQuota;
  chunks: EffectiveQuota;
  uploadBytes: EffectiveQuota;
}

/** One quota's effective limit: the project's own value when it has one, the instance's otherwise. */
export function resolveQuota(own: number | null, instance: number): EffectiveQuota {
  return own === null ? { limit: instance, inherited: true } : { limit: own, inherited: false };
}

export function resolveQuotas(project: QuotaColumns, defaults: QuotaDefaults): EffectiveQuotas {
  return {
    documents: resolveQuota(project.maxDocuments, defaults.PROJECT_MAX_DOCUMENTS),
    chunks: resolveQuota(project.maxChunks, defaults.PROJECT_MAX_CHUNKS),
    uploadBytes: resolveQuota(project.maxUploadBytes, defaults.PROJECT_MAX_UPLOAD_BYTES),
  };
}

/**
 * The bytes of every regular file under `dir`, recursively; `0` when `dir` does not exist.
 *
 * Anything else that goes wrong while reading is a `QuotaUsageUnavailableError`, with one exception: a file
 * that disappears between listing and `stat` (a concurrent delete or commit) simply is not counted, because
 * the measurement is of a tree that is allowed to change underneath it.
 */
export async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new QuotaUsageUnavailableError(dir, err);
  }
  let total = 0;
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(abs);
    else if (entry.isFile()) {
      try {
        total += (await fs.stat(abs)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new QuotaUsageUnavailableError(abs, err);
      }
    }
  }
  return total;
}

/**
 * The ceiling of a stored quota. Row counts live in `integer` columns; the byte quota is a `bigint` column read
 * as a JS number, hence `MAX_SAFE_INTEGER`. The PATCH body and an imported manifest are held to the same values.
 */
export const QUOTA_ROW_COUNT_MAX = 2147483647;
export const QUOTA_BYTES_MAX = Number.MAX_SAFE_INTEGER;

/**
 * How long an upload session may sit untouched before its staged bytes stop counting against the quota. An
 * abandoned session (a closed tab, a client that crashed after its first request) is otherwise never
 * cleaned up, and would hold part of the quota for good. Every request on a session renews it.
 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The prefix a session directory gets while the sweep deletes it (`.trash-<session>`): never a session name, never counted. */
export const SWEPT_SESSION_PREFIX = '.trash-';

/**
 * The bytes of the live upload sessions under one source's `.staging/`, leaving out `excludeSession`, expired ones
 * and every entry that is not a session (a `.trash-` directory the sweep is deleting: removing its children
 * renews its modification time, so the time alone would call it live).
 */
async function stagingBytes(root: string, excludeSession: string | undefined, now: number): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new QuotaUsageUnavailableError(root, err);
  }
  let total = 0;
  for (const name of names) {
    if (name === excludeSession || !isSessionName(name)) continue;
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs > UPLOAD_SESSION_TTL_MS) continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new QuotaUsageUnavailableError(dir, err);
    }
    total += await directoryBytes(dir);
  }
  return total;
}

export interface UploadUsageOptions {
  /** A session left out of the total: the one a commit is about to move into `current/`, which counts as `staged` there. */
  excludeSession?: string;
  /** Which source's `current/` bytes to report separately (see `UploadUsage.sourceCurrent`). */
  sourceId?: string;
}

export interface UploadUsage {
  /** Stored bytes of the project's upload sources plus the staging of their live sessions. */
  total: number;
  /** The `current/` bytes of `UploadUsageOptions.sourceId`, `0` when none was named. */
  sourceCurrent: number;
}

/**
 * The bytes stored for a project's upload sources: the sum over their `current/` trees **and** over the
 * `.staging/` trees of their live upload sessions ([ADR-0117](../../.ssot/ADR.md#adr-0117), "staging
 * included"). A session counts while it was touched within `UPLOAD_SESSION_TTL_MS`. The filesystem is the
 * source of truth for it and a counter in the database could drift from it, so this is a directory scan.
 * Only `upload` sources count; a Notion source also keeps a `current/` tree, but its size is bounded by
 * what it fetches and not by what a person pushed.
 */
export async function projectUploadUsage(db: Db, dataDir: string, projectId: string, options: UploadUsageOptions = {}): Promise<UploadUsage> {
  const sources = (await listSources(db, projectId)).filter((s) => s.type === 'upload');
  const now = Date.now();
  let total = 0;
  let sourceCurrent = 0;
  for (const source of sources) {
    const current = await directoryBytes(sourceCurrentDir(dataDir, projectId, source.id));
    if (source.id === options.sourceId) sourceCurrent = current;
    total += current + (await stagingBytes(stagingRootDir(dataDir, projectId, source.id), options.excludeSession, now));
  }
  return { total, sourceCurrent };
}

/** `projectUploadUsage(...).total`, for callers that only need the number. */
export async function projectUploadBytes(db: Db, dataDir: string, projectId: string): Promise<number> {
  return (await projectUploadUsage(db, dataDir, projectId)).total;
}

/**
 * The bytes in `to` that copying the tree `from` over it would overwrite: for every file of `from`, the size of
 * the file at the same relative path under `to`, if there is one. `add` mode replaces such files rather than
 * adding to them, so they must not be counted twice.
 */
export async function overwrittenBytes(from: string, to: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(from, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new QuotaUsageUnavailableError(from, err);
  }
  let total = 0;
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) total += await overwrittenBytes(src, dst);
    else if (entry.isFile()) total += (await fileSize(dst)) ?? 0;
  }
  return total;
}

/** The size of one regular file, `null` when there is none at that path. */
export async function fileSize(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new QuotaUsageUnavailableError(file, err);
  }
}

export interface QuotaView {
  limit: number;
  /** `null` only for `uploadBytes` when the scan failed; the read itself does not fail for it. */
  used: number | null;
  inherited: boolean;
}

export interface QuotasView {
  documents: QuotaView;
  chunks: QuotaView;
  uploadBytes: QuotaView;
}

/** What `GET /api/projects/:id` and the `PATCH` response show: each quota's effective limit, current use and origin. */
export async function describeQuotas(db: Db, dataDir: string, defaults: QuotaDefaults, project: ProjectRow): Promise<QuotasView> {
  const q = resolveQuotas(project, defaults);
  let uploadUsed: number | null = null;
  try {
    uploadUsed = await projectUploadBytes(db, dataDir, project.id);
  } catch (err) {
    // A read of the quotas must not fail because the disk could not be measured: the dashboard would lose
    // the limits too. Enforcement is the one place that fails closed (see UploadService).
    if (!(err instanceof QuotaUsageUnavailableError)) throw err;
  }
  return {
    documents: { ...q.documents, used: project.documentCount },
    chunks: { ...q.chunks, used: project.chunkCount },
    uploadBytes: { ...q.uploadBytes, used: uploadUsed },
  };
}

export interface QuotaPatch {
  maxDocuments?: number | null;
  maxChunks?: number | null;
  maxUploadBytes?: number | null;
}

/**
 * Writes the project's own quota values: a number sets, `null` hands the quota back to the instance, a key
 * that is absent is left as it was. Returns the updated row, `undefined` when there is no such project.
 */
export async function setProjectQuotas(db: Db, id: string, patch: QuotaPatch): Promise<ProjectRow | undefined> {
  const set: QuotaPatch = {};
  if (patch.maxDocuments !== undefined) set.maxDocuments = patch.maxDocuments;
  if (patch.maxChunks !== undefined) set.maxChunks = patch.maxChunks;
  if (patch.maxUploadBytes !== undefined) set.maxUploadBytes = patch.maxUploadBytes;
  const [row] = await db.update(projects).set(set).where(eq(projects.id, id)).returning();
  return row;
}
