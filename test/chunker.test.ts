import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkMarkdown, embeddingText, estimateTokens, parseFrontmatter, stripMdx } from '../src/services/chunker.js';
import { MODEL_CACHE_DIR, modelCacheGate } from './support/model-cache.js';

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

  it("merges heading-only stubs into the following chunk and keeps that chunk's breadcrumb", () => {
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
    const paragraph = (n: number) =>
      [
        `Paragraph ${n} line one lorem ipsum dolor.`,
        `Paragraph ${n} line two sit amet consectetur.`,
        `Paragraph ${n} line three adipiscing elit sed.`,
      ].join('\n');
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

/**
 * The seam of [ADR-0036](../../.ssot/ADR.md#adr-0036), asserted without a model. A counter that answers
 * one token per character is nothing like a real tokenizer, which is the point: if the chunker were
 * still counting characters ÷ 4 anywhere, these numbers would not move.
 */
describe('the injected token counter', () => {
  const oneTokenPerCharacter = (text: string): number => text.length;

  it('packs against the injected counter rather than the default estimate', () => {
    const src = `# Sayfa\n\n${Array.from({ length: 12 }, (_, i) => `Paragraf ${i} biraz metin icerir.`).join('\n\n')}`;
    const withDefault = chunkMarkdown(src, 'a.md', { maxTokens: 120, overlapTokens: 0 });
    const withStub = chunkMarkdown(src, 'a.md', { maxTokens: 120, overlapTokens: 0, countTokens: oneTokenPerCharacter });

    expect(withDefault.chunks).toHaveLength(1);
    expect(withStub.chunks.length).toBeGreaterThan(1);
    // `tokenCount` is the injected counter's answer, not the estimate's, because it is what the
    // budget was spent in and what the database records.
    for (const chunk of withStub.chunks) expect(chunk.tokenCount).toBe(chunk.content.length);
  });

  it('spends the breadcrumb and the reserve out of the same budget', () => {
    const body = Array.from({ length: 40 }, (_, i) => `satir ${i}`).join('\n');
    const src = `# Kok\n\n## Cok Uzun Bir Baslik Yolu Parcasi\n\n${body}`;
    const { chunks } = chunkMarkdown(src, 'a.md', {
      maxTokens: 200,
      overlapTokens: 0,
      countTokens: oneTokenPerCharacter,
      reserveTokens: 10,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // What the indexer embeds — breadcrumb and content together — is what has to fit, and the reserve
    // is still unspent underneath it.
    for (const chunk of chunks) expect(oneTokenPerCharacter(embeddingText(chunk))).toBeLessThanOrEqual(200 - 10);
  });

  it('is asked about any one string at most once', () => {
    const asked: string[] = [];
    const src = `# Sayim\n\n${Array.from({ length: 30 }, (_, i) => `Tekrar eden bir satir ${i}.`).join('\n\n')}`;
    chunkMarkdown(src, 'a.md', {
      maxTokens: 60,
      overlapTokens: 20,
      countTokens: (text) => {
        asked.push(text);
        return text.length;
      },
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked).size).toBe(asked.length);
  });
});

/**
 * The one test here that needs the model cache. Only the tokenizer is loaded — a few hundred kilobytes
 * of `tokenizer.json` — because the claim under test is about counting, not about embedding.
 *
 * It is gated on the cache rather than downloading it inside `npm test`, which is a convenience for a
 * contributor and not a licence to go unrun: CI warms the cache and the gate does not apply there.
 *
 * It is the acceptance test for ADR-0036 and ADR-0037: with the shipped budget and the shipped model,
 * nothing the indexer hands the model is longer than the window the model was trained at.
 *
 * The window is no longer the binding constraint — 96 against 512 clears it by a factor of five — so
 * the budget itself is asserted alongside it. That is the tight one, and it is the claim that would
 * actually break: a breadcrumb the packer forgot to charge for, or an overlap allowed past the budget,
 * shows up here and not in the window check.
 */
const MODEL = 'Xenova/multilingual-e5-small';
const MODEL_WINDOW_TOKENS = 512;
const BUDGET_TOKENS = 96;
// Skipped for a developer who has never warmed the cache, and never skipped under CI, where the
// `check` job populates it and an absent cache has to be a red build (see `support/model-cache.ts`).
const tokenizerCache = modelCacheGate(MODEL, 'tokenizer.json');

describe.skipIf(tokenizerCache.skip)('the real tokenizer, on Turkish', () => {
  beforeAll(() => tokenizerCache.assertPresent());

  it('keeps every chunk of a Turkish page inside the budget, and the budget inside the window', async () => {
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    env.cacheDir = MODEL_CACHE_DIR;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    const countTokens = (text: string): number => tokenizer.encode(text, { add_special_tokens: false }).length;

    // The eval corpus, so the fixture and the thing `npm run eval` measures cannot drift apart.
    const page = readFileSync(path.resolve('eval/corpus/tr/kurulum/tek-sunucu.md'), 'utf8');
    const { chunks } = chunkMarkdown(page, 'tr/kurulum/tek-sunucu.md', {
      maxTokens: BUDGET_TOKENS,
      overlapTokens: 24,
      countTokens,
      reserveTokens: 2,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // `+ 2` is the `<s>`/`</s>` pair the count deliberately leaves out (ADR-0036).
      const cost = countTokens(embeddingText(chunk)) + 2;
      expect(cost).toBeLessThanOrEqual(BUDGET_TOKENS);
      expect(cost).toBeLessThanOrEqual(MODEL_WINDOW_TOKENS);
    }
  });
});
