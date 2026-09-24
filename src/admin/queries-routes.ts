import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { NotFoundError, getProjectById, setProjectScoreFloor } from '../services/projects.js';
import { buildExport, toJsonl } from '../services/query-export.js';
import {
  DEFAULT_EXPORT_ROWS,
  DEFAULT_SUMMARY_DAYS,
  DEFAULT_SUMMARY_ROWS,
  MAX_EXPORT_ROWS,
  MAX_SUMMARY_DAYS,
  MAX_SUMMARY_ROWS,
  type QueryConfiguration,
  type SummaryActor,
  type SummaryScope,
  listQueryConfigurations,
  mostReturnedChunks,
  neverReturnedDocuments,
  oldestLoggedQuery,
  purgeProjectQueryLog,
  repeatedQuestions,
  setQueryLogEnabled,
  volumeOverTime,
} from '../services/query-summary.js';

/**
 * `/api/projects/:id/queries/*` and the two switch routes beside them — the read side of the query log
 * ([ADR-0050](../../.ssot/ADR.md#adr-0050)).
 *
 * The access rules were written with the columns, a release before any of these routes existed
 * ([ADR-0047](../../.ssot/ADR.md#adr-0047), FR-309): reading is a `viewer`'s, which the policy table's
 * `GET` default already says and this plugin therefore declares nothing about; the switch and the purge
 * are a `manager`'s, which is *not* the default — `requiredProjectAccess` falls `POST`/`PATCH`/`DELETE`
 * to `editor` — and is carried by the two rows already in `PROJECT_ROUTE_OVERRIDES`. Registering these
 * handlers is all that was missing.
 */

const ProjectParams = z.object({ id: z.uuid() });

/**
 * A window, whose searches, one retrieval configuration, and a page size.
 *
 * `model` and `generation` travel together or not at all. A generation without the model it belongs to
 * names half a configuration, and half a configuration is the averaging this panel exists to prevent.
 */
const SummaryFields = {
  days: z.coerce.number().int().min(1).max(MAX_SUMMARY_DAYS).default(DEFAULT_SUMMARY_DAYS),
  actor: z.enum(['mcp', 'dashboard', 'all']).default('mcp'),
  model: z.string().min(1).max(200).optional(),
  generation: z.coerce.number().int().min(0).optional(),
};

/** The pairing rule, spelled once and applied to both read routes. */
const bothOrNeither = <T extends { model?: string; generation?: number }>(q: T): boolean => (q.model === undefined) === (q.generation === undefined);
const PAIRING = {
  message: 'model and generation are given together or not at all: a generation without its model names half a retrieval configuration',
};

const SummaryQuery = z
  .object({ ...SummaryFields, limit: z.coerce.number().int().min(1).max(MAX_SUMMARY_ROWS).default(DEFAULT_SUMMARY_ROWS) })
  .refine(bothOrNeither, PAIRING);

const ExportQuery = z
  .object({ ...SummaryFields, limit: z.coerce.number().int().min(1).max(MAX_EXPORT_ROWS).default(DEFAULT_EXPORT_ROWS) })
  .refine(bothOrNeither, PAIRING);

const SwitchBody = z.object({ enabled: z.boolean() });

/**
 * A project's own relevance floor, or `null` for the instance's. The bounds are the column's check and
 * `SEARCH_SCORE_FLOOR`'s own: a cosine similarity, `0` meaning off.
 */
const FloorBody = z.object({ floor: z.number().min(0).max(1).nullable() });

/**
 * Which configuration the figures describe when the caller named none: **the one with the most
 * searches in the window**, most recent first on a tie.
 *
 * The alternative — the project's current model and live generation — makes the panel go blank the
 * morning after a re-index, and an operator reading a blank panel concludes there is no data rather
 * than that they are looking at a four-hour-old configuration. The one this picks is named in the
 * response beside every other configuration in the window and the count of searches outside it, so it
 * is a starting point the operator can see and change, not a number quietly chosen for them.
 */
const pickConfiguration = (configurations: readonly QueryConfiguration[]): QueryConfiguration | null => configurations[0] ?? null;

