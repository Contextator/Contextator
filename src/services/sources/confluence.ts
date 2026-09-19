import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentSourceRow } from '../../db/schema.js';
import { decryptSecret } from '../crypto.js';
import { sourceCurrentDir } from '../data-dir.js';
import { ValidationError } from '../projects.js';
import { PROBE_TOKEN_KEY, parseSourceConfig, type ConfluenceConfig } from '../sources.js';
import { cqlFor, HttpConfluenceClient, type ConfluenceClient, type ConfluencePageSummary } from './confluence-client.js';
import { storageToMarkdown } from './confluence-render.js';
import { registerDriver, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
// Reused rather than reimplemented: the file-stem rule (a slug plus an id prefix, so two pages with
// one title are two files) and the front-matter writer are not Notion's, they are this product's, and
// a second slugifier would differ from the first on the day somebody fixed one of them. The module
// they live in belongs to the Notion driver and is not edited here.
import { frontmatter, pageFileStem } from './notion-render.js';

/** The same ceiling the Notion driver carries, for the same reason: a pull has to have an end. */
const MAX_PAGES = 5000;
/** How much of a file has to be read to find its front matter. Two pages' worth of keys, generously. */
const HEAD_BYTES = 600;

/**
 * Confluence Cloud as a source ([ADR-0059](../../../.ssot/ADR.md#adr-0059)): every page in the
 * configured spaces — or in every space the credential can read — rendered to Markdown under
 * `<source>/<space>/<parent page>/<page>.md`, nested by the page's own ancestry.
 *
 * Incremental in the same way the Notion driver is: a listing gives every page's version number, and
 * the body of a page whose version did not move is never fetched. What it costs when nothing changed
 * is therefore the listing alone, and what a *scheduled* consideration costs is one request — see
 * `probe()` at the bottom, which is the whole reason this type is affordable on a schedule at all.
 */
export class ConfluenceDriver implements SourceDriver {
  private readonly cfg: ConfluenceConfig;
  /**
   * The CQL naming this source's pages, built **once**.
   *
   * `sync()` lists with it and `probe()` measures with it, so the set the probe reports on is the set
   * the run would index — by construction, not by two call sites agreeing. This is the property that,
   * when it is quietly false, turns a probe into a source that has silently stopped syncing.
   */
  private readonly cql: string;
  /** Built once, so the one-at-a-time pacing inside it applies to the whole sync rather than per call. */
  private built?: ConfluenceClient;

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
    /** Stands in for the REST API in tests; in production one is built from the stored credential. */
    private readonly injectedClient?: ConfluenceClient,
  ) {
    this.cfg = parseSourceConfig('confluence', source.config);
    this.cql = cqlFor(this.cfg.spaceKeys);
  }

  private client(): ConfluenceClient {
    if (this.injectedClient) return this.injectedClient;
    if (this.built) return this.built;
    if (!this.source.secretEnc) throw new ValidationError('This Confluence source has no API token stored');
    if (!this.cfg.email) {
      throw new ValidationError('This Confluence source has no account e-mail; Confluence Cloud authenticates with an e-mail plus an API token');
    }
    const token = decryptSecret(this.source.secretEnc, this.ctx.config.SECRET_KEY);
    this.built = new HttpConfluenceClient(
      { baseUrl: this.cfg.baseUrl, email: this.cfg.email, token },
      undefined,
      this.ctx.log.child({ source: this.source.name, type: 'confluence' }),
    );
    return this.built;
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async test(): Promise<string> {
    const client = this.client();
    const who = await client.whoAmI();
    const scope = this.cfg.spaceKeys.length ? `spaces ${this.cfg.spaceKeys.join(', ')}` : 'every space this account can read';
    // The same query the sync and the probe use, so "Test" answers about the pages this source would
    // actually index rather than about the site in general.
    const { total } = await client.revision(this.cql);
    return `Connected as ${who} — ${total} page(s) in ${scope}`;
  }

  /** Every page in scope, paged until Confluence stops offering a cursor or the cap bites. */
  private async listAll(client: ConfluenceClient): Promise<ConfluencePageSummary[]> {
    const pages: ConfluencePageSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const batch = await client.listPages(this.cql, cursor);
      for (const page of batch.results) {
        // A cursor that repeats a row — a page edited between two requests, under a sort that is
        // stable but not unique across concurrent writes — would otherwise become two files.
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        pages.push(page);
      }
      cursor = batch.nextCursor;
    } while (cursor && pages.length < MAX_PAGES);
    return pages;
  }

  /**
   * Where one page's file lives, relative to the source root: its space, then its ancestors outermost
   * first, then the page itself.
   *
   * Ancestors come from the listing rather than from a read, which is what lets an unchanged page keep
   * its path without being fetched.
   */
  private relativePathFor(page: ConfluencePageSummary): string[] {
    const space = spaceFolder(page.spaceKey);
    const ancestors = page.ancestors.map((a) => pageFileStem(a.title, a.id));
    return [...(space ? [space] : []), ...ancestors, `${pageFileStem(page.title, page.id)}.md`];
  }

  async sync(): Promise<SyncResult> {
    const client = this.client();
    const root = await this.docRoot();
    const pages = await this.listAll(client);

    const existingFiles = await walkFiles(root);
    // **A scope that has gone empty is a failure, not an empty wiki.** A renamed space, a revoked
    // permission or a typo corrected in Confluence rather than here all answer "no results" with a
    // 200, and the removal pass below would then delete every document this source ever contributed —
    // reporting complete success while doing it. The Notion driver refuses the same shape of answer
    // for the same reason; the difference is only that Confluence expresses it as an empty page of
    // results instead of an error, which is the more dangerous of the two.
    if (pages.length === 0 && existingFiles.size > 0) {
      const scope = this.cfg.spaceKeys.length ? `space(s) ${this.cfg.spaceKeys.join(', ')}` : 'this account';
      throw new ValidationError(
        `Confluence returned no pages for ${scope}, but this source already holds ${existingFiles.size} document(s). ` +
          'Refusing to delete them: check that the space keys are still correct and that the account can still read them.',
      );
    }

    const seen = new Set<string>();
    let written = 0;
    const failures: string[] = [];

    for (const page of pages) {
      const rel = this.relativePathFor(page);
      const key = rel.join('/');
      const abs = path.join(root, ...rel);
      seen.add(key);

      if (existingFiles.has(key) && (await storedVersion(abs)) === page.version) continue;

      let markdown: string;
      try {
        markdown = storageToMarkdown(await client.storage(page.id), page.title);
      } catch (err) {
        // One page that cannot be rendered is not a source that failed. Its previous file stays where
        // it is — `seen` already holds the path, so the removal pass below leaves it alone — and the
        // reason is reported on the run, which is the shape `indexer.ts` uses for a file it cannot
        // convert ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
        failures.push(`${page.title} (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }

      const md =
        frontmatter({
          title: page.title,
          confluence_id: page.id,
          space: page.spaceKey,
          url: page.webUrl,
          confluence_version: String(page.version),
          last_modified: page.lastModified,
        }) + `\n${markdown}\n`;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, md, 'utf8');
      written++;
    }

    let removed = 0;
    for (const key of existingFiles) {
      if (seen.has(key)) continue;
      await fs.rm(path.join(root, ...key.split('/')), { force: true });
      removed++;
    }

    const note = `${pages.length} pages, ${written} rendered, ${removed} removed`;
    // One more request at the end of a sync that just made many, buying every future consideration of
    // this source the chance to cost exactly one ([ADR-0048](../../../.ssot/ADR.md#adr-0048)). It is
    // `probe()` itself rather than a maximum computed from `pages` above, so that both sides of the
    // scheduler's comparison are the same function of the same source — the rule the driver interface
    // states, and the only reason "equal" can be trusted.
    const token = await this.probe().catch((err: unknown) => {
      this.ctx.log.warn(
        { err, source: this.source.name },
        'confluence revision probe failed after a successful sync; the next scheduled run will not be skipped',
      );
      return null;
    });
    return {
      note: failures.length ? `${note} (skipped: ${failures.join('; ')})` : note,
      ...(token === null ? {} : { configPatch: { [PROBE_TOKEN_KEY]: token } }),
    };
  }

  /**
   * One CQL search, `limit=1`, newest first: how many pages the scope holds and when the newest of
   * them was last touched.
   *
   * **What it counts is `this.cql` — the same string `sync()` lists with.** That sentence is the
   * probe, and it is also the way this kind of probe fails: one that measured a different scope (a
   * different space filter, a different content type) would answer "unchanged" about pages the run
   * does index, and the source would stop syncing while the dashboard went on reporting it healthy.
   * Both callers read one field built in the constructor, and the driver test asserts the two requests
   * carry the same query.
   *
   * **Two numbers rather than one, and the count is the half that pays for itself.** The newest
   * timestamp alone cannot see a deletion — removing a page moves nobody's `lastModified` — so a page
   * deleted from a space would survive in `current/` until something unrelated was edited. `totalSize`
   * arrives in the same response, for no extra request, and moves when a page is added or removed.
   * What neither half sees is an edit and a deletion inside one interval that happen to leave both the
   * count and the maximum where they were; that is the same residue `directoryRevision` documents, and
   * the answer to it is the same: a probe is an optimisation over a "Sync now" button that still works.
   *
   * `pages=0;modified=none` is a legitimate answer for an empty space and is compared like any other.
   * A throw is not caught here: the scheduler treats a probe that could not answer as "run it".
   */
  async probe(): Promise<string | null> {
    const { total, newest } = await this.client().revision(this.cql);
    return `pages=${total};modified=${newest ?? 'none'}`;
  }
}

/** A space key as a path segment. Keys are already restricted to `[A-Za-z0-9~_-]` by the config schema. */
function spaceFolder(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Every file under `root`, as `/`-joined relative paths. The set both the skip and the removal read. */
async function walkFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), [...rel, entry.name]);
      else if (entry.isFile()) out.add([...rel, entry.name].join('/'));
    }
  };
  await walk(root, []);
  return out;
}

const VERSION_LINE = /^confluence_version: "(\d+)"$/m;

/** The version a file was written from, read off its front matter; `null` when it says nothing. */
async function storedVersion(absolutePath: string): Promise<number | null> {
  try {
    const handle = await fs.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      const match = VERSION_LINE.exec(buffer.subarray(0, bytesRead).toString('utf8'));
      return match ? Number(match[1]) : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

registerDriver('confluence', (source, ctx) => new ConfluenceDriver(source, ctx));
