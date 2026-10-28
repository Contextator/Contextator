import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { CREDENTIAL_SOURCE_TYPES } from '../src/services/encrypted-fields.js';
import { sourceEgress } from '../src/services/sources/confluence-egress.js';
import type { DriverContext } from '../src/services/sources/driver.js';
import { GithubDriver, INCREMENTAL_LIMIT } from '../src/services/sources/github.js';
import {
  canonicalGithubToken,
  GithubClient,
  GithubRateLimitError,
  GithubRequestError,
  graphqlUrlFor,
} from '../src/services/sources/github-client.js';
import { renderDiscussion, renderIssue } from '../src/services/sources/github-render.js';
import { exportedSource } from '../src/services/transfer/export.js';
import { importedSourceConfig } from '../src/services/transfer/import.js';
import { GITHUB_SERVER_KEYS, GithubConfig, parseSourceConfig, PROBE_TOKEN_KEY, SOURCE_TYPES } from '../src/services/sources.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, routeToLoopback } from './support/egress-seams.js';
import { GOOD_TOKEN, OWNER, REPO, StubGithub } from './support/github-stub.js';

/**
 * The `github` source ([ADR-0128](../.ssot/ADR.md#adr-0128)) against a fake of GitHub's REST and GraphQL API on the
 * loopback interface, reached **through** the egress guard and its host pin by a made-up name
 * (`test/support/egress-seams.ts`, `test/support/github-stub.ts`). The stub keeps a clock the test moves, so what
 * an incremental run selects is the test's to decide, and it models the behaviours the source depends on (an edited
 * comment does not move its issue, a deleted issue is in no list, a rate limit is a `403`).
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const KEY = 'k'.repeat(64);
const PROJECT_ID = '00000000-0000-4000-8000-000000000081';
const SOURCE_ID = '00000000-0000-4000-8000-000000000082';
const API_HOST = 'api.github.fixture.test';

let stub: StubGithub;
let dataDir: string;
/** What the indexer would have stored on the source row: the settings, and whatever `configPatch` carried back. */
let stored: Record<string, unknown>;

beforeEach(async () => {
  stub = new StubGithub();
  await stub.start();
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-github-driver-')));
  stored = { owner: OWNER, repo: REPO };
});
afterEach(async () => {
  await stub.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const seams = {
  resolve: fakeResolver({ [API_HOST]: PUBLIC_FIXTURE_ADDRESS }),
  route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
};

const row = (config: Record<string, unknown>, token: string | null): DocumentSourceRow =>
  ({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 'github',
    name: 'gh',
    label: '',
    config,
    secretEnc: token === null ? null : encryptSecret(token, { current: KEY }),
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

const context = (extra: Record<string, unknown> = {}): DriverContext => ({
  db: null as never,
  log,
  config: {
    ...WEB_LIMIT_DEFAULTS,
    DATA_DIR: dataDir,
    SECRET_KEY: KEY,
    ALLOWED_DOC_ROOTS: [],
    IGNORE_GLOBS: [],
    SYNC_MAX_SKIP_HOURS: 24,
    ...extra,
  } as DriverContext['config'],
});

const driverOf = (config: Record<string, unknown>, token: string | null, extra: Record<string, unknown> = {}, egress = seams) =>
  new GithubDriver(row(config, token), context(extra), egress, { retryDelayMs: 1, apiBase: stub.apiBase(API_HOST), now: () => stub.nowMs });

/** One run as the indexer performs it: the driver reads the stored settings, and what it returns is stored on success only. */
async function run(options: { token?: string | null; extra?: Record<string, unknown> } = {}) {
  const token = options.token === undefined ? GOOD_TOKEN : options.token;
  const result = await driverOf(stored, token, options.extra).sync();
  stored = JSON.parse(JSON.stringify({ ...stored, ...result.configPatch })) as Record<string, unknown>;
  return result;
}

const tree = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else out.push(`${rel}${entry.name}`);
    }
  };
  await walk(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), '');
  return out.sort();
};
const read = (rel: string): Promise<string> => fs.readFile(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), ...rel.split('/')), 'utf8');

/** Three open issues, one closed, one pull request, with comments on two of them. */
function repository() {
  const a = stub.issue({ title: 'Rotate the signing secret', labels: ['security', 'docs'] });
  const b = stub.issue({ title: 'Backup schedule' });
  const c = stub.issue({ title: 'Old decision', state: 'closed' });
  const pr = stub.issue({ title: 'Fix the typo', pr: true });
  const d = stub.issue({ title: 'Release train' });
  stub.comment(a.number, 'Use the rotate-secret script.');
  stub.comment(a.number, 'Done in 0.5.0.', { login: 'maintainer' });
  stub.comment(c.number, 'Closed as superseded.');
  stub.comment(pr.number, 'A comment on a pull request, which the comment list also carries.');
  // The first run starts half an hour later: an incremental run reaches back five minutes, and the fixture must be outside that.
  stub.advance(30);
  return { a, b, c, pr, d };
}

