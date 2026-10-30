import type { EgressFetch } from './confluence-egress.js';
import { EgressRefusedError } from './confluence-egress.js';
import { ValidationError } from '../projects.js';

/**
 * The slice of the GitHub REST and GraphQL APIs the `github` source uses
 * ([ADR-0128](../../../.ssot/ADR.md#adr-0128)), with no GitHub client library: issues and issue comments over
 * REST (`Link`-paginated, conditional where the probe needs it), Discussions over GraphQL, all through an
 * egress fetch the driver built and pinned to the one API host of the source.
 *
 * **Rate limits end the run; they are not waited out** (decision 8). A `429`, or a `403` that carries
 * `x-ratelimit-remaining: 0`, `retry-after` or a rate-limit message, is raised as {@link GithubRateLimitError}
 * with the reset time in its message, whatever it was answering, and is never retried: retrying a primary limit
 * only spends the next window, and the driver stores no cursor for a run that failed. Only `5xx` answers and
 * network errors are retried, a few times, with a jittered exponential back-off.
 *
 * Nothing here puts the token into an error, a log line or a URL: it travels in the `Authorization` header
 * only, and GitHub's own `message` is quoted (truncated) while the request headers never are.
 */

// ---------------------------------------------------------------------------------------------------
// Fixed shapes
// ---------------------------------------------------------------------------------------------------

export const GITHUB_API_DEFAULT = 'https://api.github.com';

/** A token travels in a header. This is what GitHub issues (`ghp_…`, `github_pat_…`) and nothing a header could not hold. */
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/;

/**
 * The token as it is stored: trimmed, and checked to be one header-safe word. The message names the rule and
 * never the value — a rejected token is one the operator just pasted
 * ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 8, which applies to every credential-bearing type).
 */
export function canonicalGithubToken(raw: string): string {
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) {
    throw new ValidationError('The github token must be a single word of printable characters, without spaces or line breaks (at most 1024)');
  }
  return token;
}

/** The GraphQL endpoint that belongs to a REST base: `…/api/v3` → `…/api/graphql`, `https://api.github.com` → `…/graphql`. */
export function graphqlUrlFor(apiBase: string): string {
  const url = new URL(apiBase);
  const path = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  url.pathname = path.endsWith('/v3') ? `${path.slice(0, -3)}/graphql` : `${path}/graphql`;
  return url.href;
}

// ---------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------

/** What GitHub said no with, for anything that is not a rate limit. */
export class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GithubRequestError';
  }
}

/** A rate-limit answer. `resetAt` is when the window reopens, when GitHub said; the message already carries it. */
export class GithubRateLimitError extends Error {
  constructor(
    message: string,
    readonly resetAt: Date | null,
  ) {
    super(message);
    this.name = 'GithubRateLimitError';
  }
}

const clip = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);

// ---------------------------------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------------------------------

/** The most one answer may weigh: 100 issues of 64 KiB each is 6.4 MB; nothing legitimate is near this. */
export const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const ERROR_BODY_BYTES = 4000;

