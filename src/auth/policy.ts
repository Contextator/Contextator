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
export const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/setup/status',
  '/api/setup',
  '/api/auth/login',
  // OIDC sign-in ([ADR-0077](../../.ssot/ADR.md#adr-0077), [ADR-0089](../../.ssot/ADR.md#adr-0089)):
  // the browser has no session yet when it asks for the redirect, and it is the browser again — sent
  // back by the identity provider's redirect, carrying the code — that requests the callback. The
  // callback authenticates that request by its short-lived flow cookie (state, nonce, PKCE verifier),
  // not by a Contextator session, so neither route can require one.
  '/api/auth/oidc/login',
  '/api/auth/oidc/callback',
]);

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
  // Reading the audit log ([ADR-0055](../../.ssot/ADR.md#adr-0055)). It is **not** a project route and
  // must not become one: the log records deleting a project, so its rows outlive the membership that
  // would otherwise decide, and there is nothing for a `member` to be a member of. What it holds is
  // also instance-wide by nature — who was given the root role, whose account was disabled, which
  // address an action came from — so it asks for the same standing user management does.
  if (url.startsWith('/api/audit')) return 'admin';
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
  // A project's own relevance floor. What an agent is told "no good match" instead of an answer is the
  // same class of decision as whether its questions are recorded — not a day-to-day editorial change.
  { method: 'PATCH', url: '/api/projects/:id/score-floor', need: 'manager' },
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

/**
 * Whether an [ADR-0076](../../.ssot/ADR.md#adr-0076) API token's scope covers this route.
 *
 * The scope is written in the same key space `audit_events.action` and this file's own route tables
 * already use — `<METHOD> <route template>` — so it is not a second permission vocabulary, only a
 * subset of the first: a scope entry that is not one of this file's own route strings matches nothing
 * and grants nothing. It never widens what the token's owner may already do; `checkRequest` applies it
 * on top of, never instead of, the ordinary role and membership checks below.
 */
export function apiTokenAllowsRoute(scope: readonly string[], method: string, url: string): boolean {
  return scope.includes(`${method} ${url}`);
}

// ---------------------------------------------------------------------------------------------
// The audit log ([ADR-0055](../../.ssot/ADR.md#adr-0055))
// ---------------------------------------------------------------------------------------------

/**
 * **Auditing is the default, and the exemptions are the list.** The opposite arrangement — a table of
 * routes that are recorded — is a table the next route is not in, which is the failure mode the
 * permission matrix above is already built the other way round to avoid: one rule keyed on the route
 * template, applied by one hook, covering routes it was written before.
 *
 * So every unsafe method under `/api/*` **or `/oauth/*`** is an audit event unless it is named here,
 * with its reason. The OAuth surface is in scope and not merely adjacent to it: approving a connector
 * is a person granting a client lasting read access to one project, which is the
 * `PATCH /api/projects/:id/mcp-auth` class of decision and the exact moment
 * [ADR-0054](../../.ssot/ADR.md#adr-0054)'s "a credential that names a person" is created.
 *
 * Each route named below changes something, and each is left out because the row would be noise or
 * could not be attributed:
 *
 * - `.../sources/:sid/test` — a connectivity check. It reaches the network and writes nothing; it is a
 *   `POST` because it carries a credential in a body, not because it changes anything.
 * - `.../uploads/:session/files` — staging, one request per file. Nothing the project serves changes
 *   until the commit, and the commit **is** audited; recording each file would bury the commit.
 * - the three `/api/webhooks/*` routes — **there is no actor at all.** A delivery is authenticated by a
 *   per-source HMAC and comes from a git host, Notion or Confluence; the run it queues is recorded in
 *   `index_runs.trigger`. They are registered outside `adminRoutes`, so this hook never sees one
 *   today, and they are named anyway: the day somebody moves them under it, the rule should already
 *   say what it thinks rather than start writing rows attributed to nobody.
 * - `/oauth/register` — RFC 7591 dynamic client registration, which is **unauthenticated by
 *   specification and confers nothing**: the row is a name and a set of redirect URIs, and every grant
 *   it can ever hold comes from a person approving one at `/oauth/authorize`, which *is* recorded.
 *   There is no actor to name, and a per-host budget already bounds the traffic.
 * - `/oauth/token` and `/oauth/revoke` — machine traffic on a grant a person already approved and this
 *   table already records. A connector refreshes on its own schedule, so an event per exchange would
 *   be a row every few minutes saying nothing that the approval did not already say; and the actor of
 *   a refresh is a credential rather than the person, which is the shape this table refuses to record.
 *   `mcp_tokens.last_used_at` is where "is this grant still in use" is answered.
 */
