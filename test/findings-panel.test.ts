import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
import {
  emptyText,
  findingsState,
  groupSizes,
  loadFindingsFor,
  PAGE,
  renderFindings,
  ruleLabel,
  scanNotes,
  totalFor,
  // @ts-expect-error - see above.
} from '../public/findings.js';
import { actionLabels, descendants, fakeDocument, type FakeNode } from './helpers/fake-dom.js';

/**
 * **The findings section shows where, never what.** It lists the rule, the document and position and the
 * masked preview the server sent; says apart that scanning is off, that nothing is grouped, that documents
 * hit the per-document ceiling and that documents were cut when indexed; and is not drawn for a `viewer`
 * (ADR-0130 decision 6). The render functions are driven from state alone, with the smallest DOM `el()` needs.
 */

const PROJECT_ID = 'p1';

type Role = 'viewer' | 'editor' | 'admin';

function signIn(role: Role) {
  state.me = {
    id: 'u1',
    username: 'someone',
    role: role === 'admin' ? 'admin' : 'user',
    projects: role === 'admin' ? {} : { [PROJECT_ID]: role },
  };
  return {
    id: PROJECT_ID,
    name: 'handbook',
    access: role === 'admin' ? 'manager' : role,
    lastIndexedAt: '2026-10-28T10:00:00.000Z',
    documentCount: 3,
  };
}

const SUMMARY = {
  byRule: { aws_access_key: 2, github_token: 0, private_key: 0, jwt: 0, tckn: 0, iban: 1 },
  documentsScanned: 3,
  documentsPending: 0,
  documentsWithoutText: 0,
  documentsCapped: 0,
  documentsTruncated: 0,
  enabled: true,
  grouped: true,
};

/** A finding as the route sends it: a masked preview, never the value. */
const finding = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  rule: 'aws_access_key',
  path: 'ops/runbook.md',
  title: 'Runbook',
  line: 12,
  col: 8,
  preview: 'AKIA************MPLE',
  group: 'a1b2c3d4e5f6',
  sourceUrl: null,
  ...over,
});

const AWS_VALUE = 'AKIAIOSFODNN7EXAMPLE';

const FIRST = finding();
const SECOND = finding({ id: 'f2', path: 'ops/old-notes.md', line: 3, col: 1, group: 'a1b2c3d4e5f6' });
const THIRD = finding({
  id: 'f3',
  rule: 'iban',
  path: 'finance/payroll.md',
  line: 40,
  col: 5,
  preview: 'TR33 **** **** **** **** **26',
  group: 'ffeeddccbbaa',
});

function respond(body: unknown, status = 200) {
  return { status, ok: status < 400, text: async () => JSON.stringify(body) };
}

const page = (findings: unknown[], summary: Record<string, unknown> = {}, nextCursor: string | null = null) => ({
  findings,
  nextCursor,
  summary: { ...SUMMARY, ...summary },
});

let fetchMock: ReturnType<typeof vi.fn>;

function install(body: unknown) {
  fetchMock = vi.fn(async () => respond(body));
  vi.stubGlobal('fetch', fetchMock);
}

const requested = (n = 0) => String(fetchMock.mock.calls[n]?.[0]);

/** Every piece of text and every attribute value a tree carries: what a reader, or DevTools, could see. */
function everything(tree: FakeNode): string {
  return descendants(tree)
    .flatMap((n) => [n.textContent, ...n.attrs.values()])
    .join('\n');
}

/** Runs the click handler of the button with this label. */
function press(tree: FakeNode, label: string): void {
  const button = descendants(tree).find((n) => n.tag === 'button' && n.textContent === label);
  const onclick = button?.listeners.get('click') as (() => void) | undefined;
  if (!onclick) throw new Error(`no button labelled "${label}"`);
  onclick();
}

const notesOf = (tree: FakeNode) =>
  descendants(tree)
    .filter((n) => n.getAttribute('data-note'))
    .map((n) => n.getAttribute('data-note'));

