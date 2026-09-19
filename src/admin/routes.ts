import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { installAuth } from '../auth/plugin.js';
import type { Principal } from '../auth/types.js';
import { MAX_SEARCH_LIMIT, SYNC_MAX_INTERVAL_MINUTES, SYNC_MIN_INTERVAL_MINUTES } from '../config.js';
import type { AppContext } from '../context.js';
import { pingDb } from '../db/client.js';
import type { ProjectRow } from '../db/schema.js';
import { SecretDecryptError, SecretKeyMissingError } from '../services/crypto.js';
import { removeProjectDir } from '../services/data-dir.js';
import { ForbiddenError, RateLimitedError, SearchUnavailableError, UnauthorizedError } from '../services/errors.js';
import { PathNotAllowedError } from '../services/fs-scan.js';
import { listIndexRuns } from '../services/index-runs.js';
import { PasswordPolicyError } from '../services/passwords.js';
import { DEFAULT_SEARCH_LIMIT, searchProject } from '../services/search.js';
import { listProjectsForUser, membershipMap } from '../services/auth/memberships.js';
import { ConflictError, NotFoundError, ValidationError, createProject, deleteProject, getProjectById, listProjects } from '../services/projects.js';
import { countSourcesByProject, createSource, slugifySourceName } from '../services/sources.js';
import { scanFrom, selectionFrom } from '../services/vector-store.js';
import { authRoutes } from './auth-routes.js';
import { mcpRoutes } from './mcp-routes.js';
import { memberRoutes } from './members-routes.js';
import { sourceRoutes } from './sources-routes.js';
import { usersRoutes } from './users-routes.js';

const CreateProjectBody = z.object({
  name: z.string().min(1).max(63),
  /** Legacy convenience: creates the project with one local source pointing here. */
  rootPath: z.string().min(1).max(4096).optional(),
  index: z.boolean().default(true),
});
const IdParams = z.object({ id: z.uuid() });
const ReindexQuery = z.object({ force: z.enum(['true', 'false', '1', '0']).optional() });
/** Same bounds as the `search_docs` tool's, because it is the same search. A query string is text,
 *  so `limit` is coerced — `"3"` is the only way a browser can send 3. */
