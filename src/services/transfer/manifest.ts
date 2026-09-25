import { z } from 'zod';

/**
 * The manifest of a project export, and the refusals that are decided from it
 * ([ADR-0051](../../../.ssot/ADR.md#adr-0051)).
 *
 * **This is the first artefact this product asks another installation to read**, so it is versioned
 * before it has ever needed to change: `manifestVersion` is the format's own number, independent of
 * the product version beside it, and an importer that meets a number it does not know says so instead
 * of guessing at the fields. A format with no version is a format that cannot be changed.
 *
 * It is the **first entry in the tarball**, which is what makes the refusals below cheap: an import
 * reads the manifest before it reads a byte of data, and a model mismatch costs one small read rather
 * than a corpus's worth of it.
 *
 * Nothing in this file touches a database, a filesystem or a tar stream; it is the part of the feature
 * that is a decision rather than a mechanism, and it is a unit test.
 */

/** The manifest formats this build can read. Bumped when a field changes meaning, not when one is added. */
export const MANIFEST_VERSION = 1;

/** What the tarball claims to be. A file that does not say this is not one of ours, whatever its name. */
export const MANIFEST_KIND = 'contextator.project-export';

/** The entry an import reads first, and the name an operator will look for inside the tarball. */
export const MANIFEST_ENTRY = 'manifest.json';
/** One JSON object per line: a source, redacted (see `exportedSource`). */
export const SOURCES_ENTRY = 'sources.ndjson';
/** One JSON object per line: a document and its chunks, in document order. */
export const DOCUMENTS_ENTRY = 'documents.ndjson';
/** The prose half of the manifest, for the operator who opens the tarball rather than the importer. */
export const README_ENTRY = 'README.txt';
/** Upload sources' materialised trees, keyed by source **name** — see `dataPrefixFor`. */
export const DATA_PREFIX = 'data/sources';

/** Where an upload source's files sit inside the tarball. The name, not the id: an id is instance-local. */
export const dataPrefixFor = (sourceName: string): string => `${DATA_PREFIX}/${sourceName}`;

/**
 * What a source will need on the other side, computed at export time so that the export *says it*
 * rather than leaving the destination operator to find out on the first failed sync.
 *
 * - `credential` — the source stored an encrypted token, and the token did not travel ([ADR-0017](../../../.ssot/ADR.md#adr-0017)).
 * - `webhook-secret` — the source had a webhook secret, and it did not travel either. For git it is the
 *   secret sitting in a repository's settings pointing at the **source** instance; for Notion it is the
 *   `verification_token` bound to the source instance's subscription ([ADR-0049](../../../.ssot/ADR.md#adr-0049)).
 *   Both let their holder forge deliveries against an instance that did not move.
 * - `files-carried` — an `upload` source, whose `current/` tree is the only copy of its content
 *   anywhere and is therefore inside this tarball.
 * - `path-on-this-host` — a `local` source, pointing at a directory of the machine the export came from.
 * - `never-scheduled` — the source arrives with no sync interval, whatever it had at home.
 */
export const SOURCE_NEEDS = ['credential', 'webhook-secret', 'files-carried', 'path-on-this-host', 'never-scheduled'] as const;
export type SourceNeed = (typeof SOURCE_NEEDS)[number];

/**
 * The embedding configuration the vectors in this tarball were produced by.
 *
 * `null` only for a project that has never been indexed and therefore carries no vectors: there is then
 * nothing for a mismatch to be a mismatch *with*, and refusing such an import would refuse the one case
 * where moving a project is unambiguously safe.
 */
const Embedding = z.object({
  /** The provider-qualified id as stamped on `projects.embedding_model` (ADR-0038 builds it). */
  id: z.string().min(1).max(500),
  dimensions: z.number().int().min(1).max(2000),
});

