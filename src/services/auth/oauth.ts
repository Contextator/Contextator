import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
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
 * RFC 7591 dynamic client registration, which is how a browser-based MCP connector introduces itself:
 * it cannot be configured here in advance and the MCP authorization specification names DCR as the
 * mechanism.
 *
 * **The row confers nothing.** No grant follows from registering — every one comes from a person
 * signing in and approving this client for one project, and what that grant then reaches is decided by
 * *their* membership on every request. What the cap defends is the table, not the access: an
 * unauthenticated `INSERT` with no ceiling is a disk-filling endpoint whatever it grants.
 */
export async function registerOauthClient(db: Db, input: RegisterClientInput): Promise<OauthClientRow> {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(oauthClients);
  if (count >= input.maxClients) {
    throw new ClientLimitError(
      `This instance is holding its maximum of ${input.maxClients} registered OAuth clients. ` +
        'Unused ones are swept automatically; raise MCP_OAUTH_MAX_CLIENTS if this instance genuinely has that many.',
    );
  }
  const [row] = await db
    .insert(oauthClients)
    .values({ clientId: newClientId(), name: input.name.slice(0, 200), redirectUris: input.redirectUris })
    .returning();
  return row;
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
 * Drops clients that registered, were never used, and have been sitting there longer than `maxAgeMs`.
 *
 * A client that holds a live credential is kept whatever its age, because `mcp_tokens.client_id`
 * CASCADEs and deleting the row would silently cut a working connector off. So the predicate is
 * "never used, or unused since before the cutoff", and a client with tokens is used by definition.
 */
export async function sweepStaleOauthClients(db: Db, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const deleted = await db
    .delete(oauthClients)
    .where(
      and(
        or(isNull(oauthClients.lastUsedAt), lt(oauthClients.lastUsedAt, cutoff)),
        lt(oauthClients.createdAt, cutoff),
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
