import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { decryptWebhookSecret, keyringOf, type SecretKeyring } from '../services/crypto.js';
import { confluenceEventOf, decideConfluenceEvent } from '../services/confluence-webhook.js';
import { captureVerificationToken, decideEvent, eventTypeOf, minIntervalOf, noteDelivery, verificationTokenOf } from '../services/notion-webhook.js';
import { getSourceById } from '../services/sources.js';
import { pushedBranches, verifyConfluenceSignature, verifyNotionSignature, verifyWebhook } from '../services/webhook-verify.js';

const Params = z.object({ sourceId: z.uuid() });

/**
 * The stored webhook secret, opened, or `null` when no key in the ring can open it.
 *
 * Unreadable is not the sender's fault, but it is answered like a bad signature anyway: an
 * unauthenticated caller learns nothing about this instance's key state, and the operator learns it
 * from the log line beside the call ([ADR-0075](../../.ssot/ADR.md#adr-0075)). The secret itself never
 * reaches a log — only the source id does.
 */
function openWebhookSecret(stored: string, keys: SecretKeyring): string | null {
  try {
    return decryptWebhookSecret(stored, keys);
  } catch {
    return null;
  }
}

/**
 * The three routes that authenticate themselves: `POST /api/webhooks/git/:sourceId` (push notifications
 * from GitHub/GitLab/Bitbucket/Gitea), `POST /api/webhooks/notion/:sourceId` and
 * `POST /api/webhooks/confluence/:sourceId`. Registered as their own plugin (outside adminRoutes) because they authenticate with the per-source webhook secret
 * instead of ADMIN_TOKEN, and need the raw body for HMAC verification.
 *
 * **The two differ in where the secret came from**, and that is the whole of
 * [ADR-0049](../../.ssot/ADR.md#adr-0049): git's was generated here and carried outward by the
 * operator, Notion's is minted by Notion, POSTed once unsigned, and storable only inside a window an
 * editor opened. Confluence's is git's direction again — generated here, pasted into Confluence's
 * webhook form — but, unlike git's, it does not exist until an editor asks for one.
 */
