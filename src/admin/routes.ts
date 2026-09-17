import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { pingDb } from '../db/client.js';
import type { ProjectRow } from '../db/schema.js';
import { SecretDecryptError, SecretKeyMissingError } from '../services/crypto.js';
import { removeProjectDir } from '../services/data-dir.js';
import { PathNotAllowedError } from '../services/fs-scan.js';
import { listIndexRuns } from '../services/index-runs.js';
import { ConflictError, NotFoundError, ValidationError, createProject, deleteProject, getProjectById, listProjects } from '../services/projects.js';
import { countSourcesByProject, createSource, slugifySourceName } from '../services/sources.js';
import { sourceRoutes } from './sources-routes.js';

const CreateProjectBody = z.object({
  name: z.string().min(1).max(63),
  /** Legacy convenience: creates the project with one local source pointing here. */
  rootPath: z.string().min(1).max(4096).optional(),
  index: z.boolean().default(true),
});
const IdParams = z.object({ id: z.uuid() });
const ReindexQuery = z.object({ force: z.enum(['true', 'false', '1', '0']).optional() });

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** REST API consumed by the dashboard in public/. Optional bearer auth via ADMIN_TOKEN. */
export const adminRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db, indexer, sessions, embeddings } = ctx;

  app.addHook('onRequest', async (req, reply) => {
    if (!config.ADMIN_TOKEN || req.routeOptions.url === '/api/health') return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token || !safeEqual(token, config.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_failed', message: z.prettifyError(err), issues: err.issues });
    }
    if (err instanceof ValidationError || err instanceof PathNotAllowedError || err instanceof SecretKeyMissingError || err instanceof SecretDecryptError) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict', message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'admin api error');
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'internal_error' : 'request_error', message: status >= 500 ? 'Internal error' : (e.message ?? 'Request error') });
  });

  const baseUrl = (req: FastifyRequest): string => (config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
  /** `names` (id → name) lets a queued job say which project it is waiting for without another query. */
  const toView = (req: FastifyRequest, project: ProjectRow, names?: Map<string, string>, sourceCounts?: Map<string, number>) => {
    const job = indexer.getJob(project.id) ?? null;
    const queue = job?.phase === 'queued' ? indexer.queueInfo(project.id) : undefined;
    return {
      ...project,
      mcpUrl: `${baseUrl(req)}/mcp/${project.name}`,
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

  app.get('/api/health', async () => ({
    ok: true,
    version: ctx.version,
    uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
    db: (await pingDb(db)) ? 'up' : 'down',
    embeddings: {
      /** Provider-qualified id as stored on each project (`projects.embedding_model`). */
      id: embeddings.id,
      provider: embeddings.provider,
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      dtype: embeddings.provider === 'local' ? config.EMBEDDING_DTYPE : null,
      ready: embeddings.ready,
    },
    sessions: sessions.stats(),
    allowedDocRoots: config.ALLOWED_DOC_ROOTS,
    dataDir: config.DATA_DIR,
    secretKeyConfigured: Boolean(config.SECRET_KEY),
    uploads: {
      maxFileBytes: config.UPLOAD_MAX_FILE_BYTES,
      maxFilesPerRequest: config.UPLOAD_MAX_FILES_PER_REQUEST,
      maxArchiveBytes: config.UPLOAD_MAX_ARCHIVE_BYTES,
    },
  }));

  app.get('/api/projects', async (req) => {
    const [rows, sourceCounts] = await Promise.all([listProjects(db), countSourcesByProject(db)]);
    const names = new Map(rows.map((p) => [p.id, p.name]));
    return rows.map((p) => toView(req, p, names, sourceCounts));
  });

  app.get('/api/projects/:id/runs', async (req) => {
    const { id } = IdParams.parse(req.params);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    return { runs: await listIndexRuns(db, id) };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);
    const project = await createProject(db, { name: body.name, rootPath: body.rootPath }, config.ALLOWED_DOC_ROOTS);
    if (body.rootPath) {
      // Legacy shape: the directory becomes the project's first (local) source.
      const name = slugifySourceName(body.rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') || 'local';
      await createSource(
        db,
        project.id,
        { type: 'local', name, label: 'Local directory', config: { path: body.rootPath } },
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
    await removeProjectDir(config.DATA_DIR, id).catch((err: unknown) => req.log.warn({ err, projectId: id }, 'could not remove project data directory'));
    return reply.code(204).send();
  });

  await app.register(sourceRoutes, { ctx });
};
