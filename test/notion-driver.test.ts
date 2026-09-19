import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { NotionDriver } from '../src/services/sources/notion.js';

/**
 * Drives the real Notion source against a stub of the API client, so the whole import — discovery,
 * pagination, block fetching, file naming, nesting, the incremental skip and the removal of pages
 * that are gone — is exercised without a token or a network.
 */

const rt = (text: string) => ({ plain_text: text });
const titleProp = (text: string) => ({ Name: { type: 'title', title: [rt(text)] } });

interface StubPage {
  id: string;
  title: string;
  lastEdited: string;
  parent: Record<string, unknown>;
  blocks: Array<Record<string, unknown>>;
}

/** Counts every call so the test can assert the second sync really skipped the unchanged pages. */
class StubNotion {
  readonly calls: string[] = [];
  // Named `store`, not `pages`: the Notion client's own `pages` member is stubbed below, and a
  // constructor parameter property of the same name silently overwrote it at construction time.
  constructor(private store: StubPage[]) {}

  setPages(pages: StubPage[]): void {
    this.store = pages;
  }

  private page(id: string): StubPage | undefined {
    return this.store.find((p) => p.id === id);
  }

  /** Set to make every call reject, the way an invalid or revoked token does. */
  failWith: string | null = null;

  private guard(): void {
    if (this.failWith) throw new Error(this.failWith);
  }

  readonly users = { me: async () => ({ name: 'Docs bot', type: 'bot' }) };

  readonly pages = {
    retrieve: async (args: { page_id: string }) => {
      this.calls.push(`pages:${args.page_id}`);
      this.guard();
      const p = this.page(args.page_id);
      if (!p) throw new Error('Could not find page');
      return {
        object: 'page',
        id: p.id,
        url: `https://notion.so/${p.id}`,
        last_edited_time: p.lastEdited,
        parent: p.parent,
        properties: titleProp(p.title),
      };
    },
  };

  readonly databases = {
    retrieve: async (args: { database_id: string }) => {
      this.calls.push(`databases:${args.database_id}`);
      this.guard();
      throw new Error('Could not find database');
    },
  };

  search = async (args: { start_cursor?: string; page_size?: number; sort?: { direction: string; timestamp: string } }) => {
    // The revision probe of [ADR-0048](../.ssot/ADR.md#adr-0048) is the same endpoint asked a
    // different question: newest first, one result. Answered here the way the API answers it, and
    // labelled apart so a test can say how many *pulls* a sync made without counting the probe.
    if (args.sort?.direction === 'descending' && args.page_size === 1) {
      this.calls.push('search:probe');
      this.guard();
      const newest = [...this.store].sort((a, b) => b.lastEdited.localeCompare(a.lastEdited))[0];
      return { results: newest ? [this.asPage(newest)] : [], next_cursor: null };
    }
    this.calls.push(`search:${args.start_cursor ?? 'first'}`);
    this.guard();
    // Two pages of results, so pagination is covered.
    const half = Math.ceil(this.store.length / 2);
    const firstPage = !args.start_cursor;
    const slice = firstPage ? this.store.slice(0, half) : this.store.slice(half);
    return {
      results: slice.map((p) => this.asPage(p)),
      next_cursor: firstPage && this.store.length > half ? 'cursor-2' : null,
    };
  };

  private asPage(p: StubPage): Record<string, unknown> {
    return {
      object: 'page',
      id: p.id,
      url: `https://notion.so/${p.id}`,
      last_edited_time: p.lastEdited,
      parent: p.parent,
      properties: titleProp(p.title),
    };
  }

  readonly blocks = {
    children: {
      list: async (args: { block_id: string }) => {
        this.calls.push(`blocks:${args.block_id}`);
        this.guard();
        const owner = this.page(args.block_id);
        if (owner) return { results: owner.blocks, next_cursor: null };
        // Children of a nested block, keyed by the synthetic ids used in the fixture below.
        const nested: Record<string, Array<Record<string, unknown>>> = {
          'toggle-1': [{ id: 'tp', type: 'paragraph', paragraph: { rich_text: [rt('Folded detail.')] } }],
        };
        return { results: nested[args.block_id] ?? [], next_cursor: null };
      },
    },
  };
}

const source = (id: string, projectId: string): DocumentSourceRow =>
  ({
    id,
    projectId,
    type: 'notion',
    name: 'wiki',
    label: '',
    config: { rootIds: [], extensions: ['md'] },
    secretEnc: null,
    webhookSecret: null,
    flavor: 'plain',
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    documentCount: 0,
    syncIntervalMinutes: null,
    nextSyncAt: null,
    webhookVerificationExpiresAt: null,
    webhookDueAt: null,
    webhookMinIntervalMinutes: null,
    createdAt: new Date(),
  }) as DocumentSourceRow;

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;

const HOME: StubPage = {
  id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
  title: 'Product Handbook',
  lastEdited: '2026-09-01T10:00:00.000Z',
  parent: { type: 'workspace' },
  blocks: [
    { id: 'p1', type: 'paragraph', paragraph: { rich_text: [rt('Everything about the product.')] } },
    { id: 'toggle-1', type: 'heading_2', heading_2: { rich_text: [rt('Details')], is_toggleable: true }, has_children: true },
  ],
};

