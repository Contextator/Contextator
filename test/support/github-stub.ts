import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the one host the `github` source talks to — GitHub's REST API and its GraphQL endpoint — on the
 * loopback interface ([ADR-0128](../../.ssot/ADR.md)). It is reached **through** the egress guard by a made-up
 * host name (`test/support/egress-seams.ts`), so the host pin, the address check and the redirect rules are the
 * production ones.
 *
 * **It behaves the way GitHub is documented to**, in the parts the source depends on: the issues list returns pull
 * requests too and `since` filters on `updated_at`; a comment on an issue bumps the issue's `updated_at` but an
 * edit of a comment does not; the repository-wide comment list carries comments on pull requests; a deleted
 * issue is absent from every list and answers `404`; a transferred one answers `301`; list answers carry an
 * `ETag` and a `304` follows `If-None-Match`; a rate limit is a `403` with `x-ratelimit-remaining: 0` (or a
 * `429`); GraphQL needs a token, reports its limit inside a `200` and is paged with cursors. Time is a clock the
 * test moves (`advance`), so what `since` selects is the test's to decide. No token here is, or was, a real one.
 */

export const OWNER = 'octo-org';
export const REPO = 'handbook';
export const GOOD_TOKEN = 'fixture-token-not-a-real-credential-0000';
/** The epoch every test starts from; `advance` moves it. */
export const START_MS = Date.parse('2026-10-01T09:00:00Z');

export interface StubUser {
  login: string;
  bot?: boolean;
}

export interface StubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  user: StubUser | null;
  createdAt: string;
  updatedAt: string;
  pullRequest: boolean;
}

export interface StubComment {
  id: number;
  issueNumber: number;
  body: string;
  user: StubUser | null;
  createdAt: string;
  updatedAt: string;
}

export interface StubDiscussionComment {
  id: string;
  body: string;
  author: StubUser | null;
  createdAt: string;
  isAnswer: boolean;
  replies: Array<{ id: string; body: string; author: StubUser | null; createdAt: string; isAnswer: boolean }>;
}

export interface StubDiscussion {
  id: string;
  number: number;
  title: string;
  body: string;
  category: string;
  labels: string[];
  author: StubUser | null;
  createdAt: string;
  updatedAt: string;
  closed: boolean;
  answered: boolean;
  comments: StubDiscussionComment[];
}

export type RequestKind = 'repo' | 'issues' | 'newest' | 'issue' | 'issue-comments' | 'repo-comments' | 'graphql' | 'other';

export interface LoggedRequest {
  kind: RequestKind;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  /** The `Authorization` header as sent, so a test can assert what was and was not sent. */
  authorization: string | undefined;
  ifNoneMatch: string | undefined;
  /** GraphQL only: the variables of the query. */
  variables?: Record<string, unknown>;
  /** GraphQL only: the query text, so a test can say which order a listing asked for. */
  queryText?: string;
}

export interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

export class StubGithub {
  readonly issues = new Map<number, StubIssue>();
  readonly comments: StubComment[] = [];
  readonly discussions = new Map<number, StubDiscussion>();
  /** Issue numbers that were deleted: absent from every list, `404` on their own address. */
  readonly deleted = new Set<number>();
  /** Issue numbers that were transferred: `301` on their address, absent from the lists. */
  readonly transferred = new Set<number>();
  readonly log: LoggedRequest[] = [];
  /** Answers handed out before real handling, one per request, in order. */
  readonly scripted: Scripted[] = [];
  /** The token the stub accepts; `null` makes the repository public and every REST answer anonymous. */
  token: string | null = GOOD_TOKEN;
  /** Whether REST answers an anonymous caller (a public repository). GraphQL never does. */
  publicRepo = true;
  hasDiscussions = true;
  /** The repository's id, which survives a rename. */
  readonly repoId = 123;
  /** When set, the repository was renamed: its old address redirects to `/repositories/<id>/…`. */
  renamed = false;
  /** Called after each Discussion listing page has been served; a test uses it to change data while the list is being read. */
  afterDiscussionPage: (() => void) | undefined;
  /** Rows per REST page, whatever `per_page` says; small, to make the driver follow `Link`. */
  restPageSize = 100;
  /** Discussions per GraphQL page, and comments and replies per connection, to make the driver follow cursors. */
  discussionPageSize = 20;
  commentPageSize = 50;
  /** When set, `Link: rel="next"` names this host, as a hostile or broken server would. */
  nextLinkHost: string | undefined;
  /** Milliseconds; what `updated_at` is stamped with. Move it with {@link advance}. */
  nowMs = START_MS;
  private nextIssue = 1;
  private nextComment = 1;
  private nextNode = 1;
  server!: http.Server;
  port = 0;

