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
 * **Two deployments, one contract.** Confluence Cloud serves REST v1 under `<site>/wiki/rest/api` and
 * authenticates with an Atlassian account e-mail and an API token over HTTP Basic. Confluence Data
 * Center serves the same REST v1 resources under `<base>/rest/api` — the base being wherever the
 * instance is mounted, context path included — and authenticates with a personal access token as a
 * bearer. The operator says which one a source is; nothing here guesses, because a guess that picks
 * the wrong auth scheme fails as "401" and a guess that picks the wrong pagination fails as a wiki that
 * looks half-indexed. What the two share is everything that matters to correctness: the CQL scope
 * (`cqlFor`), the search endpoint the listing and the probe both ask, and the storage-format body.
 *
 * **Data Center 7.9 and later.** Personal access tokens arrived in 7.9; an older instance cannot be
 * authenticated the way this client authenticates, so it is refused by name (see
 * `checkDataCenterVersion`) rather than left to answer 401 forever. Server — the product line before
 * Data Center — is not a supported deployment even where the version number would pass.
 */

import type { Logger } from '../../context.js';
import { confluenceEgress } from './confluence-egress.js';

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

/** Which Confluence a source talks to. The operator chooses; nothing detects it. */
export type ConfluenceDeployment = 'cloud' | 'datacenter';

/** What a Data Center instance says about itself, before any credential is used. */
export interface ConfluenceServerInfo {
  /** `8.5.6`, as the instance reports it. */
  version: string;
  /** `confluence` for Confluence; anything else is a different Atlassian product at that URL. */
  product: string | null;
}

export interface ConfluenceClient {
  /** Who the stored credential is. The dashboard's "Test" button, and nothing else. */
  whoAmI(): Promise<string>;
  /**
   * The instance's version, for a Data Center source only; Cloud has one version and it is "now".
   * Optional so that a test stub standing in for the REST API need not pretend to be a server.
   */
  serverInfo?(): Promise<ConfluenceServerInfo>;
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
    version?: { number?: number; when?: string };
    ancestors?: Array<{ id?: string; title?: string }>;
    _links?: { webui?: string };
  };
  lastModified?: string;
}

interface SearchResponse {
  results?: SearchResult[];
  totalSize?: number;
  /** Data Center's offset for this page of results. */
  start?: number;
  _links?: { next?: string };
}

export interface ConfluenceCredentials {
  /**
   * Cloud: `https://acme.atlassian.net/wiki`. Data Center: `https://wiki.acme.internal` or
   * `https://intranet.acme.com/confluence` — wherever the instance is served. A trailing slash is fine.
   */
  baseUrl: string;
  /** Absent means Cloud, which is what every source created before Data Center existed is. */
  deployment?: ConfluenceDeployment;
  /** Cloud: the Atlassian account the API token belongs to. Data Center: unused. */
  email: string;
  /** The API token (Cloud) or personal access token (Data Center). Never logged, never returned. */
  token: string;
}

/** The anonymous application-links manifest the Data Center version check reads. */
const MANIFEST_PATH = '/rest/applinks/1.0/manifest';

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
 *
 * **The version manifest is asked without the credential**, so a 401/403 there is never the token's
 * fault: it is a proxy, SSO front or anonymous-access policy refusing an unauthenticated request, and
 * pointing the operator at the token would send them after the wrong thing.
 */
function requestFailure(status: number, pathname: string, body: string, deployment: ConfluenceDeployment = 'cloud'): Error {
  const hint =
    deployment === 'datacenter'
      ? (status === 401 || status === 403) && pathname === MANIFEST_PATH
        ? ' — this request carries no credential, so something in front of Confluence (a proxy, SSO or an anonymous-access policy) refused it; the version check needs the manifest reachable without signing in'
        : status === 401 || status === 403
          ? ' — check the personal access token, and that its user can read the spaces this source names'
          : status === 404
            ? ' — check the base URL; for Data Center it is the address Confluence is served on, including a context path such as /confluence if it has one'
            : ''
      : status === 401 || status === 403
        ? ' — check the account e-mail and the API token, and that the account can read the spaces this source names'
        : status === 404
          ? ' — check the site URL; it should end in /wiki for a Confluence Cloud site'
          : '';
  return new Error(`Confluence answered ${status} for ${pathname}${hint}: ${body.slice(0, 200)}`);
}

