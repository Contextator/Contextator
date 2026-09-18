/**
 * The `query: ` / `passage: ` prefixes an asymmetric embedding model was trained with, and where they
 * come from (ADR-0038).
 *
 * They belong to the provider and to nothing else. A caller that had to remember to prepend them would
 * eventually be a caller that forgot, and a query embedded as a passage is not an error anybody sees —
 * it is a few points of recall that look like the model being mediocre.
 */

export interface EmbeddingPrefixes {
  /** Prepended to the one text `embedQuery` encodes. Empty for a symmetric model. */
  query: string;
  /** Prepended to every text `embedPassages` encodes, and charged against the chunk budget. */
  passage: string;
}

export const NO_PREFIXES: EmbeddingPrefixes = { query: '', passage: '' };

/**
 * What an operator writes to force *no* prefix on a model this table knows. It cannot be expressed as an
 * empty value: `loadConfig` drops empty-string variables so that `.env.example`'s placeholders behave as
 * unset, so `EMBEDDING_QUERY_PREFIX=` is indistinguishable from not setting it at all. Compared
 * case-insensitively and after trimming, because the one thing an operator reaching for it wants is for
 * it to work.
 */
export const NO_PREFIX_SENTINEL = 'none';

/**
 * Models documented by their authors as trained with an instruction prefix, matched on the model name.
 *
 * Deliberately short, in the same spirit as `MODEL_WINDOWS`: the family this product ships and nothing
 * speculative. An entry that is merely absent costs a model run symmetrically, which is what every model
 * outside this table wants anyway; a wrong entry costs a prefix the model was never trained to see.
 *
 * `intfloat/e5-*` (the English-only siblings) use the same two prefixes and are deliberately not here —
 * this product does not name them anywhere, and an operator who runs one sets the two variables below.
 */
export const MODEL_PREFIXES: ReadonlyArray<{ match: RegExp; prefixes: EmbeddingPrefixes }> = [
  // intfloat's model card for the multilingual-e5 family: "Each input text should start with 'query: '
  // or 'passage: '... This is a must because that is how the model is trained." Both carry the trailing
  // space; it is part of the string the model saw.
  { match: /multilingual-e5-(small|base|large)/i, prefixes: { query: 'query: ', passage: 'passage: ' } },
];

/** What the table says for this model, before any operator override. */
export function prefixesForModel(model: string): EmbeddingPrefixes {
  const entry = MODEL_PREFIXES.find((e) => e.match.test(model));
  return entry ? { ...entry.prefixes } : { ...NO_PREFIXES };
}

/** `EMBEDDING_QUERY_PREFIX` / `EMBEDDING_PASSAGE_PREFIX`; either may be absent, and each overrides its own side. */
export interface EmbeddingPrefixOverrides {
  query?: string;
  passage?: string;
}

const applyOverride = (fromTable: string, override: string | undefined): string => {
  if (override === undefined) return fromTable;
  return override.trim().toLowerCase() === NO_PREFIX_SENTINEL ? '' : override;
};

/**
 * The table, then the operator. An override replaces one side without disturbing the other, and the
 * sentinel is the only way to say "this model's prefix, deliberately off".
 */
export function resolvePrefixes(model: string, overrides: EmbeddingPrefixOverrides = {}): EmbeddingPrefixes {
  const table = prefixesForModel(model);
  return { query: applyOverride(table.query, overrides.query), passage: applyOverride(table.passage, overrides.passage) };
}

/**
 * The segment `provider.id` grows when prefixes are in play, and **nothing when they are not**.
 *
 * The id is the re-index guard of [ADR-0007](../../../.ssot/ADR.md#adr-0007): it is stamped onto
 * `projects.embedding_model` and a project whose stamp differs is re-indexed and refused until it is. A
 * corpus indexed without prefixes and queried with them is exactly the silent degradation that guard
 * exists to catch, so the prefixes have to be inside it. They are quoted rather than pasted in raw
 * because the significant part of `passage: ` is the space at the end, and an id nobody can see the end
 * of is an id nobody can compare by eye.
 *
 * Empty prefixes add nothing at all, so a model outside the table keeps the id it had and no unrelated
 * project is re-indexed by this change.
 */
export function prefixIdSegment(prefixes: EmbeddingPrefixes): string {
  if (prefixes.query === '' && prefixes.passage === '') return '';
  return `:${JSON.stringify(prefixes.query)}+${JSON.stringify(prefixes.passage)}`;
}
