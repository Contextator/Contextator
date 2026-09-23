import type { UserRole } from '../db/schema.js';

export type { ProjectMemberRole, UserRole } from '../db/schema.js';

/** How far a principal reaches into one project. `manager` is the project's lifecycle, not its content. */
export type ProjectAccess = 'none' | 'viewer' | 'editor' | 'manager';

/**
 * Who is making the request. `token` is ADMIN_TOKEN — machine access with root permissions, kept
 * so scripts and CI that predate accounts keep working. `apiToken` is an
 * [ADR-0076](../../.ssot/ADR.md#adr-0076) credential: machine access that, unlike ADMIN_TOKEN, names
 * an account, a scope and — optionally — a single project, and can be revoked on its own.
 */
export type Principal =
  | { kind: 'token'; role: 'root'; userId: null; username: string; mustChangePassword: false }
  | { kind: 'session'; role: UserRole; userId: string; username: string; sessionId: string; mustChangePassword: boolean }
  | {
      kind: 'apiToken';
      /** The owning account's role, looked up fresh on every request — never the value at mint time. */
      role: UserRole;
      /** The owning account's id. `resolveProjectAccess` and `accessFromMembership` key off this. */
      userId: string;
      /** `"<token name> · <owner's username>"`, so an audit row names both without a schema change. */
      username: string;
      tokenId: string;
      /** Route templates this token may call, `<METHOD> <url>`, the same key space `policy.ts` uses. */
      scope: readonly string[];
      /** The single project this token is restricted to, or `null` for every project the owner reaches. */
      projectId: string | null;
      mustChangePassword: boolean;
    };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    projectAccess: ProjectAccess | null;
    /**
     * Who the audit row should name, for a surface where `principal` is not the answer
     * ([ADR-0055](../../.ssot/ADR.md#adr-0055)).
     *
     * Two uses, and both are a request whose identity is only settled inside the handler: the OAuth
     * approval page, which resolves its own session cookie and is registered outside the admin
     * plugin's hooks, and the two routes that *create* the account they then act as — sign-in and
     * first-run setup. It is deliberately a field the handler fills rather than a `recordAudit(…)`
     * call it makes: what the handler knows is who this turned out to be, and the writing stays in
     * one place.
     */
    auditActor?: Principal | null;
    /** The project an event is about when the route template does not carry one (`/oauth/authorize`). */
    auditProjectId?: string | null;
    /** The created object's id, read back from the response by the audit hook's own allowlist. */
    auditTarget?: { type: string; id: string } | null;
  }
}
