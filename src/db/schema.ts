import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid, vector } from 'drizzle-orm/pg-core';
import { embeddingDimensionsFromEnv } from '../config.js';

/**
 * Drizzle schema. Keep column-for-column in sync with the DDL in ensure-schema.ts,
 * which is what actually creates the tables at startup.
 */

export const projectStatus = pgEnum('project_status', ['idle', 'indexing', 'error']);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Legacy (pre-v3): now nullable and no longer read; the local source's config holds the path. */
  rootPath: text('root_path'),
  status: projectStatus('status').notNull().default('idle'),
  chunkCount: integer('chunk_count').notNull().default(0),
  documentCount: integer('document_count').notNull().default(0),
  lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
  lastError: text('last_error'),
  embeddingModel: text('embedding_model'),
  /**
   * Who may talk to this project's MCP endpoint. `open` is the historical behaviour — anyone who can
   * reach the URL — and stays the default so an upgrade breaks no configured client.
   */
  mcpAuth: text('mcp_auth').notNull().default('open').$type<McpAuthMode>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Bearer tokens for one project's MCP endpoint. Like sessions, only the hash is stored; the token
 * itself is shown once, when it is minted.
 */
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** What it is for, in the operator's words: "Cursor on my laptop", "CI". */
    name: text('name').notNull().default(''),
    tokenHash: text('token_hash').notNull().unique(),
    /** First few characters, so two tokens can be told apart in a list without storing either. */
    prefix: text('prefix').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('mcp_tokens_project_idx').on(t.projectId)],
);

/**
 * A place a project's documents come from. Every document path is prefixed with the source `name`
 * (`<name>/<path inside the source>`), which is why the name is immutable.
 */
export const documentSources = pgTable(
  'document_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
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
  (t) => [unique('document_sources_project_name_uq').on(t.projectId, t.name), index('document_sources_project_idx').on(t.projectId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => documentSources.id, { onDelete: 'cascade' }),
    /** Always posix-style, relative to the project root (e.g. `guides/install.md`). */
    relativePath: text('relative_path').notNull(),
    title: text('title').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('documents_project_path_uq').on(t.projectId, t.relativePath), index('documents_project_idx').on(t.projectId)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    headingPath: text('heading_path').notNull().default(''),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: embeddingDimensionsFromEnv() }).notNull(),
  },
  (t) => [
    index('chunks_project_idx').on(t.projectId),
    index('chunks_document_idx').on(t.documentId),
    index('chunks_embedding_hnsw_idx')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

/** One row per finished (or failed) index run; the indexer keeps the most recent ones per project. */
export const indexRuns = pgTable(
  'index_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
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
  (t) => [index('index_runs_project_idx').on(t.projectId, t.startedAt)],
);

/** Dashboard accounts. `root` and `admin` reach every project; a `member` only its memberships. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Login identifier, lowercased by the service layer. There is no mail transport, so it is not an e-mail. */
  username: text('username').notNull().unique(),
  /** Optional contact detail only; nothing is ever sent to it. */
  email: text('email'),
  displayName: text('display_name').notNull().default(''),
  /** `root` | `admin` | `member` (CHECK constraint lives in ensure-schema.ts). */
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
});

/** One row per signed-in browser. Only the hash of the cookie's token is stored. */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Idle expiry is measured from here against AUTH_SESSION_IDLE_MS, so the TTL stays a live setting. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip'),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId), index('user_sessions_expires_idx').on(t.expiresAt)],
);

/** Which member account reaches which project, and how far. */
export const projectMembers = pgTable(
  'project_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** `viewer` | `editor` (CHECK constraint lives in ensure-schema.ts). */
    role: text('role').notNull().$type<ProjectMemberRole>(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] }), index('project_members_project_idx').on(t.projectId)],
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
