/**
 * Which PostgreSQL text search configuration the lexical half of retrieval is spoken in
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041), amended by [ADR-0064](../../.ssot/ADR.md#adr-0064)).
 *
 * A `tsvector` does not remember the configuration it was built with, and a `tsquery` built with a
 * different one does not match it: `to_tsvector('english', 'renewed certificate')` is
 * `'certif':2 'renew':1` and `plainto_tsquery('simple', 'renewed certificate')` asks for
 * `'renewed' & 'certificate'`, which is nothing. **So the two sides have to agree** — and since
 * ADR-0064 they are made to agree per chunk rather than instance-wide: `chunks.text_search_config`
 * records what each chunk was built with, and the query is one `@@` per configuration present,
 * OR-ed. That is why this file no longer holds a single query-side constant.
 */

/**
 * The configurations a source may name. PostgreSQL ships more (and an installation may have built
 * its own), but these are the Snowball stemmers this product has measured, so a value that passes
 * this check exists on the server the operator is actually running.
 *
 * **`turkish` is one of them since [ADR-0064](../../.ssot/ADR.md#adr-0064), and the entry it amends
 * said the opposite.** ADR-0041 and ADR-0052 recorded "PostgreSQL has no Turkish configuration" and
 * that premise was never measured. It is false, on the very image this product ships
 * (`pgvector/pgvector:pg16`):
 *
 * ```
 * select to_tsvector('turkish', 'anahtarı anahtarın anahtarlar anahtar');
 *  → 'anahtar':1,2,3,4
 * select to_tsvector('turkish', 'API anahtarını nereden alırım')
 *          @@ plainto_tsquery('turkish', 'api anahtarı');
 *  → t
 * select to_tsvector('simple',  'API anahtarını nereden alırım')
 *          @@ plainto_tsquery('simple',  'api anahtarı');
 *  → f
 * ```
 *
 * Turkish is agglutinative, so under `simple` "anahtarı", "anahtarın" and "anahtarlar" are three
 * unrelated strings and a question never shares a term with a page that answers it unless the two
 * happened to inflect the word the same way. That is the failure `turkish` removes.
 */
export const TEXT_SEARCH_CONFIGS = [
  'simple',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'hungarian',
  'italian',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'spanish',
  'swedish',
  'turkish',
] as const;

export type TextSearchConfig = (typeof TEXT_SEARCH_CONFIGS)[number];

/**
 * What a chunk is indexed with when its source names no language, and what every chunk written by a
 * default installation is indexed with.
 *
 * `simple` is also still the recommendation for a corpus whose language is not known, measured
 * rather than assumed: it lower-cases and splits, and it does nothing else — so
 * `HALYARD_DISPATCH_TIMEOUT`, `X-Halyard-Signature` and `HLY-4015` survive into the index as the
 * strings they are. A stemmer is worth its cost when the source's language is *named*, which is what
 * the `language` setting is for.
 */
export const DEFAULT_TEXT_SEARCH_CONFIG: TextSearchConfig = 'simple';

const KNOWN = new Set<string>(TEXT_SEARCH_CONFIGS);

export function isTextSearchConfig(value: unknown): value is TextSearchConfig {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * The configuration a source's chunks are indexed with. Unset — which is the default and what every
 * source created before this change holds — is `simple`.
 *
 * It takes the raw `config.language` off a `document_sources` row rather than a parsed shape, because
 * the row is `jsonb` and a value that got in before the zod schema knew about the key is exactly the
 * case this must not interpolate into `to_tsvector`.
 */
export function textSearchConfigFor(language: unknown): TextSearchConfig {
  return isTextSearchConfig(language) ? language : DEFAULT_TEXT_SEARCH_CONFIG;
}
