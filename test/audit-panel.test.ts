import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022): no build
// step, no declarations, and `tsconfig.json` covers `src` only. Imported here anyway, because the
// alternative is that the one rule this panel has to obey — that a poll must not refetch it — is
// asserted nowhere but in a browser somebody has to open.
import { loadAudit } from '../public/audit.js';
// @ts-expect-error - see above.
import { state } from '../public/core.js';

/**
 * **The audit panel does not re-read itself on the dashboard's poll** ([ADR-0050](../.ssot/ADR.md#adr-0050)'s
 * rule, one table along), and every filter it does send goes to the server.
 *
 * `public/` has no build step and no DOM in this suite, so what is asserted is the part that needs
 * neither: `loadAudit()` is called by `app.js` on every refresh — twice a second while a project is
 * indexing — and is a no-op unless the request it would send has changed. A regression here is silent
 * in a browser and expensive in a database: a filtered scan of an append-only table, four times the
 * poll interval, for a page nobody asked to be re-read.
 *
 * The transient state it reads lives in `core.js` for the reason `test/dashboard-wiring.test.ts`
 * checks: `renderDetail()` replaces `#detail` wholesale, so none of it may live in the DOM.
 */

const PAGE = { events: [], nextCursor: null, filters: { actors: [], actions: [], projects: [], truncated: false }, retentionDays: 365 };

let fetchMock: ReturnType<typeof vi.fn>;

/** Every request `loadAudit()` has sent, as the path-and-query the server would see. */
const sent = (): string[] => fetchMock.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify(PAGE) }));
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(state.audit, {
    actor: '',
    project: '',
    action: '',
    from: '',
    to: '',
    cursor: null,
    back: [],
    nextCursor: null,
    loadedKey: null,
    loadedAt: null,
    status: 'idle',
    error: '',
    events: [],
    filters: null,
    retentionDays: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the audit panel asks for, and how often', () => {
  it('reads once, and then not again however many times the poll calls it', async () => {
    await loadAudit();
    expect(sent()).toHaveLength(1);

    // app.js calls this on every refresh — POLL_ACTIVE_MS is two seconds.
    for (let poll = 0; poll < 20; poll++) await loadAudit();
    expect(sent()).toHaveLength(1);
  });

  it('reads again when a filter moves, and only then', async () => {
    await loadAudit();
    state.audit.actor = 'dana';
    await loadAudit();
    await loadAudit();
    expect(sent()).toHaveLength(2);

    state.audit.action = 'DELETE /api/projects/:id';
    await loadAudit();
    state.audit.from = '2026-09-01';
    await loadAudit();
    state.audit.to = '2026-09-19';
    await loadAudit();
    state.audit.project = 'none';
    await loadAudit();
    state.audit.cursor = '5f2c0a1b-0000-4000-8000-000000000002';
    await loadAudit();
    expect(sent()).toHaveLength(7);

    // Nothing moved; the poll is still a no-op.
    await loadAudit();
    expect(sent()).toHaveLength(7);
  });

  it('reads on demand when the Refresh button asks, which is the way to get a fresh page', async () => {
    await loadAudit();
    await loadAudit();
    expect(sent()).toHaveLength(1);
    await loadAudit(true);
    await loadAudit(true);
    expect(sent()).toHaveLength(3);
  });

  it('sends every filter to the server, and sends nothing for the ones not set', async () => {
    await loadAudit();
    const first = new URL(sent()[0], 'http://dashboard.invalid');
    expect(first.pathname).toBe('/api/audit');
    expect([...first.searchParams.keys()]).toEqual(['limit']);

    Object.assign(state.audit, {
      actor: 'dana',
      action: 'PATCH /api/projects/:id/query-log',
      project: 'none',
      from: '2026-09-01',
      to: '2026-09-19',
      cursor: '5f2c0a1b-0000-4000-8000-000000000002',
    });
    await loadAudit();

    const url = new URL(sent()[1], 'http://dashboard.invalid');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '50',
      actor: 'dana',
      action: 'PATCH /api/projects/:id/query-log',
      project: 'none',
      from: '2026-09-01',
      to: '2026-09-19',
      cursor: '5f2c0a1b-0000-4000-8000-000000000002',
    });
  });

  it('keeps the pickers it already has when a later page comes back without them', async () => {
    await loadAudit();
    expect(state.audit.filters).toEqual(PAGE.filters);

    // Paging answers `filters: null`, because three DISTINCT scans per page turn is the load this
    // panel exists not to create. The panel must not then empty its own dropdowns.
    fetchMock.mockImplementation(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ ...PAGE, filters: null }) }));
    state.audit.cursor = '5f2c0a1b-0000-4000-8000-000000000002';
    await loadAudit();
    expect(state.audit.filters).toEqual(PAGE.filters);
  });

  it('drops a page that came back after the filter moved on', async () => {
    const held: Array<() => void> = [];
    fetchMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          held.push(() => resolve({ status: 200, ok: true, text: async () => JSON.stringify({ ...PAGE, retentionDays: 1 }) }));
        }),
    );
    const inFlight = loadAudit();
    // The operator picks another actor while the first page is still in the air.
    state.audit.actor = 'kerem';
    state.audit.loadedKey = 'something-else';
    for (const release of held) release();
    await inFlight;
    // The stale page is discarded rather than painted over the newer request's state.
    expect(state.audit.retentionDays).toBeNull();
    expect(state.audit.status).toBe('loading');
  });
});
