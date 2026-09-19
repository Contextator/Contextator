/**
 * The Confluence REST surface this product uses, as an interface the driver talks to and an HTTPS
 * implementation of it ([ADR-0059](../../../.ssot/ADR.md#adr-0059)).
 *
 * **It is an interface so that the driver can be driven without a network.** `NotionDriver` takes an
 * injected `Client` for the same reason; here the seam is one level lower, because the thing worth
 * pinning down is not only what the driver does with the answers but **which question it asked** — the
 * scope of the CQL is the whole of the probe's correctness, and an assertion about it needs the query
 * string itself.
 *
 * **Confluence Cloud only** — the REST v1 endpoints under `/wiki/rest/api`, authenticated with an
 * Atlassian account e-mail and an API token over HTTP Basic. Data Center and Server publish a
 * different API at a different base path and authenticate with a personal access token as a bearer;
 * they are not supported, they are not half-supported, and `README.md` says so rather than letting an
 * operator discover it from a 404.
 */

import type { Logger } from '../../context.js';

/**
 * One page as a listing answers for it — **everything the layout of the tree needs, and no body**.
 *
 * `ancestors` is on this object and not only on the full read, and that is what makes the incremental
 * skip possible at all: a page whose version did not move is never fetched, so if its path could only
 * be derived from a full read, the first unchanged run would not know where its own file lives.
 */
export interface ConfluencePageSummary {
  id: string;
  title: string;
  spaceKey: string;
  /** Confluence's own version counter. It increments on every edit, which is what the skip compares. */
  version: number;
  /** ISO-8601, as the search endpoint reports it. */
  lastModified: string;
  /** The parent chain, outermost first. Empty for a page sitting at the root of its space. */
  ancestors: Array<{ id: string; title: string }>;
  /** Absolute URL of the page in Confluence, for the front matter. */
  webUrl: string;
}

/**
 * What one CQL scope contains right now: how many pages, and when the newest of them was touched.
 *
 * **Both halves, because either alone is blind to half of what happens to a wiki.** A timestamp alone
 * cannot see a deletion — removing a page moves nobody's `lastModified` — and a count alone cannot see
 * an edit. Together they are the shape `directoryRevision` already uses for a folder (`files=…;mtime=…`)
 * and they cost exactly one request, because the search endpoint reports `totalSize` beside the page
 * of results it was asked for.
 */
export interface ConfluenceRevision {
  total: number;
  newest: string | null;
}

export interface ConfluencePageList {
  results: ConfluencePageSummary[];
  /** Opaque; hand it straight back to `listPages`. Absent on the last page. */
  nextCursor?: string;
}

export interface ConfluenceClient {
  /** Who the stored credential is. The dashboard's "Test" button, and nothing else. */
  whoAmI(): Promise<string>;
  /** One page of results for a CQL scope, ordered so that paging is stable. */
  listPages(cql: string, cursor?: string): Promise<ConfluencePageList>;
  /** `ConfluenceRevision` for a CQL scope: one request, `limit=1`, newest first. */
  revision(cql: string): Promise<ConfluenceRevision>;
  /** The storage format (XHTML) body of one page. The expensive call, and the one the skip avoids. */
  storage(id: string): Promise<string>;
}

/**
 * A space key as CQL will accept it, and as the config schema has already restricted it.
 *
 * Confluence space keys are alphanumeric, with `~` beginning a personal space. The schema in
 * `services/sources.ts` rejects anything else **before a key ever reaches this file**, which is what
 * makes string interpolation into a query language safe here rather than merely convenient; this
 * function is the second half of that statement, so that a key arriving from anywhere else — a config
 * written directly into the database, a restored dump — still cannot close the quote.
 */
export const SPACE_KEY_RE = /^[A-Za-z0-9~_-]{1,255}$/;

/**
 * The CQL naming exactly the pages a run would index.
 *
 * **One function, called once per sync, and the same string is handed to the listing and to the
 * probe.** That is the entire defence against the failure this kind of probe fails by: a probe that
 * measures a different set from the run it is deciding about answers "unchanged" about pages nobody
 * asked it to look at, and the source goes quiet in a way that looks exactly like a source with
 * nothing to do. Deriving both from one call site makes the two sets identical by construction rather
 * than by review, and `test/confluence-driver.test.ts` asserts the two requests carry the same string.
 *
 * An empty `spaceKeys` means every space the credential can read, which is what the Confluence search
 * endpoint answers when nothing narrows it.
 */
export function cqlFor(spaceKeys: readonly string[]): string {
  const keys = [...new Set(spaceKeys)].filter((key) => SPACE_KEY_RE.test(key)).sort();
  if (keys.length === 0) return 'type = page';
  return `type = page and space in (${keys.map((key) => `"${key}"`).join(',')})`;
}

/** Confluence Cloud's documented anonymous-ish ceiling is far above this; it is a courtesy, not a limit. */
const MIN_INTERVAL_MS = 200;

const SEARCH_EXPAND = 'content.space,content.version,content.ancestors';

interface SearchResult {
  content?: {
    id?: string;
    title?: string;
    space?: { key?: string };
    version?: { number?: number };
    ancestors?: Array<{ id?: string; title?: string }>;
    _links?: { webui?: string };
  };
  lastModified?: string;
}

interface SearchResponse {
  results?: SearchResult[];
  totalSize?: number;
  _links?: { next?: string };
}