  // -- addresses --------------------------------------------------------------------------------------

  /** The REST base a driver is given, reached as `host`. */
  apiBase(host: string): string {
    return `http://${host}:${this.port}`;
  }

  // -- the clock and the data -------------------------------------------------------------------------

  advance(minutes: number): void {
    this.nowMs += minutes * 60_000;
  }

  private stamp(): string {
    return iso(this.nowMs);
  }

  issue(input: {
    title: string;
    body?: string | null;
    state?: 'open' | 'closed';
    labels?: string[];
    user?: StubUser | null;
    pr?: boolean;
  }): StubIssue {
    const issue: StubIssue = {
      number: this.nextIssue++,
      title: input.title,
      body: input.body === undefined ? `Body of ${input.title}` : input.body,
      state: input.state ?? 'open',
      stateReason: input.state === 'closed' ? 'completed' : null,
      labels: input.labels ?? [],
      user: input.user === undefined ? { login: 'octocat' } : input.user,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      pullRequest: input.pr ?? false,
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  /** A new comment; it moves the issue's `updated_at`, as GitHub does. */
  comment(issueNumber: number, body: string, user: StubUser | null = { login: 'hubot-fan' }): StubComment {
    const comment: StubComment = { id: this.nextComment++, issueNumber, body, user, createdAt: this.stamp(), updatedAt: this.stamp() };
    this.comments.push(comment);
    const issue = this.issues.get(issueNumber);
    if (issue) issue.updatedAt = this.stamp();
    return comment;
  }

  /** An edit of a comment moves the comment's `updated_at` and **not** the issue's. */
  editComment(id: number, body: string): void {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    comment.body = body;
    comment.updatedAt = this.stamp();
  }

  deleteComment(id: number): void {
    const at = this.comments.findIndex((c) => c.id === id);
    if (at < 0) throw new Error(`no comment ${id}`);
    this.comments.splice(at, 1);
  }

  edit(number: number, patch: Partial<Pick<StubIssue, 'title' | 'body' | 'labels'>>): void {
    const issue = this.must(number);
    Object.assign(issue, patch);
    issue.updatedAt = this.stamp();
  }

  close(number: number, reason = 'completed'): void {
    const issue = this.must(number);
    issue.state = 'closed';
    issue.stateReason = reason;
    issue.updatedAt = this.stamp();
  }

  reopen(number: number): void {
    const issue = this.must(number);
    issue.state = 'open';
    issue.stateReason = null;
    issue.updatedAt = this.stamp();
  }

  /** Deleted: nothing in any list moves, which is the point (ADR-0128 decision 6). */
  delete(number: number): void {
    this.must(number);
    this.deleted.add(number);
  }

  transfer(number: number): void {
    this.must(number);
    this.transferred.add(number);
  }

  private must(number: number): StubIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return issue;
  }

  discussion(input: {
    title: string;
    body?: string;
    category?: string;
    labels?: string[];
    author?: StubUser | null;
    closed?: boolean;
    answered?: boolean;
  }): StubDiscussion {
    const number = this.nextIssue++;
    const discussion: StubDiscussion = {
      id: `D_${this.nextNode++}`,
      number,
      title: input.title,
      body: input.body ?? `Body of ${input.title}`,
      category: input.category ?? 'Q&A',
      labels: input.labels ?? [],
      author: input.author === undefined ? { login: 'octocat' } : input.author,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      closed: input.closed ?? false,
      answered: input.answered ?? false,
      comments: [],
    };
    this.discussions.set(number, discussion);
    return discussion;
  }

  discussionComment(
    number: number,
    body: string,
    replies: string[] = [],
    author: StubUser | null = { login: 'answerer' },
    isAnswer = false,
  ): StubDiscussionComment {
    const discussion = this.discussions.get(number);
    if (!discussion) throw new Error(`no discussion ${number}`);
    const comment: StubDiscussionComment = {
      id: `DC_${this.nextNode++}`,
      body,
      author,
      createdAt: this.stamp(),
      isAnswer,
      replies: replies.map((text) => ({
        id: `DR_${this.nextNode++}`,
        body: text,
        author: { login: 'replier' },
        createdAt: this.stamp(),
        isAnswer: false,
      })),
    };
    discussion.comments.push(comment);
    discussion.updatedAt = this.stamp();
    return comment;
  }

  editDiscussion(number: number, body: string): void {
    const discussion = this.discussions.get(number);
    if (!discussion) throw new Error(`no discussion ${number}`);
    discussion.body = body;
    discussion.updatedAt = this.stamp();
  }

  deleteDiscussion(number: number): void {
    this.discussions.delete(number);
  }

  // -- the log ----------------------------------------------------------------------------------------

  count(kind: RequestKind): number {
    return this.log.filter((r) => r.kind === kind).length;
  }
  get requests(): number {
    return this.log.length;
  }
  reset(): void {
    this.log.length = 0;
  }

  // -- the server -------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private authorised(req: http.IncomingMessage): boolean {
    return this.token !== null && req.headers.authorization === `Bearer ${this.token}`;
  }

