import { describe, expect, it } from 'vitest';
import { SOURCE_VERSION_MAX_LENGTH, parseSourceConfig, sourceVersion } from '../src/services/sources.js';
import { ValidationError } from '../src/services/projects.js';

/**
 * The release label a source carries ([ADR-0058](../.ssot/ADR.md#adr-0058)), at the only layer where
 * "unset", "blank" and "a string of spaces" are three different inputs and have to become one state.
 *
 * The case that matters most is **clearing**. `updateSource` merges a patch over the stored config, so
 * a form that simply omitted the field would keep whatever was there and an operator would have no way
 * back to unversioned — which is why the dashboard always sends the key and the schema normalises an
 * empty one away. That is a property of two pieces of code agreeing, and this is where the agreement
 * is written down.
 */
describe('a source version', () => {
  const parse = (raw: unknown): Record<string, unknown> => parseSourceConfig('upload', raw) as Record<string, unknown>;

  it('is kept as written, trimmed, on every source type', () => {
    for (const type of ['local', 'git', 'upload', 'notion'] as const) {
      const config = {
        version: '  v3  ',
        // The minimum each type's schema requires; everything else has a default.
        ...(type === 'local' ? { path: '/docs' } : {}),
        ...(type === 'git' ? { url: 'https://example.com/docs.git' } : {}),
      };
      expect(sourceVersion(parseSourceConfig(type, config) as Record<string, unknown>)).toBe('v3');
    }
  });

  it('reads an empty field, a blank one and an absent one as the same unversioned state', () => {
    // Three spellings of "no release", and the column has one: `''`. A schema that let any of them
    // through as a distinct value would make a source that looks unversioned invisible to an unfiltered
    // search of nothing, and visible to a `version: " "` filter nobody can type.
    for (const raw of [{}, { version: '' }, { version: '   ' }]) {
      expect(sourceVersion(parse(raw))).toBe('');
    }
  });

  it('clears a stored version when the form sends an empty one, which is the only way back', () => {
    // The merge `updateSource` performs, reproduced: stored config on the left, the form's patch on the
    // right. The key has to survive the parse as absent rather than as `''`, or the stored label stays.
    const stored = parse({ version: 'v2' });
    const merged = parse({ ...stored, version: '' });
    expect(sourceVersion(merged)).toBe('');
    expect(Object.hasOwn(merged, 'version') && merged.version !== undefined).toBe(false);
  });

  it('refuses a label longer than the column, the tool argument and the form all agree to carry', () => {
    expect(() => parse({ version: 'v'.repeat(SOURCE_VERSION_MAX_LENGTH) })).not.toThrow();
    expect(() => parse({ version: 'v'.repeat(SOURCE_VERSION_MAX_LENGTH + 1) })).toThrow(ValidationError);
  });

  it('reads a stored value that is not a string as unversioned rather than as itself', () => {
    // `config` is jsonb and this reader is handed rows as well as freshly parsed objects. A number or a
    // null there is a source nobody can search for by name, not a version called "42".
    for (const value of [42, null, undefined, {}, ['v3']]) {
      expect(sourceVersion({ version: value })).toBe('');
    }
    expect(sourceVersion(undefined)).toBe('');
    expect(sourceVersion(null)).toBe('');
  });
});
