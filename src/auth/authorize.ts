import { ForbiddenError, UnauthorizedError } from '../services/errors.js';
import { NotFoundError } from '../services/projects.js';
import { SAFE_METHODS, isSameSiteRequest } from './csrf.js';
import {
  METRICS_ROUTE,
  PASSWORD_CHANGE_ALLOWED,
  PUBLIC_ROUTES,
  isProjectScoped,
  requiredProjectAccess,
  requiredRole,
  roleAtLeast,
  satisfies,
} from './policy.js';
import type { Principal, ProjectAccess } from './types.js';

export interface RequestFacts {
  method: string;
  /** Fastify's route *template*, e.g. `/api/projects/:id/sources/:sid`. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  host: string;
  principal: Principal | null;
  /** Resolved only for project-scoped routes, and only after the checks that do not need it. */
  projectAccess?: ProjectAccess;
  /**
   * Whether this request carried `METRICS_TOKEN` as its bearer, already compared in constant time by
   * `src/auth/plugin.ts`. The answer travels here rather than the credential: this file holds no
   * secrets and compares nothing, which is what lets the whole decision be a unit test.
   */
  metricsTokenPresented?: boolean;
}

export interface AuthorizeEnv {
  allowedOrigins: readonly string[];
  /** Before the first account exists, "unauthorized" is the wrong thing to say. */
  needsSetup: boolean;
  hasAdminToken: boolean;
  /** `METRICS_PUBLIC=1` — the deployment says its network already decides who may scrape (ADR-0055). */
  metricsPublic?: boolean;
}

/**
 * Every check that does not need the database, in the order they must happen. Split out of
 * plugin.ts so the whole decision is a unit test: the plugin is then only "look up the session,
 * look up the membership, call this".
 *
 * Returns `'needs-project-access'` when the answer still depends on a membership the caller has to
 * fetch; `'ok'` when the request may proceed as it stands.
 */
export function checkRequest(facts: RequestFacts, env: AuthorizeEnv): 'ok' | 'needs-project-access' {
  if (PUBLIC_ROUTES.has(facts.url)) return 'ok';

  // `/metrics` ([ADR-0055](../../.ssot/ADR.md#adr-0055)). Two ways past the credential, both of them
  // something an operator had to write down, and neither of them the default: the instance declaring
  // that its network decides, or a dedicated scrape token that opens this route and nothing else.
  // Failing both it falls through to the ordinary rules below, where any signed-in account reads it —
  // there is no `requiredRole` row, because these numbers describe the process and not any project.
  if (facts.url === METRICS_ROUTE && (env.metricsPublic || facts.metricsTokenPresented)) return 'ok';

  const principal = facts.principal;
  if (!principal) {
    throw new UnauthorizedError(env.needsSetup && !env.hasAdminToken ? 'setup_required' : 'unauthorized');
  }

  // A bearer token is not an ambient credential, so it cannot be ridden by another site.
  if (principal.kind === 'session' && !SAFE_METHODS.has(facts.method) && !isSameSiteRequest(facts.headers, facts.host, env.allowedOrigins)) {
    throw new ForbiddenError('csrf_blocked', 'This request did not come from the dashboard');
  }

  if (principal.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(facts.url)) {
    throw new ForbiddenError('password_change_required', 'Choose a new password before using the dashboard');
  }

  const needRole = requiredRole(facts.method, facts.url);
  if (needRole && !roleAtLeast(principal.role, needRole)) throw new ForbiddenError();

  return isProjectScoped(facts.url) ? 'needs-project-access' : 'ok';
}

/**
 * The second half, once the membership is known. No access and "no such project" answer the same
 * 404, so project ids cannot be probed from outside.
 */
export function checkProjectAccess(method: string, url: string, access: ProjectAccess): void {
  if (access === 'none') throw new NotFoundError('Project not found');
  if (!satisfies(access, requiredProjectAccess(method, url))) throw new ForbiddenError();
}
