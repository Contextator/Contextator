import { describe, expect, it } from 'vitest';
import { buildAuditRow } from '../src/services/audit.js';
import { auditSubject } from '../src/auth/policy.js';
import type { Principal } from '../src/auth/types.js';

/**
 * The row an audit event becomes ([ADR-0055](../.ssot/ADR.md#adr-0055)), with no database in it.
 *
 * `test/permissions.test.ts` covers the other half — which requests are events at all, and what may
 * reach `detail`. What is asserted here is the part that has to be true of *every* row: it names an
 * actor, it names them in a way that survives the account being deleted, and the address beside them
 * is a hint rather than the identity.
 */

const session: Principal = {
  kind: 'session',
  role: 'admin',
  userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  username: 'dana',
  sessionId: 's-1',
  mustChangePassword: false,
};
const machine: Principal = { kind: 'token', role: 'root', userId: null, username: 'ADMIN_TOKEN', mustChangePassword: false };
const apiToken: Principal = {
  kind: 'apiToken',
  role: 'admin',
  userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  username: 'deploy · dana',
  tokenId: 't-1',
  scope: ['POST /api/projects/:id/reindex'],
  projectId: null,
  mustChangePassword: false,
};

const subjectOf = (method: string, url: string, params: Record<string, unknown> = {}, body?: unknown) => {
  const subject = auditSubject(method, url, params, body);
  if (!subject) throw new Error(`${method} ${url} is not an audit event; the test means it to be one.`);
  return subject;
};

describe('the row an audit event becomes', () => {
  it('names the account that acted, by id and by the label that outlives it', () => {
    const row = buildAuditRow(subjectOf('DELETE', '/api/projects/:id/sources/:sid', { id: 'p-1', sid: 's-9' }), {
      principal: session,
      ip: '10.0.0.4',
      statusCode: 204,
    });
    expect(row.actorKind).toBe('user');
    expect(row.actorUserId).toBe(session.userId);
    // The username is copied, not joined to. `audit_events_actor_user_id_fkey` is `ON DELETE SET
    // NULL`, so this column is the only thing that still says who did it once the account is gone.
    expect(row.actorLabel).toBe('dana');
    expect(row.action).toBe('DELETE /api/projects/:id/sources/:sid');
    expect(row.projectId).toBe('p-1');
    expect(row.targetId).toBe('s-9');
    expect(row.statusCode).toBe(204);
  });

  it('records ADMIN_TOKEN as machine access rather than as a person nobody can name', () => {
    const row = buildAuditRow(subjectOf('POST', '/api/projects/:id/mcp-tokens', { id: 'p-1' }), {
      principal: machine,
      ip: null,
      statusCode: 201,
    });
    expect(row.actorKind).toBe('token');
    // Not merely absent: `audit_events_actor_user_check` refuses a `token` row that carries an
    // account id, so this being null is the constraint's precondition and not a convenience.
    expect(row.actorUserId).toBeNull();
    expect(row.actorLabel).toBe('ADMIN_TOKEN');
  });

  it('records an ADR-0076 API token as api_token, naming the account behind it', () => {
    const row = buildAuditRow(subjectOf('POST', '/api/projects/:id/reindex', { id: 'p-1' }), {
      principal: apiToken,
      ip: '10.0.0.5',
      statusCode: 202,
    });
    // Unlike `machine` above, this *does* name somebody: the owning account's id and the
    // `"<token name> · <owner>"` label survive even though the request carried a token, not a
    // session — the reviewer's M4 mutation (`actorKind` always `'user'`) must turn this red.
    expect(row.actorKind).toBe('api_token');
    expect(row.actorUserId).toBe(apiToken.userId);
    expect(row.actorLabel).toBe('deploy · dana');
  });

  it('names the acting API token by its id in detail, beside what the request itself recorded', () => {
    const subject = subjectOf('PATCH', '/api/projects/:id/mcp-auth', { id: 'p-1' }, { mode: 'token' });
    const row = buildAuditRow(subject, { principal: apiToken, ip: null, statusCode: 200 });
    // The label cannot tell two tokens of one owner that share a name apart; the id can. It comes from
    // the principal, which is what `verifyApiToken` resolved, and is added to — not in place of — the
    // body's own allowlisted fields.
    expect(row.detail).toEqual({ ...subject.detail, tokenId: 't-1' });
    expect(row.detail).toMatchObject({ mode: 'token' });

    for (const principal of [session, machine]) {
      const other = buildAuditRow(subject, { principal, ip: null, statusCode: 200 });
      expect(other.detail).toEqual(subject.detail);
      expect(other.detail).not.toHaveProperty('tokenId');
    }
  });

  /**
   * **There is no shape of input that produces an unattributed row.** `AuditContext.principal` is not
   * optional, so a caller cannot leave the actor out; the label is derived from it rather than passed
   * beside it, so a caller cannot pass an empty one either. The database says the same thing again in
   * `audit_events_actor_label_check`, which `test/integration/audit.itest.ts` exercises against a real
   * server — two statements of one rule, because this is the rule the table exists for.
   */
  it('always produces a non-empty actor label', () => {
    for (const principal of [session, machine, apiToken]) {
      const row = buildAuditRow(subjectOf('POST', '/api/projects/:id/reindex', { id: 'p-1' }), { principal, ip: null, statusCode: 202 });
      expect(row.actorLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the address beside the actor and out of the actor columns', () => {
    const withIp = buildAuditRow(subjectOf('POST', '/api/projects/:id/reindex', { id: 'p-1' }), {
      principal: session,
      // Whatever `req.ip` was — which is `TRUST_PROXY`'s answer ([ADR-0060](../.ssot/ADR.md#adr-0060))
      // and, at `1` on a directly reachable instance, a value the client writes. So it is stored, and
      // it is never what identifies the actor. `SECURITY.md` says so as a known limit.
      ip: '203.0.113.9',
      statusCode: 202,
    });
    expect(withIp.actorIp).toBe('203.0.113.9');
    expect(withIp.actorLabel).toBe('dana');

    const withoutIp = buildAuditRow(subjectOf('POST', '/api/projects/:id/reindex', { id: 'p-1' }), {
      principal: session,
      ip: null,
      statusCode: 202,
    });
    // An absent address changes nothing about who acted, which is the property that makes it a hint.
    expect(withoutIp.actorIp).toBeNull();
    expect(withoutIp.actorLabel).toBe('dana');
  });

  it('bounds every text column it writes, so no caller can hand the table an essay', () => {
    const long = 'x'.repeat(5_000);
    const row = buildAuditRow(subjectOf('POST', '/api/projects/:id/reindex', { id: 'p-1' }), {
      principal: { ...session, username: long },
      ip: long,
      statusCode: 202,
    });
    expect(row.actorLabel.length).toBeLessThanOrEqual(200);
    expect(row.actorIp?.length).toBeLessThanOrEqual(64);
  });
});
