import { describe, expect, it } from 'vitest';

import { documentUri, parseDocumentUri } from '../src/mcp/resources.js';

/**
 * The resource URI is an access boundary before it is a format: whatever `parseDocumentUri` lets
 * through is looked up as an indexed path, so everything a list would never have issued has to stop
 * here. The lookup behind it is exact, so a wrong answer here is a not-found rather than a leak — these
 * cases keep it that way on purpose rather than by luck.
 */

describe('documentUri', () => {
  it('puts the project in the authority and the indexed path, source first, in the path', () => {
    expect(documentUri('handbook', 'docs/guide/install.md')).toBe('contextator://handbook/docs/guide/install.md');
  });

  it('percent-encodes each segment and keeps the separators', () => {
    expect(documentUri('p', 'docs/Getting started/100% ready?.md')).toBe('contextator://p/docs/Getting%20started/100%25%20ready%3F.md');
  });

  it('round-trips through parseDocumentUri', () => {
    for (const relativePath of ['docs/a.md', 'docs/Getting started/100% ready?.md', 'wiki/Ünicode/çalışma #1.md', 'src/a+b=c&d.md']) {
      expect(parseDocumentUri(documentUri('proj-1', relativePath))).toEqual({ project: 'proj-1', relativePath });
    }
  });
});

describe('parseDocumentUri accepts every URI the list can issue', () => {
  // Percent-encoding multiplies a non-ASCII path several times over: a URI built from a path
  // read_document takes must parse back, however long its encoded form is.
  it("takes a path at read_document's bound made of characters that encode to nine each", () => {
    const relativePath = `docs/${'文'.repeat(1024 - 'docs/'.length - '.md'.length)}.md`;
    expect(relativePath).toHaveLength(1024);
    const uri = documentUri('p'.repeat(63), relativePath);
    expect(uri.length).toBeGreaterThan(9000);
    expect(parseDocumentUri(uri)).toEqual({ project: 'p'.repeat(63), relativePath });
  });

  it('refuses the same path one character past the bound', () => {
    const relativePath = `docs/${'文'.repeat(1024 - 'docs/'.length - '.md'.length + 1)}.md`;
    expect(parseDocumentUri(documentUri('p', relativePath))).toBeNull();
  });
});

describe('parseDocumentUri refuses what the list would never have issued', () => {
  it.each([
    ['another scheme', 'file:///etc/passwd'],
    ['another scheme spelled like this one', 'contextator:/p/docs/a.md'],
    ['no path', 'contextator://p'],
    ['no project', 'contextator:///docs/a.md'],
    ['an empty path', 'contextator://p/'],
    ['a query', 'contextator://p/docs/a.md?x=1'],
    ['a fragment', 'contextator://p/docs/a.md#top'],
    ['a dot-dot segment', 'contextator://p/docs/../secret.md'],
    ['a leading dot-dot segment', 'contextator://p/../other/docs/a.md'],
    ['a percent-encoded dot-dot segment', 'contextator://p/docs/%2E%2E/secret.md'],
    ['a dot segment', 'contextator://p/docs/./a.md'],
    ['an empty segment', 'contextator://p/docs//a.md'],
    ['a trailing slash', 'contextator://p/docs/a.md/'],
    ['an encoded slash joining two segments', 'contextator://p/docs%2Fa.md'],
    ['an encoded backslash', 'contextator://p/docs/..%5Csecret.md'],
    ['a NUL byte', 'contextator://p/docs/a.md%00.txt'],
    ['a control character', 'contextator://p/docs/a%0A.md'],
    ['a malformed escape', 'contextator://p/docs/%E0%A4%A.md'],
    ['a decoded path longer than read_document accepts', `contextator://p/docs/${'a'.repeat(1200)}.md`],
    ['a URI too long to be worth decoding', `contextator://p/docs/${'%61'.repeat(3100)}.md`],
  ])('%s', (_label, uri) => {
    expect(parseDocumentUri(uri)).toBeNull();
  });
});
