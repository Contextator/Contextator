import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { removeSourceDir } from '../services/data-dir.js';
import { FLAVORS } from '../services/flavors.js';
import { ConflictError, NotFoundError, getProjectById } from '../services/projects.js';
import { driverFor, isDriverAvailable } from '../services/sources/driver.js';
import {
  SOURCE_TYPES,
  createSource,
  deleteSource,
  getSource,
  invalidateSourceDocuments,
  listSources,
  regenerateWebhookSecret,
  toSourceView,
  updateSource,
} from '../services/sources.js';
import { recountProject } from '../services/vector-store.js';
import { projects } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { uploadRoutes } from './upload-routes.js';

const ProjectParams = z.object({ id: z.uuid() });
const SourceParams = z.object({ id: z.uuid(), sid: z.uuid() });

const CreateBody = z.object({
  type: z.enum(SOURCE_TYPES),
  name: z.string().min(1).max(63),
  label: z.string().max(200).optional(),
  flavor: z.enum(FLAVORS).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(4096).optional(),
  /** Queue an index run right away (default true). */
  index: z.boolean().default(true),
});

const UpdateBody = z.object({
  label: z.string().max(200).optional(),
  flavor: z.enum(FLAVORS).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().max(4096).nullable().optional(),
});

/** `/api/projects/:id/sources/*` — registered inside adminRoutes so the ADMIN_TOKEN hook applies. */
export const sourceRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config, indexer, locks, log } = ctx;
  const serviceOpts = { allowedRoots: config.ALLOWED_DOC_ROOTS, secretKey: config.SECRET_KEY };

  const requireProject = async (id: string) => {
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    return project;
  };

  app.get('/api/projects/:id/sources', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    await requireProject(id);
    // A viewer sees that a webhook exists; only an editor sees what it is signed with.
    const revealWebhookSecret = req.projectAccess !== 'viewer';
    return (await listSources(db, id)).map((row) => toSourceView(row, { revealWebhookSecret }));
  });

  app.post('/api/projects/:id/sources', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    const body = CreateBody.parse(req.body);
    await requireProject(id);
    if (!isDriverAvailable(body.type)) throw new ConflictError(`Source type "${body.type}" is not available on this server yet`);
    const row = await createSource(db, id, body, serviceOpts);
    if (body.index) indexer.enqueue(id);
    return reply.code(201).send(toSourceView(row));
  });

  app.patch('/api/projects/:id/sources/:sid', async (req) => {
    const { id, sid } = SourceParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    await requireProject(id);
    const before = await getSource(db, id, sid);
    if (!before) throw new NotFoundError('Source not found');
    const row = await updateSource(db, id, sid, body, serviceOpts);

    // A new content type — or a new text search configuration (ADR-0041) — has to reach files whose
    // bytes did not change, so drop their hashes first. Both are spent after the hash comparison, on
    // the way into the chunker and into `replaceDocument`, so an unchanged file would otherwise keep
    // the lexemes the previous language produced. Under the project lock, so an index run in flight
    // cannot write fresh hashes over the reset.
    const languageChanged = (row.config as { language?: unknown }).language !== (before.config as { language?: unknown }).language;
    if (row.flavor !== before.flavor || languageChanged) await locks.runExclusive(id, () => invalidateSourceDocuments(db, sid));
    // Settings that change what the source yields (path, branch, subdir, file types, content type)
    // only take effect on a run; queue one instead of leaving the source silently stale.
    if (row.flavor !== before.flavor || JSON.stringify(row.config) !== JSON.stringify(before.config)) indexer.enqueue(id);
    return toSourceView(row);
  });

  app.delete('/api/projects/:id/sources/:sid', async (req, reply) => {
    const { id, sid } = SourceParams.parse(req.params);
    const project = await requireProject(id);
    if (project.status === 'indexing' || indexer.isBusy(id)) {
      throw new ConflictError('Project is currently being indexed; try again when it finishes');
    }
    await locks.runExclusive(id, async () => {
      await deleteSource(db, id, sid); // documents/chunks cascade
      await removeSourceDir(config.DATA_DIR, id, sid).catch((err: unknown) => log.warn({ err, sourceId: sid }, 'could not remove source directory'));
      // The live generation, not the project as a whole: the counters describe the index that is
      // being served, and a superseded generation the sweeper has not reached yet is not it
      // ([ADR-0039](../../.ssot/ADR.md#adr-0039)). Re-read under the lock, since an index run that
      // just swapped may have moved it since `requireProject` above.
      const live = (await getProjectById(db, id)) ?? project;
      const counts = await recountProject(db, id, live.liveGeneration);
      await db.update(projects).set(counts).where(eq(projects.id, id));
    });
    return reply.code(204).send();
  });

  /** Sync = re-index the whole project (sources are synced at the start of every run). */
  app.post('/api/projects/:id/sources/:sid/sync', async (req, reply) => {
    const { id, sid } = SourceParams.parse(req.params);
    await requireProject(id);
    if (!(await getSource(db, id, sid))) throw new NotFoundError('Source not found');
    const job = indexer.enqueue(id);
    return reply.code(202).send({ job });
  });

  /** Connectivity check without indexing (git: list remote refs; notion: read the integration's user). */
  app.post('/api/projects/:id/sources/:sid/test', async (req) => {
    const { id, sid } = SourceParams.parse(req.params);
    await requireProject(id);
    const source = await getSource(db, id, sid);
    if (!source) throw new NotFoundError('Source not found');
    const driver = driverFor(source, { db, log, config });
    if (!driver.test) return { ok: true, message: 'Nothing to test for this source type' };
    try {
      return { ok: true, message: await driver.test() };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/projects/:id/sources/:sid/webhook-secret', async (req) => {
    const { id, sid } = SourceParams.parse(req.params);
    await requireProject(id);
    return toSourceView(await regenerateWebhookSecret(db, id, sid));
  });

  await app.register(uploadRoutes, { ctx });
};
