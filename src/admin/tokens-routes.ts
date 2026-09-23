import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireSession } from '../auth/plugin.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/auth/api-tokens.js';

const TokenParams = z.object({ tokenId: z.uuid() });

/** `METHOD /route`, the same key space `src/auth/policy.ts` reads at request time. Nothing more is
 * validated here: an entry this product does not recognise simply matches no route ever, which is
 * why `apiTokenAllowsRoute` can stay a plain string comparison instead of a maintained registry. */
const ScopeEntry = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Z]+ \/\S+$/, 'must look like "METHOD /route"');

const CreateBody = z.object({
  name: z.string().max(100).default(''),
  scope: z.array(ScopeEntry).min(1).max(50),
  // A single project this token may reach, or `null` for every project its owner already reaches.
  // Not checked against the owner's memberships here: a project id the account cannot reach only
  // ever narrows the token to nothing, the same way it would for a stale or mistyped id — the
  // request-time membership check ([ADR-0076](../../.ssot/ADR.md#adr-0076)) is what actually decides,
  // on every request, off the owner's live role rather than a snapshot taken at mint time.
  projectId: z.uuid().nullable().default(null),
  expiresAt: z.coerce.date().nullable().default(null),
});

/**
 * `/api/tokens/*` — an account's own bearer credentials for the admin API
 * ([ADR-0076](../../.ssot/ADR.md#adr-0076)). Self-service and session-only: `requireSession` refuses
 * an `ADMIN_TOKEN` or another API token trying to mint or revoke one, the same way `requireSession`
 * already refuses either of them everywhere else a human decision is being made. Every route here
 * only ever reads or writes the caller's own rows — there is no admin surface over somebody else's
 * tokens, on purpose: an operator who needs that has account management instead.
 */
export const tokensRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;

  app.get('/api/tokens', async (req) => {
    const principal = requireSession(req);
    return listApiTokens(db, principal.userId);
  });

  app.post('/api/tokens', async (req, reply) => {
    const principal = requireSession(req);
    const body = CreateBody.parse(req.body ?? {});
    if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) {
      return reply.code(400).send({ error: 'expiresAt must be in the future' });
    }
    const { token, view } = await createApiToken(db, {
      userId: principal.userId,
      name: body.name,
      scope: body.scope,
      projectId: body.projectId,
      expiresAt: body.expiresAt,
      createdBy: principal.userId,
    });
    // Returned once and never again: the database holds only its hash (ADR-0017).
    return reply.code(201).send({ token: view, secret: token });
  });

  app.delete('/api/tokens/:tokenId', async (req, reply) => {
    const principal = requireSession(req);
    const { tokenId } = TokenParams.parse(req.params);
    await revokeApiToken(db, principal.userId, tokenId);
    return reply.code(204).send();
  });
};
