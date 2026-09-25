import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  doublePrecision,
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
// Type-only, and the only import this file makes beyond drizzle itself: `TextSearchConfig` is the
// closed set `chunks.text_search_config` may hold, and a column typed `string` would let a caller
// write a configuration name no server has. `services/text-search.ts` imports nothing, so there is
// no cycle and nothing of it survives compilation.
import type { TextSearchConfig } from '../services/text-search.js';

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

/**
 * What `projects.mcp_auth` is when nobody says ([ADR-0065](../../.ssot/ADR.md#adr-0065)).
 *
 * A constant rather than a literal in the column, because three readers have to agree on it and only
 * one of them is this file: the generated migration carries it into every database, the creation path
 * in `src/services/projects.ts` mints a first token when it is `token`, and the tests assert the value
 * a project is born with. Moving it here moves all three.
 *
 * **It is the birth value and nothing else.** No migration and no code path rewrites an existing row:
 * a project already configured `open` stays `open` through the upgrade, because the clients configured
 * against it are configured against that answer.
 */
export const DEFAULT_MCP_AUTH: McpAuthMode = 'token';

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
     * reach the URL — and it stays one of the three values an operator can choose.
     *
     * Since [ADR-0054](../../.ssot/ADR.md#adr-0054) there is a third value, `account`: the caller has
     * to present a credential that names a **user**, and that user's membership of this project is
     * what decides. `token` still accepts a static `ctxm_…` bearer, which is the credential every CLI
     * install in the field is configured with.
     *
     * The **default** is `token` since [ADR-0065](../../.ssot/ADR.md#adr-0065) — see `DEFAULT_MCP_AUTH`
     * below, which is the one place it is written and the one place a migration reads it from.
     *
     * Last, after `created_at`, because v5 added it with an `ALTER TABLE … ADD COLUMN` and that is
     * where it physically sits in every database that has been through the ladder.
     */
    mcpAuth: text('mcp_auth').notNull().default(DEFAULT_MCP_AUTH).$type<McpAuthMode>(),
    /**
     * Which generation of `documents`/`chunks` is the published index of this project
     * ([ADR-0039](../../.ssot/ADR.md#adr-0039)). A rebuild writes generation `live_generation + 1`
     * beside the live one and this column is what makes the new one live, in a single-row update.
     *
     * `0` is the default and the value every pre-generation database already holds, so the backfill
     * is the default and nothing has to be rewritten.
     */
    liveGeneration: integer('live_generation').notNull().default(0),
    /**
     * Whether searches of this project are recorded in `search_queries`
     * ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
     *
     * **A column rather than a setting, because the decision belongs to the project and not to the
     * process.** A `pg_dump` carries it, a project export will carry it, and an instance restored onto
     * another machine keeps whatever each project's operator decided — where an environment variable
     * would silently revert to the new host's default. `SEARCH_QUERY_LOG=0` is the instance-wide kill
     * switch and overrules this in the only direction that is safe: off.
     *
     * `true` is the default, and it is the default because a log of what agents asked is worth nothing
     * until there are weeks of rows behind it — a switch somebody has to find and turn on collects
     * nothing during exactly the period the first report would be drawn from. What makes that
     * defensible is the other half of the design: `SEARCH_QUERY_LOG_RETENTION_DAYS` forgets on its own
     * after thirty days, and the privacy page says so.
     */
    queryLogEnabled: boolean('query_log_enabled').notNull().default(true),
    /**
     * This project's relevance floor, overriding `SEARCH_SCORE_FLOOR` for this project only
     * ([ADR-0083](../../.ssot/ADR.md#adr-0083); the refusal rule is [ADR-0042](../../.ssot/ADR.md#adr-0042)'s).
     *
     * **`null` is the default and means "the instance's floor"**, so a project nobody has touched
     * behaves exactly as it did before the column existed. The floor is a cosine similarity measured on
     * one corpus shape; on encyclopaedic prose the same number refuses up to one answerable question in
     * eight (eval/BASELINE.md, "The relevance floor across corpus shapes"), and the operator who knows
     * the corpus is the one to lower it. A column for the reason `query_log_enabled` is one: the decision
     * belongs to the project, and a `pg_dump` carries it. `0` switches the floor off for this project.
     */
    scoreFloor: doublePrecision('score_floor'),
  },
  (t) => [
    check('projects_mcp_auth_check', sql`${t.mcpAuth} in ('open', 'token', 'account')`),
    check('projects_score_floor_check', sql`${t.scoreFloor} is null or (${t.scoreFloor} >= 0 and ${t.scoreFloor} <= 1)`),
  ],
);

