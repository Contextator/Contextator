import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import {
  apiTokens,
  auditEvents,
  mcpTokens,
  oauthClients,
  projects,
  users,
  userFederatedIdentities,
  userSessions,
  type AuditEventRow,
} from '../../src/db/schema.js';
import { issueMcpCredential } from '../../src/services/auth/mcp-tokens.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { linkFederatedIdentity, provisionFederatedUser, unlinkFederatedIdentity } from '../../src/services/auth/federated-identities.js';
import { revokeSessionsOfUser } from '../../src/services/auth/sessions.js';
import { createUser, deleteUser, SSO_ONLY_PASSWORD_HASH, setPassword, updateUser, withUserRowLock } from '../../src/services/auth/users.js';
import { PromotionRefusedError } from '../../src/services/errors.js';
import { ConflictError } from '../../src/services/projects.js';
import { applySchema, createTestDatabase, dropTestDatabase, type TestDatabase } from './support/postgres.js';
import { seedProject, startMcpInstance, type LiveInstance } from './support/mcp-instance.js';
import { startLocalOidcProvider, type LocalOidcProvider } from './support/oidc-provider.js';

/**
 * Counts every scrypt derivation the in-process server runs ([ADR-0081](../../.ssot/ADR.md#adr-0081)
 * §2, FR-602): a password sign-in to an SSO-only account has to cost the same one derivation an
 * unknown username does, and a counter proves that where a stopwatch on a shared CI runner could not.
 * Everything else in `node:crypto` is the real module; `scrypt` itself still runs, only counted.
 */
const scryptCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock(import('node:crypto'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    scrypt: ((...args: unknown[]) => {
      scryptCalls.n++;
      return Reflect.apply(actual.scrypt, undefined, args);
    }) as typeof actual.scrypt,
  };
});

/** The checkout this file runs from — `public/` is read as the browser would receive it. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * **A browser signing in through a local OIDC provider, end to end** ([ADR-0077](../../.ssot/ADR.md#adr-0077)).
 *
 * The provider is `support/oidc-provider.ts`, a from-scratch fixture rather than a mocked
 * `openid-client` — the same principle `mcp-oauth.itest.ts` follows for the client half: a test that
 * stubbed the library would prove our code calls a stub correctly, and nothing about whether it can
 * talk to a real authorization server. `fetch(..., { redirect: 'manual' })` drives every hop by hand,
 * the way a browser would without actually being one, and a small hand-rolled cookie jar
 * (`jarFromSetCookie`/`cookieHeader`) carries the OIDC flow cookie and then the session cookie across
 * those hops, since Node's `fetch` does not manage cookies on its own.
 */

const baseUrl = inject('postgresBaseUrl');

/**
 * A bearer credential for `TOKEN_PRINCIPAL` (`kind: 'token'`, `role: 'root'` — `src/auth/plugin.ts`),
 * configured on this file's one shared instance so mutation-J's negative test can prove
 * `requireSession` (`src/auth/plugin.ts`) rejects a non-session principal at `POST
 * /api/auth/oidc/link`, not just an absent one — the reviewer's own noted gap ("ADMIN_TOKEN ve API
 * token'lı başlatma testsiz", tur 2 review of ADR-0077). No other test in this file sends this header.
 */
const ADMIN_BEARER = 'oidc-itest-admin-token-12345';

let database: TestDatabase;
let root: string;
let live: LiveInstance;
let provider: LocalOidcProvider;

const jarFromSetCookie = (setCookies: string[], into: Record<string, string> = {}): Record<string, string> => {
  for (const raw of setCookies) {
    const pair = raw.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    into[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return into;
};

const cookieHeader = (jar: Record<string, string>): string =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

/**
 * Starts a flow at `startPath` (`/api/auth/oidc/login` or, with a caller's own session cookie
 * already in `cookie`, `/api/auth/oidc/link`) and follows it through the fixture's `/authorize`,
 * returning the callback URL the provider redirected to and the cookie jar accumulated so far —
 * everything a test needs to either hit the callback as-is or tamper with it first ([MAJOR-3], tur 2
 * review of [ADR-0077](../../.ssot/ADR.md#adr-0077)).
 */
async function startOidcFlow(
  origin: string,
  opts: { next?: string; startPath?: string; cookie?: string } = {},
): Promise<{ jar: Record<string, string>; callbackUrl: string }> {
  const startPath = opts.startPath ?? '/api/auth/oidc/login';
  // `/api/auth/oidc/link` is `POST` with a JSON `{url}` reply, not a redirecting `GET` ([MAJOR-1], tur
  // 3 review of ADR-0077) — `sec-fetch-site: same-origin` stands in for the browser header the CSRF
  // same-site check (`authorize.ts`) requires on every state-changing session request.
  const isLink = startPath === '/api/auth/oidc/link';
  let loginRes: Response;
  let authorizeUrl: string | null;
  if (isLink) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    if (opts.cookie) headers.cookie = opts.cookie;
    loginRes = await fetch(`${origin}${startPath}`, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: JSON.stringify(opts.next ? { next: opts.next } : {}),
    });
    if (loginRes.status !== 200) throw new Error(`${startPath} did not return 200 (status ${loginRes.status})`);
    authorizeUrl = ((await loginRes.json()) as { url: string }).url;
  } else {
    const loginUrl = `${origin}${startPath}${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`;
    loginRes = await fetch(loginUrl, { redirect: 'manual', headers: opts.cookie ? { cookie: opts.cookie } : undefined });
    authorizeUrl = loginRes.headers.get('location');
  }
  const jar = jarFromSetCookie(loginRes.headers.getSetCookie());
  if (!authorizeUrl) throw new Error(`${startPath} did not redirect (status ${loginRes.status})`);

  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = authorizeRes.headers.get('location');
  if (!callbackUrl) throw new Error(`the provider fixture did not redirect back (status ${authorizeRes.status})`);
  return { jar, callbackUrl };
}

/** Hits a callback URL with whatever cookies `jar` holds (or none, for the "missing flow cookie" case). */
async function hitCallback(callbackUrl: string, jar: Record<string, string>): Promise<Response> {
  const callback = await fetch(callbackUrl, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  jarFromSetCookie(callback.headers.getSetCookie(), jar);
  return callback;
}

/**
 * Drives `/api/auth/oidc/login` -> the fixture's `/authorize` -> `/api/auth/oidc/callback`, exactly
 * the three hops a browser makes, and returns the callback's own response (a test asserts on it) along
 * with whatever cookie jar resulted — a session cookie on success, nothing usable on failure.
 */
async function driveOidcLogin(origin: string, next?: string): Promise<{ callback: Response; jar: Record<string, string> }> {
  const { jar, callbackUrl } = await startOidcFlow(origin, { next });
  const callback = await hitCallback(callbackUrl, jar);
  return { callback, jar };
}

const events = (): Promise<AuditEventRow[]> => database.db.select().from(auditEvents);

/**
 * Waits until at least `atLeast` audit rows match. The callback's own events are written from its
 * route's `onResponse` ([F14-MINOR-2]) and the backstop's from the reply's `finish`
 * ([F14-T5-MINOR-2]) — both only once the response has gone, which can be a beat after `fetch` has
 * already resolved on its headers — so `settled()` alone could run before `record()` was even called.
 */
async function waitForEvents(match: (e: AuditEventRow) => boolean, atLeast = 1, timeoutMs = 5_000): Promise<AuditEventRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await live.ctx.audit.settled();
    const rows = (await events()).filter(match);
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A promise a test can resolve from the outside — the barrier primitive the [T6-MAJOR-1] race test
 * uses to park the login callback mid-flight (inside its row lock) and then resume it on cue, instead
 * of guessing at a `setTimeout` window that either flakes or races nothing at all.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until some backend connected to `pool`'s database is queued on a lock — the observable proof
 * that a request is blocked behind a row a test is holding, rather than a guess that 200 ms was long
 * enough for it to get there. Returns `false` if nothing ever queued within `timeoutMs`.
 */
async function waitForLockWaiter(pool: pg.Pool, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if ((res.rows[0]?.n ?? 0) > 0) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

/** The SQLSTATE of a driver error, whether it arrives bare or wrapped in Drizzle's query error. */
const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === 'string') return e.code;
  return typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
};

/** `DELETE /api/auth/oidc/link`'s refusal, word for word as [ADR-0081](../../.ssot/ADR.md#adr-0081) §1 fixes it. */
const LAST_SIGN_IN_METHOD_BODY = {
  error: 'last_sign_in_method',
  message: 'This account has no password of its own; unlinking SSO would leave it with no way to sign in. Ask an admin to set a password first.',
};

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'oidc_sso');
  await applySchema(database);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-oidc-'));
  provider = await startLocalOidcProvider();
  live = await startMcpInstance(database, {
    dataDir: path.join(root, '.data'),
    docRoot: root,
    env: {
      OIDC_ISSUER_URL: provider.issuer,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: provider.clientSecret,
      OIDC_AUTO_PROVISION: '1',
      OIDC_DEFAULT_ROLE: 'member',
      ADMIN_TOKEN: ADMIN_BEARER,
    },
  });
});

afterAll(async () => {
  await live?.close();
  await provider?.close();
  await dropTestDatabase(baseUrl, database);
  await rm(root, { recursive: true, force: true });
});