const CHILD: StubPage = {
  id: '11112222333344445555666677778888',
  title: 'Kurulum Rehberi',
  lastEdited: '2026-09-02T10:00:00.000Z',
  parent: { type: 'page_id', page_id: HOME.id },
  blocks: [{ id: 'p2', type: 'paragraph', paragraph: { rich_text: [rt('Once kurulum yapin.')] } }],
};

describe('notion source', () => {
  let dataDir: string;
  const projectId = '00000000-0000-4000-8000-000000000001';
  const sourceId = '00000000-0000-4000-8000-000000000002';
  const currentDir = (): string => sourceCurrentDir(dataDir, projectId, sourceId);

  const listFiles = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), [...rel, e.name]);
        else out.push([...rel, e.name].join('/'));
      }
    };
    await walk(currentDir(), []);
    return out.sort();
  };

  beforeAll(async () => {
    dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-notion-')));
  });
  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('imports every shared page as Markdown, nested under its parent page', async () => {
    const stub = new StubNotion([HOME, CHILD]);
    const driver = new NotionDriver(
      source(sourceId, projectId),
      { db: null as never, log, config: { DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] } },
      stub as never,
    );

    const result = await driver.sync();
    expect(result.note).toContain('2 pages');
    // Two paginated pulls, and then the one extra `search` that mints the revision token the
    // scheduler will compare against ([ADR-0048](../.ssot/ADR.md#adr-0048)).
    expect(stub.calls.filter((c) => c.startsWith('search:'))).toEqual(['search:first', 'search:cursor-2', 'search:probe']);
    expect(result.configPatch).toEqual({ syncProbeToken: `edited=${CHILD.lastEdited}` });

    // The child page sits in a folder named after its parent; both stems carry the id prefix.
    expect(await listFiles()).toEqual(['product-handbook--aaaaaaaa/kurulum-rehberi--11112222.md', 'product-handbook--aaaaaaaa.md'].sort());

    const home = await fs.readFile(path.join(currentDir(), 'product-handbook--aaaaaaaa.md'), 'utf8');
    expect(home).toContain('title: "Product Handbook"');
    expect(home).toContain(`notion_id: "${HOME.id}"`);
    expect(home).toContain('last_edited_time: "2026-09-01T10:00:00.000Z"');
    expect(home).toContain('# Product Handbook');
    expect(home).toContain('Everything about the product.');
    // The toggleable heading's children were fetched and kept.
    expect(home).toContain('## Details');
    expect(home).toContain('Folded detail.');

    const child = await fs.readFile(path.join(currentDir(), 'product-handbook--aaaaaaaa', 'kurulum-rehberi--11112222.md'), 'utf8');
    expect(child).toContain('Once kurulum yapin.');
  }, 30_000);

  it('skips pages whose last_edited_time did not move, and renders the one that did', async () => {
    const stub = new StubNotion([
      HOME,
      { ...CHILD, lastEdited: '2026-09-09T12:00:00.000Z', blocks: [{ id: 'p2', type: 'paragraph', paragraph: { rich_text: [rt('Guncellendi.')] } }] },
    ]);
    const driver = new NotionDriver(
      source(sourceId, projectId),
      { db: null as never, log, config: { DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] } },
      stub as never,
    );

    const result = await driver.sync();
    expect(result.note).toContain('1 rendered');
    // Only the changed page's blocks were fetched again.
    expect(stub.calls.filter((c) => c.startsWith('blocks:'))).toEqual([`blocks:${CHILD.id}`]);
    expect(await fs.readFile(path.join(currentDir(), 'product-handbook--aaaaaaaa', 'kurulum-rehberi--11112222.md'), 'utf8')).toContain(
      'Guncellendi.',
    );
  }, 30_000);

  it('fails loudly when the token is rejected, instead of reporting an empty workspace', async () => {
    // Swallowing this reported "0 pages" — and the removal pass below then deleted every imported file.
    const stub = new StubNotion([HOME, CHILD]);
    stub.failWith = 'API token is invalid.';
    const driver = new NotionDriver(
      source(sourceId, projectId),
      { db: null as never, log, config: { DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] } },
      stub as never,
    );

    await expect(driver.sync()).rejects.toThrow('API token is invalid.');
    expect(await listFiles()).toContain('product-handbook--aaaaaaaa.md'); // nothing was deleted
  }, 30_000);

  it('fails when no configured root can be read', async () => {
    const stub = new StubNotion([HOME]);
    stub.failWith = 'API token is invalid.';
    const rooted = {
      ...source(sourceId, projectId),
      config: { rootIds: ['1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'], extensions: ['md'] },
    } as DocumentSourceRow;
    const driver = new NotionDriver(
      rooted,
      { db: null as never, log, config: { DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] } },
      stub as never,
    );

    await expect(driver.sync()).rejects.toThrow('No configured Notion root could be read');
    expect(await listFiles()).toContain('product-handbook--aaaaaaaa.md');
  }, 30_000);

  it('removes the file of a page that is no longer shared', async () => {
    const stub = new StubNotion([HOME]);
    const driver = new NotionDriver(
      source(sourceId, projectId),
      { db: null as never, log, config: { DATA_DIR: dataDir, SECRET_KEY: undefined, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] } },
      stub as never,
    );

    const result = await driver.sync();
    expect(result.note).toContain('1 removed');
    expect(await listFiles()).toEqual(['product-handbook--aaaaaaaa.md']);
  }, 30_000);
});
