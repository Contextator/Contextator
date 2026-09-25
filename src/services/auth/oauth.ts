import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { oauthClients, type OauthClientRow } from '../../db/schema.js';

/**
 * The authorization-server half of [ADR-0054](../../../.ssot/ADR.md#adr-0054): the clients this
 * instance has met, and the authorization codes it has handed out.
 *
 * Contextator is its own authorization server rather than a relying party. It already holds accounts,
 * sessions and the memberships the whole feature is about, so pointing at an external issuer would
 * mean mapping somebody else's subject back onto a `users` row — a second identity model in a product
 * that has one, to log in the people who are already logged in.
 */

const CLIENT_PREFIX = 'ctxc_';
const CODE_PREFIX = 'ctxo_';

/** How long an authorization code is good for. RFC 6749 says "short"; ten minutes is its own example. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

export const newClientId = (): string => CLIENT_PREFIX + randomBytes(16).toString('hex');

export class ClientLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientLimitError';
  }
}

export interface RegisterClientInput {
  name: string;
  redirectUris: string[];
  /** Refuses a registration that would take the table past this. */
  maxClients: number;
}

/**
 * Serialises registrations so the ceiling is a ceiling ([ADR-0054](../../../.ssot/ADR.md#adr-0054)).
 *
 * Counting and then inserting is two statements, and under READ COMMITTED two concurrent
 * registrations both read `199` and both insert. The window is small and the endpoint is
 * unauthenticated, which is exactly the combination somebody would widen on purpose, so the count and
 * the insert happen inside one transaction behind an advisory lock. Registration is rare — a connector
 * does it once per instance it connects to — so the contention this creates is a queue of one.
 *
 * **The whole single-argument advisory-lock inventory of this repository**, because the first version
 * of this constant was chosen by adding one to the only key its author had seen and collided with the
 * one it had not:
 *
 * | Key | Where | Scope |
 * |-----|-------|-------|
 * | `7213001` | `src/db/bootstrap.ts`, and the frozen ladder in `test/integration/fixtures/ensure-schema-v5.ts` | session |
 * | `7213002` | `ADVISORY_LOCK_SETUP` in `src/admin/auth-routes.ts` — the first-run account | transaction |
 * | `7213003` | this one | transaction |
 *
 * `7213002` put every `/oauth/register` behind whichever `POST /api/setup` was in flight and every
 * setup behind a registration — two unrelated unauthenticated endpoints silently serialising each
 * other. Nothing corrupted; it was simply not what either lock was for. Adding a key here means adding
 * a row above, and the two-argument form of `pg_advisory_xact_lock` is a **different space** again and
 * shares nothing with this table.
 */
const REGISTER_LOCK_KEY = 7213003;

/**
 * RFC 7591 dynamic client registration, which is how a browser-based MCP connector introduces itself:
 * it cannot be configured here in advance and the MCP authorization specification names DCR as the
 * mechanism.
 *
 * **The row confers nothing.** No grant follows from registering — every one comes from a person
 * signing in and approving this client for one project, and what that grant then reaches is decided by
 * *their* membership on every request. What the cap defends is the table, not the access: an
 * unauthenticated `INSERT` with no ceiling is a disk-filling endpoint whatever it grants.
 *
 * **The cap is a ceiling and not a wall**, and that distinction is what `sweepStaleOauthClients`
 * below is for: a client that registered and never came back is dropped after
 * `OAUTH_CLIENT_UNUSED_MS`, so filling the table takes sustained traffic rather than one burst, and a
 * legitimate connector registering tomorrow is not locked out by what somebody did today.
 */
