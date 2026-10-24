import { describe, expect, it } from 'vitest';

import type { GoldenQuestionRow } from '../src/db/schema.js';
import {
  formatGoldenJsonl,
  GoldenQuestionInputSchema,
  GoldenQuestionPatchSchema,
  GoldenQuestionSetSchema,
  MAX_GOLDEN_QUESTIONS,
  toGoldenQuestionView,
  toGoldenRow,
} from '../src/services/golden-questions.js';
import { GoldenRowSchema } from '../src/services/golden-row.js';

/**
 * The shape of a project's golden question (Faz 09 of 0.4.0): what a client may write, what the scorer
 * reads back, and the file the set exports as. Everything here is pure; the table and the routes are
 * proved against a database in `test/integration/golden-questions.itest.ts`.
 */

const valid = { key: 'en-start-01', lang: 'en', query: 'How do I start?', expectFile: 'en/getting-started.md' } as const;

function row(overrides: Partial<GoldenQuestionRow> = {}): GoldenQuestionRow {
  return {
    id: '0b1f4c52-7a3e-4a33-9d0e-3f5a7a1d2c11',
    projectId: '6e1a3c70-2b64-4d5e-8f10-9a8b7c6d5e4f',
    key: 'en-start-01',
    lang: 'en',
    query: 'How do I start?',
    expectFile: 'en/getting-started.md',
    expectHeading: null,
    tags: [],
    note: null,
    createdAt: new Date('2026-10-24T08:00:00Z'),
    updatedAt: new Date('2026-10-24T09:30:00Z'),
    ...overrides,
  };
}

describe('GoldenQuestionInputSchema', () => {
  it('accepts a row as golden.jsonl spells it, defaulting the tags', () => {
    expect(GoldenQuestionInputSchema.parse(valid)).toEqual({ ...valid, tags: [] });
  });

  it('keeps the optional fields it is given', () => {
    const parsed = GoldenQuestionInputSchema.parse({ ...valid, expectHeading: 'What you need', tags: ['a', 'b'], note: 'why' });
    expect(parsed).toMatchObject({ expectHeading: 'What you need', tags: ['a', 'b'], note: 'why' });
  });

  it.each(['Upper', '-leading', 'under_score', 'has space', ''])('refuses the key %j', (key) => {
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, key }).success).toBe(false);
  });

  it('refuses a key past 100 characters and accepts one of exactly 100', () => {
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, key: 'a'.repeat(100) }).success).toBe(true);
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, key: 'a'.repeat(101) }).success).toBe(false);
  });

  it('refuses a language the product does not index questions in', () => {
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, lang: 'de' }).success).toBe(false);
  });

  it('trims the query and refuses one that is empty after trimming or past 4000 characters', () => {
    expect(GoldenQuestionInputSchema.parse({ ...valid, query: '  padded  ' }).query).toBe('padded');
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, query: '   ' }).success).toBe(false);
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, query: 'q'.repeat(4001) }).success).toBe(false);
  });

  it('bounds the tags in number and length', () => {
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, tags: Array.from({ length: 32 }, (_, i) => `t${i}`) }).success).toBe(true);
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, tags: ['t'.repeat(65)] }).success).toBe(false);
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, tags: [''] }).success).toBe(false);
  });

  it('refuses a field it does not know, so a negative question cannot ride in as a golden one', () => {
    expect(GoldenQuestionInputSchema.safeParse({ ...valid, kind: 'off-domain' }).success).toBe(false);
  });
});

describe('GoldenQuestionPatchSchema', () => {
  it('takes any subset of the fields', () => {
    expect(GoldenQuestionPatchSchema.parse({ note: 'changed' })).toEqual({ note: 'changed' });
    expect(GoldenQuestionPatchSchema.parse({ expectHeading: null })).toEqual({ expectHeading: null });
  });

  it('refuses an empty patch', () => {
    expect(GoldenQuestionPatchSchema.safeParse({}).success).toBe(false);
  });

  it('never renumbers a question: key is not a patchable field', () => {
    expect(GoldenQuestionPatchSchema.safeParse({ key: 'other' }).success).toBe(false);
  });
});

describe('GoldenQuestionSetSchema', () => {
  it('holds at most MAX_GOLDEN_QUESTIONS questions', () => {
    const question = (i: number) => ({ ...valid, key: `q-${i}` });
    expect(GoldenQuestionSetSchema.safeParse({ questions: Array.from({ length: MAX_GOLDEN_QUESTIONS }, (_, i) => question(i)) }).success).toBe(true);
    expect(GoldenQuestionSetSchema.safeParse({ questions: Array.from({ length: MAX_GOLDEN_QUESTIONS + 1 }, (_, i) => question(i)) }).success).toBe(
      false,
    );
  });

  it('accepts an empty set, which is how a set is cleared', () => {
    expect(GoldenQuestionSetSchema.parse({ questions: [] })).toEqual({ questions: [] });
  });
});

describe('toGoldenQuestionView', () => {
  it('names the row id and the key apart, and serialises the dates', () => {
    const view = toGoldenQuestionView(row({ expectHeading: 'What you need', tags: ['x'], note: 'n' }));
    expect(view).toEqual({
      id: '0b1f4c52-7a3e-4a33-9d0e-3f5a7a1d2c11',
      key: 'en-start-01',
      lang: 'en',
      query: 'How do I start?',
      expectFile: 'en/getting-started.md',
      expectHeading: 'What you need',
      tags: ['x'],
      note: 'n',
      createdAt: '2026-10-24T08:00:00.000Z',
      updatedAt: '2026-10-24T09:30:00.000Z',
    });
    expect(view).not.toHaveProperty('projectId');
  });
});

describe('toGoldenRow', () => {
  it('maps the key to the id the scorer reads', () => {
    expect(toGoldenRow(row({ expectHeading: 'H', note: 'n', tags: ['t'] }))).toEqual({
      id: 'en-start-01',
      lang: 'en',
      query: 'How do I start?',
      expectFile: 'en/getting-started.md',
      expectHeading: 'H',
      tags: ['t'],
      note: 'n',
    });
  });

  it('leaves a NULL heading and note absent rather than null, which scoreRow reads as "not given"', () => {
    const mapped = toGoldenRow(row());
    expect(mapped).not.toHaveProperty('expectHeading');
    expect(mapped).not.toHaveProperty('note');
    expect(mapped.expectHeading).toBeUndefined();
  });

  it('produces a row the golden.jsonl schema accepts', () => {
    expect(GoldenRowSchema.safeParse(toGoldenRow(row({ expectHeading: 'H' }))).success).toBe(true);
    expect(GoldenRowSchema.safeParse(toGoldenRow(row())).success).toBe(true);
  });
});

describe('formatGoldenJsonl', () => {
  it('is empty for an empty set, not a lone newline', () => {
    expect(formatGoldenJsonl([])).toBe('');
  });

  it('writes one JSON object per line and ends with a newline', () => {
    const text = formatGoldenJsonl([row(), row({ key: 'en-start-02', expectHeading: 'H' })]);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 'en-start-01', lang: 'en', query: 'How do I start?', expectFile: 'en/getting-started.md', tags: [] });
    expect(JSON.parse(lines[1])).toMatchObject({ id: 'en-start-02', expectHeading: 'H' });
  });

  it('exports in the shape golden.jsonl is read in: no uuid, no timestamps, no project', () => {
    const [line] = formatGoldenJsonl([row()]).trimEnd().split('\n');
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(['expectFile', 'id', 'lang', 'query', 'tags']);
  });
});