describe('the github credential and settings', () => {
  it('is on the credential list as a bare token, and the type is registered', () => {
    expect([...CREDENTIAL_SOURCE_TYPES]).toContain('github');
    expect([...SOURCE_TYPES]).toContain('github');
  });

  it('trims a token and refuses one a header cannot carry, without echoing it', () => {
    expect(canonicalGithubToken(`  ${GOOD_TOKEN}\n`)).toBe(GOOD_TOKEN);
    for (const bad of ['two words', `${GOOD_TOKEN}\r\nx-evil: 1`, '', 'tokén']) {
      let message = '';
      try {
        canonicalGithubToken(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('single word');
      expect(message).not.toContain(bad.trim() || 'never-empty');
    }
  });

  it('takes the documented defaults and normalises the API base', () => {
    const cfg = parseSourceConfig('github', { owner: 'octo-org', repo: 'handbook' });
    expect(cfg).toMatchObject({
      apiBaseUrl: 'https://api.github.com',
      includeClosed: false,
      includeDiscussions: false,
      includeBots: true,
      extensions: ['md'],
    });
    expect(parseSourceConfig('github', { owner: 'o', repo: 'r', apiBaseUrl: 'https://ghe.example.com/api/v3/' }).apiBaseUrl).toBe(
      'https://ghe.example.com/api/v3',
    );
    expect(parseSourceConfig('github', { owner: 'o', repo: 'r', apiBaseUrl: '' }).apiBaseUrl).toBe('https://api.github.com');
  });

  it('refuses a plain-http base, a credential in the URL, a query, and names that are not names', () => {
    const parse = (extra: Record<string, unknown>) => parseSourceConfig('github', { owner: 'o', repo: 'r', ...extra });
    expect(() => parse({ apiBaseUrl: 'http://ghe.example.com/api/v3' })).toThrow(/https/);
    expect(() => parse({ apiBaseUrl: 'https://user:pw@ghe.example.com/api/v3' })).toThrow(/user or password/);
    expect(() => parse({ apiBaseUrl: 'https://ghe.example.com/api/v3?x=1' })).toThrow(/query/);
    expect(() => parse({ owner: '-bad' })).toThrow(/organisation/);
    expect(() => parse({ owner: 'a/b' })).toThrow();
    expect(() => parse({ repo: '..' })).toThrow();
    expect(() => parse({ repo: 'a b' })).toThrow();
    expect(() => parseSourceConfig('github', { repo: 'r' })).toThrow(/owner/);
  });

  it('knows the GraphQL address of github.com and of an Enterprise Server base', () => {
    expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrlFor('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/api/graphql');
  });

  it('keeps the server’s five keys when it is given them, which the services overwrite', () => {
    expect([...GITHUB_SERVER_KEYS]).toEqual(['syncedSince', 'lastFullRunAt', 'scope', 'issuesEtag', 'discussionsMark']);
    expect(GithubConfig.parse({ owner: 'o', repo: 'r', syncedSince: '2026-10-01T00:00:00Z', issuesEtag: 'W/"x"' })).toMatchObject({
      syncedSince: '2026-10-01T00:00:00Z',
    });
  });

  it('drops the cursor and the validators an archive carries, and an export leaves them out', () => {
    const config = importedSourceConfig({
      type: 'github',
      config: {
        owner: 'o',
        repo: 'r',
        syncedSince: '2026-10-01T00:00:00Z',
        lastFullRunAt: '2026-10-01T00:00:00Z',
        scope: '[]',
        issuesEtag: 'W/"x"',
        discussionsMark: '1@2',
      },
    });
    for (const key of GITHUB_SERVER_KEYS) expect(config).not.toHaveProperty(key);
    expect(config).toMatchObject({ owner: 'o', repo: 'r' });

    const exported = exportedSource({
      type: 'github',
      name: 'gh',
      label: '',
      flavor: 'plain',
      syncIntervalMinutes: null,
      webhookMinIntervalMinutes: null,
      config: { owner: 'o', repo: 'r', syncedSince: '2026-10-01T00:00:00Z', issuesEtag: 'W/"x"', [PROBE_TOKEN_KEY]: 'issues:W/"x"' },
    } as unknown as DocumentSourceRow);
    expect(exported.config).toEqual({ owner: 'o', repo: 'r' });
  });
});

describe('the rendering', () => {
  const issue = {
    number: 7,
    title: 'Title with "quotes"',
    body: 'Line one\r\nLine two',
    state: 'closed' as const,
    stateReason: 'not_planned',
    htmlUrl: 'https://github.com/o/r/issues/7',
    labels: ['a', 'b'],
    author: { login: 'octocat', bot: false },
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-02T09:00:00Z',
    isPullRequest: false,
  };
  const comments = [
    { issueNumber: 7, body: 'First', author: { login: 'one', bot: false }, createdAt: '2026-10-01T10:00:00Z' },
    { issueNumber: 7, body: 'Second', author: { login: 'ci[bot]', bot: true }, createdAt: '2026-10-03T10:00:00Z' },
  ];

  it('is front matter, the body, then each comment under a heading naming its author and day, in order', () => {
    const text = renderIssue(issue, comments, true);
    expect(text.startsWith('---\nurl: "https://github.com/o/r/issues/7"\nupdated_at: "2026-10-02T09:00:00Z"\n')).toBe(true);
    expect(text).toContain('title: "Title with \\"quotes\\""');
    expect(text).toContain('state: "closed (not planned)"');
    expect(text).toContain('labels: "a, b"');
    expect(text).toContain('# Title with "quotes" (#7)\n\nLine one\nLine two');
    expect(text.indexOf('## one — 2026-10-01\n\nFirst')).toBeGreaterThan(0);
    expect(text.indexOf('## ci[bot] (bot) — 2026-10-03\n\nSecond')).toBeGreaterThan(text.indexOf('## one'));
  });

  it('leaves a bot’s comment out when bots are off, and says so for an empty body', () => {
    const text = renderIssue({ ...issue, body: '' }, comments, false);
    expect(text).not.toContain('Second');
    expect(text).toContain('_No description._');
  });

  it('renders a discussion with its answer and its replies one level down', () => {
    const text = renderDiscussion(
      {
        number: 9,
        title: 'How?',
        body: 'Question',
        htmlUrl: 'https://github.com/o/r/discussions/9',
        category: 'Q&A',
        labels: [],
        author: { login: 'asker', bot: false },
        createdAt: '2026-10-01T09:00:00Z',
        updatedAt: '2026-10-01T09:00:00Z',
        closed: false,
        answered: true,
        comments: [
          {
            issueNumber: 0,
            body: 'Like this',
            author: { login: 'helper', bot: false },
            createdAt: '2026-10-02T09:00:00Z',
            isAnswer: true,
            replies: [{ issueNumber: 0, body: 'Thanks', author: { login: 'asker', bot: false }, createdAt: '2026-10-03T09:00:00Z' }],
          },
        ],
      },
      true,
    );
    expect(text).toContain('state: "answered"');
    expect(text).toContain('category: "Q&A"');
    expect(text).toContain('## helper — 2026-10-02 — accepted answer\n\nLike this');
    expect(text).toContain('### asker — 2026-10-03 (reply)\n\nThanks');
  });
});

describe('the first run', () => {
  it('writes the open issues with their comments, skips closed ones and pull requests, and stores its cursor', async () => {
    const r = repository();
    const result = await run();

    expect(await tree()).toEqual([`issues/${r.a.number}.md`, `issues/${r.b.number}.md`, `issues/${r.d.number}.md`].sort());
    const a = await read(`issues/${r.a.number}.md`);
    expect(a).toContain('title: "Rotate the signing secret"');
    expect(a).toContain('labels: "security, docs"');
    expect(a.indexOf('Use the rotate-secret script.')).toBeLessThan(a.indexOf('Done in 0.5.0.'));
    expect(a).toContain('## maintainer — 2026-10-01');
    expect(await read(`issues/${r.b.number}.md`)).not.toContain('## ');
    expect(result.note).toContain('3 written, 0 unchanged, 0 removed [full run;');

    const first = stub.log.filter((q) => q.kind !== 'newest').map((q) => q.kind);
    expect(stub.log[0]?.kind).toBe('newest');
    expect(first).toEqual(['issues', 'repo-comments']);
    expect(stored.syncedSince).toBe(new Date(stub.nowMs).toISOString());
    expect(stored.issuesEtag).toMatch(/^W\/"/);
    expect(stored[PROBE_TOKEN_KEY]).toBe(`issues:${String(stored.issuesEtag)}`);
    expect(stored.scope).toBeTruthy();
    expect(stored.lastFullRunAt).toBeTruthy();
  });

  it('takes the freshness validator before it lists anything', async () => {
    repository();
    await run();
    const kinds = stub.log.map((q) => q.kind);
    expect(kinds.indexOf('newest')).toBeLessThan(kinds.indexOf('issues'));
    expect(stub.log[0]?.ifNoneMatch).toBeUndefined();
  });

  it('keeps closed issues when they are opted in, with the state in the front matter', async () => {
    const r = repository();
    stored.includeClosed = true;
    await run();
    expect(await tree()).toContain(`issues/${r.c.number}.md`);
    const closed = await read(`issues/${r.c.number}.md`);
    expect(closed).toContain('state: "closed (completed)"');
    expect(closed).toContain('Closed as superseded.');
    // A pull request is never a document, whatever the setting.
    expect(await tree()).not.toContain(`issues/${r.pr.number}.md`);
  });

  it('follows the Link header over pages and refuses a link to another host', async () => {
    for (let i = 1; i <= 5; i++) stub.issue({ title: `Issue ${i}` });
    stub.restPageSize = 2;
    await run();
    expect((await tree()).length).toBe(5);
    expect(stub.count('issues')).toBe(3);

    stub.nextLinkHost = 'evil.fixture.test';
    stored = { owner: OWNER, repo: REPO };
    await expect(run()).rejects.toThrow('pagination link to another host');
    expect(stub.log.some((q) => q.host === 'evil.fixture.test')).toBe(false);
  });

  it('stops at GITHUB_MAX_ISSUES, newest first, and says so in capitals', async () => {
    for (let i = 1; i <= 5; i++) stub.issue({ title: `Issue ${i}` });
    const result = await run({ extra: { GITHUB_MAX_ISSUES: 3 } });
    expect(await tree()).toEqual(['issues/3.md', 'issues/4.md', 'issues/5.md']);
    expect(result.note).toContain('STOPPED AT THE 3-ISSUE CEILING (GITHUB_MAX_ISSUES)');
  });

  it('counts the ceiling over the issues it would index: closed ones do not use it up', async () => {
    for (let i = 1; i <= 3; i++) stub.issue({ title: `Open ${i}` });
    stub.advance(1);
    for (let i = 1; i <= 4; i++) stub.issue({ title: `Closed ${i}`, state: 'closed' });
    const result = await run({ extra: { GITHUB_MAX_ISSUES: 3 } });
    expect(await tree()).toEqual(['issues/1.md', 'issues/2.md', 'issues/3.md']);
    expect(result.note).not.toContain('CEILING');
  });

  it('tells the truth when the ceiling does cut: closed issues are not the advice while they are already left out', async () => {
    for (let i = 1; i <= 4; i++) stub.issue({ title: `Open ${i}` });
    const result = await run({ extra: { GITHUB_MAX_ISSUES: 3 } });
    expect(result.note).toContain('STOPPED AT THE 3-ISSUE CEILING');
    expect(result.note).toContain('Raise GITHUB_MAX_ISSUES.');
    expect(result.note).not.toContain('leave closed issues out');
    stored = { owner: OWNER, repo: REPO, includeClosed: true };
    expect((await run({ extra: { GITHUB_MAX_ISSUES: 3 } })).note).toContain('or leave closed issues out');
  });

  it('drops bots when bots are off: a bot’s issue, and a bot’s comment on a person’s', async () => {
    const human = stub.issue({ title: 'Human issue' });
    stub.issue({ title: 'Bot issue', user: { login: 'dependabot[bot]', bot: true } });
    stub.comment(human.number, 'Human words');
    stub.comment(human.number, 'Automated words', { login: 'ci[bot]', bot: true });
    stored.includeBots = false;
    await run();
    expect(await tree()).toEqual([`issues/${human.number}.md`]);
    const text = await read(`issues/${human.number}.md`);
    expect(text).toContain('Human words');
    expect(text).not.toContain('Automated words');

    stored = { owner: OWNER, repo: REPO, includeBots: true };
    await run();
    expect((await tree()).length).toBe(2);
    expect(await read(`issues/${human.number}.md`)).toContain('## ci[bot] (bot)');
  });
});

describe('an incremental run', () => {
  it('re-renders only the issues that moved, and reads their comments, not everyone’s', async () => {
    const r = repository();
    await run();
    const untouched = await fs.stat(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), 'issues', `${r.b.number}.md`));

    stub.advance(60);
    stub.comment(r.a.number, 'A new comment after the first run.');
    stub.edit(r.d.number, { body: 'Release train, revised body.' });
    stub.reset();
    const result = await run();

    expect(result.note).toContain('2 written, 0 unchanged, 0 removed [incremental run;');
    expect(await read(`issues/${r.a.number}.md`)).toContain('A new comment after the first run.');
    expect(await read(`issues/${r.d.number}.md`)).toContain('revised body');
    // The issue list was asked with `since` and ascending update order; nothing was listed in full.
    const listing = stub.log.filter((q) => q.kind === 'issues');
    expect(listing).toHaveLength(1);
    expect(listing[0]?.query).toMatchObject({ sort: 'updated', direction: 'asc' });
    expect(listing[0]?.query.since).toBeTruthy();
    // The affected issues' comments were read per issue; the issue nobody touched was not.
    expect(stub.log.filter((q) => q.kind === 'issue-comments').map((q) => q.path)).toEqual([
      `/repos/${OWNER}/${REPO}/issues/${r.a.number}/comments`,
      `/repos/${OWNER}/${REPO}/issues/${r.d.number}/comments`,
    ]);
    const after = await fs.stat(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), 'issues', `${r.b.number}.md`));
    expect(after.mtimeMs).toBe(untouched.mtimeMs);
    expect(stored.lastFullRunAt).toBeTruthy();
  });

  it('moves the cursor back by a few minutes, so an edit made while the last run listed is not missed', async () => {
    const r = repository();
    await run();
    const startedAt = stub.nowMs;
    // GitHub stamped the edit two minutes before the run began, by its own clock; the run did not see it. Without the
    // skew the next run would start from the moment this one began and never ask for it.
    stub.nowMs = startedAt - 2 * 60_000;
    stub.edit(r.b.number, { body: 'Edited just before the run started.' });
    stub.nowMs = startedAt + 10 * 60_000;
    const result = await run();
    expect(result.note).toContain('1 written');
    expect(await read(`issues/${r.b.number}.md`)).toContain('Edited just before');
  });

  it('does not count pull requests, nor the comments on them, towards the limit that makes a run a full one', async () => {
    const r = repository();
    await run();
    stub.advance(60);
    for (let i = 0; i < INCREMENTAL_LIMIT + 5; i++) {
      const pr = stub.issue({ title: `Pull request ${i}`, pr: true });
      stub.comment(pr.number, `Review comment ${i}`);
    }
    stub.edit(r.d.number, { body: 'The only issue that moved.' });
    const result = await run();
    expect(result.note).toContain('1 written, 0 unchanged, 0 removed [incremental run;');
    expect((await tree()).length).toBe(3);
  });

  it('finds an edited comment even though its issue did not move', async () => {
    const r = repository();
    await run();
    const [first] = stub.comments;
    stub.advance(60);
    stub.editComment(first?.id ?? 0, 'Use the rotate-secret script, version two.');
    const result = await run();
    expect(result.note).toContain('1 written');
    expect(await read(`issues/${r.a.number}.md`)).toContain('version two');
  });

  it('drops a closed issue when closed ones are not wanted, and brings it back when it is reopened', async () => {
    const r = repository();
    await run();
    stub.advance(60);
    stub.close(r.b.number);
    expect((await run()).note).toContain('1 removed');
    expect(await tree()).not.toContain(`issues/${r.b.number}.md`);

    stub.advance(60);
    stub.reopen(r.b.number);
    expect((await run()).note).toContain('1 written');
    expect(await tree()).toContain(`issues/${r.b.number}.md`);
  });

  it('does not mistake a renamed repository for a transfer: the redirect stays on the repository’s own id', async () => {
    const r = repository();
    await run();
    stub.advance(60);
    stub.renamed = true;
    // A comment edit moves the comment and not its issue, so the issue is fetched one by one — through the redirect.
    stub.editComment(stub.comments[0]?.id ?? 0, 'Edited after the rename.');
    const result = await run();
    expect(result.note).toContain('1 written, 0 unchanged, 0 removed');
    expect(await read(`issues/${r.a.number}.md`)).toContain('Edited after the rename.');
  });

  it('keeps a closed issue that closed ones are opted in for, with its new state', async () => {
    const r = repository();
    stored.includeClosed = true;
    await run();
    stub.advance(60);
    stub.close(r.b.number, 'not_planned');
    const result = await run();
    expect(result.note).toContain('[incremental run;');
    expect(await read(`issues/${r.b.number}.md`)).toContain('state: "closed (not planned)"');
  });

  it('does not see a deleted or a transferred issue, which stay until a full run', async () => {
    const r = repository();
    await run();
    stub.advance(60);
    stub.delete(r.a.number);
    stub.transfer(r.b.number);
    // Something else moved, so the run is not skipped.
    stub.edit(r.d.number, { body: 'Moved on.' });
    const result = await run();
    expect(result.note).toContain('[incremental run;');
    expect(result.note).toContain('0 removed');
    expect(await tree()).toEqual([`issues/${r.a.number}.md`, `issues/${r.b.number}.md`, `issues/${r.d.number}.md`].sort());
  });

  it('becomes a full run when more than the limit moved, and then finds the deletion too', async () => {
    const r = repository();
    await run();
    stub.advance(60);
    stub.delete(r.a.number);
    for (let i = 0; i < INCREMENTAL_LIMIT + 1; i++) stub.issue({ title: `Bulk ${i}` });
    const result = await run({ extra: { GITHUB_MAX_ISSUES: 1000 } });
    expect(result.note).toContain('[full run;');
    expect(await tree()).not.toContain(`issues/${r.a.number}.md`);
    expect((await tree()).length).toBe(2 + INCREMENTAL_LIMIT + 1);
  });

  it('turns a failed run into nothing: a rate limit mid-run stores no cursor, and the next run finds the same changes', async () => {
    const r = repository();
    await run();
    const before = JSON.stringify(stored);
    stub.advance(60);
    stub.comment(r.a.number, 'Written while the limit was hit.');
    // takeMarks passes, then the issue listing is refused.
    stub.scripted.push({ status: 200, body: [] }, { status: 429, body: { message: 'API rate limit exceeded' }, headers: { 'retry-after': '90' } });
    await expect(run()).rejects.toThrow(GithubRateLimitError);
    expect(JSON.stringify(stored)).toBe(before);

    const result = await run();
    expect(result.note).toContain('1 written');
    expect(await read(`issues/${r.a.number}.md`)).toContain('Written while the limit was hit.');
  });
});

