import { ForbiddenError, UnauthorizedError } from '../services/errors.js';
import { NotFoundError } from '../services/projects.js';
import { SAFE_METHODS, isSameSiteRequest } from './csrf.js';
import { PASSWORD_CHANGE_ALLOWED, PUBLIC_ROUTES, isProjectScoped, requiredProjectAccess, requiredRole, roleAtLeast, satisfies } from './policy.js';
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
}

export interface AuthorizeEnv {
  allowedOrigins: readonly string[];
  /** Before the first account exists, "unauthorized" is the wrong thing to say. */
  needsSetup: boolean;
  hasAdminToken: boolean;
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
