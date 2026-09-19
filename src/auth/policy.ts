import { SAFE_METHODS } from './csrf.js';
import type { Principal, ProjectAccess, UserRole } from './types.js';

/**
 * Every authorization rule of the admin API, as data. No database, no Fastify: the whole matrix is
 * a unit test (test/permissions.test.ts), and src/auth/plugin.ts is the only thing that applies it.
 *
 * Route keys are Fastify's *templates* (`/api/projects/:id/sources/:sid`), which is what
 * `req.routeOptions.url` gives even inside nested plugins — that is how one hook covers them all.
 */

/** Reachable without any principal at all. */
export const PUBLIC_ROUTES = new Set(['/api/health', '/api/setup/status', '/api/setup', '/api/auth/login']);

/**
 * The Prometheus exposition ([ADR-0055](../../.ssot/ADR.md#adr-0055)). Not in `PUBLIC_ROUTES`, and
 * that is the decision: a scrape describes the instance — its version, its model, how many projects
 * are queued, how busy its pool is — and an unauthenticated description is a reconnaissance surface
 * on a port somebody may have exposed by accident.
 *
 * What it is instead is three answers, in `checkRequest`: `METRICS_PUBLIC=1` opens it for a
 * deployment whose network already guards it, `METRICS_TOKEN` is a dedicated scrape credential that
 * reaches this and nothing else, and failing both it falls through to the ordinary rule — any signed-in
 * account, including a `member`, and `ADMIN_TOKEN`. It needs no `requiredRole` row for that last part:
 * the numbers here say nothing about any one project's content.
 */
export const METRICS_ROUTE = '/metrics';

/** Still reachable while a temporary password is waiting to be replaced. */
export const PASSWORD_CHANGE_ALLOWED = new Set(['/api/health', '/api/auth/me', '/api/auth/password', '/api/auth/logout']);

const ROLE_RANK: Record<UserRole, number> = { member: 1, admin: 2, root: 3 };
const ACCESS_RANK: Record<ProjectAccess, number> = { none: 0, viewer: 1, editor: 2, manager: 3 };

export const roleAtLeast = (have: UserRole, need: UserRole): boolean => ROLE_RANK[have] >= ROLE_RANK[need];
export const satisfies = (have: ProjectAccess, need: ProjectAccess): boolean => ACCESS_RANK[have] >= ACCESS_RANK[need];

/** Routes that are not about one project: the instance role they need, or null for any account. */
export function requiredRole(method: string, url: string): UserRole | null {
  if (url.startsWith('/api/users')) return 'admin';
  // Creating and deleting a project is instance lifecycle: a new /mcp/<name> surface, disk, CPU.
  if (url === '/api/projects' && method === 'POST') return 'admin';
  // An import creates a project, so it is the same decision — and it is stated here rather than in
  // `PROJECT_ROUTE_OVERRIDES` because **there is no project to be a member of yet**
  // ([ADR-0051](../../.ssot/ADR.md#adr-0051)). It also writes into DATA_DIR from a file somebody
  // uploaded, which is a second reason and not the deciding one.
  if (url === '/api/projects/import' && method === 'POST') return 'admin';
  return null;
}

/** Per-project routes that need more than the default. */
const PROJECT_ROUTE_OVERRIDES: ReadonlyArray<{ method: string; url: string; need: ProjectAccess }> = [
  { method: 'DELETE', url: '/api/projects/:id', need: 'manager' },
  // Whether this project's documents are readable by anything that can reach the URL is the same
  // class of decision as creating the project in the first place, which is already admin-only.
  { method: 'PATCH', url: '/api/projects/:id/mcp-auth', need: 'manager' },
  { method: 'GET', url: '/api/projects/:id/members', need: 'viewer' },
  { method: 'PUT', url: '/api/projects/:id/members/:userId', need: 'manager' },
  { method: 'DELETE', url: '/api/projects/:id/members/:userId', need: 'manager' },
  // The query log ([ADR-0047](../../.ssot/ADR.md#adr-0047)). **Reading it is a `viewer`'s** and needs
  // no row here: the default below already says so, and it is the same access the search panel needs,
  // which is the panel these rows are of.
  //
  // Deciding whether this project records what agents ask, and throwing away what it has recorded, are
  // both `manager` — the same class of decision as `mcp-auth` directly above, and for the same reason:
  // one says whether the project's content is readable by anything that can reach a URL, the other
  // whether the project's *users* are recorded at all. Neither is a day-to-day editorial change.
  //
  // **These two routes do not exist yet**, and the rows are here anyway. The table is the decision and
  // the route is its application; a rule written when the column was added is a rule argued on its
  // merits, where one written the day somebody needs the endpoint is a rule chosen to unblock them.
  // `requiredProjectAccess` is a lookup — a row matching no route costs nothing and refuses nothing.
  { method: 'PATCH', url: '/api/projects/:id/query-log', need: 'manager' },
  { method: 'DELETE', url: '/api/projects/:id/query-log', need: 'manager' },
  // The project export ([ADR-0051](../../.ssot/ADR.md#adr-0051)). **A `GET`, and deliberately not a
  // viewer's.** A viewer can already read any one document, any excerpt and every source's settings
  // through the dashboard, which is the argument the `GET` default makes — and what the default cannot
  // see is that the entire corpus in one downloadable file is a different act from reading a page of
  // it. It is the `mcp-auth` class of decision: who may have this project's content, and where.
  { method: 'GET', url: '/api/projects/:id/export', need: 'manager' },
];