describe('deletions and changed settings, found on a full run', () => {
  it('removes a deleted and a transferred issue when the last full run is older than SYNC_MAX_SKIP_HOURS', async () => {
    const r = repository();
    await run();
    stub.delete(r.a.number);
    stub.transfer(r.b.number);
    stub.advance(60 * 25);
    const result = await run();
    expect(result.note).toContain('[full run;');
    expect(result.note).toContain('2 removed');
    expect(await tree()).toEqual([`issues/${r.d.number}.md`]);
  });

  it('does not wait a day when the settings changed: closed issues arrive, and leave again', async () => {
    const r = repository();
    await run();
    expect(await tree()).not.toContain(`issues/${r.c.number}.md`);
    stored.includeClosed = true;
    expect((await run()).note).toContain('[full run;');
    expect(await tree()).toContain(`issues/${r.c.number}.md`);
    stored.includeClosed = false;
    const back = await run();
    expect(back.note).toContain('[full run;');
    expect(back.note).toContain('1 removed');
    expect(await tree()).not.toContain(`issues/${r.c.number}.md`);
  });

  it('lists everything when a cursor has nothing on disk behind it (a restore, an import, a wiped directory)', async () => {
    repository();
    await run();
    await fs.rm(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), { recursive: true, force: true });
    const result = await run();
    expect(result.note).toContain('[full run;');
    expect((await tree()).length).toBe(3);
  });

  it('is a full run when the cursor is unknown, and an empty repository stays quiet afterwards', async () => {
    const first = await run();
    expect(first.note).toContain('0 written, 0 unchanged, 0 removed [full run;');
    expect(await fs.readdir(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), 'issues'))).toEqual([]);
    stub.advance(10);
    expect((await run()).note).toContain('[incremental run;');
  });

  it('lists everything on a forced run, and only then finds a deletion before the full-run age', async () => {
    const r = repository();
    await run();
    stub.delete(r.a.number);
    stub.advance(10);
    stub.edit(r.d.number, { body: 'Moved on.' });
    // A normal run, the same minutes later: incremental, and the deleted issue stays.
    const normal = await run();
    expect(normal.note).toContain('[incremental run;');
    expect(await tree()).toContain(`issues/${r.a.number}.md`);
    // The user forces the run: every number is listed and the deleted one goes.
    const forced = await new GithubDriver(row(stored, GOOD_TOKEN), { ...context(), force: true }, seams, {
      retryDelayMs: 1,
      apiBase: stub.apiBase(API_HOST),
      now: () => stub.nowMs,
    }).sync();
    expect(forced.note).toContain('[full run;');
    expect(forced.note).toContain('1 removed');
    expect(await tree()).not.toContain(`issues/${r.a.number}.md`);
  });

  it('writes nothing again for an issue whose text did not change', async () => {
    repository();
    await run();
    stub.advance(60 * 25);
    const result = await run();
    expect(result.note).toContain('0 written, 3 unchanged');
  });
});

