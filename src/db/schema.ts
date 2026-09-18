import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * The Drizzle schema, and — since [ADR-0033](../../.ssot/ADR.md#adr-0033) — the only description of the
 * tables there is. `drizzle/*.sql` is generated from this file and applied at startup by
 * `src/db/bootstrap.ts`; nothing else creates a table.
 *
 * One documented way to add a column: edit this file, run `npm run db:generate`, read the SQL it
 * wrote, commit both. `npm run db:check` fails if the two ever stop agreeing.
 *
 * Every constraint that PostgreSQL would otherwise have named for us is named here explicitly, with
 * the names a `0.1.0` database already has (`documents_project_id_fkey`, `projects_name_key`,
 * `project_members_pkey`, …). An installation adopted into the migration journal keeps those names,
 * so a later migration that has to drop one by name means the same thing on a fresh install and on
 * an upgraded one.
 */

/**
 * The dimension that goes into *generated SQL*, and nowhere else.
 *
 * The real type of `chunks.embedding` is `vector(EMBEDDING_DIMENSIONS)` and is set once, by
 * `src/db/bootstrap.ts`, after the migrations have run. drizzle-kit diffs this file against its own
 * snapshot in `drizzle/meta` and never against the live database, so a deployment sitting at
 * `vector(1536)` is invisible to `generate`: no migration can ever be emitted that re-types this
 * column, and none can be emitted that assumes it is 384 either.
 *
 * Runtime is unaffected. Drizzle's `vector` mapper serialises a `number[]` to a string and never
 * looks at its length; the dimension is enforced by the column type in the database, as it always was.
 */
const MIGRATION_VECTOR_DIMENSIONS = 384;

/**
 * PostgreSQL's `tsvector`, which drizzle-kit has no column helper for
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). It is declared rather than generated on purpose: a
 * `GENERATED ALWAYS AS (to_tsvector('simple', …)) STORED` column would bake one text search
 * configuration into the table for every row of every project at once, and the configuration is the
 * one thing that has to be able to vary per source.
 *
 * `driverData: string` because nothing in this codebase ever reads the column back: it is written by
 * `replaceDocument` as a `to_tsvector(…)` expression and read only by `@@` inside the search
 * statement. A mapper that pretended to parse a `tsvector` into something would be a mapper nobody
 * calls and nobody maintains.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

export const projectStatus = pgEnum('project_status', ['idle', 'indexing', 'error']);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique('projects_name_key'),
    /** Legacy (pre-v3): now nullable and no longer read; the local source's config holds the path. */
    rootPath: text('root_path'),
    status: projectStatus('status').notNull().default('idle'),
    chunkCount: integer('chunk_count').notNull().default(0),
    documentCount: integer('document_count').notNull().default(0),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
    lastError: text('last_error'),
    embeddingModel: text('embedding_model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Who may talk to this project's MCP endpoint. `open` is the historical behaviour — anyone who can
     * reach the URL — and stays the default so an upgrade breaks no configured client.
     *
     * Last, after `created_at`, because v5 added it with an `ALTER TABLE … ADD COLUMN` and that is
     * where it physically sits in every database that has been through the ladder.
     */
    mcpAuth: text('mcp_auth').notNull().default('open').$type<McpAuthMode>(),
    /**
     * Which generation of `documents`/`chunks` is the published index of this project
     * ([ADR-0039](../../.ssot/ADR.md#adr-0039)). A rebuild writes generation `live_generation + 1`
     * beside the live one and this column is what makes the new one live, in a single-row update.
     *
     * `0` is the default and the value every pre-generation database already holds, so the backfill
     * is the default and nothing has to be rewritten.
     */
    liveGeneration: integer('live_generation').notNull().default(0),
  },
  (t) => [check('projects_mcp_auth_check', sql`${t.mcpAuth} in ('open', 'token')`)],
);

/**
 * Bearer tokens for one project's MCP endpoint. Like sessions, only the hash is stored; the token
 * itself is shown once, when it is minted.
 */
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    /** What it is for, in the operator's words: "Cursor on my laptop", "CI". */
    name: text('name').notNull().default(''),
    tokenHash: text('token_hash').notNull().unique('mcp_tokens_token_hash_key'),
    /** First few characters, so two tokens can be told apart in a list without storing either. */
    prefix: text('prefix').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: 'mcp_tokens_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'mcp_tokens_created_by_fkey', columns: [t.createdBy], foreignColumns: [users.id] }).onDelete('set null'),
    index('mcp_tokens_project_idx').on(t.projectId),
  ],
);

/**
 * A place a project's documents come from. Every document path is prefixed with the source `name`
 * (`<name>/<path inside the source>`), which is why the name is immutable.
 */