export const Manifest = z.object({
  kind: z.literal(MANIFEST_KIND),
  manifestVersion: z.number().int().min(1),
  createdAt: z.string().min(1).max(64),
  product: z.object({ name: z.string().max(200), version: z.string().max(200) }),
  /**
   * How far the source instance's schema had come: the value `settings.schema_version` holds and the
   * number of rows in its migration journal ([ADR-0033](../../../.ssot/ADR.md#adr-0033)). It is a
   * *refusal* input in one direction only — see `checkManifest`.
   */
  schema: z.object({ version: z.string().max(64), migrations: z.number().int().min(0) }),
  /** Provenance, not identity: the instance id the source minted for itself, and its base URL when it has one. */
  instance: z.object({ id: z.string().max(200), publicBaseUrl: z.string().max(2048).nullable() }),
  embedding: Embedding.nullable(),
  project: z.object({
    name: z.string().min(1).max(63),
    /**
     * The generation this export was taken from, on the instance it was taken from
     * ([ADR-0039](../../../.ssot/ADR.md#adr-0039)). It is recorded and **not** carried: generation
     * numbers are instance-local and load-bearing in every search predicate, so the import writes 0.
     */
    exportedGeneration: z.number().int().min(0),
    /**
     * The access mode travels ([ADR-0051](../../../.ssot/ADR.md#adr-0051), FR-354), so a project that
     * was closed at home arrives closed. `account` joined the set in
     * [ADR-0054](../../../.ssot/ADR.md#adr-0054) and `manifestVersion` deliberately did **not** move
     * with it: this is a value added to a field, not a field that changed meaning, and bumping the
     * format would have made every new export unreadable by builds that could have read all of it but
     * one enum. What it costs is that a `0.1`-era importer meeting an `account` export refuses it as
     * unreadable — which is the right answer from a build that has no such mode to put it in.
     */
    mcpAuth: z.enum(['open', 'token', 'account']),
    queryLogEnabled: z.boolean(),
    /**
     * The project's own relevance floor, or null for "the server's default". It travels for the reason
     * `mcpAuth` and `queryLogEnabled` do — it is a decision about this project, not about the instance —
     * and an importer applies it under **its own** `SEARCH_SCORE_FLOOR`, whose `0` still turns it off.
     * Optional, and `manifestVersion` did not move, for the reason given on `mcpAuth`: an export taken
     * before the column existed reads as "the server's default", which is what that project ran, and
     * an older importer ignores the key rather than refusing the file.
     */
    scoreFloor: z.number().min(0).max(1).nullable().optional(),
    lastIndexedAt: z.string().nullable(),
  }),
  counts: z.object({
    sources: z.number().int().min(0),
    documents: z.number().int().min(0),
    chunks: z.number().int().min(0),
    uploadFiles: z.number().int().min(0),
    uploadBytes: z.number().int().min(0),
  }),
  /**
   * What the source instance held and this file deliberately does not, so that the absence is a
   * statement rather than a silence. Every number here is a count of rows that stayed behind.
   */
  excluded: z.object({
    searchQueries: z.number().int().min(0),
    searchQueryHits: z.number().int().min(0),
    mcpTokens: z.number().int().min(0),
    indexRuns: z.number().int().min(0),
    /**
     * Memberships, **by role and by count only**. A username list is an inventory of accounts on an
     * instance that did not move, in a file that travels by e-mail; the count is what the destination
     * operator needs — "this project had four people who could see it and now has none" — and the
     * source operator already knows the names.
     */
    projectMembers: z.object({ viewer: z.number().int().min(0), editor: z.number().int().min(0) }),
  }),
  sources: z.array(
    z.object({
      name: z.string().min(1).max(64),
      /**
       * `confluence` joined the set in [ADR-0059](../../../.ssot/ADR.md#adr-0059) and `web` in
       * [ADR-0070](../../../.ssot/ADR.md#adr-0070), and `manifestVersion` deliberately did **not** move
       * with either — the same decision, for the same reason, that `account` got above. This is a value added to a field, not a field that changed
       * meaning, and bumping the format would make every new export unreadable by builds that could
       * have read all of it but one enum member.
       *
       * What it costs is written down rather than discovered: a build from before such an entry,
       * meeting an export that holds a source of a type it has never heard of, refuses the **whole
       * import** with a raw zod message
       * naming this field. That is a blunt refusal and it is the right one — such a build has no
       * driver to put the source in — and the property that matters is that it refuses rather than
       * importing something it does not understand. Nothing is silently dropped and nothing lands
       * half-configured.
       */
      type: z.enum(['local', 'git', 'upload', 'notion', 'confluence', 'web']),
      needs: z.array(z.enum(SOURCE_NEEDS)),
    }),
  ),
});
export type Manifest = z.infer<typeof Manifest>;

/** A refusal an operator can act on: what was expected, what arrived, and what to do about it. */
export class ImportRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportRefusedError';
    this.code = code;
  }
}

export interface DestinationFacts {
  /** `provider.id` of the instance being imported into. */
  embeddingId: string;
  embeddingDimensions: number;
  /** Rows in this instance's migration journal. */
  migrations: number;
}

/**
 * Every reason an import stops before it has written anything.
 *
 * **The model check is the one this feature exists around.** An embedding is comparable only to
 * embeddings from the same model at the same dimension; an import that quietly accepted a mismatch
 * would land a project that searches and answers nonsense, which is the worst failure shape this
 * product has. So it is refused, loudly, naming both ids — and re-embedding on import stays a feature
 * somebody can argue for later rather than a silent fallback nobody asked for.
 *
 * **The schema check runs in one direction.** A tarball from an instance that has applied *more*
 * migrations than this one may name columns this build has never heard of, so it is refused. A tarball
 * from an *older* instance is accepted: every column added since has a default, which is the property
 * [ADR-0033](../../../.ssot/ADR.md#adr-0033)'s ladder is built on, and refusing it would make the
 * export useless for the one direction operators actually move in — off an old instance onto a new one.
 */
