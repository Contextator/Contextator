import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Push-webhook verification for the git hosting services (pure, unit-tested):
 * - GitHub: `X-Hub-Signature-256: sha256=<hex hmac>`
 * - Gitea / Forgejo: `X-Gitea-Signature: <hex hmac>` (newer versions also send X-Hub-Signature-256)
 * - Bitbucket Cloud: `X-Hub-Signature: sha256=<hex hmac>`
 * - GitLab: `X-Gitlab-Token: <the secret itself>`
 */

export type WebhookHeaders = Record<string, string | string[] | undefined>;

function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function hmacMatches(rawBody: Buffer, secret: string, provided: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(
    expected,
    provided
      .replace(/^sha256=/i, '')
      .trim()
      .toLowerCase(),
  );
}

export function verifyWebhook(headers: WebhookHeaders, rawBody: Buffer, secret: string): { ok: boolean; provider: string } {
  const gitlab = header(headers, 'x-gitlab-token');
  if (gitlab !== undefined) return { ok: safeEqual(gitlab, secret), provider: 'gitlab' };
  const gitea = header(headers, 'x-gitea-signature') ?? header(headers, 'x-forgejo-signature');
  if (gitea !== undefined) return { ok: hmacMatches(rawBody, secret, gitea), provider: 'gitea' };
  const github = header(headers, 'x-hub-signature-256');
  if (github !== undefined) return { ok: hmacMatches(rawBody, secret, github), provider: header(headers, 'x-github-event') ? 'github' : 'generic' };
  const bitbucket = header(headers, 'x-hub-signature');
  if (bitbucket !== undefined) return { ok: hmacMatches(rawBody, secret, bitbucket), provider: 'bitbucket' };
  return { ok: false, provider: 'unknown' };
}

/**
 * Notion's signature ([ADR-0049](../../.ssot/ADR.md#adr-0049)):
 * `X-Notion-Signature: sha256=<hex hmac>` over the **raw** body, keyed with the `verification_token`
 * Notion generated and this product captured.
 *
 * **Deliberately not a fifth branch of `verifyWebhook`.** That function dispatches across providers by
 * header, so a Notion branch inside it would teach `/api/webhooks/git/:id` to accept
 * `X-Notion-Signature` — a header whose secret arrives *inbound*, on a route whose secret does not.
 * The two share `hmacMatches` and nothing else.
 *
 * The raw body is the whole point and Notion's own documentation says so: re-serialised JSON produces
 * different bytes and fails, which is why the route hands the buffer Fastify parsed nothing out of.
 */
export function verifyNotionSignature(headers: WebhookHeaders, rawBody: Buffer, secret: string): boolean {
  const provided = header(headers, 'x-notion-signature');
  if (provided === undefined) return false;
  return hmacMatches(rawBody, secret, provided);
}

/** Branch names a push payload touches (empty when the payload shape is unknown → treat as "any"). */
export function pushedBranches(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { ref?: unknown; push?: { changes?: Array<{ new?: { type?: string; name?: string } | null }> } };
  if (typeof p.ref === 'string') {
    return p.ref.startsWith('refs/heads/') ? [p.ref.slice('refs/heads/'.length)] : [];
  }
  if (Array.isArray(p.push?.changes)) {
    return p.push.changes.map((c) => (c.new?.type === 'branch' && c.new.name ? c.new.name : '')).filter(Boolean);
  }
  return [];
}