describe('signing in through a local OIDC provider', () => {
  it('auto-provisions a new account on first sign-in and lands where "next" pointed', async () => {
    provider.setNextIdentity({ sub: 'first-timer', email: 'first@example.test', preferred_username: 'firsttimer', name: 'First Timer' });

    const { callback, jar } = await driveOidcLogin(live.origin, '/dashboard');

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard');
    expect(jar[SESSION_COOKIE]).toBeTruthy();

    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'first-timer'));
    expect(link).toBeTruthy();
    expect(link.issuer).toBe(provider.issuer);

    const [user] = await database.db.select().from(users).where(eq(users.id, link.userId));
    expect(user.username).toBe('firsttimer');
    expect(user.role).toBe('member');
    expect(user.isActive).toBe(true);
    // No password of its own, and a hash no password can ever verify against ([ADR-0081], FR-602).
    expect(user.passwordHash).toBe(SSO_ONLY_PASSWORD_HASH);
    // An SSO sign-in is a sign-in: `last_login_at` moves just as a password one does ([F14-MINOR-3]).
    expect(user.lastLoginAt).toBeInstanceOf(Date);

    const me = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.username).toBe('firsttimer');
    expect(meBody.authKind).toBe('session');
  });

  it('signs the same identity back into the same account on a second visit, without provisioning again', async () => {
    provider.setNextIdentity({ sub: 'repeat-visitor', email: 'repeat@example.test', preferred_username: 'repeatvisitor' });

    const first = await driveOidcLogin(live.origin);
    expect(first.callback.status).toBe(302);
    const [linkAfterFirst] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'repeat-visitor'));
    const userId = linkAfterFirst.userId;

    const second = await driveOidcLogin(live.origin);
    // Not just "some 302": a broken account-mapping lookup also ends in a 302 (`refuse()`'s own
    // redirect), so the location and the session cookie are what actually distinguish "signed in
    // again" from "silently failed to be recognized and hit the unique constraint on retry".
    expect(second.callback.headers.get('location')).toBe('/');
    expect(second.jar[SESSION_COOKIE]).toBeTruthy();

    const links = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'repeat-visitor'));
    expect(links).toHaveLength(1);
    expect(links[0].userId).toBe(userId);
  });

  it('refuses a provider identity with no linked account when auto-provisioning is off', async () => {
    const noProvisionInstance = await startMcpInstance(database, {
      dataDir: path.join(root, '.data-noprov'),
      docRoot: root,
      env: {
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_AUTO_PROVISION: '0',
      },
    });
    try {
      provider.setNextIdentity({ sub: 'nobody-linked-this' });
      const { callback, jar } = await driveOidcLogin(noProvisionInstance.origin);
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('/login?oidc_error=no_account');
      expect(jar[SESSION_COOKIE]).toBeUndefined();
    } finally {
      await noProvisionInstance.close();
    }
  });

  it('still signs in an already-linked identity when auto-provisioning is off, proving the mapping lookup itself is not skipped', async () => {
    provider.setNextIdentity({ sub: 'already-linked-no-provision', preferred_username: 'alreadylinkednoprovision' });
    const setup = await driveOidcLogin(live.origin);
    expect(setup.callback.status).toBe(302);
    expect(setup.jar[SESSION_COOKIE]).toBeTruthy();

    const noProvisionInstance = await startMcpInstance(database, {
      dataDir: path.join(root, '.data-noprov-linked'),
      docRoot: root,
      env: {
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_AUTO_PROVISION: '0',
      },
    });
    try {
      // Same identity as above — already linked via the first, provisioning instance, sharing the same
      // database. "Auto-provisioning off" must never stand in for "the mapping lookup itself never
      // ran": an unrelated, never-seen `sub` is correctly refused (see the test above), but this one is
      // already linked and must succeed on that basis alone ([MAJOR-3] kabul 6, tur 2 review of
      // [ADR-0077](../../.ssot/ADR.md#adr-0077)) — a mutation that skips the mapping lookup collapses
      // both cases into the same refusal, which is exactly the gap this test closes.
      provider.setNextIdentity({ sub: 'already-linked-no-provision', preferred_username: 'alreadylinkednoprovision' });
      const { callback, jar } = await driveOidcLogin(noProvisionInstance.origin);
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('/');
      expect(jar[SESSION_COOKIE]).toBeTruthy();
    } finally {
      await noProvisionInstance.close();
    }
  });

  it('refuses when the provider itself denies the authorization', async () => {
    provider.denyNextAuthorization();
    const { callback } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=provider_denied');
  });

  it('records the sign-in in the audit log with the provider attached', async () => {
    provider.setNextIdentity({ sub: 'audited-user', email: 'audited@example.test', preferred_username: 'audited' });
    const { jar } = await driveOidcLogin(live.origin);

    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'audited-user'));
    const rows = await waitForEvents((e) => e.actorUserId === link.userId && e.action === 'GET /api/auth/oidc/callback');
    expect(rows).toHaveLength(1);
    // The status the browser actually got — the redirect — not a number fixed before the reply existed
    // ([F14-MINOR-2]).
    expect(rows[0].statusCode).toBe(302);
    expect(rows[0].actorLabel).toBe(`audited · sso:${new URL(provider.issuer).hostname}`);
    expect(rows[0].detail).toMatchObject({ provider: new URL(provider.issuer).hostname, newAccount: true });
    expect(jar[SESSION_COOKIE]).toBeTruthy();
  });

  it('refuses a callback whose state does not match the flow cookie', async () => {
    provider.setNextIdentity({ sub: 'wrong-state', preferred_username: 'wrongstate' });
    const { jar, callbackUrl } = await startOidcFlow(live.origin);
    const tampered = new URL(callbackUrl);
    tampered.searchParams.set('state', `${tampered.searchParams.get('state')}-tampered`);
    const callback = await hitCallback(tampered.href, jar);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=exchange_failed');
    expect(jar[SESSION_COOKIE]).toBeFalsy();
  });

  it.each([
    ['wrong iss', { issOverride: 'http://not-the-real-issuer.invalid' }],
    ['wrong aud', { audOverride: 'not-the-real-client' }],
    ['wrong nonce', { nonceOverride: 'not-the-real-nonce' }],
    ['a corrupted signature', { corruptSignature: true }],
  ] as const)('refuses an ID token with %s', async (_label, tampering) => {
    provider.setNextIdentity({ sub: `tampered-${_label.replace(/\s+/g, '-')}`, preferred_username: 'tamperedtoken' });
    provider.tamperNextIdToken(tampering);
    const { callback, jar } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=exchange_failed');
    expect(jar[SESSION_COOKIE]).toBeFalsy();
  });

  it('refuses an ID token that omits the nonce the flow required', async () => {
    // Distinct from the `wrong nonce` case above: that one forces a *truthy* mismatched nonce, which
    // openid-client's own "no nonce expected" default would reject even if this codebase never
    // requested or checked a nonce at all. This one proves the nonce is genuinely round-tripped and
    // verified — a legitimate flow's ID token always carries back the nonce it asked for, so an ID
    // token with none at all must be refused, not silently accepted ([MAJOR-3], tur 2 review of
    // ADR-0077).
    provider.setNextIdentity({ sub: 'tampered-dropped-nonce', preferred_username: 'droppednonce' });
    provider.tamperNextIdToken({ dropNonce: true });
    const { callback, jar } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=exchange_failed');
    expect(jar[SESSION_COOKIE]).toBeFalsy();
  });

  it('refuses a callback with no flow cookie at all', async () => {
    provider.setNextIdentity({ sub: 'no-cookie', preferred_username: 'nocookie' });
    const { callbackUrl } = await startOidcFlow(live.origin);
    const callback = await hitCallback(callbackUrl, {}); // empty jar: the flow cookie never rides along
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=flow_expired');
  });

  it('never lets a sign-in redirect off this origin, even through the %09-hidden-host trick', async () => {
    // The login route runs every `next` through `safeNext` ([MAJOR-2], tur 2 review of
    // [ADR-0077](../../.ssot/ADR.md#adr-0077)) before it is ever written into the flow cookie, so a
    // value that would resolve to `//evil.example` once a browser parses it never survives past
    // `/api/auth/oidc/login` — this exercises that against the real route, not just the unit under
    // `safeNext` itself (see `test/pages.test.ts`).
    provider.setNextIdentity({ sub: 'redirect-victim', preferred_username: 'redirectvictim' });
    const { callback, jar } = await driveOidcLogin(live.origin, '/\t/evil.example');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/');
    expect(jar[SESSION_COOKIE]).toBeTruthy();
  });

  it('provisions a brand-new, distinctly-named account rather than colliding into an existing one with the same preferred_username', async () => {
    provider.setNextIdentity({ sub: 'collider-original', preferred_username: 'samename', email: 'original@example.test' });
    const original = await driveOidcLogin(live.origin);
    expect(original.callback.status).toBe(302);
    const [originalLink] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'collider-original'));

    // Same preferred_username, a different `sub` — mapping is strictly by (issuer, subject), so this
    // must never be recognized as, or elevated into, the account above.
    provider.setNextIdentity({ sub: 'collider-impostor', preferred_username: 'samename', email: 'impostor@example.test' });
    const impostor = await driveOidcLogin(live.origin);
    expect(impostor.callback.status).toBe(302);
    expect(impostor.jar[SESSION_COOKIE]).toBeTruthy();

    const [impostorLink] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'collider-impostor'));
    expect(impostorLink).toBeTruthy();
    expect(impostorLink.userId).not.toBe(originalLink.userId);

    const [impostorUser] = await database.db.select().from(users).where(eq(users.id, impostorLink.userId));
    expect(impostorUser.username).not.toBe('samename');
    expect(impostorUser.username.startsWith('samename')).toBe(true);

    const [originalUser] = await database.db.select().from(users).where(eq(users.id, originalLink.userId));
    expect(originalUser.username).toBe('samename');
    expect(originalUser.email).toBe('original@example.test'); // untouched by the second sign-in
  });

  it('refuses a sign-in for an account that has since been disabled', async () => {
    provider.setNextIdentity({ sub: 'soon-disabled', preferred_username: 'soondisabled' });
    const first = await driveOidcLogin(live.origin);
    expect(first.callback.status).toBe(302);
    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'soon-disabled'));
    await database.db.update(users).set({ isActive: false }).where(eq(users.id, link.userId));

    const second = await driveOidcLogin(live.origin);
    expect(second.callback.status).toBe(302);
    expect(second.callback.headers.get('location')).toBe('/login?oidc_error=account_disabled');
    expect(second.jar[SESSION_COOKIE]).toBeFalsy();
  });

  it('local password sign-in keeps working when OIDC is configured but the provider is unreachable', async () => {
    const deadProvider = await startLocalOidcProvider();
    const unreachableIssuer = deadProvider.issuer;
    await deadProvider.close(); // bound port, nothing listens on it anymore

    const withDeadProvider = await startMcpInstance(database, {
      dataDir: path.join(root, '.data-dead'),
      docRoot: root,
      env: {
        OIDC_ISSUER_URL: unreachableIssuer,
        OIDC_CLIENT_ID: 'whatever',
        OIDC_CLIENT_SECRET: 'whatever',
      },
    });
    try {
      const password = 'a-long-enough-password-2!';
      await createUser(database.db, { username: 'localadmin', role: 'admin', password });

      const res = await fetch(`${withDeadProvider.origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'localadmin', password }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    } finally {
      await withDeadProvider.close();
    }
  });
});

describe('a federated sign-in reaches exactly its mapped account’s permissions', () => {
  it('a member-mapped identity reaches its own profile but not the admin user list', async () => {
    const instance = await startMcpInstance(database, {
      dataDir: path.join(root, '.data-member'),
      docRoot: root,
      env: {
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_AUTO_PROVISION: '1',
        OIDC_DEFAULT_ROLE: 'member',
      },
    });
    try {
      provider.setNextIdentity({ sub: 'boundary-member', preferred_username: 'boundarymember' });
      const { callback, jar } = await driveOidcLogin(instance.origin);
      expect(callback.status).toBe(302);

      // positive: reaches its own profile
      const me = await fetch(`${instance.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
      expect(me.status).toBe(200);

      // negative: does not exceed the mapped role — the user list is admin-only
      const listUsers = await fetch(`${instance.origin}/api/users`, { headers: { cookie: cookieHeader(jar) } });
      expect(listUsers.status).toBe(403);
    } finally {
      await instance.close();
    }
  });

  it('an admin-mapped identity does reach the admin user list', async () => {
    const instance = await startMcpInstance(database, {
      dataDir: path.join(root, '.data-admin'),
      docRoot: root,
      env: {
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_AUTO_PROVISION: '1',
        OIDC_DEFAULT_ROLE: 'admin',
      },
    });
    try {
      provider.setNextIdentity({ sub: 'boundary-admin', preferred_username: 'boundaryadmin' });
      const { callback, jar } = await driveOidcLogin(instance.origin);
      expect(callback.status).toBe(302);

      const listUsers = await fetch(`${instance.origin}/api/users`, { headers: { cookie: cookieHeader(jar) } });
      expect(listUsers.status).toBe(200);
    } finally {
      await instance.close();
    }
  });
});