  private kindOf(method: string, route: string): RequestKind {
    const base = `/repos/${OWNER}/${REPO}`;
    if (method === 'POST' && route === '/graphql') return 'graphql';
    if (method !== 'GET') return 'other';
    if (route === base) return 'repo';
    if (route === `${base}/issues`) return 'issues';
    if (route === `${base}/issues/comments`) return 'repo-comments';
    if (new RegExp(`^${base}/issues/\\d+/comments$`).test(route)) return 'issue-comments';
    if (new RegExp(`^${base}/issues/\\d+$`).test(route) || /^\/repositories\/\d+\/issues\/\d+$/.test(route)) return 'issue';
    return 'other';
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://unused');
    const query = Object.fromEntries(url.searchParams.entries());
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const route = url.pathname;
    let kind = this.kindOf(req.method ?? '', route);
    const entry: LoggedRequest = {
      kind,
      method: req.method ?? '',
      host,
      path: route,
      query,
      authorization: req.headers.authorization,
      ifNoneMatch: req.headers['if-none-match'] as string | undefined,
    };
    this.log.push(entry);

    let rawBody = '';
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      rawBody = Buffer.concat(chunks).toString('utf8');
    }

    const scripted = this.scripted.shift();
    if (scripted) return this.json(res, scripted.status, scripted.body, scripted.headers);

    if (req.headers.authorization !== undefined && !this.authorised(req)) return this.json(res, 401, { message: 'Bad credentials' });

    if (kind === 'graphql') {
      if (!this.authorised(req)) return this.json(res, 401, { message: 'This endpoint requires you to be authenticated.' });
      const parsed = JSON.parse(rawBody) as { query: string; variables?: Record<string, unknown> };
      entry.variables = parsed.variables ?? {};
      entry.queryText = parsed.query;
      return this.graphql(res, parsed.query, parsed.variables ?? {});
    }

    // REST: a private repository answers an anonymous caller as if it did not exist.
    if (!this.authorised(req) && !this.publicRepo) return this.json(res, 404, { message: 'Not Found' });