export const queriesRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db } = ctx;

  /** The shared first half of both read routes: the project, the window, and the configuration. */
  async function resolve(
    id: string,
    query: { days: number; actor: SummaryActor; model?: string; generation?: number },
  ): Promise<{
    project: Awaited<ReturnType<typeof getProjectById>>;
    from: Date;
    to: Date;
    configurations: QueryConfiguration[];
    configuration: QueryConfiguration | null;
  }> {
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');

    const to = new Date();
    const from = new Date(to.getTime() - query.days * 24 * 60 * 60 * 1000);
    const configurations = await listQueryConfigurations(db, id, from, to, query.actor);
    const configuration =
      query.model === undefined
        ? pickConfiguration(configurations)
        : // A configuration the caller named that the window does not contain is an empty panel rather
          // than an error: it is a legitimate question ("what did generation 2 look like?") whose
          // honest answer is "nothing in this window", and the list beside it says what there is.
          (configurations.find((c) => c.embeddingModel === query.model && c.liveGeneration === query.generation) ?? {
            embeddingModel: query.model,
            liveGeneration: query.generation ?? 0,
            queries: 0,
            firstAt: from.toISOString(),
            lastAt: from.toISOString(),
          });
    return { project, from, to, configurations, configuration };
  }

  app.get('/api/projects/:id/queries/summary', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const query = SummaryQuery.parse(req.query);
    const { project, from, to, configurations, configuration } = await resolve(id, query);

    const oldest = await oldestLoggedQuery(db, id);
    const window = {
      days: query.days,
      from: from.toISOString(),
      to: to.toISOString(),
      /**
       * The caution [OPERATIONS.md](../../.ssot/OPERATIONS.md) §6.1 gives somebody holding `psql`,
       * turned into a field: a window longer than retention returns retention and says nothing about
       * it. Here it says so.
       */
      retentionDays: config.SEARCH_QUERY_LOG_RETENTION_DAYS,
      beyondRetention: query.days > config.SEARCH_QUERY_LOG_RETENTION_DAYS,
      oldestQueryAt: oldest,
    };
    const base = {
      window,
      actor: query.actor,
      logEnabled: project?.queryLogEnabled === true,
      instanceLogEnabled: config.SEARCH_QUERY_LOG,
      /**
       * The relevance floor this project's searches are decided against, and where it comes from. The
       * panel is where the operator reads `below_floor` rows, so it is where the number that set them
       * is shown — and where a manager changes it.
       */
      scoreFloor: {
        project: project?.scoreFloor ?? null,
        instance: config.SEARCH_SCORE_FLOOR,
        effective: project?.scoreFloor ?? config.SEARCH_SCORE_FLOOR,
      },
      configurations,
      configuration,
      /** Searches in the window that the figures below do **not** describe. */
      queriesOutsideConfiguration: configurations.reduce((n, c) => n + c.queries, 0) - (configuration?.queries ?? 0),
      /** What the project runs now, so the panel can say when it is looking at an older configuration. */
      current: { embeddingModel: project?.embeddingModel ?? null, liveGeneration: project?.liveGeneration ?? 0 },
    };
    if (!configuration) {
      return { ...base, questions: [], neverReturned: { documentsInGeneration: 0, rows: [] }, chunks: [], volume: [] };
    }

    const scope: SummaryScope = {
      projectId: id,
      from,
      to,
      actor: query.actor,
      embeddingModel: configuration.embeddingModel,
      liveGeneration: configuration.liveGeneration,
    };
    const [questions, neverReturned, chunks, volume] = await Promise.all([
      repeatedQuestions(db, scope, query.limit),
      neverReturnedDocuments(db, scope, query.limit),
      mostReturnedChunks(db, scope, query.limit),
      volumeOverTime(db, scope),
    ]);
    return { ...base, questions, neverReturned, chunks, volume };
  });

  /**
   * The same ranking, written as the evaluation harness's JSONL
   * ([`services/query-export.ts`](../services/query-export.ts) carries the decision about its shape).
   *
   * `application/x-ndjson` and a filename, because this is a file an operator saves next to a corpus
   * and edits — not a page they read.
   */
  app.get('/api/projects/:id/queries/export', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    const query = ExportQuery.parse(req.query);
    const { project, from, to, configuration } = await resolve(id, query);

    const rows = configuration
      ? await repeatedQuestions(
          db,
          {
            projectId: id,
            from,
            to,
            actor: query.actor,
            embeddingModel: configuration.embeddingModel,
            liveGeneration: configuration.liveGeneration,
          },
          query.limit,
        )
      : [];
    const name = `${project?.name ?? 'project'}-questions.jsonl`;
    return reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(toJsonl(buildExport(rows)));
  });

  /** `manager`, by the row ADR-0047 put in the policy table before this handler existed. */
  app.patch('/api/projects/:id/query-log', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const { enabled } = SwitchBody.parse(req.body);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    const queryLogEnabled = await setQueryLogEnabled(db, id, enabled);
    // It takes effect on the next search and deletes nothing — the same two sentences OPERATIONS §5.17
    // gives an operator doing this with `psql`.
    return { queryLogEnabled };
  });

  /**
   * `manager`, by its row in `PROJECT_ROUTE_OVERRIDES`: what this project refuses to answer is the same
   * class of decision as whether it records what it was asked. `null` returns the project to the
   * instance's `SEARCH_SCORE_FLOOR`; the next search reads the new value.
   */
  app.patch('/api/projects/:id/score-floor', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const { floor } = FloorBody.parse(req.body);
    const row = await setProjectScoreFloor(db, id, floor);
    if (!row) throw new NotFoundError('Project not found');
    return { scoreFloor: row.scoreFloor, instanceScoreFloor: config.SEARCH_SCORE_FLOOR };
  });

  /** Also `manager`: deleting evidence is not an editorial act. */
  app.delete('/api/projects/:id/query-log', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');
    const deleted = await purgeProjectQueryLog(db, id);
    req.log.info({ projectId: id, deleted }, 'query log purged');
    // The count, and the one consequence a `DELETE` cannot reach: the dumps already taken still hold
    // these rows (OPERATIONS §4.8).
    return { deleted, dumpsUnaffected: true };
  });
};
