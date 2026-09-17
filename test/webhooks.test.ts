import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pushedBranches, verifyWebhook } from '../src/services/webhook-verify.js';

const secret = 'c0ffee'.repeat(8);
const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
const hmac = createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhook', () => {
  it('accepts GitHub, Gitea and Bitbucket HMAC signatures', () => {
    expect(verifyWebhook({ 'x-hub-signature-256': `sha256=${hmac}`, 'x-github-event': 'push' }, body, secret)).toEqual({ ok: true, provider: 'github' });
    expect(verifyWebhook({ 'x-gitea-signature': hmac }, body, secret)).toEqual({ ok: true, provider: 'gitea' });
    expect(verifyWebhook({ 'x-hub-signature': `sha256=${hmac}` }, body, secret)).toEqual({ ok: true, provider: 'bitbucket' });
  });

  it('accepts the GitLab shared token and rejects everything else', () => {
    expect(verifyWebhook({ 'x-gitlab-token': secret }, body, secret).ok).toBe(true);
    expect(verifyWebhook({ 'x-gitlab-token': 'wrong' }, body, secret).ok).toBe(false);
    expect(verifyWebhook({ 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body, secret).ok).toBe(false);
    expect(verifyWebhook({ 'x-hub-signature-256': `sha256=${hmac}` }, Buffer.from('tampered'), secret).ok).toBe(false);
    expect(verifyWebhook({}, body, secret)).toEqual({ ok: false, provider: 'unknown' });
  });
});

describe('pushedBranches', () => {
  it('reads GitHub/GitLab/Gitea refs and Bitbucket change lists', () => {
    expect(pushedBranches({ ref: 'refs/heads/main' })).toEqual(['main']);
    expect(pushedBranches({ ref: 'refs/tags/v1' })).toEqual([]);
    expect(pushedBranches({ push: { changes: [{ new: { type: 'branch', name: 'dev' } }, { new: null }, { new: { type: 'tag', name: 'v1' } }] } })).toEqual(['dev']);
    expect(pushedBranches('garbage')).toEqual([]);
  });
});
