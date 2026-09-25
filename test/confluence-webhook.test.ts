import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { confluenceEventOf, decideConfluenceEvent } from '../src/services/confluence-webhook.js';
import { verifyConfluenceSignature, verifyWebhook } from '../src/services/webhook-verify.js';

const SECRET = 'confluence-webhook-secret-for-tests';
const body = Buffer.from(JSON.stringify({ event: 'page_updated', timestamp: 1_758_000_000_000, userKey: 'ff80', page: { id: 98_311 } }));
const sign = (raw: Buffer, key = SECRET) => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;

describe('verifyConfluenceSignature', () => {
  it('accepts the signature Confluence Data Center sends, over the raw body', () => {
    expect(verifyConfluenceSignature({ 'x-hub-signature': sign(body) }, body, SECRET)).toBe(true);
    // Header values arrive lower-cased by Node, and a repeated header as an array.
    expect(verifyConfluenceSignature({ 'x-hub-signature': [sign(body)] }, body, SECRET)).toBe(true);
    expect(verifyConfluenceSignature({ 'x-hub-signature': sign(body).toUpperCase().replace('SHA256=', 'sha256=') }, body, SECRET)).toBe(true);
  });

  it('refuses another key, another body and no header at all', () => {
    expect(verifyConfluenceSignature({ 'x-hub-signature': sign(body, 'somebody-else') }, body, SECRET)).toBe(false);
    const moved = Buffer.from(body.toString('utf8').replace('98311', '98312'));
    expect(verifyConfluenceSignature({ 'x-hub-signature': sign(body) }, moved, SECRET)).toBe(false);
    // Unsigned is refused, never trusted — which is what the route's "invalid secret" test leans on.
    expect(verifyConfluenceSignature({}, body, SECRET)).toBe(false);
    expect(verifyConfluenceSignature({ 'x-hub-signature': '' }, body, SECRET)).toBe(false);
  });

  it('refuses a bare hex digest and the other algorithms, so the scheme is part of what is checked', () => {
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyConfluenceSignature({ 'x-hub-signature': hex }, body, SECRET)).toBe(false);
    expect(verifyConfluenceSignature({ 'x-hub-signature': `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}` }, body, SECRET)).toBe(
      false,
    );
  });

  it('does not accept the headers of the other routes', () => {
    // Each route has its own function; a GitHub or Notion signature header is not a Confluence one.
    expect(verifyConfluenceSignature({ 'x-hub-signature-256': sign(body) }, body, SECRET)).toBe(false);
    expect(verifyConfluenceSignature({ 'x-notion-signature': sign(body) }, body, SECRET)).toBe(false);
    // And the git dispatcher is unchanged by this function's existence.
    expect(verifyWebhook({ 'x-hub-signature': sign(body) }, body, SECRET)).toEqual({ ok: true, provider: 'bitbucket' });
  });
});

describe('confluenceEventOf', () => {
  it('reads the event name, and nothing that is not one', () => {
    expect(confluenceEventOf(JSON.parse(body.toString('utf8')))).toBe('page_updated');
    expect(confluenceEventOf({ type: 'page.content_updated' })).toBeNull();
    expect(confluenceEventOf({ event: '' })).toBeNull();
    expect(confluenceEventOf({ event: 42 })).toBeNull();
    expect(confluenceEventOf({ event: 'x'.repeat(101) })).toBeNull();
    expect(confluenceEventOf(null)).toBeNull();
    expect(confluenceEventOf('page_updated')).toBeNull();
  });
});

describe('decideConfluenceEvent', () => {
  it.each(['page_created', 'page_updated', 'page_moved', 'page_removed', 'page_trashed', 'page_restored'])(
    'queues %s, which is content the driver indexes',
    (event) => {
      expect(decideConfluenceEvent(event)).toEqual({ queue: true, reason: event });
    },
  );

  it.each(['content_permissions_updated', 'space_permissions_updated', 'space_removed'])(
    'queues %s, because it can change what this account may read',
    (event) => {
      expect(decideConfluenceEvent(event).queue).toBe(true);
    },
  );

  it.each([
    'comment_created',
    'comment_updated',
    'comment_removed',
    'user_created',
    'group_removed',
    'label_added',
    'attachment_created',
    'relation_created',
    'blog_created',
    'blog_updated',
    'blog_removed',
    'theme_enabled',
    'space_logo_updated',
  ])('queues nothing for %s, and says why', (event) => {
    const decision = decideConfluenceEvent(event);
    expect(decision.queue).toBe(false);
    expect(decision.reason).toContain(event);
  });

  it('queues an event this build has never heard of, and a body with no event at all', () => {
    expect(decideConfluenceEvent('page_something_new').queue).toBe(true);
    expect(decideConfluenceEvent(null)).toEqual({ queue: true, reason: 'unrecognised delivery; indexing anyway' });
  });
});
