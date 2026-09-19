import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_ROWS,
  PHRASED_ACTIONS,
  dayBounds,
  decodeCursor,
  encodeCursor,
  summarizeAction,
  summarizeAuditEvent,
} from '../src/admin/audit-routes.js';
import { AUDIT_EXEMPT_ROUTES, auditSubject } from '../src/auth/policy.js';
import { ValidationError } from '../src/services/projects.js';

/**
 * The read side of the audit log ([ADR-0055](../.ssot/ADR.md#adr-0055)): the parts of `GET /api/audit`
 * that have no database in them.
 *
 * `test/audit.test.ts` covers the row an action becomes and `test/permissions.test.ts` covers who may
 * read it. What is asserted here is what an operator actually sees — that a row becomes a sentence
 * rather than a dump of uuids, that a route nobody has written yet still renders, that a deleted
 * project's rows say so instead of going blank, and that the paging cursor cannot be made to mean
 * something the endpoint did not produce.
 */

const base = {
  action: 'DELETE /api/projects/:id/sources/:sid',
  actorLabel: 'dana',
  projectId: '9f1c2d3e-0000-4000-8000-000000000001',
  projectName: 'handbook',
  targetType: 'sid',
  targetId: '5f2c0a1b-0000-4000-8000-000000000002',
  detail: {} as Record<string, string | boolean>,
};

describe('a row as a sentence', () => {
  it('names the actor, what they did, and the project they did it to', () => {
    expect(summarizeAuditEvent(base)).toBe('dana deleted a source from handbook (source 5f2c0a1b…)');
  });

  it('carries the closed set of detail fields into the sentence, because that is the substance', () => {
    expect(
      summarizeAuditEvent({
        ...base,
        action: 'PATCH /api/projects/:id/mcp-auth',
        targetType: null,
        targetId: null,
        detail: { mode: 'account' },
      }),
    ).toBe('dana changed who may reach the MCP endpoint of handbook (mode: account)');
    // A boolean stays a boolean in the row and reads as a word here.
    expect(
      summarizeAuditEvent({ ...base, action: 'PATCH /api/projects/:id/query-log', targetType: null, targetId: null, detail: { enabled: false } }),
    ).toBe('dana switched query logging on handbook (enabled: false)');
  });

  /**
   * The case the schema was written for: `audit_events.project_id` carries **no foreign key**, because
   * deleting a project is itself one of the events recorded. So a panel joining `projects` for the name
   * gets nothing back, and the sentence has to be honest about it rather than silently dropping the
   * only clue as to which project it was.
   */
  it('says a project no longer exists instead of losing the row that outlived it', () => {
    expect(summarizeAuditEvent({ ...base, projectName: null })).toBe('dana deleted a source from 9f1c2d3e… (no longer exists) (source 5f2c0a1b…)');
    expect(summarizeAuditEvent({ ...base, action: 'DELETE /api/projects/:id', projectName: null, targetType: null, targetId: null })).toBe(
      'dana deleted the project 9f1c2d3e… (no longer exists)',
    );
  });

  it('says nothing about a project for an event that belongs to none', () => {
    const sentence = summarizeAuditEvent({
      ...base,
      action: 'POST /api/users',
      projectId: null,
      projectName: null,
      targetType: null,
      targetId: null,
      detail: { role: 'admin' },
    });
    expect(sentence).toBe('dana created an account (role: admin)');
  });

  it('names a machine actor as the credential it is', () => {
    expect(summarizeAuditEvent({ ...base, actorLabel: 'ADMIN_TOKEN' })).toBe('ADMIN_TOKEN deleted a source from handbook (source 5f2c0a1b…)');
  });

  /**
   * `src/auth/policy.ts` refuses to give an action a name somebody has to assign, because the next
   * route would not have one. This panel's phrase table is the other end of that argument and has to
   * fail soft: an action with no phrase still names the actor, the project and the target.
   */
  it('renders an action nobody has written a phrase for', () => {
    const sentence = summarizeAuditEvent({ ...base, action: 'POST /api/projects/:id/something-new', targetType: null, targetId: null });
    expect(sentence).toBe('dana ran POST /api/projects/:id/something-new on handbook');
    expect(summarizeAction('POST /api/projects/:id/something-new')).toBe('ran POST /api/projects/:id/something-new');
  });

  /**
   * The phrase table is keyed on `audit_events.action`, so a key that is not an action is a phrase
   * nobody will ever see — a typo, or a phrase written for one of the routes the policy layer exempts.
   * Read off the table itself and asked of `auditSubject()`, not of a list copied into this file: a
   * copy would agree with the table by construction and would catch neither.
   */
  it('has a phrase only for requests that are actually recorded', () => {
    expect(PHRASED_ACTIONS.length).toBeGreaterThan(20);
    for (const action of PHRASED_ACTIONS) {
      const [method, url] = action.split(' ');
      expect(AUDIT_EXEMPT_ROUTES.has(url), `${action} is exempt from the audit log, so this phrase is dead`).toBe(false);
      expect(auditSubject(method, url, {}, undefined), `${action} is not an audit event`).not.toBeNull();
      expect(summarizeAction(action).startsWith('ran '), `${action} falls back despite being in the table`).toBe(false);
    }
  });

  /** The handful the panel is most often read for; deleting one of these phrases is a failing test. */
  it('has a phrase for the acts the log exists to record', () => {
    for (const action of [
      'DELETE /api/projects/:id',
      'DELETE /api/projects/:id/sources/:sid',
      'PATCH /api/projects/:id/mcp-auth',
      'PUT /api/projects/:id/members/:userId',
      'POST /api/users',
      'PATCH /api/users/:id',
      'DELETE /api/users/:id',
    ]) {
      expect(PHRASED_ACTIONS, action).toContain(action);
    }
  });
});

