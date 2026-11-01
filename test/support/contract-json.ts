/**
 * The shared half of the contract snapshots under `test/contracts/` that are JSON
 * ([ADR-0137](../../.ssot/ADR.md#adr-0137)): a value with its object keys sorted, written in the shape
 * Biome's formatter keeps, so `npm run lint` (which checks the snapshot files too) stays green and a diff
 * of a snapshot is a diff of the contract and nothing else.
 */

/**
 * Object keys sorted by code unit, not by locale: the order must not depend on whoever records the snapshot.
 * A `required` list of names is sorted too: the order a schema lists them in carries no meaning.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = (value as Record<string, unknown>)[key];
    out[key] = key === 'required' && Array.isArray(inner) && inner.every((name) => typeof name === 'string') ? [...inner].sort() : sortKeys(inner);
  }
  return out;
}

/**
 * Two-space JSON: objects always one key per line, an array of scalars on one line while the whole line
 * (indent, key, array, trailing comma) fits in `LINE_WIDTH`, anything else one item per line. What JSON would
 * drop (`undefined`) is dropped here too. `lead` is how many characters precede the value on its line.
 */
const LINE_WIDTH = 150;

export function renderJson(value: unknown, depth = 0, lead = '  '.repeat(depth)): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => item === null || typeof item !== 'object')) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (lead.length + inline.length + 1 <= LINE_WIDTH) return inline;
    }
    return `[\n${value.map((item) => `${pad}${renderJson(item, depth + 1, pad)}`).join(',\n')}\n${close}]`;
  }
  const entries = Object.entries(value).filter(([, inner]) => inner !== undefined);
  if (entries.length === 0) return '{}';
  const rows = entries.map(([key, inner]) => {
    const head = `${pad}${JSON.stringify(key)}: `;
    return `${head}${renderJson(inner, depth + 1, head)}`;
  });
  return `{\n${rows.join(',\n')}\n${close}}`;
}

/** A value as a snapshot file: keys sorted, Biome-shaped, one trailing newline. */
export const recordJson = (value: unknown): string => `${renderJson(sortKeys(value))}\n`;

/** Strings in code-unit order, for the lists whose order carries no meaning. */
export const sorted = (items: Iterable<string>): string[] => [...items].sort();

/** The wording is Tier 3 ([ADR-0137](../../.ssot/ADR.md#adr-0137)): a string-valued `title` or `description` goes, wherever it sits. */
export function withoutWording(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWording);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, inner]) => !((key === 'title' || key === 'description') && typeof inner === 'string'))
      .map(([key, inner]) => [key, withoutWording(inner)]),
  );
}
