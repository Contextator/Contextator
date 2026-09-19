import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

import { loadConfig } from '../../../src/config.js';
import type { AppContext } from '../../../src/context.js';
import type { Db } from '../../../src/db/client.js';
import { documentSources, projects, type ProjectRow } from '../../../src/db/schema.js';
import { adminRoutes } from '../../../src/admin/routes.js';
import { oauthRoutes } from '../../../src/mcp/oauth-routes.js';
import { mcpRoutes } from '../../../src/mcp/router.js';
import { SessionRegistry } from '../../../src/mcp/sessions.js';
import { SlidingWindow } from '../../../src/services/rate-limit.js';
import { chunkMarkdown, embeddingText, estimateTokens } from '../../../src/services/chunker.js';
import type { EmbeddingProvider } from '../../../src/services/embeddings/provider.js';
import { replaceDocument, storedDocumentContent, type NewChunk } from '../../../src/services/vector-store.js';
import { silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './postgres.js';

/**
 * A real Contextator MCP endpoint on a real port, for the two suites that have to drive a real MCP
 * client at it ([ADR-0054](../../../.ssot/ADR.md#adr-0054)).
 *
 * It listens rather than being `inject`ed, and that is the whole reason this file exists: the SDK's
 * Streamable HTTP transport and its OAuth client both speak `fetch`, and a test that reached past them
 * into the handlers would prove the code runs without proving the protocol works.
 */

const DIMS = TEST_EMBEDDING_DIMENSIONS;
export const STUB_MODEL_ID = 'local:stub-bag-of-words:fp32';

/** A deterministic bag-of-words vector, so a search is reproducible without loading a model. */
export function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

export const stubEmbeddings: EmbeddingProvider = {
  id: STUB_MODEL_ID,
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: estimateTokens,
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => texts.map(stubVector),
  embedQuery: async (text: string) => stubVector(text),
};

/** Indexes one Markdown page into a project the way the indexer does, chunks, vectors and all. */
export async function seedDocument(db: Db, projectId: string, sourceId: string, relativePath: string, body: string): Promise<void> {
  const { title, chunks } = chunkMarkdown(body, relativePath, { maxTokens: 96, overlapTokens: 24, countTokens: estimateTokens });
  const rows: NewChunk[] = chunks.map((c) => ({
    chunkIndex: c.index,
    headingPath: c.headingPath,
    content: c.content,
    tokenCount: c.tokenCount,
    embedding: stubVector(embeddingText(c)),
  }));
  await replaceDocument(
    db,
    {
      projectId,
      sourceId,
      relativePath,
      title,
      contentHash: `hash-${relativePath}`,
      sizeBytes: Buffer.byteLength(body),
      indexGeneration: 0,
      ...storedDocumentContent(body, 1024 * 1024),
    },
    rows,
  );
}

/** A project with one `local` source and one indexed page, ready to be searched. */
export async function seedProject(db: Db, name: string, page: { path: string; body: string }): Promise<ProjectRow> {
  const [project] = await db.insert(projects).values({ name, embeddingModel: STUB_MODEL_ID }).returning();
  const [source] = await db
    .insert(documentSources)
    .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: '/docs', extensions: ['md'] } })
    .returning();
  await seedDocument(db, project.id, source.id, page.path, page.body);
  const [updated] = await db.update(projects).set({ documentCount: 1, chunkCount: 4 }).where(eq(projects.id, project.id)).returning();
  return updated;
}

export interface LiveInstance {
  app: FastifyInstance;
  ctx: AppContext;
  /** `http://127.0.0.1:<port>` — what a client is handed, and what `PUBLIC_BASE_URL` is pinned to. */
  origin: string;
  close(): Promise<void>;
}

/**
 * Starts the OAuth routes and the MCP router against a test database, on an ephemeral port.
 *
 * **`PUBLIC_BASE_URL` is deliberately left unset**, so every URL this instance publishes — the resource
 * identifier in the protected resource metadata, the authorization server's endpoints, the
 * `resource_metadata` pointer in a `401` — is derived from the request's own host. That is both what
 * the product does by default and the only way to get it right here: routes have to be registered
 * before Fastify will listen, and the port is not known until it has.
 */
export async function startMcpInstance(database: TestDatabase, opts: { dataDir: string; docRoot: string }): Promise<LiveInstance> {
  // `trustProxy` as the real server has it (`src/server.ts`), which is also what lets a suite present
  // itself as several hosts: the per-host budget on `/oauth/register` is a product behaviour, and a
  // test file that registered thirty clients from one address would be hitting it on purpose.
  const app = Fastify({ logger: false, forceCloseConnections: true, trustProxy: true });
  await app.register(cookie);

  const config = loadConfig({
    DATABASE_URL: database.url,
    ALLOWED_DOC_ROOTS: opts.docRoot,
    DATA_DIR: opts.dataDir,
    SECRET_KEY: '0'.repeat(64),
    AUTH_COOKIE_SECURE: '0',
    // Short enough that an expiry is a number a test can reason about, long enough that nothing
    // expires between issuing a credential and using it.
    MCP_OAUTH_ACCESS_TTL_MIN: '5',
    // The stub encoder's cosine similarities live nowhere near the default floor, which was measured
    // against `multilingual-e5-small` ([ADR-0042](../../../.ssot/ADR.md#adr-0042)). These suites are
    // about who may search, not about what a search returns, so the gate is off rather than tuned.
    SEARCH_SCORE_FLOOR: '0',
  });

  const ctx = {
    config,
    db: database.db,
    log: silentLogger,
    embeddings: stubEmbeddings,
    chunkBudget: { checked: true },
    indexer: {},
    locks: {},
    uploads: {},
    sessions: new SessionRegistry(silentLogger),
    setup: { needsSetup: false },
    loginLimiter: new SlidingWindow(100, 60_000),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;

  // The admin API too, so a suite can drive the routes that *change* who may reach an endpoint —
  // a password change, a membership — through the real route rather than by calling the service the
  // route calls. Registering it touches neither the indexer nor the embedding model; only a request
  // to one of those routes would, and no suite here sends one.
  await app.register(adminRoutes, { ctx });
  await app.register(oauthRoutes, { ctx });
  await app.register(mcpRoutes, { ctx });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('The test server did not bind a port.');

  return {
    app,
    ctx,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await ctx.sessions.closeAll();
      await app.close();
    },
  };
}
