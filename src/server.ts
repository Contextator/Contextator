import 'dotenv/config';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { authPageRoutes } from './admin/auth-pages.js';
import { pageRoutes } from './admin/pages.js';
import { adminRoutes } from './admin/routes.js';
import { webhookRoutes } from './admin/webhooks.js';
// Source drivers register themselves on import.
import './services/sources/git.js';
import './services/sources/notion.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createDb, waitForDb } from './db/client.js';
import { bootstrapDatabase, SchemaMismatchError } from './db/bootstrap.js';
import { mcpRoutes } from './mcp/router.js';
import { SessionRegistry } from './mcp/sessions.js';
import { newChunkBudgetState, verifyChunkBudget } from './services/chunk-budget.js';
import { sweepOrphanDirs } from './services/data-dir.js';
import { createEmbeddingProvider } from './services/embeddings/index.js';
import { Indexer } from './services/indexer.js';
import { KeyedMutex } from './services/locks.js';
import { listProjects } from './services/projects.js';
import { QueryLog, sweepQueryLog } from './services/query-log.js';
import { startSyncScheduler } from './services/scheduler.js';
import { floorModelWarning } from './services/relevance.js';
import { countUsers } from './services/auth/users.js';
import { startSessionReaper } from './services/auth/sessions.js';
import { SetupGate } from './services/auth/setup.js';
import { SlidingWindow } from './services/rate-limit.js';
import { listAllSources } from './services/sources.js';
import { sweepGenerations } from './services/vector-store.js';
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

  const { db, pool } = createDb(config.DATABASE_URL, log);
  const embeddings = createEmbeddingProvider(config, log);
  const sessions = new SessionRegistry(log);
  const locks = new KeyedMutex();
  const indexer = new Indexer({ db, embeddings, config, log, locks });
  const uploads = new UploadService(config);
  const setup = new SetupGate();
  const loginLimiter = new SlidingWindow(config.AUTH_LOGIN_MAX_ATTEMPTS, config.AUTH_LOGIN_WINDOW_MIN * 60_000);
  // Built only when the instance-wide switch allows it (ADR-0047). Left undefined there is no sink for
  // the MCP tool or the search route to hand `searchProject`, so `SEARCH_QUERY_LOG=0` is not a flag the
  // search path has to remember to check — it is the absence of the thing that would have written.
  const queryLog = config.SEARCH_QUERY_LOG ? new QueryLog(db, log) : undefined;
  const ctx: AppContext = {
    config,
    db,
    log,
    embeddings,
    chunkBudget: newChunkBudgetState(),
    indexer,
    locks,
    uploads,
    sessions,
    setup,
    loginLimiter,
    queryLog,
    version: APP_VERSION,
    startedAt: Date.now(),
  };

  // No `credentials: true`: ALLOWED_ORIGINS exists for browser MCP clients, and granting them
  // credentialed reads of /api/* would hand them the dashboard of whoever is signed in.
  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS.length > 0 ? config.ALLOWED_ORIGINS : false,
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    allowedHeaders: ['content-type', 'authorization', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'],
  });
  await app.register(cookie); // the session cookie; registered on the root app so every plugin can read it
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)), // works from src/ (tsx) and dist/ (node)
    prefix: '/',
    index: false, // `/` is an explicit, guarded route in auth-pages.ts
  });
  // Explicit page routes win over the static wildcard, so /about and the legal pages keep clean URLs.
  await app.register(pageRoutes, { version: APP_VERSION });
  await app.register(authPageRoutes, { ctx });
  await app.register(adminRoutes, { ctx });
  await app.register(webhookRoutes, { ctx });
  await app.register(mcpRoutes, { ctx });

  let stopSessionReaper: (() => void) | undefined;
  let stopSyncScheduler: (() => void) | undefined;
  app.addHook('onClose', async () => {
    sessions.stopReaper();
    stopSessionReaper?.();
    stopSyncScheduler?.();
    await sessions.closeAll();
    // Before the pool, and awaited: what is buffered is a handful of rows and a shutdown that drops
    // them would lose exactly the queries of the minute somebody restarted the container.
    await queryLog?.close().catch((err: unknown) => log.warn({ err }, 'query log did not flush on shutdown'));
    await pool.end();
  });

  await waitForDb(db, { attempts: 30, delayMs: 1000 }, (attempt, err) =>
    log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'waiting for database'),
  );
  try {
    await bootstrapDatabase(db, { pool, dimensions: config.EMBEDDING_DIMENSIONS, resetVectors: config.RESET_VECTORS, log });
  } catch (err) {
    if (err instanceof SchemaMismatchError) {
      log.fatal(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Accounts: with none, the dashboard is a setup wizard and /api/* is closed to everything but
  // ADMIN_TOKEN. The one-time code lives in memory, so a restart prints a fresh one.
  const userCount = await countUsers(db);
  setup.arm(userCount, config.SETUP_CODE);
  if (setup.needsSetup) {
    const baseUrl = config.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? `http://localhost:${config.PORT}`;
    // Straight to stdout rather than through pino: this is the one line an operator has to read,
    // and a JSON-escaped box is not something anyone reads. The structured line below is what a
    // log collector sees — it never carries the code.
    process.stdout.write(setup.banner(baseUrl) + '\n');
    log.warn({ setupUrl: `${baseUrl}/setup`, codeFromEnv: setup.codeIsPinned }, 'no user accounts yet; setup is pending');
    if (!config.ADMIN_TOKEN) {
      log.warn('Until that account exists, every /api/* endpoint answers 401 setup_required.');
    }
  }
  // One timer for everything that has to be forgotten on a schedule. The query log's retention rides
  // the session reaper's interval rather than starting a third one (ADR-0047): the sweep is a single
  // `DELETE … WHERE created_at < now() - …` and a quarter of an hour of latency on a thirty-day window
  // is not a number anybody can observe.
  stopSessionReaper = startSessionReaper(db, log, config.AUTH_SESSION_IDLE_MS, 15 * 60_000, () => {
    loginLimiter.sweep();
    if (!config.SEARCH_QUERY_LOG) return;
    void sweepQueryLog(db, config.SEARCH_QUERY_LOG_RETENTION_DAYS)
      .then((deleted) => {
        if (deleted > 0) log.info({ deleted, retentionDays: config.SEARCH_QUERY_LOG_RETENTION_DAYS }, 'swept expired query log rows');
      })
      .catch((err: unknown) => log.warn({ err }, 'query log sweep failed'));
  });

  // Data directory for materialised sources; drop directories whose project/source rows are gone.
  await fs.mkdir(config.DATA_DIR, { recursive: true });
  try {
    const [projectRows, sourceRows] = await Promise.all([listProjects(db), listAllSources(db)]);
    const removed = await sweepOrphanDirs(config.DATA_DIR, {
      projectIds: new Set(projectRows.map((p) => p.id)),
      sourceIds: new Set(sourceRows.map((s) => s.id)),
    });
    if (removed.length) log.info({ removed }, 'removed orphan source directories');

    // The same sweep, for the database. A process killed mid-rebuild leaves a generation that was
    // never made live and that nothing will ever serve ([ADR-0039](../../.ssot/ADR.md#adr-0039)); the
    // next run of that project would collect it, but a project nobody re-indexes would carry it for
    // as long as the installation lives. Under each project's mutex, because the indexer's queue
    // starts the moment a route is hit.
    let reclaimed = 0;
    for (const row of projectRows) {
      reclaimed += await locks.runExclusive(row.id, () => sweepGenerations(db, row.id, row.liveGeneration));
    }
    if (reclaimed > 0) log.info({ reclaimed }, 'reclaimed documents of abandoned index generations');
  } catch (err) {
    log.warn({ err }, 'orphan sweep of DATA_DIR failed');
  }

  // Model download/load can take a while on first start; don't block the dashboard on it.
  void embeddings
    .warmup()
    .then(() => {
      log.info(
        {
          provider: embeddings.provider,
          model: embeddings.model,
          // The id carries the prefixes (ADR-0038), and it is the value every project is stamped with,
          // so the line that says the model is ready says which configuration it is ready as.
          id: embeddings.id,
          dimensions: embeddings.dimensions,
          maxInputTokens: embeddings.maxInputTokens,
          truncatesAtTokens: embeddings.truncatesAtTokens,
          windowSource: embeddings.windowSource,
        },
        'embedding model ready',
      );
      // The only place a loaded tokenizer and the configuration are both in hand (ADR-0035). Loud,
      // never fatal: exiting from a background promise would make a tuning mistake a crash loop.
      verifyChunkBudget(ctx);
      // And the same shape of mistake one setting along (ADR-0042): SEARCH_SCORE_FLOOR is a cosine
      // similarity, cosine similarities are not comparable between encoders, and its default was
      // measured against one. Here rather than in `config.ts` because the model is a runtime fact.
      const floorWarning = floorModelWarning(config.SEARCH_SCORE_FLOOR, embeddings.model);
      if (floorWarning) log.warn({ floor: config.SEARCH_SCORE_FLOOR, model: embeddings.model }, floorWarning);
    })
    .catch((err: unknown) => log.error({ err }, 'embedding model failed to load; indexing and search will fail until it is available'));

  sessions.startReaper(config.SESSION_IDLE_TTL_MS);

  // The one timer that reaches outside the machine ([ADR-0048](../.ssot/ADR.md#adr-0048)), and the
  // reason it is started last: it wants the drivers registered (the imports at the top of this file)
  // and the schema settled, and it must not fire before the orphan sweep above has decided which
  // source directories still belong to anything.
  //
  // It is not conditional on a setting. On an upgraded installation every source carries
  // `sync_interval_minutes = NULL`, so the tick is one indexed query that matches nothing, once a
  // minute, and NFR-10 holds by the data rather than by a flag somebody has to find.
  stopSyncScheduler = startSyncScheduler({ db, indexer, log, config });

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
