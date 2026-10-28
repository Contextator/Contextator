/**
 * Smoke run of the `github` source against the real GitHub API (ADR-0128), on the operator's machine.
 *
 *   GITHUB_SMOKE_REPO=owner/repository npx tsx scripts/smoke-github.ts
 *
 * Use a public test repository you may edit. The run is read-only against GitHub; it asks you, between steps, to add a
 * comment to an issue, to close one and to delete one, because that is the only way to measure what a change costs.
 *
 * Optional environment, read here and nowhere else, never printed and never written to the repository:
 *
 * - `GITHUB_SMOKE_TOKEN` — a token. Without it the run is anonymous (public repository, Issues only, 60 requests an hour
 *   per address); with it the probe's `304` is free of the primary limit, which is the thing worth measuring.
 * - `GITHUB_SMOKE_DISCUSSIONS=1` — also read Discussions (needs the token and Discussions switched on in the repository).
 * - `GITHUB_SMOKE_API` — an Enterprise Server API base, such as `https://ghe.example.com/api/v3`.
 *
 * What it prints is counts, request counts and host names: **never** the token, an issue title or a comment. That is what
 * makes its output safe to paste into the phase report.
 *
 * It measures, in this order: Test, the first sync (documents, requests), the requests an idle probe costs, a new comment
 * (probe, then sync), a closed issue (probe, then sync — and whether it left the index), a deleted issue (probe, then an
 * incremental sync that is expected to keep it, then a full run that removes it) and the idle probe again.
 */
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { sourceEgress } from '../src/services/sources/confluence-egress.js';
import { GithubDriver } from '../src/services/sources/github.js';
import { GITHUB_API_DEFAULT, GithubClient } from '../src/services/sources/github-client.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000b2';

const target = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(process.env.GITHUB_SMOKE_REPO ?? '');
const token = process.env.GITHUB_SMOKE_TOKEN?.trim() || null;
const discussions = process.env.GITHUB_SMOKE_DISCUSSIONS === '1';
const apiBase = (process.env.GITHUB_SMOKE_API ?? '').trim().replace(/\/+$/, '') || GITHUB_API_DEFAULT;
if (!target) {
  console.error('Set GITHUB_SMOKE_REPO to owner/repository (a public test repository you may edit).');
  process.exit(2);
}
if (discussions && !token) {
  console.error(
    'GITHUB_SMOKE_DISCUSSIONS=1 needs GITHUB_SMOKE_TOKEN: GitHub serves Discussions through GraphQL, which answers no anonymous request.',
  );
  process.exit(2);
}
const [, owner, repo] = target as RegExpExecArray;

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const results: Array<[string, string | number]> = [];
/** What the indexer would have stored on the source row: the settings, and whatever a run's `configPatch` carried back. */
let stored: Record<string, unknown> = {};
const record = (label: string, value: string | number): void => {
  results.push([label, value]);
  console.log(`  ${label}: ${value}`);
};

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-smoke-github-'));
  const secretKey = randomBytes(32).toString('hex');
  stored = { owner, repo, apiBaseUrl: apiBase, includeDiscussions: discussions };

  const source = (): DocumentSourceRow =>
    ({
      id: SOURCE_ID,
      projectId: PROJECT_ID,
      type: 'github',
      name: 'smoke',
      label: '',
      config: stored,
      secretEnc: token === null ? null : encryptSecret(token, { current: secretKey }),
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
  const driver = (): GithubDriver =>
    new GithubDriver(source(), {
      db: null as never,
      log,
      config: { DATA_DIR: dataDir, SECRET_KEY: secretKey, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [], SYNC_MAX_SKIP_HOURS: 24 } as never,
    });
  const sync = async (label: string): Promise<void> => {
    const result = await driver().sync();
    stored = JSON.parse(JSON.stringify({ ...stored, ...result.configPatch })) as Record<string, unknown>;
    record(`${label}: note`, result.note ?? '');
    const files = await countFiles(dataDir);
    record(`${label}: documents on disk`, `${files.issues} issue(s), ${files.discussions} discussion(s)`);
  };

  try {
    console.log(
      `Repository ${owner}/${repo}${token ? ' with a token' : ' anonymously'}${discussions ? ', Discussions on' : ''}${apiBase === GITHUB_API_DEFAULT ? '' : ', Enterprise Server'}`,
    );

    console.log('1. Test');
    console.log(`  ${await driver().test()}`);

    console.log('2. First sync');
    await sync('first sync');

    console.log('3. Idle probe (nothing changed)');
    const idle = await probeCost();
    record('probe answer equals the stored token', String(idle.answer === stored.syncProbeToken));
    record('requests', idle.requests);
    record('answered 304', String(idle.notModified));

    await rl.question('4. Add a comment to an open issue in the repository, then press Enter... ');
    const commented = await probeCost();
    record('probe after a comment differs from the stored token', String(commented.answer !== stored.syncProbeToken));
    await sync('after a comment');

    await rl.question('5. Close one open issue (not a pull request), then press Enter... ');
    const closed = await probeCost();
    record('probe after closing differs from the stored token', String(closed.answer !== stored.syncProbeToken));
    await sync('after closing');

    await rl.question('6. Delete one issue (Settings of the issue -> Delete issue), then press Enter... ');
    const deleted = await probeCost();
    record(
      'probe after a deletion differs from the stored token (a deletion moves no list: expected false)',
      String(deleted.answer !== stored.syncProbeToken),
    );
    await sync('incremental run after the deletion (the document is expected to stay)');
    // The next run is a full one: its age is what the driver reads.
    stored = { ...stored, lastFullRunAt: new Date(Date.now() - 48 * 3_600_000).toISOString() };
    await sync('full run (the document is expected to go)');

    console.log('7. Idle probe again');
    const again = await probeCost();
    record('probe answer equals the stored token', String(again.answer === stored.syncProbeToken));
    record('requests', again.requests);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    rl.close();
  }
  console.log('\nSummary (paste into the phase report):');
  for (const [label, value] of results) console.log(`- ${label}: ${value}`);
}

/** The probe's requests, made by a client of its own over the same egress, counting what leaves the process. */
async function probeCost(): Promise<{ answer: string | null; requests: number; notModified: boolean }> {
  const egress = sourceEgress({
    allowedHosts: [],
    pinnedHosts: [new URL(apiBase).hostname],
    label: 'GitHub',
    subject: 'the API address',
    httpsOnly: true,
    methods: ['GET', 'POST'],
  });
  const client = new GithubClient({ fetch: egress, apiBase, owner, repo, token });
  const etag = typeof stored.issuesEtag === 'string' ? stored.issuesEtag : undefined;
  const newest = await client.newestIssue(etag);
  const part = newest.unchanged ? (etag ?? null) : newest.etag;
  let answer: string | null = null;
  if (part !== null) {
    answer = `issues:${part}`;
    if (discussions) answer += `|discussions:${await client.newestDiscussion()}`;
  }
  return { answer, requests: client.requests, notModified: newest.unchanged };
}

async function countFiles(root: string): Promise<{ issues: number; discussions: number }> {
  const base = path.join(root, 'projects', PROJECT_ID, 'sources', SOURCE_ID, 'current');
  const count = async (dir: string): Promise<number> =>
    (await fs.readdir(path.join(base, dir)).catch(() => [])).filter((name) => name.endsWith('.md')).length;
  return { issues: await count('issues'), discussions: await count('discussions') };
}

main().catch((err: unknown) => {
  // A message from this product or from GitHub; neither carries the token.
  console.error(`\nSmoke run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
