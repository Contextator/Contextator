import * as client from 'openid-client';
import type { IDToken } from 'openid-client';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { OidcFlowState } from '../cookies.js';

export type { IDToken } from 'openid-client';

/** Whether an OIDC provider is configured — the feature's on/off switch (see `OIDC_ISSUER_URL` in config.ts). */
export function isOidcEnabled(config: Config): boolean {
  return config.OIDC_ISSUER_URL !== undefined;
}

/**
 * Discovery (`GET {issuer}/.well-known/openid-configuration`) is one network round trip; a process
 * this long-lived does it once and keeps the `Configuration`, same as every cache in this codebase
 * that trades a little staleness for not re-paying a fixed cost on every request. Keyed by
 * issuer+client id, not just issuer, so a test process that boots several instances with different
 * `OIDC_*` overrides never serves one instance's `Configuration` to another's — and cleared on
 * failure so a provider outage does not poison the cache for the rest of the process's life.
 *
 * Deliberately module-level rather than a field on `AppContext`: the alternative would touch
 * `context.ts`, `server.ts`'s context-construction site and every test fixture that builds an
 * `AppContext` by hand, for a value nothing outside this module ever reads.
 */
const discoveryCache = new Map<string, Promise<client.Configuration>>();

/** Test-only escape hatch: lets an integration test rotate a fixture's issuer without restarting the process. */
export function resetOidcDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

const isLoopbackIssuer = (issuer: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer);

/**
 * The short name `user_federated_identities.provider` and the audit row's `username` label use.
 * There is no separate `OIDC_PROVIDER_NAME` setting — the issuer's own host is already a stable,
 * unique, operator-free name for it, and a second setting naming the same provider a second time is
 * one more way for the two to quietly disagree.
 */
export function providerName(config: Config): string {
  try {
    return config.OIDC_ISSUER_URL ? new URL(config.OIDC_ISSUER_URL).hostname : 'oidc';
  } catch {
    return 'oidc';
  }
}

async function discover(config: Config): Promise<client.Configuration> {
  const issuer = config.OIDC_ISSUER_URL;
  const clientId = config.OIDC_CLIENT_ID;
  const clientSecret = config.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) throw new Error('OIDC is not configured (OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET)');

  const key = `${issuer}::${clientId}`;
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  // Only ever relaxes the HTTPS requirement for a loopback issuer — the local provider fixture the
  // integration test drives. A real deployment's issuer is never localhost, so this never fires there.
  const options = isLoopbackIssuer(issuer) ? { execute: [client.allowInsecureRequests] } : undefined;
  const discovered = client
    .discovery(new URL(issuer), clientId, clientSecret, undefined, options)
    .then((configuration) => {
      // openid-client leaves ID token JWS signature verification opt-in for the authorization code
      // flow — by default it validates claims (iss/aud/exp/nonce/…) but not that the signature over
      // them is genuine. That gap is invisible until a JWKS rotation, a compromised signing key or a
      // JWKS mix-up produces a token with valid-looking claims and a signature that does not match
      // them ([MAJOR-3], tur 2 review of [ADR-0077](../../../.ssot/ADR.md#adr-0077)). One call closes
      // it for every grant made against this `Configuration`.
      client.enableNonRepudiationChecks(configuration);
      return configuration;
    })
    .catch((err: unknown) => {
      discoveryCache.delete(key);
      throw err;
    });
  discoveryCache.set(key, discovered);
  return discovered;
}

/**
 * `OIDC_REDIRECT_URI` if the operator pinned one; otherwise derived from `PUBLIC_BASE_URL` or, absent
 * that, the request's own scheme and host — the same fallback `src/mcp/oauth-routes.ts`'s `baseUrl`
 * uses, so the two derived-URL conventions in this product stay one convention.
 */
export function resolveRedirectUri(config: Config, req: FastifyRequest): string {
  if (config.OIDC_REDIRECT_URI) return config.OIDC_REDIRECT_URI;
  const base = (config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
  return `${base}/api/auth/oidc/callback`;
}

/**
 * Builds the URL to send the browser to, and the flow state its matching cookie must hold.
 *
 * `intent` only ever selects which branch `GET /api/auth/oidc/callback` takes on the way back
 * (`'login'` signs in, `'link'` attaches the identity to whoever is signed in at that point) — it is
 * never how the callback decides *which account*, because the flow cookie carrying it is unsigned
 * ([MAJOR-1], tur 2 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)).
 */
export async function buildAuthorizationRedirect(
  config: Config,
  req: FastifyRequest,
  next: string,
  intent: 'login' | 'link' = 'login',
): Promise<{ url: string; flow: OidcFlowState }> {
  const oidcConfig = await discover(config);
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: resolveRedirectUri(config, req),
    scope: config.OIDC_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, flow: { state, nonce, verifier, next, intent } };
}

/**
 * Exchanges the authorization code for tokens and returns the ID token's validated claims. Validates
 * `state`, `nonce` and the PKCE verifier against the flow cookie's values — the three checks that
 * make this callback trustworthy against both CSRF and a code swapped in from another session — plus
 * the ID token's JWS signature against the provider's JWKS, via `enableNonRepudiationChecks` in
 * `discover()`.
 */
export async function completeAuthorizationCodeGrant(config: Config, currentUrl: URL, flow: OidcFlowState): Promise<IDToken> {
  const oidcConfig = await discover(config);
  const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('the provider returned no ID token');
  return claims;
}
