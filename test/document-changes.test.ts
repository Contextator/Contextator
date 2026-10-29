import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  type DocumentChangeKind,
  DOCUMENT_CHANGES_RETENTION_DAYS,
  classifyChange,
  historyStartsAt,
  isModified,
  parseSince,
  textProvesEqual,
  whatsNewTruncationNote,
} from '../src/services/document-changes.js';

/**
 * The decisions behind `whats_new` that need no database: whether a hash that moved is a change, what a
 * stored row is reported as for a `since`, how far back the record can speak, and how `since` is read
 * ([ADR-0123](../.ssot/ADR.md#adr-0123)). The statements that apply them are held to the same answers in
 * `test/integration/whats-new.itest.ts`.
 */

const at = (iso: string): Date => new Date(iso);

describe('textProvesEqual', () => {
  it('needs both texts, untruncated and identical', () => {
    expect(textProvesEqual({ content: 'a', contentTruncated: false }, { content: 'a', contentTruncated: false })).toBe(true);
  });

  it('is not proved by different text', () => {
    expect(textProvesEqual({ content: 'a', contentTruncated: false }, { content: 'b', contentTruncated: false })).toBe(false);
  });

  it('is not proved by a missing text on either side', () => {
    expect(textProvesEqual({ content: null, contentTruncated: false }, { content: 'a', contentTruncated: false })).toBe(false);
    expect(textProvesEqual({ content: 'a', contentTruncated: false }, { content: null, contentTruncated: false })).toBe(false);
    expect(textProvesEqual({ content: null, contentTruncated: false }, { content: null, contentTruncated: false })).toBe(false);
  });

  it('is not proved by a truncated text on either side, even when the stored parts agree', () => {
    expect(textProvesEqual({ content: 'a', contentTruncated: true }, { content: 'a', contentTruncated: false })).toBe(false);
    expect(textProvesEqual({ content: 'a', contentTruncated: false }, { content: 'a', contentTruncated: true })).toBe(false);
  });
});

describe('isModified', () => {
  const stored = (contentHash: string, content: string | null, contentTruncated = false) => ({ contentHash, content, contentTruncated });

  it('is not a change when the hash is the same, whatever the text says', () => {
    expect(isModified(stored('h1', 'a'), stored('h1', 'b'))).toBe(false);
    expect(isModified(stored('h1', null), stored('h1', null))).toBe(false);
  });

  it('is not a change when the hash moved and the text did not (one operation of a specification, a blanked hash)', () => {
    expect(isModified(stored('h1', 'same'), stored('h2', 'same'))).toBe(false);
    expect(isModified(stored('', 'same'), stored('h2', 'same'))).toBe(false);
  });

  it('is a change when the hash moved and the text did too', () => {
    expect(isModified(stored('h1', 'old'), stored('h2', 'new'))).toBe(true);
  });

  it('errs towards reporting when the text cannot prove equality', () => {
    expect(isModified(stored('h1', null), stored('h2', 'new'))).toBe(true);
    expect(isModified(stored('h1', 'same', true), stored('h2', 'same'))).toBe(true);
    expect(isModified(stored('h1', 'same'), stored('h2', 'same', true))).toBe(true);
  });
});

describe('classifyChange', () => {
  const since = at('2026-10-10T00:00:00Z');
  const before = at('2026-10-01T00:00:00Z');
  const after = at('2026-10-15T00:00:00Z');
  const later = at('2026-10-20T00:00:00Z');
  const row = (change: DocumentChangeKind, addedAt: Date | null, changedAt: Date) => ({ change, addedAt, changedAt });

  it.each<[string, ReturnType<typeof row>, DocumentChangeKind | null]>([
    ['a change at or before since is not reported', row('modified', null, since), null],
    ['a change before since is not reported', row('added', before, before), null],
    ['added inside the window stays added', row('added', after, after), 'added'],
    ['added inside the window and modified since is still added', row('modified', after, later), 'added'],
    ['added inside the window and removed since never was, to the agent', row('removed', after, later), null],
    ['added before the window and modified inside it is modified', row('modified', before, after), 'modified'],
    ['added before the window and removed inside it is removed', row('removed', before, after), 'removed'],
    ['an unknown addition date is never added: modified', row('modified', null, after), 'modified'],
    ['an unknown addition date is never added: removed', row('removed', null, after), 'removed'],
    ['an added row with no date is reported as it says', row('added', null, after), 'added'],
  ])('%s', (_name, input, expected) => {
    expect(classifyChange(input, since)).toBe(expected);
  });
});