export interface ConfluenceCredentials {
  /** `https://acme.atlassian.net/wiki`, with or without a trailing slash. */
  baseUrl: string;
  /** The Atlassian account the API token belongs to. */
  email: string;
  /** The API token itself. Never logged, never put in a message, never returned. */
  token: string;
}

/** Just enough of `fetch` to be replaceable in a test without any of it reaching a network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>;

/**
 * An error an operator can act on, from a response nobody should ever see the whole of.
 *
 * **The body is cut and the request is never echoed.** A Confluence error body is JSON that repeats
 * neither the credential nor the header, but "include the response so the message is useful" is
 * exactly how a token ends up in `last_error`, which the dashboard renders and the API returns
 * ([ADR-0017](../../../.ssot/ADR.md#adr-0017)). What this says instead is the status, the path, and
 * the first 200 characters of the body — enough to tell a wrong site from a wrong token from a space
 * that was renamed.
 */
function requestFailure(status: number, pathname: string, body: string): Error {
  const hint =
    status === 401 || status === 403
      ? ' — check the account e-mail and the API token, and that the account can read the spaces this source names'
      : status === 404
        ? ' — check the site URL; it should end in /wiki for a Confluence Cloud site'
        : '';
  return new Error(`Confluence answered ${status} for ${pathname}${hint}: ${body.slice(0, 200)}`);
}

/**
 * The HTTPS implementation: Confluence Cloud REST v1, HTTP Basic, one request at a time.
 *
 * `fetchImpl` is a parameter so that the header construction, the query strings and the redaction
 * above are all testable without a network — the alternative is a class whose only proof is that it
 * compiles.
 */
export class HttpConfluenceClient implements ConfluenceClient {
  private readonly base: string;
  private readonly authorization: string;
  private lastRequest = 0;

  constructor(
    credentials: ConfluenceCredentials,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly log?: Logger,
  ) {
    this.base = credentials.baseUrl.replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, 'utf8').toString('base64')}`;
  }

  private async get(pathname: string, params: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(`${this.base}${pathname}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);

    const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequest = Date.now();

    // `url.href` and not the object: a logger that serialises a URL would print `username`/`password`
    // if either were ever set on it. They are not, and this is the line that keeps it that way.
    this.log?.debug({ pathname }, 'confluence request');
    const response = await this.fetchImpl(url.href, {
      method: 'GET',
      headers: { authorization: this.authorization, accept: 'application/json' },
    });
    if (!response.ok) throw requestFailure(response.status, pathname, await response.text().catch(() => ''));
    return response.json();
  }

  async whoAmI(): Promise<string> {
    const me = (await this.get('/rest/api/user/current', {})) as { displayName?: string; email?: string; accountId?: string };
    return me.displayName ?? me.accountId ?? 'the configured account';
  }

  async listPages(cql: string, cursor?: string): Promise<ConfluencePageList> {
    // **`created`, and not `id` and not `lastmodified`.** Paging a cursor over a set somebody is
    // editing underneath you is only stable if the sort key does not move, which rules out
    // `lastmodified` — the one field a pull of this length is guaranteed to disturb. `id` has that
    // property too and is **not a documented CQL sort field**, so it would have been a guess that a
    // stub cannot refuse and a real site can; `created` is documented, never changes for a page, and
    // is all this needs. Pages created in the same second may tie, which the `seen` set in the driver
    // already absorbs. The probe orders the other way because it asks for exactly one row.
    const body = (await this.get('/rest/api/search', {
      cql: `${cql} order by created asc`,
      limit: '50',
      expand: SEARCH_EXPAND,
      cursor,
    })) as SearchResponse;
    return {
      results: (body.results ?? []).map((raw) => this.toSummary(raw)).filter((page): page is ConfluencePageSummary => page !== null),
      ...(nextCursor(body._links?.next) ? { nextCursor: nextCursor(body._links?.next) } : {}),
    };
  }

  async revision(cql: string): Promise<ConfluenceRevision> {
    const body = (await this.get('/rest/api/search', {
      cql: `${cql} order by lastmodified desc`,
      limit: '1',
      expand: SEARCH_EXPAND,
    })) as SearchResponse;
    return { total: body.totalSize ?? 0, newest: body.results?.[0]?.lastModified ?? null };
  }

  async storage(id: string): Promise<string> {
    const body = (await this.get(`/rest/api/content/${encodeURIComponent(id)}`, { expand: 'body.storage' })) as {
      body?: { storage?: { value?: string } };
    };
    return body.body?.storage?.value ?? '';
  }

  private toSummary(raw: SearchResult): ConfluencePageSummary | null {
    const content = raw.content;
    if (!content?.id || !content.title) return null;
    const webui = content._links?.webui ?? '';
    return {
      id: content.id,
      title: content.title,
      spaceKey: content.space?.key ?? '',
      version: content.version?.number ?? 0,
      lastModified: raw.lastModified ?? '',
      ancestors: (content.ancestors ?? [])
        .filter((a): a is { id: string; title: string } => typeof a.id === 'string' && typeof a.title === 'string')
        .map((a) => ({ id: a.id, title: a.title })),
      webUrl: webui ? `${this.base}${webui.startsWith('/') ? '' : '/'}${webui}` : '',
    };
  }
}

/** Confluence answers a next page as a relative link; the only part of it that is ours to keep is the cursor. */
function nextCursor(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    return new URL(link, 'https://confluence.invalid').searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}
