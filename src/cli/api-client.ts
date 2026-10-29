/**
 * The `contextator` command's view of the admin API ([ADR-0131](../../.ssot/ADR.md#adr-0131)).
 *
 * This file, `commands.ts` and `main.ts` import nothing that reads the server's environment, and in
 * particular not `src/config.ts`: the command runs on a machine that has none of the server's settings,
 * and a validation failure about a variable it never uses must not stop it. Only the Node standard
 * library and `fetch` are used, so the command adds no dependency.
 */

/** The exit codes of ADR-0131 decision 6. */
export const EXIT = {
  ok: 0,
  /** Unexpected failure, or a server error. */
  failure: 1,
  /** Usage: an argument or a required variable is wrong or missing. */
  usage: 2,
  /** `401` / `403`. */
  auth: 3,
  /** `404` / `409`. */
  notFound: 4,
  /** The awaited index run ended in `error`. */
  runFailed: 5,
  /** `--wait` ran out of time. */
  timeout: 6,
  /** The server could not be reached. */
  unreachable: 7,
} as const;

/** A failure the command reports on stderr and turns into an exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    /** True for a failure that a retry can outlast (the server restarting, a gateway timing out). */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiClientOptions {
  /** Origin plus an optional path prefix, without a trailing slash. */
  baseUrl: string;
  /** An API token or `ADMIN_TOKEN`. Sent as a bearer credential and never written anywhere. */
  token: string;
  fetch: typeof fetch;
  /** Per request unless a call passes its own; `--wait` passes what is left of `--timeout`, so a hung connection cannot outlast it. */
  requestTimeoutMs?: number;
}

/** The longest one request may take unless the caller allows less. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The admin API's error body: `{ error, message }`, and for a validation failure also `issues`. */
interface ErrorBody {
  error?: unknown;
  message?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What the server said, in one line. The body is the server's own words and carries no credential of ours. */
const serverMessage = (payload: unknown, fallback: string): string => {
  if (isRecord(payload)) {
    const body = payload as ErrorBody;
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.error === 'string' && body.error) return body.error;
  }
  return fallback;
};

/** Maps an HTTP status to the exit code ADR-0131 gives it. Other `4xx` are the server refusing the request: `1`. */
export const exitCodeForStatus = (status: number): number => {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404 || status === 409) return EXIT.notFound;
  return EXIT.failure;
};

const describeNetworkError = (err: unknown): string => {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (isRecord(cause)) {
      const code = typeof cause.code === 'string' ? cause.code : '';
      const message = typeof cause.message === 'string' ? cause.message : '';
      // `getaddrinfo ENOTFOUND host` already names the code; say it once.
      return (code && message.includes(code) ? message : [code, message].filter(Boolean).join(': ')) || err.message;
    }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'the request timed out';
    return err.message;
  }
  return String(err);
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.doFetch = options.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * One admin API call, answered with the parsed body. A refusal becomes a {@link CliError} carrying the
   * exit code of its status. Redirects are not followed: a credential belongs to the origin it was
   * configured for, and a redirect means `CONTEXTATOR_URL` names the wrong one.
   */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, options.timeoutMs ?? this.requestTimeoutMs)),
      });
    } catch (err) {
      throw new CliError(`could not reach ${this.baseUrl}: ${describeNetworkError(err)}`, EXIT.unreachable, true);
    }
    const text = await response.text().catch(() => '');
    const payload = parseJson(text);
    if (response.status >= 300 && response.status < 400) {
      const where = response.headers.get('location');
      throw new CliError(
        `the server answered ${response.status} and redirected${where ? ` to ${where}` : ''}; set CONTEXTATOR_URL to the address it redirects to`,
        EXIT.failure,
      );
    }
    if (!response.ok) {
      const transient = response.status === 502 || response.status === 503 || response.status === 504;
      throw new CliError(
        `${method} ${path}: ${response.status} ${serverMessage(payload, response.statusText || 'request failed')}`,
        exitCodeForStatus(response.status),
        transient,
      );
    }
    if (payload === undefined)
      throw new CliError(`${method} ${path}: the server answered ${response.status} with a body that is not JSON`, EXIT.failure);
    return payload as T;
  }

  /**
   * `GET /api/health`, which needs no credential. It answers `503` with the same body while the database
   * is down, and that body still names the version, so a `503` is read rather than refused.
   */
  async health(): Promise<{ version: string | null }> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/api/health`, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new CliError(`could not reach ${this.baseUrl}: ${describeNetworkError(err)}`, EXIT.unreachable, true);
    }
    const payload = parseJson(await response.text().catch(() => ''));
    const version = isRecord(payload) && typeof payload.version === 'string' ? payload.version : null;
    return { version };
  }
}
