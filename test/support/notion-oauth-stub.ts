import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the parts of Notion that the OAuth flow ([ADR-0129](../../.ssot/ADR.md#adr-0129))
 * touches, on a real loopback port: the authorize page, `POST /v1/oauth/token` (authorization-code and
 * rotating refresh grants, HTTP Basic) and the handful of API endpoints a sync reads.
 *
 * **It behaves the way Notion is documented to**, because the point of the tests built on it is the
 * behaviours that are easy to get wrong: a refresh token is single-use (the old one is `invalid_grant`
 * the moment a new pair is issued), an access token that is not the current one is `401 unauthorized`,
 * and a code can be spent once. It keeps counters instead of mocks so a test asserts what was asked of
 * Notion, not what a mock was told to say.
 *
 * Nothing here is a real credential: every token is `stub-…`.
 */

export interface StubNotionPage {
  id: string;
  title: string;
  lastEdited: string;
  paragraphs: string[];
  /** The page this one sits under; the parent lists it as a `child_page` block. */
  parentId?: string;
}

export interface StubTokenRequest {
  grantType: string;
  /** Whether the HTTP Basic credentials were the ones this stub was configured with. */
  authorised: boolean;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const rt = (text: string) => ({ type: 'text', plain_text: text, text: { content: text } });

export class StubNotionOAuth {
  readonly clientId = 'stub-client-id';
  readonly clientSecret = 'stub-client-secret';
  readonly workspaceName = 'Stub Workspace';
  readonly workspaceId = 'ws-stub-0001';
  readonly botId = 'bot-stub-0001';

  pages: StubNotionPage[] = [];
  /** Every call to `/v1/oauth/token`, in order. */
  readonly tokenRequests: StubTokenRequest[] = [];
  /** Every API call that carried a valid or invalid bearer, as `<METHOD> <path>`. */
  readonly apiCalls: string[] = [];
  /** How many API calls were answered `401`. */
  unauthorizedResponses = 0;
  /** Set to make the next authorize hop come back with `error=access_denied`, like pressing Cancel. */
  denyNextAuthorization = false;
  /** When set, the token endpoint answers every grant with this status and no body, like Notion having an outage. */
  tokenFailureStatus: number | null = null;
  /** Counts down with each authorised API call; at zero the access token stops working (expiry in the middle of a sync). */
  private callsUntilExpiry: number | null = null;
  /** Slows the token endpoint down, so two refreshes can be made to overlap. */
  tokenDelayMs = 0;

  private server: http.Server | undefined;
  private counter = 0;
  private readonly codes = new Map<string, { redirectUri: string }>();
  private validAccess = new Set<string>();
  private validRefresh = new Set<string>();
  private lastAccess = '';
  private lastRefresh = '';

  /** `http://127.0.0.1:<port>`; valid after `start()`. */
  get url(): string {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (!address) throw new Error('The Notion stub is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  /** The access token Notion would currently accept, for a test that needs to put one into a row. */
  get currentAccessToken(): string {
    return this.lastAccess;
  }

  get currentRefreshToken(): string {
    return this.lastRefresh;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(() =>
        json(res, 500, { object: 'error', status: 500, code: 'internal_server_error', message: 'stub failure' }),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  /** Issues a pair outright, as if the person had authorised earlier. */
  issuePair(): { accessToken: string; refreshToken: string } {
    const accessToken = `stub-access-${++this.counter}`;
    const refreshToken = `stub-refresh-${++this.counter}`;
    // A new pair retires the previous one: that is what rotation means.
    this.validAccess = new Set([accessToken]);
    this.validRefresh = new Set([refreshToken]);
    this.lastAccess = accessToken;
    this.lastRefresh = refreshToken;
    return { accessToken, refreshToken };
  }

  /** The access token stops working (expiry, or a revoked grant) but the refresh token is still good. */
  expireAccessToken(): void {
    this.validAccess = new Set();
  }

  /** The access token is accepted for `calls` more API calls and refused after that. */
  expireAccessTokenAfter(calls: number): void {
    this.callsUntilExpiry = calls;
  }

  /** The person removed the connection in Notion: nothing that was issued works any more. */
  revokeEverything(): void {
    this.validAccess = new Set();
    this.validRefresh = new Set();
  }

  get refreshGrants(): number {
    return this.tokenRequests.filter((r) => r.grantType === 'refresh_token').length;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  private basicOk(req: http.IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    return req.headers.authorization === expected;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/v1/oauth/authorize') {
      if (url.searchParams.get('client_id') !== this.clientId) return json(res, 400, { error: 'invalid_client' });
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const target = new URL(redirectUri);
      if (this.denyNextAuthorization) {
        this.denyNextAuthorization = false;
        target.searchParams.set('error', 'access_denied');
      } else {
        const code = `stub-code-${randomBytes(6).toString('hex')}`;
        this.codes.set(code, { redirectUri });
        target.searchParams.set('code', code);
      }
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }

    if (method === 'POST' && url.pathname === '/v1/oauth/token') {
      const body = JSON.parse((await this.readBody(req)) || '{}') as Record<string, string>;
      const authorised = this.basicOk(req);
      this.tokenRequests.push({ grantType: String(body.grant_type), authorised });
      if (this.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
      if (!authorised) return json(res, 401, { error: 'invalid_client' });
      if (this.tokenFailureStatus !== null) {
        res.writeHead(this.tokenFailureStatus);
        return void res.end();
      }
      if (body.grant_type === 'authorization_code') {
        const issued = this.codes.get(body.code);
        if (!issued || issued.redirectUri !== body.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
        this.codes.delete(body.code);
      } else if (body.grant_type === 'refresh_token') {
        if (!this.validRefresh.has(body.refresh_token)) return json(res, 400, { error: 'invalid_grant' });
      } else {
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      const pair = this.issuePair();
      return json(res, 200, {
        access_token: pair.accessToken,
        token_type: 'bearer',
        refresh_token: pair.refreshToken,
        bot_id: this.botId,
        workspace_id: this.workspaceId,
        workspace_name: this.workspaceName,
        workspace_icon: null,
        owner: { type: 'user' },
        duplicated_template_id: null,
      });
    }

    // The API proper: a bearer that is not the current one is `unauthorized`, as a revoked or expired one is.
    this.apiCalls.push(`${method} ${url.pathname}`);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !this.validAccess.has(bearer)) {
      this.unauthorizedResponses++;
      return json(res, 401, { object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' });
    }
    if (this.callsUntilExpiry !== null && --this.callsUntilExpiry <= 0) {
      this.callsUntilExpiry = null;
      this.validAccess = new Set();
    }
    const pageRoute = /^\/v1\/pages\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && pageRoute) {
      const page = this.pages.find((p) => p.id === pageRoute[1]);
      return page
        ? json(res, 200, this.asPage(page))
        : json(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'not found' });
    }
    if (method === 'GET' && url.pathname === '/v1/users/me') return json(res, 200, { object: 'user', type: 'bot', name: 'Stub bot' });
    if (method === 'POST' && url.pathname === '/v1/search') {
      const body = JSON.parse((await this.readBody(req)) || '{}') as { sort?: { direction?: string }; page_size?: number };
      const all = [...this.pages].sort((a, b) => b.lastEdited.localeCompare(a.lastEdited));
      const picked = body.sort?.direction === 'descending' && body.page_size === 1 ? all.slice(0, 1) : this.pages;
      return json(res, 200, { object: 'list', results: picked.map((p) => this.asPage(p)), next_cursor: null, has_more: false });
    }
    const children = /^\/v1\/blocks\/([^/]+)\/children$/.exec(url.pathname);
    if (method === 'GET' && children) {
      const page = this.pages.find((p) => p.id === children[1]);
      const results: Array<Record<string, unknown>> = (page?.paragraphs ?? []).map((text, i) => ({
        object: 'block',
        id: `${children[1]}-b${i}`,
        type: 'paragraph',
        has_children: false,
        paragraph: { rich_text: [rt(text)] },
      }));
      for (const child of this.pages.filter((p) => p.parentId === children[1])) {
        results.push({ object: 'block', id: child.id, type: 'child_page', has_children: true, child_page: { title: child.title } });
      }
      return json(res, 200, { object: 'list', results, next_cursor: null, has_more: false });
    }
    return json(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'not found' });
  }

  private asPage(p: StubNotionPage): Record<string, unknown> {
    return {
      object: 'page',
      id: p.id,
      url: `https://www.notion.so/${p.id}`,
      last_edited_time: p.lastEdited,
      parent: p.parentId ? { type: 'page_id', page_id: p.parentId } : { type: 'workspace', workspace: true },
      properties: { Name: { type: 'title', title: [rt(p.title)] } },
    };
  }
}
