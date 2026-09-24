import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';

/**
 * A minimal, spec-just-enough OIDC provider for `oidc.itest.ts` (ADR-0077) — no `jose`, no new
 * dependency: `node:crypto` already does RSA key generation, JWK export and RS256 signing, and this
 * fixture needs nothing else. It runs in-process, on loopback, and `src/auth/oidc/client.ts`'s
 * `isLoopbackIssuer` check is exactly what lets `discover()` talk to it over plain HTTP.
 *
 * Deliberately not a browser-driven flow: a test drives `/api/auth/oidc/login` and
 * `/api/auth/oidc/callback` with `fetch(..., { redirect: 'manual' })`, following the `Location`
 * headers by hand, the same way a browser would without actually being one. `setNextIdentity`,
 * `denyNextAuthorization` and `tamperNextIdToken` are the knobs a test needs to control what the
 * "provider" decides — there is no login form here to click through.
 */

export interface OidcProviderIdentity {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
}

/**
 * Corrupts one aspect of the *next* ID token this fixture issues, so a test can prove
 * `completeAuthorizationCodeGrant` (`src/auth/oidc/client.ts`, via `openid-client`) actually
 * rejects it rather than only ever being exercised with a token that would pass anyway
 * ([MAJOR-3], tur 2 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)). Each field replaces what the
 * token would otherwise have carried; `corruptSignature` flips a bit of the decoded signature's
 * first byte after signing (not the last — see the comment at the `/token` handler for why), so the
 * claims are internally consistent but the signature no longer matches them.
 */
export interface IdTokenTampering {
  issOverride?: string;
  audOverride?: string;
  nonceOverride?: string;
  /**
   * Omits the `nonce` claim entirely, as if the provider never echoed it back — distinct from
   * `nonceOverride`, which always forces a *truthy* value. A truthy override is caught by
   * `openid-client`'s own "unexpected nonce claim" check even with no `expectedNonce` passed, which
   * would let a client that never sent or checked a nonce at all pass that specific test by accident.
   * `dropNonce` proves the flow's nonce is genuinely requested and verified, since a legitimate flow's
   * ID token always carries the nonce it asked for ([MAJOR-3], tur 2 review of
   * [ADR-0077](../../.ssot/ADR.md#adr-0077)).
   */
  dropNonce?: boolean;
  corruptSignature?: boolean;
}

export interface LocalOidcProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The identity the next successful `/authorize` redirect will carry through to the ID token. */
  setNextIdentity(identity: OidcProviderIdentity): void;
  /** Makes the next `/authorize` request come back as `error=access_denied`, once. */
  denyNextAuthorization(): void;
  /** Applies to the very next `/token` exchange only, then clears itself — see {@link IdTokenTampering}. */
  tamperNextIdToken(tampering: IdTokenTampering): void;
  close(): Promise<void>;
}

interface PendingAuthorization {
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  clientId: string;
  identity: OidcProviderIdentity;
}

const DEFAULT_IDENTITY: OidcProviderIdentity = {
  sub: 'user-1',
  email: 'user1@example.test',
  preferred_username: 'user1',
  name: 'Test User',
};

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

async function s256(verifier: string): Promise<string> {
  const digest = crypto.createHash('sha256').update(verifier).digest();
  return base64url(digest);
}

function signIdToken(privateKey: crypto.KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startLocalOidcProvider(): Promise<LocalOidcProvider> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };

  const clientId = 'test-client';
  const clientSecret = 'test-secret';
  const codes = new Map<string, PendingAuthorization>();
  let nextIdentity: OidcProviderIdentity = DEFAULT_IDENTITY;
  let denyNext = false;
  let tampering: IdTokenTampering | null = null;
  let issuer = '';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
            scopes_supported: ['openid', 'profile', 'email'],
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state') ?? '';
        if (!redirectUri) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('missing redirect_uri');
          return;
        }
        const target = new URL(redirectUri);
        if (denyNext) {
          denyNext = false;
          target.searchParams.set('error', 'access_denied');
          if (state) target.searchParams.set('state', state);
          res.writeHead(302, { location: target.href });
          res.end();
          return;
        }
        const code = randomUUID();
        codes.set(code, {
          redirectUri,
          nonce: url.searchParams.get('nonce') ?? '',
          codeChallenge: url.searchParams.get('code_challenge') ?? '',
          clientId: url.searchParams.get('client_id') ?? '',
          identity: nextIdentity,
        });
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        res.writeHead(302, { location: target.href });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(await readBody(req));
        const pending = codes.get(body.get('code') ?? '');
        if (pending) codes.delete(body.get('code') ?? '');
        if (!pending || body.get('grant_type') !== 'authorization_code') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (body.get('client_id') !== clientId || body.get('client_secret') !== clientSecret) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        const verifier = body.get('code_verifier') ?? '';
        if ((await s256(verifier)) !== pending.codeChallenge) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const applied = tampering;
        tampering = null; // consumed once, same as denyNext
        const now = Math.floor(Date.now() / 1000);
        let idToken = signIdToken(privateKey, kid, {
          iss: applied?.issOverride ?? issuer,
          sub: pending.identity.sub,
          aud: applied?.audOverride ?? (pending.clientId || clientId),
          exp: now + 3600,
          iat: now,
          nonce: applied?.dropNonce ? undefined : (applied?.nonceOverride ?? (pending.nonce || undefined)),
          email: pending.identity.email,
          preferred_username: pending.identity.preferred_username,
          name: pending.identity.name,
        });
        if (applied?.corruptSignature) {
          const parts = idToken.split('.');
          // Flips a bit in the *first* signature byte, not the last: base64url's final group for a
          // 256-byte RSA signature has four low bits that a decoder discards on the way back to bytes,
          // so mutating only the trailing character can silently decode to the exact same signature —
          // this actually changes the bytes `crypto.verify` sees.
          const sigBytes = Buffer.from(parts[2] ?? '', 'base64url');
          sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
          idToken = `${parts[0]}.${parts[1]}.${base64url(sigBytes)}`;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: randomUUID(),
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })().catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the local OIDC provider fixture did not bind a port');
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    setNextIdentity(identity) {
      nextIdentity = identity;
    },
    denyNextAuthorization() {
      denyNext = true;
    },
    tamperNextIdToken(next) {
      tampering = next;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
