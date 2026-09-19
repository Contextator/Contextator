import type { Account, CommitRecord } from './rules.js';

/**
 * The GitHub surface the licence gate uses, as two interfaces and one `fetch` implementation of each
 * ([ADR-0061](../../../.ssot/ADR.md#adr-0061)).
 *
 * They are two rather than one because they are reached with two different tokens, and that split is
 * the point. `ProductRepo` holds the job's own `GITHUB_TOKEN`, scoped to this repository and able to
 * comment and to re-run a workflow. `SignatureStore` holds `CLA_SIGNATURES_TOKEN`, a fine-grained
 * token that can write to `Contextator/cla-signatures` and to nothing else — it cannot touch this
 * repository, and that has been verified against the API rather than assumed. A single client would
 * make the wider token the obvious one to pass everywhere.
 *
 * Nothing in `run.ts` constructs either of these; they arrive as arguments, which is what lets
 * `test/cla-gate.test.ts` drive the whole gate without a network.
 */

/** Everything the gate needs from the repository the pull request is against. */
export interface ProductRepo {
  getPullRequest(number: number): Promise<PullRequestInfo>;
  /**
   * The commits of the pull request, **as many as the API will give** — at most `MAX_COMMITS`, with no
   * signal when that truncates. `run.ts` compares the length against `PullRequestInfo.commits` and
   * refuses on a mismatch, which is where truncation is actually caught.
   */
  listCommits(number: number): Promise<CommitRecord[]>;
  listComments(number: number): Promise<IssueComment[]>;
  createComment(number: number, body: string): Promise<void>;
  updateComment(commentId: number, body: string): Promise<void>;
  /** Runs of one workflow file against one head commit, most recent first. */
  listWorkflowRuns(workflowFile: string, headSha: string): Promise<WorkflowRun[]>;
  rerunWorkflowRun(runId: number): Promise<void>;
}

export type PullRequestInfo = {
  number: number;
  state: 'open' | 'closed';
  headSha: string;
  /**
   * The account that opened it. GitHub authenticated this one; nothing inside a commit is
   * authenticated, which is why `collectAuthors` rests on it.
   */
  user: Account;
  /**
   * How many commits GitHub says it has. Read by `run.ts` against the length of `listCommits`, which is
   * the only way the 250-commit cap below is noticed rather than silently passed.
   */
  commits: number;
};

export type IssueComment = {
  id: number;
  body: string;
  user: Account | null;
};

export type WorkflowRun = {
  id: number;
  status: string;
};

/** Reading and writing the one JSON file that is the record. */
export interface SignatureStore {
  /** `null` when the file is absent, which this gate treats as a failure rather than as "no signatures". */
  readFile(): Promise<StoredFile | null>;
  /** Throws `StaleWriteError` when `sha` no longer names the blob that is there. */
  writeFile(args: { content: string; sha: string; message: string }): Promise<void>;
}

export type StoredFile = {
  /** Decoded UTF-8, not the base64 the API returns. */
  content: string;
  /** The blob SHA this content was read at. Writing with a stale one is how a lost signature is caught. */
  sha: string;
};

/**
 * Two runs recorded a signature at the same moment and this one read the file first.
 *
 * It is a distinct type because it is the one API failure with a correct automatic response — read the
 * file again and redo the append against what is actually there. Every other failure is a red check.
 */
export class StaleWriteError extends Error {}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * `GET /repos/{o}/{r}/pulls/{n}/commits` returns at most 250 commits however hard it is paged, and
 * says nothing when it truncates — no header, no flag, just a shorter list. **Nothing here can detect
 * that**, which is why the detection is not here: `run.ts` compares what came back against
 * `PullRequestInfo.commits`, the count GitHub reports for the pull request itself, and refuses when
 * they differ. A guard written as `received > MAX_COMMITS` would never fire, because the cap is
 * exactly what the API stops at.
 */
export const MAX_COMMITS = 250;

const API = 'https://api.github.com';

type Json = Record<string, unknown>;

