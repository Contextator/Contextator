import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PROJECT_NAME_RE } from '../config.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { cookieSecure } from '../auth/cookies.js';
import { requireSession } from '../auth/plugin.js';
import { satisfies } from '../auth/policy.js';
import { resolveProjectAccess } from '../services/auth/memberships.js';
import { keyringOf } from '../services/crypto.js';
import { ConflictError, NotFoundError, ValidationError, getProjectById } from '../services/projects.js';
import { isDriverAvailable } from '../services/sources/driver.js';
import {
  NotionOAuthError,
  buildNotionAuthorizeUrl,
  exchangeAuthorizationCode,
  notionOAuthLocks,
  notionOAuthSettings,
  oauthSecretFromGrant,
  serializeOAuthSecret,
  type NotionTokenGrant,
} from '../services/sources/notion-oauth.js';
import {
  NotionConfig,
  createSource,
  deleteSource,
  getSource,
  getSourceByName,
  replaceSourceSecretIfUnchanged,
  updateSource,
  type NotionOAuthInfo,
} from '../services/sources.js';

/**
 * Notion OAuth ([ADR-0129](../../.ssot/ADR.md#adr-0129)): the dashboard starts the flow, the browser
 * goes to Notion and comes back to `GET /api/sources/notion/oauth/callback`, and the callback turns the
 * grant into a source (or into new tokens for an existing one).
 *
 * `POST /api/projects/:id/sources/notion/oauth` is a project route like the others, so the policy
 * table already asks for an `editor` and the audit hook already records it; what it adds is that only a
 * **session** can start it. The callback is not project-scoped; it authenticates by the session and by
 * the flow cookie, and **re-checks every fact the cookie carries against live state** — the cookie is
 * unsigned for the reason the OIDC one is: nothing in it is trusted, everything in it is verified.
 */

export const NOTION_OAUTH_FLOW_COOKIE = 'contextator_notion_oauth_flow';
const FLOW_PATH = '/api/sources/notion/oauth';
const FLOW_TTL_SECONDS = 10 * 60;

const ProjectParams = z.object({ id: z.uuid() });

const StartBody = z.object({
  name: z.string().min(1).max(63).optional(),
  rootIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  sourceId: z.uuid().optional(),
});

const CallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
});

/** What the cookie carries across the redirect. Every field is checked again when the browser returns. */
const FlowCookie = z.object({
  state: z.string().min(1),
  projectId: z.uuid(),
  /** The session that started the flow; the callback must be reached by the same one. */
  sessionId: z.string().min(1),
  expiresAt: z.number(),
  /** Reconnect: the source whose tokens are replaced. */
  sourceId: z.uuid().optional(),
  /** New connection: the source to create. */
  create: z.object({ name: z.string(), rootIds: z.array(z.string()) }).optional(),
});
type FlowCookie = z.infer<typeof FlowCookie>;

function setFlowCookie(reply: FastifyReply, req: FastifyRequest, ctx: AppContext, flow: FlowCookie): void {
  reply.setCookie(NOTION_OAUTH_FLOW_COOKIE, Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url'), {
    httpOnly: true,
    // `lax`, not `strict`: Notion sends the browser back with a top-level `GET`, and that is the one
    // cross-site request a `lax` cookie still travels on.
    sameSite: 'lax',
    path: FLOW_PATH,
    secure: cookieSecure(ctx.config, req),
    maxAge: FLOW_TTL_SECONDS,
  });
}

function clearFlowCookie(reply: FastifyReply, req: FastifyRequest, ctx: AppContext): void {
  reply.clearCookie(NOTION_OAUTH_FLOW_COOKIE, { path: FLOW_PATH, sameSite: 'lax', httpOnly: true, secure: cookieSecure(ctx.config, req) });
}

