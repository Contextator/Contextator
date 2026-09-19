import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getSourceById } from '../services/sources.js';
import { pushedBranches, verifyWebhook } from '../services/webhook-verify.js';

const Params = z.object({ sourceId: z.uuid() });

/**
 * `POST /api/webhooks/git/:sourceId` — push notifications from GitHub/GitLab/Bitbucket/Gitea.
 * Registered as its own plugin (outside adminRoutes) because it authenticates with the per-source
 * webhook secret instead of ADMIN_TOKEN, and needs the raw body for HMAC verification.
 */
export const webhookRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, indexer, log } = ctx;

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/api/webhooks/git/:sourceId', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const source = await getSourceById(db, parsed.data.sourceId);
    if (!source || source.type !== 'git' || !source.webhookSecret) return reply.code(404).send({ error: 'not_found' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    const { ok, provider } = verifyWebhook(req.headers, raw, source.webhookSecret);
    if (!ok) {
      log.warn({ sourceId: source.id, provider }, 'webhook signature rejected');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    // Form-encoded deliveries (GitHub "application/x-www-form-urlencoded") wrap the JSON in `payload=`.
    let payload: unknown = null;
    try {
      const text = raw.toString('utf8');
      payload = text.startsWith('payload=') ? JSON.parse(decodeURIComponent(text.slice('payload='.length).replace(/\+/g, ' '))) : JSON.parse(text);
    } catch {
      payload = null;
    }
    const branch = (source.config as { branch?: string }).branch ?? 'main';
    const branches = pushedBranches(payload);
    if (branches.length > 0 && !branches.includes(branch)) {
      return reply.code(202).send({ queued: false, reason: `push to ${branches.join(', ')} ignored; source tracks ${branch}` });
    }
    // The interactive lane: a push is somebody waiting, and it must not queue behind the timer's
    // backlog ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
    const job = indexer.enqueue(source.projectId, { trigger: 'webhook' });
    log.info({ sourceId: source.id, provider, branches }, 'webhook accepted; re-index queued');
    return reply.code(202).send({ queued: true, job: { phase: job.phase, queuedAt: job.queuedAt } });
  });
};
