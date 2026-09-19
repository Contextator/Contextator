/**
 * A `ConfluenceClient` that answers out of an array and records what it was asked, plus the small page
 * tree both the unit and the integration suite drive the Confluence source with
 * ([ADR-0059](../../.ssot/ADR.md#adr-0059)).
 *
 * It lives here rather than in one of the two test files because the *same* fixture has to reach both:
 * the unit suite asserts the paths and the probe arithmetic, and the integration suite asserts that
 * those paths become documents an agent can find — and a second copy of the tree would let the two
 * drift until they were testing different products.
 *
 * **Nothing in it reaches a network.** That is the point of the seam; the driver takes this object.
 */

import type {
  ConfluenceClient,
  ConfluencePageList,
  ConfluencePageSummary,
  ConfluenceRevision,
} from '../../src/services/sources/confluence-client.js';

export const SPACE = 'ENG';
export const OTHER_SPACE = 'MKT';

export interface StubPage {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  lastModified: string;
  ancestors: Array<{ id: string; title: string }>;
  storage: string;
}

/**
 * Answers the four calls of `ConfluenceClient` out of an array, and **records the CQL of every one of
 * them**. That recording is the point: the claim this connector's cost rests on is that the probe
 * measures the set the sync lists, and the only way to see whether two queries are the same question
 * is to compare the questions.
 */
export class StubConfluence implements ConfluenceClient {
  readonly calls: string[] = [];
  /** Every CQL string this stub was handed, labelled by the call that carried it. */
  readonly queries: Array<{ call: 'list' | 'revision'; cql: string }> = [];
  /** Set to make every call reject, the way a revoked token does. */
  failWith: string | null = null;
  /** Pages per listing response, so paging is exercised rather than assumed. */
  pageSize = 2;

  constructor(private store: StubPage[]) {}

  setPages(pages: StubPage[]): void {
    this.store = pages;
  }

  private guard(): void {
    if (this.failWith) throw new Error(this.failWith);
  }

  /** The stub's own reading of a CQL scope, so "in scope" means the same thing here as in production. */
  private inScope(cql: string): StubPage[] {
    const keys = [...cql.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return keys.length === 0 ? this.store : this.store.filter((p) => keys.includes(p.spaceKey));
  }

  async whoAmI(): Promise<string> {
    this.calls.push('whoAmI');
    this.guard();
    return 'Docs Bot';
  }

  async listPages(cql: string, cursor?: string): Promise<ConfluencePageList> {
    this.calls.push(`list:${cursor ?? 'first'}`);
    this.queries.push({ call: 'list', cql });
    this.guard();
    const all = this.inScope(cql);
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return {
      results: slice.map((p) => summaryOf(p)),
      ...(next < all.length ? { nextCursor: String(next) } : {}),
    };
  }

  async revision(cql: string): Promise<ConfluenceRevision> {
    this.calls.push('revision');
    this.queries.push({ call: 'revision', cql });
    this.guard();
    const all = this.inScope(cql);
    const newest = [...all].sort((a, b) => b.lastModified.localeCompare(a.lastModified))[0];
    return { total: all.length, newest: newest?.lastModified ?? null };
  }

  async storage(id: string): Promise<string> {
    this.calls.push(`storage:${id}`);
    this.guard();
    const page = this.store.find((p) => p.id === id);
    if (!page) throw new Error(`No content found with id ${id}`);
    return page.storage;
  }
}

export function summaryOf(p: StubPage): ConfluencePageSummary {
  return {
    id: p.id,
    title: p.title,
    spaceKey: p.spaceKey,
    version: p.version,
    lastModified: p.lastModified,
    ancestors: p.ancestors,
    webUrl: `https://acme.atlassian.net/wiki/spaces/${p.spaceKey}/pages/${p.id}`,
  };
}

export const HANDBOOK: StubPage = {
  id: '100001',
  title: 'Engineering Handbook',
  spaceKey: SPACE,
  version: 4,
  lastModified: '2026-09-01T10:00:00.000Z',
  ancestors: [],
  storage: '<p>Everything an engineer needs.</p><h2>Scope</h2><p>All of it.</p>',
};

export const ROTATION: StubPage = {
  id: '100002',
  title: 'Kurulum Rehberi',
  spaceKey: SPACE,
  version: 2,
  lastModified: '2026-09-02T10:00:00.000Z',
  ancestors: [{ id: HANDBOOK.id, title: HANDBOOK.title }],
  storage:
    '<p>Once <strong>kurulum</strong> yapin.</p>' +
    '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
    '<ac:parameter ac:name="language">bash</ac:parameter>' +
    '<ac:plain-text-body><![CDATA[npm ci && npm run build]]></ac:plain-text-body>' +
    '</ac:structured-macro>',
};

export const CAMPAIGN: StubPage = {
  id: '200001',
  title: 'Campaign Plan',
  spaceKey: OTHER_SPACE,
  version: 1,
  lastModified: '2026-09-15T10:00:00.000Z',
  ancestors: [],
  storage: '<p>Not this source.</p>',
};
