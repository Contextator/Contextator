import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DEFAULT_EVAL_RUN_LIST, getEvalRun, listEvalRuns, MAX_EVAL_RUN_LIST } from '../services/eval-runs.js';
import { ConflictError, getProjectById, NotFoundError } from '../services/projects.js';

const ProjectParams = z.object({ id: z.uuid() });
const RunParams = ProjectParams.extend({ runId: z.uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(MAX_EVAL_RUN_LIST).default(DEFAULT_EVAL_RUN_LIST) });

/**
 * `/api/projects/:id/eval-runs` — the golden set's runs against the live index
 * ([ADR-0124](../../.ssot/ADR.md#adr-0124)).
 *
 * Registered inside adminRoutes, so the project guard has already decided whether this principal reaches the
 * project. Reading is a `viewer`'s by the policy default; asking for a run is a `manager`'s (`auth/policy.ts`),
 * because a run is up to a thousand searches and the same class of act as asking for a floor suggestion, and it
 * is audited like every other unsafe method.
 *
 * Nothing here scores: `services/eval-runs.ts` does, with the module the CLI uses.
 */
export const evalRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;

  // A project that does not exist answers 404 on every route, including the list: an empty list for a
  // project that is not there would read as "never measured".
  const requireProject = async (id: string): Promise<void> => {
    if (!(await getProjectById(db, id))) throw new NotFoundError('Project not found');
  };

  /** A `viewer`'s, by the `GET` default: the runs, newest first, without their per-question ranks. */
  app.get('/api/projects/:id/eval-runs', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const { limit } = ListQuery.parse(req.query);
    await requireProject(id);
    return { runs: await listEvalRuns(db, id, limit) };
  });

  /** One run in full, with the rank of every question it asked (keys, never question text). */
  app.get('/api/projects/:id/eval-runs/:runId', async (req) => {
    const { id, runId } = RunParams.parse(req.params);
    await requireProject(id);
    return getEvalRun(db, id, runId);
  });

  /**
   * Asks for a run now. `202` with the id of the row it will write: the run goes on in the background and is
   * read back from the two routes above. `409` when the project already has a run going or waiting, when the
   * server is already running one (they are one at a time across the instance), or when the project has no
   * golden questions to ask.
   */
  app.post('/api/projects/:id/eval-runs', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    const runner = ctx.evalRuns;
    if (!runner) return reply.code(503).send({ error: 'unavailable', message: 'Eval runs are not available on this server' });
    const outcome = await runner.requestManual(id);
    switch (outcome.status) {
      case 'project_gone':
        throw new NotFoundError('Project not found');
      case 'no_questions':
        throw new ConflictError('This project has no golden questions to ask; add some first');
      case 'busy':
        throw new ConflictError(
          outcome.reason === 'project'
            ? 'A run of this project is already going or waiting; wait for it to finish'
            : 'The server is already running an eval for another project; try again shortly',
        );
      case 'started':
        return reply.code(202).send({ runId: outcome.runId });
    }
  });
};
