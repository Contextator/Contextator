import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { sourceCurrentDir, sourceRepoDir } from '../src/services/data-dir.js';
import {
  daysSince,
  formatSourceDate,
  isStale,
  normalizeSourceUrl,
  parseSourceDate,
  resolveStoredMeta,
  sourceFieldsOf,
  sourceLine,
  sourceMetaDiffers,
} from '../src/services/source-url.js';
import { ConfluenceDriver } from '../src/services/sources/confluence.js';
import type { DocumentMetaFile, DriverContext } from '../src/services/sources/driver.js';
import { GitDriver } from '../src/services/sources/git.js';
import { LocalDriver } from '../src/services/sources/local.js';
import { NotionDriver } from '../src/services/sources/notion.js';
import { UploadDriver } from '../src/services/sources/upload.js';
import { WebDriver } from '../src/services/sources/web.js';
import { page, StubWeb, type StubPage } from './support/web-stub.js';

/**
 * Where each source type says a document lives and when it last changed
 * ([ADR-0116](../.ssot/ADR.md#adr-0116)): one case per driver, then the pure helpers that decide what is
 * stored and what a response shows. No socket is opened and no database is touched; the drivers are asked
 * what they know about files already on disk, which is exactly how the indexer asks.
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const PROJECT_ID = '00000000-0000-4000-8000-000000000041';
const SOURCE_ID = '00000000-0000-4000-8000-000000000042';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-source-url-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const row = (type: string, config: Record<string, unknown>): DocumentSourceRow =>
  ({ id: SOURCE_ID, projectId: PROJECT_ID, type, name: 'docs', label: '', config, secretEnc: null, flavor: 'plain' }) as unknown as DocumentSourceRow;

const ctx = (extra: Record<string, unknown> = {}): DriverContext => ({
  db: null as never,
  log,
  config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: '', ALLOWED_DOC_ROOTS: [dataDir], IGNORE_GLOBS: [], ...extra } as never,
});

const fileOf = (root: string, rel: string, mtimeMs = 0): DocumentMetaFile => ({ path: rel, absolutePath: path.join(root, rel), mtimeMs });

describe('git', () => {
  const COMMITTED_AT = 1_700_000_000; // 2023-11-14T22:13:20Z
  let head: string;

  /** A real one-commit repository where the driver keeps its clone, so `documentMeta` reads real objects. */
  async function seedRepo(): Promise<string> {
    const dir = sourceRepoDir(dataDir, PROJECT_ID, SOURCE_ID);
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.writeFile(path.join(dir, 'docs', 'guide.md'), '# Guide\n');
    await git.add({ fs, dir, filepath: 'docs/guide.md' });
    const author = { name: 'A', email: 'a@example.com', timestamp: COMMITTED_AT - 100, timezoneOffset: 0 };
    head = await git.commit({ fs, dir, message: 'init', author, committer: { ...author, timestamp: COMMITTED_AT } });
    return dir;
  }

  const driver = (url: string, extra: Record<string, unknown> = {}) => new GitDriver(row('git', { url, branch: 'main', ...extra }), ctx());

  it('links the file at the commit it was indexed from, and dates it with that commit', async () => {
    const dir = await seedRepo();
    const meta = await driver('https://github.com/org/repo.git', { subdir: 'docs' }).documentMeta([fileOf(dir, 'guide.md')]);
    const got = meta.get('guide.md');
    expect(got?.url).toBe(`https://github.com/org/repo/blob/${head}/docs/guide.md`);
    expect(got?.modifiedAt?.toISOString()).toBe(new Date(COMMITTED_AT * 1000).toISOString());
    // Git dates describe the moment of observation, so the indexer must not re-stamp unchanged files with them.
    expect(got?.stampOnChange).toBe(true);
  });

  it('never lets a credential in the remote reach the link', async () => {
    const dir = await seedRepo();
    const meta = await driver('https://user:token@github.com/org/repo.git', { subdir: 'docs' }).documentMeta([fileOf(dir, 'guide.md')]);
    const url = meta.get('guide.md')?.url ?? '';
    expect(url).toBe(`https://github.com/org/repo/blob/${head}/docs/guide.md`);
    expect(url).not.toContain('user:token@');
    expect(url).not.toContain('token');
  });

  it('answers nothing when the clone is not there, rather than a wrong link', async () => {
    const meta = await driver('https://github.com/org/repo.git').documentMeta([fileOf(dataDir, 'guide.md')]);
    expect(meta.size).toBe(0);
  });
});

