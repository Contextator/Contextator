import { describe, expect, it } from 'vitest';
import { chunkMarkdown, estimateTokens } from '../src/services/chunker.js';
import { chunksWithinBudget, joinChunks, overlappingLines, truncateToTokens } from '../src/services/document-read.js';
import { storedDocumentContent } from '../src/services/vector-store.js';

/**
 * The two things a sectional read can get wrong without anybody noticing
 * ([ADR-0043](../.ssot/ADR.md#adr-0043)): the chunker's overlap surviving into text an agent reads as
 * the document, and a budget an agent was told is in tokens turning out to be a byte count.
 *
 * The overlap assertions are deliberately fed by `chunkMarkdown` itself rather than by hand-written
 * strings. What is being claimed is that this joiner removes *the duplication the chunker produces* —
 * a claim about two functions agreeing, which hand-written input cannot make.
 */

const count = estimateTokens;

describe('overlappingLines', () => {
  it('finds the longest repeated run of lines and ignores trailing whitespace', () => {
    expect(overlappingLines(['a', 'b', 'c'], ['b  ', 'c', 'd'])).toBe(2);
  });

  it('does not count a run that is only blank lines', () => {
    expect(overlappingLines(['a', '', ''], ['', '', 'z'])).toBe(0);
  });

  it('removes nothing when the chunks share no boundary', () => {
    expect(overlappingLines(['a', 'b'], ['c', 'd'])).toBe(0);
  });
});

describe('joinChunks', () => {
  it('drops the overlap the chunker seeded, so no sentence is read twice', () => {
    // Prose in one section, well over one chunk, so the packer runs and `takeTail` seeds the next one.
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains a part of the delivery pipeline in some detail.`);
    const source = `# Guide\n\n${sentences.join('\n\n')}\n`;
    const { chunks } = chunkMarkdown(source, 'guide.md', { maxTokens: 96, overlapTokens: 24 });
    expect(chunks.length).toBeGreaterThan(3);

    const naive = chunks.map((c) => c.content).join('\n\n');
    const joined = joinChunks(chunks.map((c) => c.content));
    expect(joined.text.length).toBeLessThan(naive.length);

    // Every sentence of the document appears, and appears once.
    for (const sentence of sentences) {
      expect(joined.text.split(sentence).length - 1, sentence).toBe(1);
    }
  });

  it('records an offset per chunk, so a cut can land on a boundary', () => {
    const joined = joinChunks(['alpha', 'beta', 'gamma']);
    expect(joined.text).toBe('alpha\n\nbeta\n\ngamma');
    expect(joined.offsets).toHaveLength(4);
    expect(joined.text.slice(0, joined.offsets[2])).toBe('alpha\n\nbeta');
    expect(joined.offsets[3]).toBe(joined.text.length);
  });

  it('is the identity on chunks that do not overlap', () => {
    expect(joinChunks(['# One\n\nfirst', '## Two\n\nsecond']).text).toBe('# One\n\nfirst\n\n## Two\n\nsecond');
  });
});

describe('truncateToTokens', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of a document that is longer than any budget it will be read under`).join('\n');

  it('returns the text untouched when it fits', () => {
    const cut = truncateToTokens('short', 100, count);
    expect(cut).toEqual({ text: 'short', tokens: count('short'), truncated: false });
  });

  it('cuts to at most the budget, counted by the injected counter', () => {
    const cut = truncateToTokens(text, 120, count);
    expect(cut.truncated).toBe(true);
    expect(cut.tokens).toBeLessThanOrEqual(120);
    expect(count(cut.text)).toBe(cut.tokens);
    expect(text.startsWith(cut.text)).toBe(true);
  });

  it('honours a counter that disagrees with the character estimate', () => {
    // Four times the tokens per character, which is what a real tokenizer does to Turkish text
    // relative to `estimateTokens`. The cut has to move with the counter, not with the length.
    const expensive = (t: string) => estimateTokens(t) * 4;
    const cheap = truncateToTokens(text, 400, count);
    const dear = truncateToTokens(text, 400, expensive);
    expect(dear.text.length).toBeLessThan(cheap.text.length);
    expect(expensive(dear.text)).toBeLessThanOrEqual(400);
  });
});

describe('chunksWithinBudget', () => {
  const joined = joinChunks(Array.from({ length: 10 }, (_, i) => `chunk ${i}: ${'word '.repeat(20)}`));

  it('returns every chunk when the whole thing fits', () => {
    expect(chunksWithinBudget(joined, 100_000, count)).toBe(10);
  });

  it('returns the number of whole chunks that fit, and that prefix really fits', () => {
    const fitting = chunksWithinBudget(joined, 100, count);
    expect(fitting).toBeGreaterThan(0);
    expect(fitting).toBeLessThan(10);
    expect(count(joined.text.slice(0, joined.offsets[fitting]))).toBeLessThanOrEqual(100);
    expect(count(joined.text.slice(0, joined.offsets[fitting + 1]))).toBeGreaterThan(100);
  });

  it('returns zero when not even the first chunk fits', () => {
    expect(chunksWithinBudget(joined, 2, count)).toBe(0);
  });
});

describe('storedDocumentContent', () => {
  it('stores the whole text when it is inside the cap', () => {
    expect(storedDocumentContent('hello', 1024)).toEqual({ content: 'hello', contentTruncated: false });
  });

  it('cuts on a character boundary rather than splitting a multi-byte sequence', () => {
    // `ş` is two bytes, so a cap of 5 lands inside the third one.
    const text = 'şşşşş';
    const cut = storedDocumentContent(text, 5);
    expect(cut.contentTruncated).toBe(true);
    expect(cut.content).toBe('şş');
    expect(cut.content).not.toContain('�');
    expect(Buffer.byteLength(cut.content, 'utf8')).toBeLessThanOrEqual(5);
  });

  it('measures the cap in bytes, not in characters', () => {
    const cut = storedDocumentContent('ş'.repeat(100), 20);
    expect(cut.content).toHaveLength(10);
  });
});
