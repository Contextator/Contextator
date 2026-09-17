import { describe, expect, it } from 'vitest';
import { transformContent, transformPath } from '../src/services/flavors.js';

describe('obsidian flavor', () => {
  it('rewrites wikilinks, aliases, headings and embeds', () => {
    const md = 'See [[Getting Started]] and [[Setup|the setup guide]] or [[API#Auth]]. ![[diagram.png]]';
    expect(transformContent('obsidian', md)).toBe(
      'See [Getting Started](Getting%20Started.md) and [the setup guide](Setup.md) or [API › Auth](API.md#auth). ![diagram.png](diagram.png)',
    );
  });

  it('leaves plain markdown alone', () => {
    const md = '# Title\n\n[normal](link.md) and `[[code]]`';
    expect(transformContent('plain', md)).toBe(md);
    expect(transformPath('plain', 'a/b.md')).toBe('a/b.md');
  });
});

describe('notion-export flavor', () => {
  it('strips the 32-hex id suffix from every path segment', () => {
    expect(transformPath('notion-export', 'Wiki 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Getting started 0123456789abcdef0123456789abcdef.md')).toBe(
      'Wiki/Getting started.md',
    );
    expect(transformPath('notion-export', 'plain/file.md')).toBe('plain/file.md');
  });

  it('cleans internal links and keeps external ones', () => {
    const md = '[Next](Getting%20started%200123456789abcdef0123456789abcdef.md) [Site](https://example.com/x%2020)';
    expect(transformContent('notion-export', md)).toBe('[Next](Getting%20started.md) [Site](https://example.com/x%2020)');
  });
});