describe('self-service linking and unlinking of an SSO identity ([MAJOR-1], tur 2 review of ADR-0077)', () => {
  /** Signs a fresh local-password account in and returns its session jar and user id. */
  async function signInLocalUser(username: string): Promise<{ jar: Record<string, string>; userId: string }> {
    const password = 'a-long-enough-password-2!';
    const created = await createUser(database.db, { username, role: 'member', password });
    const res = await fetch(`${live.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return { jar: jarFromSetCookie(res.headers.getSetCookie()), userId: created.id };
  }

  it('refuses to start a linking flow without a live session', async () => {
    const res = await fetch(`${live.origin}/api/auth/oidc/link`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('refuses to unlink without a live session', async () => {
    const res = await fetch(`${live.origin}/api/auth/oidc/link`, { method: 'DELETE', redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('lets a signed-in user link an SSO identity to their own account, and only their own', async () => {
    const { jar, userId } = await signInLocalUser('linker-self');
    provider.setNextIdentity({ sub: 'linker-self-identity', preferred_username: 'irrelevant-here' });

    const cookie = cookieHeader(jar);
    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie, next: '/settings' });
    const merged = { ...jar, ...flowJar };
    const callback = await hitCallback(callbackUrl, merged);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/settings');

    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'linker-self-identity'));
    expect(link).toBeTruthy();
    expect(link.userId).toBe(userId); // the live session's own account — never one named by the flow cookie

    const rows = await waitForEvents(
      (e) => e.actorUserId === userId && e.action === 'GET /api/auth/oidc/callback' && (e.detail as { linked?: boolean } | null)?.linked === true,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].statusCode).toBe(302);
  });

  it('returns to the tokens page fragment after linking, matching what public/tokens.js actually sends ([T3-MINOR-2], tur 3 review)', async () => {
    const { jar } = await signInLocalUser('linker-next-fragment');
    provider.setNextIdentity({ sub: 'linker-next-fragment-identity', preferred_username: 'irrelevant-here' });

    const cookie = cookieHeader(jar);
    // The value comes from `public/tokens.js` itself rather than a copy of it here ([F14-T4-MINOR-3]):
    // `linkOidc()` sends `TOKENS_RETURN_PATH`, so a change there is what this test exercises. A bare
    // `#/~tokens` (no leading `/`) fails `safeNext`'s `startsWith('/')` check and silently collapses
    // to `/`, losing the return-to-tokens-page destination.
    const tokensJs = await readFile(path.join(REPO_ROOT, 'public', 'tokens.js'), 'utf8');
    const returnPath = /export const TOKENS_RETURN_PATH = '([^']+)';/.exec(tokensJs)?.[1];
    expect(returnPath).toBeTruthy();
    expect(tokensJs).toMatch(/\/api\/auth\/oidc\/link', \{ method: 'POST', body: \{ next: TOKENS_RETURN_PATH \} \}/);

    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie, next: returnPath });
    const merged = { ...jar, ...flowJar };
    const callback = await hitCallback(callbackUrl, merged);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(returnPath);
  });

  it('refuses to link an identity that is already linked to a different account', async () => {
    provider.setNextIdentity({ sub: 'already-claimed-identity', preferred_username: 'irrelevant-here' });
    const owner = await driveOidcLogin(live.origin); // auto-provisions and claims the identity first
    expect(owner.callback.status).toBe(302);

    const { jar } = await signInLocalUser('linker-conflict');
    const cookie = cookieHeader(jar);
    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie });
    const merged = { ...jar, ...flowJar };
    const callback = await hitCallback(callbackUrl, merged);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=link_conflict');
  });

  it('lets a signed-in user remove their own linked identity, and records it in the audit log', async () => {
    const { jar, userId } = await signInLocalUser('unlinker-self');
    provider.setNextIdentity({ sub: 'unlinker-self-identity', preferred_username: 'irrelevant-here' });
    const cookie = cookieHeader(jar);
    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie });
    const merged = { ...jar, ...flowJar };
    const linkCallback = await hitCallback(callbackUrl, merged);
    expect(linkCallback.status).toBe(302);

    const before = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'unlinker-self-identity'));
    expect(before).toHaveLength(1);

    const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader(jar), 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    });
    expect(unlink.status).toBe(204);

    const after = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'unlinker-self-identity'));
    expect(after).toHaveLength(0);

    await live.ctx.audit.settled();
    const rows = (await events()).filter((e) => e.actorUserId === userId && e.action === 'DELETE /api/auth/oidc/link');
    expect(rows).toHaveLength(1);
  });

  it("refuses a linking identity from a second account, and leaves the first account's own link untouched (mutation L, tur 2 review)", async () => {
    const first = await signInLocalUser('unlink-scope-first');
    const second = await signInLocalUser('unlink-scope-second');

    provider.setNextIdentity({ sub: 'unlink-scope-first-identity', preferred_username: 'irrelevant-here' });
    const firstFlow = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(first.jar) });
    const firstCallback = await hitCallback(firstFlow.callbackUrl, { ...first.jar, ...firstFlow.jar });
    expect(firstCallback.status).toBe(302);

    provider.setNextIdentity({ sub: 'unlink-scope-second-identity', preferred_username: 'irrelevant-here' });
    const secondFlow = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(second.jar) });
    const secondCallback = await hitCallback(secondFlow.callbackUrl, { ...second.jar, ...secondFlow.jar });
    expect(secondCallback.status).toBe(302);

    // `unlinkFederatedIdentity` deletes by `userId` alone (src/services/auth/federated-identities.ts)
    // — this proves that scoping holds under `DELETE /api/auth/oidc/link`, not merely by reading the
    // function in isolation: the second account's row must survive the first account's unlink.
    const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader(first.jar), 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    });
    expect(unlink.status).toBe(204);

    const firstRows = await database.db
      .select()
      .from(userFederatedIdentities)
      .where(eq(userFederatedIdentities.subject, 'unlink-scope-first-identity'));
    expect(firstRows).toHaveLength(0);

    const secondRows = await database.db
      .select()
      .from(userFederatedIdentities)
      .where(eq(userFederatedIdentities.subject, 'unlink-scope-second-identity'));
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].userId).toBe(second.userId);
  });

  describe("revoking the account's MCP OAuth credentials on unlink ([ADR-0090](../../.ssot/ADR.md#adr-0090), FR-616)", () => {
    /** One `initialize` on the project's MCP endpoint — `200` means the credential was accepted. */
    const initializeWith = (projectName: string, token: string) =>
      fetch(`${live.origin}/mcp/${projectName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } },
        }),
      });

    it("turns the unlinked account's access token away with 401, records how many it revoked, and leaves another account's alone", async () => {
      const project = await seedProject(database.db, 'unlink-mcp', { path: 'guide.md', body: '# Guide\n\nSomething to read.' });
      // The mode OAuth credentials exist for: no anonymous reader and no static token.
      await database.db.update(projects).set({ mcpAuth: 'account' }).where(eq(projects.id, project.id));
      const [client] = await database.db
        .insert(oauthClients)
        .values({ clientId: 'ctxc_unlink_mcp_test', name: 'connector', redirectUris: ['https://client.example/cb'] })
        .returning();

      const unlinker = await signInLocalUser('unlink-mcp-owner');
      const bystander = await signInLocalUser('unlink-mcp-bystander');
      for (const account of [unlinker, bystander]) await setMemberRole(database.db, project.id, account.userId, 'viewer', null);

      provider.setNextIdentity({ sub: 'unlink-mcp-owner-identity', preferred_username: 'irrelevant-here' });
      const flow = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(unlinker.jar) });
      expect((await hitCallback(flow.callbackUrl, { ...unlinker.jar, ...flow.jar })).status).toBe(302);

      const grant = (userId: string) => ({ projectId: project.id, userId, clientId: client.clientId, name: 'connector', ttlMs: 60_000 });
      const access = await issueMcpCredential(database.db, { ...grant(unlinker.userId), kind: 'access' });
      const refresh = await issueMcpCredential(database.db, { ...grant(unlinker.userId), kind: 'refresh' });
      const theirs = await issueMcpCredential(database.db, { ...grant(bystander.userId), kind: 'access' });
      expect((await initializeWith(project.name, access.token)).status).toBe(200);
      expect((await initializeWith(project.name, theirs.token)).status).toBe(200);

      const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
        method: 'DELETE',
        headers: { cookie: cookieHeader(unlinker.jar), 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      });
      expect(unlink.status).toBe(204);

      expect((await initializeWith(project.name, access.token)).status).toBe(401);
      expect((await initializeWith(project.name, theirs.token)).status).toBe(200);

      const rows = await database.db.select().from(mcpTokens).where(eq(mcpTokens.clientId, client.clientId));
      const revoked = new Map(rows.map((r) => [r.id, r.revokedAt !== null]));
      expect(revoked.get(access.id)).toBe(true);
      expect(revoked.get(refresh.id)).toBe(true); // the grant, not only the string a client presents
      expect(revoked.get(theirs.id)).toBe(false);

      const recorded = await waitForEvents((e) => e.actorUserId === unlinker.userId && e.action === 'DELETE /api/auth/oidc/link');
      expect(recorded).toHaveLength(1);
      expect(recorded[0].detail).toMatchObject({ revokedMcpCredentials: 2 });
    });

    it('records zero when there was nothing linked to remove, and revokes nothing', async () => {
      const project = await seedProject(database.db, 'unlink-mcp-noop', { path: 'guide.md', body: '# Guide' });
      await database.db.update(projects).set({ mcpAuth: 'account' }).where(eq(projects.id, project.id));
      const [client] = await database.db
        .insert(oauthClients)
        .values({ clientId: 'ctxc_unlink_mcp_noop', name: 'connector', redirectUris: ['https://client.example/cb'] })
        .returning();
      const account = await signInLocalUser('unlink-mcp-never-linked');
      await setMemberRole(database.db, project.id, account.userId, 'viewer', null);
      const access = await issueMcpCredential(database.db, {
        projectId: project.id,
        userId: account.userId,
        clientId: client.clientId,
        kind: 'access',
        name: 'connector',
        ttlMs: 60_000,
      });

      const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
        method: 'DELETE',
        headers: { cookie: cookieHeader(account.jar), 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      });
      expect(unlink.status).toBe(204);
      expect((await initializeWith(project.name, access.token)).status).toBe(200);

      const recorded = await waitForEvents((e) => e.actorUserId === account.userId && e.action === 'DELETE /api/auth/oidc/link');
      expect(recorded).toHaveLength(1);
      expect(recorded[0].detail).toMatchObject({ revokedMcpCredentials: 0 });
    });
  });

  it('refuses to complete a linking flow when the callback arrives under a different session than the one that started it ([BLOCKER], tur 3 review of ADR-0077)', async () => {
    const starter = await signInLocalUser('link-blocker-starter');
    const intruder = await signInLocalUser('link-blocker-intruder');
    provider.setNextIdentity({ sub: 'link-blocker-identity', preferred_username: 'irrelevant-here' });

    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, {
      startPath: '/api/auth/oidc/link',
      cookie: cookieHeader(starter.jar),
    });
    // The scenario the fix closes: an attacker who can plant the flow cookie in a victim's browser
    // (e.g. a captured redirect) must not be able to bind their own provider identity to the
    // victim's account merely by having the victim's browser complete the callback under the
    // victim's own, different session.
    const callback = await hitCallback(callbackUrl, { ...intruder.jar, ...flowJar });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=link_requires_session');

    const rows = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'link-blocker-identity'));
    expect(rows).toHaveLength(0);
  });

  it('refuses to complete a linking flow when the callback arrives under a bearer-token principal instead of a session (mutation I, tur 2 review)', async () => {
    const starter = await signInLocalUser('link-token-principal');
    provider.setNextIdentity({ sub: 'link-token-principal-identity', preferred_username: 'irrelevant-here' });

    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, {
      startPath: '/api/auth/oidc/link',
      cookie: cookieHeader(starter.jar),
    });
    // No session cookie at all here — only the flow cookie plus an ADMIN_TOKEN bearer, so
    // `req.principal.kind` is `'token'` rather than `'session'` at the callback. A mutant that
    // narrowed the callback's guard to only the sessionId comparison (dropping the `principal.kind
    // !== 'session'` half) would let this through.
    const callback = await fetch(callbackUrl, {
      headers: { cookie: cookieHeader(flowJar), authorization: `Bearer ${ADMIN_BEARER}` },
      redirect: 'manual',
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=link_requires_session');

    const rows = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'link-token-principal-identity'));
    expect(rows).toHaveLength(0);
  });

  it('refuses to start a linking flow from a cross-site request ([MAJOR-1], tur 3 review — CSRF on the start route)', async () => {
    const { jar } = await signInLocalUser('link-csrf-cross-site');
    const res = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(jar),
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('csrf_blocked');
  });

  it('refuses to start a linking flow for the root account ([MAJOR-4], tur 3 review of ADR-0077)', async () => {
    const password = 'a-long-enough-password-2!';
    await createUser(database.db, { username: 'link-root-start', role: 'root', password });
    const loginRes = await fetch(`${live.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'link-root-start', password }),
    });
    expect(loginRes.status).toBe(200);
    const jar = jarFromSetCookie(loginRes.headers.getSetCookie());

    const res = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jar), 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('root_local_only');
  });

  it('refuses a callback that would link the root account even when the promotion happens after the flow already started ([MAJOR-4], defense in depth)', async () => {
    const { jar, userId } = await signInLocalUser('link-root-promoted');
    provider.setNextIdentity({ sub: 'link-root-promoted-identity', preferred_username: 'irrelevant-here' });
    const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(jar) });

    // Promoted to root between the start request and the callback — the two are not atomic with
    // respect to a concurrent role change, so the callback's own root check must catch this
    // independently of the check the start route already made.
    await database.db.update(users).set({ role: 'root' }).where(eq(users.id, userId));

    const callback = await hitCallback(callbackUrl, { ...jar, ...flowJar });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/login?oidc_error=root_local_only');

    const rows = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'link-root-promoted-identity'));
    expect(rows).toHaveLength(0);
  });

  it('refuses to start a linking flow with a bearer token instead of a session, for both ADMIN_TOKEN and a scoped API token (mutation J, tur 2 review)', async () => {
    const admin = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}`, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({}),
    });
    expect(admin.status).toBe(403);
    expect((await admin.json()).error).toBe('token_has_no_account');

    const { jar } = await signInLocalUser('link-api-token-principal');
    const created = await fetch(`${live.origin}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jar), 'sec-fetch-site': 'same-origin' },
      // Scoped to this exact route so the request clears the policy layer's own scope check
      // (src/auth/authorize.ts) and actually reaches `requireSession` — the thing this test proves.
      body: JSON.stringify({ name: 'oidc-itest', scope: ['POST /api/auth/oidc/link'] }),
    });
    expect(created.status).toBe(201);
    const { secret } = await created.json();

    const scoped = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({}),
    });
    expect(scoped.status).toBe(403);
    expect((await scoped.json()).error).toBe('token_has_no_account');
  });

  it('refuses SSO sign-in for an account that was promoted to root after linking, and leaves the link itself in place ([T3-MAJOR-1], tur 3 review of ADR-0077)', async () => {
    const { jar, userId } = await signInLocalUser('root-promoted-after-link');
    provider.setNextIdentity({ sub: 'root-promoted-after-link-identity', preferred_username: 'irrelevant-here' });
    const { jar: flowJar, callbackUrl: linkCallbackUrl } = await startOidcFlow(live.origin, {
      startPath: '/api/auth/oidc/link',
      cookie: cookieHeader(jar),
    });
    const linkCallback = await hitCallback(linkCallbackUrl, { ...jar, ...flowJar });
    expect(linkCallback.status).toBe(302);

    const before = await database.db
      .select()
      .from(userFederatedIdentities)
      .where(eq(userFederatedIdentities.subject, 'root-promoted-after-link-identity'));
    expect(before).toHaveLength(1);

    // Promoted to root only after the identity is already linked — this is the path `POST
    // /api/auth/oidc/link`'s and the link callback's own root checks cannot see, since neither of
    // them runs again at sign-in time.
    await database.db.update(users).set({ role: 'root' }).where(eq(users.id, userId));

    const loginAttempt = await driveOidcLogin(live.origin);
    expect(loginAttempt.callback.status).toBe(302);
    expect(loginAttempt.callback.headers.get('location')).toBe('/login?oidc_error=root_local_only');
    expect(loginAttempt.jar[SESSION_COOKIE]).toBeFalsy();

    // The link row itself is untouched — refusing the sign-in is not the same as tearing down the
    // connection, which becomes usable again the moment the account is demoted.
    const after = await database.db
      .select()
      .from(userFederatedIdentities)
      .where(eq(userFederatedIdentities.subject, 'root-promoted-after-link-identity'));
    expect(after).toHaveLength(1);
    // And it is not counted as a sign-in of that identity either ([T4-NIT-1]): the touch comes after
    // the root refusal, so a refused attempt leaves the identity's `last_login_at` as it was.
    expect(before[0].lastLoginAt).toBeNull();
    expect(after[0].lastLoginAt).toBeNull();

    const rows = await waitForEvents(
      (e) =>
        e.actorUserId === userId &&
        e.action === 'GET /api/auth/oidc/callback' &&
        (e.detail as { refused?: string } | null)?.refused === 'root_local_only',
    );
    expect(rows).toHaveLength(1);
    // Written with the status the browser actually received — the refusal's redirect — rather than a
    // `403` the handler picked before any reply existed ([F14-MINOR-2]).
    expect(rows[0].statusCode).toBe(302);
  });

  it("revokes and clears a session whose account reads root through a path other than updateUser's promotion gate, instead of leaving it able to act as root ([T4-MAJOR-1], tur 4 review; backstop kept, tur 6 addendum of ADR-0077)", async () => {
    provider.setNextIdentity({ sub: 'promoted-mid-session', preferred_username: 'promotedmidsession' });
    const { callback, jar } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    expect(jar[SESSION_COOKIE]).toBeTruthy();

    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'promoted-mid-session'));
    expect(link).toBeTruthy();

    // `updateUser` now refuses this exact promotion outright while the identity stays linked (tur 6
    // addendum, [root_requires_unlink]) — proven separately below. A raw write is the only way left to
    // reach the state this test is actually about: a session that was already open when its account's
    // role became `root` by *some* means other than that gate, which is what plugin.ts's backstop
    // exists for regardless of how the row got there.
    await database.db.update(users).set({ role: 'root' }).where(eq(users.id, link.userId));

    // The write does not revoke sessions, so the SSO session opened before it is still live and now
    // resolves to role: root on every request. The `authMethod` check in plugin.ts's onRequest hook is
    // what stands between that and a session acting as root — tur 6 changed its reaction from a 403
    // that continued to exist to revoking the session outright and answering as anonymous.
    const createAnotherRoot = await fetch(`${live.origin}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: cookieHeader(jar) },
      body: JSON.stringify({ username: 'root-via-blocked-sso-session', role: 'root', password: 'a-long-enough-password-3!' }),
    });
    expect(createAnotherRoot.status).toBe(401);
    expect((await createAnotherRoot.json()).error).toBe('unauthorized');
    // The cookie-clearing `Set-Cookie` fired on this very request, so the user is not left presenting a
    // cookie that keeps failing the same way on every next click ([T5-MAJOR-2], tur 5 review).
    expect(createAnotherRoot.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);

    const [created] = await database.db.select().from(users).where(eq(users.username, 'root-via-blocked-sso-session'));
    expect(created).toBeUndefined();

    // The session row itself is revoked, not merely refused this one time — a second request with the
    // same (now-cleared) cookie would find nothing live either.
    const revoked = await database.db.select().from(userSessions).where(eq(userSessions.userId, link.userId));
    expect(revoked.every((s) => s.revokedAt !== null)).toBe(true);

    // And the cut-off is on record ([F14-T5-MINOR-2]): which request, whose session, with the status the
    // anonymous request actually got.
    const refusals = await waitForEvents(
      (e) => e.actorUserId === link.userId && (e.detail as { refused?: string } | null)?.refused === 'root_local_only',
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].action).toBe('POST /api/users');
    expect(refusals[0].statusCode).toBe(401);
    expect((refusals[0].detail as { authMethod?: string }).authMethod).toBe('sso');
  });

  it('leaves a root-reading SSO session alone on the public routes and /metrics, and cuts it off on the first route that needs a principal ([F14-T5-MINOR-1])', async () => {
    provider.setNextIdentity({ sub: 'backstop-exemptions', preferred_username: 'backstopexemptions' });
    const { callback, jar } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'backstop-exemptions'));
    await database.db.update(users).set({ role: 'root' }).where(eq(users.id, link.userId));

    const liveSessions = async (): Promise<number> =>
      (await database.db.select().from(userSessions).where(eq(userSessions.userId, link.userId))).filter((s) => s.revokedAt === null).length;
    const clearsCookie = (res: Response): boolean => res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`));
    const backstopRows = async (): Promise<AuditEventRow[]> => {
      await live.ctx.audit.settled();
      return (await events()).filter(
        (e) => e.actorUserId === link.userId && (e.detail as { refused?: string } | null)?.refused === 'root_local_only',
      );
    };

    for (const route of ['/api/health', '/api/setup/status']) {
      const res = await fetch(`${live.origin}${route}`, { headers: { cookie: cookieHeader(jar) } });
      expect(res.status, route).toBe(200);
      expect(clearsCookie(res), route).toBe(false);
    }
    const metrics = await fetch(`${live.origin}/metrics`, { headers: { cookie: cookieHeader(jar) } });
    expect(metrics.status).not.toBe(401);
    expect(clearsCookie(metrics)).toBe(false);

    expect(await liveSessions()).toBeGreaterThan(0);
    expect(await backstopRows()).toHaveLength(0);

    // The exemption is exactly those routes: the next ordinary request is where the backstop bites.
    const me = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    expect(me.status).toBe(401);
    expect(clearsCookie(me)).toBe(true);
    expect(await liveSessions()).toBe(0);
    const rows = await waitForEvents(
      (e) => e.actorUserId === link.userId && (e.detail as { refused?: string } | null)?.refused === 'root_local_only',
    );
    expect(rows.map((r) => r.action)).toEqual(['GET /api/auth/me']);
  });

  it('reports canLinkOidc as false for root and true for a member on GET /api/auth/me (mutation M7, tur 3 review)', async () => {
    const password = 'a-long-enough-password-2!';
    await createUser(database.db, { username: 'me-root-canlink', role: 'root', password });
    const rootLogin = await fetch(`${live.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'me-root-canlink', password }),
    });
    expect(rootLogin.status).toBe(200);
    const rootJar = jarFromSetCookie(rootLogin.headers.getSetCookie());

    const rootMe = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(rootJar) } });
    expect(rootMe.status).toBe(200);
    expect((await rootMe.json()).canLinkOidc).toBe(false);

    const { jar: memberJar } = await signInLocalUser('me-member-canlink');
    const memberMe = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(memberJar) } });
    expect(memberMe.status).toBe(200);
    expect((await memberMe.json()).canLinkOidc).toBe(true);
  });

  describe('SSO login callback races unlink for the same account ([T6-MAJOR-1], tur 7 fix of ADR-0077)', () => {
    it("serializes the login callback's re-check-and-write against a concurrent unlink, so nothing the callback would have issued outlives it", async () => {
      const { jar: ownerJar, userId } = await signInLocalUser('race-login-vs-unlink');
      provider.setNextIdentity({ sub: 'race-login-vs-unlink-identity', preferred_username: 'irrelevant-here' });
      const { jar: linkFlowJar, callbackUrl: linkCallbackUrl } = await startOidcFlow(live.origin, {
        startPath: '/api/auth/oidc/link',
        cookie: cookieHeader(ownerJar),
      });
      const linkCallback = await hitCallback(linkCallbackUrl, { ...ownerJar, ...linkFlowJar });
      expect(linkCallback.status).toBe(302);

      // A fresh, unauthenticated login flow for the same identity — the callback this test pauses.
      provider.setNextIdentity({ sub: 'race-login-vs-unlink-identity', preferred_username: 'irrelevant-here' });
      const { jar: loginFlowJar, callbackUrl: loginCallbackUrl } = await startOidcFlow(live.origin);

      const entered = deferred<void>();
      const release = deferred<void>();
      live.ctx.testHooks = {
        // Fires inside `withUserRowLock`, holding the account row's `FOR UPDATE` lock, right after the
        // callback re-confirms the identity is still linked and right before it would write the session
        // ([T6-MAJOR-1], tur 6 review's exact window).
        onOidcLoginBeforeSignIn: async () => {
          entered.resolve();
          await release.promise;
        },
      };

      try {
        const callbackPromise = hitCallback(loginCallbackUrl, loginFlowJar);
        await entered.promise;

        // The unlink's own `withUserRowLock` queues behind the same row lock and cannot complete while
        // the callback is parked here — proven below, before the barrier is ever released, not assumed.
        const unlinkPromise = fetch(`${live.origin}/api/auth/oidc/link`, {
          method: 'DELETE',
          headers: { cookie: cookieHeader(ownerJar), 'sec-fetch-site': 'same-origin' },
          redirect: 'manual',
        });
        const raceOutcome = await Promise.race([
          unlinkPromise.then(() => 'resolved' as const),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200)),
        ]);
        expect(raceOutcome).toBe('pending');

        release.resolve();
        const [callback, unlink] = await Promise.all([callbackPromise, unlinkPromise]);
        expect(unlink.status).toBe(204);
        // Both settle here; which one actually won the row lock is not what this test asserts on — only
        // what is left standing afterward, regardless of which order the lock was granted in.
        expect(callback.status).toBe(302);

        // No live session anywhere for this account afterward: either the callback lost the race and its
        // re-check under the lock saw the identity already gone (`no_account`, no session ever written),
        // or it won the race and wrote one that the unlink then revoked right after, the same way it
        // revokes every other session this account holds — including the owner's original local-login one.
        const sessions = await database.db.select().from(userSessions).where(eq(userSessions.userId, userId));
        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

        const sessionCookie = loginFlowJar[SESSION_COOKIE];
        if (sessionCookie) {
          const me = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(loginFlowJar) } });
          expect(me.status).toBe(401);

          // This mint attempt runs strictly after the race above has already resolved: the session is
          // dead by this point, so `requireSession` refuses it before the request ever reaches
          // `POST /api/tokens`'s own `withUserRowLock` re-check. It does not exercise the mint-vs-unlink
          // race itself — that race, and the claim that nothing minted inside it survives, is what the
          // batched, deterministic test below (`API token mint races unlink…`, [T7-MAJOR-1], tur 8 fix)
          // exists to prove, by pausing a concurrent mint *inside* the lock instead of after it settles.
          const mintAttempt = await fetch(`${live.origin}/api/tokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: cookieHeader(loginFlowJar), 'sec-fetch-site': 'same-origin' },
            body: JSON.stringify({ name: 'race-test', scope: ['GET /api/auth/me'] }),
          });
          expect(mintAttempt.status).toBe(401);
        }

        const link = await database.db
          .select()
          .from(userFederatedIdentities)
          .where(eq(userFederatedIdentities.subject, 'race-login-vs-unlink-identity'));
        expect(link).toHaveLength(0);
      } finally {
        // Released on every path ([F14-T7-MINOR-3]): an assertion failing above while the callback is
        // still parked inside its row lock would otherwise hold that lock until `afterAll` times out.
        release.resolve();
        live.ctx.testHooks = undefined;
      }
    });
  });

  describe('API token mint races unlink for the same account ([T7-MAJOR-1], tur 8 fix of ADR-0077)', () => {
    it('serializes a concurrent mint against unlink over several trials, so no token minted off a since-revoked link survives it', async () => {
      const TRIALS = 8;
      let leaked = 0;
      for (let i = 0; i < TRIALS; i++) {
        const { jar: ownerJar, userId } = await signInLocalUser(`race-mint-vs-unlink-${i}`);
        provider.setNextIdentity({ sub: `race-mint-vs-unlink-identity-${i}`, preferred_username: 'irrelevant-here' });
        const { jar: linkFlowJar, callbackUrl: linkCallbackUrl } = await startOidcFlow(live.origin, {
          startPath: '/api/auth/oidc/link',
          cookie: cookieHeader(ownerJar),
        });
        const linkCallback = await hitCallback(linkCallbackUrl, { ...ownerJar, ...linkFlowJar });
        expect(linkCallback.status).toBe(302);

        const entered = deferred<void>();
        const release = deferred<void>();
        live.ctx.testHooks = {
          // Fires inside `withUserRowLock`, holding the account row's `FOR UPDATE` lock, right after the
          // mint re-confirms the calling session is still live and right before it inserts the token row
          // ([T7-MAJOR-1], tur 8 fix's exact window).
          onTokenMintBeforeInsert: async () => {
            entered.resolve();
            await release.promise;
          },
        };

        try {
          const mintPromise = fetch(`${live.origin}/api/tokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: cookieHeader(ownerJar), 'sec-fetch-site': 'same-origin' },
            body: JSON.stringify({ name: `race-${i}`, scope: ['GET /api/auth/me'] }),
          });
          await entered.promise;

          // The unlink's own `withUserRowLock` queues behind the same row lock and cannot complete while
          // the mint is parked here — proven below, before the barrier is ever released, not assumed.
          const unlinkPromise = fetch(`${live.origin}/api/auth/oidc/link`, {
            method: 'DELETE',
            headers: { cookie: cookieHeader(ownerJar), 'sec-fetch-site': 'same-origin' },
            redirect: 'manual',
          });
          const raceOutcome = await Promise.race([
            unlinkPromise.then(() => 'resolved' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200)),
          ]);
          // Released unconditionally, before any assertion below can throw: a paused mint left holding
          // the row lock is exactly the hang `afterAll`'s 180s hook timeout would surface ([T7-MINOR-3],
          // tur 7 review of the sibling test above) if a failed expectation ever skipped this.
          release.resolve();
          const [mint, unlink] = await Promise.all([mintPromise, unlinkPromise]);
          expect(raceOutcome).toBe('pending');
          expect(unlink.status).toBe(204);
          expect(mint.status).toBe(201);

          // The literal claim under test: whichever of them the lock let commit first, nothing this
          // account holds afterward is a live, unrevoked token — unlink revokes every token exactly the
          // way it revokes every session, including one minted moments before it under the same lock.
          const tokens = await database.db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
          leaked += tokens.filter((t) => t.revokedAt === null).length;
        } finally {
          live.ctx.testHooks = undefined;
        }
      }
      expect(leaked).toBe(0);
    });
  });

  describe('API token mint re-checks revoked_at when unlink already committed first ([T8-MAJOR-1] fix of ADR-0077)', () => {
    it('refuses to mint once unlink has fully committed and released the lock, before the mint ever acquires it', async () => {
      const { jar: ownerJar, userId } = await signInLocalUser('race-mint-after-unlink');
      provider.setNextIdentity({ sub: 'race-mint-after-unlink-identity', preferred_username: 'irrelevant-here' });
      const { jar: linkFlowJar, callbackUrl: linkCallbackUrl } = await startOidcFlow(live.origin, {
        startPath: '/api/auth/oidc/link',
        cookie: cookieHeader(ownerJar),
      });
      const linkCallback = await hitCallback(linkCallbackUrl, { ...ownerJar, ...linkFlowJar });
      expect(linkCallback.status).toBe(302);

      const entered = deferred<void>();
      const release = deferred<void>();
      live.ctx.testHooks = {
        // Fires before `POST /api/tokens` ever calls `withUserRowLock` ([T8-MAJOR-1] fix): pausing the
        // mint here, before it even attempts the lock, lets a racing unlink acquire the lock, revoke the
        // session, and commit to completion — genuinely producing the "unlink commits, then mint starts"
        // order the `revoked_at` re-check exists for. `onTokenMintBeforeInsert` (sibling test above) can
        // only ever produce the opposite order, since it already holds the lock unlink would need.
        onTokenMintBeforeLock: async () => {
          entered.resolve();
          await release.promise;
        },
      };

      try {
        const mintPromise = fetch(`${live.origin}/api/tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieHeader(ownerJar), 'sec-fetch-site': 'same-origin' },
          body: JSON.stringify({ name: 'race-after-unlink', scope: ['GET /api/auth/me'] }),
        });
        await entered.promise;

        const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
          method: 'DELETE',
          headers: { cookie: cookieHeader(ownerJar), 'sec-fetch-site': 'same-origin' },
          redirect: 'manual',
        });
        expect(unlink.status).toBe(204);

        // Unlink has already committed and released the row lock at this point — the mint is still
        // parked before it has even tried to acquire it. Released only now, so the mutation this test
        // exists to catch (dropping the `revoked_at` re-check at tokens-routes.ts) cannot be masked by
        // unlink revoking a token minted before it ran, the way the sibling test above's order would.
        release.resolve();
        const mint = await mintPromise;
        expect(mint.status).toBe(401);
        const mintBody = (await mint.json()) as { error?: string };
        expect(mintBody.error).toBe('session_revoked');

        const tokens = await database.db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
        expect(tokens.filter((t) => t.revokedAt === null)).toHaveLength(0);
      } finally {
        live.ctx.testHooks = undefined;
      }
    });
  });

  describe('unlinking refuses to remove the last way in ([ADR-0081], FR-602)', () => {
    const unlinkWith = (jar: Record<string, string>): Promise<Response> =>
      fetch(`${live.origin}/api/auth/oidc/link`, {
        method: 'DELETE',
        headers: { cookie: cookieHeader(jar), 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      });
    const linksOf = (userId: string) => database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.userId, userId));

    it('answers 409 last_sign_in_method for a passwordless account with one link, and changes nothing — then 204 once an admin has set a password', async () => {
      provider.setNextIdentity({ sub: 'k8-single-link', preferred_username: 'k8singlelink' });
      const { callback, jar } = await driveOidcLogin(live.origin);
      expect(callback.status).toBe(302);
      const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'k8-single-link'));
      const userId = link.userId;
      const [account] = await database.db.select().from(users).where(eq(users.id, userId));
      expect(account.passwordHash).toBe(SSO_ONLY_PASSWORD_HASH);

      const mint = await fetch(`${live.origin}/api/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: cookieHeader(jar) },
        body: JSON.stringify({ name: 'k8-probe', scope: ['GET /api/auth/me'] }),
      });
      expect(mint.status).toBe(201);
      const secret = (await mint.json()).secret as string;

      const refused = await unlinkWith(jar);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual(LAST_SIGN_IN_METHOD_BODY);

      // The refusal changed nothing: the link, the session and the token all survive it.
      expect(await linksOf(userId)).toHaveLength(1);
      const me = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
      expect(me.status).toBe(200);
      const meByToken = await fetch(`${live.origin}/api/auth/me`, { headers: { authorization: `Bearer ${secret}` } });
      expect(meByToken.status).toBe(200);
      const sessions = await database.db.select().from(userSessions).where(eq(userSessions.userId, userId));
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((s) => s.revokedAt === null)).toBe(true);
      const tokens = await database.db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
      expect(tokens.every((t) => t.revokedAt === null)).toBe(true);
      await live.ctx.audit.settled();
      expect((await events()).filter((e) => e.actorUserId === userId && e.action === 'DELETE /api/auth/oidc/link')).toHaveLength(0);

      // What ADR-0081 tells the user to do: an admin sets a password, which replaces the sentinel.
      await setPassword(database.db, userId, 'a-long-enough-password-7!', false);
      const allowed = await unlinkWith(jar);
      expect(allowed.status).toBe(204);
      expect(await linksOf(userId)).toHaveLength(0);
    });

    it('answers 409 for a passwordless account with several links too, and keeps every one of them — the route would have removed them all at once', async () => {
      provider.setNextIdentity({ sub: 'k8-multi-link', preferred_username: 'k8multilink' });
      const { callback, jar } = await driveOidcLogin(live.origin);
      expect(callback.status).toBe(302);
      const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'k8-multi-link'));
      await database.db
        .insert(userFederatedIdentities)
        .values({ userId: link.userId, provider: 'second', issuer: 'https://second-idp.example', subject: 'k8-multi-link-second' });
      expect(await linksOf(link.userId)).toHaveLength(2);

      const refused = await unlinkWith(jar);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual(LAST_SIGN_IN_METHOD_BODY);
      expect(await linksOf(link.userId)).toHaveLength(2);
    });

    it('answers a no-op 204 for an account with no link at all, with a password or without one, and revokes nothing', async () => {
      const withPassword = await signInLocalUser('k8-nolink-password');
      const withoutPassword = await signInLocalUser('k8-nolink-sentinel');
      await database.db.update(users).set({ passwordHash: SSO_ONLY_PASSWORD_HASH }).where(eq(users.id, withoutPassword.userId));

      for (const account of [withPassword, withoutPassword]) {
        const res = await unlinkWith(account.jar);
        expect(res.status).toBe(204);
        const me = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(account.jar) } });
        expect(me.status).toBe(200);
      }
    });

    it('answers 204 for an account with a password of its own and removes its link (the existing unlink path, unchanged)', async () => {
      const { jar, userId } = await signInLocalUser('k8-password-link');
      provider.setNextIdentity({ sub: 'k8-password-link-identity', preferred_username: 'irrelevant-here' });
      const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(jar) });
      expect((await hitCallback(callbackUrl, { ...jar, ...flowJar })).status).toBe(302);
      expect(await linksOf(userId)).toHaveLength(1);

      const res = await unlinkWith(jar);
      expect(res.status).toBe(204);
      expect(await linksOf(userId)).toHaveLength(0);
    });
  });

  it('refuses a password sign-in to an SSO-only account exactly as it refuses an unknown username — same body, and one password derivation paid for each ([ADR-0081] §2)', async () => {
    provider.setNextIdentity({ sub: 'k8-sentinel-login', preferred_username: 'k8sentinellogin' });
    const { callback } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    const [account] = await database.db.select().from(users).where(eq(users.username, 'k8sentinellogin'));
    expect(account.passwordHash).toBe(SSO_ONLY_PASSWORD_HASH);

    const login = (username: string): Promise<Response> =>
      fetch(`${live.origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'whatever-password-1!' }),
      });
    /** Runs one sign-in attempt and counts how many `scrypt` derivations it paid for. */
    const derivationsOf = async (username: string): Promise<{ res: Response; body: unknown; derivations: number }> => {
      const before = scryptCalls.n;
      const res = await login(username);
      const body = await res.json();
      return { res, body, derivations: scryptCalls.n - before };
    };

    // The first unknown-username attempt also builds the lazy dummy hash (one extra derivation, once
    // per process) — spent here so both measured attempts below start from the same state.
    expect((await login('k8-unknown-warmup')).status).toBe(401);

    const unknown = await derivationsOf('k8-no-such-user');
    const sentinel = await derivationsOf('k8sentinellogin');

    expect(unknown.res.status).toBe(401);
    expect(sentinel.res.status).toBe(401);
    expect(sentinel.body).toEqual({ error: 'invalid_credentials', message: 'Wrong username or password' });
    expect(sentinel.body).toEqual(unknown.body);
    // A counter, not a stopwatch: the unknown-username path pays exactly one derivation, and so must
    // the sentinel path — without `burnPasswordTime` it would pay none and answer measurably faster.
    expect(unknown.derivations).toBe(1);
    expect(sentinel.derivations).toBe(1);
  });

  describe('each SSO write re-decides under the account row lock, whichever side takes it first ([F14-T7-MINOR-3]: L-b, L-e, L-f, L-g)', () => {
    it('a login callback queued behind an unlink that already holds the row sees the link gone and writes no session (L-b)', async () => {
      const { jar: ownerJar, userId } = await signInLocalUser('lb-unlink-first');
      provider.setNextIdentity({ sub: 'lb-unlink-first-identity', preferred_username: 'irrelevant-here' });
      const { jar: linkFlowJar, callbackUrl: linkCallbackUrl } = await startOidcFlow(live.origin, {
        startPath: '/api/auth/oidc/link',
        cookie: cookieHeader(ownerJar),
      });
      expect((await hitCallback(linkCallbackUrl, { ...ownerJar, ...linkFlowJar })).status).toBe(302);

      provider.setNextIdentity({ sub: 'lb-unlink-first-identity', preferred_username: 'irrelevant-here' });
      const { jar: loginFlowJar, callbackUrl: loginCallbackUrl } = await startOidcFlow(live.origin);

      // The unlink's own transaction, parked while it holds the row: it has deleted the link and revoked
      // the sessions, and not yet committed — so the callback's pre-lock lookup still finds the link.
      const entered = deferred<void>();
      const release = deferred<void>();
      const holder = withUserRowLock(database.db, userId, async (tx) => {
        await unlinkFederatedIdentity(tx, userId);
        await revokeSessionsOfUser(tx, userId);
        entered.resolve();
        await release.promise;
      });
      try {
        await entered.promise;
        const callbackPromise = hitCallback(loginCallbackUrl, loginFlowJar);
        expect(await waitForLockWaiter(database.pool)).toBe(true);
        release.resolve();
        await holder;
        const callback = await callbackPromise;

        expect(callback.status).toBe(302);
        expect(callback.headers.get('location')).toBe('/login?oidc_error=no_account');
        expect(loginFlowJar[SESSION_COOKIE]).toBeFalsy();
        const sessions = await database.db.select().from(userSessions).where(eq(userSessions.userId, userId));
        expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      } finally {
        release.resolve();
        await holder.catch(() => undefined);
      }
    });

    it('a link callback queued behind a promotion to root that already holds the row sees root and refuses to link (L-f, L-g)', async () => {
      const { jar, userId } = await signInLocalUser('lfg-promote-first');
      provider.setNextIdentity({ sub: 'lfg-promote-first-identity', preferred_username: 'irrelevant-here' });
      const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(jar) });

      const entered = deferred<void>();
      const release = deferred<void>();
      const promotion = updateUser(
        database.db,
        userId,
        { role: 'root' },
        {
          onRowLocked: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      );
      try {
        await entered.promise;
        let settled = false;
        const callbackPromise = hitCallback(callbackUrl, { ...jar, ...flowJar }).finally(() => {
          settled = true;
        });
        // The callback is queued on the row the promotion holds — observed, not assumed.
        expect(await waitForLockWaiter(database.pool)).toBe(true);
        expect(settled).toBe(false);
        release.resolve();

        const promoted = await promotion;
        expect(promoted.role).toBe('root');
        const callback = await callbackPromise;
        expect(callback.status).toBe(302);
        expect(callback.headers.get('location')).toBe('/login?oidc_error=root_local_only');
        const links = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.userId, userId));
        expect(links).toHaveLength(0);
      } finally {
        release.resolve();
        await promotion.catch(() => undefined);
      }
    });

    it('a promotion to root queued behind a link that already holds the row sees the link and is refused (L-e)', async () => {
      const { userId } = await signInLocalUser('le-link-first');
      const lookup = { issuer: provider.issuer, subject: 'le-link-first-identity' };

      const entered = deferred<void>();
      const release = deferred<void>();
      const holder = withUserRowLock(database.db, userId, async (tx) => {
        await linkFederatedIdentity(tx, { userId, provider: 'local', ...lookup });
        entered.resolve();
        await release.promise;
      });
      try {
        await entered.promise;
        const promotion = updateUser(database.db, userId, { role: 'root' });
        promotion.catch(() => undefined);
        expect(await waitForLockWaiter(database.pool)).toBe(true);
        release.resolve();
        await holder;

        await expect(promotion).rejects.toBeInstanceOf(PromotionRefusedError);
        const [row] = await database.db.select().from(users).where(eq(users.id, userId));
        expect(row.role).toBe('member');
        const links = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.userId, userId));
        expect(links).toHaveLength(1);
      } finally {
        release.resolve();
        await holder.catch(() => undefined);
      }
    });
  });
});

