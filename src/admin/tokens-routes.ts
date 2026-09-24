import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireSession } from '../auth/plugin.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/auth/api-tokens.js';
import { isSessionLive } from '../services/auth/sessions.js';
import { withUserRowLock } from '../services/auth/users.js';
import { UnauthorizedError } from '../services/errors.js';

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
    /**
     * Minted inside `withUserRowLock` ([T7-MAJOR-1], tur 8 fix of [ADR-0077](../../.ssot/ADR.md#adr-0077)):
     * `DELETE /api/auth/oidc/link` revokes this account's sessions and tokens together, under the same
     * lock, so a mint racing it must serialize against it too — otherwise a session unlink was about to
     * revoke could still mint a token in the gap, and that token would outlive the link the same way
     * [T6-MAJOR-1]'s session did before tur 7. The re-check below reads this request's own session row
     * fresh, under the lock: if the session lost the race, it was revoked before this transaction could
     * commit, and no token is minted. `createApiToken` is called with `tx`, never `db` — see the warning
     * on `withUserRowLock` about why a `db` write here would deadlock the request against its own lock.
     *
     * The re-check only matters when unlink's `withUserRowLock` transaction commits and releases the
     * row lock *before* this call below ever acquires it — a mint that already holds the lock can only
     * ever make a racing unlink queue behind it instead ([T8-MAJOR-1], tur 9 fix): that order is what
     * `ctx.testHooks.onTokenMintBeforeLock` below pauses to produce deterministically in
     * `test/integration/oidc.itest.ts`, since a randomized race cannot be relied on to hit it.
     */
    await ctx.testHooks?.onTokenMintBeforeLock?.();
    const { token, view } = await withUserRowLock(db, principal.userId, async (tx) => {
      if (!(await isSessionLive(tx, principal.sessionId))) {
        throw new UnauthorizedError('session_revoked', 'Your session was revoked; sign in again to create a token');
      }
      await ctx.testHooks?.onTokenMintBeforeInsert?.();
      return createApiToken(tx, {
        userId: principal.userId,
        name: body.name,
        scope: body.scope,
        projectId: body.projectId,
        expiresAt: body.expiresAt,
        createdBy: principal.userId,
      });
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
