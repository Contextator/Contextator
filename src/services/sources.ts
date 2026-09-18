import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PROJECT_NAME_RE } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, documentSources, type DocumentSourceRow } from '../db/schema.js';
import { encryptSecret, randomSecret } from './crypto.js';
import { FLAVORS, type Flavor } from './flavors.js';
import { DEFAULT_EXTENSIONS, SUPPORTED_EXTENSIONS, resolveProjectRoot } from './fs-scan.js';
import { ConflictError, NotFoundError, ValidationError } from './projects.js';
import { TEXT_SEARCH_CONFIGS } from './text-search.js';

export const SOURCE_TYPES = ['local', 'git', 'upload', 'notion'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const Extensions = z.array(z.enum(SUPPORTED_EXTENSIONS)).min(1);

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

/** Non-secret, type-specific settings stored in `document_sources.config`. */
export const LocalConfig = z.object({
  path: z.string().min(1).max(4096),
  extensions: Extensions.default([...DEFAULT_EXTENSIONS]),
  language: Language,
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
});
export const UploadConfig = z.object({
  extensions: Extensions.default(['md', 'mdx', 'txt']),
  language: Language,
});
export const NotionConfig = z.object({
  /** Page or database ids to start from; empty = everything shared with the integration. */
  rootIds: z.array(z.string().min(1).max(64)).max(50).default([]),
  extensions: Extensions.default(['md']),
  language: Language,
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
  /** Git only: shared secret the provider signs webhook deliveries with. Editors only. */
  webhookSecret: string | null;
  /** So a viewer's dashboard can say a webhook is configured without showing its secret. */
  hasWebhookSecret: boolean;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  documentCount: number;
  createdAt: Date;
}

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
    webhookSecret: reveal && row.type === 'git' ? row.webhookSecret : null,
    hasWebhookSecret: row.type === 'git' && Boolean(row.webhookSecret),
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    documentCount: row.documentCount,
    createdAt: row.createdAt,
  };
}

/** Parses (and fills defaults of) a source's config for its type. Throws ValidationError on bad input. */
export function parseSourceConfig<T extends SourceType>(type: T, raw: unknown): z.infer<(typeof SourceConfigByType)[T]> {
  const result = SourceConfigByType[type].safeParse(raw ?? {});
  if (!result.success) throw new ValidationError(`Invalid ${type} source settings: ${z.prettifyError(result.error)}`);
  return result.data as z.infer<(typeof SourceConfigByType)[T]>;
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
  const secretEnc = input.secret ? encryptSecret(input.secret, opts.secretKey) : null;
  const webhookSecret = input.type === 'git' ? randomSecret() : null;
  try {
    const [row] = await db
      .insert(documentSources)
      .values({ projectId, type: input.type, name, label: input.label?.trim() ?? '', flavor, config, secretEnc, webhookSecret })
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
    patch.config = await validateConfig(existing.type as SourceType, merged, opts);
  }
  if (input.secret !== undefined) patch.secretEnc = input.secret ? encryptSecret(input.secret, opts.secretKey) : null;
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