/**
 * The oldest Data Center this client can authenticate against: personal access tokens are a 7.9
 * feature. Everything the client asks after authenticating — CQL search with `totalSize`, the
 * `version`/`ancestors`/`space` expansions, `body.storage` — predates it.
 */
export const MIN_DATA_CENTER_VERSION = '7.9';

function versionParts(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Refuses, by name, an instance this client does not support — and returns quietly for one it does.
 *
 * **A version that cannot be read is refused too.** The manifest is anonymous and is served by every
 * Confluence Data Center; when it is missing, the base URL is wrong, a proxy is in the way, or the
 * thing at that address is not Confluence Data Center — and in each case the honest answer is to say
 * so on "Test" rather than to proceed on an assumption and fail later as something less legible.
 */
export function checkDataCenterVersion(info: ConfluenceServerInfo): void {
  if (info.product !== null && info.product.toLowerCase() !== 'confluence') {
    throw new Error(`The server at this base URL reports itself as "${info.product}", not Confluence`);
  }
  const parts = versionParts(info.version);
  const [minMajor, minMinor] = versionParts(MIN_DATA_CENTER_VERSION) as [number, number];
  if (!parts) {
    throw new Error(
      `Could not read a Confluence version from "${info.version.slice(0, 40)}"; Confluence Data Center ${MIN_DATA_CENTER_VERSION} or later is required`,
    );
  }
  const [major, minor] = parts;
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(
      `Confluence ${info.version} is not supported: Data Center ${MIN_DATA_CENTER_VERSION} or later is required (personal access tokens were introduced in ${MIN_DATA_CENTER_VERSION})`,
    );
  }
}

/**
 * The HTTPS implementation: Confluence REST v1, one request at a time — HTTP Basic against Cloud, a
 * bearer personal access token against Data Center.
 *
 * `fetchImpl` is a parameter so that the header construction, the query strings and the redaction
 * above are all testable without a network — the alternative is a class whose only proof is that it
 * compiles.
 *
 * **Cloud's requests are the ones this class always made.** Every Data Center difference sits behind
 * `this.deployment === 'datacenter'`; a Cloud source takes none of those branches, and the Cloud
 * assertions in `test/confluence-driver.test.ts` pin the URLs and the header it sends.
 */
export class HttpConfluenceClient implements ConfluenceClient {
  private readonly base: string;
  private readonly authorization: string;
  private readonly deployment: ConfluenceDeployment;
  private lastRequest = 0;

  constructor(
    credentials: ConfluenceCredentials,
    /**
     * Every request this client makes goes through it. The default is the ADR-0088 egress with an empty
     * allowlist — the strictest it can be — so a client built without one cannot reach an internal
     * address; the driver passes one that carries `CONFLUENCE_ALLOWED_HOSTS`.
     */
    private readonly fetchImpl: FetchLike = confluenceEgress({ allowedHosts: [] }),
    private readonly log?: Logger,
  ) {
    this.base = credentials.baseUrl.replace(/\/+$/, '');
    this.deployment = credentials.deployment ?? 'cloud';
    this.authorization =
      this.deployment === 'datacenter'
        ? `Bearer ${credentials.token}`
        : `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, 'utf8').toString('base64')}`;
  }