function readFlowCookie(req: FastifyRequest): FlowCookie | undefined {
  const raw = req.cookies?.[NOTION_OAUTH_FLOW_COOKIE];
  if (!raw) return undefined;
  try {
    const parsed = FlowCookie.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Cut to what `NotionOAuthInfo` accepts: a long workspace name must not turn a successful authorisation into a refused save. */
function oauthInfoOf(grant: NotionTokenGrant): NotionOAuthInfo {
  return {
    workspaceId: grant.workspace_id.slice(0, 200),
    workspaceName: (grant.workspace_name ?? '').slice(0, 500),
    botId: grant.bot_id.slice(0, 200),
  };
}

export const notionOAuthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config, indexer, log } = ctx;
  const settings = notionOAuthSettings(config);
  const serviceOpts = { allowedRoots: config.ALLOWED_DOC_ROOTS, keys: keyringOf(config) };

  /** Whether the dashboard should offer "Connect with Notion"; the panel asks, as it asks `oidc.enabled`. */
  app.get('/api/sources/notion/oauth', async () => ({ enabled: settings !== null }));

  /**
   * Starts the flow. Session-only: a person in a browser is the whole point, so `requireSession`
   * refuses `ADMIN_TOKEN` and API tokens, and the `editor` check is the policy table's default for a
   * `POST` under a project. `POST` rather than `GET` for the reason `/api/auth/oidc/link` is: a
   * state-changing request the browser can be made to send by navigation is a CSRF target.
   */
  app.post('/api/projects/:id/sources/notion/oauth', async (req, reply) => {
    const principal = requireSession(req);
    if (!settings) throw new NotFoundError('Notion OAuth is not configured on this instance');
    const { id } = ProjectParams.parse(req.params);
    const body = StartBody.parse(req.body ?? {});
    if (!(await getProjectById(db, id))) throw new NotFoundError('Project not found');
    if (!isDriverAvailable('notion')) throw new ConflictError('Source type "notion" is not available on this server yet');

    const flow: Omit<FlowCookie, 'state' | 'expiresAt'> = { projectId: id, sessionId: principal.sessionId };
    if (body.sourceId) {
      if (body.name !== undefined || body.rootIds !== undefined) {
        throw new ValidationError('Reconnecting a source takes only its id; its name and root pages stay as they are');
      }
      const source = await getSource(db, id, body.sourceId);
      if (!source) throw new NotFoundError('Source not found');
      if (source.type !== 'notion') throw new ValidationError('Only a Notion source can be connected to Notion');
      flow.sourceId = source.id;
    } else {
      const name = (body.name ?? '').trim();
      if (!PROJECT_NAME_RE.test(name)) {
        throw new ValidationError('Source name must be 1-63 characters of lowercase letters, digits, "-" or "_", and start with a letter or digit');
      }
      if (await getSourceByName(db, id, name)) throw new ConflictError(`A source named "${name}" already exists in this project`);
      // The same validation a source created with a pasted token goes through, so a root list the
      // callback would refuse is refused here, before the person has been sent to Notion.
      const rootIds = NotionConfig.parse({ rootIds: body.rootIds ?? [] }).rootIds;
      flow.create = { name, rootIds };
    }

    const state = randomBytes(32).toString('base64url');
    setFlowCookie(reply, req, ctx, { ...flow, state, expiresAt: Date.now() + FLOW_TTL_SECONDS * 1000 });
    return reply.header('cache-control', 'no-store').send({ url: buildNotionAuthorizeUrl(settings, state) });
  });

  /**
   * Where Notion sends the browser back to. Everything that can be refused is refused before the
   * authorization code is spent, and the flow cookie is cleared on every path: it is single-use.
   *
   * What is refused, and how it answers: no cookie, an expired flow or a different `state` comes back to
   * the dashboard as `?notion_oauth=expired`; a different session, or an account that stopped being an
   * `editor` of the project in the meantime, as `?notion_oauth=forbidden`. **Those redirects name no
   * project**: the cookie is unsigned, so the project in it has not been shown to be this person's, and a
   * name must not be handed to someone who has not been checked against it. They leave no trace in the
   * sources and do not reach Notion. A person who pressed "Cancel" in Notion, or a code Notion refuses,
   * comes back with a reason and the project; an unreachable Notion is `502`.
   */
  app.get('/api/sources/notion/oauth/callback', async (req, reply) => {
    const principal = requireSession(req);
    if (!settings) throw new NotFoundError('Notion OAuth is not configured on this instance');
    const query = CallbackQuery.parse(req.query ?? {});

    const flow = readFlowCookie(req);
    clearFlowCookie(reply, req, ctx);
    const refuse = (outcome: 'expired' | 'forbidden', why: string): FastifyReply => {
      log.warn({ outcome, why }, 'notion oauth callback refused');
      return reply.header('cache-control', 'no-store').redirect(`/?notion_oauth=${outcome}`, 302);
    };
    if (!flow || flow.expiresAt < Date.now()) return refuse('expired', 'no flow cookie, or it expired');
    if (!query.state || !sameValue(query.state, flow.state)) return refuse('expired', 'state mismatch');
    if (flow.sessionId !== principal.sessionId) return refuse('forbidden', 'different session');
    // Live, not what the cookie says: the account may have lost the project in the ten minutes since.
    if (!satisfies(await resolveProjectAccess(db, principal, flow.projectId), 'editor')) return refuse('forbidden', 'no longer an editor');
    const project = await getProjectById(db, flow.projectId);
    if (!project) throw new NotFoundError('Project not found');

    const back = (outcome: string): FastifyReply =>
      reply.header('cache-control', 'no-store').redirect(`/?notion_oauth=${outcome}#/${encodeURIComponent(project.name)}`, 302);

    if (query.error) return back(query.error === 'access_denied' ? 'denied' : 'failed');
    if (!query.code) throw new ValidationError('Notion did not send an authorization code');

    let grant: NotionTokenGrant;
    try {
      grant = await exchangeAuthorizationCode(settings, query.code);
    } catch (err) {
      if (!(err instanceof NotionOAuthError)) throw err;
      // The code and Notion's response body are not kept; the error code is all there is to log.
      log.warn({ code: err.code, status: err.status, projectId: project.id }, 'notion oauth code exchange failed');
      if (err.transient) {
        return reply
          .code(502)
          .send({ error: 'upstream_unavailable', message: 'Notion could not be reached to finish connecting. Try again in a moment.' });
      }
      return back('failed');
    }

    const secret = serializeOAuthSecret(oauthSecretFromGrant(grant));
    const oauth = oauthInfoOf(grant);

    if (flow.sourceId) {
      const sourceId = flow.sourceId;
      // The same lock a driver takes to refresh, so a run in flight cannot write its refreshed pair
      // over the one that was just authorised (or the other way round).
      const row = await notionOAuthLocks.runExclusive(sourceId, async () => {
        const existing = await getSource(db, project.id, sourceId);
        if (!existing || existing.type !== 'notion') throw new NotFoundError('Source not found');
        // One transaction: the new pair and the workspace it belongs to land together or not at all, so a
        // refused config can never leave a source holding an OAuth credential its settings do not mention.
        return db.transaction(async (tx) => {
          const trx = tx as unknown as Db;
          if (!(await replaceSourceSecretIfUnchanged(trx, sourceId, existing.secretEnc, secret, serviceOpts.keys))) {
            throw new ConflictError('The source changed while it was being reconnected; start again');
          }
          return updateSource(trx, project.id, sourceId, { oauth }, serviceOpts);
        });
      });
      ctx.audit.record(
        {
          action: 'PATCH /api/projects/:id/sources/:sid',
          projectId: project.id,
          targetType: 'sid',
          targetId: row.id,
          detail: { connection: 'notion-oauth' },
        },
        { principal, ip: req.ip || null, statusCode: 302 },
      );
      indexer.enqueue(project.id);
      return back('reconnected');
    }

    const create = flow.create;
    if (!create) throw new ValidationError('The Notion connection did not say what to create. Start it again from the dashboard.');
    let created;
    try {
      // Created without a secret and sealed straight after: `createSource` refuses a `{…}` secret
      // (`checkSecretAllowed`), which is what keeps the API from choosing the stored format.
      created = await createSource(
        db,
        project.id,
        {
          type: 'notion',
          name: create.name,
          config: { rootIds: create.rootIds },
          oauth,
          syncIntervalMinutes: config.SYNC_DEFAULT_INTERVAL_MINUTES || null,
        },
        serviceOpts,
      );
    } catch (err) {
      if (err instanceof ConflictError) return back('name_taken');
      throw err;
    }
    try {
      if (!(await replaceSourceSecretIfUnchanged(db, created.id, null, secret, serviceOpts.keys)))
        throw new ConflictError('The new source changed under the callback');
    } catch (err) {
      // A source that cannot hold its credential is worse than none: it would sit in the list failing every run.
      await deleteSource(db, project.id, created.id).catch((cleanup: unknown) =>
        log.error({ err: cleanup, sourceId: created.id }, 'could not remove a source whose OAuth credential was not saved'),
      );
      throw err;
    }
    ctx.audit.record(
      {
        action: 'POST /api/projects/:id/sources',
        projectId: project.id,
        targetType: 'sid',
        targetId: created.id,
        detail: { connection: 'notion-oauth' },
      },
      { principal, ip: req.ip || null, statusCode: 302 },
    );
    indexer.enqueue(project.id);
    return back('connected');
  });
};