describe('the freshness check', () => {
  it('is one conditional request that GitHub answers 304, and costs the token nothing more than that', async () => {
    repository();
    await run();
    stub.reset();
    const token = await driverOf(stored, GOOD_TOKEN).probe();
    expect(token).toBe(stored[PROBE_TOKEN_KEY]);
    expect(stub.requests).toBe(1);
    expect(stub.log[0]).toMatchObject({ kind: 'newest', ifNoneMatch: stored.issuesEtag, authorization: `Bearer ${GOOD_TOKEN}` });
    expect(stub.log[0]?.query).toMatchObject({ state: 'all', sort: 'updated', direction: 'desc', per_page: '1' });
  });

  it('moves when an issue, or a comment on one, changes, and not otherwise', async () => {
    const r = repository();
    await run();
    stub.advance(5);
    expect(await driverOf(stored, GOOD_TOKEN).probe()).toBe(stored[PROBE_TOKEN_KEY]);
    stub.comment(r.b.number, 'New comment');
    const moved = await driverOf(stored, GOOD_TOKEN).probe();
    expect(moved).not.toBe(stored[PROBE_TOKEN_KEY]);
    expect(moved).toMatch(/^issues:W\//);
    // The run that follows stores the token the probe now answers.
    await run();
    expect(await driverOf(stored, GOOD_TOKEN).probe()).toBe(stored[PROBE_TOKEN_KEY]);
  });

  it('works for a source with no token, sending no credential at all', async () => {
    repository();
    await run({ token: null });
    expect(stub.log.every((q) => q.authorization === undefined)).toBe(true);
    stub.reset();
    expect(await driverOf(stored, null).probe()).toBe(stored[PROBE_TOKEN_KEY]);
    expect(stub.requests).toBe(1);
    expect(stub.log[0]?.authorization).toBeUndefined();
  });

  it('answers "run it" when it has no validator to compare', async () => {
    repository();
    const token = await driverOf(stored, GOOD_TOKEN).probe();
    expect(token).toMatch(/^issues:W\//);
    expect(stored[PROBE_TOKEN_KEY]).toBeUndefined();
  });

  it('is not skipped by a changed token: the next check runs the source', async () => {
    repository();
    await run();
    // `updateSource` forgets the server's keys and the probe token when the token is replaced.
    const forgotten = Object.fromEntries(
      Object.entries(stored).filter(([key]) => !(GITHUB_SERVER_KEYS as readonly string[]).includes(key) && key !== PROBE_TOKEN_KEY),
    );
    const token = await driverOf(forgotten, GOOD_TOKEN).probe();
    expect(token).not.toBeNull();
    expect(forgotten[PROBE_TOKEN_KEY]).toBeUndefined();
  });
});

describe('what a limit or a refusal does', () => {
  it('ends the run on a 403 that says the limit is spent, with the reset time in the message, and does not retry', async () => {
    repository();
    const reset = Math.floor(Date.parse('2026-10-01T10:00:00Z') / 1000);
    stub.scripted.push({
      status: 403,
      body: { message: 'API rate limit exceeded for user ID 1.' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    });
    const error = await run().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as Error).message).toContain('2026-10-01T10:00:00.000Z');
    expect(stub.requests).toBe(1);
    expect(stored[PROBE_TOKEN_KEY]).toBeUndefined();
    expect(stored.syncedSince).toBeUndefined();
  });

  it('knows a secondary limit (403 with retry-after) and a 429, anonymous or not', async () => {
    repository();
    stub.scripted.push({ status: 403, body: { message: 'You have exceeded a secondary rate limit.' }, headers: { 'retry-after': '60' } });
    await expect(run({ token: null })).rejects.toThrow(`rate limit reached; it resets at ${new Date(stub.nowMs + 60_000).toISOString()}`);
    stub.scripted.push({ status: 429, body: { message: 'slow down' } });
    await expect(run()).rejects.toThrow(GithubRateLimitError);
    // Anonymous callers are told a token raises the limit.
    stub.scripted.push({ status: 403, body: { message: 'API rate limit exceeded for 203.0.113.9.' }, headers: { 'x-ratelimit-remaining': '0' } });
    await expect(run({ token: null })).rejects.toThrow(/a token raises it/);
  });

  it('reports a GraphQL limit, which GitHub sends inside a 200', async () => {
    stub.discussion({ title: 'A question' });
    stored.includeDiscussions = true;
    stub.scripted.push({ status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } });
    // The first request is the REST freshness check; script it through, then the GraphQL freshness query fails.
    stub.scripted.unshift({ status: 200, body: [], headers: { etag: 'W/"x"' } });
    await expect(run()).rejects.toThrow(/GraphQL rate limit reached/);
  });

  it('is not a rate limit when a 403 is only a refusal, and says what to check', async () => {
    stub.scripted.push({ status: 403, body: { message: 'Resource not accessible by personal access token' } });
    const error = await run().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GithubRequestError);
    expect((error as Error).message).toContain('Resource not accessible');
    expect((error as Error).message).toContain('read access to issues');
  });

  it('retries a 5xx a few times, and then succeeds', async () => {
    repository();
    stub.scripted.push({ status: 502, body: { message: 'Bad Gateway' } }, { status: 503, body: { message: 'unavailable' } });
    const result = await run();
    expect(result.note).toContain('3 written');
    // The two refused attempts and the one that answered, all for the same freshness request.
    expect(stub.log.filter((q) => q.path.endsWith('/issues') && q.query.per_page === '1').length).toBe(3);
  });

  it('names a rejected token without quoting it, and a missing or private repository by what to do', async () => {
    const bad = await run({ token: 'fixture-wrong-token-not-a-real-credential' }).catch((err: unknown) => err);
    expect(bad).toBeInstanceOf(GithubRequestError);
    expect((bad as Error).message).toContain('rejected the token (HTTP 401)');
    expect((bad as Error).message).not.toContain('wrong-token');

    stub.publicRepo = false;
    const anonymous = await run({ token: null }).catch((err: unknown) => err);
    expect((anonymous as Error).message).toContain('private and needs a token');
    const wrongRepo = await new GithubDriver(row({ owner: OWNER, repo: 'nothing-here' }, GOOD_TOKEN), context(), seams, {
      retryDelayMs: 1,
      apiBase: stub.apiBase(API_HOST),
    })
      .test()
      .catch((err: unknown) => err);
    expect(wrongRepo).toBeInstanceOf(GithubRequestError);
  });

  it('never sends the token anywhere but the API host: a redirect off it is refused before a socket is opened', async () => {
    repository();
    stub.scripted.push({ status: 302, body: {}, headers: { location: `http://evil.fixture.test:${stub.port}/steal` } });
    await expect(run()).rejects.toThrow('the server redirected to `evil.fixture.test`');
    expect(stub.log.some((q) => q.host === 'evil.fixture.test')).toBe(false);
  });

  it('is refused for an Enterprise Server host on a private address until SOURCE_ALLOWED_HOSTS names it', async () => {
    repository();
    const privateSeams = { resolve: fakeResolver({ [API_HOST]: '10.1.2.3' }), route: routeToLoopback('10.1.2.3') };
    const refused = driverOf(stored, GOOD_TOKEN, {}, privateSeams).sync();
    await expect(refused).rejects.toThrow(`list \`${API_HOST}\` in SOURCE_ALLOWED_HOSTS`);
    expect(stub.requests).toBe(0);
    const allowed = await driverOf(stored, GOOD_TOKEN, { SOURCE_ALLOWED_HOSTS: [API_HOST] }, privateSeams).sync();
    expect(allowed.note).toContain('3 written');
  });
});