    if (kind === 'repo') {
      return this.json(res, 200, {
        id: this.repoId,
        full_name: `${OWNER}/${REPO}`,
        private: !this.publicRepo,
        has_issues: true,
        has_discussions: this.hasDiscussions,
      });
    }
    if (kind === 'issues') {
      if (query.per_page === '1' && query.sort === 'updated' && query.direction === 'desc') {
        kind = 'newest';
        entry.kind = 'newest';
      }
      return this.listIssues(req, res, query, route);
    }
    if (kind === 'repo-comments') return this.listComments(req, res, query, route, null);
    if (kind === 'issue-comments') {
      const number = Number(/\/issues\/(\d+)\/comments$/.exec(route)?.[1]);
      if (this.deleted.has(number) || this.transferred.has(number) || !this.issues.has(number)) return this.json(res, 404, { message: 'Not Found' });
      return this.listComments(req, res, query, route, number);
    }
    if (kind === 'issue') {
      if (route.startsWith('/repositories/')) {
        const number = Number(/\/issues\/(\d+)$/.exec(route)?.[1]);
        return this.json(res, 200, {
          ...this.issueJson(this.must(number)),
          repository_url: `${this.apiBase(host)}/repositories/${route.split('/')[2]}`,
        });
      }
      const number = Number(/\/issues\/(\d+)$/.exec(route)?.[1]);
      if (this.renamed && !this.deleted.has(number) && this.issues.has(number) && !this.transferred.has(number)) {
        res.writeHead(301, { location: `/repositories/${this.repoId}/issues/${number}` });
        return void res.end();
      }
      if (this.deleted.has(number) || !this.issues.has(number)) return this.json(res, 410, { message: 'This issue was deleted' });
      if (this.transferred.has(number)) {
        res.writeHead(301, { location: `/repositories/999/issues/${number}` });
        return void res.end();
      }
      return this.json(res, 200, this.issueJson(this.must(number)));
    }
    this.json(res, 404, { message: 'Not Found' });
  }

  // -- REST bodies ------------------------------------------------------------------------------------

  private userJson(user: StubUser | null): unknown {
    return user ? { login: user.login, type: user.bot ? 'Bot' : 'User' } : null;
  }

  private issueJson(issue: StubIssue): Record<string, unknown> {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.stateReason,
      html_url: `https://github.com/${OWNER}/${REPO}/${issue.pullRequest ? 'pull' : 'issues'}/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      user: this.userJson(issue.user),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`,
      ...(issue.pullRequest ? { pull_request: { url: 'x' } } : {}),
    };
  }

  private visibleIssues(): StubIssue[] {
    return [...this.issues.values()].filter((issue) => !this.deleted.has(issue.number) && !this.transferred.has(issue.number));
  }

  private paginate<T>(
    rows: T[],
    query: Record<string, string>,
    route: string,
    res: http.ServerResponse,
    map: (row: T) => unknown,
    etag: boolean,
    req?: http.IncomingMessage,
  ): void {
    const size = Math.min(Number(query.per_page ?? 30), this.restPageSize);
    const page = Math.max(1, Number(query.page ?? 1));
    const slice = rows.slice((page - 1) * size, page * size);
    const headers: Record<string, string> = {};
    if (page * size < rows.length) {
      const next = new URLSearchParams({ ...query, page: String(page + 1) });
      const origin = this.nextLinkHost ? `http://${this.nextLinkHost}:${this.port}` : `http://${(req?.headers.host ?? 'unused').toString()}`;
      headers.link = `<${origin}${route}?${next.toString()}>; rel="next"`;
    }
    const body = JSON.stringify(slice.map(map));
    if (etag) {
      const tag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
      headers.etag = tag;
      if (req?.headers['if-none-match'] === tag) {
        res.writeHead(304, headers);
        return void res.end();
      }
    }
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(body);
  }

  private listIssues(req: http.IncomingMessage, res: http.ServerResponse, query: Record<string, string>, route: string): void {
    let rows = this.visibleIssues();
    if (query.state && query.state !== 'all') rows = rows.filter((issue) => issue.state === query.state);
    if (query.since) {
      const since = Date.parse(query.since);
      rows = rows.filter((issue) => Date.parse(issue.updatedAt) >= since);
    }
    const key = query.sort === 'updated' ? 'updatedAt' : 'createdAt';
    const sign = query.direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => sign * (Date.parse(a[key]) - Date.parse(b[key])) || sign * (a.number - b.number));
    this.paginate(rows, query, route, res, (issue) => this.issueJson(issue), true, req);
  }

  private listComments(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: Record<string, string>,
    route: string,
    issueNumber: number | null,
  ): void {
    let rows = this.comments.filter((c) => !this.deleted.has(c.issueNumber) && !this.transferred.has(c.issueNumber));
    if (issueNumber !== null) rows = rows.filter((c) => c.issueNumber === issueNumber);
    if (query.since) {
      const since = Date.parse(query.since);
      rows = rows.filter((c) => Date.parse(c.updatedAt) >= since);
    }
    rows.sort((a, b) => a.id - b.id);
    this.paginate(
      rows,
      query,
      route,
      res,
      (c) => ({
        id: c.id,
        body: c.body,
        user: this.userJson(c.user),
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        issue_url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/${c.issueNumber}`,
        html_url: `https://github.com/${OWNER}/${REPO}/${this.issues.get(c.issueNumber)?.pullRequest ? 'pull' : 'issues'}/${c.issueNumber}#issuecomment-${c.id}`,
      }),
      false,
      req,
    );
  }

  // -- GraphQL ----------------------------------------------------------------------------------------

  private actor(user: StubUser | null): unknown {
    return user ? { login: user.login, __typename: user.bot ? 'Bot' : 'User' } : null;
  }

  private connection<T>(rows: T[], first: number, after: unknown, cap: number, map: (row: T) => unknown): unknown {
    const size = Math.min(first, cap);
    const start = typeof after === 'string' ? Number(after) : 0;
    const slice = rows.slice(start, start + size);
    const more = start + size < rows.length;
    return { pageInfo: { hasNextPage: more, endCursor: more ? String(start + size) : null }, nodes: slice.map(map) };
  }

  private commentNode(c: StubDiscussionComment): unknown {
    return {
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      isAnswer: c.isAnswer,
      author: this.actor(c.author),
      replies: this.connection(c.replies, 50, null, this.commentPageSize, (r) => ({
        id: r.id,
        body: r.body,
        createdAt: r.createdAt,
        isAnswer: r.isAnswer,
        author: this.actor(r.author),
      })),
    };
  }

  private async graphql(res: http.ServerResponse, query: string, variables: Record<string, unknown>): Promise<void> {
    const field = query.includes('field: CREATED_AT') ? 'createdAt' : 'updatedAt';
    const sorted = (): StubDiscussion[] =>
      [...this.discussions.values()].sort((a, b) => Date.parse(b[field]) - Date.parse(a[field]) || b.number - a.number);

    if (query.includes('node(id: $id)')) {
      const id = String(variables.id);
      if (query.includes('... on DiscussionComment')) {
        for (const d of this.discussions.values()) {
          const comment = d.comments.find((c) => c.id === id);
          if (comment) {
            return this.json(res, 200, {
              data: {
                node: {
                  replies: this.connection(comment.replies, 50, variables.after, this.commentPageSize, (r) => ({
                    id: r.id,
                    body: r.body,
                    createdAt: r.createdAt,
                    isAnswer: r.isAnswer,
                    author: this.actor(r.author),
                  })),
                },
              },
            });
          }
        }
        return this.json(res, 200, { data: { node: null } });
      }
      const discussion = [...this.discussions.values()].find((d) => d.id === id);
      if (!discussion) return this.json(res, 200, { data: { node: null } });
      return this.json(res, 200, {
        data: { node: { comments: this.connection(discussion.comments, 50, variables.after, this.commentPageSize, (c) => this.commentNode(c)) } },
      });
    }

    if (variables.owner !== OWNER || variables.name !== REPO) {
      return this.json(res, 200, {
        data: { repository: null },
        errors: [
          { type: 'NOT_FOUND', message: `Could not resolve to a Repository with the name '${String(variables.owner)}/${String(variables.name)}'.` },
        ],
      });
    }
    if (/discussions\(first: 1,/.test(query)) {
      const top = sorted()[0];
      return this.json(res, 200, { data: { repository: { discussions: { nodes: top ? [{ number: top.number, updatedAt: top.updatedAt }] : [] } } } });
    }
    this.json(res, 200, {
      data: {
        repository: {
          discussions: this.connection(sorted(), 20, variables.after, this.discussionPageSize, (d) => ({
            id: d.id,
            number: d.number,
            title: d.title,
            url: `https://github.com/${OWNER}/${REPO}/discussions/${d.number}`,
            body: d.body,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            closed: d.closed,
            isAnswered: d.answered,
            author: this.actor(d.author),
            category: { name: d.category },
            labels: { nodes: d.labels.map((name) => ({ name })) },
            comments: this.connection(d.comments, 50, null, this.commentPageSize, (c) => this.commentNode(c)),
          })),
        },
      },
    });
    this.afterDiscussionPage?.();
  }
}