export const documentSources = pgTable(
  'document_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    /** `local` | `git` | `upload` | `notion` */
    type: text('type').notNull(),
    /** URL-safe slug, unique per project; the mount prefix of every document path. */
    name: text('name').notNull(),
    label: text('label').notNull().default(''),
    /** Type-specific, non-secret settings (see services/sources.ts). */
    config: jsonb('config').notNull().$type<Record<string, unknown>>().default({}),
    /** Encrypted token (services/crypto.ts); never returned by the API. */
    secretEnc: text('secret_enc'),
    webhookSecret: text('webhook_secret'),
    /** `plain` | `obsidian` | `notion-export` */
    flavor: text('flavor').notNull().default('plain'),
    /** `idle` | `syncing` | `error` */
    status: text('status').notNull().default('idle'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    documentCount: integer('document_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'document_sources_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    unique('document_sources_project_name_uq').on(t.projectId, t.name),
    index('document_sources_project_idx').on(t.projectId),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    sourceId: uuid('source_id'),
    /** Always posix-style, relative to the project root (e.g. `guides/install.md`). */
    relativePath: text('relative_path').notNull(),
    title: text('title').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    /**
     * The document's text, as `read_document` serves it ([ADR-0043](../../.ssot/ADR.md#adr-0043)).
     *
     * **The flavor-transformed string, not the raw bytes** — the exact text the indexer hands
     * `chunkMarkdown`, which is what `chunks.content` was cut from and what the vectors were built
     * from. Storing the raw file instead would make `read_document` and `search_docs` disagree about
     * what an Obsidian or Notion document says, which is the worse of the two failures.
     *
     * **Nullable, and that is the upgrade path**, as `chunks.content_tsv` is. Every document written
     * before this column existed holds NULL and keeps holding it until its file is re-indexed — an
     * incremental run skips a file whose sha256 has not moved, and unlike `content_tsv` this column is
     * *not* recoverable from anything already in the database. `read_document` falls back to the
     * filesystem while it is NULL and says so in the log.
     */
    content: text('content'),
    /** True when `content` holds only the first `MAX_STORED_DOCUMENT_BYTES` of the document. */
    contentTruncated: boolean('content_truncated').notNull().default(false),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The generation this row belongs to. Equal to the project's `live_generation` for everything a
     * reader may see; a rebuild in flight writes `live_generation + 1` and nothing reads it until the
     * swap ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
     */
    indexGeneration: integer('index_generation').notNull().default(0),
  },
  (t) => [
    foreignKey({ name: 'documents_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'documents_source_id_fkey', columns: [t.sourceId], foreignColumns: [documentSources.id] }).onDelete('cascade'),
    // A path is unique *within a generation*, not within a project: two generations of the same
    // corpus hold the same paths at once, which is the whole point. This replaces
    // `documents_project_path_uq` and is the upsert target of `replaceDocument`.
    unique('documents_project_generation_path_uq').on(t.projectId, t.indexGeneration, t.relativePath),
    index('documents_project_idx').on(t.projectId),
    index('documents_source_idx').on(t.sourceId),
    index('documents_project_generation_idx').on(t.projectId, t.indexGeneration),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    documentId: uuid('document_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    headingPath: text('heading_path').notNull().default(''),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: MIGRATION_VECTOR_DIMENSIONS }).notNull(),
    /**
     * The lexical half of retrieval ([ADR-0041](../../.ssot/ADR.md#adr-0041)):
     * `to_tsvector(<config>, heading_path || ' ' || content)`, written by `replaceDocument` in the
     * same statement as the row itself. The breadcrumb is in it because an identifier lives in a
     * heading (`### AUTH_COOKIE_SECURE`) as often as in prose, and the dense side already prepends it.
     *
     * **Nullable, and that is the upgrade path.** A database that has been through the migration holds
     * this column empty for every chunk written before it; `src/db/bootstrap.ts` fills it in batches at
     * the next start, and until it has, `content_tsv @@ query` is NULL for those rows, which is not
     * true, which keeps them out of the lexical candidate list and leaves them exactly where dense-only
     * retrieval had them. There is no state in which a half-filled column returns a wrong row.
     */
    contentTsv: tsvector('content_tsv'),
    /**
     * Denormalised from the owning document, deliberately ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
     * `searchChunks` has to apply the generation as a plain column predicate on this table with no
     * join, because that predicate is what pgvector's iterative scan will be given to work against.
     */
    indexGeneration: integer('index_generation').notNull().default(0),
  },
  // `chunks_embedding_hnsw_idx` is deliberately absent, and its absence is load-bearing. An HNSW index
  // needs a fixed dimension and blocks the `ALTER COLUMN … TYPE` that sets the real one, so the
  // bootstrap creates it afterwards. Declaring it here would put it in the snapshot, and the first
  // `db:generate` after that would emit a `DROP INDEX` for an index this file cannot describe.
  (t) => [
    foreignKey({ name: 'chunks_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'chunks_document_id_fkey', columns: [t.documentId], foreignColumns: [documents.id] }).onDelete('cascade'),
    index('chunks_project_idx').on(t.projectId),
    index('chunks_document_idx').on(t.documentId),
    // **An invariant that was always true and had never been said** ([ADR-0042](../../.ssot/ADR.md#adr-0042)).
    // `replaceDocument` deletes a document's chunks and rewrites them in one transaction, numbering
    // them from the chunker's own counter, so a document has never held two chunks at one index. Saying
    // it makes neighbour expansion — "chunk `i − 1` and `i + 1` of this document" — a point lookup with
    // one answer rather than a query that trusts the writer. A generation predicate is not needed
    // beside it: a document row belongs to exactly one generation, so its id already carries one.
    unique('chunks_document_chunk_index_uq').on(t.documentId, t.chunkIndex),
    index('chunks_project_generation_idx').on(t.projectId, t.indexGeneration),
    // Unlike `chunks_embedding_hnsw_idx` above, this one *is* declared here and *is* generated. A GIN
    // index over a `tsvector` needs no fixed dimension and blocks no `ALTER COLUMN … TYPE`, so none of
    // the reasons that keep the HNSW index in the bootstrap apply to it.
    index('chunks_content_tsv_idx').using('gin', t.contentTsv),
  ],
);

/** One row per finished (or failed) index run; the indexer keeps the most recent ones per project. */
export const indexRuns = pgTable(
  'index_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    /** `incremental` or `force`. */
    mode: text('mode').notNull(),
    /** `done` or `error`. */
    status: text('status').notNull(),
    filesTotal: integer('files_total').notNull().default(0),
    filesSkipped: integer('files_skipped').notNull().default(0),
    filesUpdated: integer('files_updated').notNull().default(0),
    filesRemoved: integer('files_removed').notNull().default(0),
    chunksWritten: integer('chunks_written').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    /**
     * The generation this run wrote into, when it wrote into one of its own — a rebuild's, whether it
     * went live or was abandoned. NULL for an incremental run, which writes into whatever generation
     * was already live, and for every run recorded before [ADR-0039](../../.ssot/ADR.md#adr-0039).
     * With it, "which run produced the index being served" is a join and not an investigation.
     */
    generation: integer('generation'),
  },
  (t) => [
    foreignKey({ name: 'index_runs_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    // Descending on `started_at`: the query this serves is "the most recent runs of this project".
    // `nullsFirst()` is not decoration — it is PostgreSQL's own default for a DESC column, and
    // drizzle-kit writes `DESC NULLS LAST` unless it is said. Without it a fresh install would get an
    // index one word different from the one every existing database has.
    index('index_runs_project_idx').on(t.projectId, t.startedAt.desc().nullsFirst()),
  ],
);

/** Dashboard accounts. `root` and `admin` reach every project; a `member` only its memberships. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Login identifier, lowercased by the service layer. There is no mail transport, so it is not an e-mail. */
    username: text('username').notNull().unique('users_username_key'),
    /** Optional contact detail only; nothing is ever sent to it. */
    email: text('email'),
    displayName: text('display_name').notNull().default(''),
    /** `root` | `admin` | `member`, enforced by `users_role_check` below. */
    role: text('role').notNull().default('member').$type<UserRole>(),
    /** services/passwords.ts wire format; never returned by the API. */
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // A CHECK rather than an enum, so the set of roles can move with a DROP/ADD CONSTRAINT in one
  // migration instead of the pain of `ALTER TYPE`.
  (t) => [
    foreignKey({ name: 'users_created_by_fkey', columns: [t.createdBy], foreignColumns: [t.id] }).onDelete('set null'),
    check('users_role_check', sql`${t.role} in ('root', 'admin', 'member')`),
  ],
);

/** One row per signed-in browser. Only the hash of the cookie's token is stored. */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique('user_sessions_token_hash_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Idle expiry is measured from here against AUTH_SESSION_IDLE_MS, so the TTL stays a live setting. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip'),
  },
  (t) => [
    foreignKey({ name: 'user_sessions_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    index('user_sessions_user_idx').on(t.userId),
    index('user_sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Which member account reaches which project, and how far. */
export const projectMembers = pgTable(
  'project_members',
  {
    userId: uuid('user_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** `viewer` | `editor`, enforced by `project_members_role_check` below. */
    role: text('role').notNull().$type<ProjectMemberRole>(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // PK order is (user_id, project_id): the hot queries are "this account's projects" and the point
  // lookup, both served by that index. The reverse direction gets its own.
  (t) => [
    foreignKey({ name: 'project_members_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    foreignKey({ name: 'project_members_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'project_members_created_by_fkey', columns: [t.createdBy], foreignColumns: [users.id] }).onDelete('set null'),
    primaryKey({ name: 'project_members_pkey', columns: [t.userId, t.projectId] }),
    check('project_members_role_check', sql`${t.role} in ('viewer', 'editor')`),
    index('project_members_project_idx').on(t.projectId),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRole = 'root' | 'admin' | 'member';
export type McpAuthMode = 'open' | 'token';
export type ProjectMemberRole = 'viewer' | 'editor';

export type UserRow = typeof users.$inferSelect;
export type UserSessionRow = typeof userSessions.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type McpTokenRow = typeof mcpTokens.$inferSelect;
export type DocumentSourceRow = typeof documentSources.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ChunkInsert = typeof chunks.$inferInsert;
export type IndexRunRow = typeof indexRuns.$inferSelect;
export type IndexRunInsert = typeof indexRuns.$inferInsert;
