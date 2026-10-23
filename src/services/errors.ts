/**
 * Errors the admin API's single error handler turns into status codes. The older domain errors
 * (ValidationError, NotFoundError, ConflictError) still live in services/projects.ts, which is
 * where the rest of the codebase imports them from.
 */

export class UnauthorizedError extends Error {
  /** Machine-readable reason: `unauthorized`, `setup_required`, `invalid_credentials` or `session_revoked`. */
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

/**
 * A project the caller may read that cannot answer a search right now. `409` rather than an empty
 * result set, because "nothing is indexed" and "indexed with a model this server no longer runs"
 * have different remedies and neither is "your query was bad". Kept apart from `ConflictError`'s
 * generic `conflict` so a script can tell the three apart.
 */
export class SearchUnavailableError extends Error {
  /** `not_indexed` or `model_mismatch`. */
  readonly code: string;
  constructor(code: 'not_indexed' | 'model_mismatch', message: string) {
    super(message);
    this.name = 'SearchUnavailableError';
    this.code = code;
  }
}

/**
 * A role change that would hand `root` to an account with a live SSO identity ([ADR-0077], tur 6
 * addendum: root must stay provable-local, and every promotion goes through `updateUser` so this is
 * the one place that needs to say so). `409` rather than `403`: the request is well formed and the
 * caller may otherwise grant this role, it is *this particular target* that cannot receive it right
 * now — unlinking its SSO identity first is the remedy. Kept apart from `ConflictError`'s generic
 * `conflict` so a caller can tell "you are the last root" apart from "unlink SSO first".
 */
export class PromotionRefusedError extends Error {
  readonly code: string;
  constructor(code: 'root_requires_unlink', message: string) {
    super(message);
    this.name = 'PromotionRefusedError';
    this.code = code;
  }
}

/** The three per-project quotas ([ADR-0117](../../.ssot/ADR.md#adr-0117)), named as the `quota` field of a refusal carries them. */
export type QuotaName = 'max_documents' | 'max_chunks' | 'max_upload_bytes';

const QUOTA_UNITS: Record<QuotaName, string> = { max_documents: 'documents', max_chunks: 'chunks', max_upload_bytes: 'bytes of uploads' };

/**
 * A project asked to hold more than its quota allows ([ADR-0117](../../.ssot/ADR.md#adr-0117)).
 *
 * One class for the three quotas, because what a caller does with it is the same: an upload request maps it
 * to `413` and the indexer ends the run with `errorCode: 'quota_exceeded'`. `limit` is the effective value
 * (the project's own or the instance's), `used` what the project holds before the refused work, and
 * `requested` how much that work wanted to add, so a message and a script can both say by how much.
 * The numbers travel as fields and not only in the text, for the same reason `InsufficientDiskError`'s do.
 */
export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded';
  constructor(
    readonly quota: QuotaName,
    readonly limit: number,
    readonly used: number,
    readonly requested: number,
  ) {
    super(
      `This project would go over its limit of ${limit} ${QUOTA_UNITS[quota]} (${used} used, ${requested} more requested). ` +
        'Ask an instance administrator to raise the limit, or remove content first.',
    );
    this.name = 'QuotaExceededError';
  }
}

/**
 * The bytes a project stores for its uploads could not be measured (the directory scan failed for a reason
 * other than "there is nothing there"). `503` and not a pass: a quota is a limit, and a usage nobody could
 * read is not "under the limit" ([ADR-0117](../../.ssot/ADR.md#adr-0117)).
 */
export class QuotaUsageUnavailableError extends Error {
  readonly code = 'quota_usage_unavailable';
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super('The storage used by this project could not be measured, so the upload quota cannot be checked. Try again shortly.', { cause });
    this.name = 'QuotaUsageUnavailableError';
  }
}
