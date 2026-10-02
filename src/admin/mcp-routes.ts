import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requirePrincipal } from '../auth/plugin.js';
import { createMcpToken, listMcpTokens, revokeMcpToken, setProjectMcpAuth } from '../services/auth/mcp-tokens.js';

const ProjectParams = z.object({ id: z.uuid() });
const TokenParams = ProjectParams.extend({ tokenId: z.uuid() });
/** The lifetimes a static MCP token may be minted with, in days; `null` (not listed) never expires. */
export const TOKEN_LIFETIME_DAYS = [30, 90, 365] as const;

/**
 * `expiresInDays` is a lifetime rather than a date: a count of days cannot be in the past or in the
 * caller's time zone. It is one of `TOKEN_LIFETIME_DAYS`, the choices the panel offers; `null` (the
 * default) never expires.
 */
export const CreateBody = z.object({
  name: z.string().max(100).default(''),
  expiresInDays: z.literal(TOKEN_LIFETIME_DAYS).nullable().default(null),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment a token minted at `now` with this lifetime stops being accepted; `null` for never. */
export const expiryFromDays = (days: number | null, now: Date = new Date()): Date | null =>
  days === null ? null : new Date(now.getTime() + days * DAY_MS);

/**
 * `/api/projects/:id/mcp-tokens/*`. The project guard in src/auth/plugin.ts has already decided
 * whether this principal reaches the project: reading the list is a viewer's, minting and revoking
 * an editor's. Turning the requirement on and off is a manager's, and lives on the project itself.
 */
export const mcpRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, sessions } = ctx;

  app.get('/api/projects/:id/mcp-tokens', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    return listMcpTokens(db, id);
  });

  app.post('/api/projects/:id/mcp-tokens', async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = ProjectParams.parse(req.params);
    const { name, expiresInDays } = CreateBody.parse(req.body ?? {});
    const { token, view } = await createMcpToken(db, id, name, principal.userId, expiryFromDays(expiresInDays));
    // Returned once and never again: the database holds only its hash.
    return reply.code(201).send({ token: view, secret: token });
  });

  app.delete('/api/projects/:id/mcp-tokens/:tokenId', async (req, reply) => {
    const { id, tokenId } = TokenParams.parse(req.params);
    await revokeMcpToken(db, id, tokenId);
    // An open MCP session was authenticated once; close it so the revocation is immediate rather
    // than "on their next request".
    await sessions.closeForProject(id);
    return reply.code(204).send();
  });

  app.patch('/api/projects/:id/mcp-auth', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    // `account` since [ADR-0054](../../.ssot/ADR.md#adr-0054): a widening of this enum and not a
    // change to it, so a dashboard or script written against the previous version still sends a value
    // this route accepts and still means by it what it meant.
    const { mode } = z.object({ mode: z.enum(['open', 'token', 'account']) }).parse(req.body);
    const mcpAuth = await setProjectMcpAuth(db, id, mode);
    // Closing on the way in as well as out: a session opened while the endpoint was public should
    // not outlive the moment it stopped being public. `account` narrows further than `token` does,
    // so it closes for the same reason.
    if (mode !== 'open') await sessions.closeForProject(id);
    return { mcpAuth };
  });
};
