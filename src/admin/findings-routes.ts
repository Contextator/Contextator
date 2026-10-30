import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { secretKeyId } from '../services/crypto.js';
import { DEFAULT_FINDINGS_LIMIT, listFindings, MAX_FINDINGS_LIMIT, summarizeFindings } from '../services/document-findings.js';
import { PII_RULES } from '../services/pii-rules.js';
import { getProjectById, NotFoundError } from '../services/projects.js';

const ProjectParams = z.object({ id: z.uuid() });
const ListQuery = z.object({
  rule: z.enum(PII_RULES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FINDINGS_LIMIT).default(DEFAULT_FINDINGS_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
});

/**
 * `GET /api/projects/:id/findings` — where the PII scan found secrets and personal numbers in a project's documents
 * ([ADR-0130](../../.ssot/ADR.md#adr-0130) decision 6).
 *
 * **An `editor`'s, and not a `viewer`'s** (`auth/policy.ts`). A viewer can read every document already, but a
 * list of where the credentials are is a different thing to hand to the widest audience. A read, so it is not
 * audited.
 *
 * What a finding carries is a place, a masked preview and a short group id taken from the front of its HMAC. **The
 * HMAC itself never leaves the server, there is no route that takes a value and says whether it was found, and
 * the MCP surface has no finding on it:** each of those would turn a report into a way of testing guesses.
 */
export const findingsRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;

  app.get('/api/projects/:id/findings', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    const { rule, limit, cursor } = ListQuery.parse(req.query);
    // A project that is not there answers 404, as the eval routes do: an empty list would read as "nothing found".
    if (!(await getProjectById(db, id))) throw new NotFoundError('Project not found');

    const keyId = ctx.config.SECRET_KEY ? secretKeyId(ctx.config.SECRET_KEY) : null;
    const [page, summary] = await Promise.all([listFindings(db, id, { rule, limit, cursor, keyId }), summarizeFindings(db, id, keyId)]);
    return {
      findings: page.findings,
      nextCursor: page.nextCursor,
      summary: {
        ...summary,
        // The two facts the dashboard has to state: scanning is off (the findings shown are from before), and
        // without `SECRET_KEY` nothing is grouped.
        enabled: ctx.config.PII_SCAN,
        grouped: keyId !== null,
      },
    };
  });
};