describe('historyStartsAt', () => {
  const now = at('2026-10-25T12:00:00Z');

  it('is the retention horizon when recording began before it', () => {
    expect(historyStartsAt(now, at('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-07-27T12:00:00.000Z');
  });

  it('is the moment recording began when that is later than the horizon', () => {
    expect(historyStartsAt(now, at('2026-10-20T08:00:00Z')).toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('is the moment the project came to exist here when that is later than both, as for a project imported after recording began', () => {
    expect(historyStartsAt(now, at('2026-09-01T00:00:00Z'), at('2026-10-10T00:00:00Z')).toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('ignores a project that is older than the record', () => {
    expect(historyStartsAt(now, at('2026-10-20T08:00:00Z'), at('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(historyStartsAt(now, at('2026-01-01T00:00:00Z'), at('2025-01-01T00:00:00Z')).toISOString()).toBe('2026-07-27T12:00:00.000Z');
  });

  it('speaks for nothing when there is no record of when recording began', () => {
    expect(historyStartsAt(now, null).toISOString()).toBe(now.toISOString());
  });

  it('keeps ninety days', () => {
    expect(DOCUMENT_CHANGES_RETENTION_DAYS).toBe(90);
  });
});

describe('parseSince', () => {
  it.each([
    ['2026-10-01', '2026-10-01T00:00:00.000Z'],
    ['2026-10-01T09:30', '2026-10-01T09:30:00.000Z'],
    ['2026-10-01T09:30:15', '2026-10-01T09:30:15.000Z'],
    ['2026-10-01T09:30:15Z', '2026-10-01T09:30:15.000Z'],
    ['2026-10-01T09:30:15.123Z', '2026-10-01T09:30:15.123Z'],
    ['2026-10-01T09:30:15.1Z', '2026-10-01T09:30:15.100Z'],
    ['2026-10-01T09:30:15+02:00', '2026-10-01T07:30:15.000Z'],
    ['2026-10-01T00:30:00-03:30', '2026-10-01T04:00:00.000Z'],
    ['  2026-10-01T09:30:15z  ', '2026-10-01T09:30:15.000Z'],
    ['2028-02-29', '2028-02-29T00:00:00.000Z'],
  ])('reads %s as %s', (raw, iso) => {
    expect(parseSince(raw)?.toISOString()).toBe(iso);
  });

  it.each([
    'yesterday',
    'October 5 2026',
    '2026-10-01 09:30:00',
    '2026-10-01T09',
    '20261001',
    '2026-13-01',
    '2026-02-31',
    '2027-02-29',
    '2026-10-32',
    '2026-10-01T24:00:00Z',
    '2026-10-01T09:60:00Z',
    '2026-10-01T09:30:60Z',
    '2026-10-01T09:30:00+24:00',
    '2026-10-01T09:30:00+02:60',
    '2026-10-01T09:30:00+0200',
    '',
  ])('refuses %j', (raw) => {
    expect(parseSince(raw)).toBeNull();
  });
});

describe('the reaper', () => {
  // The sweep has to run on an instance that has switched the query log off: this table is not the query
  // log (ADR-0123 decision 5). The reaper's tick is a closure inside `server.ts`, so the order is held at
  // its source, the one place a refactor could silently reverse it.
  // Since 0.6.0 the query log's own sweep is not behind that switch either, so the reaper's tick neither
  // returns nor names the switch; the test holds that it stays that way.
  it('sweeps document changes with nothing in the tick consulting the query log switch', () => {
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('startSessionReaper(db');
    const tick = source
      .slice(start, source.indexOf('\n  });\n', start))
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(start).toBeGreaterThan(-1);
    expect(tick).toContain('sweepDocumentChanges(db)');
    expect(tick).not.toMatch(/\bSEARCH_QUERY_LOG\b(?!_)/);
    expect(tick).not.toMatch(/\breturn\b/);
  });
});

describe('whatsNewTruncationNote', () => {
  it('asks for a larger limit while one exists', () => {
    expect(whatsNewTruncationNote(2)).toBe(
      '[…truncated: the 2 newest changes are shown. Ask again with a larger limit (at most 200), to see the rest.]',
    );
    expect(whatsNewTruncationNote(199)).toContain('larger limit');
  });

  it('says to narrow the question at the ceiling, where no larger limit exists', () => {
    const note = whatsNewTruncationNote(200);
    expect(note).toContain('Narrow the question with source or version');
    expect(note).not.toContain('larger limit');
  });
});