/**
 * The default — read is `viewer`, anything else is `editor` — covers every source and upload route
 * without listing them, so a new one is protected the moment it is registered.
 */
export function requiredProjectAccess(method: string, url: string): ProjectAccess {
  const override = PROJECT_ROUTE_OVERRIDES.find((r) => r.method === method && r.url === url);
  if (override) return override.need;
  return method === 'GET' || method === 'HEAD' ? 'viewer' : 'editor';
}

export const isProjectScoped = (url: string): boolean => url.startsWith('/api/projects/:id');

/**
 * What an account-backed credential must hold on a project to read it over `/mcp/*`
 * ([ADR-0054](../../.ssot/ADR.md#adr-0054)).
 *
 * **It is stated here rather than derived**, and that is the point. `requiredProjectAccess` reads the
 * method: every MCP request is a `POST`, so the default would have asked for `editor` and locked every
 * `viewer` out of the surface that exists for reading — the derivation is right about a REST API whose
 * method says what it does, and wrong about a JSON-RPC transport where the method says nothing. A
 * `viewer` is the access that reads a project's documents in the dashboard, and the three MCP tools are
 * the same reading through another door.
 *
 * It is a constant and not a row in `PROJECT_ROUTE_OVERRIDES` because `/mcp/:project` is not in that
 * table's key space: those keys are `/api/*` route templates, and adding one shaped differently would
 * make the table mean two things.
 */
export const MCP_READ_ACCESS: ProjectAccess = 'viewer';

/** root, admin and ADMIN_TOKEN reach every project; a member reaches the ones it is listed on. */
export function accessFromMembership(principal: Principal, membershipRole: 'viewer' | 'editor' | null): ProjectAccess {
  if (principal.kind === 'token' || principal.role === 'root' || principal.role === 'admin') return 'manager';
  return membershipRole ?? 'none';
}

export const canManageUsers = (principal: Principal): boolean => roleAtLeast(principal.role, 'admin');

/** Only a root account may create, change or delete another root account. */
export const canActOnRole = (principal: Principal, targetRole: UserRole): boolean => targetRole !== 'root' || principal.role === 'root';

// ---------------------------------------------------------------------------------------------
// The audit log ([ADR-0055](../../.ssot/ADR.md#adr-0055))
// ---------------------------------------------------------------------------------------------

/**
 * **Auditing is the default, and the exemptions are the list.** The opposite arrangement — a table of
 * routes that are recorded — is a table the next route is not in, which is the failure mode the
 * permission matrix above is already built the other way round to avoid: one rule keyed on the route
 * template, applied by one hook, covering routes it was written before.
 *
 * So every unsafe method under `/api/*` is an audit event unless it is named here, with its reason.
 * Each of these changes something, and each is left out because the row would be noise or could not
 * be attributed:
 *
 * - `/api/setup` — **there is no actor yet.** It runs without a principal, and the row it could write
 *   would say "somebody holding the setup code". The account it creates is the record, and
 *   `src/server.ts` logs the moment as well.
 * - `/api/auth/login` — public, so the principal is resolved *by* it rather than before it. Sign-ins
 *   are recorded where they already were: `users.last_login_at`, `users.failed_login_count`, and a
 *   `warn` line per failure.
 * - `.../sources/:sid/test` — a connectivity check. It reaches the network and writes nothing; it is a
 *   `POST` because it carries a credential in a body, not because it changes anything.
 * - `.../uploads/:session/files` — staging, one request per file. Nothing the project serves changes
 *   until the commit, and the commit **is** audited; recording each file would bury the commit.
 * - the two `/api/webhooks/*` routes — **there is no actor at all.** A delivery is authenticated by a
 *   per-source HMAC and comes from a git host or Notion; the run it queues is recorded in
 *   `index_runs.trigger`. They are registered outside `adminRoutes`, so this hook never sees one
 *   today, and they are named anyway: the day somebody moves them under it, the rule should already
 *   say what it thinks rather than start writing rows attributed to nobody.
 */