describe('notion and confluence', () => {
  async function pageFile(root: string, rel: string, front: string[]): Promise<DocumentMetaFile> {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `---\n${front.join('\n')}\n---\n\n# Body\n`);
    return { path: rel, absolutePath: abs, mtimeMs: Date.now() };
  }

  it('notion: the page address and last_edited_time', async () => {
    const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
    const f = await pageFile(root, 'plan.md', [
      'title: "Plan"',
      'url: "https://www.notion.so/Plan-0123456789abcdef0123456789abcdef"',
      'last_edited_time: "2026-03-04T05:06:07.000Z"',
    ]);
    const meta = await new NotionDriver(row('notion', { rootPageIds: [] }), ctx()).documentMeta([f]);
    expect(meta.get('plan.md')?.url).toBe('https://www.notion.so/Plan-0123456789abcdef0123456789abcdef');
    expect(meta.get('plan.md')?.modifiedAt?.toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  it('confluence: the page address and the version time', async () => {
    const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
    const f = await pageFile(root, 'runbook.md', [
      'url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Runbook"',
      'last_modified: "2026-01-02T03:04:05.000Z"',
    ]);
    const meta = await new ConfluenceDriver(row('confluence', { baseUrl: 'https://acme.atlassian.net/wiki' }), ctx()).documentMeta([f]);
    expect(meta.get('runbook.md')?.url).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Runbook');
    expect(meta.get('runbook.md')?.modifiedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('a front-matter address that is not http(s), or carries a credential, is not stored as written', async () => {
    const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
    const bad = await pageFile(root, 'bad.md', ['url: "javascript:alert(1)"', 'last_edited_time: "not a date"']);
    const cred = await pageFile(root, 'cred.md', ['url: "https://user:token@notion.so/x#frag"']);
    const meta = await new NotionDriver(row('notion', { rootPageIds: [] }), ctx()).documentMeta([bad, cred]);
    expect(meta.get('bad.md')).toEqual({ url: null, modifiedAt: null });
    expect(meta.get('cred.md')?.url).toBe('https://notion.so/x');
  });

  it('a file with no front matter is a document with nothing known, not an error', async () => {
    const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'plain.md'), '# No front matter\n');
    const meta = await new NotionDriver(row('notion', { rootPageIds: [] }), ctx()).documentMeta([fileOf(root, 'plain.md')]);
    expect(meta.get('plain.md')).toEqual({ url: null, modifiedAt: null });
  });
});

describe('local and upload', () => {
  it('local: no address, and the file mtime as the date', async () => {
    const mtimeMs = Date.UTC(2026, 4, 6, 7, 8, 9);
    const meta = await new LocalDriver(row('local', { path: dataDir }), ctx()).documentMeta([fileOf(dataDir, 'a.md', mtimeMs)]);
    expect(meta.get('a.md')?.url).toBeNull();
    expect(meta.get('a.md')?.modifiedAt?.getTime()).toBe(mtimeMs);
  });

  it('upload: neither an address nor a date, because mtime there is the moment of the upload', async () => {
    const meta = await new UploadDriver(row('upload', {}), ctx()).documentMeta([fileOf(dataDir, 'a.md', Date.now())]);
    expect(meta.get('a.md')).toEqual({ url: null, modifiedAt: null });
  });
});

describe('web', () => {
  const LIMITS = { WEB_MAX_PAGES: 100, WEB_MAX_DEPTH: 3, WEB_REQUEST_DELAY_MS: 0, WEB_CRAWL_BUDGET_MS: 60_000, WEB_RESPECT_ROBOTS: true };

  async function crawl(pages: Record<string, StubPage>): Promise<Map<string, { url: string | null; modifiedAt: Date | null }>> {
    const web = new WebDriver(
      row('web', { entryUrl: 'https://docs.example.com/sitemap.xml', extensions: ['html', 'md', 'txt'] }),
      ctx(LIMITS),
      new StubWeb({ 'https://docs.example.com/robots.txt': { status: 404 }, ...pages }),
    );
    await web.sync();
    const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
    const files = (await fs.readdir(root)).filter((n) => n.endsWith('.html')).map((n) => fileOf(root, n));
    return web.documentMeta(files);
  }

  const sitemap = (...locs: string[]): StubPage => ({
    contentType: 'application/xml',
    body: `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`,
  });

  it('keeps the final address after a redirect, and the Last-Modified the server sent', async () => {
    const meta = await crawl({
      'https://docs.example.com/sitemap.xml': sitemap('https://docs.example.com/old'),
      'https://docs.example.com/old': {
        body: page('Moved', '<p>Words.</p>'),
        redirectedTo: 'https://docs.example.com/new-home',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      },
    });
    const got = [...meta.values()];
    expect(got).toHaveLength(1);
    expect(got[0].url).toBe('https://docs.example.com/new-home');
    expect(got[0].modifiedAt?.toISOString()).toBe('2026-10-21T07:28:00.000Z');
  });

  it('a page served without Last-Modified has an address and no date', async () => {
    const meta = await crawl({
      'https://docs.example.com/sitemap.xml': sitemap('https://docs.example.com/plain'),
      'https://docs.example.com/plain': { body: page('Plain', '<p>Words.</p>') },
    });
    const got = [...meta.values()];
    expect(got).toHaveLength(1);
    expect(got[0].url).toBe('https://docs.example.com/plain');
    expect(got[0].modifiedAt).toBeNull();
  });

  it('a garbled Last-Modified reads as no date', async () => {
    const meta = await crawl({
      'https://docs.example.com/sitemap.xml': sitemap('https://docs.example.com/odd'),
      'https://docs.example.com/odd': { body: page('Odd', '<p>Words.</p>'), lastModified: 'yesterday-ish' },
    });
    expect([...meta.values()][0].modifiedAt).toBeNull();
  });
});

describe('normalizeSourceUrl', () => {
  it('stores only http(s), without credentials or fragment', () => {
    expect(normalizeSourceUrl('https://example.com/a?b=1#top')).toBe('https://example.com/a?b=1');
    expect(normalizeSourceUrl('http://u:p@example.com/a')).toBe('http://example.com/a');
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://example.com/a',
      'data:text/html,hi',
      '/relative/path',
      'not a url',
      '',
      '   ',
      null,
      42,
    ]) {
      expect(normalizeSourceUrl(bad)).toBeNull();
    }
  });

  it('refuses an address too long to be a link rather than truncating it', () => {
    expect(normalizeSourceUrl(`https://example.com/${'a'.repeat(2100)}`)).toBeNull();
  });
});

describe('parseSourceDate', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  it('reads HTTP-dates and ISO timestamps', () => {
    expect(parseSourceDate('Wed, 21 Oct 2026 07:28:00 GMT', now)?.toISOString()).toBe('2026-10-21T07:28:00.000Z');
    expect(parseSourceDate('2026-01-02T03:04:05Z', now)?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });
  it('treats unparseable, empty, epoch-zero and far-future values as no date', () => {
    for (const bad of ['', '  ', 'soon', 0, '1970-01-01T00:00:00Z', '2030-01-01T00:00:00Z', undefined, null, {}]) {
      expect(parseSourceDate(bad, now)).toBeNull();
    }
  });
});

describe('stale mark and response text', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const old = new Date('2024-01-01T00:00:00Z');
  const recent = new Date('2026-10-01T00:00:00Z');

  it('is stale only past the threshold; unknown is never old and 0 switches it off', () => {
    expect(isStale(old, 365, now)).toBe(true);
    expect(isStale(recent, 365, now)).toBe(false);
    expect(isStale(null, 365, now)).toBe(false);
    expect(isStale(old, 0, now)).toBe(false);
    expect(daysSince(recent, now)).toBe(21);
    expect(formatSourceDate(old)).toBe('2024-01-01');
  });

  it('shapes the structured fields', () => {
    expect(sourceFieldsOf({ sourceUrl: 'https://e.com/a', sourceModifiedAt: old }, 365, now)).toEqual({
      sourceUrl: 'https://e.com/a',
      sourceModifiedAt: '2024-01-01T00:00:00.000Z',
      stale: true,
    });
    expect(sourceFieldsOf({ sourceUrl: null, sourceModifiedAt: null }, 365, now)).toEqual({ sourceUrl: null, sourceModifiedAt: null, stale: false });
  });

  it('does not trust a stored address on the way out', () => {
    expect(sourceFieldsOf({ sourceUrl: 'javascript:alert(1)', sourceModifiedAt: null }, 365, now).sourceUrl).toBeNull();
    expect(sourceFieldsOf({ sourceUrl: 'https://u:t@e.com/a', sourceModifiedAt: null }, 365, now).sourceUrl).toBe('https://e.com/a');
  });

  it('writes the line only when something is known, so an unlinked source reads as before 0.4', () => {
    expect(sourceLine({ sourceUrl: null, sourceModifiedAt: null }, 365, now)).toBeNull();
    expect(sourceLine({ sourceUrl: 'https://e.com/a', sourceModifiedAt: recent }, 365, now)).toBe('Source: https://e.com/a · modified 2026-10-01');
    expect(sourceLine({ sourceUrl: 'https://e.com/a', sourceModifiedAt: old }, 365, now)).toBe(
      'Source: https://e.com/a · modified 2024-01-01 (unchanged for over 365 days)',
    );
    expect(sourceLine({ sourceUrl: 'https://e.com/a', sourceModifiedAt: null }, 365, now)).toBe('Source: https://e.com/a');
    expect(sourceLine({ sourceUrl: null, sourceModifiedAt: recent }, 365, now)).toBe('Modified: 2026-10-01');
    expect(sourceLine({ sourceUrl: 'https://e.com/a', sourceModifiedAt: old }, 0, now)).toBe('Source: https://e.com/a · modified 2024-01-01');
  });
});

