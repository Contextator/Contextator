import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthorizationCodeStore, redirectUriAllowed, redirectUriRegistered, s256Challenge } from '../src/services/auth/oauth.js';
import type { OauthClientRow } from '../src/db/schema.js';

/**
 * The parts of the authorization server that are a decision rather than a query
 * ([ADR-0054](../.ssot/ADR.md#adr-0054)): the PKCE check, the code's single use, and the redirect-URI
 * comparison. All three are what stands between an authorization code and somebody who is not the
 * client it was issued to, and none of them needs a database to be checked.
 */

const grant = {
  clientId: 'ctxc_client',
  projectId: 'project-uuid',
  userId: 'user-uuid',
  redirectUri: 'https://client.example/cb',
  resource: 'https://docs.example/mcp/handbook',
  credentialsEpoch: 0,
};

const verifier = () => randomBytes(32).toString('base64url');

describe('the authorization code store', () => {
  it('hands back the grant to whoever holds the verifier the challenge was made from', () => {
    const codes = new AuthorizationCodeStore();
    const v = verifier();
    const code = codes.issue({ ...grant, codeChallenge: s256Challenge(v) });
    const redeemed = codes.redeem(code, v);
    expect(redeemed).toMatchObject({ userId: 'user-uuid', projectId: 'project-uuid', clientId: 'ctxc_client' });
  });

  it('refuses a verifier that is not the one, however well-formed', () => {
    const codes = new AuthorizationCodeStore();
    const code = codes.issue({ ...grant, codeChallenge: s256Challenge(verifier()) });
    expect(codes.redeem(code, verifier())).toEqual({ error: expect.stringContaining('code_verifier') });
  });

  /**
   * RFC 6749 §4.1.2: a code is single-use. It is consumed on a **failed** exchange too, and that is
   * the case that matters — a code somebody presented with the wrong verifier is a code that may be in
   * the wrong hands, and leaving it live for the real client to retry leaves it live for them.
   */
  it('consumes a code whether the exchange succeeded or failed', () => {
    const codes = new AuthorizationCodeStore();
    const good = verifier();
    const first = codes.issue({ ...grant, codeChallenge: s256Challenge(good) });
    expect(codes.redeem(first, good)).toMatchObject({ userId: 'user-uuid' });
    expect(codes.redeem(first, good)).toEqual({ error: expect.stringContaining('already used') });

    const second = codes.issue({ ...grant, codeChallenge: s256Challenge(good) });
    expect(codes.redeem(second, verifier())).toEqual({ error: expect.stringContaining('code_verifier') });
    expect(codes.redeem(second, good)).toEqual({ error: expect.stringContaining('already used') });
    expect(codes.size()).toBe(0);
  });

  it('expires a code rather than leaving it usable, and forgets it on the way past', () => {
    const codes = new AuthorizationCodeStore();
    const v = verifier();
    const code = codes.issue({ ...grant, codeChallenge: s256Challenge(v) }, -1);
    expect(codes.redeem(code, v)).toEqual({ error: expect.stringContaining('expired') });
    expect(codes.size()).toBe(0);
  });

  it('never hands the grant to an empty verifier, which is what a client that skipped PKCE sends', () => {
    const codes = new AuthorizationCodeStore();
    const code = codes.issue({ ...grant, codeChallenge: s256Challenge(verifier()) });
    expect(codes.redeem(code, '')).toEqual({ error: expect.anything() });
  });

  it('issues codes that are distinct and prefixed so one is recognisable in a log', () => {
    const codes = new AuthorizationCodeStore();
    const issued = Array.from({ length: 50 }, () => codes.issue({ ...grant, codeChallenge: s256Challenge(verifier()) }));
    expect(new Set(issued).size).toBe(50);
    for (const code of issued) expect(code).toMatch(/^ctxo_[0-9a-f]{64}$/);
  });
});

describe('the PKCE challenge', () => {
  it('is the RFC 7636 S256 transformation, checked against the specification’s own vector', () => {
    // RFC 7636 Appendix B.
    expect(s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('the redirect URI comparison', () => {
  const client = { clientId: 'ctxc_client', redirectUris: ['https://client.example/cb'] } as OauthClientRow;

  it('accepts exactly what was registered', () => {
    expect(redirectUriRegistered(client, 'https://client.example/cb')).toBe(true);
  });

  /**
   * The negative half is the reason this function exists. A prefix match would accept every line
   * below, and the authorization code is handed to whatever the browser is sent to — which is the
   * open redirect of this flow rather than a cosmetic strictness.
   */
  it('refuses anything that merely starts with it, or differs from it at all', () => {
    for (const uri of [
      'https://client.example/cb.attacker.test',
      'https://client.example/cb/../elsewhere',
      'https://client.example/cb?next=https://attacker.test',
      'https://client.example/cb#x',
      'http://client.example/cb',
      'https://client.example:443/cb',
      'https://client.example/CB',
      'https://attacker.test/cb',
      '',
    ]) {
      expect(redirectUriRegistered(client, uri)).toBe(false);
    }
  });
});

/**
 * Which redirect URIs a registration may carry, by RFC 7591 `application_type`. The absent row is the
 * one that matters for compatibility: every connector registered before the field was read sends
 * none, and its answers must be the ones it always got.
 */
describe('the redirect URI a registration may carry', () => {
  const table: Array<[string, { absent: boolean; native: boolean; web: boolean }]> = [
    ['https://client.example/cb', { absent: true, native: true, web: true }],
    ['http://127.0.0.1:53682/cb', { absent: true, native: true, web: false }],
    ['http://localhost:53682/cb', { absent: true, native: true, web: false }],
    ['http://[::1]:53682/cb', { absent: false, native: true, web: false }],
    ['http://127.0.0.2/cb', { absent: false, native: true, web: false }],
    ['https://localhost/cb', { absent: true, native: true, web: false }],
    ['https://127.0.0.1/cb', { absent: true, native: true, web: false }],
    // Spellings that name loopback without being a loopback literal: refused to `web`, and not taken
    // as a loopback `http` callback for `native` either, since a resolver may send them elsewhere.
    ['https://app.localhost/cb', { absent: true, native: true, web: false }],
    ['https://localhost./cb', { absent: true, native: true, web: false }],
    ['https://[::ffff:127.0.0.1]/cb', { absent: true, native: true, web: false }],
    ['http://app.localhost/cb', { absent: false, native: false, web: false }],
    ['com.example.app:/cb', { absent: false, native: true, web: false }],
    ['com.example.app://oauth/cb', { absent: false, native: true, web: false }],
    ['http://client.example/cb', { absent: false, native: false, web: false }],
    ['http://127.0.0.1.attacker.test/cb', { absent: false, native: false, web: false }],
    ['myapp:/cb', { absent: false, native: false, web: false }],
    ['file:///etc/passwd', { absent: false, native: false, web: false }],
    ['ftp://client.example/cb', { absent: false, native: false, web: false }],
    ['not a url', { absent: false, native: false, web: false }],
  ];

  for (const [uri, expected] of table) {
    it(`answers ${uri} as absent=${expected.absent}, native=${expected.native}, web=${expected.web}`, () => {
      expect(redirectUriAllowed(uri, undefined)).toBe(expected.absent);
      expect(redirectUriAllowed(uri, 'native')).toBe(expected.native);
      expect(redirectUriAllowed(uri, 'web')).toBe(expected.web);
    });
  }
});