async function readBounded(response: Response, limit: number, onExceeded: 'throw' | 'truncate'): Promise<string> {
  const stream = response.body;
  if (!stream) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        if (onExceeded === 'throw') throw new Error(`the answer is larger than ${limit} bytes`);
        chunks.push(value.subarray(0, value.byteLength - (received - limit)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// ---------------------------------------------------------------------------------------------------
// The data the driver reads
// ---------------------------------------------------------------------------------------------------

/** Who wrote something. `null` login is a deleted account, which GitHub shows as `ghost`. */
export interface GithubAuthor {
  login: string;
  bot: boolean;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  htmlUrl: string;
  labels: string[];
  author: GithubAuthor;
  createdAt: string;
  updatedAt: string;
  /** The issues API returns pull requests too; they are told apart by this, and skipped. */
  isPullRequest: boolean;
}

export interface GithubComment {
  /** The issue the comment is on; for a Discussion comment, `0`. */
  issueNumber: number;
  body: string;
  author: GithubAuthor;
  createdAt: string;
  /** REST comments only: the comment is on a pull request, which the repository-wide list carries too. */
  onPullRequest?: boolean;
  /** Discussion comments only: the one marked as the answer. */
  isAnswer?: boolean;
  /** Discussion comments only: replies to this comment, in order. */
  replies?: GithubComment[];
}

export interface GithubDiscussion {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  category: string;
  labels: string[];
  author: GithubAuthor;
  createdAt: string;
  updatedAt: string;
  closed: boolean;
  answered: boolean;
  comments: GithubComment[];
}

export interface GithubRepository {
  /** The repository's numeric id, which survives a rename; `null` when the answer carries none. */
  id: number | null;
  fullName: string;
  private: boolean;
  hasIssues: boolean;
  /** `undefined` on a server whose REST answer does not say (older Enterprise Server). */
  hasDiscussions: boolean | undefined;
}

const GHOST: GithubAuthor = { login: 'ghost', bot: false };

function authorOf(raw: unknown): GithubAuthor {
  const user = asObject(raw);
  const login = str(user?.login);
  if (!login) return GHOST;
  // REST says `type: "Bot"`; GraphQL says `__typename: "Bot"`.
  return { login, bot: user?.type === 'Bot' || user?.__typename === 'Bot' };
}

function issueFrom(raw: unknown): GithubIssue | null {
  const item = asObject(raw);
  if (!item || typeof item.number !== 'number' || !Number.isInteger(item.number) || item.number < 1) return null;
  const labels: string[] = [];
  if (Array.isArray(item.labels)) {
    for (const label of item.labels) {
      const name = typeof label === 'string' ? label : str(asObject(label)?.name);
      if (name) labels.push(name);
    }
  }
  const state = item.state === 'closed' ? 'closed' : 'open';
  return {
    number: item.number,
    title: typeof item.title === 'string' ? item.title : '',
    body: typeof item.body === 'string' ? item.body : '',
    state,
    stateReason: str(item.state_reason),
    htmlUrl: str(item.html_url) ?? '',
    labels,
    author: authorOf(item.user),
    createdAt: str(item.created_at) ?? '',
    updatedAt: str(item.updated_at) ?? '',
    isPullRequest: asObject(item.pull_request) !== null,
  };
}

function commentFrom(raw: unknown): GithubComment | null {
  const item = asObject(raw);
  if (!item) return null;
  const issueUrl = str(item.issue_url);
  const match = issueUrl ? /\/issues\/(\d+)$/.exec(issueUrl) : null;
  if (!match) return null;
  return {
    issueNumber: Number(match[1]),
    body: typeof item.body === 'string' ? item.body : '',
    author: authorOf(item.user),
    createdAt: str(item.created_at) ?? '',
    // A comment's page address says what it is on: `/pull/12#issuecomment-…` or `/issues/12#issuecomment-…`.
    onPullRequest: /\/pull\/\d+/.test(str(item.html_url) ?? ''),
  };
}

// ---------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------

export interface GithubClientOptions {
  /** The egress, pinned to the API host; the one thing that decides where a request may go. */
  fetch: EgressFetch;
  /** `https://api.github.com`, or an Enterprise Server base such as `https://ghe.example.com/api/v3`; no trailing slash. */
  apiBase: string;
  owner: string;
  repo: string;
  /** `null` is an anonymous client: public repositories, Issues only. */
  token: string | null;
  now?: () => number;
  /** Retries after the first attempt, for `5xx` and network errors (default 3). */
  retries?: number;
  /** Back-off unit: retry *n* waits about this × 2^(n-1), jittered (default 500 ms). */
  retryDelayMs?: number;
  random?: () => number;
}

const PAGE_SIZE = 100;
/** A listing that does not end after this many pages is not one. */
const MAX_PAGES = 5000;
const MAX_BACKOFF_MS = 15_000;

/** Page sizes of the GraphQL queries, chosen so that discussions × comments × replies stays well inside GitHub's 500 000-node limit. */
const DISCUSSIONS_PER_PAGE = 20;
const COMMENTS_PER_PAGE = 50;
const REPLIES_PER_PAGE = 50;

const AUTHOR_FIELDS = 'author { login __typename }';
const COMMENT_FIELDS = `id body createdAt isAnswer ${AUTHOR_FIELDS}`;
const REPLIES = `replies(first: ${REPLIES_PER_PAGE}) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }`;
const COMMENTS = `comments(first: ${COMMENTS_PER_PAGE}) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} ${REPLIES} } }`;
const DISCUSSION_FIELDS = `number title url body createdAt updatedAt closed isAnswered ${AUTHOR_FIELDS}
  category { name }
  labels(first: 20) { nodes { name } }
  ${COMMENTS}`;

interface Connection<T> {
  nodes: T[];
  hasNext: boolean;
  endCursor: string | null;
}

function connection(raw: unknown): Connection<unknown> {
  const root = asObject(raw);
  const info = asObject(root?.pageInfo);
  return {
    nodes: Array.isArray(root?.nodes) ? (root.nodes as unknown[]) : [],
    hasNext: info?.hasNextPage === true,
    endCursor: str(info?.endCursor),
  };
}

export class GithubClient {
  private readonly base: URL;
  private readonly graphql: string;
  private readonly now: () => number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly random: () => number;
  private readonly repoPath: string;
  /** The repository's id, once `repository()` has read it. */
  private repoId: number | null | undefined;
  /** Requests sent, retries included; the probe logs it and the smoke run reports it. */
  requests = 0;

  constructor(private readonly options: GithubClientOptions) {
    this.base = new URL(options.apiBase);
    this.graphql = graphqlUrlFor(options.apiBase);
    this.now = options.now ?? Date.now;
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.random = options.random ?? Math.random;
    this.repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  }

  get authenticated(): boolean {
    return this.options.token !== null;
  }

  // -- transport --------------------------------------------------------------------------------------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'contextator',
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...extra,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  /** When the limit lifts, from the headers GitHub sends with a limit answer. */
  private resetOf(response: Response): Date | null {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return new Date(this.now() + Number(retryAfter) * 1000);
    const reset = response.headers.get('x-ratelimit-reset');
    if (reset !== null && /^\d+$/.test(reset.trim())) return new Date(Number(reset) * 1000);
    return null;
  }

  private rateLimited(response: Response, message: string): GithubRateLimitError {
    const resetAt = this.resetOf(response);
    const when = resetAt ? `; it resets at ${resetAt.toISOString()}` : '';
    const who = this.authenticated ? '' : ' Anonymous requests share a small limit per address; a token raises it.';
    return new GithubRateLimitError(
      `GitHub rate limit reached${when}. The run stopped and will start over from where it was.${who}${message ? ` (${clip(message, 120)})` : ''}`,
      resetAt,
    );
  }

  /** Whether a non-2xx answer is a rate limit rather than a refusal ([ADR-0128](../../../.ssot/ADR.md#adr-0128) decision 8). */
  private isRateLimit(response: Response, message: string): boolean {
    if (response.status === 429) return true;
    if (response.status !== 403) return false;
    return (
      response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|abuse detection/i.test(message)
    );
  }

  private failure(what: string, response: Response, text: string): Error {
    const body = asObject(parseJson(text));
    const message = str(body?.message) ?? '';
    if (this.isRateLimit(response, message)) return this.rateLimited(response, message);
    const { status } = response;
    const repo = `${this.options.owner}/${this.options.repo}`;
    if (status === 401) {
      return new GithubRequestError(
        'GitHub rejected the token (HTTP 401): check that it is current, has not expired and belongs to this server (github.com or the Enterprise Server host)',
        status,
      );
    }
    if (status === 404) {
      const hint = this.authenticated
        ? 'it does not exist, or the token cannot read it (a fine-grained token must be granted this repository)'
        : 'it does not exist, or it is private and needs a token';
      return new GithubRequestError(`GitHub answered 404 for ${what}: ${repo}: ${hint}`, status);
    }
    if (status === 410) {
      return new GithubRequestError(`GitHub answered 410 for ${what}: ${message || 'issues are disabled for this repository'}`, status);
    }
    if (status === 403) {
      return new GithubRequestError(
        `GitHub refused ${what} (HTTP 403)${message ? `: ${clip(message)}` : ''}; the token may lack read access to issues${this.authenticated ? '' : ', or the repository needs one'}`,
        status,
      );
    }
    return new GithubRequestError(`GitHub ${what} failed: HTTP ${status}${message ? `: ${clip(message)}` : ''}`, status);
  }

  /**
   * One request with the retry policy above. Returns a 2xx response, or a `304` when `allowNotModified`;
   * anything else is raised as the error {@link failure} makes of it.
   */
  private async perform(
    what: string,
    url: string,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Uint8Array },
    allowNotModified = false,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      let response: Response;
      this.requests++;
      try {
        response = await this.options.fetch(url, init);
      } catch (err) {
        // A refusal is the guard's answer about the host, not a flaky network: say it, once.
        if (err instanceof EgressRefusedError) throw err;
        lastError = err;
        if (attempt <= this.retries) await this.sleep(this.backoff(attempt));
        continue;
      }
      if (response.ok || (allowNotModified && response.status === 304)) return response;
      const text = await readBounded(response, ERROR_BODY_BYTES, 'truncate').catch(() => '');
      if (response.status >= 500) {
        lastError = this.failure(what, response, text);
        if (attempt <= this.retries) await this.sleep(this.backoff(attempt));
        continue;
      }
      throw this.failure(what, response, text);
    }
    if (lastError instanceof GithubRequestError || lastError instanceof GithubRateLimitError) throw lastError;
    const reason = lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError);
    throw new Error(`GitHub ${what} could not be completed: ${clip(reason)}`);
  }

  private async json(what: string, response: Response): Promise<unknown> {
    const text = await readBounded(response, MAX_ANSWER_BYTES, 'throw').catch((err: unknown) => {
      throw new Error(`GitHub ${what} failed: the answer could not be read (${err instanceof Error ? err.message : 'unknown'})`, { cause: err });
    });
    const parsed = parseJson(text);
    if (parsed === undefined) {
      throw new Error(`GitHub ${what} failed: the answer was not JSON; check that nothing between this server and GitHub rewrites it`);
    }
    return parsed;
  }

  // -- REST -------------------------------------------------------------------------------------------

  private restUrl(path: string, query: Record<string, string>): string {
    const prefix = this.base.pathname.replace(/\/+$/, '');
    const search = new URLSearchParams(query).toString();
    return `${this.base.origin}${prefix}${path}${search ? `?${search}` : ''}`;
  }

  private async getJson(what: string, url: string): Promise<{ body: unknown; response: Response }> {
    const response = await this.perform(what, url, { method: 'GET', headers: this.headers() });
    return { body: await this.json(what, response), response };
  }

  /**
   * Every page of a list endpoint, following `Link: rel="next"`. A next address on another origin is refused:
   * the token is only ever sent to the host the source names.
   */
  private async *pages(what: string, firstUrl: string): AsyncGenerator<unknown[]> {
    let url: string | null = firstUrl;
    const seen = new Set<string>();
    for (let page = 1; url !== null; page++) {
      if (page > MAX_PAGES || seen.has(url)) throw new Error(`GitHub ${what} failed: the listing did not end`);
      seen.add(url);
      const { body, response } = await this.getJson(what, url);
      if (!Array.isArray(body)) throw new Error(`GitHub ${what} failed: the answer was not a list`);
      yield body;
      url = this.nextLink(response.headers.get('link'));
    }
  }

  private nextLink(header: string | null): string | null {
    if (!header) return null;
    for (const part of header.split(',')) {
      const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
      if (!match) continue;
      let next: URL;
      try {
        next = new URL(match[1] as string);
      } catch {
        return null;
      }
      if (next.origin !== this.base.origin) throw new Error('GitHub sent a pagination link to another host; refusing to follow it');
      return next.href;
    }
    return null;
  }

  /** `GET /repos/{owner}/{repo}`: whether it can be read, and what it has switched on. */
  async repository(): Promise<GithubRepository> {
    const what = 'repository lookup';
    const { body } = await this.getJson(what, this.restUrl(this.repoPath, {}));
    const repo = asObject(body);
    if (!repo) throw new Error(`GitHub ${what} failed: the answer was not an object`);
    const id = typeof repo.id === 'number' && Number.isInteger(repo.id) ? repo.id : null;
    this.repoId = id;
    return {
      id,
      fullName: str(repo.full_name) ?? `${this.options.owner}/${this.options.repo}`,
      private: repo.private === true,
      hasIssues: repo.has_issues !== false,
      hasDiscussions: typeof repo.has_discussions === 'boolean' ? repo.has_discussions : undefined,
    };
  }

  /**
   * The probe's REST half ([ADR-0128](../../../.ssot/ADR.md#adr-0128) decision 7): the most recently updated
   * issue, one request. With the `ETag` of the last answer it is conditional, and a `304` is `unchanged`
   * (free of the primary limit when the request carries a token). `etag` is `null` when GitHub sent none.
   */
  async newestIssue(ifNoneMatch?: string): Promise<{ unchanged: true } | { unchanged: false; etag: string | null }> {
    const url = this.restUrl(`${this.repoPath}/issues`, { state: 'all', sort: 'updated', direction: 'desc', per_page: '1' });
    const response = await this.perform(
      'freshness check',
      url,
      { method: 'GET', headers: this.headers(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}) },
      true,
    );
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return { unchanged: true };
    }
    await this.json('freshness check', response);
    return { unchanged: false, etag: response.headers.get('etag') };
  }

  /** Issues (and pull requests, which the caller skips), `state=all`, newest created first, or — with `since` — oldest updated first. */
  async *listIssues(options: { since?: Date } = {}): AsyncGenerator<GithubIssue[]> {
    const query: Record<string, string> = { state: 'all', per_page: String(PAGE_SIZE) };
    if (options.since) Object.assign(query, { since: options.since.toISOString(), sort: 'updated', direction: 'asc' });
    else Object.assign(query, { sort: 'created', direction: 'desc' });
    for await (const page of this.pages('issue listing', this.restUrl(`${this.repoPath}/issues`, query))) {
      yield page.map(issueFrom).filter((issue): issue is GithubIssue => issue !== null);
    }
  }

  /** One issue by number. `null` when it is gone: deleted (`404`/`410`), or transferred (`301` to another repository). */
  async issue(number: number): Promise<GithubIssue | null> {
    const what = `lookup of issue #${number}`;
    const url = this.restUrl(`${this.repoPath}/issues/${number}`, {});
    let response: Response;
    try {
      response = await this.perform(what, url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      if (err instanceof GithubRequestError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
    // The egress follows a redirect itself, and two things redirect: a transferred issue (`301` to its new repository's
    // id) and a repository that was renamed (`301` to its own id). Only the first is an issue that has left.
    if (response.redirected) {
      const target = /\/repositories\/(\d+)\/issues\/\d+$/.exec(new URL(response.url).pathname)?.[1];
      const own = this.repoId === undefined ? (await this.repository()).id : this.repoId;
      if (target === undefined || own === null || Number(target) !== own) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
    }
    return issueFrom(await this.json(what, response));
  }

  /** Every comment of the repository's issues, in one listing; `since` limits it to comments updated after it. */
  async *listRepositoryComments(options: { since?: Date } = {}): AsyncGenerator<GithubComment[]> {
    const query: Record<string, string> = { per_page: String(PAGE_SIZE), sort: 'created', direction: 'asc' };
    if (options.since) query.since = options.since.toISOString();
    for await (const page of this.pages('comment listing', this.restUrl(`${this.repoPath}/issues/comments`, query))) {
      yield page.map(commentFrom).filter((comment): comment is GithubComment => comment !== null);
    }
  }

  /** All comments of one issue, oldest first. */
  async *listIssueComments(number: number): AsyncGenerator<GithubComment[]> {
    const query = { per_page: String(PAGE_SIZE) };
    for await (const page of this.pages(`comment listing of issue #${number}`, this.restUrl(`${this.repoPath}/issues/${number}/comments`, query))) {
      yield page.map(commentFrom).filter((comment): comment is GithubComment => comment !== null);
    }
  }

  // -- GraphQL ----------------------------------------------------------------------------------------

  private async query(what: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.token) throw new GithubRequestError('GitHub Discussions are read through the GraphQL API, which needs a token', 401);
    const body = Buffer.from(JSON.stringify({ query, variables }), 'utf8');
    const response = await this.perform(what, this.graphql, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body });
    const answer = asObject(await this.json(what, response));
    const errors = Array.isArray(answer?.errors) ? (answer.errors as unknown[]) : [];
    if (errors.length > 0) {
      const first = asObject(errors[0]);
      const type = str(first?.type);
      const message = str(first?.message) ?? 'unknown error';
      // GraphQL reports its limit inside a 200.
      if (type === 'RATE_LIMITED' || /rate limit/i.test(message)) {
        throw new GithubRateLimitError(
          `GitHub GraphQL rate limit reached. The run stopped and will start over from where it was. (${clip(message, 120)})`,
          null,
        );
      }
      if (type === 'NOT_FOUND') {
        throw new GithubRequestError(
          `GitHub ${what} failed: ${this.options.owner}/${this.options.repo} was not found, or the token cannot read it`,
          404,
        );
      }
      throw new GithubRequestError(`GitHub ${what} failed: ${clip(message)}`, 200);
    }
    const data = asObject(answer?.data);
    if (!data) throw new Error(`GitHub ${what} failed: the answer carried no data`);
    return data;
  }

  private repositoryNode(data: Record<string, unknown>, what: string): Record<string, unknown> {
    const repository = asObject(data.repository);
    if (!repository)
      throw new GithubRequestError(
        `GitHub ${what} failed: ${this.options.owner}/${this.options.repo} was not found, or the token cannot read it`,
        404,
      );
    return repository;
  }

  private commentFromGraphql(raw: unknown): { comment: GithubComment; id: string | null; replies: Connection<unknown> } | null {
    const item = asObject(raw);
    if (!item) return null;
    return {
      id: str(item.id),
      replies: connection(item.replies),
      comment: {
        issueNumber: 0,
        body: typeof item.body === 'string' ? item.body : '',
        author: authorOf(item.author),
        createdAt: str(item.createdAt) ?? '',
        isAnswer: item.isAnswer === true,
      },
    };
  }

  /** Comments of a Discussion, with each one's replies completed beyond the first page. */
  private async completeComments(first: Connection<unknown>, discussionId: string | null): Promise<GithubComment[]> {
    const out: GithubComment[] = [];
    let page = first;
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      for (const raw of page.nodes) {
        const parsed = this.commentFromGraphql(raw);
        if (!parsed) continue;
        const replies = await this.completeReplies(parsed.replies, parsed.id);
        out.push({ ...parsed.comment, replies });
      }
      if (!page.hasNext || !page.endCursor || !discussionId) return out;
      const data = await this.query(
        'discussion comment listing',
        `query($id: ID!, $after: String) { node(id: $id) { ... on Discussion { comments(first: ${COMMENTS_PER_PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} ${REPLIES} } } } } }`,
        { id: discussionId, after: page.endCursor },
      );
      page = connection(asObject(data.node)?.comments);
    }
    throw new Error('GitHub discussion comment listing failed: the listing did not end');
  }

  private async completeReplies(first: Connection<unknown>, commentId: string | null): Promise<GithubComment[]> {
    const out: GithubComment[] = [];
    let page = first;
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      for (const raw of page.nodes) {
        const parsed = this.commentFromGraphql(raw);
        if (parsed) out.push(parsed.comment);
      }
      if (!page.hasNext || !page.endCursor || !commentId) return out;
      const data = await this.query(
        'discussion reply listing',
        `query($id: ID!, $after: String) { node(id: $id) { ... on DiscussionComment { replies(first: ${REPLIES_PER_PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } } } } }`,
        { id: commentId, after: page.endCursor },
      );
      page = connection(asObject(data.node)?.replies);
    }
    throw new Error('GitHub discussion reply listing failed: the listing did not end');
  }

  /**
   * The repository's Discussions, newest first, in pages of up to 20 with their comments and replies complete
   * ([ADR-0128](../../../.ssot/ADR.md#adr-0128) decision 5); a page is only completed (extra queries for long threads)
   * when it is read.
   *
   * **`order` is the caller's choice and it matters.** An incremental run reads `updated` and stops at its cursor. A
   * full run reads `created`: the list is a snapshot it deletes by, and a Discussion that is commented on while the
   * pages are being read would move to the front of an `updated` list, be missed, and have its document removed.
   */
  async *listDiscussions(order: 'created' | 'updated'): AsyncGenerator<GithubDiscussion[]> {
    const field = order === 'created' ? 'CREATED_AT' : 'UPDATED_AT';
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: Record<string, unknown> = await this.query(
        'discussion listing',
        `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { discussions(first: ${DISCUSSIONS_PER_PAGE}, after: $after, orderBy: { field: ${field}, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { id ${DISCUSSION_FIELDS} } } } }`,
        { owner: this.options.owner, name: this.options.repo, after },
      );
      const discussions = connection(asObject(this.repositoryNode(data, 'discussion listing'))?.discussions);
      const out: GithubDiscussion[] = [];
      for (const raw of discussions.nodes) {
        const item = asObject(raw);
        if (!item || typeof item.number !== 'number' || !Number.isInteger(item.number) || item.number < 1) continue;
        const labels = connection(item.labels)
          .nodes.map((label) => str(asObject(label)?.name))
          .filter((name): name is string => name !== null);
        out.push({
          number: item.number,
          title: typeof item.title === 'string' ? item.title : '',
          body: typeof item.body === 'string' ? item.body : '',
          htmlUrl: str(item.url) ?? '',
          category: str(asObject(item.category)?.name) ?? '',
          labels,
          author: authorOf(item.author),
          createdAt: str(item.createdAt) ?? '',
          updatedAt: str(item.updatedAt) ?? '',
          closed: item.closed === true,
          answered: item.isAnswered === true,
          comments: await this.completeComments(connection(item.comments), str(item.id)),
        });
      }
      yield out;
      if (!discussions.hasNext || !discussions.endCursor) return;
      after = discussions.endCursor;
    }
    throw new Error('GitHub discussion listing failed: the listing did not end');
  }

  /** The probe's GraphQL half: the most recently updated Discussion, as `number@updatedAt`, or `none`. One query. */
  async newestDiscussion(): Promise<string> {
    const data = await this.query(
      'discussion freshness check',
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussions(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number updatedAt } } } }`,
      { owner: this.options.owner, name: this.options.repo },
    );
    const node = asObject(connection(asObject(this.repositoryNode(data, 'discussion freshness check'))?.discussions).nodes[0]);
    return node && typeof node.number === 'number' ? `${node.number}@${str(node.updatedAt) ?? ''}` : 'none';
  }
}