/**
 * The one function that makes a request, injected rather than reached for.
 *
 * `test/cla-github.test.ts` passes its own, which is what makes the paging, the conflict mapping and
 * the base64 decoding below testable at all — they are the half of this gate that is shaped by another
 * system's answers, and the half the unit suite would otherwise never execute.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

const realFetch: FetchLike = (url, init) => fetch(url, init);

async function request(fetchImpl: FetchLike, token: string, method: string, path: string, body?: Json): Promise<{ status: number; json: unknown }> {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'contextator-licence-gate',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 204 and 202 carry no body; `rerun` answers 201 with one nobody reads.
  const text = await response.text();
  const json = text === '' ? null : JSON.parse(text);
  return { status: response.status, json };
}

async function ok(fetchImpl: FetchLike, token: string, method: string, path: string, body?: Json): Promise<unknown> {
  const { status, json } = await request(fetchImpl, token, method, path, body);
  if (status >= 200 && status < 300) return json;
  const message = json !== null && typeof json === 'object' && 'message' in json ? String((json as Json).message) : '';
  throw new GitHubError(`${method} ${path} failed: ${status}${message === '' ? '' : ` ${message}`}`, status);
}

/** Pages a list endpoint to exhaustion, or up to `limit` items. */
async function paged(fetchImpl: FetchLike, token: string, path: string, limit: number): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; items.length < limit; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await ok(fetchImpl, token, 'GET', `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new GitHubError(`GET ${path} did not answer with a list`, 200);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** The opener is not optional: a pull request this gate cannot name the author of is one it refuses. */
function mustBeAccount(value: unknown, message: string): Account {
  const account = asAccount(value);
  if (account === null) throw new GitHubError(message, 200);
  return account;
}

function asAccount(value: unknown): Account | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Json;
  if (typeof raw.login !== 'string' || typeof raw.id !== 'number' || typeof raw.type !== 'string') return null;
  return { login: raw.login, id: raw.id, type: raw.type };
}

export function createProductRepo(token: string, owner: string, repo: string, fetchImpl: FetchLike = realFetch): ProductRepo {
  const base = `/repos/${owner}/${repo}`;
  return {
    async getPullRequest(number) {
      const raw = (await ok(fetchImpl, token, 'GET', `${base}/pulls/${number}`)) as Json;
      const head = raw.head as Json;
      return {
        number,
        state: raw.state === 'open' ? 'open' : 'closed',
        headSha: String(head.sha),
        user: mustBeAccount(raw.user, `GET ${base}/pulls/${number} named no author`),
        commits: typeof raw.commits === 'number' ? raw.commits : -1,
      };
    },

    async listCommits(number) {
      const raw = await paged(fetchImpl, token, `${base}/pulls/${number}/commits`, MAX_COMMITS);
      return raw.map((item) => {
        const entry = item as Json;
        const commit = entry.commit as Json;
        const author = commit.author as Json;
        return {
          sha: String(entry.sha),
          author: asAccount(entry.author),
          commit: { author: { name: String(author.name ?? ''), email: String(author.email ?? '') } },
        } satisfies CommitRecord;
      });
    },

    async listComments(number) {
      const raw = await paged(fetchImpl, token, `${base}/issues/${number}/comments`, 1000);
      return raw.map((item) => {
        const entry = item as Json;
        return { id: Number(entry.id), body: typeof entry.body === 'string' ? entry.body : '', user: asAccount(entry.user) };
      });
    },

    async createComment(number, body) {
      await ok(fetchImpl, token, 'POST', `${base}/issues/${number}/comments`, { body });
    },

    async updateComment(commentId, body) {
      await ok(fetchImpl, token, 'PATCH', `${base}/issues/comments/${commentId}`, { body });
    },

    async listWorkflowRuns(workflowFile, headSha) {
      const raw = (await ok(
        fetchImpl,
        token,
        'GET',
        `${base}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=pull_request_target&head_sha=${encodeURIComponent(headSha)}&per_page=20`,
      )) as Json;
      const runs = Array.isArray(raw.workflow_runs) ? raw.workflow_runs : [];
      return runs.map((item) => {
        const entry = item as Json;
        return { id: Number(entry.id), status: String(entry.status ?? '') };
      });
    },

    async rerunWorkflowRun(runId) {
      await ok(fetchImpl, token, 'POST', `${base}/actions/runs/${runId}/rerun`);
    },
  };
}

export function createSignatureStore(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch: string,
  fetchImpl: FetchLike = realFetch,
): SignatureStore {
  const url = `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async readFile() {
      const { status, json } = await request(fetchImpl, token, 'GET', `${url}?ref=${encodeURIComponent(branch)}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw new GitHubError(`GET ${url} failed: ${status}`, status);
      const raw = json as Json;
      if (typeof raw.content !== 'string' || typeof raw.sha !== 'string') {
        throw new GitHubError(`GET ${url} did not answer with a file`, status);
      }
      return { content: Buffer.from(raw.content, 'base64').toString('utf8'), sha: raw.sha };
    },

    async writeFile({ content, sha, message }) {
      const { status, json } = await request(fetchImpl, token, 'PUT', url, {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha,
        branch,
      });
      if (status >= 200 && status < 300) return;
      // 409 is the documented conflict; 422 is what the contents API answers when the `sha` it was
      // given is not the blob that is there. Both mean the same thing here: somebody else wrote first.
      if (status === 409 || status === 422) {
        throw new StaleWriteError(`the signature record moved under this write (${status})`);
      }
      const raw = json as Json | null;
      throw new GitHubError(`PUT ${url} failed: ${status}${raw?.message === undefined ? '' : ` ${String(raw.message)}`}`, status);
    },
  };
}