export const AUDIT_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  '/api/projects/:id/sources/:sid/test',
  '/api/projects/:id/sources/:sid/uploads/:session/files',
  '/api/webhooks/git/:sourceId',
  '/api/webhooks/notion/:sourceId',
  '/api/webhooks/confluence/:sourceId',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
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
  // Whether the person approved the connector or refused it. The whole substance of the event, and
  // the reason a refusal is recorded here where a refusal is recorded nowhere else in this table: a
  // `deny` is the person acting, not the permission matrix declining.
  { url: '/oauth/authorize', field: 'decision', values: ['approve', 'deny'] },
];

/**
 * Where the id of a **created** object is found in the response, per route.
 *
 * A creating route names nothing in its path — `POST /api/projects/:id/mcp-tokens` has only the
 * project — so the rule that reads the route template finds no target and the row would say *that* a
 * token was minted without saying *which*, which leaves "who minted this token" unanswerable and
 * uncorrelatable with the `DELETE .../mcp-tokens/:tokenId` that names one.
 *
 * So the id is read back out of the response, and **only through this table**: a route not named here
 * reads nothing, the path into the body is fixed rather than searched, and the value is kept only if
 * it is a UUID. Those three together are what stop this from becoming a way for a response body to
 * put text into `audit_events` — which is the property `AUDIT_DETAIL` above exists to protect.
 */
const AUDIT_CREATED: ReadonlyArray<{ method: string; url: string; type: string; path: readonly string[] }> = [
  { method: 'POST', url: '/api/projects', type: 'projectId', path: ['id'] },
  { method: 'POST', url: '/api/projects/import', type: 'projectId', path: ['projectId'] },
  { method: 'POST', url: '/api/projects/:id/sources', type: 'sid', path: ['id'] },
  { method: 'POST', url: '/api/projects/:id/mcp-tokens', type: 'tokenId', path: ['token', 'id'] },
  { method: 'POST', url: '/api/tokens', type: 'tokenId', path: ['token', 'id'] },
  { method: 'POST', url: '/api/users', type: 'userId', path: ['user', 'id'] },
  // The first account. `POST /api/setup` is the one request in this product that creates its own
  // actor, and the account it creates is both the target and the person the row names.
  { method: 'POST', url: '/api/setup', type: 'userId', path: ['user', 'id'] },
];

/** Version 4 UUID, the only shape `target_id` accepts from a response body. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The created object's id, from a response body this route is allowed to be read from. Pure, and
 * deliberately incapable of returning anything that is not a UUID.
 */
export function auditCreatedTarget(method: string, url: string, body: unknown): { type: string; id: string } | null {
  const rule = AUDIT_CREATED.find((r) => r.method === method && r.url === url);
  if (!rule) return null;
  let node: unknown = body;
  for (const key of rule.path) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' && UUID_RE.test(node) ? { type: rule.type, id: node } : null;
}

/** Whether this route's response is worth parsing at all — asked before the body is deserialised. */
export const auditReadsResponse = (method: string, url: string): boolean => AUDIT_CREATED.some((r) => r.method === method && r.url === url);

/**
 * One event's `detail`. Strings and booleans come from a request body through `AUDIT_DETAIL`; a number
 * is only ever a count a handler computed itself (`req.auditDetail`), never a value a caller sent.
 */
export type AuditDetail = Record<string, string | number | boolean>;

/** What the policy layer decided to record about one request; `null` when the request is not an event. */
export interface AuditSubject {
  /** `<METHOD> <route template>`, which is the whole identity of the action. */
  action: string;
  projectId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: AuditDetail;
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
  if (!url.startsWith('/api/') && !url.startsWith('/oauth/')) return null;
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