const SearchQuery = z.object({
  q: z.string().min(1).max(2000),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  // The same two filters `search_docs` takes, spelled the way a query string is (ADR-0042). Both
  // optional, and an empty one is dropped rather than refused: a form that submits every field it
  // has would otherwise send `source=` and be told it named a source called nothing.
  source: z
    .string()
    .max(64)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  path_prefix: z
    .string()
    .max(512)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

/**
 * REST API consumed by the dashboard in public/. Every request is authenticated either by the
 * session cookie of a user account or by `Authorization: Bearer <ADMIN_TOKEN>` (machine access with
 * root permissions); src/auth/plugin.ts resolves and enforces both for this plugin and every
 * plugin nested below it.
 */
export const adminRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db, indexer, sessions, embeddings } = ctx;

  installAuth(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_failed', message: z.prettifyError(err), issues: err.issues });
    }
    if (
      err instanceof ValidationError ||
      err instanceof PathNotAllowedError ||
      err instanceof SecretKeyMissingError ||
      err instanceof SecretDecryptError ||
      err instanceof PasswordPolicyError
    ) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.code, message: err.message });
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.code, message: err.message });
    if (err instanceof RateLimitedError) {
      return reply
        .code(429)
        .header('retry-after', String(err.retryAfterSec))
        .send({ error: 'rate_limited', message: err.message, retryAfterSec: err.retryAfterSec });
    }
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict', message: err.message });
    if (err instanceof SearchUnavailableError) return reply.code(409).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'admin api error');
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Internal error' : (e.message ?? 'Request error'),
    });
  });

  const baseUrl = (req: FastifyRequest): string => (config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
  /** `names` (id → name) lets a queued job say which project it is waiting for without another query. */
  const toView = (
    req: FastifyRequest,
    project: ProjectRow,
    names?: Map<string, string>,
    sourceCounts?: Map<string, number>,
    access: 'viewer' | 'editor' | 'manager' = 'manager',
  ) => {
    const job = indexer.getJob(project.id) ?? null;
    const queue = job?.phase === 'queued' ? indexer.queueInfo(project.id) : undefined;
    return {
      ...project,
      mcpUrl: `${baseUrl(req)}/mcp/${project.name}`,
      /** What the caller may do here; the dashboard hides what it cannot use. */
      access,
      sourceCount: sourceCounts?.get(project.id) ?? 0,
      job: job
        ? {
            ...job,
            queue: queue
              ? { position: queue.position, aheadProjectName: queue.runningProjectId ? (names?.get(queue.runningProjectId) ?? null) : null }
              : null,
          }
        : null,
    };
  };

  /**
   * Public, because the sign-in page, the setup page and the container's HEALTHCHECK all need it
   * before there is anyone to be. The anonymous shape keeps `ok`, `version` and `db` exactly where
   * they were, so an external monitor watching this endpoint does not notice; everything that says
   * something about the machine (document roots, data directory, model, open sessions) waits for a
   * principal, and the filesystem paths wait for an administrator.
   *
   * The status is `200` while the database answers and `503` while it does not (ADR-0032), with the
   * same body either way: the code is what the image's HEALTHCHECK reads, and the body is what turns
   * "something is wrong" into "the database is". `ok` reports the database, not the process — a
   * process that is gone answers nothing at all rather than answering `ok: false`.
   */
  app.get('/api/health', async (req, reply) => {
    const principal = req.principal;
    const dbUp = await pingDb(db);
    if (!dbUp) reply.code(503);
    const base = {
      ok: dbUp,
      version: ctx.version,
      db: dbUp ? 'up' : 'down',
      authRequired: true,
      needsSetup: ctx.setup.needsSetup,
    };
    if (!principal) return base;

    const detail = {
      ...base,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      embeddings: {
        /** Provider-qualified id as stored on each project (`projects.embedding_model`). */
        id: embeddings.id,
        provider: embeddings.provider,
        model: embeddings.model,
        dimensions: embeddings.dimensions,
        dtype: embeddings.provider === 'local' ? config.EMBEDDING_DTYPE : null,
        ready: embeddings.ready,
        /** Empty strings for a symmetric model; part of `id` whenever they are not (ADR-0038). */
        queryPrefix: embeddings.queryPrefix,
        passagePrefix: embeddings.passagePrefix,
        /** What the model reads usefully; `truncatesAtTokens` is where the runtime cuts (ADR-0035). */
        maxInputTokens: embeddings.maxInputTokens,
        truncatesAtTokens: embeddings.truncatesAtTokens,
        windowSource: embeddings.windowSource,
      },
      /** Sticky, and `checked: false` until the model has loaded — before that there is no window. */
      chunkBudget: {
        checked: ctx.chunkBudget.checked,
        ok: ctx.chunkBudget.warning === null,
        chunkMaxTokens: config.CHUNK_MAX_TOKENS,
        suggestedChunkMaxTokens: ctx.chunkBudget.warning?.suggestedChunkMaxTokens ?? null,
      },
      sessions: sessions.stats(),
      uploads: {
        maxFileBytes: config.UPLOAD_MAX_FILE_BYTES,
        maxFilesPerRequest: config.UPLOAD_MAX_FILES_PER_REQUEST,
        maxArchiveBytes: config.UPLOAD_MAX_ARCHIVE_BYTES,
      },
      /**
       * What the source dialog preselects for a **new** source, and the band the API will accept
       * ([ADR-0048](../../.ssot/ADR.md#adr-0048)). `null` when the instance creates new sources
       * unscheduled (`SYNC_DEFAULT_INTERVAL_MINUTES=0`), which is also what the form then shows.
       */
      sync: {
        defaultIntervalMinutes: config.SYNC_DEFAULT_INTERVAL_MINUTES || null,
        minIntervalMinutes: SYNC_MIN_INTERVAL_MINUTES,
        maxIntervalMinutes: SYNC_MAX_INTERVAL_MINUTES,
      },
    };
    if (principal.role === 'member') return detail;

    return {
      ...detail,
      allowedDocRoots: config.ALLOWED_DOC_ROOTS,
      dataDir: config.DATA_DIR,
      secretKeyConfigured: Boolean(config.SECRET_KEY),
    };
  });

  app.get('/api/projects', async (req) => {
    const principal = req.principal as Principal;
    const member = principal.kind === 'session' && principal.role === 'member' ? principal.userId : null;
    const [rows, sourceCounts, roles] = await Promise.all([
      member ? listProjectsForUser(db, member) : listProjects(db),
      countSourcesByProject(db),
      member ? membershipMap(db, member) : Promise.resolve({} as Record<string, 'viewer' | 'editor'>),
    ]);
    const names = new Map(rows.map((p) => [p.id, p.name]));
    return rows.map((p) => toView(req, p, names, sourceCounts, member ? (roles[p.id] ?? 'viewer') : 'manager'));
  });

  app.get('/api/projects/:id/runs', async (req) => {
    const { id } = IdParams.parse(req.params);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    return { runs: await listIndexRuns(db, id) };
  });

  /**
   * What the agent sees, for the person who has to judge it (ROADMAP Item 3). No `:projectId` here
   * and no registration outside this plugin: `isProjectScoped()` matches the literal `/api/projects/:id`
   * prefix and the auth hooks are installed on this instance, so a `GET` is a viewer's by the policy
   * table's default and this handler declares nothing of its own.
   */
  app.get('/api/projects/:id/search', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { q, limit, source, path_prefix } = SearchQuery.parse(req.query);
    const outcome = await searchProject(
      // The floor is passed here as well as to the tool, because this panel is the operator's view of
      // what the agent sees and a search that would be refused has to look refused (ADR-0042). The
      // hits come back either way; the dashboard shows them under the notice.
      // Recorded as `dashboard` rather than `mcp` ([ADR-0047](../../.ssot/ADR.md#adr-0047)), because
      // the operator testing their own corpus is not an agent asking a question and an analysis that
      // averaged the two would be reading its author's own typing back to them.
      {
        db,
        embeddings,
        scan: scanFrom(config),
        selection: selectionFrom(config),
        scoreFloor: config.SEARCH_SCORE_FLOOR,
        queryLog: ctx.queryLog?.for('dashboard'),
      },
      { projectId: id, query: q, limit, source, pathPrefix: path_prefix },
    );
    // Deleted between the policy hook resolving access and this read — the same 404 a caller who
    // may not see it would have got.
    if (outcome.status === 'project_gone') throw new NotFoundError('Project not found');
    if (outcome.status === 'unknown_source') {
      const known = outcome.available.length > 0 ? outcome.available.join(', ') : 'none';
      throw new ValidationError(`This project has no source named "${outcome.requested}". Its sources are: ${known}.`);
    }
    if (outcome.status === 'invalid_path_prefix') {
      throw new ValidationError(`"${outcome.requested}" is not a usable path prefix; use a relative path as shown by the documents list.`);
    }
    if (outcome.status === 'not_indexed') {
      throw new SearchUnavailableError('not_indexed', 'This project has no indexed content yet. Index it and try again.');
    }
    if (outcome.status === 'model_mismatch') {
      throw new SearchUnavailableError(
        'model_mismatch',
        `This project was indexed with "${outcome.indexedWith}" but the server now embeds with "${outcome.serverUses}". Re-index it before searching.`,
      );
    }
    return {
      query: q,
      limit: limit ?? DEFAULT_SEARCH_LIMIT,
      source: source ?? null,
      pathPrefix: path_prefix ?? null,
      // What the agent would have been told instead of these hits, and the number that decided it
      // (ADR-0042). Additive, like the three fusion fields: a script parsing the old shape is unaffected.
      belowFloor: outcome.belowFloor,
      scoreFloor: config.SEARCH_SCORE_FLOOR,
      // The raw score and the path, deliberately: a score an operator cannot see is a score they
      // cannot reason about, and the path is what read_document takes next.
      //
      // Since ADR-0041 the score no longer explains the order, so the three numbers that do are here
      // beside it, additively (API.md §2): `fusedScore` is what ranked the list and the two ranks say
      // which half found the chunk. An excerpt with `lexicalRank: 1` and no `denseRank` is the
      // identifier query this change exists for, visible as such on the operator's own page rather
      // than inferred from a reordering.
      hits: outcome.hits.map((hit) => ({
        score: hit.score,
        fusedScore: hit.fusedScore,
        denseRank: hit.denseRank,
        lexicalRank: hit.lexicalRank,
        path: hit.file,
        title: hit.title,
        headingPath: hit.headingPath,
        chunkIndex: hit.chunkIndex,
        content: hit.content,
        // The passages either side, so the panel can show the excerpt in the place it came from
        // rather than as a paragraph with no edges. `null` when there is none or the setting is 0.
        contextBefore: hit.contextBefore,
        contextAfter: hit.contextAfter,
      })),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);
    const project = await createProject(db, { name: body.name, rootPath: body.rootPath }, config.ALLOWED_DOC_ROOTS);
    if (body.rootPath) {
      // Legacy shape: the directory becomes the project's first (local) source.
      const name =
        slugifySourceName(
          body.rootPath
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop() ?? '',
        ) || 'local';
      await createSource(
        db,
        project.id,
        {
          type: 'local',
          name,
          label: 'Local directory',
          config: { path: body.rootPath },
          // The same default the source route applies, so a project created the legacy way is not a
          // project whose only source is quietly unscheduled ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
          syncIntervalMinutes: config.SYNC_DEFAULT_INTERVAL_MINUTES || null,
        },
        { allowedRoots: config.ALLOWED_DOC_ROOTS, secretKey: config.SECRET_KEY },
      );
      if (body.index) indexer.enqueue(project.id);
    }
    return reply.code(201).send(toView(req, project, undefined, new Map([[project.id, body.rootPath ? 1 : 0]])));
  });

  app.get('/api/projects/:id/status', async (req) => {
    const { id } = IdParams.parse(req.params);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    return { project: toView(req, project), job: indexer.getJob(id) ?? null };
  });

  app.post('/api/projects/:id/reindex', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { force } = ReindexQuery.parse(req.query);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    const job = indexer.enqueue(id, { force: force === 'true' || force === '1' });
    return reply.code(202).send({ job });
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await deleteProject(db, id, (projectId) => indexer.isBusy(projectId));
    indexer.forget(id);
    await sessions.closeForProject(id);
    await removeProjectDir(config.DATA_DIR, id).catch((err: unknown) =>
      req.log.warn({ err, projectId: id }, 'could not remove project data directory'),
    );
    return reply.code(204).send();
  });

  await app.register(authRoutes, { ctx });
  await app.register(usersRoutes, { ctx });
  await app.register(memberRoutes, { ctx });
  await app.register(mcpRoutes, { ctx });
  await app.register(sourceRoutes, { ctx });
};
