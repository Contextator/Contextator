import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { state } from '../public/core.js';
// @ts-expect-error - see above.
import { renderFloorSuggestions } from '../public/floor-suggestions.js';
// @ts-expect-error - see above.
import { renderGolden } from '../public/golden.js';
// @ts-expect-error - see above.
import { renderMcpAccess } from '../public/mcp.js';
// @ts-expect-error - see above.
import { renderQueries } from '../public/queries.js';
// @ts-expect-error - see above.
import { renderQuotas } from '../public/quotas.js';
import { actionLabels, descendants, fakeDocument, type FakeNode } from './helpers/fake-dom.js';

/**
 * **A button the signed-in account may not use is not drawn.** The server refuses the request anyway
 * (every rule is enforced again there), so this is not security; it is that a reader should not be
 * offered a control that answers 403. Each panel gates on a different thing — the quota limits on the
 * instance role, the floor on the manager access of the project, the golden set and the token
 * allowlists on edit access — so the cases below run every role through every gate. The render
 * functions are driven from state alone, with the smallest DOM that `el()` needs.
 */

type Role = 'viewer' | 'editor' | 'manager' | 'admin';

const PROJECT_ID = 'p1';
const ACCESS: Record<Role, string> = { viewer: 'viewer', editor: 'editor', manager: 'manager', admin: 'manager' };

/** What `/api/auth/me` and the project list say for each kind of account. */
function signIn(role: Role) {
  state.me = {
    id: 'u1',
    username: 'someone',
    role: role === 'admin' ? 'admin' : 'user',
    projects: role === 'admin' ? {} : { [PROJECT_ID]: role === 'viewer' ? 'viewer' : 'editor' },
  };
  return { id: PROJECT_ID, name: 'handbook', authMode: 'token', access: ACCESS[role] };
}

const ROLES: Role[] = ['viewer', 'editor', 'manager', 'admin'];
const has = (tree: FakeNode, label: string) => actionLabels(tree).includes(label);
const hasLabelled = (tree: FakeNode, text: string) =>
  descendants(tree).some((n) => n.tag === 'button' && (n.getAttribute('aria-label') ?? '').startsWith(text));

beforeEach(() => {
  vi.stubGlobal('document', fakeDocument());
  // A render that asks for data it lacks reads it; none of these cases wants the answer.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: 200, ok: true, text: async () => '{}' })),
  );
  state.projects = [{ id: PROJECT_ID, name: 'handbook' }];
  state.selectedId = PROJECT_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
  state.me = null;
});

describe('quotas: Edit limits is for an admin', () => {
  const limit = { limit: 100, used: 10, inherited: true };
  beforeEach(() => {
    Object.assign(state.quotas, {
      projectId: PROJECT_ID,
      status: 'done',
      data: { documents: limit, chunks: limit, uploadBytes: limit },
    });
  });

  for (const role of ROLES) {
    it(`${role}: ${role === 'admin' ? 'shown' : 'hidden'}`, () => {
      const tree = renderQuotas(signIn(role));
      expect(has(tree, 'Edit limits')).toBe(role === 'admin');
      expect(has(tree, 'Refresh')).toBe(true);
    });
  }

  it('is not offered before the limits have been read, even to an admin', () => {
    Object.assign(state.quotas, { data: null, status: 'loading' });
    expect(has(renderQuotas(signIn('admin')), 'Edit limits')).toBe(false);
  });
});

describe('floor suggestions: Measure and Apply are for a manager', () => {
  const current = { embeddingModel: 'm', liveGeneration: 1 };
  const suggestion = {
    id: 's1',
    suggestedFloor: 0.8,
    previousFloor: null,
    appliedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    trigger: 'operator',
    embeddingModel: 'm',
    liveGeneration: 1,
    basis: { method: 'sentences', probes: 100, allowedShare: 0.01, topScores: null, refusedAtPrevious: null },
  };
  beforeEach(() => {
    Object.assign(state.floorSuggestions, {
      projectId: PROJECT_ID,
      status: 'done',
      data: { current, suggestions: [suggestion] },
      notice: '',
      busy: false,
      showAll: false,
    });
  });

  for (const role of ROLES) {
    const manages = ACCESS[role] === 'manager';
    it(`${role}: ${manages ? 'shown' : 'hidden'}`, () => {
      const project = signIn(role);
      const tree = renderFloorSuggestions(project, project.access === 'manager', () => undefined);
      expect(has(tree, 'Measure a floor')).toBe(manages);
      expect(has(tree, 'Apply this floor')).toBe(manages);
      expect(has(tree, 'Dismiss')).toBe(manages);
    });
  }

  it('the queries panel hands the floor block the manager gate of the project', () => {
    Object.assign(state.queries, {
      projectId: PROJECT_ID,
      status: 'done',
      tab: 'questions',
      data: {
        logEnabled: true,
        instanceLogEnabled: true,
        scoreFloor: 0.8,
        configuration: null,
        configurations: [],
        questions: [],
        window: { retentionDays: 30 },
      },
    });
    for (const role of ROLES) {
      const tree = renderQueries(signIn(role));
      expect(has(tree, 'Measure a floor')).toBe(ACCESS[role] === 'manager');
    }
  });
});

describe('golden questions: Add, Edit and Delete are for those who can edit', () => {
  beforeEach(() => {
    Object.assign(state.golden, {
      projectId: PROJECT_ID,
      status: 'done',
      error: '',
      shown: 25,
      confirmDelete: null,
      questions: [
        { id: 'q1', key: 'reset-password', lang: 'en', query: 'How do I reset?', expectFile: 'a.md', expectHeading: null, tags: [], note: null },
      ],
    });
  });

  for (const role of ROLES) {
    const edits = role !== 'viewer';
    it(`${role}: ${edits ? 'shown' : 'hidden'}`, () => {
      const tree = renderGolden(signIn(role));
      expect(has(tree, 'Add question')).toBe(edits);
      expect(hasLabelled(tree, 'Edit the question')).toBe(edits);
      expect(hasLabelled(tree, 'Delete the question')).toBe(edits);
      // What a viewer may still do.
      expect(has(tree, 'Refresh')).toBe(true);
      expect(has(tree, 'Export JSONL')).toBe(true);
    });
  }
});

describe('MCP access: New token, Networks and Revoke are for those who can edit; the mode is for an admin', () => {
  beforeEach(() => {
    state.mcpTokensFor = PROJECT_ID;
    state.mcpTokens = [
      { id: 't1', prefix: 'ctx_abc', name: 'ci', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null, allowedCidrs: [] },
    ];
  });

  for (const role of ROLES) {
    const edits = role !== 'viewer';
    it(`${role}: ${edits ? 'token controls shown' : 'token controls hidden'}`, () => {
      const tree = renderMcpAccess(signIn(role));
      expect(has(tree, 'New token')).toBe(edits);
      expect(has(tree, 'Networks')).toBe(edits);
      expect(has(tree, 'Revoke')).toBe(edits);
    });
  }

  it('offers the other access modes to an admin only', () => {
    const modes = (role: Role) => actionLabels(renderMcpAccess(signIn(role))).filter((l) => l !== 'New token' && l !== 'Networks' && l !== 'Revoke');
    expect(modes('admin').length).toBeGreaterThan(0);
    for (const role of ['viewer', 'editor', 'manager'] as const) expect(modes(role)).toEqual([]);
  });
});
