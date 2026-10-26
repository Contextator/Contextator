import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  createGoldenQuestion,
  deleteGoldenQuestion,
  formatGoldenJsonl,
  getGoldenQuestion,
  GoldenQuestionInputSchema,
  GoldenQuestionPatchSchema,
  GoldenQuestionSetSchema,
  listGoldenQuestions,
  replaceGoldenQuestions,
  toGoldenQuestionView,
  updateGoldenQuestion,
} from '../services/golden-questions.js';
import { getProjectById, NotFoundError } from '../services/projects.js';

const ProjectParams = z.object({ id: z.uuid() });
const QuestionParams = ProjectParams.extend({ questionId: z.uuid() });

/**
 * `/api/projects/:id/golden-questions/*` — a project's own golden question set (FR-347).
 *
 * Registered inside adminRoutes, so the project guard has already decided whether this principal reaches
 * the project; the default per-method roles apply (`viewer` reads, `editor` writes), which is the right
 * answer here: the set is the project's content, not an instance setting. Every unsafe method is audited
 * by the policy layer without this file doing anything.
 *
 * The routes store and serve questions. Asking them is `npm run eval -- --project <name>` and the server's
 * own run (`eval-runs.ts`, [ADR-0124](../../.ssot/ADR.md#adr-0124)), which a change to the set requests once
 * the set has been left alone for a while: the change is stored first and the run is only ever told about it.
 */
export const goldenRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;

  // A project that does not exist answers 404 on every route, including the list: an empty array for a
  // project that is not there would read as "no questions yet".
  const requireProject = async (id: string): Promise<void> => {
    if (!(await getProjectById(db, id))) throw new NotFoundError('Project not found');
  };

  // Told after the write has committed and never awaited: a set that changed is asked again (ADR-0124).
  const changed = (id: string): void => ctx.evalRuns?.notifyGoldenSetChanged(id);

  app.get('/api/projects/:id/golden-questions', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    await requireProject(id);
    return { questions: (await listGoldenQuestions(db, id)).map(toGoldenQuestionView) };
  });

  // The set in `golden.jsonl`'s shape (`key` is the row's `id`), ready for `npm run eval -- --golden`.
  app.get('/api/projects/:id/golden-questions/export', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    await requireProject(id);
    const rows = await listGoldenQuestions(db, id);
    return reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', 'attachment; filename="golden.jsonl"')
      .send(formatGoldenJsonl(rows));
  });

  app.get('/api/projects/:id/golden-questions/:questionId', async (req) => {
    const { id, questionId } = QuestionParams.parse(req.params);
    await requireProject(id);
    return toGoldenQuestionView(await getGoldenQuestion(db, id, questionId));
  });

  app.post('/api/projects/:id/golden-questions', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    await requireProject(id);
    const input = GoldenQuestionInputSchema.parse(req.body);
    const created = await createGoldenQuestion(db, id, input);
    changed(id);
    return reply.code(201).send(toGoldenQuestionView(created));
  });

  // Replaces the whole set in one transaction — how a file of questions is loaded.
  app.put('/api/projects/:id/golden-questions', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    await requireProject(id);
    const { questions } = GoldenQuestionSetSchema.parse(req.body);
    const replaced = await replaceGoldenQuestions(db, id, questions);
    changed(id);
    return { questions: replaced.map(toGoldenQuestionView) };
  });

  app.patch('/api/projects/:id/golden-questions/:questionId', async (req) => {
    const { id, questionId } = QuestionParams.parse(req.params);
    await requireProject(id);
    const patch = GoldenQuestionPatchSchema.parse(req.body);
    const updated = await updateGoldenQuestion(db, id, questionId, patch);
    changed(id);
    return toGoldenQuestionView(updated);
  });

  app.delete('/api/projects/:id/golden-questions/:questionId', async (req, reply) => {
    const { id, questionId } = QuestionParams.parse(req.params);
    await requireProject(id);
    await deleteGoldenQuestion(db, id, questionId);
    changed(id);
    return reply.code(204).send();
  });
};