export const AUDIT_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  '/api/setup',
  '/api/auth/login',
  '/api/projects/:id/sources/:sid/test',
  '/api/projects/:id/sources/:sid/uploads/:session/files',
  '/api/webhooks/git/:sourceId',
  '/api/webhooks/notion/:sourceId',
]);

/**
 * The only body fields any action may record, and the closed set of values each may hold.
 *
 * **This is what keeps user content out of `audit_events` by construction** rather than by review: a
 * field that is not named here never reaches the row, and a value outside its set is dropped even if
 * the field is. There is no shape of request body that can put free text into the table, so the
 * privacy page's separation between "what was done" and "what was read" cannot be eroded by a route
 * added later — the worst a new route can do is record nothing.
 */
const AUDIT_DETAIL: ReadonlyArray<{ url: string; field: string; values: readonly string[] }> = [
  // Which way the MCP endpoint was switched. Without it the row says the door was changed and not
  // which way, which is the one fact somebody reading this event actually wants.
  { url: '/api/projects/:id/mcp-auth', field: 'mode', values: ['open', 'token', 'account'] },
  // Whether this project still records what agents ask ([ADR-0047](../../.ssot/ADR.md#adr-0047)).
  // Booleans are stated as strings here so the set stays one kind of thing; the row keeps the boolean.
  { url: '/api/projects/:id/query-log', field: 'enabled', values: ['true', 'false'] },
  // A role granted or changed on a project, and an instance role granted to an account. Both are the
  // substance of the event rather than a detail of it.
  { url: '/api/projects/:id/members/:userId', field: 'role', values: ['viewer', 'editor'] },
  { url: '/api/users', field: 'role', values: ['root', 'admin', 'member'] },
  { url: '/api/users/:id', field: 'role', values: ['root', 'admin', 'member'] },
];

/** What the policy layer decided to record about one request; `null` when the request is not an event. */
export interface AuditSubject {
  /** `<METHOD> <route template>`, which is the whole identity of the action. */
  action: string;
  projectId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, string | boolean>;
}

/** Path parameters as Fastify resolved them. Values are strings; anything else is ignored. */
export type RouteParams = Record<string, unknown>;

/**
 * The name of the thing an action was performed on, for a route that names one.
 *
 * `:id` is the project on a project-scoped route and is reported as the project rather than twice, so
 * what is left is the route's own second parameter — `:sid`, `:tokenId`, `:userId`, `:session`. The
 * *name* is kept as the type because it is the route template's own word for it, which is the key
 * space `action` is already written in; inventing a prettier one would mean a lookup table that the
 * next route is missing from.
 */
function auditTarget(url: string, params: RouteParams): { type: string; id: string } | null {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const candidates = isProjectScoped(url) ? names.filter((name) => name !== 'id') : names;
  const name = candidates.at(-1);
  if (!name) return null;
  const value = params[name];
  return typeof value === 'string' && value.length > 0 ? { type: name, id: value } : null;
}

/** The allowlisted fields of one route, taken from a body that may be anything at all. */
function auditDetail(url: string, body: unknown): Record<string, string | boolean> {
  const rules = AUDIT_DETAIL.filter((rule) => rule.url === url);
  if (rules.length === 0 || typeof body !== 'object' || body === null) return {};
  const source = body as Record<string, unknown>;
  const detail: Record<string, string | boolean> = {};
  for (const rule of rules) {
    const raw = source[rule.field];
    // A boolean is stated as a string in the rule and kept as a boolean in the row: the closed set is
    // about what may be written, and `"true"` there would make the column two types.
    const asText = typeof raw === 'boolean' ? String(raw) : typeof raw === 'string' ? raw : undefined;
    if (asText !== undefined && rule.values.includes(asText)) detail[rule.field] = raw as string | boolean;
  }
  return detail;
}

/**
 * Whether this request is an audit event, and what the row says about it — **derived from the route
 * template and the path, and from the body only through `AUDIT_DETAIL` above.**
 *
 * Pure, so the whole of "what gets recorded" is a unit test in the same file as the permission matrix.
 * `src/auth/plugin.ts` adds the actor, the address and the status, and is the only thing that writes.
 */
export function auditSubject(method: string, url: string, params: RouteParams, body: unknown): AuditSubject | null {
  if (SAFE_METHODS.has(method)) return null;
  if (!url.startsWith('/api/')) return null;
  if (AUDIT_EXEMPT_ROUTES.has(url)) return null;
  const target = auditTarget(url, params);
  const projectId = isProjectScoped(url) && typeof params.id === 'string' ? params.id : null;
  return {
    action: `${method} ${url}`,
    projectId,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    detail: auditDetail(url, body),
  };
}
