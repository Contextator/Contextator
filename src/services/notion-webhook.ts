import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { WEBHOOK_VERIFICATION_WINDOW_MINUTES } from '../config.js';
import type { Db } from '../db/client.js';
import { documentSources, type DocumentSourceRow } from '../db/schema.js';

/**
 * The Notion webhook ([ADR-0049](../../.ssot/ADR.md#adr-0049)): which deliveries mean a run, and the
 * three column writes that stand between a delivery and `Indexer.enqueue`.
 *
 * The verification half is the part that needed a decision rather than an implementation. Every
 * webhook before this one had a secret *this* product generated and the operator carried outward
 * ([ADR-0018](../../.ssot/ADR.md#adr-0018)); Notion mints its own, POSTs it once, unsigned, to a URL
 * that was never a secret, and signs everything afterwards with it. So the token is storable only
 * inside a window an editor opened — and the operator then has to carry that token *back* into
 * Notion's own modal, without which the subscription stays "pending verification" and nothing is ever
 * delivered.
 */

/** The shape of the one-time body Notion POSTs when a subscription is created. */
export interface VerificationBody {
  verification_token: string;
}

export function verificationTokenOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const token = (payload as Partial<VerificationBody>).verification_token;
  return typeof token === 'string' && token.length > 0 && token.length <= 500 ? token : null;
}

/** The `type` of a delivery, or `null` when the body is not a delivery this product recognises. */
export function eventTypeOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const type = (payload as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

/**
 * Events that cannot have changed what this product indexes, and therefore queue nothing.
 *
 * `comment.*`: comments are not rendered into the Markdown a page becomes, and `comment.created` is
 * the highest-frequency **non-aggregated** event Notion sends — the one an active page produces per
 * keystroke of somebody else's discussion.
 *
 * `page.locked` / `page.unlocked`: lock state is a property no driver reads. They are named
 * individually rather than by a rule, because they are also the only other non-aggregated page events
 * and getting them wrong is a run per lock.
 */
const NEVER_QUEUES = new Set(['comment.created', 'comment.updated', 'comment.deleted', 'page.locked', 'page.unlocked']);

export interface EventDecision {
  queue: boolean;
  reason: string;
}

/**
 * Whether a delivery of this type is worth a run.
 *
 * **Everything that is not on the list above queues one, including a type this build has never heard
 * of.** That is [ADR-0048](../../.ssot/ADR.md#adr-0048)'s rule about probes applied one layer out:
 * every uncertainty resolves toward the run, because an optimisation that can silently stop a source
 * syncing is a bug that looks like a working product for weeks. It is also what makes the deprecated
 * `database.content_updated` / `database.schema_updated` and their `data_source.*` successors both
 * work without a table of names — which pair an instance receives depends on the API version bound to
 * the subscription, and nothing here should have an opinion about that.
 */
export function decideEvent(type: string | null): EventDecision {
  if (type === null) return { queue: true, reason: 'unrecognised delivery; indexing anyway' };
  if (NEVER_QUEUES.has(type)) return { queue: false, reason: `${type} does not change indexed content` };
  return { queue: true, reason: type };
}

/** Opens (or replaces) the window during which a `verification_token` may be stored for this source. */
export async function openVerificationWindow(db: Db, sourceId: string): Promise<Date> {
  const [row] = await db
    .update(documentSources)
    .set({ webhookVerificationExpiresAt: sql`now() + make_interval(mins => ${WEBHOOK_VERIFICATION_WINDOW_MINUTES})` })
    .where(eq(documentSources.id, sourceId))
    .returning({ expiresAt: documentSources.webhookVerificationExpiresAt });
  return row.expiresAt as Date;
}

/**
 * Stores the token **only if a window is open**, and closes the window in the same statement.
 *
 * Both halves of that sentence are the decision. The window is what stops "whoever POSTs first sets
 * the secret" from being true of a URL that is not a secret; closing it here — rather than in a second
 * statement, or on a timer — is what makes it one-shot, so a delivery that arrives a moment later
 * cannot take the source over. Outside a window nothing at all is written, which is why the caller can
 * answer `401` without wondering what state it left behind.
 *
 * The comparison is made by the database, like every other deadline in this product, so that clock
 * skew between the application and PostgreSQL cannot open a window that is shut.
 */
export async function captureVerificationToken(db: Db, sourceId: string, token: string): Promise<boolean> {
  const stored = await db
    .update(documentSources)
    .set({ webhookSecret: token, webhookVerificationExpiresAt: null })
    .where(
      and(
        eq(documentSources.id, sourceId),
        isNotNull(documentSources.webhookVerificationExpiresAt),
        sql`${documentSources.webhookVerificationExpiresAt} > now()`,
      ),
    )
    .returning({ id: documentSources.id });
  return stored.length === 1;
}

export interface DeliveryDecision {
  /** The run is owed now: the caller enqueues it in the interactive lane. */
  enqueueNow: boolean;
  /** When the scheduler's tick will take it instead. `null` exactly when `enqueueNow` is true. */
  dueAt: Date | null;
}

/**
 * The debounce, as one statement whose comparison happens in SQL.
 *
 * - **The last sync is already older than the minimum** — or there has never been one — so the run is
 *   owed now, and the caller enqueues it on the interactive lane with `trigger: 'webhook'`. This is
 *   the common case, because most deliveries arrive to a source nobody has touched for an hour, and it
 *   is what makes "seconds rather than an interval" true.
 * - **Otherwise** the claim is written at the earliest permitted moment, `last_synced_at + minimum`,
 *   and the scheduler's existing tick takes it from there. Every further delivery inside that window
 *   computes the *same* value from the same two numbers, so a bulk change that produces two hundred
 *   deliveries is two hundred idempotent updates and exactly one run.
 *
 * `least(…)` over the existing claim is belt and braces rather than arithmetic: the value is already
 * deterministic, and this makes it impossible for a delivery to push an existing claim *later*.
 */
export async function noteDelivery(db: Db, source: DocumentSourceRow, minIntervalMinutes: number): Promise<DeliveryDecision> {
  const gap = sql`make_interval(mins => ${minIntervalMinutes})`;
  const owed = sql`(${documentSources.lastSyncedAt} is null or ${documentSources.lastSyncedAt} + ${gap} <= now())`;
  const [row] = await db
    .update(documentSources)
    .set({
      webhookDueAt: sql`case when ${owed} then ${documentSources.webhookDueAt}
        else least(coalesce(${documentSources.webhookDueAt}, 'infinity'::timestamptz), ${documentSources.lastSyncedAt} + ${gap}) end`,
    })
    .where(eq(documentSources.id, source.id))
    .returning({ enqueueNow: sql<boolean>`${owed}`, dueAt: documentSources.webhookDueAt });
  return row.enqueueNow ? { enqueueNow: true, dueAt: null } : { enqueueNow: false, dueAt: row.dueAt as Date };
}

/** The minimum this source is debounced by: its own, or the instance's when it names none. */
export function minIntervalOf(source: DocumentSourceRow, instanceDefault: number): number {
  return source.webhookMinIntervalMinutes ?? instanceDefault;
}