export const webhookRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config, indexer, log } = ctx;
  const keys = keyringOf(config);

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/api/webhooks/git/:sourceId', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const source = await getSourceById(db, parsed.data.sourceId);
    if (!source || source.type !== 'git' || !source.webhookSecret) return reply.code(404).send({ error: 'not_found' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    const secret = openWebhookSecret(source.webhookSecret, keys);
    if (secret === null) {
      log.warn({ sourceId: source.id }, 'webhook secret cannot be decrypted with the configured keys; regenerate it for this source');
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    const { ok, provider } = verifyWebhook(req.headers, raw, secret);
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

  /**
   * `POST /api/webhooks/notion/:sourceId` — one URL, two bodies
   * ([ADR-0049](../../.ssot/ADR.md#adr-0049)).
   *
   * **Everything that is not a refusal answers `200`.** Notion's published specification says to
   * "return an HTTP 200 status code to indicate that the data was received successfully", nothing
   * documents whether another `2xx` counts, and the cost of guessing wrong is eight retries and then a
   * subscription switched off for repeated delivery failures — silent staleness on a source the
   * dashboard says is healthy. The git route above keeps its `202`; this one answers what its sender
   * asked for.
   */
  app.post('/api/webhooks/notion/:sourceId', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const source = await getSourceById(db, parsed.data.sourceId);
    if (!source || source.type !== 'notion') return reply.code(404).send({ error: 'not_found' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    let payload: unknown = null;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      payload = null;
    }

    // The one-time, **unsigned** body Notion POSTs when a subscription is created. It is accepted only
    // while an editor's window is open, and the same statement closes that window — so the first token
    // stored wins and a second POST cannot take the source over. Outside a window nothing is written at
    // all, which is the difference between refusing a request and being configured by one.
    const token = verificationTokenOf(payload);
    if (token !== null) {
      if (!(await captureVerificationToken(db, source.id, token, keys))) {
        log.warn({ sourceId: source.id }, 'notion webhook verification token refused: no window open');
        return reply.code(401).send({ error: 'verification_not_open' });
      }
      log.info({ sourceId: source.id }, 'notion webhook verification token captured; show it to the operator');
      return reply.code(200).send({ verified: true });
    }

    // A source whose window expired without a token is **not broken**: it syncs on its interval, and
    // this is the only place that has to say so.
    if (!source.webhookSecret) {
      log.warn({ sourceId: source.id }, 'notion webhook delivery for a source that was never verified');
      return reply.code(401).send({ error: 'not_verified' });
    }
    const secret = openWebhookSecret(source.webhookSecret, keys);
    if (secret === null) {
      log.warn({ sourceId: source.id }, 'notion webhook secret cannot be decrypted with the configured keys; re-verify this source');
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    if (!verifyNotionSignature(req.headers, raw, secret)) {
      log.warn({ sourceId: source.id }, 'notion webhook signature rejected');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const type = eventTypeOf(payload);
    const decision = decideEvent(type);
    if (!decision.queue) return reply.code(200).send({ queued: false, reason: decision.reason });

    // Never `enqueue` unconditionally: a bulk move or a script touching two hundred pages is two
    // hundred deliveries, each of which would otherwise ask for its own pull of the same workspace.
    const delivery = await noteDelivery(db, source, minIntervalOf(source, config.WEBHOOK_MIN_INTERVAL_MINUTES));
    if (!delivery.enqueueNow) {
      log.info({ sourceId: source.id, type, dueAt: delivery.dueAt }, 'notion webhook accepted; run already due');
      return reply.code(200).send({ queued: false, reason: 'within the minimum inter-run interval', dueAt: delivery.dueAt });
    }
    // The interactive lane, the value the git route already uses: a delivery is somebody's edit, and it
    // must not queue behind the timer's backlog ([ADR-0048](../../.ssot/ADR.md#adr-0048)).
    const job = indexer.enqueue(source.projectId, { trigger: 'webhook' });
    log.info({ sourceId: source.id, type }, 'notion webhook accepted; re-index queued');
    return reply.code(200).send({ queued: true, job: { phase: job.phase, queuedAt: job.queuedAt } });
  });

  /**
   * `POST /api/webhooks/confluence/:sourceId` — deliveries from Confluence Data Center's webhooks
   * (7.7+), or from anything else that signs its body the same way.
   *
   * **The window is the secret's existence.** A Confluence source is created with no webhook secret,
   * and until an editor generates one through the admin API every delivery is refused with
   * `not_enabled` and nothing is written — the half of [ADR-0049](../../.ssot/ADR.md#adr-0049) that
   * matters, "refused and not stored". There is no inbound secret to capture: a body that looks like
   * Notion's `verification_token` is just an unsigned delivery here, and is refused like one.
   *
   * After that it is the Notion route's second half unchanged: signature over the raw body, a filter
   * for events that cannot change indexed content, the debounce, and the interactive lane. Every
   * non-refusal answers `200`, because a Data Center webhook counts anything else as a failure and
   * stops delivering after a run of them.
   */
  app.post('/api/webhooks/confluence/:sourceId', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const source = await getSourceById(db, parsed.data.sourceId);
    if (!source || source.type !== 'confluence') return reply.code(404).send({ error: 'not_found' });

    if (!source.webhookSecret) {
      log.warn({ sourceId: source.id }, 'confluence webhook delivery for a source whose webhook is not enabled');
      return reply.code(401).send({ error: 'not_enabled' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    const secret = openWebhookSecret(source.webhookSecret, keys);
    if (secret === null) {
      log.warn({ sourceId: source.id }, 'confluence webhook secret cannot be decrypted with the configured keys; regenerate it for this source');
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    if (!verifyConfluenceSignature(req.headers, raw, secret)) {
      log.warn({ sourceId: source.id }, 'confluence webhook signature rejected');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      payload = null;
    }
    const event = confluenceEventOf(payload);
    const decision = decideConfluenceEvent(event);
    if (!decision.queue) return reply.code(200).send({ queued: false, reason: decision.reason });

    const delivery = await noteDelivery(db, source, minIntervalOf(source, config.WEBHOOK_MIN_INTERVAL_MINUTES));
    if (!delivery.enqueueNow) {
      log.info({ sourceId: source.id, event, dueAt: delivery.dueAt }, 'confluence webhook accepted; run already due');
      return reply.code(200).send({ queued: false, reason: 'within the minimum inter-run interval', dueAt: delivery.dueAt });
    }
    const job = indexer.enqueue(source.projectId, { trigger: 'webhook' });
    log.info({ sourceId: source.id, event }, 'confluence webhook accepted; re-index queued');
    return reply.code(200).send({ queued: true, job: { phase: job.phase, queuedAt: job.queuedAt } });
  });
};
