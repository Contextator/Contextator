import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PROJECT_NAME_RE, SYNC_MAX_INTERVAL_MINUTES, SYNC_MIN_INTERVAL_MINUTES } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, documentSources, type DocumentSourceRow } from '../db/schema.js';
import { encryptSecret, randomSecret } from './crypto.js';
import { allowedExtensionsFor, FLAVOR_ONLY_EXTENSIONS, FLAVORS, type Flavor } from './flavors.js';
import { DEFAULT_EXTENSIONS, SUPPORTED_EXTENSIONS, resolveProjectRoot } from './fs-scan.js';
import { ConflictError, NotFoundError, ValidationError } from './projects.js';
import { TEXT_SEARCH_CONFIGS } from './text-search.js';

export const SOURCE_TYPES = ['local', 'git', 'upload', 'notion'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * **The widest set any flavor allows, narrowed to the source's own flavor by `checkExtensions` below.**
 * The enum cannot do the narrowing itself — these four schemas are per source *type*, and the flavor is
 * a column beside the config rather than a key inside it ([ADR-0057](../../.ssot/ADR.md#adr-0057)).
 */
const Extensions = z.array(z.enum([...SUPPORTED_EXTENSIONS, ...FLAVOR_ONLY_EXTENSIONS])).min(1);

/**
 * Refuses an extension this flavor's readers cannot do anything with.
 *
 * Without it a `plain` source could store `["yaml"]`, scan nothing (the matcher filters it out and
 * falls back to Markdown) and leave an operator staring at a file list that says `.yaml` beside an
 * index that holds none. The rule is stated once, here, rather than being discoverable from the
 * absence of results.
 */
function checkExtensions(flavor: Flavor, config: Record<string, unknown>): void {
  const configured = config.extensions;
  if (!Array.isArray(configured)) return;
  const allowed = allowedExtensionsFor(flavor);
  const rejected = configured.filter((e) => !allowed.includes(String(e)));
  if (rejected.length > 0) {
    throw new ValidationError(
      `The "${flavor}" content type does not read ${rejected.map((e) => `.${String(e)}`).join(', ')}. ` +
        `It reads ${allowed.map((e) => `.${e}`).join(', ')}.`,
    );
  }
}

/**
 * The PostgreSQL text search configuration this source's documents are indexed with
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). Unset — the default, and what every source created
 * before that entry holds — means `simple`.
 *
 * The empty string is accepted and normalised away so that the dashboard's "—" option can *clear* the
 * setting: `updateSource` merges a patch over the stored config, so a key the form simply omitted
 * would keep whatever was there, and there would be no way back to unset.
 *
 * **Turkish is not an option, because PostgreSQL has no Turkish configuration**, and `simple` is what
 * a Turkish source gets. The four schemas below each carry the key rather than sharing a base object,
 * because each one is also the documentation of its type in `DATA-MODEL.md` §1.
 */
const Language = z
  .enum(TEXT_SEARCH_CONFIGS)
  .or(z.literal(''))
  .optional()
  .transform((value) => (value === '' ? undefined : value));

/**
 * The driver-owned revision token the scheduler compares against
 * ([ADR-0048](../../.ssot/ADR.md#adr-0048)). Written by `sync()` through `SyncResult.configPatch`,
 * exactly as git's `lastCommit` is, and never by a client — `UpdateSourceInput` strips it.
 *
 * It appears in all four schemas rather than in a shared base, for the reason stated above the
 * language field: each of these objects is also this type's documentation in
 * [DATA-MODEL.md](../../.ssot/DATA-MODEL.md) §1, and a key that every type carries should be visible
 * in every type. Unvalidated length is the point of the cap: a driver that one day returned a
 * megabyte of etag would otherwise put it in a row the dashboard renders.
 */
const ProbeToken = z.string().max(500).optional();

/** The `config` key that token lives under. One constant, so the drivers and the scheduler agree. */
export const PROBE_TOKEN_KEY = 'syncProbeToken';

/** As much of a release label as a column, a form field and a tool argument all agree to carry. */
export const SOURCE_VERSION_MAX_LENGTH = 64;

/**
 * Which release of the documentation this source carries ([ADR-0058](../../.ssot/ADR.md#adr-0058)) —
 * stamped onto `documents.version` by every run, and the value `search_docs`' `version` argument is
 * matched against.
 *
 * **A free-form label and deliberately not a sortable thing.** `v3`, `2024.1`, `next` and `legacy` are
 * all versions somebody writes, and a product that ordered them would be confidently wrong about at
 * least one — which is the failure this whole feature exists to stop, reintroduced one layer down. So
 * the filter is equality, there is no "latest", and the entry says what it refused rather than leaving
 * it to be discovered.
 *
 * **Several sources may share one version**, which is the reason this is not simply the `source`
 * filter under another name: `api-v3` and `sdk-v3` are two mount points of one release.
 *
 * Trimmed, and the empty string is normalised away so that the dashboard's empty field *clears* the
 * setting — `updateSource` merges a patch over the stored config, and a key the form omitted would
 * keep whatever was there. Exactly the rule `language` above already follows, and the same reason.
 *
 * It appears in all four schemas rather than in a shared base, for the reason stated above both of
 * them: each object is also this type's documentation in
 * [DATA-MODEL.md](../../.ssot/DATA-MODEL.md) §1.
 */
const Version = z
  .string()
  .max(SOURCE_VERSION_MAX_LENGTH)
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

/**
 * The version a source stamps, read off a stored `config`. One reader, because the indexer, the
 * import and the route that decides whether an edit has to re-index all have to agree about what a
 * missing, blank or non-string value means: unversioned, which is `''` in the column.
 */
export function sourceVersion(config: Record<string, unknown> | null | undefined): string {
  const value = config?.version;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Two configs compared as values rather than as text. One side of the comparison below has just come
 * out of zod (keys in schema order) and the other out of `jsonb` (keys in PostgreSQL's own order), so
 * a plain `JSON.stringify` of the two would report a difference that is not one. Shallow, because the
 * only nested value in any of the four schemas is an array, whose order is meaningful.
 */
function canonicalConfig(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

/** The stored token of a source, or `undefined` when nothing has written one yet. */
export function storedProbeToken(config: Record<string, unknown>): string | undefined {
  const value = config[PROBE_TOKEN_KEY];
  return typeof value === 'string' ? value : undefined;
}

/** Non-secret, type-specific settings stored in `document_sources.config`. */
export const LocalConfig = z.object({
  path: z.string().min(1).max(4096),
  extensions: Extensions.default([...DEFAULT_EXTENSIONS]),
  language: Language,
  version: Version,
  syncProbeToken: ProbeToken,
});
export const GitConfig = z.object({
  url: z.url().max(2048),
  branch: z.string().min(1).max(200).default('main'),
  subdir: z.string().max(1024).default(''),
  username: z.string().max(200).default(''),
  provider: z.enum(['auto', 'github', 'gitlab', 'bitbucket', 'gitea']).default('auto'),
  /** Last commit checked out; set by the driver. */
  lastCommit: z.string().max(64).optional(),
  extensions: Extensions.default([...DEFAULT_EXTENSIONS]),
  language: Language,
  version: Version,
  syncProbeToken: ProbeToken,
});
export const UploadConfig = z.object({
  extensions: Extensions.default(['md', 'mdx', 'txt']),
  language: Language,
  version: Version,
  syncProbeToken: ProbeToken,
});
export const NotionConfig = z.object({
  /** Page or database ids to start from; empty = everything shared with the integration. */
  rootIds: z.array(z.string().min(1).max(64)).max(50).default([]),
  extensions: Extensions.default(['md']),
  language: Language,
  version: Version,
  syncProbeToken: ProbeToken,
});

export const SourceConfigByType = { local: LocalConfig, git: GitConfig, upload: UploadConfig, notion: NotionConfig } as const;
export type LocalConfig = z.infer<typeof LocalConfig>;
export type GitConfig = z.infer<typeof GitConfig>;
export type UploadConfig = z.infer<typeof UploadConfig>;
export type NotionConfig = z.infer<typeof NotionConfig>;

export interface SourceView {
  id: string;
  projectId: string;
  type: SourceType;
  name: string;
  label: string;
  flavor: Flavor;
  config: Record<string, unknown>;
  hasSecret: boolean;
  /**
   * Git and Notion: the shared secret a delivery to this source is signed with. Editors only.
   *
   * **The same field for two provenances** ([ADR-0049](../../.ssot/ADR.md#adr-0049)). For git it is
   * the secret this product generated and the operator copies into the repository settings; for Notion
   * it is the `verification_token` Notion generated, which the operator has to copy **back** into
   * Notion's own modal — without which the subscription stays pending and nothing is ever delivered.
   * Showing it is therefore not a convenience there, it is the step that completes the flow.
   */
  webhookSecret: string | null;
  /** So a viewer's dashboard can say a webhook is configured without showing its secret. */
  hasWebhookSecret: boolean;
  /** Notion only: the open capture window, `null` when none is open ([ADR-0049](../../.ssot/ADR.md#adr-0049)). */
  webhookVerificationExpiresAt: Date | null;
  /** Notion only: a delivery waiting for the minimum inter-run interval, `null` when none is. */
  webhookDueAt: Date | null;
  /** Minutes between two webhook-triggered runs; `null` means the instance's `WEBHOOK_MIN_INTERVAL_MINUTES`. */
  webhookMinIntervalMinutes: number | null;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  documentCount: number;
  /** Minutes between scheduled considerations; `null` is off ([ADR-0048](../../.ssot/ADR.md#adr-0048)). */
  syncIntervalMinutes: number | null;
  /** When the scheduler will next consider it. `null` while it is off, or before the first tick. */
  nextSyncAt: Date | null;
  createdAt: Date;
}

/** The two source types whose deliveries are signed, whichever side generated the secret. */
const HAS_WEBHOOK = new Set<string>(['git', 'notion']);

export interface SourceViewOptions {
  /** A project viewer may read a source's settings but not the secret a push webhook signs with. */
  revealWebhookSecret?: boolean;
}

export function toSourceView(row: DocumentSourceRow, opts: SourceViewOptions = {}): SourceView {
  const reveal = opts.revealWebhookSecret ?? true;
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type as SourceType,
    name: row.name,
    label: row.label,
    flavor: row.flavor as Flavor,
    config: row.config,
    hasSecret: Boolean(row.secretEnc),
    webhookSecret: reveal && HAS_WEBHOOK.has(row.type) ? row.webhookSecret : null,
    hasWebhookSecret: HAS_WEBHOOK.has(row.type) && Boolean(row.webhookSecret),
    webhookVerificationExpiresAt: row.type === 'notion' ? row.webhookVerificationExpiresAt : null,
    webhookDueAt: row.type === 'notion' ? row.webhookDueAt : null,
    webhookMinIntervalMinutes: row.webhookMinIntervalMinutes,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    documentCount: row.documentCount,
    syncIntervalMinutes: row.syncIntervalMinutes,
    nextSyncAt: row.nextSyncAt,
    createdAt: row.createdAt,
  };
}

/** Parses (and fills defaults of) a source's config for its type. Throws ValidationError on bad input. */
export function parseSourceConfig<T extends SourceType>(type: T, raw: unknown): z.infer<(typeof SourceConfigByType)[T]> {
  const result = SourceConfigByType[type].safeParse(raw ?? {});
  if (!result.success) throw new ValidationError(`Invalid ${type} source settings: ${z.prettifyError(result.error)}`);
  return result.data as z.infer<(typeof SourceConfigByType)[T]>;
}

/**
 * The interval a client may set on a source: `null` switches scheduling off, and any other value has
 * to sit inside the band `config.ts` documents. Shared by the create and the update route so that
 * "off" means the same thing on both.
 */
export const SyncIntervalMinutes = z.number().int().min(SYNC_MIN_INTERVAL_MINUTES).max(SYNC_MAX_INTERVAL_MINUTES).nullable();

/**
 * The first `next_sync_at` of a source: **now plus a uniformly random fraction of one interval**
 * ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
 *
 * **The jitter is here, at the write, and nowhere near the tick.** A hundred sources created by one
 * import script land on a hundred different minutes, and every later advance adds a whole interval to
 * the moment the source was considered — so that spread is a property the population *keeps*, for as
 * long as the rows live. Jittering at the tick instead would re-randomise the herd into a fresh
 * collision every cycle: uniform in expectation, clumped in every actual hour.
 *
 * It is also why a source that has just been switched on does not fire immediately. That is
 * deliberate: switching ten sources on from the dashboard in one minute should not produce ten runs
 * in that minute, and the operator who wants one now has the "Sync now" button that has always been
 * there.
 */
export function firstSyncDueAt(intervalMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + Math.random() * intervalMinutes * 60_000);
}

export function slugifySourceName(input: string): string {
  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
  return PROJECT_NAME_RE.test(name) ? name : '';
}

export async function listSources(db: Db, projectId: string): Promise<DocumentSourceRow[]> {
  return db.select().from(documentSources).where(eq(documentSources.projectId, projectId)).orderBy(asc(documentSources.createdAt));
}

export async function listAllSources(db: Db): Promise<DocumentSourceRow[]> {
  return db.select().from(documentSources);
}

export async function getSource(db: Db, projectId: string, sourceId: string): Promise<DocumentSourceRow | undefined> {
  const [row] = await db
    .select()
    .from(documentSources)
    .where(and(eq(documentSources.projectId, projectId), eq(documentSources.id, sourceId)))
    .limit(1);
  return row;
}

/**
 * The source an agent named in `search_docs`' `source` filter ([ADR-0042](../../.ssot/ADR.md#adr-0042)).
 * By name, because the name is what every document path is prefixed with and therefore the only handle
 * a client has ever been shown; unique per project, by `document_sources_project_name_uq`.
 */
export async function getSourceByName(db: Db, projectId: string, name: string): Promise<DocumentSourceRow | undefined> {
  const [row] = await db
    .select()
    .from(documentSources)
    .where(and(eq(documentSources.projectId, projectId), eq(documentSources.name, name)))
    .limit(1);
  return row;
}

export async function getSourceById(db: Db, sourceId: string): Promise<DocumentSourceRow | undefined> {
  const [row] = await db.select().from(documentSources).where(eq(documentSources.id, sourceId)).limit(1);
  return row;
}

export interface CreateSourceInput {
  type: SourceType;
  name: string;
  label?: string;
  flavor?: Flavor;
  config?: unknown;
  /** Plain token; encrypted before it is stored. */
  secret?: string;
  /**
   * Minutes between scheduled syncs, `null` for none. The route defaults it to
   * `SYNC_DEFAULT_INTERVAL_MINUTES`; **undefined here means none**, so a caller that has never heard
   * of scheduling creates an unscheduled source rather than one that starts calling out.
   */
  syncIntervalMinutes?: number | null;
}

export interface SourceServiceOptions {
  allowedRoots: string[];
  secretKey: string | undefined;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** Validates type-specific settings (a local path must resolve inside ALLOWED_DOC_ROOTS). */
async function validateConfig(type: SourceType, config: unknown, opts: SourceServiceOptions): Promise<Record<string, unknown>> {
  const parsed = parseSourceConfig(type, config) as Record<string, unknown>;
  if (type === 'local') await resolveProjectRoot(String(parsed.path), opts.allowedRoots); // throws PathNotAllowedError
  if (type === 'git') {
    const subdir = String(parsed.subdir ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (subdir.split('/').some((s) => s === '..' || s === '.')) throw new ValidationError('subdir must not contain "." or ".." segments');
    parsed.subdir = subdir;
  }
  return parsed;
}

export async function createSource(db: Db, projectId: string, input: CreateSourceInput, opts: SourceServiceOptions): Promise<DocumentSourceRow> {
  if (!SOURCE_TYPES.includes(input.type)) throw new ValidationError(`Unknown source type "${String(input.type)}"`);
  const name = input.name.trim();
  if (!PROJECT_NAME_RE.test(name)) {
    throw new ValidationError('Source name must be 1-63 characters of lowercase letters, digits, "-" or "_", and start with a letter or digit');
  }
  const flavor = input.flavor ?? 'plain';
  if (!FLAVORS.includes(flavor)) throw new ValidationError(`Unknown flavor "${String(flavor)}"`);
  const config = await validateConfig(input.type, input.config, opts);
  checkExtensions(flavor, config);
  const secretEnc = input.secret ? encryptSecret(input.secret, opts.secretKey) : null;
  const webhookSecret = input.type === 'git' ? randomSecret() : null;
  try {
    const syncIntervalMinutes = input.syncIntervalMinutes ?? null;
    const [row] = await db
      .insert(documentSources)
      .values({
        projectId,
        type: input.type,
        name,
        label: input.label?.trim() ?? '',
        flavor,
        config,
        secretEnc,
        webhookSecret,
        syncIntervalMinutes,
        // Jittered from the moment of creation, so a scripted import spreads itself.
        nextSyncAt: syncIntervalMinutes === null ? null : firstSyncDueAt(syncIntervalMinutes),
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A source named "${name}" already exists in this project`);
    throw err;
  }
}

export interface UpdateSourceInput {
  label?: string;
  flavor?: Flavor;
  config?: unknown;
  /** New plain token; `null` removes the stored one. */
  secret?: string | null;
  /** Minutes between scheduled syncs; `null` switches scheduling off. Omitted leaves it alone. */
  syncIntervalMinutes?: number | null;
  /** Minutes between webhook-triggered runs; `null` returns the source to the instance default. */
  webhookMinIntervalMinutes?: number | null;
}

export async function updateSource(
  db: Db,
  projectId: string,
  sourceId: string,
  input: UpdateSourceInput,
  opts: SourceServiceOptions,
): Promise<DocumentSourceRow> {
  const existing = await getSource(db, projectId, sourceId);
  if (!existing) throw new NotFoundError('Source not found');
  const patch: Partial<typeof documentSources.$inferInsert> = {};
  if (input.label !== undefined) patch.label = input.label.trim();
  if (input.flavor !== undefined) {
    if (!FLAVORS.includes(input.flavor)) throw new ValidationError(`Unknown flavor "${String(input.flavor)}"`);
    patch.flavor = input.flavor;
  }
  if (input.config !== undefined) {
    // Keep driver-owned keys (e.g. git lastCommit) unless the user changed something that invalidates them.
    const merged = { ...existing.config, ...(input.config as Record<string, unknown>) };
    // **The probe token is not one of those keys, when anything else moved.** It describes the source
    // as it was configured a moment ago, and the point of an edit is that the source now means
    // something else — a different path, a different branch, a different set of file extensions.
    // Leaving it would let the scheduler answer "unchanged" about a question nobody is asking any
    // more ([ADR-0048](../../.ssot/ADR.md#adr-0048)). Stripping it here is also the reason a client
    // cannot write it: this is the only path that takes `config` from one.
    //
    // An edit that changed nothing keeps it, and that is not a nicety — the dashboard sends the whole
    // config on every save, so forgetting the token unconditionally would turn "Save changes" with
    // nothing changed into a re-sync of the source, and the route below reads exactly this comparison
    // to decide whether to queue a run at all.
    delete merged[PROBE_TOKEN_KEY];
    const nextConfig = await validateConfig(existing.type as SourceType, merged, opts);
    const previous = { ...existing.config };
    const token = previous[PROBE_TOKEN_KEY];
    delete previous[PROBE_TOKEN_KEY];
    if (token !== undefined && canonicalConfig(nextConfig) === canonicalConfig(previous)) nextConfig[PROBE_TOKEN_KEY] = token;
    patch.config = nextConfig;
  }
  const nextFlavor = (patch.flavor as Flavor | undefined) ?? (existing.flavor as Flavor);
  if (input.config !== undefined) {
    // The caller stated the extensions, so a value the new content type cannot read is a mistake to
    // name rather than one to quietly correct. Checked against the flavor this source will *have* once
    // the patch lands — the dashboard sends both in one save, and checking the stored one would refuse
    // the very edit that makes the extensions legal.
    checkExtensions(nextFlavor, patch.config as Record<string, unknown>);
  } else if (patch.flavor !== undefined) {
    // **A patch that moves only the content type may not be refused by a setting it did not send.**
    // Turning an `openapi` source back into a plain one would otherwise be impossible without also
    // re-sending its extensions, because the stored `.yaml` is legal under the old flavor and not the
    // new one. So the stored list is narrowed to what the new content type reads, which is what the
    // operator asked for by name; only a narrowing that leaves nothing is an error, because a source
    // that indexes no extension at all would silently index nothing.
    const stored = existing.config.extensions;
    if (Array.isArray(stored)) {
      const allowed = allowedExtensionsFor(nextFlavor);
      const kept = stored.filter((e) => allowed.includes(String(e)));
      if (kept.length === 0) {
        throw new ValidationError(
          `The "${nextFlavor}" content type reads none of this source's file types (${stored.map((e) => `.${String(e)}`).join(', ')}). ` +
            `Change the file types in the same request.`,
        );
      }
      if (kept.length !== stored.length) patch.config = { ...existing.config, extensions: kept };
    }
  }
  if (input.secret !== undefined) patch.secretEnc = input.secret ? encryptSecret(input.secret, opts.secretKey) : null;
  if (input.syncIntervalMinutes !== undefined && input.syncIntervalMinutes !== existing.syncIntervalMinutes) {
    patch.syncIntervalMinutes = input.syncIntervalMinutes;
    // Re-jittered rather than carried over: a source moved from daily to hourly would otherwise keep
    // a due time up to a day out, and one moved the other way would fire straight away. Off clears
    // the due time so that switching it back on is indistinguishable from creating it.
    patch.nextSyncAt = input.syncIntervalMinutes === null ? null : firstSyncDueAt(input.syncIntervalMinutes);
  }
  // No re-jitter and no claim to move: a debounce is a limit rather than a schedule, and the claim that
  // may be outstanding was computed from the last sync, which this does not touch.
  if (input.webhookMinIntervalMinutes !== undefined && input.webhookMinIntervalMinutes !== existing.webhookMinIntervalMinutes) {
    patch.webhookMinIntervalMinutes = input.webhookMinIntervalMinutes;
  }
  if (Object.keys(patch).length === 0) return existing;
  const [row] = await db.update(documentSources).set(patch).where(eq(documentSources.id, sourceId)).returning();
  return row;
}

export async function regenerateWebhookSecret(db: Db, projectId: string, sourceId: string): Promise<DocumentSourceRow> {
  const existing = await getSource(db, projectId, sourceId);
  if (!existing) throw new NotFoundError('Source not found');
  if (existing.type !== 'git') throw new ValidationError('Only git sources have a webhook secret');
  const [row] = await db.update(documentSources).set({ webhookSecret: randomSecret() }).where(eq(documentSources.id, sourceId)).returning();
  return row;
}

/** Deletes the row (documents/chunks cascade). The caller removes the materialised directory afterwards. */
export async function deleteSource(db: Db, projectId: string, sourceId: string): Promise<DocumentSourceRow> {
  const existing = await getSource(db, projectId, sourceId);
  if (!existing) throw new NotFoundError('Source not found');
  await db.delete(documentSources).where(eq(documentSources.id, sourceId));
  return existing;
}

export async function setSourceStatus(
  db: Db,
  sourceId: string,
  patch: { status: 'idle' | 'syncing' | 'error'; lastError?: string | null; lastSyncedAt?: Date; config?: Record<string, unknown> },
): Promise<void> {
  await db.update(documentSources).set(patch).where(eq(documentSources.id, sourceId));
}

/**
 * Drops the stored hashes of a source's documents so the next run re-chunks all of them. The indexer
 * decides what to skip from the hash of the file as it sits on disk, while the content type is applied
 * afterwards, on the way into the chunker — so without this a changed content type would reach no file.
 *
 * The same applies to `language` since [ADR-0041](../../.ssot/ADR.md#adr-0041): the text search
 * configuration is spent inside `replaceDocument`, on a document the run would otherwise have skipped
 * as unchanged.
 */
export async function invalidateSourceDocuments(db: Db, sourceId: string): Promise<void> {
  await db.update(documents).set({ contentHash: '' }).where(eq(documents.sourceId, sourceId));
}

/**
 * Refreshes `document_count` of every source of the project from the documents table, counting **one
 * generation** ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
 *
 * The generation is not optional and is not defaulted. While a rebuild is in flight a project holds
 * two generations of the same corpus, so a count over `source_id` alone is roughly double — and a
 * doubled number on the dashboard is the kind of wrong that reads as plausible.
 */
export async function recountSources(db: Db, projectId: string, generation: number): Promise<void> {
  await db.execute(sql`
    UPDATE document_sources s
    SET document_count = (SELECT count(*) FROM documents d WHERE d.source_id = s.id AND d.index_generation = ${generation})
    WHERE s.project_id = ${projectId}`);
}

/** Number of sources per project, for the project list. */
export async function countSourcesByProject(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ projectId: documentSources.projectId, n: sql<number>`count(*)::int` })
    .from(documentSources)
    .groupBy(documentSources.projectId);
  return new Map(rows.map((r) => [r.projectId, r.n]));
}
