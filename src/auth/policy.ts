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

/** root, admin and ADMIN_TOKEN reach every project; a member reaches the ones it is listed on. */
export function accessFromMembership(principal: Principal, membershipRole: 'viewer' | 'editor' | null): ProjectAccess {
  if (principal.kind === 'token' || principal.role === 'root' || principal.role === 'admin') return 'manager';
  return membershipRole ?? 'none';
}

export const canManageUsers = (principal: Principal): boolean => roleAtLeast(principal.role, 'admin');

/** Only a root account may create, change or delete another root account. */
export const canActOnRole = (principal: Principal, targetRole: UserRole): boolean => targetRole !== 'root' || principal.role === 'root';
