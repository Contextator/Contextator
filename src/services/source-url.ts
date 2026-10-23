/**
 * Where a document lives at its origin and when the origin last changed it ([ADR-0116](../../.ssot/ADR.md#adr-0116)).
 *
 * Pure helpers shared by the source drivers (which produce the values), the indexer (which stores them)
 * and the search and read responses (which show them). Nothing here touches the network or the database.
 */

/** A longer address than this is not a link anybody follows; it is stored as unknown rather than truncated. */
export const MAX_SOURCE_URL_LENGTH = 2048;

/**
 * The only form of a link that is ever stored or returned: an absolute `http(s)` URL with no credentials
 * and no fragment, canonicalised by the URL parser. `null` for anything else — `javascript:`, `file:`,
 * `data:`, a relative path, garbage — so a hostile or malformed frontmatter value cannot become a link an
 * MCP client renders as clickable. User info is dropped rather than refused: a pasted `user:token@` must
 * never reach the database, the response or a log line (ADR-0075, ADR-0116).
 */
export function normalizeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text.length > MAX_SOURCE_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname === '') return null;
  u.username = '';
  u.password = '';
  u.hash = '';
  const href = u.href;
  return href.length > MAX_SOURCE_URL_LENGTH ? null : href;
}

/** One day of slack for clocks that disagree; a date further ahead than that is a wrong date, not a recent one. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * A date the origin reported — an HTTP-date (`Last-Modified`) or an ISO-8601 timestamp (Notion's
 * `last_edited_time`, Confluence's `version.when`). `null` when it does not parse or is implausible, so a
 * garbled header reads as "no date" and never as 1970 or as next year.
 */
export function parseSourceDate(raw: unknown, now: Date = new Date()): Date | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const d = new Date(typeof raw === 'string' ? raw.trim() : raw);
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  if (t > now.getTime() + FUTURE_TOLERANCE_MS) return null;
  return d;
}

/** `YYYY-MM-DD` in UTC, so the same document reads the same on every client (ADR-0116). */
export function formatSourceDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Whether a document has gone unchanged at its origin for longer than `staleAfterDays`
 * (`SOURCE_STALE_AFTER_DAYS`, [ADR-0116](../../.ssot/ADR.md#adr-0116)). A document with no known date is
 * never stale — "unknown" is not "old" — and `0` turns the mark off.
 */
export function isStale(modifiedAt: Date | null, staleAfterDays: number, now: Date = new Date()): boolean {
  if (!modifiedAt || !(staleAfterDays > 0)) return false;
  return now.getTime() - modifiedAt.getTime() > staleAfterDays * 24 * 60 * 60 * 1000;
}

/** Whole days between `modifiedAt` and `now`, for the "unchanged for over N days" wording. */
export function daysSince(modifiedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - modifiedAt.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * The two fields every response carries for a document, derived from the stored columns.
 * `sourceModifiedAt` is ISO-8601 (UTC) for machines; the text renderers format it themselves.
 */
export function sourceFieldsOf(
  row: { sourceUrl: string | null; sourceModifiedAt: Date | null },
  staleAfterDays: number,
  now: Date = new Date(),
): { sourceUrl: string | null; sourceModifiedAt: string | null; stale: boolean } {
  // Re-validated on the way out: a row written by an older build or an import is not trusted to be a safe link.
  return {
    sourceUrl: normalizeSourceUrl(row.sourceUrl),
    sourceModifiedAt: row.sourceModifiedAt ? row.sourceModifiedAt.toISOString() : null,
    stale: isStale(row.sourceModifiedAt, staleAfterDays, now),
  };
}

/**
 * The line shown under a search hit's heading, or `null` when nothing is known (so a source with no URL
 * and no date renders exactly as it did before 0.4). `Source: <url> · modified YYYY-MM-DD`, with the stale
 * wording appended when the threshold is passed.
 */
export function sourceLine(
  row: { sourceUrl: string | null; sourceModifiedAt: Date | null },
  staleAfterDays: number,
  now: Date = new Date(),
): string | null {
  const url = normalizeSourceUrl(row.sourceUrl);
  const when = row.sourceModifiedAt;
  if (!url && !when) return null;
  const stale = when && isStale(when, staleAfterDays, now) ? ` (unchanged for over ${staleAfterDays} days)` : '';
  if (url && when) return `Source: ${url} · modified ${formatSourceDate(when)}${stale}`;
  if (url) return `Source: ${url}`;
  return `Modified: ${formatSourceDate(when as Date)}${stale}`;
}

/** The two stored values, as the `documents` row holds them. */
export interface StoredSourceMeta {
  sourceUrl: string | null;
  sourceModifiedAt: Date | null;
}

/**
 * What to write into `documents.source_url` / `source_modified_at` for one document
 * ([ADR-0116](../../.ssot/ADR.md#adr-0116)).
 *
 * - `meta` undefined means the driver gave no answer this run (it has no `documentMeta`, or it threw):
 *   the stored values stand, because a transient failure must not erase a link.
 * - A driver that answered is believed, `null` included: a page whose `Last-Modified` header went away has
 *   no date any more, and keeping the old one would be claiming something the origin no longer says.
 * - The exception is a driver that marks its date `stampOnChange` (git): it describes the moment of
 *   observation, so for a document whose text did not change the stored date is kept and is filled only
 *   while it is still `null`. That is what stops one commit from dating every file in the repository. The
 *   address is not kept; it is recomputed and replaced every run. `previous` is the stored row of the same
 *   text: on a rebuild the caller finds it in the generation being replaced.
 *
 * Only an http(s) address survives, whatever a driver returned — a second line of defence behind the
 * driver's own sanitising.
 */
export function resolveStoredMeta(
  meta: { url: string | null; modifiedAt: Date | null; stampOnChange?: boolean } | undefined,
  previous: StoredSourceMeta | undefined,
  contentChanged: boolean,
): StoredSourceMeta {
  const kept: StoredSourceMeta = { sourceUrl: previous?.sourceUrl ?? null, sourceModifiedAt: previous?.sourceModifiedAt ?? null };
  if (meta === undefined) return kept;
  const url = normalizeSourceUrl(meta.url);
  const modifiedAt = meta.modifiedAt && Number.isFinite(meta.modifiedAt.getTime()) ? meta.modifiedAt : null;
  if (meta.stampOnChange && !contentChanged && previous) {
    // Only the date is a moment of observation. The address is derived from the remote and the sha every
    // run, so a corrected remote or provider reaches documents whose text did not change.
    return { sourceUrl: url, sourceModifiedAt: kept.sourceModifiedAt ?? modifiedAt };
  }
  return { sourceUrl: url, sourceModifiedAt: modifiedAt };
}

/** Whether two stored values differ, comparing dates by instant. */
export function sourceMetaDiffers(a: StoredSourceMeta, b: StoredSourceMeta): boolean {
  return a.sourceUrl !== b.sourceUrl || (a.sourceModifiedAt?.getTime() ?? null) !== (b.sourceModifiedAt?.getTime() ?? null);
}
