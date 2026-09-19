import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';
import type { DocumentSourceRow } from '../../db/schema.js';
import { decryptSecret, SecretKeyMissingError } from '../crypto.js';
import { sourceCurrentDir } from '../data-dir.js';
import { ValidationError } from '../projects.js';
import { PROBE_TOKEN_KEY, parseSourceConfig, type NotionConfig } from '../sources.js';
import { registerDriver, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
import { frontmatter, pageFileStem, pageTitle, renderBlocks, type NotionBlock } from './notion-render.js';

const MAX_PAGES = 5000;
const MAX_DEPTH = 25;
const MIN_INTERVAL_MS = 350; // ~3 requests/second, Notion's documented limit

interface PageInfo {
  id: string;
  title: string;
  url: string;
  lastEdited: string;
  parentId: string | null; // page or database/data-source id
  parentKind: 'page' | 'database' | 'workspace';
}

type AnyRecord = Record<string, unknown>;

/**
 * Notion integration (API) source: every page shared with the integration (or the configured roots and
 * their descendants) becomes one Markdown file under `<source>/current/`, nested by parent page.
 * Incremental: a page is re-rendered only when its `last_edited_time` changed.
 */
export class NotionDriver implements SourceDriver {
  private readonly cfg: NotionConfig;
  private lastRequest = 0;
  /** Roots and databases that could not be read while others could; reported on the run. */
  private readonly partialFailures: string[] = [];

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
    /** Stands in for the API in tests; in production one is built from the stored token. */
    private readonly injectedClient?: Client,
  ) {
    this.cfg = parseSourceConfig('notion', source.config);
  }

  private client(): Client {
    if (this.injectedClient) return this.injectedClient;
    if (!this.source.secretEnc) throw new SecretKeyMissingError();
    const auth = decryptSecret(this.source.secretEnc, this.ctx.config.SECRET_KEY);
    return new Client({ auth });
  }

  private async throttle<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();
    return fn();
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async test(): Promise<string> {
    const client = this.client();
    const me = (await this.throttle(() => client.users.me({}))) as AnyRecord;
    const name = (me.name as string | undefined) ?? (me.type as string | undefined) ?? 'integration';
    return `Connected as ${name}`;
  }

  private toPageInfo(page: AnyRecord): PageInfo | null {
    if (page.object !== 'page' || typeof page.id !== 'string') return null;
    const parent = (page.parent ?? {}) as { type?: string; page_id?: string; database_id?: string; data_source_id?: string };
    let parentKind: PageInfo['parentKind'] = 'workspace';
    let parentId: string | null = null;
    if (parent.type === 'page_id' && parent.page_id) {
      parentKind = 'page';
      parentId = parent.page_id;
    } else if ((parent.type === 'database_id' && parent.database_id) || (parent.type === 'data_source_id' && parent.data_source_id)) {
      parentKind = 'database';
      parentId = parent.database_id ?? parent.data_source_id ?? null;
    }
    return {
      id: page.id,
      title: pageTitle(page as Parameters<typeof pageTitle>[0]) || 'Untitled',
      url: (page.url as string | undefined) ?? '',
      lastEdited: (page.last_edited_time as string | undefined) ?? '',
      parentId,
      parentKind,
    };
  }

  /** All pages the integration can see (search) or the configured roots plus their descendants. */
  private async discoverPages(client: Client): Promise<Map<string, PageInfo>> {
    const pages = new Map<string, PageInfo>();
    const add = (raw: AnyRecord) => {
      const info = this.toPageInfo(raw);
      if (info && !pages.has(info.id)) pages.set(info.id, info);
      return info;
    };

    if (this.cfg.rootIds.length === 0) {
      let cursor: string | undefined;
      do {
        const res = (await this.throttle(() =>
          client.search({ filter: { property: 'object', value: 'page' }, page_size: 100, start_cursor: cursor }),
        )) as { results: AnyRecord[]; next_cursor: string | null };
        for (const r of res.results) add(r);
        cursor = res.next_cursor ?? undefined;
        if (pages.size >= MAX_PAGES) break;
      } while (cursor);
      return pages;
    }

    const queue: Array<{ id: string; kind: 'page' | 'database'; depth: number }> = [];
    const rootFailures: string[] = [];
    for (const id of this.cfg.rootIds) {
      const clean = id.replace(/-/g, '');
      try {
        const page = (await this.throttle(() => client.pages.retrieve({ page_id: clean }))) as AnyRecord;
        if (add(page)) queue.push({ id: clean, kind: 'page', depth: 0 });
        continue;
      } catch {
        /* not a page id — it may name a database */
      }
      try {
        for (const page of await this.databasePages(client, clean, true))
          if (add(page)) queue.push({ id: page.id as string, kind: 'page', depth: 1 });
      } catch (err) {
        rootFailures.push(`${clean.slice(0, 8)}… (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    // Every configured root unreadable means a bad token, a revoked share or a wrong id. Reporting
    // that as an empty workspace would delete every page already imported, so fail the sync instead.
    if (rootFailures.length > 0 && rootFailures.length === this.cfg.rootIds.length) {
      throw new ValidationError(`No configured Notion root could be read — ${rootFailures.join('; ')}`);
    }
    if (rootFailures.length > 0) this.partialFailures.push(...rootFailures);
    while (queue.length > 0 && pages.size < MAX_PAGES) {
      const item = queue.shift()!;
      if (item.depth > MAX_DEPTH) continue;
      if (item.kind === 'database') {
        for (const page of await this.databasePages(client, item.id))
          if (add(page)) queue.push({ id: page.id as string, kind: 'page', depth: item.depth + 1 });
        continue;
      }
      for (const child of await this.childBlocks(client, item.id, true)) {
        if (child.type === 'child_page') {
          try {
            const page = (await this.throttle(() => client.pages.retrieve({ page_id: child.id }))) as AnyRecord;
            if (add(page)) queue.push({ id: child.id, kind: 'page', depth: item.depth + 1 });
          } catch (err) {
            this.ctx.log.warn({ err, pageId: child.id }, 'notion child page not accessible');
          }
        } else if (child.type === 'child_database') {
          queue.push({ id: child.id, kind: 'database', depth: item.depth + 1 });
        }
      }
    }
    return pages;
  }

  /** Pages of a database: 2025-09 API queries data sources; older tokens still answer `databases.query`. */
  private async databasePages(client: Client, databaseId: string, required = false): Promise<AnyRecord[]> {
    const out: AnyRecord[] = [];
    const c = client as unknown as {
      databases: { retrieve: (a: AnyRecord) => Promise<AnyRecord>; query?: (a: AnyRecord) => Promise<AnyRecord> };
      dataSources?: { query: (a: AnyRecord) => Promise<AnyRecord> };
    };
    let dataSourceIds: string[] = [];
    try {
      const db = await this.throttle(() => c.databases.retrieve({ database_id: databaseId }));
      dataSourceIds = ((db.data_sources as Array<{ id: string }> | undefined) ?? []).map((d) => d.id);
    } catch (err) {
      if (required) throw err;
      this.ctx.log.warn({ err, databaseId }, 'notion database not accessible');
      this.partialFailures.push(`database ${databaseId.slice(0, 8)}… is not accessible`);
      return out;
    }
    const query = async (args: AnyRecord): Promise<AnyRecord> => {
      if (c.dataSources && dataSourceIds.length) return this.throttle(() => c.dataSources!.query(args));
      if (c.databases.query) return this.throttle(() => c.databases.query!({ database_id: databaseId, ...args }));
      return { results: [], next_cursor: null };
    };
    for (const dsId of dataSourceIds.length ? dataSourceIds : [databaseId]) {
      let cursor: string | undefined;
      do {
        const res = (await query({ data_source_id: dsId, page_size: 100, start_cursor: cursor })) as {
          results: AnyRecord[];
          next_cursor: string | null;
        };
        out.push(...res.results.filter((r) => r.object === 'page'));
        cursor = res.next_cursor ?? undefined;
      } while (cursor && out.length < MAX_PAGES);
    }
    return out;
  }

  /** Children of a block/page, recursively (except child pages, which are documents of their own). */
  private async childBlocks(client: Client, blockId: string, shallow = false, depth = 0): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const res = (await this.throttle(() => client.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor }))) as {
        results: AnyRecord[];
        next_cursor: string | null;
      };
      for (const r of res.results) blocks.push(r as unknown as NotionBlock);
      cursor = res.next_cursor ?? undefined;
    } while (cursor);
    if (!shallow && depth < MAX_DEPTH) {
      for (const b of blocks) {
        if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database')
          b.children = await this.childBlocks(client, b.id, false, depth + 1);
      }
    }
    return blocks;
  }

  /** Directory (relative) a page lives in: nested under its parent pages, databases as `<stem>` folders. */
  private dirFor(page: PageInfo, pages: Map<string, PageInfo>): string[] {
    const parts: string[] = [];
    let current: PageInfo | undefined = page;
    for (let i = 0; i < MAX_DEPTH && current; i++) {
      if (current.parentKind === 'page' && current.parentId) {
        const parent = pages.get(current.parentId);
        if (!parent) break;
        parts.unshift(pageFileStem(parent.title, parent.id));
        current = parent;
      } else if (current.parentKind === 'database' && current.parentId) {
        parts.unshift(`database--${current.parentId.replace(/-/g, '').slice(0, 8)}`);
        break;
      } else break;
    }
    return parts;
  }

  async sync(): Promise<SyncResult> {
    const client = this.client();
    const root = await this.docRoot();
    const pages = await this.discoverPages(client);
    const seen = new Set<string>();
    let written = 0;

    for (const page of pages.values()) {
      const dir = this.dirFor(page, pages);
      const rel = [...dir, `${pageFileStem(page.title, page.id)}.md`];
      const abs = path.join(root, ...rel);
      seen.add(rel.join('/'));

      let unchanged = false;
      try {
        const head = (await fs.readFile(abs, 'utf8')).slice(0, 600);
        unchanged = head.includes(`last_edited_time: ${JSON.stringify(page.lastEdited)}`);
      } catch {
        /* new page */
      }
      if (unchanged) continue;

      const blocks = await this.childBlocks(client, page.id);
      const body = renderBlocks(blocks);
      const md =
        frontmatter({ title: page.title, notion_id: page.id, url: page.url, last_edited_time: page.lastEdited }) + `\n# ${page.title}\n\n${body}\n`;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, md, 'utf8');
      written++;
    }

    // Remove files of pages that are no longer shared/exist.
    let removed = 0;
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs, [...rel, e.name]);
        else if (e.isFile() && !seen.has([...rel, e.name].join('/'))) {
          await fs.rm(abs, { force: true });
          removed++;
        }
      }
    };
    await walk(root, []);

    const note = `${pages.size} pages, ${written} rendered, ${removed} removed`;
    // One more request, at the end of a sync that just made hundreds, and it buys every *future* run
    // of this source the chance to cost one request in total ([ADR-0048](../../../.ssot/ADR.md#adr-0048)).
    // Deliberately `probe()` and not `max(page.lastEdited)` computed from the map above: with
    // `rootIds` set, that map is one subtree and the probe reads the whole workspace, so the two
    // numbers are different and comparing them would report "changed" on every single tick.
    const token = await this.probe().catch((err: unknown) => {
      this.ctx.log.warn(
        { err, source: this.source.name },
        'notion revision probe failed after a successful sync; the next scheduled run will not be skipped',
      );
      return null;
    });
    return {
      note: this.partialFailures.length ? `${note} (skipped: ${this.partialFailures.join('; ')})` : note,
      ...(token === null ? {} : { configPatch: { [PROBE_TOKEN_KEY]: token } }),
    };
  }

  /**
   * One `search`, sorted by `last_edited_time` descending, one result: the moment the workspace was
   * last written to. Against a sync that reads every page at `MIN_INTERVAL_MS` apart — three minutes
   * of API calls for a 500-page workspace, every run, forever — that is the whole argument for
   * probing at all.
   *
   * **It sees edits, not un-shares.** A page removed from the integration's access without anybody
   * editing anything leaves the newest edit time exactly where it was, so its Markdown file survives
   * in `current/` until the next real edit triggers a run that notices it is gone. Rendering that as
   * "possibly stale" rather than as a wrong answer is the same trade the whole probe is: the
   * alternative is pulling the workspace hourly to find out.
   *
   * The timestamp alone, and not the page id beside it: two pages sharing a `last_edited_time` could
   * order either way between two calls, and a token that flickered would schedule a full pull every
   * hour — which is exactly the cost this exists to avoid. A *deleted* newest page is still seen,
   * because the timestamp then moves backwards to whatever is now on top.
   */
  async probe(): Promise<string | null> {
    const client = this.client();
    const res = (await this.throttle(() =>
      client.search({
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 1,
      }),
    )) as { results: AnyRecord[] };
    const newest = res.results[0]?.last_edited_time;
    return typeof newest === 'string' ? `edited=${newest}` : 'edited=none';
  }
}

registerDriver('notion', (source, ctx) => new NotionDriver(source, ctx));
