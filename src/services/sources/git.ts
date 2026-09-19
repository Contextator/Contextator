import fs from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import type { DocumentSourceRow } from '../../db/schema.js';
import { decryptSecret } from '../crypto.js';
import { sourceRepoDir } from '../data-dir.js';
import { isInside } from '../fs-scan.js';
import { PathNotAllowedError } from '../fs-scan.js';
import { PROBE_TOKEN_KEY, parseSourceConfig, type GitConfig } from '../sources.js';
import { registerDriver, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
import { credentialsFor, detectProvider, sanitizeGitUrl } from './git-auth.js';

/**
 * Git repositories via isomorphic-git (the container image has no git binary). Shallow, single-branch
 * checkouts under `<source>/repo/`. Sync = fetch the branch tip; when it moved, point the local branch
 * at it and force-checkout. Any failure falls back to a fresh clone.
 */
export class GitDriver implements SourceDriver {
  private readonly cfg: GitConfig;

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
  ) {
    this.cfg = parseSourceConfig('git', source.config);
  }

  private get dir(): string {
    return sourceRepoDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
  }

  private authOptions() {
    const url = sanitizeGitUrl(this.cfg.url);
    const token = this.source.secretEnc ? decryptSecret(this.source.secretEnc, this.ctx.config.SECRET_KEY) : null;
    const provider = detectProvider(url, this.cfg.provider);
    return {
      url,
      onAuth: token ? () => credentialsFor(provider, token, this.cfg.username) : undefined,
      onAuthFailure: () => ({ cancel: true }) as const,
    };
  }

  private async currentHead(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' });
    } catch {
      return null;
    }
  }

  private async clone(): Promise<string> {
    const { url, onAuth, onAuthFailure } = this.authOptions();
    await fs.rm(this.dir, { recursive: true, force: true, maxRetries: 5 });
    await fs.mkdir(this.dir, { recursive: true });
    await git.clone({ fs, http, dir: this.dir, url, ref: this.cfg.branch, singleBranch: true, depth: 1, noTags: true, onAuth, onAuthFailure });
    const head = await this.currentHead();
    if (!head) throw new Error('Clone succeeded but HEAD could not be resolved');
    return head;
  }

  /** Fetches the branch tip; returns the new HEAD (unchanged when already up to date). */
  private async update(): Promise<{ head: string; changed: boolean }> {
    const { url, onAuth, onAuthFailure } = this.authOptions();
    const before = await this.currentHead();
    const { fetchHead } = await git.fetch({
      fs,
      http,
      dir: this.dir,
      url,
      ref: this.cfg.branch,
      remoteRef: this.cfg.branch,
      singleBranch: true,
      depth: 1,
      tags: false,
      onAuth,
      onAuthFailure,
    });
    if (!fetchHead) throw new Error(`Branch "${this.cfg.branch}" not found on the remote`);
    if (fetchHead === before) return { head: fetchHead, changed: false };
    await git.writeRef({ fs, dir: this.dir, ref: `refs/heads/${this.cfg.branch}`, value: fetchHead, force: true });
    await git.checkout({ fs, dir: this.dir, ref: this.cfg.branch, force: true });
    return { head: fetchHead, changed: true };
  }

  async sync(): Promise<SyncResult> {
    const log = this.ctx.log.child({ source: this.source.name, type: 'git' });
    const existing = await this.currentHead();
    let head: string;
    let note: string;
    if (existing && this.cfg.lastCommit) {
      try {
        const r = await this.update();
        head = r.head;
        note = r.changed ? `updated to ${head.slice(0, 7)}` : `already at ${head.slice(0, 7)}`;
      } catch (err) {
        log.warn({ err }, 'git fetch failed; re-cloning');
        head = await this.clone();
        note = `re-cloned at ${head.slice(0, 7)}`;
      }
    } else {
      head = await this.clone();
      note = `cloned at ${head.slice(0, 7)}`;
    }
    await this.docRoot(); // validates the subdirectory exists in this checkout
    // The head this run checked out **is** the token `probe()` will answer with next time, so git is
    // the one driver whose sync pays nothing at all for scheduling ([ADR-0048](../../../.ssot/ADR.md#adr-0048)).
    // It is written under both keys rather than the scheduler being taught to read `lastCommit`: one
    // of them is the driver's own state and the other is the scheduler's contract, and collapsing the
    // two would make a future change to either a change to both.
    return { configPatch: { lastCommit: head, [PROBE_TOKEN_KEY]: head }, note };
  }

  /**
   * The branch tip as the remote advertises it — `git ls-remote`, which is what
   * `git.listServerRefs` is: one HTTPS request for the ref advertisement and no objects at all,
   * against a fetch that transfers a commit's worth of tree.
   *
   * `null` when the branch is not there, so the run happens and reports the real error rather than
   * the source going quiet because the branch was renamed.
   */
  async probe(): Promise<string | null> {
    const { url, onAuth, onAuthFailure } = this.authOptions();
    const refs = await git.listServerRefs({ http, url, prefix: `refs/heads/${this.cfg.branch}`, onAuth, onAuthFailure });
    return refs.find((r) => r.ref === `refs/heads/${this.cfg.branch}`)?.oid ?? null;
  }

  async docRoot(): Promise<string> {
    const root = this.dir;
    const sub = this.cfg.subdir ? path.resolve(root, ...this.cfg.subdir.split('/')) : root;
    if (!isInside(root, sub)) throw new PathNotAllowedError('subdir escapes the repository');
    try {
      if (!(await fs.stat(sub)).isDirectory()) throw new Error();
    } catch {
      throw new PathNotAllowedError(`Subdirectory "${this.cfg.subdir}" does not exist in the repository (branch ${this.cfg.branch})`);
    }
    return sub;
  }

  async test(): Promise<string> {
    const { url, onAuth, onAuthFailure } = this.authOptions();
    const refs = await git.listServerRefs({ http, url, prefix: `refs/heads/${this.cfg.branch}`, onAuth, onAuthFailure });
    const match = refs.find((r) => r.ref === `refs/heads/${this.cfg.branch}`);
    if (!match) throw new Error(`Connected, but branch "${this.cfg.branch}" was not found on the remote`);
    return `Connected: ${this.cfg.branch} is at ${match.oid.slice(0, 7)}`;
  }
}

registerDriver('git', (source, ctx) => new GitDriver(source, ctx));
