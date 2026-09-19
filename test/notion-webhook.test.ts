import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decideEvent, eventTypeOf, minIntervalOf, verificationTokenOf } from '../src/services/notion-webhook.js';
import { verifyNotionSignature, verifyWebhook } from '../src/services/webhook-verify.js';
import type { DocumentSourceRow } from '../src/db/schema.js';

/**
 * The pure half of [ADR-0049](../.ssot/ADR.md#adr-0049): what a delivery is signed with, and which
 * deliveries are worth a run. The window, the debounce and the tick need a real `document_sources`
 * table and live in `test/integration/notion-webhook.itest.ts`.
 *
 * Nothing here reaches Notion. The bodies are the shapes its reference pages publish, signed here with
 * a token of this file's own choosing — which is exactly what the product will be handed.
 */

const token = 'secret_tMrlL1qK5vuQAh1b6cZGhFChZTSYJlce98V0pYn7yBl';
const body = Buffer.from(JSON.stringify({ type: 'page.content_updated', entity: { id: 'p1', type: 'page' } }));
const sign = (raw: Buffer, key = token) => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;

describe('verifyNotionSignature', () => {
  it('accepts a body signed with the captured verification token', () => {
    expect(verifyNotionSignature({ 'x-notion-signature': sign(body) }, body, token)).toBe(true);
  });

  it('refuses a body one byte different from the one that was signed', () => {
    // The raw body is the whole point: Notion's own note is that re-serialised JSON produces different
    // bytes and fails. One flipped byte is the smallest version of that.
    const mutated = Buffer.from(body);
    mutated[mutated.length - 2] ^= 0x01;
    expect(verifyNotionSignature({ 'x-notion-signature': sign(body) }, mutated, token)).toBe(false);
  });

  it('refuses a signature made with another token, and a missing header', () => {
    expect(verifyNotionSignature({ 'x-notion-signature': sign(body, 'secret_someone_else') }, body, token)).toBe(false);
    expect(verifyNotionSignature({}, body, token)).toBe(false);
    expect(verifyNotionSignature({ 'x-notion-signature': '' }, body, token)).toBe(false);
    // A hex digest of the right length but the wrong value, so the comparison cannot pass on length.
    expect(verifyNotionSignature({ 'x-notion-signature': `sha256=${'0'.repeat(64)}` }, body, token)).toBe(false);
  });

  it('does not teach the git route to accept X-Notion-Signature', () => {
    // The reason this is a separate function and not a fifth branch of `verifyWebhook`: that one
    // dispatches by header, and a Notion branch inside it would make the git endpoint — whose secret
    // this product generated — accept a header whose secret arrived inbound.
    expect(verifyWebhook({ 'x-notion-signature': sign(body) }, body, token)).toEqual({ ok: false, provider: 'unknown' });
  });
});

describe('the verification body', () => {
  it('is recognised by its token and nothing else', () => {
    expect(verificationTokenOf({ verification_token: token })).toBe(token);
    expect(verificationTokenOf({ type: 'page.created' })).toBeNull();
    expect(verificationTokenOf({ verification_token: '' })).toBeNull();
    expect(verificationTokenOf({ verification_token: 'x'.repeat(501) })).toBeNull();
    expect(verificationTokenOf(null)).toBeNull();
    expect(verificationTokenOf('garbage')).toBeNull();
  });
});

describe('which deliveries queue a run', () => {
  it('queues nothing for comments, which are not indexed', () => {
    for (const type of ['comment.created', 'comment.updated', 'comment.deleted']) {
      expect(decideEvent(type).queue).toBe(false);
    }
    // And it says why, because the route puts that reason in a 200 rather than an error.
    expect(decideEvent('comment.created').reason).toContain('comment.created');
  });

  it('queues nothing for a lock, which no driver reads', () => {
    expect(decideEvent('page.locked').queue).toBe(false);
    expect(decideEvent('page.unlocked').queue).toBe(false);
  });

  it('queues a run for the events that change bytes on disk', () => {
    for (const type of [
      'page.created',
      'page.content_updated',
      'page.properties_updated',
      'page.moved',
      'page.deleted',
      'page.undeleted',
      'database.created',
      'database.schema_updated',
      'database.content_updated',
      'data_source.schema_updated',
      'data_source.content_updated',
      'data_source.deleted',
    ]) {
      expect(decideEvent(type).queue).toBe(true);
    }
  });

  it('queues a run for an event type this build has never heard of', () => {
    // [ADR-0048](../.ssot/ADR.md#adr-0048)'s rule one layer out: every uncertainty resolves toward the
    // run. Notion adds event types, and a build that silently ignored a new one would be a source that
    // stopped syncing without anything to see.
    expect(decideEvent('page.transcription_block.transcript_deleted').queue).toBe(true);
    expect(decideEvent('view.created').queue).toBe(true);
    expect(decideEvent(null).queue).toBe(true);
    expect(decideEvent(eventTypeOf({ notype: 1 })).queue).toBe(true);
  });
});

describe('the minimum a source is debounced by', () => {
  const source = (webhookMinIntervalMinutes: number | null) => ({ webhookMinIntervalMinutes }) as DocumentSourceRow;

  it('is the instance default when the source names none, and the source when it does', () => {
    // NULL means "whatever the instance currently says" — not "never", which is what NULL means on the
    // scheduling column beside it. A debounce is a limit the instance imposes.
    expect(minIntervalOf(source(null), 5)).toBe(5);
    expect(minIntervalOf(source(30), 5)).toBe(30);
    // Zero is a value and not an absence: it means every delivery queues immediately.
    expect(minIntervalOf(source(0), 5)).toBe(0);
  });
});