describe('resolveStoredMeta', () => {
  const stored = { sourceUrl: 'https://e.com/old', sourceModifiedAt: new Date('2025-01-01T00:00:00Z') };
  const fresh = { url: 'https://e.com/new', modifiedAt: new Date('2026-02-02T00:00:00Z') };

  it('keeps what is stored when the driver gave no answer', () => {
    expect(resolveStoredMeta(undefined, stored, true)).toEqual(stored);
    expect(resolveStoredMeta(undefined, undefined, true)).toEqual({ sourceUrl: null, sourceModifiedAt: null });
  });

  it('believes a driver that answered, null included', () => {
    expect(resolveStoredMeta(fresh, stored, false)).toEqual({ sourceUrl: 'https://e.com/new', sourceModifiedAt: fresh.modifiedAt });
    expect(resolveStoredMeta({ url: null, modifiedAt: null }, stored, false)).toEqual({ sourceUrl: null, sourceModifiedAt: null });
  });

  it('drops a non-http(s) address even from a driver', () => {
    expect(resolveStoredMeta({ url: 'file:///etc/passwd', modifiedAt: null }, undefined, true).sourceUrl).toBeNull();
  });

  it('git: unchanged text keeps the stored values and only fills what is still null', () => {
    const stamped = { ...fresh, stampOnChange: true };
    expect(resolveStoredMeta(stamped, stored, false)).toEqual(stored);
    expect(resolveStoredMeta(stamped, { sourceUrl: null, sourceModifiedAt: null }, false)).toEqual({
      sourceUrl: 'https://e.com/new',
      sourceModifiedAt: fresh.modifiedAt,
    });
    expect(resolveStoredMeta(stamped, stored, true)).toEqual({ sourceUrl: 'https://e.com/new', sourceModifiedAt: fresh.modifiedAt });
    expect(resolveStoredMeta(stamped, undefined, false)).toEqual({ sourceUrl: 'https://e.com/new', sourceModifiedAt: fresh.modifiedAt });
  });

  it('compares dates by instant', () => {
    const a = { sourceUrl: 'https://e.com/a', sourceModifiedAt: new Date(1000) };
    expect(sourceMetaDiffers(a, { ...a, sourceModifiedAt: new Date(1000) })).toBe(false);
    expect(sourceMetaDiffers(a, { ...a, sourceModifiedAt: new Date(2000) })).toBe(true);
    expect(sourceMetaDiffers(a, { ...a, sourceUrl: null })).toBe(true);
  });
});
