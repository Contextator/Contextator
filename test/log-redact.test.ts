import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, redactUrl, serializeRequest } from '../src/log-redact.js';

describe('redactUrl', () => {
  it.each([
    ['/api/auth/oidc/callback?code=abc123&state=xyz789', `/api/auth/oidc/callback?code=${REDACTED_VALUE}&state=${REDACTED_VALUE}`],
    [
      '/api/sources/notion/oauth/callback?code=n0tion&state=s7ate',
      `/api/sources/notion/oauth/callback?code=${REDACTED_VALUE}&state=${REDACTED_VALUE}`,
    ],
    [
      '/oauth/authorize?response_type=code&client_id=c1&state=opaque&code_challenge=chal&redirect_uri=http%3A%2F%2Flocalhost%2Fcb',
      `/oauth/authorize?response_type=code&client_id=c1&state=${REDACTED_VALUE}&code_challenge=chal&redirect_uri=http%3A%2F%2Flocalhost%2Fcb`,
    ],
    [
      '/api/sources/notion/oauth/callback?error=access_denied&state=s7ate',
      `/api/sources/notion/oauth/callback?error=access_denied&state=${REDACTED_VALUE}`,
    ],
    ['/cb?a=1&code=x=y%3D&b=2', `/cb?a=1&code=${REDACTED_VALUE}&b=2`],
    ['/cb?code=A&code=B', `/cb?code=${REDACTED_VALUE}&code=${REDACTED_VALUE}`],
    ['/cb?state=A&x=1&state=B', `/cb?state=${REDACTED_VALUE}&x=1&state=${REDACTED_VALUE}`],
    ['/cb?st%61te=S', `/cb?st%61te=${REDACTED_VALUE}`],
    ['/cb?cod%65=secret', `/cb?cod%65=${REDACTED_VALUE}`],
    ['/cb?code=secret#frag', `/cb?code=${REDACTED_VALUE}#frag`],
  ])('redacts code and state in %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });

  it.each([
    '/api/auth/oidc/callback',
    '/api/projects?limit=10&q=state',
    '/api/projects?statement=1&barcode=2&code_challenge=3',
    '/health',
    '/cb?code&state',
    '/cb?',
    '/',
  ])('leaves %s unchanged', (input) => {
    expect(redactUrl(input)).toBe(input);
  });

  it('never lets a secret value through', () => {
    expect(redactUrl('/api/auth/oidc/callback?code=SECRET-CODE&state=SECRET-STATE')).not.toMatch(/SECRET/);
  });
});

describe('serializeRequest', () => {
  it('keeps the default fields and redacts the URL', () => {
    const out = serializeRequest({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=abc&state=def&iss=https%3A%2F%2Fidp',
      host: 'docs.example.com',
      ip: '10.0.0.1',
      headers: { 'accept-version': '1.0.0' },
      socket: { remotePort: 5555 },
    });
    expect(out).toEqual({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=${REDACTED_VALUE}&state=${REDACTED_VALUE}&iss=https%3A%2F%2Fidp`,
      version: '1.0.0',
      host: 'docs.example.com',
      remoteAddress: '10.0.0.1',
      remotePort: 5555,
    });
  });

  it('is what the request log lines are written with', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: 'debug', serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
    });
    app.get('/api/auth/oidc/callback', async () => 'ok');
    await app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=SECRET-CODE&state=SECRET-STATE&keep=1' });
    await app.close();
    const logged = lines.join('\n');
    expect(logged).toContain(`code=${REDACTED_VALUE}`);
    expect(logged).toContain('keep=1');
    expect(logged).not.toMatch(/SECRET/);
  });
});
