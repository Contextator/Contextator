/**
 * Which PostgreSQL text search configuration the lexical half of retrieval is spoken in
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)).
 *
 * A `tsvector` does not remember the configuration it was built with, and a `tsquery` built with a
 * different one does not match it: `to_tsvector('english', 'renewed certificate')` is
 * `'certif':2 'renew':1` and `plainto_tsquery('simple', 'renewed certificate')` asks for
 * `'renewed' & 'certificate'`, which is nothing. **So the two sides have to agree**, and that is the
 * whole of why this file is one constant with two names rather than a setting.
 */

/**
 * The configurations a source may name. PostgreSQL ships more (and an installation may have built
 * its own), but this is the Snowball set that has been in every stock build since 8.3, so a value
 * that passes this check exists on the server the operator is actually running.
 *
 * **Turkish is not in it, because PostgreSQL has no Turkish configuration.** Turkish documentation is
 * indexed with `simple` — no stemming, no stop words, the identifier intact — which is the honest
 * answer and the one the dashboard says out loud rather than only here.
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
] as const;

export type TextSearchConfig = (typeof TEXT_SEARCH_CONFIGS)[number];

/**
 * What a chunk is indexed with when its source names no language, and what every chunk written by a
 * default installation is indexed with.
 *
 * `simple` is also the recommendation, measured rather than assumed: it lower-cases and splits, and
 * it does nothing else — so `HALYARD_DISPATCH_TIMEOUT`, `X-Halyard-Signature` and `HLY-4015` survive
 * into the index as the strings they are. That is the failure this whole change exists for.
 */
export const DEFAULT_TEXT_SEARCH_CONFIG: TextSearchConfig = 'simple';

/**
 * What every query is parsed with, and deliberately a constant rather than a setting in this version.
 *
 * One search spans every source of a project, and those sources may name different languages. The
 * honest multi-configuration query is one `@@` per distinct configuration present, OR-ed — which is
 * more machinery than forty-eight questions over twenty-six pages can justify. Until the eval says
 * otherwise, both sides say `simple`, and a source that names a language is indexed in a
 * configuration the query does not speak. The dashboard field says so where it is set.
 */
export const QUERY_TEXT_SEARCH_CONFIG: TextSearchConfig = DEFAULT_TEXT_SEARCH_CONFIG;

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
