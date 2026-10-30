import fs from 'node:fs/promises';
import path from 'node:path';
import { SOURCE_PAGE_LIMIT_DEFAULTS } from '../../config.js';
import type { DocumentSourceRow } from '../../db/schema.js';
import { decryptSecret, keyringOf } from '../crypto.js';
import { sourceCurrentDir } from '../data-dir.js';
import { ValidationError } from '../projects.js';
import { parseSourceConfig, PROBE_TOKEN_KEY, type GithubConfig } from '../sources.js';
import { sourceEgress, type EgressOptions } from './confluence-egress.js';
import { registerDriver, type DocumentMeta, type DocumentMetaFile, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
import { frontmatterMeta } from './frontmatter-meta.js';
import { canonicalGithubToken, GithubClient, type GithubComment, type GithubDiscussion, type GithubIssue } from './github-client.js';
import { discussionFileName, issueFileName, keepsAuthor, renderDiscussion, renderIssue } from './github-render.js';

/**
 * A GitHub repository's issues, and with `includeDiscussions` its Discussions, as a source
 * ([ADR-0128](../../../.ssot/ADR.md#adr-0128)): one Markdown document per issue (`issues/<number>.md`) and per
 * Discussion (`discussions/<number>.md`) under `<source>/current/`, with the comments in the same document. Pull
 * requests, which the issues API returns beside issues, are not documents. Wiki and files are the `git` source's.
 *
 * **Two kinds of run, and what each finds** (decisions 5 and 6).
 *
 * - An **incremental** run asks for issues and repository comments updated since the last successful run's start
 *   (moved back {@link SKEW_MS} for clock skew), re-reads the comments of each issue that moved, and re-renders
 *   those documents. It writes what changed and finds no deletion: GitHub's lists never show an issue that was
 *   deleted or transferred, so a document for one stays until the next full run.
 * - A **full** run lists every issue and every comment of the repository (and every Discussion), writes what
 *   differs, and removes the documents whose number is gone. It is the first run, one after a change to the
 *   settings the cursor was taken under, one when the last full run is older than `SYNC_MAX_SKIP_HOURS`
 *   (ADR-0095's bound, 24 hours when that is off), and the answer to an incremental run that finds more than
 *   {@link INCREMENTAL_LIMIT} issues moved, where listing everything is the cheaper way to be right.
 *
 * **The cursor moves with a successful run only.** `syncedSince` is the moment the run began, stored in
 * `configPatch` — which the indexer persists after a run that succeeded — so a run that fails (a rate limit most
 * of all, decision 8) stores nothing and the next one starts again from the same place. The freshness validators
 * are taken *before* anything is listed for the same reason: a change made during the run is seen by the next probe.
 *
 * **The probe** is one conditional request for the most recently updated issue (a `304` with a token costs none of the
 * primary limit) and, with Discussions on, one GraphQL query for the most recently updated Discussion. It does not
 * see deletions, which is why the full run exists.
 *
 * **Every request goes through the egress guard, pinned to the one API host of the source**, so the token cannot be
 * led to another host by a redirect or a pagination link. A host that resolves privately (Enterprise Server) must be
 * named in `SOURCE_ALLOWED_HOSTS`.
 */

/** Added to the cursor when it is used: GitHub's clock is not this server's, and a run that starts late must not miss an edit made while it listed. */
export const SKEW_MS = 5 * 60_000;
/** An incremental run that finds more issues than this moved lists everything instead. */
export const INCREMENTAL_LIMIT = 100;
/** The longest a source goes without a full run when `SYNC_MAX_SKIP_HOURS` is off. */
const FALLBACK_FULL_RUN_HOURS = 24;
/** Seconds of silence after which a request is abandoned. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface GithubDriverOptions {
  /** Test seam: shortens the retry back-off (production waits 500 ms × 2^(n-1), jittered). */
  retryDelayMs?: number;
  /**
   * Test seam: the REST base the requests go to, with `https` no longer required (a fixture is plain `http`) and
   * the host pin following it. Production never sets it, and the registered factory does not.
   */
  apiBase?: string;
  /** Test seam: the clock the cursor and the full-run age are read from. */
  now?: () => number;
}

