import 'dotenv/config';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { adminRoutes } from './admin/routes.js';
import { webhookRoutes } from './admin/webhooks.js';
// Source drivers register themselves on import.
import './services/sources/git.js';
import './services/sources/notion.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createDb, waitForDb } from './db/client.js';
import { ensureSchema, SchemaMismatchError } from './db/ensure-schema.js';
import { mcpRoutes } from './mcp/router.js';
import { SessionRegistry } from './mcp/sessions.js';
import { sweepOrphanDirs } from './services/data-dir.js';
import { createEmbeddingProvider } from './services/embeddings/index.js';
import { Indexer } from './services/indexer.js';
import { KeyedMutex } from './services/locks.js';
import { listProjects } from './services/projects.js';
import { listAllSources } from './services/sources.js';
import { UploadService } from './services/uploads.js';
import { APP_VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const verbose = config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace';

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // The dashboard polls; per-request log lines are noise unless debugging.
    logController: new LogController({ disableRequestLogging: !verbose }),
    bodyLimit: 4 * 1024 * 1024, // matches the MCP SDK's own body limit
    forceCloseConnections: true, // hijacked SSE sockets must not block shutdown
    trustProxy: true,
  });
  const log = app.log;

  const { db, pool } = createDb(config.DATABASE_URL);
  const embeddings = createEmbeddingProvider(config, log);
  const sessions = new SessionRegistry(log);
  const locks = new KeyedMutex();
  const indexer = new Indexer({ db, embeddings, config, log, locks });
  const uploads = new UploadService(config);
  const ctx: AppContext = { config, db, log, embeddings, indexer, locks, uploads, sessions, version: APP_VERSION, startedAt: Date.now() };

  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS.length > 0 ? config.ALLOWED_ORIGINS : false,
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    allowedHeaders: ['content-type', 'authorization', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'],
  });
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)), // works from src/ (tsx) and dist/ (node)
    prefix: '/',
    index: ['index.html'],
  });
  await app.register(adminRoutes, { ctx });
  await app.register(webhookRoutes, { ctx });
  await app.register(mcpRoutes, { ctx });

  app.addHook('onClose', async () => {
    sessions.stopReaper();
    await sessions.closeAll();
    await pool.end();
  });

  await waitForDb(db, { attempts: 30, delayMs: 1000 }, (attempt, err) =>
    log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'waiting for database'),
  );
  try {
    await ensureSchema(db, { dimensions: config.EMBEDDING_DIMENSIONS, resetVectors: config.RESET_VECTORS, log });
  } catch (err) {
    if (err instanceof SchemaMismatchError) {
      log.fatal(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Data directory for materialised sources; drop directories whose project/source rows are gone.
  await fs.mkdir(config.DATA_DIR, { recursive: true });
  try {
    const [projectRows, sourceRows] = await Promise.all([listProjects(db), listAllSources(db)]);
    const removed = await sweepOrphanDirs(config.DATA_DIR, {
      projectIds: new Set(projectRows.map((p) => p.id)),
      sourceIds: new Set(sourceRows.map((s) => s.id)),
    });
    if (removed.length) log.info({ removed }, 'removed orphan source directories');
  } catch (err) {
    log.warn({ err }, 'orphan sweep of DATA_DIR failed');
  }

  // Model download/load can take a while on first start; don't block the dashboard on it.
  void embeddings
    .warmup()
    .then(() => log.info({ provider: embeddings.provider, model: embeddings.model, dimensions: embeddings.dimensions }, 'embedding model ready'))
    .catch((err: unknown) => log.error({ err }, 'embedding model failed to load; indexing and search will fail until it is available'));

  sessions.startReaper(config.SESSION_IDLE_TTL_MS);

  await app.listen({ port: config.PORT, host: config.HOST });
  log.info({ dashboard: `http://localhost:${config.PORT}/`, mcp: `http://localhost:${config.PORT}/mcp/<project>` }, 'Contextator is up');

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