describe('root cannot be reached through a linked SSO identity (tur 6 addendum of ADR-0077)', () => {
  it('refuses to promote an SSO-linked account to root, and leaves its role untouched (root_requires_unlink)', async () => {
    provider.setNextIdentity({ sub: 'promote-linked-refused', preferred_username: 'promotelinkedrefused' });
    const { callback } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);

    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'promote-linked-refused'));
    expect(link).toBeTruthy();

    const promote = await fetch(`${live.origin}/api/users/${link.userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}` },
      body: JSON.stringify({ role: 'root' }),
    });
    expect(promote.status).toBe(409);
    expect((await promote.json()).error).toBe('root_requires_unlink');

    const [row] = await database.db.select().from(users).where(eq(users.id, link.userId));
    expect(row.role).toBe('member');
  });

  it('revokes every session and API token an account holds on unlink, and only then can it be promoted — the old credentials stay dead afterwards', async () => {
    provider.setNextIdentity({ sub: 'unlink-revokes-credentials', preferred_username: 'unlinkrevokescreds' });
    const { callback, jar } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'unlink-revokes-credentials'));
    expect(link).toBeTruthy();

    const mint = await fetch(`${live.origin}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: cookieHeader(jar) },
      body: JSON.stringify({ name: 'unlink-probe', scope: ['GET /api/auth/me'] }),
    });
    expect(mint.status).toBe(201);
    const secret = (await mint.json()).secret as string;

    // An auto-provisioned account has no password of its own, and unlinking its only way in is refused
    // (`409 last_sign_in_method`, [ADR-0081], FR-602 — proven on its own below). Giving it one first is
    // exactly what ADR-0081 tells an administrator to do; it goes straight to the service here, since
    // the admin route also revokes every session and token, which is what this test wants the unlink
    // itself to be seen doing.
    await setPassword(database.db, link.userId, 'a-long-enough-password-4!', false);

    // Both credentials work before the unlink.
    const sessionBefore = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    expect(sessionBefore.status).toBe(200);
    const tokenBefore = await fetch(`${live.origin}/api/auth/me`, { headers: { authorization: `Bearer ${secret}` } });
    expect(tokenBefore.status).toBe(200);

    const unlink = await fetch(`${live.origin}/api/auth/oidc/link`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader(jar), 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    });
    expect(unlink.status).toBe(204);

    // Both go dead in the same request that removed the link — not on their own next natural check.
    const sessionAfter = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    expect(sessionAfter.status).toBe(401);
    const tokenAfter = await fetch(`${live.origin}/api/auth/me`, { headers: { authorization: `Bearer ${secret}` } });
    expect(tokenAfter.status).toBe(401);

    // The identity is gone now, so the promotion this account was refused above succeeds.
    const promote = await fetch(`${live.origin}/api/users/${link.userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}` },
      body: JSON.stringify({ role: 'root' }),
    });
    expect(promote.status).toBe(200);
    expect((await promote.json()).role).toBe('root');

    // The session and token revoked by the unlink do not come back to life just because the account
    // they name is root now — neither was ever re-issued, so both stay exactly as dead as they were.
    const sessionAfterPromote = await fetch(`${live.origin}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    expect(sessionAfterPromote.status).toBe(401);
    const tokenAfterPromote = await fetch(`${live.origin}/api/auth/me`, { headers: { authorization: `Bearer ${secret}` } });
    expect(tokenAfterPromote.status).toBe(401);
  });

  it("a token minted from an SSO session before an attempted promotion never gains root authority, because the promotion itself is refused (replays the reviewer's tur 5 probe, [T5-MAJOR-1])", async () => {
    provider.setNextIdentity({ sub: 'token-probe-then-promote', preferred_username: 'tokenprobethenpromote' });
    const { callback, jar } = await driveOidcLogin(live.origin);
    expect(callback.status).toBe(302);
    const [link] = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, 'token-probe-then-promote'));
    expect(link).toBeTruthy();

    // The exact shape of the reviewer's tur 5 Q2 probe: an unrestricted, non-expiring token scoped to
    // the very route that mints a root account, minted while the account is still only a member.
    const mint = await fetch(`${live.origin}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: cookieHeader(jar) },
      body: JSON.stringify({ name: 'q2-probe', scope: ['POST /api/users'] }),
    });
    expect(mint.status).toBe(201);
    const secret = (await mint.json()).secret as string;

    const promote = await fetch(`${live.origin}/api/users/${link.userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}` },
      body: JSON.stringify({ role: 'root' }),
    });
    expect(promote.status).toBe(409);
    expect((await promote.json()).error).toBe('root_requires_unlink');
    const [stillMember] = await database.db.select().from(users).where(eq(users.id, link.userId));
    expect(stillMember.role).toBe('member');

    // With the promotion refused, the token's owner is still `member` — the scope alone was never
    // enough, and reading the owner's live role is what actually stops this ([ADR-0076]).
    const exploit = await fetch(`${live.origin}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ username: 'root-via-q2-token', role: 'root', password: 'a-long-enough-password-4!' }),
    });
    expect(exploit.status).toBe(403);
    const [created] = await database.db.select().from(users).where(eq(users.username, 'root-via-q2-token'));
    expect(created).toBeUndefined();
  });

  describe('promotion gate re-checks role and link state under the lock, not against its pre-lock read ([T7-MINOR-2] fix of ADR-0077)', () => {
    it('refuses a PATCH that resends role:"root" once the account has been demoted and linked since that PATCH read its stale pre-lock state', async () => {
      const password = 'a-long-enough-password-5!';
      const created = await createUser(database.db, { username: 'stale-promote-then-link', role: 'root', password });
      const loginRes = await fetch(`${live.origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'stale-promote-then-link', password }),
      });
      expect(loginRes.status).toBe(200);
      const jar = jarFromSetCookie(loginRes.headers.getSetCookie());
      const targetId = created.id;

      const entered = deferred<void>();
      const release = deferred<void>();
      live.ctx.testHooks = {
        // Fires before `updateUser` ever calls `withUserRowLock` ([T7-MINOR-2] fix): pausing here is
        // after `before` (and therefore `target` in the route above) has already been read as
        // `role: 'root'`, but before the fresh, locked read the fix computes `promotesToRoot`/`losesRoot`
        // from. That gap is exactly where a demotion and a self-service link need to land and commit for
        // this test to exercise the old bug: a PATCH that merely resends the account's current role
        // (the real trigger, per `public/users.js`, which always sends `role` alongside any edit) saw
        // `before.role === 'root'` and therefore never ran the identity check at all, regardless of what
        // happened afterward.
        onUserUpdateBeforeLock: async () => {
          entered.resolve();
          await release.promise;
        },
      };

      try {
        const patchPromise = fetch(`${live.origin}/api/users/${targetId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_BEARER}` },
          body: JSON.stringify({ role: 'root', displayName: 'renamed while stale' }),
        });
        await entered.promise;

        // Demoted by a direct write, the same way `scripts/restore.ts` or an operator's own SQL can
        // change a role outside `updateUser` (an already-documented, pre-existing gap this test does not
        // otherwise exercise) — chosen here so this step needs no lock of its own and cannot itself be
        // paused by the same hook, keeping the race deterministic.
        await database.db.update(users).set({ role: 'member' }).where(eq(users.id, targetId));

        provider.setNextIdentity({ sub: 'stale-promote-then-link-identity', preferred_username: 'irrelevant-here' });
        const { jar: flowJar, callbackUrl } = await startOidcFlow(live.origin, { startPath: '/api/auth/oidc/link', cookie: cookieHeader(jar) });
        const linkCallback = await hitCallback(callbackUrl, { ...jar, ...flowJar });
        expect(linkCallback.status).toBe(302);
        const [link] = await database.db
          .select()
          .from(userFederatedIdentities)
          .where(eq(userFederatedIdentities.subject, 'stale-promote-then-link-identity'));
        expect(link).toBeTruthy();
        expect(link.userId).toBe(targetId);

        // The demotion and the link have both fully committed before the parked PATCH above is let
        // through — it must now re-decide against what actually exists, not the root-with-no-link
        // snapshot it read before it was ever paused.
        release.resolve();
        const patch = await patchPromise;
        expect(patch.status).toBe(409);
        const patchBody = (await patch.json()) as { error?: string };
        expect(patchBody.error).toBe('root_requires_unlink');

        const [row] = await database.db.select().from(users).where(eq(users.id, targetId));
        expect(row.role).toBe('member');
        expect(row.displayName).not.toBe('renamed while stale');
      } finally {
        live.ctx.testHooks = undefined;
      }
    });
  });
});

describe('a "next" outside Latin-1 ([F14-T2-MINOR-1])', () => {
  it('redirects to the percent-encoded path instead of failing to write the Location header', async () => {
    provider.setNextIdentity({ sub: 'non-latin1-next', preferred_username: 'nonlatin1next' });
    const turkish = await driveOidcLogin(live.origin, '/ş');
    expect(turkish.callback.status).toBe(302);
    expect(turkish.callback.headers.get('location')).toBe('/%C5%9F');
    expect(turkish.jar[SESSION_COOKIE]).toBeTruthy();

    provider.setNextIdentity({ sub: 'non-latin1-next', preferred_username: 'nonlatin1next' });
    const cjk = await driveOidcLogin(live.origin, '/文書');
    expect(cjk.callback.status).toBe(302);
    expect(cjk.callback.headers.get('location')).toBe('/%E6%96%87%E6%9B%B8');
  });
});

describe('federated identity writes under concurrency ([F14-MINOR-1], [F14-T2-MINOR-2])', () => {
  it('provisions the account and its identity row in one transaction: losing the identity insert leaves no orphan account behind', async () => {
    const owner = await createUser(database.db, { username: 'provision-owner', role: 'member', password: 'a-long-enough-password-6!' });
    const lookup = { issuer: 'https://provision-probe.example', subject: 'provision-probe-subject' };
    // The identity is already taken — exactly what a concurrent first sign-in that committed first
    // looks like from this attempt's side, once its own account row is already written.
    await database.db.insert(userFederatedIdentities).values({ userId: owner.id, provider: 'probe', ...lookup });

    const result = await provisionFederatedUser(database.db, { provider: 'probe', ...lookup, role: 'member', preferredUsername: 'orphan-probe' });

    expect(result.created).toBe(false);
    expect(result.user.id).toBe(owner.id);
    const orphans = await database.db.select().from(users).where(eq(users.username, 'orphan-probe'));
    expect(orphans).toHaveLength(0);
  });

  it('answers a link that loses the unique-index race with ConflictError, not a raw constraint error', async () => {
    const loser = await createUser(database.db, { username: 'link-race-loser', role: 'member', password: 'a-long-enough-password-6!' });
    const winner = await createUser(database.db, { username: 'link-race-winner', role: 'member', password: 'a-long-enough-password-6!' });
    const lookup = { issuer: 'https://link-race.example', subject: 'link-race-subject' };

    // The winner's insert, left uncommitted: the loser's fast-path read finds nothing, and its own
    // insert then waits on the unique index until the winner commits — and trips it.
    const client = await database.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO user_federated_identities (user_id, provider, issuer, subject) VALUES ($1, $2, $3, $4)', [
        winner.id,
        'probe',
        lookup.issuer,
        lookup.subject,
      ]);
      const link = linkFederatedIdentity(database.db, { userId: loser.id, provider: 'probe', ...lookup });
      link.catch(() => undefined);
      expect(await waitForLockWaiter(database.pool)).toBe(true);
      await client.query('COMMIT');
      committed = true;

      await expect(link).rejects.toBeInstanceOf(ConflictError);
      const rows = await database.db.select().from(userFederatedIdentities).where(eq(userFederatedIdentities.subject, lookup.subject));
      expect(rows.map((r) => r.userId)).toEqual([winner.id]);
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('removing root accounts: one lock order, and the last active root stays ([F14-T7-MINOR-1], [F14-T10-MINOR-1])', () => {
  // A database of its own: these tests count active roots, and the shared one has roots other tests
  // created and left behind.
  let rootsDb: TestDatabase;
  const password = 'a-long-enough-password-8!';

  beforeAll(async () => {
    rootsDb = await createTestDatabase(baseUrl, 'oidc_root_locks');
    await applySchema(rootsDb);
  });

  afterAll(async () => {
    if (rootsDb) await dropTestDatabase(baseUrl, rootsDb);
  });

  beforeEach(async () => {
    await rootsDb.db.update(users).set({ role: 'member' }).where(eq(users.role, 'root'));
  });

  const activeRoots = async (): Promise<string[]> =>
    (await rootsDb.db.select().from(users).where(eq(users.role, 'root'))).filter((u) => u.isActive).map((u) => u.id);

  /**
   * Parks each caller right after it holds its account row, until all `parties` are parked or
   * `fallbackMs` passes. Under the old order (row first, then the root set) both removers get here
   * holding their own row and then each asks for the other's — a guaranteed deadlock. Under the fixed
   * order the second remover is still queued on the root set, never arrives, and the first moves on
   * after the fallback.
   */
  function rowLockedBarrier(parties: number, fallbackMs = 750): () => Promise<void> {
    let arrived = 0;
    const all = deferred<void>();
    return async () => {
      arrived += 1;
      if (arrived >= parties) all.resolve();
      await Promise.race([all.promise, sleep(fallbackMs)]);
    };
  }

  /** Exactly one remover wins, the other is refused as the last root — and neither is a deadlock. */
  function expectOneWinnerNoDeadlock(results: PromiseSettledResult<unknown>[]): void {
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const r of rejected) expect(pgCode(r.reason), String(r.reason)).not.toBe('40P01');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
  }

  it('demotes one of two roots demoted at the same moment and refuses the other, without a deadlock (40P01)', async () => {
    const x = await createUser(rootsDb.db, { username: 'deadlock-root-x', role: 'root', password });
    const y = await createUser(rootsDb.db, { username: 'deadlock-root-y', role: 'root', password });
    const onRowLocked = rowLockedBarrier(2);

    const results = await Promise.allSettled([
      updateUser(rootsDb.db, x.id, { role: 'member' }, { onRowLocked }),
      updateUser(rootsDb.db, y.id, { role: 'member' }, { onRowLocked }),
    ]);

    expectOneWinnerNoDeadlock(results);
    expect(await activeRoots()).toHaveLength(1);
  });

  it('takes the locks in the same order for a delete racing a demotion, without a deadlock', async () => {
    const x = await createUser(rootsDb.db, { username: 'deadlock-delete-x', role: 'root', password });
    const y = await createUser(rootsDb.db, { username: 'deadlock-delete-y', role: 'root', password });
    const onRowLocked = rowLockedBarrier(2);

    const results = await Promise.allSettled([
      deleteUser(rootsDb.db, x.id, { onRowLocked }),
      updateUser(rootsDb.db, y.id, { role: 'member' }, { onRowLocked }),
    ]);

    expectOneWinnerNoDeadlock(results);
    expect(await activeRoots()).toHaveLength(1);
  });

  it('refuses to demote, disable or delete the last active root, and leaves it an active root', async () => {
    const only = await createUser(rootsDb.db, { username: 'last-root', role: 'root', password });

    await expect(updateUser(rootsDb.db, only.id, { role: 'member' })).rejects.toBeInstanceOf(ConflictError);
    await expect(updateUser(rootsDb.db, only.id, { isActive: false })).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteUser(rootsDb.db, only.id)).rejects.toBeInstanceOf(ConflictError);

    expect(await activeRoots()).toEqual([only.id]);
  });

  it('demotes a root while another active root remains', async () => {
    const x = await createUser(rootsDb.db, { username: 'spare-root-x', role: 'root', password });
    const y = await createUser(rootsDb.db, { username: 'spare-root-y', role: 'root', password });

    const demoted = await updateUser(rootsDb.db, x.id, { role: 'member' });

    expect(demoted.role).toBe('member');
    expect(await activeRoots()).toEqual([y.id]);
  });

  it('counts the other active roots under the lock: the other root demoted in between makes this the last one', async () => {
    const x = await createUser(rootsDb.db, { username: 'stale-root-x', role: 'root', password });
    const y = await createUser(rootsDb.db, { username: 'stale-root-y', role: 'root', password });

    const demotion = updateUser(
      rootsDb.db,
      x.id,
      { role: 'member' },
      {
        // After the unlocked pre-read (which saw two roots), before any lock: the other root goes.
        onBeforeLock: async () => {
          await rootsDb.db.update(users).set({ role: 'member' }).where(eq(users.id, y.id));
        },
      },
    );

    await expect(demotion).rejects.toBeInstanceOf(ConflictError);
    expect(await activeRoots()).toEqual([x.id]);
  });

  it('decides losesRoot from the read under the lock, not the pre-lock read: an admin promoted to last root in between is refused the demotion and the disable ([F14-T10-MINOR-1])', async () => {
    for (const [label, input] of [
      ['demotion', { role: 'member' }],
      ['disable', { isActive: false }],
    ] as const) {
      await rootsDb.db.update(users).set({ role: 'member' }).where(eq(users.role, 'root'));
      const x = await createUser(rootsDb.db, { username: `promoted-root-x-${label}`, role: 'admin', password });
      const y = await createUser(rootsDb.db, { username: `promoted-root-y-${label}`, role: 'root', password });

      const change = updateUser(rootsDb.db, x.id, input, {
        // The unlocked pre-read saw X as an admin — nothing for this request to protect. Before any lock,
        // X becomes root and the only other root goes, so X is now the last root: only a `losesRoot`
        // decided from the read under the lock still sees that.
        onBeforeLock: async () => {
          await rootsDb.db.update(users).set({ role: 'root' }).where(eq(users.id, x.id));
          await rootsDb.db.update(users).set({ role: 'member' }).where(eq(users.id, y.id));
        },
      });

      await expect(change, label).rejects.toBeInstanceOf(ConflictError);
      const [row] = await rootsDb.db.select().from(users).where(eq(users.id, x.id));
      expect({ role: row.role, isActive: row.isActive }, label).toEqual({ role: 'root', isActive: true });
      expect(await activeRoots(), label).toEqual([x.id]);
    }
  });
});

describe('an instance with no OIDC_ISSUER_URL set', () => {
  it('refuses both OIDC routes and reports SSO as disabled when no issuer is configured', async () => {
    const plainRoot = await mkdtemp(path.join(tmpdir(), 'contextator-oidc-off-'));
    const plain = await startMcpInstance(database, { dataDir: path.join(plainRoot, '.data'), docRoot: plainRoot });
    try {
      const status = await fetch(`${plain.origin}/api/setup/status`, { headers: { accept: 'application/json' } });
      const body = await status.json();
      expect(body.oidc).toEqual({ enabled: false });

      // The login route has nothing to redirect to, so it 404s outright.
      const login = await fetch(`${plain.origin}/api/auth/oidc/login`, { redirect: 'manual' });
      expect(login.status).toBe(404);

      // The callback route sends a browser back to /login with an error rather than 404ing, since a
      // stray callback hit (e.g. a stale bookmark from when OIDC was configured) is still a browser
      // that needs somewhere sensible to land.
      const callback = await fetch(`${plain.origin}/api/auth/oidc/callback`, { redirect: 'manual' });
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('/login?oidc_error=not_configured');
    } finally {
      await plain.close();
      await rm(plainRoot, { recursive: true, force: true });
    }
  });
});