beforeEach(() => {
  vi.stubGlobal('document', fakeDocument());
  Object.assign(findingsState, {
    projectId: null,
    status: 'idle',
    error: '',
    items: [],
    nextCursor: null,
    summary: null,
    rule: '',
    more: false,
    loadedKey: null,
    loadedAt: null,
  });
  state.projects = [{ id: PROJECT_ID, name: 'handbook' }];
  state.selectedId = PROJECT_ID;
  install(page([FIRST, SECOND, THIRD]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  state.me = null;
});

describe('pure helpers', () => {
  it('names each rule, and shows an id it does not know as it came', () => {
    expect(ruleLabel('aws_access_key')).toBe('AWS access key');
    expect(ruleLabel('tckn')).toBe('Turkish citizen number');
    expect(ruleLabel('future_rule')).toBe('future_rule');
  });

  it('counts the findings of a group among those in hand, and ignores findings with no group', () => {
    const sizes = groupSizes([FIRST, SECOND, THIRD, finding({ id: 'f4', group: null })]);
    expect(sizes.get('a1b2c3d4e5f6')).toBe(2);
    expect(sizes.get('ffeeddccbbaa')).toBe(1);
    expect(sizes.size).toBe(2);
  });

  it('totals the findings of the project or of one rule', () => {
    expect(totalFor(SUMMARY, '')).toBe(3);
    expect(totalFor(SUMMARY, 'iban')).toBe(1);
    expect(totalFor(SUMMARY, 'jwt')).toBe(0);
    expect(totalFor(null, '')).toBe(0);
  });
});

describe('the empty list says which kind of empty it is', () => {
  const none = { ...SUMMARY, byRule: { ...SUMMARY.byRule, aws_access_key: 0, iban: 0 } };

  it('no findings: states that documents were scanned', () => {
    expect(emptyText(none, '')).toMatch(/^No findings\. 3 documents were scanned/);
  });

  it('scanning off: says so and does not claim a clean result', () => {
    const text = emptyText({ ...none, enabled: false }, '');
    expect(text).toContain('PII_SCAN=0');
    expect(text).not.toMatch(/No findings/);
  });

  it('nothing scanned yet: says documents are waiting', () => {
    const text = emptyText({ ...none, documentsScanned: 0, documentsPending: 1 }, '');
    expect(text).toContain('Nothing has been scanned yet');
    expect(text).toContain('1 document is waiting');
  });

  it('scanning off with a rule chosen and findings under other rules: does not say none was ever reported', () => {
    const text = emptyText({ ...SUMMARY, enabled: false }, 'jwt');
    expect(text).toBe('No findings for JSON Web Token among those found before scanning was switched off (PII_SCAN=0).');
  });

  it('a rule chosen: names the rule', () => {
    expect(emptyText(none, 'jwt')).toBe('No findings for JSON Web Token.');
  });
});

describe('the notes about the scan are separate statements', () => {
  const keys = (summary: Record<string, unknown>) => scanNotes({ ...SUMMARY, ...summary }).map((n: { key: string }) => n.key);

  it('says nothing when there is nothing to say', () => {
    expect(keys({})).toEqual([]);
  });

  it('scanning off', () => {
    expect(keys({ enabled: false })).toEqual(['disabled']);
  });

  it('scanning off with nothing listed: no note, since the empty-list text says it', () => {
    expect(scanNotes({ ...SUMMARY, enabled: false }, { listed: false })).toEqual([]);
  });

  it('grouping off (no SECRET_KEY) is its own note and names the cause', () => {
    const notes = scanNotes({ ...SUMMARY, grouped: false });
    expect(notes.map((n: { key: string }) => n.key)).toEqual(['ungrouped']);
    expect(notes[0].text).toContain('SECRET_KEY');
    expect(notes[0].text).toContain('not grouped');
  });

  it('capped and truncated are two facts, each with its own count', () => {
    const notes = scanNotes({ ...SUMMARY, documentsCapped: 2, documentsTruncated: 5 });
    expect(notes.map((n: { key: string }) => n.key)).toEqual(['capped', 'truncated']);
    expect(notes[0].text).toContain('2 documents have more findings than are kept');
    expect(notes[1].text).toContain('5 documents were cut when indexed');
  });

  it('pending is not said when scanning is off, since nothing is waiting for a scan that will not come', () => {
    expect(keys({ documentsPending: 4 })).toEqual(['pending']);
    expect(keys({ documentsPending: 4, enabled: false })).toEqual(['disabled']);
  });

  it('documents with no text are counted', () => {
    expect(scanNotes({ ...SUMMARY, documentsWithoutText: 1 })[0].text).toContain('1 document has no stored text');
  });
});

describe('reading', () => {
  it('asks for the first page of the project, without a rule', async () => {
    await loadFindingsFor(signIn('editor'));
    expect(requested()).toBe(`/api/projects/${PROJECT_ID}/findings?limit=${PAGE}`);
    expect(findingsState.status).toBe('done');
    expect(findingsState.items).toHaveLength(3);
  });

  it('asks nothing of a viewer, whom the route would refuse', async () => {
    await loadFindingsFor(signIn('viewer'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for an admin, whose access to every project is implicit', async () => {
    await loadFindingsFor(signIn('admin'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op until the index or the rule moves, and reads again when forced', async () => {
    const project = signIn('editor');
    await loadFindingsFor(project);
    await loadFindingsFor(project);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadFindingsFor({ ...project, documentCount: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await loadFindingsFor(project, true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a chosen rule is part of the request', async () => {
    const project = signIn('editor');
    await loadFindingsFor(project);
    findingsState.rule = 'iban';
    await loadFindingsFor(project);
    expect(requested(1)).toBe(`/api/projects/${PROJECT_ID}/findings?limit=${PAGE}&rule=iban`);
  });

  it('keeps the error and no list when the read fails', async () => {
    install({ message: 'boom' });
    fetchMock.mockImplementation(async () => respond({ message: 'boom' }, 500));
    await loadFindingsFor(signIn('editor'));
    expect(findingsState.status).toBe('error');
    expect(findingsState.error).toBe('boom');
    expect(findingsState.items).toEqual([]);
  });

  it('a read for the project that was left does not land on the one now open', async () => {
    let release: (value: unknown) => void = () => undefined;
    fetchMock = vi.fn(() => new Promise((resolve) => (release = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const slow = loadFindingsFor(signIn('editor'));
    findingsState.projectId = 'other';
    release(respond(page([FIRST])));
    await slow;
    expect(findingsState.items).toEqual([]);
  });
});

describe('rendering', () => {
  async function drawn(role: Role = 'editor') {
    const project = signIn(role);
    await loadFindingsFor(project);
    return renderFindings(project) as FakeNode;
  }

  it('is not drawn for a viewer, and is for an editor and an admin', async () => {
    expect(renderFindings(signIn('viewer'))).toBeNull();
    expect(renderFindings(signIn('editor'))).not.toBeNull();
    expect(renderFindings(signIn('admin'))).not.toBeNull();
  });

  it('reads first: says so until the first answer is in', () => {
    const tree = renderFindings(signIn('editor')) as FakeNode;
    expect(tree.textContent).toContain('Reading the findings…');
  });

  it('lists the rule, the path, the position and the masked preview', async () => {
    const tree = await drawn();
    const rows = descendants(tree).filter((n) => n.className === 'finding');
    expect(rows).toHaveLength(3);
    const first = rows[0]?.textContent ?? '';
    expect(first).toContain('AWS access key');
    expect(first).toContain('ops/runbook.md');
    expect(first).toContain('line 12, column 8');
    expect(first).toContain('AKIA************MPLE');
    expect(rows[2]?.textContent).toContain('IBAN');
  });

  it('shows no value: only what the server sent as a preview, and nothing of the response it was not meant to draw', async () => {
    install(page([{ ...FIRST, value: AWS_VALUE, valueHmac: 'deadbeef'.repeat(8), normalized: AWS_VALUE }]));
    const tree = await drawn();
    const seen = everything(tree);
    expect(seen).toContain('AKIA************MPLE');
    expect(seen).not.toContain(AWS_VALUE);
    expect(seen).not.toContain('deadbeef');
  });

  it('a hostile path or preview is text, not markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    install(page([finding({ path: hostile, preview: hostile })]));
    const tree = await drawn();
    expect(descendants(tree).every((n) => n.innerHTML === '')).toBe(true);
    expect(tree.textContent).toContain(hostile);
  });

  it('links the path to the document at its source when the source is a web address', async () => {
    install(page([finding({ sourceUrl: 'https://example.com/wiki/runbook' }), finding({ id: 'f2', sourceUrl: null })]));
    const tree = await drawn();
    const links = descendants(tree).filter((n) => n.tag === 'a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/wiki/runbook');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.textContent).toBe('ops/runbook.md');
  });

  it('never makes a link of an address that is not http(s)', async () => {
    install(page([finding({ sourceUrl: 'javascript:alert(1)' })]));
    const tree = await drawn();
    expect(descendants(tree).filter((n) => n.tag === 'a')).toHaveLength(0);
    expect(tree.textContent).toContain('ops/runbook.md');
  });

  it('marks findings of the same value, and only where two are in the list', async () => {
    const tree = await drawn();
    const groups = descendants(tree).filter((n) => n.className === 'finding-group');
    expect(groups.map((n) => n.textContent)).toEqual(['same value a1b2c3d4 ×2', 'same value a1b2c3d4 ×2']);
  });

  it('with grouping off, lists the findings, draws no group, and says why', async () => {
    install(page([FIRST, SECOND], { grouped: false }));
    const tree = await drawn();
    expect(descendants(tree).filter((n) => n.className === 'finding')).toHaveLength(2);
    expect(descendants(tree).filter((n) => n.className === 'finding-group')).toHaveLength(0);
    expect(notesOf(tree)).toEqual(['ungrouped']);
    expect(tree.textContent).toContain('SECRET_KEY is not set');
  });

  it('with grouping off a group id the server did send is not drawn either', async () => {
    install(page([FIRST, SECOND], { grouped: false }));
    const tree = await drawn();
    expect(everything(tree)).not.toContain('a1b2c3d4');
  });

  it('with scanning off and nothing found, says so once: in the empty-list text and not also in a note', async () => {
    install(page([], { enabled: false, byRule: { ...SUMMARY.byRule, aws_access_key: 0, iban: 0 } }));
    const tree = await drawn();
    expect(notesOf(tree)).toEqual([]);
    expect(tree.textContent.match(/PII_SCAN=0/g)).toHaveLength(1);
    const empty = descendants(tree).find((n) => n.className === 'hint findings-empty');
    expect(empty?.textContent).toContain('Scanning is switched off');
    expect(descendants(tree).filter((n) => n.className === 'finding')).toHaveLength(0);
  });

  it('with scanning off and a rule that has no findings among others that do, says that once too', async () => {
    install(page([], { enabled: false }));
    const project = signIn('editor');
    await loadFindingsFor(project);
    findingsState.rule = 'jwt';
    await loadFindingsFor(project);
    const tree = renderFindings(project) as FakeNode;
    expect(notesOf(tree)).toEqual([]);
    expect(tree.textContent.match(/PII_SCAN=0/g)).toHaveLength(1);
    expect(tree.textContent).toContain('No findings for JSON Web Token among those found before scanning was switched off');
  });

  it('with scanning off and earlier findings, still lists them and says they are from before', async () => {
    install(page([FIRST], { enabled: false }));
    const tree = await drawn();
    expect(descendants(tree).filter((n) => n.className === 'finding')).toHaveLength(1);
    expect(tree.textContent).toContain('from before it was switched off');
  });

  it('with nothing found, says no findings and how many documents were scanned', async () => {
    install(page([], { byRule: { ...SUMMARY.byRule, aws_access_key: 0, iban: 0 } }));
    const tree = await drawn();
    expect(tree.textContent).toContain('No findings. 3 documents were scanned');
    expect(notesOf(tree)).toEqual([]);
  });

  it('draws the ceiling and the cut as two separate notes', async () => {
    install(page([FIRST], { documentsCapped: 1, documentsTruncated: 2 }));
    const tree = await drawn();
    expect(notesOf(tree)).toEqual(['capped', 'truncated']);
  });

  it('shows a count by rule in the filter, and what is on screen of the total', async () => {
    const tree = await drawn();
    const options = descendants(tree)
      .filter((n) => n.tag === 'option')
      .map((n) => n.textContent);
    expect(options[0]).toBe('All rules (3)');
    expect(options).toContain('AWS access key (2)');
    expect(options).toContain('IBAN (1)');
    expect(options).toContain('JSON Web Token (0)');
    expect(tree.textContent).toContain('Showing 3 of 3');
  });

  it('choosing a rule reads again with that rule', async () => {
    const tree = await drawn();
    const select = descendants(tree).find((n) => n.tag === 'select');
    expect(select?.getAttribute('aria-label')).toBe('Show findings of one rule');
    const onchange = select?.listeners.get('change') as (event: unknown) => void;
    install(page([THIRD], {}));
    onchange({ target: { value: 'iban' } });
    await vi.waitFor(() => expect(findingsState.items).toHaveLength(1));
    expect(requested()).toBe(`/api/projects/${PROJECT_ID}/findings?limit=${PAGE}&rule=iban`);
  });

  it('opens the next page with its cursor and appends it', async () => {
    install(page([FIRST], {}, 'cursor-1'));
    const project = signIn('editor');
    await loadFindingsFor(project);
    const tree = renderFindings(project) as FakeNode;
    expect(actionLabels(tree)).toContain('Show 2 more');

    install(page([THIRD], {}, null));
    press(tree, 'Show 2 more');
    await vi.waitFor(() => expect(findingsState.items).toHaveLength(2));
    expect(requested()).toContain('cursor=cursor-1');
    expect(findingsState.nextCursor).toBeNull();
    expect(actionLabels(renderFindings(project) as FakeNode)).not.toContain('Show 2 more');
  });

  it('has a Refresh that reads again', async () => {
    const project = signIn('editor');
    await loadFindingsFor(project);
    const tree = renderFindings(project) as FakeNode;
    press(tree, 'Refresh');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('a failed first read offers Retry', async () => {
    fetchMock.mockImplementation(async () => respond({ message: 'boom' }, 500));
    const project = signIn('editor');
    await loadFindingsFor(project);
    const tree = renderFindings(project) as FakeNode;
    expect(tree.textContent).toContain('Could not read the findings: boom');
    expect(actionLabels(tree)).toContain('Retry');
  });
});

describe('races and failures while a page is read', () => {
  /** A fetch that answers when the test says so, in the order it was asked. */
  function deferred() {
    const pending: Array<(value: unknown) => void> = [];
    fetchMock = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    return pending;
  }

  const rows = (tree: FakeNode) => descendants(tree).filter((n) => n.className === 'finding');

  async function withNextPage() {
    install(page([FIRST], {}, 'cursor-1'));
    const project = signIn('editor');
    await loadFindingsFor(project);
    return project;
  }

  it('"Show more" taken while a rule is being read does nothing, and the panel recovers with the new rule', async () => {
    const project = await withNextPage();
    const staleTree = renderFindings(project) as FakeNode;

    const pending = deferred();
    findingsState.rule = 'iban';
    const reading = loadFindingsFor(project);
    // The button of the old render is still in the page for an instant: pressing it asks for nothing.
    press(staleTree, 'Show 2 more');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const during = renderFindings(project) as FakeNode;
    expect(during.textContent).toContain('Reading the findings…');
    expect(actionLabels(during).some((l) => l.startsWith('Show '))).toBe(false);

    pending[0]?.(respond(page([THIRD])));
    await reading;
    expect(findingsState.status).toBe('done');
    expect(findingsState.items.map((i: { id: string }) => i.id)).toEqual(['f3']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('rule=iban');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('cursor=');
    const after = renderFindings(project) as FakeNode;
    expect(rows(after)).toHaveLength(1);
    expect(actionLabels(after)).toContain('Refresh');
    expect(
      descendants(after)
        .find((n) => n.tag === 'button' && n.textContent === 'Refresh')
        ?.getAttribute('disabled'),
    ).toBeNull();
  });

  it('"Show more" taken while Refresh is reading does not strand the panel in "Reading…"', async () => {
    const project = await withNextPage();
    const staleTree = renderFindings(project) as FakeNode;
    const pending = deferred();
    const reading = loadFindingsFor(project, true);
    press(staleTree, 'Show 2 more');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending[0]?.(respond(page([FIRST, SECOND])));
    await reading;
    expect(findingsState.status).toBe('done');
    expect(rows(renderFindings(project) as FakeNode)).toHaveLength(2);
  });

  it('a "Show more" read that a Refresh overtakes does not land on the new list', async () => {
    const project = await withNextPage();
    const tree = renderFindings(project) as FakeNode;
    const pending = deferred();
    press(tree, 'Show 2 more');
    const refreshing = loadFindingsFor(project, true);
    pending[0]?.(respond(page([THIRD])));
    pending[1]?.(respond(page([FIRST, SECOND])));
    await refreshing;
    await vi.waitFor(() => expect(findingsState.more).toBe(false));
    expect(findingsState.items.map((i: { id: string }) => i.id)).toEqual(['f1', 'f2']);
  });

  it('a failed "Show more" says so, keeps the list, and offers another try that works', async () => {
    const project = await withNextPage();
    fetchMock.mockImplementation(async () => respond({ message: 'upstream down' }, 502));
    press(renderFindings(project) as FakeNode, 'Show 2 more');
    await vi.waitFor(() => expect(findingsState.moreError).toBe('upstream down'));

    const tree = renderFindings(project) as FakeNode;
    expect(tree.textContent).toContain('The next findings could not be read: upstream down');
    expect(rows(tree)).toHaveLength(1);
    expect(actionLabels(tree)).toContain('Show 2 more');

    install(page([THIRD]));
    press(tree, 'Show 2 more');
    await vi.waitFor(() => expect(findingsState.items).toHaveLength(2));
    expect(findingsState.moreError).toBe('');
    expect(requested()).toContain('cursor=cursor-1');
    expect((renderFindings(project) as FakeNode).textContent).not.toContain('could not be read');
  });

  it("a rule whose first read fails shows the error and none of the other rule's findings", async () => {
    install(page([FIRST, SECOND], {}, 'cursor-1'));
    const project = signIn('editor');
    await loadFindingsFor(project);

    fetchMock.mockImplementation(async () => respond({ message: 'boom' }, 500));
    findingsState.rule = 'iban';
    await loadFindingsFor(project);

    expect(findingsState.status).toBe('error');
    expect(findingsState.items).toEqual([]);
    expect(findingsState.nextCursor).toBeNull();
    const tree = renderFindings(project) as FakeNode;
    expect(rows(tree)).toHaveLength(0);
    expect(tree.textContent).not.toContain('ops/runbook.md');
    expect(tree.textContent).toContain('The findings could not be read: boom');
    // An error is not an answer: the list does not claim there was nothing.
    expect(tree.textContent).not.toContain('No findings');
    expect(actionLabels(tree).some((l) => l.startsWith('Show '))).toBe(false);
    const select = descendants(tree).find((n) => n.tag === 'select');
    expect(descendants(select as FakeNode).find((n) => n.tag === 'option' && n.getAttribute('selected') !== null)?.textContent).toBe('IBAN (1)');
  });
});