describe('the issue lookup', () => {
  const client = () =>
    new GithubClient({
      fetch: sourceEgress({
        allowedHosts: [],
        pinnedHosts: [API_HOST],
        label: 'GitHub',
        httpsOnly: false,
        methods: ['GET', 'POST'],
        ...seams,
      }),
      apiBase: stub.apiBase(API_HOST),
      owner: OWNER,
      repo: REPO,
      token: GOOD_TOKEN,
      retryDelayMs: 1,
    });

  it('reads the issue through a rename’s redirect, and still says nothing for a transferred one', async () => {
    const live = stub.issue({ title: 'Live' });
    const moved = stub.issue({ title: 'Moved' });
    stub.transfer(moved.number);
    stub.renamed = true;
    expect((await client().issue(live.number))?.title).toBe('Live');
    expect(await client().issue(moved.number)).toBeNull();
  });

  it('answers the issue, and nothing for a deleted one (410) or a transferred one (301 to its new home)', async () => {
    const live = stub.issue({ title: 'Live' });
    const gone = stub.issue({ title: 'Gone' });
    const moved = stub.issue({ title: 'Moved' });
    stub.delete(gone.number);
    stub.transfer(moved.number);
    expect((await client().issue(live.number))?.title).toBe('Live');
    expect(await client().issue(gone.number)).toBeNull();
    expect(await client().issue(moved.number)).toBeNull();
    expect(await client().issue(9999)).toBeNull();
  });
});

