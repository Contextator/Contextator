import { describe, expect, it } from 'vitest';
import { transformContent, transformPath } from '../src/services/flavors.js';

const obsidian = (md: string): string => transformContent('obsidian', md);

describe('obsidian flavor', () => {
  it('rewrites wikilinks, aliases, headings and image embeds', () => {
    const md = 'See [[Getting Started]] and [[Setup|the setup guide]] or [[API#Auth]]. ![[diagram.png]]';
    expect(obsidian(md)).toBe(
      'See [Getting Started](Getting%20Started.md) and [the setup guide](Setup.md) or [API › Auth](API.md#auth). ![diagram.png](diagram.png)',
    );
  });

  it('keeps a note embed a link — only images stay embeds', () => {
    // `![[Note]]` inlines another note's text in Obsidian; as an image it would render as a broken one.
    expect(obsidian('![[Release Notes]]')).toBe('[Release Notes](Release%20Notes.md)');
    expect(obsidian('![[handbook.pdf]]')).toBe('[handbook.pdf](handbook.pdf)');
    expect(obsidian('![[shot.PNG]]')).toBe('![shot.PNG](shot.PNG)');
  });

  it('handles links inside the same note and block references', () => {
    expect(obsidian('jump to [[#Installation]]')).toBe('jump to [Installation](#installation)');
    expect(obsidian('see [[API#^ref-42]]')).toBe('see [API](API.md#^ref-42)');
    expect(obsidian('[[Page#Two Words]]')).toBe('[Page › Two Words](Page.md#two-words)');
  });

  it('keeps paths and existing extensions, and leaves non-links alone', () => {
    expect(obsidian('[[guides/Install]]')).toBe('[guides/Install](guides/Install.md)');
    expect(obsidian('[[guides/Install.md]]')).toBe('[guides/Install.md](guides/Install.md)');
    expect(obsidian('[[]] and [[|x]]')).toBe('[[]] and [[|x]]');
  });

  it('drops %% comments %%, which are written not to be read', () => {
    expect(obsidian('Visible %%hidden note%% text')).toBe('Visible  text');
    expect(obsidian('a\n%%\nmulti\nline\n%%\nb')).toBe('a\n\nb');
  });

  it('turns callouts into a searchable label', () => {
    expect(obsidian('> [!NOTE] Heads up\n> body')).toBe('> **Note:** Heads up\n> body');
    expect(obsidian('> [!warning]- Folded')).toBe('> **Warning:** Folded');
    expect(obsidian('> plain quote')).toBe('> plain quote');
  });

  it('leaves plain markdown alone', () => {
    const md = '# Title\n\n[normal](link.md) and `[[code]]`';
    expect(transformContent('plain', md)).toBe(md);
    expect(transformPath('plain', 'a/b.md')).toBe('a/b.md');
    expect(transformPath('obsidian', 'a/b.md')).toBe('a/b.md');
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