interface RunStats {
  mode: 'full' | 'incremental';
  written: number;
  unchanged: number;
  removed: number;
  /** The listing stopped at `GITHUB_MAX_ISSUES`. */
  issuesTruncated: boolean;
  /** The listing stopped at `GITHUB_MAX_DISCUSSIONS`. */
  discussionsTruncated: boolean;
}

const NUMBERED = /^(\d+)\.md$/;

export class GithubDriver implements SourceDriver {
  private readonly cfg: GithubConfig;
  private built?: GithubClient;

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
    /**
     * Test seams for the egress guard: which address a name resolves to, and where an address that has
     * passed the check is dialled. Production passes neither; the check itself cannot be replaced.
     */
    private readonly egress?: Pick<EgressOptions, 'resolve' | 'route'>,
    private readonly options: GithubDriverOptions = {},
  ) {
    this.cfg = parseSourceConfig('github', source.config);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private requireTokenForDiscussions(): void {
    if (this.cfg.includeDiscussions && !this.source.secretEnc) {
      throw new ValidationError(
        'This GitHub source reads Discussions, which needs a token: GitHub serves them through its GraphQL API, which does not answer anonymous requests',
      );
    }
  }

  private client(): GithubClient {
    if (this.built) return this.built;
    const token = this.source.secretEnc ? canonicalGithubToken(decryptSecret(this.source.secretEnc, keyringOf(this.ctx.config))) : null;
    const apiBase = this.options.apiBase ?? this.cfg.apiBaseUrl;
    this.built = new GithubClient({
      fetch: sourceEgress({
        allowedHosts: [...(this.ctx.config.SOURCE_ALLOWED_HOSTS ?? [])],
        pinnedHosts: [new URL(apiBase).hostname],
        label: 'GitHub',
        subject: 'the API address',
        httpsOnly: !this.options.apiBase,
        methods: ['GET', 'POST'],
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...this.egress,
      }),
      apiBase,
      owner: this.cfg.owner,
      repo: this.cfg.repo,
      token,
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.retryDelayMs === undefined ? {} : { retryDelayMs: this.options.retryDelayMs }),
    });
    return this.built;
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private get maxIssues(): number {
    return this.ctx.config.GITHUB_MAX_ISSUES ?? SOURCE_PAGE_LIMIT_DEFAULTS.GITHUB_MAX_ISSUES;
  }

  private get maxDiscussions(): number {
    return this.ctx.config.GITHUB_MAX_DISCUSSIONS ?? SOURCE_PAGE_LIMIT_DEFAULTS.GITHUB_MAX_DISCUSSIONS;
  }

  /**
   * The settings a cursor is only valid under. A change to any of them makes the next run a full one: closed
   * issues that were never listed, Discussions that were never read and another repository's numbers are not
   * found by asking what moved since.
   */
  private get scope(): string {
    const { owner, repo, apiBaseUrl, includeClosed, includeDiscussions, includeBots } = this.cfg;
    return JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), apiBaseUrl, includeClosed, includeDiscussions, includeBots]);
  }

  // -- files ------------------------------------------------------------------------------------------

  private async numbersIn(root: string, dir: 'issues' | 'discussions'): Promise<Set<number>> {
    const out = new Set<number>();
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
      const match = entry.isFile() ? NUMBERED.exec(entry.name) : null;
      if (match) out.add(Number(match[1]));
    }
    return out;
  }

  /** Writes the file unless it already holds exactly this text, so an unchanged document keeps its modification time. */
  private async writeIfChanged(root: string, relative: string, text: string): Promise<boolean> {
    const absolute = path.join(root, ...relative.split('/'));
    if ((await fs.readFile(absolute, 'utf8').catch(() => null)) === text) return false;
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text, 'utf8');
    return true;
  }

  private async removeFile(root: string, relative: string): Promise<boolean> {
    const absolute = path.join(root, ...relative.split('/'));
    const existed = await fs
      .stat(absolute)
      .then(() => true)
      .catch(() => false);
    if (existed) await fs.rm(absolute, { force: true });
    return existed;
  }

  // -- what is in scope -------------------------------------------------------------------------------

  /** Whether an issue is a document of this source: not a pull request, open unless closed ones are wanted, and not a bot's unless bots are. */
  private wantsIssue(issue: GithubIssue): boolean {
    if (issue.isPullRequest) return false;
    if (issue.state === 'closed' && !this.cfg.includeClosed) return false;
    return keepsAuthor(issue.author, this.cfg.includeBots);
  }

  private wantsDiscussion(discussion: GithubDiscussion): boolean {
    return keepsAuthor(discussion.author, this.cfg.includeBots);
  }

  private async writeIssue(root: string, issue: GithubIssue, comments: readonly GithubComment[], stats: RunStats): Promise<void> {
    const changed = await this.writeIfChanged(root, issueFileName(issue.number), renderIssue(issue, comments, this.cfg.includeBots));
    if (changed) stats.written++;
    else stats.unchanged++;
  }

  private async writeDiscussion(root: string, discussion: GithubDiscussion, stats: RunStats): Promise<void> {
    const changed = await this.writeIfChanged(root, discussionFileName(discussion.number), renderDiscussion(discussion, this.cfg.includeBots));
    if (changed) stats.written++;
    else stats.unchanged++;
  }

  // -- the two kinds of run ---------------------------------------------------------------------------

  private async needsFullRun(root: string): Promise<boolean> {
    // A forced run is the user asking for everything to be read again (ADR-0128 decision 6).
    if (this.ctx.force === true) return true;
    const { syncedSince, lastFullRunAt } = this.cfg;
    if (!syncedSince || !lastFullRunAt || this.cfg.scope !== this.scope) return true;
    const lastFull = Date.parse(lastFullRunAt);
    if (Number.isNaN(lastFull) || Number.isNaN(Date.parse(syncedSince))) return true;
    const hours = this.ctx.config.SYNC_MAX_SKIP_HOURS;
    const limit = (hours !== undefined && hours > 0 ? hours : FALLBACK_FULL_RUN_HOURS) * 3_600_000;
    if (this.now() - lastFull > limit) return true;
    // A cursor with nothing on disk (a restored backup, an imported project, a wiped data directory) is a cursor
    // for documents this instance does not have. A full run creates `issues/` even for a repository with none.
    const present = await fs
      .stat(path.join(root, 'issues'))
      .then((s) => s.isDirectory())
      .catch(() => false);
    return !present;
  }

  private async fullRun(client: GithubClient, root: string, stats: RunStats): Promise<void> {
    stats.mode = 'full';
    // The ceiling counts the issues this source would index, not every number it lists: closed issues (while they
    // are left out) and a bot's would otherwise use it up, and the older open issues behind them would never arrive.
    const wanted = new Map<number, GithubIssue>();
    const listed = new Set<number>();
    listing: for await (const page of client.listIssues()) {
      for (const issue of page) {
        if (issue.isPullRequest || listed.has(issue.number)) continue;
        listed.add(issue.number);
        if (!this.wantsIssue(issue)) continue;
        if (wanted.size >= this.maxIssues) {
          stats.issuesTruncated = true;
          break listing;
        }
        wanted.set(issue.number, issue);
      }
    }

    // The repository-wide comment list, once, grouped by issue: no request per issue. It also holds the comments
    // of pull requests, which `wanted` leaves out.
    const comments = new Map<number, GithubComment[]>();
    if (wanted.size > 0) {
      for await (const page of client.listRepositoryComments()) {
        for (const comment of page) {
          if (!wanted.has(comment.issueNumber)) continue;
          const list = comments.get(comment.issueNumber);
          if (list) list.push(comment);
          else comments.set(comment.issueNumber, [comment]);
        }
      }
    }

    await fs.mkdir(path.join(root, 'issues'), { recursive: true });
    for (const issue of wanted.values()) await this.writeIssue(root, issue, comments.get(issue.number) ?? [], stats);
    for (const number of await this.numbersIn(root, 'issues')) {
      if (wanted.has(number)) continue;
      if (await this.removeFile(root, issueFileName(number))) stats.removed++;
    }

    const seenDiscussions = new Set<number>();
    if (this.cfg.includeDiscussions) {
      await fs.mkdir(path.join(root, 'discussions'), { recursive: true });
      let kept = 0;
      // Newest-created first: the list is what this run deletes by, so it must not shuffle while it is read.
      listing: for await (const page of client.listDiscussions('created')) {
        for (const discussion of page) {
          if (seenDiscussions.has(discussion.number)) continue;
          seenDiscussions.add(discussion.number);
          if (!this.wantsDiscussion(discussion)) continue;
          if (kept >= this.maxDiscussions) {
            stats.discussionsTruncated = true;
            // Not written, and not "seen": a document of it from an earlier run goes with the rest below.
            seenDiscussions.delete(discussion.number);
            break listing;
          }
          kept++;
          await this.writeDiscussion(root, discussion, stats);
        }
      }
    }
    // Everything on disk that the listing no longer names: deleted, transferred, or left out by a changed setting.
    for (const number of await this.numbersIn(root, 'discussions')) {
      if (seenDiscussions.has(number)) continue;
      if (await this.removeFile(root, discussionFileName(number))) stats.removed++;
    }
  }

  /** Returns `false` when so much moved that a full run is the better way to be right; nothing is stored for it. */
  private async incrementalRun(client: GithubClient, root: string, stats: RunStats): Promise<boolean> {
    const since = new Date(Date.parse(this.cfg.syncedSince as string) - SKEW_MS);
    // `null` is an issue known only from a comment on it.
    const moved = new Map<number, GithubIssue | null>();
    const onDisk = await this.numbersIn(root, 'issues');
    for await (const page of client.listIssues({ since })) {
      for (const issue of page) {
        // Pull requests are not documents and do not count towards the limit below; one that is on disk anyway
        // (the issue it was written as became a pull request) leaves.
        if (issue.isPullRequest) {
          if (onDisk.has(issue.number) && (await this.removeFile(root, issueFileName(issue.number)))) stats.removed++;
          continue;
        }
        moved.set(issue.number, issue);
      }
    }
    for await (const page of client.listRepositoryComments({ since })) {
      for (const comment of page) {
        // The repository-wide list carries the conversation of every pull request too; a busy repository's would
        // otherwise count as hundreds of issues that moved.
        if (comment.onPullRequest || moved.has(comment.issueNumber)) continue;
        moved.set(comment.issueNumber, null);
      }
    }
    if (moved.size > INCREMENTAL_LIMIT) return false;

    for (const [number, known] of moved) {
      const issue = known ?? (await client.issue(number));
      if (!issue || !this.wantsIssue(issue)) {
        // Deleted, transferred, turned into a pull request, closed while closed ones are not wanted, or a bot's.
        if (await this.removeFile(root, issueFileName(number))) stats.removed++;
        continue;
      }
      const comments: GithubComment[] = [];
      for await (const page of client.listIssueComments(number)) comments.push(...page);
      await this.writeIssue(root, issue, comments, stats);
    }

    if (this.cfg.includeDiscussions) {
      listing: for await (const page of client.listDiscussions('updated')) {
        for (const discussion of page) {
          // Newest update first: the first one older than the cursor ends the walk.
          const updated = Date.parse(discussion.updatedAt);
          if (!Number.isNaN(updated) && updated < since.getTime()) break listing;
          if (this.wantsDiscussion(discussion)) await this.writeDiscussion(root, discussion, stats);
          else if (await this.removeFile(root, discussionFileName(discussion.number))) stats.removed++;
        }
      }
    }
    return true;
  }

  // -- SourceDriver -----------------------------------------------------------------------------------

  async test(): Promise<string> {
    this.requireTokenForDiscussions();
    const client = this.client();
    const repo = await client.repository();
    const parts = [
      `Connected to ${repo.fullName} (${repo.private ? 'private' : 'public'}), ${client.authenticated ? 'with a token' : 'without a token — anonymous requests share a small hourly limit'}`,
    ];
    if (!repo.hasIssues) parts.push('Issues are switched off for this repository');
    if (this.cfg.includeDiscussions) {
      if (repo.hasDiscussions === false) parts.push('Discussions are switched off for this repository');
      else {
        await client.newestDiscussion();
        parts.push('Discussions are readable');
      }
    }
    return parts.join(' — ');
  }

  /** What the freshness check compares, taken before the run lists anything so that a change made while it ran is seen by the next check. */
  private async takeMarks(client: GithubClient): Promise<{ etag: string | null; discussions: string | null }> {
    const newest = await client.newestIssue();
    return {
      etag: newest.unchanged ? null : newest.etag,
      discussions: this.cfg.includeDiscussions ? await client.newestDiscussion() : null,
    };
  }

  async sync(): Promise<SyncResult> {
    this.requireTokenForDiscussions();
    const client = this.client();
    const root = await this.docRoot();
    const startedAt = new Date(this.now());
    const marks = await this.takeMarks(client);

    const stats: RunStats = { mode: 'incremental', written: 0, unchanged: 0, removed: 0, issuesTruncated: false, discussionsTruncated: false };
    let full = await this.needsFullRun(root);
    if (!full) full = !(await this.incrementalRun(client, root, stats));
    if (full) {
      // Counted again from nothing: whatever an abandoned incremental run wrote is what the full run would have written.
      Object.assign(stats, { written: 0, unchanged: 0, removed: 0 });
      await this.fullRun(client, root, stats);
    }

    const extras = [`${stats.mode} run`, `${client.requests} request(s)`];
    let note = `${stats.written} written, ${stats.unchanged} unchanged, ${stats.removed} removed [${extras.join('; ')}]`;
    if (stats.issuesTruncated) {
      this.ctx.log.warn(
        { source: this.source.name, max: this.maxIssues },
        'github source reached GITHUB_MAX_ISSUES; the issues past the ceiling are not indexed',
      );
      note += ` — STOPPED AT THE ${this.maxIssues}-ISSUE CEILING (GITHUB_MAX_ISSUES): this repository has more issues than that, and the older ones are NOT indexed. Raise GITHUB_MAX_ISSUES${this.cfg.includeClosed ? ', or leave closed issues out' : ''}.`;
    }
    if (stats.discussionsTruncated) {
      this.ctx.log.warn(
        { source: this.source.name, max: this.maxDiscussions },
        'github source reached GITHUB_MAX_DISCUSSIONS; the discussions past the ceiling are not indexed',
      );
      note += ` — STOPPED AT THE ${this.maxDiscussions}-DISCUSSION CEILING (GITHUB_MAX_DISCUSSIONS): this repository has more discussions than that, and the older ones are NOT indexed. Raise GITHUB_MAX_DISCUSSIONS.`;
    }

    const token = marks.etag === null ? null : this.probeToken(marks.etag, marks.discussions);
    return {
      note,
      configPatch: {
        syncedSince: startedAt.toISOString(),
        scope: this.scope,
        // A full run is when deletions were last found; an incremental one leaves that date where it was.
        lastFullRunAt: full ? new Date(this.now()).toISOString() : this.cfg.lastFullRunAt,
        // `undefined` drops the key from the stored JSON: a validator that could not be taken must not leave an old one behind.
        issuesEtag: marks.etag ?? undefined,
        discussionsMark: marks.discussions ?? undefined,
        [PROBE_TOKEN_KEY]: token ?? undefined,
      },
    };
  }

  private probeToken(etag: string, discussions: string | null): string {
    return `issues:${etag}${discussions === null ? '' : `|discussions:${discussions}`}`;
  }

  /**
   * One conditional request for the newest issue and, with Discussions on, one GraphQL query for the newest
   * Discussion. The token is built by the same function the sync stored it with, from the stored validator when
   * GitHub answers `304`, so nothing changed returns the stored token and the scheduler skips the run. No validator
   * stored yet, or none sent, is "run it" ([ADR-0048](../../../.ssot/ADR.md#adr-0048) rule 1).
   */
  async probe(): Promise<string | null> {
    this.requireTokenForDiscussions();
    const client = this.client();
    const stored = this.cfg.issuesEtag;
    const newest = await client.newestIssue(stored);
    const etag = newest.unchanged ? (stored ?? null) : newest.etag;
    if (etag === null) return null;
    const discussions = this.cfg.includeDiscussions ? await client.newestDiscussion() : null;
    this.ctx.log.debug({ source: this.source.name, requests: client.requests, unchanged: newest.unchanged }, 'github probe');
    return this.probeToken(etag, discussions);
  }

  // -- source links (ADR-0116) ------------------------------------------------------------------------

  /** The issue or Discussion URL and update time the sync wrote into each file's front matter; never a remote call. */
  documentMeta(files: readonly DocumentMetaFile[]): Promise<Map<string, DocumentMeta>> {
    return frontmatterMeta(files, 'url', 'updated_at');
  }
}

registerDriver('github', (source, ctx) => new GithubDriver(source, ctx));