describe('Discussions', () => {
  const withDiscussions = () => {
    stored.includeDiscussions = true;
  };

  it('is refused without a token, by the driver and by the stub alike, naming the reason', async () => {
    withDiscussions();
    await expect(run({ token: null })).rejects.toThrow('needs a token');
    await expect(driverOf(stored, null).probe()).rejects.toThrow('needs a token');
    await expect(driverOf(stored, null).test()).rejects.toThrow('needs a token');
    expect(stub.requests).toBe(0);
  });

  it('writes each discussion as a document with its comments and replies, the answer marked', async () => {
    withDiscussions();
    const q = stub.discussion({ title: 'How do I rotate?', body: 'Asking.', labels: ['help'] });
    stub.discussionComment(q.number, 'Use the script.', ['Thanks!', 'Worked.'], { login: 'helper' }, true);
    stub.discussionComment(q.number, 'Or the API.');
    const bot = stub.discussion({ title: 'Release notes', author: { login: 'release[bot]', bot: true } });
    stub.issue({ title: 'An issue' });
    const result = await run();

    expect(await tree()).toEqual(
      [`discussions/${bot.number}.md`, `discussions/${q.number}.md`, `issues/${stub.issues.keys().next().value}.md`].sort(),
    );
    const text = await read(`discussions/${q.number}.md`);
    expect(text).toContain('category: "Q&A"');
    expect(text).toContain('labels: "help"');
    expect(text).toContain('## helper — 2026-10-01 — accepted answer\n\nUse the script.');
    expect(text.indexOf('Thanks!')).toBeLessThan(text.indexOf('Worked.'));
    expect(text.indexOf('Worked.')).toBeLessThan(text.indexOf('Or the API.'));
    expect(text).toContain('(reply)');
    expect(result.note).toContain('written');
    expect(stub.log.some((entry) => entry.kind === 'graphql' && entry.authorization === `Bearer ${GOOD_TOKEN}`)).toBe(true);
  });

  it('completes a long thread over the extra pages of comments and of replies', async () => {
    withDiscussions();
    stub.commentPageSize = 2;
    const q = stub.discussion({ title: 'Long thread' });
    for (let i = 1; i <= 5; i++) stub.discussionComment(q.number, `Comment number ${i}`, i === 1 ? ['r1', 'r2', 'r3', 'r4', 'r5'] : []);
    await run();
    const text = await read(`discussions/${q.number}.md`);
    for (let i = 1; i <= 5; i++) expect(text).toContain(`Comment number ${i}`);
    for (let i = 1; i <= 5; i++) expect(text).toContain(`r${i}`);
    // More than one query: the first page of comments, then the rest, then the replies.
    expect(stub.log.filter((entry) => entry.kind === 'graphql').length).toBeGreaterThan(3);
  });

  it('pages through discussions and stops at GITHUB_MAX_DISCUSSIONS', async () => {
    withDiscussions();
    stub.discussionPageSize = 2;
    for (let i = 1; i <= 5; i++) {
      stub.discussion({ title: `Thread ${i}` });
      stub.advance(1);
    }
    const all = await run();
    expect((await tree()).length).toBe(5);
    expect(all.note).not.toContain('CEILING');

    stored = { owner: OWNER, repo: REPO, includeDiscussions: true };
    const capped = await run({ extra: { GITHUB_MAX_DISCUSSIONS: 3 } });
    expect(capped.note).toContain('STOPPED AT THE 3-DISCUSSION CEILING (GITHUB_MAX_DISCUSSIONS)');
    expect((await tree()).length).toBe(3);
  });

  it('reads only what moved on an incremental run: newest update first, until the cursor is passed', async () => {
    withDiscussions();
    stub.discussionPageSize = 1;
    const first = stub.discussion({ title: 'First old thread' });
    stub.advance(60);
    const second = stub.discussion({ title: 'Second old thread' });
    stub.advance(60);
    await run();
    stub.advance(120);
    const recent = stub.discussion({ title: 'Recent thread' });
    stub.discussionComment(recent.number, 'A late reply');
    stub.reset();
    const result = await run();
    expect(result.note).toContain('[incremental run;');
    expect(await read(`discussions/${recent.number}.md`)).toContain('A late reply');
    expect(await tree()).toEqual([`discussions/${first.number}.md`, `discussions/${second.number}.md`, `discussions/${recent.number}.md`].sort());
    // The freshness query, the page with the recent thread, and the page whose thread is older than the cursor: the third page is never asked for.
    expect(stub.count('graphql')).toBe(3);
  });

  it('asks a full run for creation order and an incremental run for update order', async () => {
    withDiscussions();
    const q = stub.discussion({ title: 'Thread' });
    stub.advance(30);
    stub.reset();
    await run();
    const orders = (): string[] =>
      stub.log
        .filter((entry) => entry.kind === 'graphql' && /discussions\(first: 20,/.test(entry.queryText ?? ''))
        .map((entry) => /field: (\w+)/.exec(entry.queryText ?? '')?.[1] ?? '');
    expect(orders()).toEqual(['CREATED_AT']);
    stub.advance(60);
    stub.discussionComment(q.number, 'More');
    stub.reset();
    expect((await run()).note).toContain('[incremental run;');
    expect(orders()).toEqual(['UPDATED_AT']);
  });

  it('does not delete a discussion that is commented on while a full run reads the list', async () => {
    withDiscussions();
    stub.discussionPageSize = 1;
    const oldest = stub.discussion({ title: 'Oldest thread' });
    stub.advance(1);
    stub.discussion({ title: 'Middle thread' });
    stub.advance(1);
    stub.discussion({ title: 'Newest thread' });
    await run();
    expect((await tree()).length).toBe(3);
    stub.advance(5);
    // After the first page is served the oldest thread gets a comment: by update time it would jump to the front.
    stub.afterDiscussionPage = () => {
      stub.afterDiscussionPage = undefined;
      stub.discussionComment(oldest.number, 'A comment that arrives mid-run');
    };
    const forced = await new GithubDriver(row(stored, GOOD_TOKEN), { ...context(), force: true }, seams, {
      retryDelayMs: 1,
      apiBase: stub.apiBase(API_HOST),
      now: () => stub.nowMs,
    }).sync();
    expect(forced.note).toContain('[full run;');
    expect(forced.note).toContain('0 removed');
    expect(await tree()).toContain(`discussions/${oldest.number}.md`);
    expect((await tree()).length).toBe(3);
  });

  it('removes a deleted discussion on a full run, and a closed one is still a document', async () => {
    withDiscussions();
    const keep = stub.discussion({ title: 'Closed but kept', closed: true });
    const drop = stub.discussion({ title: 'To be deleted' });
    await run();
    expect(await read(`discussions/${keep.number}.md`)).toContain('state: "closed"');
    stub.deleteDiscussion(drop.number);
    stub.advance(60 * 25);
    const result = await run();
    expect(result.note).toContain('1 removed');
    expect(await tree()).toEqual([`discussions/${keep.number}.md`]);
  });

  it('leaves no discussion behind when they are switched off', async () => {
    withDiscussions();
    const q = stub.discussion({ title: 'Soon gone' });
    await run();
    expect(await tree()).toEqual([`discussions/${q.number}.md`]);
    stored.includeDiscussions = false;
    expect((await run()).note).toContain('1 removed');
    expect(await tree()).toEqual([]);
  });

  it('adds a discussion mark to the freshness token, which moves when a discussion does', async () => {
    withDiscussions();
    const q = stub.discussion({ title: 'Thread' });
    await run();
    expect(String(stored[PROBE_TOKEN_KEY])).toMatch(/\|discussions:\d+@2026-/);
    stub.reset();
    expect(await driverOf(stored, GOOD_TOKEN).probe()).toBe(stored[PROBE_TOKEN_KEY]);
    // One REST request (a 304) and one GraphQL query.
    expect(stub.log.map((entry) => entry.kind)).toEqual(['newest', 'graphql']);
    stub.advance(5);
    stub.editDiscussion(q.number, 'Edited.');
    expect(await driverOf(stored, GOOD_TOKEN).probe()).not.toBe(stored[PROBE_TOKEN_KEY]);
  });

  it('is reported by Test, with whether the repository has them switched on', async () => {
    withDiscussions();
    expect(await driverOf(stored, GOOD_TOKEN).test()).toBe('Connected to octo-org/handbook (public), with a token — Discussions are readable');
    stub.hasDiscussions = false;
    expect(await driverOf(stored, GOOD_TOKEN).test()).toContain('Discussions are switched off for this repository');
  });
});

describe('Test, and the links', () => {
  it('says what it connected to, and that it did so without a token', async () => {
    expect(await driverOf(stored, null).test()).toContain('Connected to octo-org/handbook (public), without a token');
    expect(await driverOf(stored, GOOD_TOKEN).test()).toBe('Connected to octo-org/handbook (public), with a token');
  });

  it('reads each document’s URL and update time from its front matter, never from the remote', async () => {
    const r = repository();
    await run();
    stub.reset();
    const root = sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID);
    const meta = await driverOf(stored, GOOD_TOKEN).documentMeta([
      { path: `issues/${r.a.number}.md`, absolutePath: path.join(root, 'issues', `${r.a.number}.md`), mtimeMs: 0 },
    ]);
    const entry = meta.get(`issues/${r.a.number}.md`);
    expect(entry?.url).toBe(`https://github.com/${OWNER}/${REPO}/issues/${r.a.number}`);
    expect(entry?.modifiedAt?.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(stub.requests).toBe(0);
  });
});