export async function registerOauthClient(db: Db, input: RegisterClientInput): Promise<OauthClientRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REGISTER_LOCK_KEY})`);
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(oauthClients);
    if (count >= input.maxClients) {
      throw new ClientLimitError(
        `This instance is holding its maximum of ${input.maxClients} registered OAuth clients. ` +
          'Ones that registered and never connected are dropped within a day; raise MCP_OAUTH_MAX_CLIENTS if this instance genuinely has that many.',
      );
    }
    const [row] = await tx
      .insert(oauthClients)
      .values({ clientId: newClientId(), name: input.name.slice(0, 200), redirectUris: input.redirectUris })
      .returning();
    return row;
  });
}

export async function getOauthClient(db: Db, clientId: string): Promise<OauthClientRow | undefined> {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return row;
}

/** Throttled to a minute and off the response path, exactly as a token's `lastUsedAt` is. */
export function touchOauthClient(db: Db, clientId: string): void {
  void db
    .update(oauthClients)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(oauthClients.clientId, clientId),
        sql`(${oauthClients.lastUsedAt} is null or ${oauthClients.lastUsedAt} < now() - interval '60 seconds')`,
      ),
    )
    .catch(() => undefined);
}

/**
 * Drops registered clients nothing is using, on **two** windows rather than one.
 *
 * - A client that registered and **never came back** is dropped after `unusedMs` — a day. It is the
 *   short window because it is the only one a flood can produce: a row written by an unauthenticated
 *   `POST` that never reached the consent page is a row nobody will ever recognise, and holding it for
 *   a month would turn `MCP_OAUTH_MAX_CLIENTS` into a month-long lockout of every honest connector.
 * - A client that **did** connect and has gone quiet is dropped after `staleMs` — a month. That one is
 *   somebody's connector and deserves the longer rope.
 *
 * A client holding a live credential is kept whatever its age, because `mcp_tokens.client_id` CASCADEs
 * and deleting the row would silently cut a working connector off.
 */
export async function sweepStaleOauthClients(db: Db, windows: { unusedMs: number; staleMs: number }): Promise<number> {
  const neverUsedCutoff = new Date(Date.now() - windows.unusedMs);
  const idleCutoff = new Date(Date.now() - windows.staleMs);
  const deleted = await db
    .delete(oauthClients)
    .where(
      and(
        or(
          and(isNull(oauthClients.lastUsedAt), lt(oauthClients.createdAt, neverUsedCutoff)),
          and(isNotNull(oauthClients.lastUsedAt), lt(oauthClients.lastUsedAt, idleCutoff)),
        ),
        sql`not exists (select 1 from mcp_tokens t where t.client_id = ${oauthClients.clientId} and t.revoked_at is null)`,
      ),
    )
    .returning({ clientId: oauthClients.clientId });
  return deleted.length;
}

/**
 * An issued authorization code, before it is exchanged.
 *
 * **It is held in memory and not in a table**, which is a decision and not a shortcut. The code lives
 * for one minute and is consumed once; it is the only genuinely secret artefact of the flow that is
 * not already a hash; and this product is one process in one container by construction
 * ([ADR-0006](../../../.ssot/ADR.md#adr-0006)), so there is no second instance that would have to see
 * it. What it costs is that a restart inside that one-minute window makes the client start the flow
 * again, which is the same recovery a client already has for an expired code.
 */
interface PendingCode {
  clientId: string;
  projectId: string;
  userId: string;
  redirectUri: string;
  /** The PKCE `code_challenge`, S256 only. A public client has no secret, so this is the proof. */
  codeChallenge: string;
  /** RFC 8707: the resource the code was issued for, echoed back and checked at the token endpoint. */
  resource: string;
  /**
   * The account's `mcp_credentials_epoch` as the consent step read it under the row's `FOR SHARE`.
   * The token endpoint refuses a code whose epoch the account has since moved past: the revoke could
   * not reach a code that was not a row yet, so the exchange has to ask whether one came in between.
   */
  credentialsEpoch: number;
  expiresAt: number;
}

export class AuthorizationCodeStore {
  private readonly codes = new Map<string, PendingCode>();

  /** Returns the code to hand the browser; only its sha256 is kept, like every other credential here. */
  issue(grant: Omit<PendingCode, 'expiresAt'>, ttlMs = AUTHORIZATION_CODE_TTL_MS): string {
    this.sweep();
    const code = CODE_PREFIX + randomBytes(32).toString('hex');
    this.codes.set(hashCode(code), { ...grant, expiresAt: Date.now() + ttlMs });
    return code;
  }

  /**
   * Consumes a code. **It is removed whether or not the verifier matches**, because a code is
   * single-use by RFC 6749 §4.1.2 and a failed exchange is exactly the case where somebody else may be
   * holding it: leaving it live for the real client to retry would leave it live for them too.
   */
  redeem(code: string, verifier: string): PendingCode | { error: string } {
    this.sweep();
    const key = hashCode(code);
    const pending = this.codes.get(key);
    if (!pending) return { error: 'The authorization code is unknown, already used or expired' };
    this.codes.delete(key);
    if (pending.expiresAt <= Date.now()) return { error: 'The authorization code has expired' };
    if (!verifierMatches(verifier, pending.codeChallenge)) return { error: 'The code_verifier does not match the code_challenge' };
    return pending;
  }

  size(): number {
    this.sweep();
    return this.codes.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, pending] of this.codes) if (pending.expiresAt <= now) this.codes.delete(key);
  }
}

const hashCode = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');

/** RFC 7636 S256, and only S256: `plain` is a challenge that proves nothing and OAuth 2.1 drops it. */
export const s256Challenge = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

function verifierMatches(verifier: string, challenge: string): boolean {
  if (!verifier) return false;
  const computed = Buffer.from(s256Challenge(verifier), 'utf8');
  const expected = Buffer.from(challenge, 'utf8');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * Whether a redirect URI is one this client registered, compared as a whole string.
 *
 * **Not a prefix match and not a pattern match.** A prefix match is the open redirect of this flow:
 * `https://client.example/cb` would accept `https://client.example/cb.attacker.test`, and the
 * authorization code is handed to whatever the browser is sent to.
 */
export const redirectUriRegistered = (client: OauthClientRow, redirectUri: string): boolean => client.redirectUris.includes(redirectUri);
