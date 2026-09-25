import type { EventDecision } from './notion-webhook.js';

/**
 * The Confluence webhook: which deliveries mean a run.
 *
 * Everything else is [ADR-0049](../../.ssot/ADR.md#adr-0049)'s machinery reused as it stands — the
 * per-source secret column, `noteDelivery`'s debounce and the scheduler's claim that outranks the
 * probe. What is Confluence's own is only the shape of a delivery and the list below.
 *
 * **What a delivery is, and is not.** Confluence Data Center (7.7 and later) posts a small JSON body —
 * `{"event":"page_updated","timestamp":…,"userKey":…,"page":{"id":…}}` and its relatives — signed with
 * `X-Hub-Signature`. It names *that* something changed and nothing of what; the run it causes is the
 * ordinary sync, which is what already knows how to skip every page whose version did not move
 * ([ADR-0059](../../.ssot/ADR.md#adr-0059)). So a delivery is a hint to look now rather than at the
 * next interval, never a statement of the index's content.
 *
 * **A Data Center webhook is instance-wide.** Its admin form picks events, not spaces, so a source that
 * indexes one space still hears every edit in every other. That is tolerated rather than filtered: the
 * body identifies content by id, finding its space would be an API call per delivery, and the
 * debounce already folds a burst into one run whose cost is a listing.
 */

/** The `event` of a delivery, or `null` when the body is not a delivery this product recognises. */
export function confluenceEventOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = (payload as { event?: unknown }).event;
  return typeof event === 'string' && event.length > 0 && event.length <= 100 ? event : null;
}

/**
 * Families of events that cannot change what this product indexes. The driver reads a page's title,
 * its ancestors, its version and its `body.storage` — nothing else — so:
 *
 * - `comment_*`: comments are not rendered into the Markdown a page becomes, and on a busy instance
 *   they are the most frequent event there is.
 * - `user_*`, `group_*`: directory changes. They move nobody's content.
 * - `label_*`: labels are not read.
 * - `attachment_*`: attachments are not indexed; a page that *embeds* one changes its own version when
 *   it is edited, and that arrives as a `page_updated` of its own.
 * - `relation_*`: likes and favourites.
 */
const NEVER_QUEUES_PREFIXES = ['comment_', 'user_', 'group_', 'label_', 'attachment_', 'relation_'] as const;
const NEVER_QUEUES = new Set(['theme_enabled', 'space_logo_updated']);

/**
 * Whether a delivery of this event is worth a run.
 *
 * **Anything not excluded above queues one, including an event this build has never heard of** — the
 * same rule as the Notion filter and for the same reason ([ADR-0048](../../.ssot/ADR.md#adr-0048)): an
 * optimisation that can silently stop a source syncing is a bug that looks like a working product.
 * Permission events (`content_permissions_updated`, `space_permissions_updated`) queue for that reason:
 * a restriction can take pages out of what this account may read.
 */
export function decideConfluenceEvent(event: string | null): EventDecision {
  if (event === null) return { queue: true, reason: 'unrecognised delivery; indexing anyway' };
  if (NEVER_QUEUES.has(event) || NEVER_QUEUES_PREFIXES.some((prefix) => event.startsWith(prefix))) {
    return { queue: false, reason: `${event} does not change indexed content` };
  }
  return { queue: true, reason: event };
}
