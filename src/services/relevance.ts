/**
 * When a search should answer **"no good match"** instead of handing over its best hit
 * ([ADR-0042](../../.ssot/ADR.md#adr-0042)).
 *
 * Nothing here touches a database, which is the point: the gate is a decision about a result set and a
 * question, and it is the one part of result selection that can be wrong in a way no `recall@5` shows.
 * A floor that fires when the answer was at rank 2 turns a retrieval miss into a confident refusal, and
 * an agent told "nothing matched" does not ask again.
 *
 * **What the floor is, and what it deliberately is not.** ROADMAP.md Item 7 asks for a relevance floor
 * so that an agent is not handed "a 0.21 hit it will cite". Under `multilingual-e5-small` there is no
 * 0.21 hit: measured over the golden set, every top hit of every question the corpus answers sits at
 * 0.833 or above, and a question about something the corpus has never heard of still tops out at 0.829.
 * The whole usable range is four thousandths wide, and it separates exactly one thing — *this question
 * is not about this documentation at all*. It does not separate a question shaped like the product
 * whose answer is simply not written down: those score inside the band of questions that are answered,
 * and no threshold splits them. The numbers are in ADR-0042; Item 6's query log is where that second
 * case is meant to be caught.
 */

import type { SearchHit } from './vector-store.js';

/**
 * The model `SEARCH_SCORE_FLOOR`'s default was measured against. A cosine similarity is a number about
 * one encoder — ADR-0037 moved this product's whole score distribution by changing nothing else — so a
 * floor carried onto another model is a floor that means something nobody measured.
 */
export const FLOOR_MEASURED_MODEL = 'Xenova/multilingual-e5-small';

/** `foo.bar`, `3.0.0`, `settings.json` — a dot between two word characters rather than a full stop. */
const DOTTED_PATH = /[A-Za-z0-9]\.[A-Za-z0-9]/;

/** `getUserById` or `HLY`: a lower-to-upper transition, or a run of capitals. */
const CASE_RUN = /\p{Ll}\p{Lu}|\p{Lu}{2,}/u;

/**
 * Whether the question looks like it names an identifier rather than describing a subject.
 *
 * **This is the escape hatch, and it is generous on purpose.** A `tsvector` match on
 * `AUTH_COOKIE_SECURE` is correct at any cosine similarity at all, because the string is either in the
 * chunk or it is not — which is precisely the case a similarity floor gets wrong. The two errors are
 * not symmetric: firing when it should not have degrades that one query to the behaviour of the
 * version before the floor existed, while *not* firing hides a correct answer behind a refusal. So the
 * four-or-more-character test is applied to every token of the question and not only to a question
 * that is one token — `What does HLY-4019 mean?` has to reach the table that defines it.
 */
export function isIdentifierShaped(query: string): boolean {
  if (query.includes('_') || query.includes('::') || DOTTED_PATH.test(query)) return true;
  return query.split(/\s+/).some((token) => token.length >= 4 && (/\d/.test(token) || token.includes('_') || CASE_RUN.test(token)));
}

/**
 * Whether this result set is below the floor and the caller should say so instead of returning it.
 *
 * The gate is on the **best** hit and therefore on the query: if the top of the list does not clear the
 * floor, nothing in the list does. It is deliberately not a per-hit filter — the measurement behind the
 * number is a distribution over questions, and trimming a tail this far down would remove almost
 * nothing while making `limit` mean two different things.
 *
 * `hits` empty is not below the floor. That is the older, separate answer — the search found nothing at
 * all — and the two want different wording.
 */
export function belowRelevanceFloor(query: string, hits: readonly SearchHit[], floor: number): boolean {
  if (floor <= 0 || hits.length === 0) return false;
  if (hits[0].score >= floor) return false;
  // The lexical half having returned *something* is half of the escape hatch: an identifier-shaped
  // question that no keyword matched is a question about an identifier this corpus does not contain,
  // which is the case the floor is right about.
  if (isIdentifierShaped(query) && hits.some((hit) => hit.lexicalRank !== null)) return false;
  return true;
}

/**
 * The warning for an operator running the floor's default against a model it was not measured on, or
 * `null` when there is nothing to say.
 *
 * It is a warning and never a refusal: the number may well have been re-measured, and `config.ts`
 * cannot tell a deliberate 0.82 from the default one anyway. Startup is where it belongs, because by
 * the time somebody wonders why every search answers "no good match" they are not reading the schema.
 */
export function floorModelWarning(floor: number, model: string): string | null {
  if (floor <= 0 || model === FLOOR_MEASURED_MODEL) return null;
  return (
    `SEARCH_SCORE_FLOOR=${floor} was measured against ${FLOOR_MEASURED_MODEL} and this server embeds with ${model}. ` +
    'Cosine similarity is not comparable between models: if the new one scores lower, every search answers ' +
    '"no good match". Re-measure the floor for this model or set SEARCH_SCORE_FLOOR=0.'
  );
}