export function checkManifest(manifest: Manifest, destination: DestinationFacts): void {
  if (manifest.manifestVersion > MANIFEST_VERSION) {
    throw new ImportRefusedError(
      'manifest_too_new',
      `This export is in manifest format ${manifest.manifestVersion} and this Contextator reads up to ${MANIFEST_VERSION}. ` +
        'It was produced by a newer version; upgrade this instance and import it again.',
    );
  }
  if (manifest.schema.migrations > destination.migrations) {
    throw new ImportRefusedError(
      'schema_too_new',
      `This export came from a database ${manifest.schema.migrations} migrations in, and this one is at ${destination.migrations}. ` +
        'Upgrade this instance to at least the version the export was taken from, and import it again.',
    );
  }
  if (manifest.embedding === null) return;
  if (manifest.embedding.id !== destination.embeddingId) {
    throw new ImportRefusedError(
      'model_mismatch',
      `This project was indexed with "${manifest.embedding.id}" and this instance embeds with "${destination.embeddingId}". ` +
        'Its vectors are only comparable to vectors from the same model, so importing it here would produce a project that ' +
        'searches and answers nonsense. Point this instance at the same model, or re-index the project after importing it ' +
        'into an instance that runs one.',
    );
  }
  if (manifest.embedding.dimensions !== destination.embeddingDimensions) {
    throw new ImportRefusedError(
      'dimension_mismatch',
      `This project's vectors are ${manifest.embedding.dimensions}-dimensional and this instance stores ` +
        `${destination.embeddingDimensions}-dimensional ones. The column would refuse them and the search would be meaningless if it did not.`,
    );
  }
}

/**
 * The prose the tarball carries beside the manifest, for the person who untars it rather than the code
 * that reads it.
 *
 * It exists because the roadmap's requirement is that the **export** says which of its sources will
 * need what on the other side, and a JSON field says that to a program. This says it to a reader, from
 * the same data, so the two cannot drift.
 */
export function readmeFor(manifest: Manifest): string {
  const lines: string[] = [
    `Contextator project export — "${manifest.project.name}"`,
    `Taken ${manifest.createdAt} from ${manifest.instance.publicBaseUrl ?? `instance ${manifest.instance.id}`}`,
    `by ${manifest.product.name} ${manifest.product.version}, manifest format ${manifest.manifestVersion}.`,
    '',
    `It carries ${manifest.counts.documents} documents and ${manifest.counts.chunks} chunks, with their vectors, from ` +
      `generation ${manifest.project.exportedGeneration} of that instance. The generation number does not travel: it is ` +
      'local to the instance that produced it, and the import renumbers this corpus to 0.',
    '',
    manifest.embedding
      ? `The vectors were produced by "${manifest.embedding.id}" at ${manifest.embedding.dimensions} dimensions. An instance ` +
        'running any other model will refuse this file rather than accept vectors it cannot compare.'
      : 'This project has never been indexed, so it carries no vectors and any instance can accept it.',
    '',
    'What did NOT travel, and will not:',
    `  - source credentials (${manifest.sources.filter((s) => s.needs.includes('credential')).length} source(s) had one). They are ` +
      'encrypted under a key belonging to the instance that made this file.',
    `  - webhook secrets (${manifest.sources.filter((s) => s.needs.includes('webhook-secret')).length} source(s) had one). Both kinds ` +
      'of them authenticate deliveries to the instance that did not move; a copy would let whoever holds this file forge those.',
    `  - ${manifest.excluded.searchQueries} logged searches and ${manifest.excluded.searchQueryHits} of their results. They are what ` +
      'people typed, held under a retention window this file would escape.',
    `  - ${manifest.excluded.mcpTokens} MCP token(s). They are bearer credentials for the other instance's endpoints. Mint new ones here.`,
    `  - ${manifest.excluded.indexRuns} index run record(s). They describe runs on another machine, numbered in its generations.`,
    `  - ${manifest.excluded.projectMembers.viewer} viewer and ${manifest.excluded.projectMembers.editor} editor membership(s). They name ` +
      'accounts that do not exist here. The project arrives reachable by root and admin only; add members after importing.',
    '',
    'Its sources, and what each needs here:',
  ];
  for (const source of manifest.sources) {
    lines.push(`  - ${source.name} (${source.type}): ${describeNeeds(source.needs, source.type)}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const NEED_TEXT: Record<SourceNeed, string> = {
  credential: 're-enter its access token before syncing',
  'webhook-secret': 'generate a new webhook secret here and paste it into the provider',
  'files-carried': 'nothing — its files are in this tarball, because they exist nowhere else',
  'path-on-this-host': 'check that its directory exists on this machine and is inside ALLOWED_DOC_ROOTS',
  'never-scheduled': 'set a sync interval if you want one; it arrives unscheduled',
};

/**
 * A Notion source's webhook secret is not one this instance mints: it is the `verification_token`
 * Notion delivers into a verification window the operator opens ([ADR-0049](../../../.ssot/ADR.md#adr-0049)),
 * and "generate a new webhook secret" is an action the dashboard refuses for anything but git.
 */
const NOTION_WEBHOOK_TEXT = 'point the Notion subscription at this instance, open a fresh verification window here and re-verify from Notion';

/** The source's type decides only the webhook line; every other need reads the same for all of them. */
export function describeNeeds(needs: readonly SourceNeed[], sourceType?: string): string {
  if (needs.length === 0) return 'nothing';
  return needs.map((need) => (need === 'webhook-secret' && sourceType === 'notion' ? NOTION_WEBHOOK_TEXT : NEED_TEXT[need])).join('; ');
}
