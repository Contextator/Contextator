import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
import {
  evalCommand,
  loadGolden,
  normalizeForm,
  parseTags,
  questionCreateBody,
  questionPatch,
  validateQuestion,
  // @ts-expect-error - see above.
} from '../public/golden.js';

/**
 * **The panel keeps the questions; it does not score them.** It reads, validates and sends the stored
 * golden set the way the route takes it, and hands over the command that runs the evaluation, because
 * the server deliberately has no route that runs one (FR-347).
 */

let fetchMock: ReturnType<typeof vi.fn>;
const STORED = {
  id: 'q1',
  key: 'reset-password',
  lang: 'en',
  query: 'How do I reset my password?',
  expectFile: 'guides/account.md',
  expectHeading: 'Resetting a password',
  tags: ['account', 'how-to'],
  note: null,
};

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ questions: [STORED] }) }));
  vi.stubGlobal('fetch', fetchMock);
  state.projects = [{ id: 'p1', name: 'handbook' }];
  state.selectedId = 'p1';
  Object.assign(state.golden, { projectId: null, status: 'idle', error: '', questions: [], shown: 25, confirmDelete: null });
});

afterEach(() => vi.unstubAllGlobals());

describe('reading the set', () => {
  it("asks the project's golden-questions route, once per selection", async () => {
    await loadGolden();
    await loadGolden();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/p1/golden-questions');
    expect(state.golden.status).toBe('done');
    expect(state.golden.questions).toEqual([STORED]);
  });

  it('reads again when forced, and says so when it cannot', async () => {
    await loadGolden();
    fetchMock.mockImplementationOnce(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) }));
    await loadGolden(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.golden.status).toBe('error');
    expect(state.golden.error).toBe('boom');
  });

  it("drops the previous project's questions when the selection moves", async () => {
    await loadGolden();
    state.projects = [{ id: 'p2', name: 'other' }];
    state.selectedId = 'p2';
    fetchMock.mockImplementationOnce(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ questions: [] }) }));
    await loadGolden();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/p2/golden-questions');
    expect(state.golden.questions).toEqual([]);
  });
});

describe('the form', () => {
  const typed = (over = {}) =>
    normalizeForm({ key: 'a-1', lang: 'tr', query: '  Merhaba?  ', expectFile: ' a.md ', expectHeading: '', tags: 'x, y,,x', note: '', ...over });

  it('normalizes what was typed', () => {
    expect(typed()).toEqual({ key: 'a-1', lang: 'tr', query: 'Merhaba?', expectFile: 'a.md', expectHeading: null, tags: ['x', 'y'], note: null });
    expect(parseTags('a\nb, a')).toEqual(['a', 'b']);
  });

  it('refuses what the server would refuse, in words', () => {
    expect(validateQuestion(typed({ key: '' }), { creating: true })).toMatch(/key/);
    expect(validateQuestion(typed({ key: 'Bad Key' }), { creating: true })).toMatch(/lowercase/);
    expect(validateQuestion(typed({ key: '-x' }), { creating: true })).toMatch(/lowercase/);
    expect(validateQuestion(typed({ query: ' ' }), { creating: true })).toMatch(/question/);
    expect(validateQuestion(typed({ expectFile: '' }), { creating: true })).toMatch(/file/);
    expect(validateQuestion(typed({ tags: Array.from({ length: 33 }, (_, i) => `t${i}`).join(',') }), { creating: true })).toMatch(/tags/);
    expect(validateQuestion(typed(), { creating: true })).toBeNull();
    // An edit never checks the key: it cannot change.
    expect(validateQuestion(typed({ key: '' }), { creating: false })).toBeNull();
  });

  it('sends a create with the optional fields only when there is something to say', () => {
    expect(questionCreateBody(typed())).toEqual({ key: 'a-1', lang: 'tr', query: 'Merhaba?', expectFile: 'a.md', tags: ['x', 'y'] });
    expect(questionCreateBody(typed({ expectHeading: 'H', note: 'n' }))).toMatchObject({ expectHeading: 'H', note: 'n' });
  });

  it('sends an edit as only the fields that changed, with null to clear one', () => {
    const same = normalizeForm({ ...STORED, tags: STORED.tags.join(', ') });
    expect(questionPatch(STORED, same)).toEqual({});
    expect(questionPatch(STORED, { ...same, query: 'Another?' })).toEqual({ query: 'Another?' });
    expect(questionPatch(STORED, { ...same, expectHeading: null })).toEqual({ expectHeading: null });
    expect(questionPatch(STORED, { ...same, tags: ['account'] })).toEqual({ tags: ['account'] });
    expect(questionPatch(STORED, { ...same, note: 'new' })).toEqual({ note: 'new' });
    expect(questionPatch(STORED, { ...same, key: 'renamed' })).toEqual({}); // the key is never sent
  });
});

describe('the evaluation command', () => {
  it('names the project, quoting it only when a shell would split it', () => {
    expect(evalCommand('handbook')).toBe('npm run eval -- --project handbook');
    expect(evalCommand('team docs')).toBe("npm run eval -- --project 'team docs'");
    expect(evalCommand("it's")).toBe("npm run eval -- --project 'it'\\''s'");
  });
});