/**
 * OAuth clients this instance has met ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
 *
 * A row is written by RFC 7591 dynamic client registration, which is how a browser-based MCP
 * connector introduces itself: it has no way of being configured here in advance, and the MCP
 * authorization specification names DCR as the mechanism. **The row confers nothing.** It is a name
 * and a set of redirect URIs; every grant it can ever hold comes from a person signing in and
 * approving it, and what that grant reaches is decided by *their* membership on every request.
 *
 * There is no `client_secret` column because there is no confidential client: a connector that runs
 * in a browser cannot hold one, so every client here is public and authenticates with PKCE instead.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    /** The `client_id` itself, `ctxc_` + 16 random bytes in hex. Public by definition, so it is the key. */
    clientId: text('client_id').primaryKey(),
    /** `client_name` from the registration request, shown on the consent page. Display only. */
    name: text('name').notNull().default(''),
    /**
     * The exact redirect URIs registered, compared as whole strings on every authorize request.
     * A prefix or wildcard match here is the classic open-redirect in this flow.
     */
    redirectUris: jsonb('redirect_uris').notNull().$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Written at most once a minute, like a token's: what the stale-client sweep reads. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('oauth_clients_last_used_idx').on(t.lastUsedAt)],
);

/**
 * Credentials for one project's MCP endpoint. Like sessions, only the hash is stored; the token
 * itself is shown once, when it is minted.
 *
 * Since [ADR-0054](../../.ssot/ADR.md#adr-0054) the table holds three kinds of credential rather than
 * one, and the reason they share a table rather than getting two more is `search_queries.mcp_token_id`
 * ([ADR-0047](../../.ssot/ADR.md#adr-0047)): the query log points here, so a search made through an
 * OAuth session is attributable by the column that already exists instead of by a second one that
 * would have to be added, backfilled and then read in both places by every report.
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
    /**
     * `static` · `access` · `refresh` (CHECK). `static` is every row that existed before this column
     * did and every token the dashboard's *New token* button mints; the other two are the pair an
     * OAuth exchange issues.
     *
     * The default is `static` **and it is the default so the migration writes nothing**: a backfill
     * that had to decide what each existing row is would be a backfill with an opinion.
     */
    kind: text('kind').notNull().default('static').$type<McpTokenKind>(),
    /**
     * The account this credential acts as, or NULL for one that acts as nobody
     * ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
     *
     * **Every existing token arrives NULL and keeps exactly the access it had**, which is what makes
     * this migration safe to apply to an installation whose agents are configured and working. A
     * migration that quietly attached every token to the account that happened to mint it would have
     * changed what those tokens reach, on an upgrade nobody asked for — NFR-10's rule one door along.
     *
     * CASCADE and not SET NULL: a credential whose owner is deleted must stop working, not quietly
     * become an anonymous one with the run of the project.
     */
    userId: uuid('user_id'),
    /** The client an OAuth credential was issued to; NULL for a static token. */
    clientId: text('client_id'),
    /** When this credential stops being accepted. NULL — never — is what a static token carries. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: 'mcp_tokens_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'mcp_tokens_created_by_fkey', columns: [t.createdBy], foreignColumns: [users.id] }).onDelete('set null'),
    foreignKey({ name: 'mcp_tokens_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    foreignKey({ name: 'mcp_tokens_client_id_fkey', columns: [t.clientId], foreignColumns: [oauthClients.clientId] }).onDelete('cascade'),
    check('mcp_tokens_kind_check', sql`${t.kind} in ('static', 'access', 'refresh')`),
    index('mcp_tokens_project_idx').on(t.projectId),
    // "This account's MCP credentials", which is what revoking a person's access has to be able to ask.
    index('mcp_tokens_user_idx').on(t.userId),
    // The expiry sweep, and nothing else: partial, so it is empty on an installation using no OAuth.
    index('mcp_tokens_expires_idx').on(t.expiresAt).where(sql`expires_at is not null`),
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
    /**
     * Encrypted under `SECRET_KEY` when the instance has one (ADR-0075), registered in
     * `services/encrypted-fields.ts`; never returned by the API. Rows written before ADR-0075 may still
     * hold the plaintext, which `crypto.decryptWebhookSecret` reads as is and the `rotate-secret` pass seals.
     */
    webhookSecret: text('webhook_secret'),
    /** `plain` | `obsidian` | `notion-export` */
    flavor: text('flavor').notNull().default('plain'),
    /** `idle` | `syncing` | `error` */
    status: text('status').notNull().default('idle'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    documentCount: integer('document_count').notNull().default(0),
    /**
     * How often the scheduler considers this source, in minutes — **NULL means never**
     * ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
     *
     * A column and not a `config` key, unlike the probe token beside it, because the question the
     * scheduler asks every minute is "which sources are due", and that has to be a `WHERE` rather than
     * a read of every source's jsonb. Every source that existed before this column was added carries
     * NULL, so an upgrade starts no outbound traffic nobody asked for (NFR-10); a newly created source
     * is given `SYNC_DEFAULT_INTERVAL_MINUTES`.
     */
    syncIntervalMinutes: integer('sync_interval_minutes'),
    /**
     * When the scheduler should next consider this source. NULL means "as soon as it is looked at",
     * which is what a source whose interval was just switched on would hold for a moment.
     *
     * **The jitter lives in the value, not in the tick.** It is first written as
     * `now() + random() × interval`, so a hundred sources created by one script are spread uniformly
     * across one interval and *stay* spread; afterwards it advances by a whole interval from the
     * moment the source was considered. It advances whether or not anything was enqueued, which is the
     * entire reason a run that outlives its own interval cannot turn the tick into a probe loop.
     */
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    /**
     * The open Notion webhook verification window ([ADR-0049](../../.ssot/ADR.md#adr-0049)): while this
     * is in the future, a `verification_token` POSTed to the source's webhook URL is stored as
     * `webhook_secret`. NULL or in the past means the token is refused and **nothing is written**.
     *
     * It is cleared by the statement that stores the token, which is what makes the window one-shot,
     * and it is a column rather than a `config` key because `updateSource` validates `config` against
     * the type's schema and strips what that schema does not name — an unrelated "Save changes" would
     * otherwise delete the window at the exact moment the operator is using it.
     */
    webhookVerificationExpiresAt: timestamp('webhook_verification_expires_at', { withTimezone: true }),
    /**
     * A **claim** left by a webhook delivery that arrived inside the source's minimum inter-run
     * interval: the earliest moment a run may happen for it.
     *
     * Every delivery in the same window computes the same value from `last_synced_at` and that
     * minimum, so a burst of two hundred is two hundred idempotent updates and one run. The tick
     * clears it whenever the source is considered — invariant 19's reason, one column along — and a row
     * taken because of a claim is enqueued **without being probed**, since the Notion probe reads the
     * newest `last_edited_time` and a deletion moves nobody's.
     */
    webhookDueAt: timestamp('webhook_due_at', { withTimezone: true }),
    /**
     * Minutes between two webhook-triggered runs of this source. **NULL means the instance's
     * `WEBHOOK_MIN_INTERVAL_MINUTES`**, read live — not "never", which is what NULL means one column
     * up in `sync_interval_minutes`. The asymmetry is deliberate: an interval is a schedule somebody
     * chose per source, a debounce is a limit the instance imposes.
     */
    webhookMinIntervalMinutes: integer('webhook_min_interval_minutes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'document_sources_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    unique('document_sources_project_name_uq').on(t.projectId, t.name),
    index('document_sources_project_idx').on(t.projectId),
    // The scheduler's own query, and the only one it runs per tick: the sources that are switched on
    // and due, oldest first. Partial on `sync_interval_minutes IS NOT NULL` because an instance that
    // schedules nothing — every source of an upgraded installation — then carries an empty index.
    index('document_sources_due_idx').on(t.nextSyncAt.asc().nullsFirst()).where(sql`sync_interval_minutes is not null`),
    // The other half of that query since [ADR-0049](../../.ssot/ADR.md#adr-0049): a source a delivery
    // claimed is due whether or not it is scheduled at all. Partial for the same reason — on an
    // installation with no Notion webhook it matches nothing and costs a catalogue row.
    index('document_sources_webhook_due_idx').on(t.webhookDueAt).where(sql`webhook_due_at is not null`),
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
    /**
     * Which release of the documentation this document is ([ADR-0058](../../.ssot/ADR.md#adr-0058)) —
     * the source's `config.version`, stamped here when the document was indexed.
     *
     * **It is an opaque label and never an ordering.** `v3`, `2024.1`, `next` and `legacy` are all
     * things a documentation team writes, and no parser is right about all four; the filter is
     * equality and there is deliberately no "latest". Empty string is "unversioned", which is what
     * every document written before this column existed holds and what a source with no version set
     * writes — so an absent filter is the search this product has always run.
     *
     * **Not `index_generation`, and the two must not be confused** ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
     * A generation is instance-local bookkeeping: it changes on every rebuild, means nothing outside
     * this database, and is never a thing an agent names. A version is the content's own label, chosen
     * by an operator, stable across rebuilds, and the only one of the two an agent ever sees.
     *
     * Denormalised off `document_sources.config` on purpose: the filter is resolved against
     * `documents` inside the search statement, and a join to the source table there would put a
     * second relation between pgvector and the predicate the two candidate lists depend on.
     */
    version: text('version').notNull().default(''),
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
     * **Which configuration the `tsvector` beside this one was built with**
     * ([ADR-0064](../../.ssot/ADR.md#adr-0064)). A `tsvector` does not carry that, and a query parsed
     * in another configuration silently matches none of it — so before this column existed the only
     * way to keep the two sides agreeing was for the whole instance to speak one configuration, which
     * is what ADR-0041 did and what kept Turkish sources out of the lexical half entirely.
     *
     * With it, the search statement asks the project which configurations it actually holds and
     * builds one `@@` per configuration, so a project whose German source is stemmed and whose
     * reference manual is `simple` gets both halves of its own index rather than whichever one the
     * instance was set to.
     *
     * **`NOT NULL DEFAULT 'simple'`, and that is the upgrade path**, as `content_tsv` was: the column
     * is catalogue-only to add, every existing row reads `simple`, and `reconcileTextSearchConfigs`
     * in `src/db/bootstrap.ts` moves the rows of a source that names a language to that language at
     * the next start — rewriting `content_tsv` with them, since the two must describe each other and
     * only one of them can be read back.
     *
     * Denormalised off the source for `version`'s reason, two tables up: it is resolved inside the
     * search statement, and a join to `document_sources` there would put a second relation between
     * pgvector and the predicate both candidate lists depend on.
     */
    textSearchConfig: text('text_search_config').notNull().default('simple').$type<TextSearchConfig>(),
    /**
     * Denormalised from the owning document, deliberately ([ADR-0039](../../.ssot/ADR.md#adr-0039)).
     * `searchChunks` has to apply the generation as a plain column predicate on this table with no
     * join, because that predicate is what pgvector's iterative scan will be given to work against.
     */
    indexGeneration: integer('index_generation').notNull().default(0),
  },
  // The vector indexes — one partial HNSW index per project, `src/db/vector-indexes.ts` — are
  // deliberately absent, and their absence is load-bearing. An HNSW index needs a fixed dimension and
  // blocks the `ALTER COLUMN … TYPE` that sets the real one, so the bootstrap creates them afterwards.
  // Declaring one here would put it in the snapshot, and the first `db:generate` after that would emit
  // a `DROP INDEX` for an index this file cannot describe.
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
    // **Three columns since [ADR-0064](../../.ssot/ADR.md#adr-0064), and the third one is free.** The
    // first two are the predicate every search already carries; the search's `corpus` CTE has always
    // counted this project's chunks through this index, and with `text_search_config` on the end that
    // same index-only scan also yields which configurations the project holds and how many chunks
    // each of them has — which is what the per-configuration commonness threshold is computed from.
    // Nothing that used the two-column prefix changes: a leading-column lookup does not care what
    // follows it.
    index('chunks_project_generation_idx').on(t.projectId, t.indexGeneration, t.textSearchConfig),
    // Unlike the vector indexes above, this one *is* declared here and *is* generated. A GIN
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
    /**
     * What asked for this run: `manual` (a person, a route, a source that was just edited), `webhook`
     * (a push from a git provider) or `scheduled` (the timer of
     * [ADR-0048](../../.ssot/ADR.md#adr-0048)). NULL for every run recorded before that entry, exactly
     * as `generation` above is NULL for every run recorded before [ADR-0039](../../.ssot/ADR.md#adr-0039).
     *
     * It is also the lane the run was queued in: `scheduled` drains only when nothing interactive is
     * waiting, so "did a person wait behind the timer" is answerable from this column and
     * `started_at` rather than from the application log.
     */
    trigger: text('trigger'),
  },
  (t) => [
    foreignKey({ name: 'index_runs_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    // Descending on `started_at`: the query this serves is "the most recent runs of this project".
    // `nullsFirst()` is not decoration — it is PostgreSQL's own default for a DESC column, and
    // drizzle-kit writes `DESC NULLS LAST` unless it is said. Without it a fresh install would get an
    // index one word different from the one every existing database has.
    index('index_runs_project_idx').on(t.projectId, t.startedAt.desc().nullsFirst()),
    // NULL passes an `IN` check, which is what lets the rows recorded before the column existed stay.
    check('index_runs_trigger_check', sql`${t.trigger} in ('manual', 'webhook', 'scheduled')`),
  ],
);

/**
 * What agents asked, and what they got back ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
 *
 * One row per search that actually ran — through the MCP tool or through the dashboard's search panel.
 * The five outcomes that never reached the index (an unknown source, a project with nothing in it, a
 * model mismatch) are configuration states rather than questions, and they are not rows here.
 *
 * **It is written off the response path.** `services/query-log.ts` buffers rows in memory and drops
 * them rather than letting them back up: a search that failed because the log was busy would be a
 * worse product than one that lost a log row.
 *
 * **User content lives here.** `query` is whatever somebody typed, in the clear, because the entire
 * purpose is reading "what are people asking" back out of it — a hash cannot be read. It is therefore
 * in every `pg_dump` ([ADR-0046](../../.ssot/ADR.md#adr-0046)), readable by every viewer of the
 * project, and swept by `SEARCH_QUERY_LOG_RETENTION_DAYS`.
 */
export const searchQueries = pgTable(
  'search_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** `mcp` — an agent through `search_docs` — or `dashboard`, an operator through the search panel. */
    actor: text('actor').notNull().$type<QueryActor>(),
    /**
     * Which of the project's MCP tokens the session presented, when it presented one; NULL for an
     * `open` project and for every dashboard search.
     *
     * **`ON DELETE SET NULL`, not cascade.** A token is revoked rather than deleted today, but a
     * project that rotates tokens for years will eventually delete one, and a foreign key that took
     * the log with it would erase the history of exactly the agent somebody is investigating.
     */
    mcpTokenId: uuid('mcp_token_id'),
    /** What was typed, verbatim and bounded by the tool's own 2 000-character limit. */
    query: text('query').notNull(),
    /**
     * The same question, folded so two spellings of it group together: NFKC, lowercased, whitespace
     * collapsed. It is a *grouping* key and not an identity — "how many agents asked this" is the
     * question the whole table exists for, and `GROUP BY query` over raw text answers it wrongly.
     */
    queryNorm: text('query_norm').notNull(),
    /** How many excerpts were asked for. `limit` is a reserved word, hence the column name. */
    resultLimit: integer('result_limit').notNull(),
    /** The `source` filter, as it was given; NULL when the search was over the whole project. */
    filterSource: text('filter_source'),
    /** The `path_prefix` filter, normalised as the search normalised it; NULL when there was none. */
    filterPathPrefix: text('filter_path_prefix'),
    /**
     * The `version` filter ([ADR-0058](../../.ssot/ADR.md#adr-0058)); NULL when the search was over
     * every version. Beside the other two rather than left out: the three together are what decides
     * which corpus a question was asked of, and a log that recorded two of them would describe a
     * search nobody ran.
     */
    filterVersion: text('filter_version'),
    /** How many excerpts came back — 0 is a real and interesting answer. */
    hitCount: integer('hit_count').notNull().default(0),
    /** The best cosine similarity of the answer, or NULL when nothing came back at all. */
    topScore: doublePrecision('top_score'),
    /** Whether the agent was told "no good match" instead of being handed these hits (ADR-0042). */
    belowFloor: boolean('below_floor').notNull().default(false),
    /**
     * The relevance floor `below_floor` was decided against — the project's own or the server's, `0`
     * when it was off. NULL on rows logged before the floor was recorded. Without it a window that
     * spans a change of floor reads every refusal as the current floor's; with it the summary scopes
     * to one floor the way it scopes to one model.
     */
    scoreFloor: doublePrecision('score_floor'),
    /** Wall clock of the whole search, embedding included. */
    durationMs: integer('duration_ms').notNull().default(0),
    /**
     * The provider-qualified id of the encoder that answered this question, and the generation it
     * answered from — **the part of this table that is easy to leave out and expensive to add later.**
     *
     * [ROADMAP.md](../../.ssot/ROADMAP.md) Item 6's own observation is that "a log recorded across a
     * retrieval rewrite compares two different systems". These two columns turn that from a caveat into
     * a predicate: analysis can be scoped to one retrieval configuration instead of averaging across a
     * model change. This repository changed its model mid-phase ([ADR-0037](../../.ssot/ADR.md#adr-0037)),
     * so that is not hypothetical.
     */
    embeddingModel: text('embedding_model').notNull(),
    liveGeneration: integer('live_generation').notNull().default(0),
  },
  (t) => [
    foreignKey({ name: 'search_queries_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'search_queries_mcp_token_id_fkey', columns: [t.mcpTokenId], foreignColumns: [mcpTokens.id] }).onDelete('set null'),
    check('search_queries_actor_check', sql`${t.actor} in ('mcp', 'dashboard')`),
    // "The most recent queries of this project", and the per-project row cap's own cut-off lookup.
    // `nullsFirst()` for `index_runs`' reason: it is PostgreSQL's default for a DESC column, and
    // leaving it unsaid makes drizzle-kit write `DESC NULLS LAST` instead.
    index('search_queries_project_created_idx').on(t.projectId, t.createdAt.desc().nullsFirst()),
    // The retention sweep is instance-wide — one `created_at` predicate over every project — so it
    // cannot use the composite above.
    index('search_queries_created_idx').on(t.createdAt),
    // The question the table exists to answer: "asked 41 times this week, best match 0.31".
    index('search_queries_project_norm_idx').on(t.projectId, t.queryNorm),
  ],
);

/**
 * What one logged search returned, one row per excerpt, in the order the agent saw them
 * ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
 *
 * **It stores the path, not a `document_id`**, and that is the load-bearing decision. Documents are
 * generation-scoped and [ADR-0039](../../.ssot/ADR.md#adr-0039)'s sweeper deletes the ones a rebuild
 * superseded, so a foreign key to `documents` would erase the log every time somebody re-indexed —
 * taking with it the only record of what the previous index answered, which is precisely what a
 * before-and-after comparison needs.
 */
export const searchQueryHits = pgTable(
  'search_query_hits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryId: uuid('query_id').notNull(),
    /** 1-based position in the answer the caller received. */
    rank: integer('rank').notNull(),
    /** `<source>/<path inside the source>`, as `search_docs` printed it and `read_document` takes it. */
    relativePath: text('relative_path').notNull(),
    headingPath: text('heading_path').notNull().default(''),
    chunkIndex: integer('chunk_index').notNull(),
    /** The cosine similarity shown beside the excerpt. */
    score: doublePrecision('score').notNull(),
  },
  (t) => [
    foreignKey({ name: 'search_query_hits_query_id_fkey', columns: [t.queryId], foreignColumns: [searchQueries.id] }).onDelete('cascade'),
    // Also the index for "the hits of this query": a unique constraint is an index, and `query_id`
    // leads it, so a separate one would be the same b-tree twice.
    unique('search_query_hits_query_rank_uq').on(t.queryId, t.rank),
    index('search_query_hits_path_idx').on(t.relativePath),
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
    /**
     * When `revokeMcpCredentialsOfUser` last ran for this account — unlink, a password change, an
     * administrator's reset. `POST /oauth/token` refuses an authorization code issued at or before it,
     * because a code is an MCP credential that is not a row yet and so the revoke cannot reach it.
     * NULL until the first revoke.
     */
    mcpCredentialsRevokedAt: timestamp('mcp_credentials_revoked_at', { withTimezone: true }),
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
    // How this session was opened ([ADR-0077](../../.ssot/ADR.md#adr-0077)). `findSessionUser` reads
    // this alongside the role on every request: a session opened over SSO is refused the moment the
    // role it resolves to is `root`, no matter when — before or after this row was created — the
    // promotion happened. Additive, defaults every existing row to `password`, which is what every
    // session predating this column actually was.
    authMethod: text('auth_method').notNull().default('password').$type<SessionAuthMethod>(),
  },
  (t) => [
    foreignKey({ name: 'user_sessions_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    index('user_sessions_user_idx').on(t.userId),
    index('user_sessions_expires_idx').on(t.expiresAt),
    check('user_sessions_auth_method_check', sql`${t.authMethod} in ('password', 'sso')`),
  ],
);

/**
 * Admin API credentials scoped to an account ([ADR-0076](../../.ssot/ADR.md#adr-0076)). Unlike
 * `ADMIN_TOKEN`, every row here is an identity: it belongs to a user, carries its own name and
 * scope, and can be revoked without touching any other credential.
 *
 * Only the hash is stored, like every other bearer credential in this schema; the token itself is
 * shown once, when it is minted (ADR-0017's pattern).
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The account this token acts as. Its access can never exceed this account's own, live access. */
    userId: uuid('user_id').notNull(),
    /** What it is for, in the operator's words: "CI reindex", "staging bot". */
    name: text('name').notNull().default(''),
    tokenHash: text('token_hash').notNull().unique('api_tokens_token_hash_key'),
    /** First few characters, so two tokens can be told apart in a list without storing either. */
    prefix: text('prefix').notNull(),
    /**
     * A subset of the routes `src/auth/policy.ts` already recognizes, each written the same way
     * `audit_events.action` is: `<METHOD> <route template>`. Not a new permission vocabulary — this
     * column can only narrow what the owning account may already do, never widen it.
     */
    scope: jsonb('scope').notNull().$type<string[]>(),
    /** Restricts the token to one project; NULL reaches every project the owner already reaches. */
    projectId: uuid('project_id'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: 'api_tokens_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    // CASCADE, not SET NULL: a token restricted to a deleted project must stop working, not quietly
    // widen into one that reaches every project the owner has — the same reasoning `mcp_tokens` uses.
    foreignKey({ name: 'api_tokens_project_id_fkey', columns: [t.projectId], foreignColumns: [projects.id] }).onDelete('cascade'),
    foreignKey({ name: 'api_tokens_created_by_fkey', columns: [t.createdBy], foreignColumns: [users.id] }).onDelete('set null'),
    index('api_tokens_user_idx').on(t.userId),
    index('api_tokens_expires_idx').on(t.expiresAt).where(sql`expires_at is not null`),
  ],
);

/**
 * Which account a federated (OIDC) identity signs in as ([ADR-0077](../../.ssot/ADR.md#adr-0077)).
 *
 * The unique key is `(issuer, subject)`, not `(provider, subject)`: `issuer` is the value the token
 * itself is signed over and the thing two different provider *labels* could otherwise collide on,
 * where `provider` is only the operator's display name for the same issuer. There is deliberately no
 * `email` column here — this table is never consulted by email, only by the provider's own subject
 * claim, so a provider-side email change or a second account sharing an address cannot repoint a
 * sign-in at the wrong local account.
 */
export const userFederatedIdentities = pgTable(
  'user_federated_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** The configured OIDC provider's short name (OIDC_BUTTON_LABEL is display-only; this is not it). */
    provider: text('provider').notNull(),
    /** The provider's issuer URL, exactly as discovery returned it — what `(issuer, subject)` keys on. */
    issuer: text('issuer').notNull(),
    /** The `sub` claim: stable, provider-scoped, never reused across accounts by the provider's own contract. */
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: 'user_federated_identities_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
    unique('user_federated_identities_issuer_subject_key').on(t.issuer, t.subject),
    index('user_federated_identities_user_idx').on(t.userId),
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

/**
 * Who changed this instance, and what they changed ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
 *
 * One row per state-changing admin request that succeeded, written by the policy layer that already
 * resolved the actor — `src/auth/plugin.ts`, from the table in `src/auth/policy.ts`. Nothing else
 * writes here, and no route opts in: a call added per route is as complete as the route somebody
 * forgot to add it to.
 *
 * **It records what was done, never what was read.** There is no query text, no document body and no
 * excerpt in any column — `detail` can only ever hold values from a closed set named in the policy
 * table. That is what keeps this table out of the query log's privacy regime: `search_queries` is
 * what an agent asked, held for thirty days because it is user content; this is what an operator did,
 * held for a year because it is accountability. They are deliberately not one table.
 *
 * **Append-only.** Nothing in the product updates or deletes a row except the retention sweep, and
 * the actor columns are shaped so a row cannot be orphaned into anonymity: `actor_label` is the
 * username copied at the time, so deleting the account leaves the deed attributed.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * `<METHOD> <route template>`, e.g. `DELETE /api/projects/:id/sources/:sid`.
     *
     * The route template is the identity of the action, and it is deliberately not a prettier dotted
     * name from a lookup table: a name that has to be assigned is a name the next route will not
     * have, and this column would then say nothing about exactly the route somebody forgot. It is
     * also the same key space `src/auth/policy.ts` already states every permission in.
     */
    action: text('action').notNull(),
    /**
     * `user` — a dashboard account — `token`, which is `ADMIN_TOKEN` and has no account row, or
     * `api_token`, an [ADR-0076](../../.ssot/ADR.md#adr-0076) credential that does.
     */
    actorKind: text('actor_kind').notNull().$type<AuditActorKind>(),
    /**
     * The account that acted, when one did. `ON DELETE SET NULL` rather than cascade: deleting a
     * person must not delete the record of what they did — that is the one deletion an audit log
     * exists to survive — and `actor_label` beside it is what keeps the row attributed afterwards.
     */
    actorUserId: uuid('actor_user_id'),
    /**
     * The username as it was at the time, or `ADMIN_TOKEN`. **This is the column that makes "no row
     * without an actor" true**: it is NOT NULL and constrained non-empty, so there is no way to write
     * an anonymous event, and it still names the actor after the account is gone or renamed.
     */
    actorLabel: text('actor_label').notNull(),
    /**
     * The address the request appeared to come from — **a hint beside the actor, never the actor.**
     *
     * What `req.ip` is worth here is `TRUST_PROXY`'s answer ([ADR-0060](../../.ssot/ADR.md#adr-0060)):
     * the socket's own peer address by default, the left-most `X-Forwarded-For` — which the client
     * writes — on an instance set to `1`, and the forwarded address vouched for by a named proxy when
     * it is set to one. It is recorded because it is useful next to an identity that was established
     * properly, and it is named as a known limit in `SECURITY.md` rather than presented as evidence.
     */
    actorIp: text('actor_ip'),
    /**
     * The project the action was scoped to, for a project route; NULL otherwise.
     *
     * **No foreign key, on purpose.** Deleting a project is itself one of the events recorded here, so
     * a key to `projects` would either refuse the row or erase it — the same reasoning that keeps
     * `search_query_hits` on a path rather than a `document_id`.
     */
    projectId: uuid('project_id'),
    /**
     * What was acted on, when the route names one: the route template's own parameter name
     * (`sid`, `tokenId`, `userId`, …) and the value it carried. Derived from the path and never from
     * the body, which is what keeps a credential or a document out of this table by construction.
     */
    targetType: text('target_type'),
    targetId: text('target_id'),
    /**
     * The handful of body fields the policy table lets an action record, each restricted to a closed
     * set of values — `{"mode":"account"}` for the MCP access switch. A field that is not named there,
     * or a value outside its set, is dropped rather than stored, so free text cannot reach this column.
     * One field comes from the actor rather than the body: an `api_token` row carries `tokenId`, the
     * id of the token that acted ([ADR-0076](../../.ssot/ADR.md#adr-0076)), which its label alone
     * cannot tell apart from another token of the same name.
     */
    detail: jsonb('detail').notNull().default({}),
    /** The status the request answered with. Only successes are written, so this is 2xx by contract. */
    statusCode: integer('status_code').notNull(),
  },
  (t) => [
    foreignKey({ name: 'audit_events_actor_user_id_fkey', columns: [t.actorUserId], foreignColumns: [users.id] }).onDelete('set null'),
    check('audit_events_actor_kind_check', sql`${t.actorKind} in ('user', 'token', 'api_token')`),
    // The two halves of "no row without an actor", stated in the database so that a future writer
    // — a backfill, a panel, a migration — cannot produce an anonymous event either.
    check('audit_events_actor_label_check', sql`length(btrim(${t.actorLabel})) > 0`),
    // `ADMIN_TOKEN` is not an account, so it must not carry one; a `user` or `api_token` event may
    // end up with NULL here once the account is deleted, which is what the `SET NULL` above is for.
    check('audit_events_actor_user_check', sql`${t.actorKind} in ('user', 'api_token') or ${t.actorUserId} is null`),
    // The retention sweep is instance-wide — one `created_at` predicate over every row.
    index('audit_events_created_idx').on(t.createdAt),
    // "What happened on this project", and "what did this account do", which are the two questions a
    // panel over this table asks. `nullsFirst()` for `index_runs`' reason: it is PostgreSQL's own
    // default for a DESC column, and leaving it unsaid makes drizzle-kit write `DESC NULLS LAST`.
    index('audit_events_project_created_idx').on(t.projectId, t.createdAt.desc().nullsFirst()),
    index('audit_events_actor_created_idx').on(t.actorUserId, t.createdAt.desc().nullsFirst()),
    // The two the *panel* asks on, which are not the two above ([ADR-0055](../../.ssot/ADR.md#adr-0055),
    // FR-451). `audit_events_actor_created_idx` is keyed on `actor_user_id`, and the panel filters on
    // `actor_label` — it has to, because the label is the column that outlives the account being
    // deleted, which is half of what the panel exists to show. And "what kind of act was this" had no
    // index at all. Both are `(column, created_at DESC)` rather than the column alone, so one index
    // serves the filter and the `(created_at, id)` ordering every page is read in.
    index('audit_events_actor_label_created_idx').on(t.actorLabel, t.createdAt.desc().nullsFirst()),
    index('audit_events_action_created_idx').on(t.action, t.createdAt.desc().nullsFirst()),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRole = 'root' | 'admin' | 'member';
/** Who asked a logged question ([ADR-0047](../../.ssot/ADR.md#adr-0047)). */
export type QueryActor = 'mcp' | 'dashboard';
/**
 * How a project's MCP endpoint decides ([ADR-0027](../../.ssot/ADR.md#adr-0027),
 * [ADR-0054](../../.ssot/ADR.md#adr-0054)): nothing, a bearer credential of any sort, or a credential
 * that names an account whose membership then decides.
 */
export type McpAuthMode = 'open' | 'token' | 'account';
/** Which of the three credentials an `mcp_tokens` row is ([ADR-0054](../../.ssot/ADR.md#adr-0054)). */
export type McpTokenKind = 'static' | 'access' | 'refresh';
/**
 * Who an audit event belongs to ([ADR-0055](../../.ssot/ADR.md#adr-0055)): a dashboard account,
 * `ADMIN_TOKEN` — machine access that is a credential rather than a person, and says so — or
 * `api_token`, an [ADR-0076](../../.ssot/ADR.md#adr-0076) credential that names the account it acts
 * as and the token itself in its label.
 */
export type AuditActorKind = 'user' | 'token' | 'api_token';
export type ProjectMemberRole = 'viewer' | 'editor';
/** How a `user_sessions` row was opened — a password sign-in, or an OIDC provider. */
export type SessionAuthMethod = 'password' | 'sso';

export type UserRow = typeof users.$inferSelect;
export type UserSessionRow = typeof userSessions.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type McpTokenRow = typeof mcpTokens.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type UserFederatedIdentityRow = typeof userFederatedIdentities.$inferSelect;
export type OauthClientRow = typeof oauthClients.$inferSelect;
export type DocumentSourceRow = typeof documentSources.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ChunkInsert = typeof chunks.$inferInsert;
export type IndexRunRow = typeof indexRuns.$inferSelect;
export type IndexRunInsert = typeof indexRuns.$inferInsert;
export type SearchQueryRow = typeof searchQueries.$inferSelect;
export type SearchQueryInsert = typeof searchQueries.$inferInsert;
export type SearchQueryHitRow = typeof searchQueryHits.$inferSelect;
export type SearchQueryHitInsert = typeof searchQueryHits.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AuditEventInsert = typeof auditEvents.$inferInsert;
