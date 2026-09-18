import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'documents_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'documents_source_id_fkey', columns: [t.sourceId], foreignColumns: [documentSources.id] }).onDelete('cascade'),
    unique('documents_project_path_uq').on(t.projectId, t.relativePath),
    index('documents_project_idx').on(t.projectId),
    index('documents_source_idx').on(t.sourceId),
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
