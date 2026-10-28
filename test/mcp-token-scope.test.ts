import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { CreateBody, UpdateSourcesBody } from '../src/admin/mcp-routes.js';
import type { ProjectRow } from '../src/db/schema.js';
import { registerResources } from '../src/mcp/resources.js';
import { EMPTY_SCOPE_MESSAGE, MCP_TOOL_NAMES, registerTools, sourceScopeOf, type ToolContext } from '../src/mcp/tools.js';
import { isSourceForeignKeyViolation, toMcpTokenView } from '../src/services/auth/mcp-tokens.js';
import { withinSourceScope } from '../src/services/source-scope.js';
import { RESOURCE_METHOD_SCOPE, TOOL_SCOPE } from './support/token-scope-inventory.js';

/**
 * A static token's source scope ([ADR-0133](../.ssot/ADR.md#adr-0133)), the parts that need no database:
 * how the scope is read off a call, what an empty one is, the request bodies, the view, and the guard that
 * keeps the inventory of read paths equal to the paths there are. What the scope *filters* is proved against
 * PostgreSQL in `test/integration/token-scope.itest.ts`.
 */

const auth = (extra: Record<string, unknown> | undefined) => ({ token: 't', clientId: 'c', scopes: [], ...(extra ? { extra } : {}) });

