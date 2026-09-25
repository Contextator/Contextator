/**
 * A Confluence **Data Center** stand-in that is an actual HTTP server on the loopback interface.
 *
 * The Cloud suite drives the driver through a `ConfluenceClient` stub, which pins what the driver asks
 * but not how a request is spelled. For Data Center the spelling *is* the feature — the base path, the
 * bearer, the offset paging, the version manifest — so this answers real HTTP and the driver under
 * test builds its own client from a stored, encrypted token exactly as production does.
 *
 * It is modelled on Data Center's REST v1 as its documentation describes it: `/rest/api/search` with
 * `start`/`limit` and a `next` link carrying `start`, `totalSize` beside the results, `version.when`
 * on the content, and `/rest/applinks/1.0/manifest` reporting the product and version anonymously.
 * **Nothing here reaches a network beyond 127.0.0.1**, and the token is not a real one.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StubPage } from './confluence-stub.js';

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  authorization: string | undefined;
}

export class DataCenterServer {
  readonly requests: RecordedRequest[] = [];
  /** What the manifest reports. */
  version = '8.5.6';
  product = 'confluence';
  /** Results per search response, so the offset paging is really followed. */
  pageSize = 1;
  /** `start` (Data Center's documented shape) or `cursor` (what newer releases put in the link). */
  paging: 'start' | 'cursor' = 'start';
  /** Leave `totalSize` out of search responses, the way a response the client cannot trust would. */
  omitTotalSize = false;
  /** Send `lastModified` as display text instead of ISO-8601, so the `version.when` fallback is exercised. */
  friendlyLastModified = false;
  private server?: http.Server;

  constructor(
    private pages: StubPage[],
    readonly token: string,
    /** The context path the instance is mounted on. */
    readonly contextPath = '/confluence',
  ) {}

  setPages(pages: StubPage[]): void {
    this.pages = pages;
  }

  get baseUrl(): string {
    if (!this.server) throw new Error('DataCenterServer.start() has not been called');
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${this.contextPath}`;
  }

  /** Requests under `/rest/api`, with the context path stripped — what the client asked the API. */
  apiCalls(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith('/rest/api/'));
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Answers and returns `undefined`, so a handler can `return this.send(...)` on every branch. */
  private send(res: http.ServerResponse, status: number, body: unknown): undefined {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return undefined;
  }

  private inScope(cql: string): StubPage[] {
    const keys = [...cql.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return keys.length === 0 ? this.pages : this.pages.filter((p) => keys.includes(p.spaceKey));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): undefined {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(`${this.contextPath}/`)) return this.send(res, 404, { message: 'no context path' });
    const path = url.pathname.slice(this.contextPath.length);
    const params = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ method: req.method ?? 'GET', path, params, authorization: req.headers.authorization });

    if (path === '/rest/applinks/1.0/manifest') {
      return this.send(res, 200, { id: 'a1b2', name: 'Acme Wiki', typeId: this.product, version: this.version, buildNumber: 8703 });
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.send(res, 401, { statusCode: 401, message: 'Unauthorized' });

    if (path === '/rest/api/user/current') {
      return this.send(res, 200, { type: 'known', username: 'docs-bot', userKey: 'ff80', displayName: 'Docs Bot' });
    }
    if (path === '/rest/api/search') return this.search(res, params);
    const content = /^\/rest\/api\/content\/([^/]+)$/.exec(path);
    if (content) {
      const page = this.pages.find((p) => p.id === decodeURIComponent(content[1]));
      if (!page) return this.send(res, 404, { statusCode: 404, message: `No content found with id: ${content[1]}` });
      return this.send(res, 200, {
        id: page.id,
        type: 'page',
        title: page.title,
        body: { storage: { value: page.storage, representation: 'storage' } },
      });
    }
    return this.send(res, 404, { statusCode: 404, message: 'Not found' });
  }

  private search(res: http.ServerResponse, params: Record<string, string>): undefined {
    const [scope, order] = (params.cql ?? '').split(/ order by /);
    const all = [...this.inScope(scope)];
    if (order === 'lastmodified desc') all.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    const limit = Number(params.limit ?? '25');
    const start = params.cursor ? Number(Buffer.from(params.cursor, 'base64url').toString('utf8')) : Number(params.start ?? '0');
    const size = Math.min(limit, this.pageSize);
    const slice = all.slice(start, start + size);
    const nextStart = start + slice.length;
    const nextParams = new URLSearchParams({ cql: params.cql ?? '', limit: String(limit) });
    if (this.paging === 'cursor') nextParams.set('cursor', Buffer.from(String(nextStart)).toString('base64url'));
    else nextParams.set('start', String(nextStart));
    return this.send(res, 200, {
      results: slice.map((p) => ({
        content: {
          id: p.id,
          type: 'page',
          status: 'current',
          title: p.title,
          space: { key: p.spaceKey },
          version: { number: p.version, when: p.lastModified },
          ancestors: p.ancestors.map((a) => ({ id: a.id, title: a.title, type: 'page' })),
          _links: { webui: `/display/${p.spaceKey}/${encodeURIComponent(p.title).replace(/%20/g, '+')}` },
        },
        title: p.title,
        lastModified: this.friendlyLastModified ? 'Sep 02, 2026' : p.lastModified,
        friendlyLastModified: 'Sep 02, 2026',
      })),
      start,
      limit,
      size: slice.length,
      ...(this.omitTotalSize ? {} : { totalSize: all.length }),
      cqlQuery: params.cql,
      _links: {
        base: this.baseUrl,
        context: this.contextPath,
        ...(nextStart < all.length ? { next: `/rest/api/search?${nextParams.toString()}` } : {}),
      },
    });
  }
}
