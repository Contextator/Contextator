import { describe, expect, it } from 'vitest';
import { chunkMarkdown, embeddingText, estimateTokens, parseFrontmatter, stripMdx } from '../src/services/chunker.js';

const opts = { maxTokens: 100, overlapTokens: 15 };

describe('parseFrontmatter', () => {
  it('extracts simple key/value pairs and strips quotes', () => {
    const { data, body } = parseFrontmatter('---\ntitle: "Install Guide"\nsidebar_position: 2\n---\n\n# Hello\n');
    expect(data.title).toBe('Install Guide');
    expect(data.sidebar_position).toBe('2');
    expect(body.trim()).toBe('# Hello');
  });

  it('leaves documents without frontmatter untouched', () => {
    const src = '# Title\n\ntext';
    expect(parseFrontmatter(src)).toEqual({ data: {}, body: src });
  });
});

describe('stripMdx', () => {
  it('removes imports/exports and component tags outside fences but keeps them inside', () => {
    const src = [
      "import Tabs from '@theme/Tabs';",
      'import {',
      '  A,',
      '  B,',
      "} from './components';",
      'export const meta = {',
      '  id: 1,',
      '};',
      '',
      '<Tabs>',
      'Real content here.',
      '</Tabs>',
      '{/* a jsx comment */}',
      '```js',
      "import fs from 'node:fs';",
      '<Component />',
      '```',
    ].join('\n');
    const out = stripMdx(src);
    expect(out).not.toContain('@theme/Tabs');
    expect(out).not.toContain('./components');
    expect(out).not.toContain('meta');
    expect(out).not.toContain('<Tabs>');
    expect(out).not.toContain('jsx comment');
    expect(out).toContain('Real content here.');
    expect(out).toContain("import fs from 'node:fs';");
    expect(out).toContain('<Component />');
  });
});

describe('chunkMarkdown', () => {
  it('uses the frontmatter title, then H1, then the filename', () => {
    expect(chunkMarkdown('---\ntitle: From Front\n---\n# From H1\n\ntext', 'a/b.md', opts).title).toBe('From Front');
    expect(chunkMarkdown('# From H1\n\ntext', 'a/b.md', opts).title).toBe('From H1');
    expect(chunkMarkdown('just text without headings', 'guides/getting-started.md', opts).title).toBe('Getting Started');
  });

  it('builds heading breadcrumbs per section', () => {
    const body = (s: string) => `${s} `.repeat(6).trim();
    const src = [
      '# Guide',
      '',
      body('intro text'),
      '',
      '## Install',
      '',
      body('install text'),
      '',
      '### Docker',
      '',
      body('docker text'),
      '',
      '## Usage',
      '',
      body('usage text'),
    ].join('\n');
    const { chunks } = chunkMarkdown(src, 'guide.md', opts);
    const paths = chunks.map((c) => c.headingPath);
    expect(paths).toEqual(['Guide', 'Guide > Install', 'Guide > Install > Docker', 'Guide > Usage']);
    expect(chunks[2].content).toContain('### Docker');
    expect(chunks[2].content).toContain('docker text');
  });

  it('merges heading-only stubs into the following chunk and keeps that chunk\'s breadcrumb', () => {
    const src = ['# Guide', '', '## Install', '', `${'real install content '.repeat(4)}`].join('\n');
    const { chunks } = chunkMarkdown(src, 'guide.md', opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toBe('Guide > Install');
    expect(chunks[0].content.startsWith('# Guide')).toBe(true);
  });

  it('seeds the breadcrumb with the title when the document has no H1', () => {
    const src = '---\ntitle: Kurulum\n---\n\n## Docker ile\n\nmetin';
    const { chunks } = chunkMarkdown(src, 'kurulum.md', opts);
    expect(chunks[0].headingPath).toBe('Kurulum > Docker ile');
  });

  it('splits oversized sections on paragraph boundaries with overlap and respects the budget', () => {
    // Each paragraph is three ~10-token lines, so a 15-token overlap can carry whole lines across.
    const paragraph = (n: number) => [`Paragraph ${n} line one lorem ipsum dolor.`, `Paragraph ${n} line two sit amet consectetur.`, `Paragraph ${n} line three adipiscing elit sed.`].join('\n');
    const src = '# Big\n\n' + Array.from({ length: 8 }, (_, i) => paragraph(i)).join('\n\n');
    const { chunks } = chunkMarkdown(src, 'big.md', opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(opts.maxTokens + 2);
    // overlap: the last line of chunk N is repeated at the head of chunk N+1
    const tail = chunks[0].content.split('\n').pop()!;
    expect(chunks[1].content.startsWith(tail)).toBe(true);
    expect(chunks.every((c) => c.headingPath === 'Big')).toBe(true);
  });

  it('never splits a fenced code block that fits the budget', () => {
    const code = '```ts\n' + Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
    const src = `# Code\n\n${'text '.repeat(60)}\n\n${code}\n\n${'more text '.repeat(60)}`;
    const { chunks } = chunkMarkdown(src, 'code.md', opts);
    const withCode = chunks.filter((c) => c.content.includes('```ts'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0].content).toContain(code);
  });

  it('re-wraps pieces of an oversized code block in the same fence', () => {
    const code = '```python\n' + Array.from({ length: 80 }, (_, i) => `print("line ${i} of a long script")`).join('\n') + '\n```';
    const { chunks } = chunkMarkdown(`# Script\n\n${code}`, 'script.md', opts);
    const pieces = chunks.filter((c) => c.content.includes('```python'));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      // the first piece may be prefixed with the merged "# Script" heading stub
      expect(p.content).toMatch(/(^|\n\n)```python\n/);
      expect(p.content.endsWith('\n```')).toBe(true);
      expect(estimateTokens(p.content)).toBeLessThanOrEqual(opts.maxTokens + 5);
    }
  });

  it('merges tiny chunks and normalises CRLF', () => {
    const { chunks } = chunkMarkdown('# A\r\n\r\n## B\r\n\r\nok\r\n\r\n## C\r\n\r\nsecond section text', 'x.md', opts);
    expect(chunks.every((c) => c.content.replace(/\s+/g, '').length >= 20 || chunks.length === 1)).toBe(true);
    expect(chunks.some((c) => c.content.includes('\r'))).toBe(false);
  });

  it('prefixes the breadcrumb in the embedded text', () => {
    expect(embeddingText({ headingPath: 'A > B', content: 'body' })).toBe('A > B\n\nbody');
    expect(embeddingText({ headingPath: '', content: 'body' })).toBe('body');
  });
});
