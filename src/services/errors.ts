/**
 * Errors the admin API's single error handler turns into status codes. The older domain errors
 * (ValidationError, NotFoundError, ConflictError) still live in services/projects.ts, which is
 * where the rest of the codebase imports them from.
 */

export class UnauthorizedError extends Error {
  /** Machine-readable reason: `unauthorized` or `setup_required`. */
  readonly code: string;
  constructor(code = 'unauthorized', message = 'Sign in to continue') {
    super(message);
    this.name = 'UnauthorizedError';
    this.code = code;
  }
}

export class ForbiddenError extends Error {
  /** `forbidden`, `csrf_blocked`, `password_change_required`, `account_disabled`, … */
  readonly code: string;
  constructor(code = 'forbidden', message = 'You do not have access to this') {
    super(message);
    this.name = 'ForbiddenError';
    this.code = code;
  }
}

export class RateLimitedError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message = 'Too many attempts; try again later') {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterSec));
  }
}