describe('sourceScopeOf', () => {
  it('is null for a call that carries no scope, which is every unscoped token and every request with no credential', () => {
    expect(sourceScopeOf(undefined)).toBeNull();
    expect(sourceScopeOf(auth(undefined))).toBeNull();
    expect(sourceScopeOf(auth({ tokenId: 'x' }))).toBeNull();
    expect(sourceScopeOf(auth({ tokenId: 'x', sourceScope: null }))).toBeNull();
  });

  it('is the list the router wrote, and an empty list stays empty: it is not "no scope"', () => {
    expect(sourceScopeOf(auth({ sourceScope: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(sourceScopeOf(auth({ sourceScope: [] }))).toEqual([]);
  });

  it('fails closed on a scope it cannot read: a scope that holds nothing, never the whole project', () => {
    for (const bad of ['a', 7, {}, [1], ['a', null], true]) expect(sourceScopeOf(auth({ sourceScope: bad }))).toEqual([]);
  });
});

describe('withinSourceScope', () => {
  it('leaves the predicate out for no scope and writes one for every scope, an empty one included', () => {
    const column = { name: 'source_id' } as never;
    expect(withinSourceScope(column, undefined)).toBeUndefined();
    expect(withinSourceScope(column, null)).toBeUndefined();
    expect(withinSourceScope(column, [])).toBeDefined();
    expect(withinSourceScope(column, ['a'])).toBeDefined();
  });
});

describe('EMPTY_SCOPE_MESSAGE', () => {
  it('says only what is true of the token itself', () => {
    expect(EMPTY_SCOPE_MESSAGE).toBe("This token is limited to sources that no longer exist; ask the project's operator for a new token.");
  });
});

describe('the request bodies', () => {
  it('leaves `sources` out of a body that does not carry it, so a caller from before this field parses as it did', () => {
    expect(CreateBody.parse({})).toEqual({ name: '', expiresInDays: null, allowedCidrs: null });
    expect(CreateBody.parse({}).sources).toBeUndefined();
  });

  it('keeps `[]`, `null` and a list apart: the route refuses the first, reads the second as whole-project, and passes the third', () => {
    expect(CreateBody.parse({ sources: [] }).sources).toEqual([]);
    expect(CreateBody.parse({ sources: null }).sources).toBeNull();
    expect(CreateBody.parse({ sources: ['handbook'] }).sources).toEqual(['handbook']);
    expect(UpdateSourcesBody.parse({ sources: null }).sources).toBeNull();
    expect(UpdateSourcesBody.parse({ sources: [] }).sources).toEqual([]);
  });

  it('refuses a body that is not a list of names, and a PATCH that names nothing at all', () => {
    expect(CreateBody.safeParse({ sources: 'handbook' }).success).toBe(false);
    expect(CreateBody.safeParse({ sources: [''] }).success).toBe(false);
    expect(CreateBody.safeParse({ sources: [1] }).success).toBe(false);
    expect(UpdateSourcesBody.safeParse({}).success).toBe(false);
  });
});

describe('toMcpTokenView', () => {
  const row = { id: 'i', name: 'n', prefix: 'ctxm_x…', createdAt: new Date(0), lastUsedAt: null, expiresAt: null, allowedCidrs: null } as never;

  it('an unscoped token has `sources: null` and is not empty', () => {
    expect(toMcpTokenView({ ...(row as object), sourceScoped: false } as never)).toMatchObject({ sources: null, scopeEmpty: false });
  });

  it('a scoped token lists its names', () => {
    expect(toMcpTokenView({ ...(row as object), sourceScoped: true } as never, ['a', 'b'])).toMatchObject({ sources: ['a', 'b'], scopeEmpty: false });
  });

  it('a scoped token with no names left is an empty scope, flagged, and never `null`', () => {
    expect(toMcpTokenView({ ...(row as object), sourceScoped: true } as never)).toMatchObject({ sources: [], scopeEmpty: true });
    expect(toMcpTokenView({ ...(row as object), sourceScoped: true } as never, [])).toMatchObject({ sources: [], scopeEmpty: true });
  });
});

describe('the inventory of read paths', () => {
  it('names every tool registerTools registers, and no other', () => {
    expect(Object.keys(TOOL_SCOPE).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('names every resource method registerResources handles, and no other', () => {
    const methods: string[] = [];
    const server = {
      server: {
        registerCapabilities: () => {},
        setRequestHandler: (method: string) => {
          methods.push(method);
        },
      },
    };
    registerResources(server as unknown as McpServer, { db: {} as never, log: {} as never }, { name: 'handbook' } as ProjectRow);
    expect(Object.keys(RESOURCE_METHOD_SCOPE).sort()).toEqual(methods.sort());
  });

  it('registers the same tools with a scope as without one: a scope narrows what they read, not which exist', () => {
    const names = (scope: string[] | null): string[] => {
      const out: string[] = [];
      const server = { registerTool: (name: string) => void out.push(name) };
      registerTools(
        server as unknown as McpServer,
        { config: { MCP_STRUCTURED_OUTPUT: false }, queryLog: {} } as unknown as ToolContext,
        { name: 'handbook', queryLogEnabled: true } as ProjectRow,
        null,
        'legacy',
        scope,
      );
      return out.sort();
    };
    expect(names(['a'])).toEqual(names(null));
  });

  it('gives every entry that does not apply a reason', () => {
    for (const table of [TOOL_SCOPE, RESOURCE_METHOD_SCOPE]) {
      for (const [name, disposition] of Object.entries(table)) {
        if (!disposition.applies) expect(disposition.reason.length, name).toBeGreaterThan(10);
      }
    }
  });
});

describe('isSourceForeignKeyViolation', () => {
  const violation = (constraint: string) => Object.assign(new Error('insert violates foreign key'), { code: '23503', constraint });

  it('is true for the source foreign key, at the error or behind the driver wrapper that carries it as `cause`', () => {
    expect(isSourceForeignKeyViolation(violation('mcp_token_sources_source_id_fkey'))).toBe(true);
    expect(isSourceForeignKeyViolation(Object.assign(new Error('Failed query'), { cause: violation('mcp_token_sources_source_id_fkey') }))).toBe(
      true,
    );
  });

  it('is false for any other foreign key, which is a project or an account deleted mid-request, and for other errors', () => {
    expect(isSourceForeignKeyViolation(violation('mcp_tokens_project_id_fkey'))).toBe(false);
    expect(isSourceForeignKeyViolation(violation('mcp_tokens_created_by_fkey'))).toBe(false);
    expect(isSourceForeignKeyViolation(violation('mcp_token_sources_token_id_fkey'))).toBe(false);
    expect(isSourceForeignKeyViolation(Object.assign(new Error('x'), { code: '23505', constraint: 'mcp_token_sources_source_id_fkey' }))).toBe(false);
    expect(isSourceForeignKeyViolation(new Error('x'))).toBe(false);
    expect(isSourceForeignKeyViolation(undefined)).toBe(false);
  });
});