/**
 * The date filter, which is the one an operator can be lied to by: `from` and `to` are UTC days, and a
 * range whose upper bound was the first instant of the day named would answer "nothing" for the most
 * common query there is — one day, typed into both boxes.
 */
describe('the day range', () => {
  it('is inclusive of the day typed into the second box', () => {
    const range = dayBounds('2026-09-19', '2026-09-19');
    expect(range.from?.toISOString()).toBe('2026-09-19T00:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('leaves an end open when only one box is filled', () => {
    expect(dayBounds('2026-09-01', undefined)).toEqual({ from: new Date('2026-09-01T00:00:00.000Z'), to: null });
    expect(dayBounds(undefined, undefined)).toEqual({ from: null, to: null });
  });

  it('refuses a date that is not one rather than silently widening the window', () => {
    expect(() => dayBounds('19-09-2026', undefined)).toThrow(ValidationError);
    expect(() => dayBounds(undefined, '2026-13-45')).toThrow(ValidationError);
  });
});

/**
 * Keyset paging, in the order `audit_events_created_idx` already holds. A cursor is a position and not
 * an offset, so a row recorded while somebody is paging cannot make a page repeat or skip one.
 */
describe('the page cursor', () => {
  const row = { createdAt: new Date('2026-09-19T08:30:00.000Z'), id: '5f2c0a1b-0000-4000-8000-000000000002' };

  it('round-trips the position of the last row handed out', () => {
    expect(decodeCursor(encodeCursor(row))).toEqual(row);
  });

  it('refuses anything it did not produce', () => {
    for (const bad of ['', 'nonsense', '~', 'not-a-date~5f2c0a1b', '2026-09-19T08:30:00.000Z~']) {
      expect(() => decodeCursor(bad), bad).toThrow(ValidationError);
    }
  });

  it('bounds one page, so no filter can ask for the whole table', () => {
    expect(MAX_PAGE_ROWS).toBeLessThanOrEqual(200);
  });
});