  private async request(pathname: string, params: Record<string, string | undefined>, headers: Record<string, string>): Promise<Response> {
    const url = new URL(`${this.base}${pathname}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);

    const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequest = Date.now();

    // `url.href` and not the object: a logger that serialises a URL would print `username`/`password`
    // if either were ever set on it. They are not, and this is the line that keeps it that way.
    this.log?.debug({ pathname }, 'confluence request');
    const response = await this.fetchImpl(url.href, { method: 'GET', headers });
    if (!response.ok) throw requestFailure(response.status, pathname, await response.text().catch(() => ''), this.deployment);
    return response;
  }

  private async get(pathname: string, params: Record<string, string | undefined>): Promise<unknown> {
    const response = await this.request(pathname, params, { authorization: this.authorization, accept: 'application/json' });
    return response.json();
  }

  async whoAmI(): Promise<string> {
    const me = (await this.get('/rest/api/user/current', {})) as { displayName?: string; email?: string; accountId?: string; username?: string };
    return me.displayName ?? me.accountId ?? me.username ?? 'the configured account';
  }

  /**
   * The application-links manifest every Data Center instance serves: product type and version.
   *
   * **Asked without the credential.** The resource is anonymous, so there is no reason for the token
   * to travel to it; the fewer endpoints a bearer reaches, the fewer places a misconfigured proxy can
   * log it. JSON is asked for and XML is accepted, because which one comes back has varied by version.
   */
  async serverInfo(): Promise<ConfluenceServerInfo> {
    const response = await this.request(MANIFEST_PATH, {}, { accept: 'application/json, application/xml;q=0.9' });
    const text = await response.text();
    if (text.trimStart().startsWith('{')) {
      const body = JSON.parse(text) as { version?: unknown; typeId?: unknown };
      return {
        version: typeof body.version === 'string' ? body.version : '',
        product: typeof body.typeId === 'string' ? body.typeId : null,
      };
    }
    const tag = (name: string): string | null => new RegExp(`<${name}>([^<]{1,100})</${name}>`).exec(text)?.[1]?.trim() ?? null;
    return { version: tag('version') ?? '', product: tag('typeId') };
  }

  async listPages(cql: string, cursor?: string): Promise<ConfluencePageList> {
    // **`created`, and not `id` and not `lastmodified`.** Paging a cursor over a set somebody is
    // editing underneath you is only stable if the sort key does not move, which rules out
    // `lastmodified` — the one field a pull of this length is guaranteed to disturb. `id` has that
    // property too and is **not a documented CQL sort field**, so it would have been a guess that a
    // stub cannot refuse and a real site can; `created` is documented, never changes for a page, and
    // is all this needs. Pages created in the same second may tie, which the `seen` set in the driver
    // already absorbs. The probe orders the other way because it asks for exactly one row.
    if (this.deployment === 'datacenter') return this.listPagesDataCenter(cql, cursor);
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

  /**
   * Data Center pages its search by offset (`start`), and newer releases also offer a cursor in the
   * `next` link. Whichever the link carries is what the next request sends back, wrapped so that the
   * driver still sees one opaque string. **An empty page ends the listing** even if a `next` link came
   * with it: an offset that does not advance is a loop, and `MAX_PAGES` would be its only exit.
   */
  private async listPagesDataCenter(cql: string, cursor?: string): Promise<ConfluencePageList> {
    const resume = parseDataCenterCursor(cursor);
    const body = (await this.get('/rest/api/search', {
      cql: `${cql} order by created asc`,
      limit: '50',
      expand: SEARCH_EXPAND,
      ...(resume?.kind === 'cursor' ? { cursor: resume.value } : {}),
      ...(resume?.kind === 'start' ? { start: resume.value } : {}),
    })) as SearchResponse;
    const raw = body.results ?? [];
    const results = raw.map((r) => this.toSummary(r)).filter((page): page is ConfluencePageSummary => page !== null);
    const start = resume?.kind === 'start' ? Number(resume.value) : typeof body.start === 'number' ? body.start : 0;
    const next = raw.length > 0 ? dataCenterNext(body._links?.next, start + raw.length) : undefined;
    return { results, ...(next ? { nextCursor: next } : {}) };
  }

  async revision(cql: string): Promise<ConfluenceRevision> {
    const body = (await this.get('/rest/api/search', {
      cql: `${cql} order by lastmodified desc`,
      limit: '1',
      expand: SEARCH_EXPAND,
    })) as SearchResponse;
    if (this.deployment === 'datacenter') {
      // **A missing count is not a zero.** `pages=0` would compare equal to every later `pages=0` and
      // the scheduler would skip a wiki it cannot see; a throw is "run it", which is the safe answer.
      if (typeof body.totalSize !== 'number') throw new Error('Confluence did not report totalSize for /rest/api/search');
      const first = body.results?.[0];
      return { total: body.totalSize, newest: first ? this.modifiedOf(first) || null : null };
    }
    return { total: body.totalSize ?? 0, newest: body.results?.[0]?.lastModified ?? null };
  }

  async storage(id: string): Promise<string> {
    const body = (await this.get(`/rest/api/content/${encodeURIComponent(id)}`, { expand: 'body.storage' })) as {
      body?: { storage?: { value?: string } };
    };
    return body.body?.storage?.value ?? '';
  }

  /**
   * When a search result was last modified. Cloud reports `lastModified` as ISO-8601 and that is what
   * it has always used. Data Center's search result carries it as well, but the content's own
   * `version.when` is the field both releases agree on — so a Data Center result that has no parseable
   * `lastModified` falls back to it rather than to an empty string a probe would compare against.
   */
  private modifiedOf(raw: SearchResult): string {
    if (this.deployment !== 'datacenter') return raw.lastModified ?? '';
    if (raw.lastModified && ISO_TIMESTAMP.test(raw.lastModified)) return raw.lastModified;
    return raw.content?.version?.when ?? '';
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
      lastModified: this.modifiedOf(raw),
      ancestors: (content.ancestors ?? [])
        .filter((a): a is { id: string; title: string } => typeof a.id === 'string' && typeof a.title === 'string')
        .map((a) => ({ id: a.id, title: a.title })),
      webUrl: webui ? `${this.base}${webui.startsWith('/') ? '' : '/'}${webui}` : '',
    };
  }
}

/**
 * An ISO-8601 timestamp, which is what the probe token compares. `Date.parse` is not the test: it also
 * accepts display text such as "Sep 02, 2026", which would put a day-granular string into the token.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Confluence answers a next page as a relative link; the only part of it that is ours to keep is the cursor. */
function nextCursor(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    return new URL(link, 'https://confluence.invalid').searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

/** `cursor:<opaque>` or `start:<offset>` — the Data Center resume point, as one string for the driver. */
function parseDataCenterCursor(cursor: string | undefined): { kind: 'cursor' | 'start'; value: string } | null {
  if (!cursor) return null;
  if (cursor.startsWith('cursor:')) return { kind: 'cursor', value: cursor.slice('cursor:'.length) };
  if (cursor.startsWith('start:') && /^\d+$/.test(cursor.slice('start:'.length))) return { kind: 'start', value: cursor.slice('start:'.length) };
  return null;
}

/**
 * The Data Center resume point after this page: the link's cursor if it has one, its `start` if it has
 * that, and otherwise the offset just past what this response returned. No link means no next page.
 */
function dataCenterNext(link: string | undefined, fallbackStart: number): string | undefined {
  if (!link) return undefined;
  let params: URLSearchParams;
  try {
    params = new URL(link, 'https://confluence.invalid').searchParams;
  } catch {
    return undefined;
  }
  const cursor = params.get('cursor');
  if (cursor) return `cursor:${cursor}`;
  const start = params.get('start');
  if (start && /^\d+$/.test(start)) return `start:${start}`;
  return `start:${fallbackStart}`;
}
