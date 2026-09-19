import { z } from 'zod';

import { GitHubError, StaleWriteError, type ProductRepo, type SignatureStore } from './github.js';
import {
  appendSignature,
  collectAuthors,
  COMMENT_MARKER,
  hasSigned,
  judge,
  maySignFor,
  parseSignatureRecord,
  readCommentIntent,
  renderComment,
  serialiseSignatureRecord,
  type Account,
  type Signature,
  type SignatureRecord,
  type Verdict,
} from './rules.js';

/**
 * The licence gate, wired up: it fetches, writes, re-runs and reports, and decides nothing itself
 * ([ADR-0061](../../../.ssot/ADR.md#adr-0061)). Every judgement it makes is a call into `rules.ts`.
 *
 * `runGate` takes its two GitHub clients as arguments and returns a verdict rather than exiting, which
 * is the whole reason this file is separable from the one below it: `test/cla-gate.test.ts` runs the
 * complete flow — comment arrives, record is read, signature is appended, check concludes — against
 * fakes, with no network anywhere in the suite.
 *
 * Read `.github/workflows/cla.yml` beside this. The workflow contributes no logic: it decides when a
 * runner starts and hands this script two tokens and the event payload on disk, and nothing a fork
 * controls reaches a shell or a `${{ }}` expression on the way.
 */

const AccountSchema = z.object({ login: z.string(), id: z.number().int(), type: z.string() });

const RepositorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

const PullRequestEventSchema = z.object({
  repository: RepositorySchema,
  pull_request: z.object({ number: z.number().int() }),
});

const IssueCommentEventSchema = z.object({
  repository: RepositorySchema,
  issue: z.object({
    number: z.number().int(),
    /** Present only when the issue is a pull request. Absent on an ordinary issue. */
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int(),
    body: z.string(),
    created_at: z.string(),
    user: AccountSchema,
  }),
});

export type GateConfig = {
  /** Absolute; the comment it goes into is read on github.com. */
  documentUrl: string;
  /** The file name of this workflow, used to find the run whose check has to be re-evaluated. */
  workflowFile: string;
  /** How many times a signature write may be redone after losing a race. See `recordSignature`. */
  writeAttempts: number;
  /** How many times the re-run is attempted while the pull request's own run is still going. */
  rerunAttempts: number;
};

export const DEFAULT_CONFIG: GateConfig = {
  documentUrl: 'https://github.com/Contextator/Contextator/blob/main/CLA.md',
  workflowFile: 'cla.yml',
  writeAttempts: 5,
  rerunAttempts: 6,
};

export type GateDeps = {
  eventName: string;
  event: unknown;
  product: ProductRepo;
  store: SignatureStore;
  config: GateConfig;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

export type GateOutcome = {
  /** What the **Licence grant** check concludes. False is a red check and a refused merge. */
  passed: boolean;
  /** Why, in the words the run summary shows. */
  lines: string[];
  /** True when this run recorded a new row in the signature file. */
  recorded: boolean;
};

/**
 * A comment on a plain issue, which is not a pull request and has no check to report against.
 *
 * This is the one path that returns `passed: true` without judging anything, and it is safe because no
 * pull request is involved at all: there is no head commit, no required check and nothing to merge.
 * Every other path — including a `closed` event, including a comment that says nothing — goes all the
 * way through `judge`. A run that carries the name **Licence grant** and concludes green has verified.
 */
const NOT_A_PULL_REQUEST: GateOutcome = {
  passed: true,
  lines: ['This comment is not on a pull request; there is nothing to check.'],
  recorded: false,
};

export async function runGate(deps: GateDeps): Promise<GateOutcome> {
  const { eventName, event, product, store, config, log } = deps;

  let pullNumber: number;
  let repositoryId: number;
  let owner: string;
  let repo: string;
  let comment: { id: number; body: string; created_at: string; user: Account } | null = null;

  if (eventName === 'pull_request_target') {
    const parsed = PullRequestEventSchema.parse(event);
    pullNumber = parsed.pull_request.number;
    repositoryId = parsed.repository.id;
    owner = parsed.repository.owner.login;
    repo = parsed.repository.name;
  } else if (eventName === 'issue_comment') {
    const parsed = IssueCommentEventSchema.parse(event);
    if (parsed.issue.pull_request === undefined) return NOT_A_PULL_REQUEST;
    pullNumber = parsed.issue.number;
    repositoryId = parsed.repository.id;
    owner = parsed.repository.owner.login;
    repo = parsed.repository.name;
    comment = parsed.comment;
  } else {
    throw new Error(`the licence gate does not run on ${eventName}`);
  }

  const pull = await product.getPullRequest(pullNumber);
  const commits = await product.listCommits(pullNumber);
  const authors = collectAuthors(commits);
  log(`#${pullNumber}: ${commits.length} commit(s), ${authors.accounts.length} account(s), ${authors.unlinked.length} unlinked commit(s).`);

  let record = await readRecord(store);
  let recorded = false;

  // The signature, if one arrived. Recorded before the judgement below so that the comment that signs
  // is also the run that turns the check green, rather than needing a second `recheck`.
  if (comment !== null && readCommentIntent(comment.body) === 'signature') {
    if (!maySignFor(comment.user, authors)) {
      // No comment is posted in answer. The one already on the thread names who has to sign, and
      // saying "you are not one of them" to whoever wandered past is noise on somebody else's pull
      // request. The refusal is in the log, where the maintainer looking at a red check will find it.
      log(`@${comment.user.login} signed but authored none of the commits here; nothing recorded — nobody signs on somebody else's behalf.`);
    } else if (hasSigned(record, comment.user.id)) {
      log(`@${comment.user.login} has already signed; the record is unchanged.`);
    } else {
      record = await recordSignature(
        deps,
        {
          name: comment.user.login,
          id: comment.user.id,
          comment_id: comment.id,
          created_at: comment.created_at,
          repoId: repositoryId,
          pullRequestNo: pullNumber,
        },
        `${comment.user.login} signed the CLA in ${owner}/${repo}`,
      );
      recorded = true;
      log(`@${comment.user.login} signed; recorded in ${owner}/${repo}.`);
    }
  }

  const verdict = judge(authors, record);

  // Only while the pull request is open. A closed one is still judged — the check has to mean
  // something on a `closed` event — but nobody is asked to act on a thread that is finished.
  if (!verdict.passed && pull.state === 'open') {
    await ensureComment(product, pullNumber, renderComment({ verdict, documentUrl: config.documentUrl }), log);
  }

  // Re-running is what turns the check on the *pull request's* head commit green. This run's own check
  // is attached to whatever commit the comment event carried, which is not the one branch protection
  // is looking at.
  if (comment !== null) {
    const intent = readCommentIntent(comment.body);
    if (recorded || intent === 'recheck') {
      await rerun(deps, pull.headSha);
    }
  }

  return { passed: verdict.passed, lines: summarise(verdict), recorded };
}

async function readRecord(store: SignatureStore): Promise<SignatureRecord> {
  const file = await store.readFile();
  if (file === null) {
    // Fail closed, loudly. An absent record is not "nobody has signed yet": it is a gate that cannot
    // see its own evidence, and answering "everybody has signed" over a file that is not there is the
    // one failure this mechanism must never have.
    throw new Error('the signature record is missing; the gate cannot judge anything without it');
  }
  return parseSignatureRecord(file.content);
}

/**
 * Append one signature to the record, redoing the whole append if somebody else got there first.
 *
 * Two contributors signing within the same few seconds are two runs that both read the same file and
 * both write it back. Whichever writes second is writing against a blob SHA that is no longer there;
 * the contents API refuses it, and this catches that refusal, **re-reads the file** and appends to what
 * is actually in it. Re-reading is the whole of the fix — retrying the same prepared content against a
 * fresh SHA would write back a record missing the other signature, which is a licence grant silently
 * deleted, and no check would ever go red over it.
 *
 * When the attempts run out the error escapes and the check goes red. That is the right direction: a
 * signature that could not be recorded has not been recorded, and the contributor's `recheck` is a
 * documented way back.
 */
async function recordSignature(deps: GateDeps, signature: Signature, message: string): Promise<SignatureRecord> {
  const { store, config, log, sleep } = deps;

  for (let attempt = 1; attempt <= config.writeAttempts; attempt += 1) {
    const file = await store.readFile();
    if (file === null) throw new Error('the signature record is missing; refusing to create it here');
    const current = parseSignatureRecord(file.content);
    if (hasSigned(current, signature.id)) return current;

    const next = appendSignature(current, signature);
    try {
      await store.writeFile({
        content: serialiseSignatureRecord(next),
        sha: file.sha,
        message,
      });
      return next;
    } catch (err) {
      if (!(err instanceof StaleWriteError) || attempt === config.writeAttempts) throw err;
      log(`the signature record moved under attempt ${attempt}; re-reading it and appending again.`);
      await sleep(attempt * 500);
    }
  }

  throw new Error('the signature record could not be written');
}

/**
 * One comment per pull request, edited afterwards rather than repeated.
 *
 * `CONTRIBUTING.md` step 1 promises a signed pull request gets nothing at all, and step 2 promises one
 * comment naming who has not signed. A run that posts again on every push turns that promise into a
 * thread nobody reads. The marker is an invisible HTML comment rather than a match on the author,
 * so this only ever edits its own.
 */
async function ensureComment(product: ProductRepo, pullNumber: number, body: string, log: (line: string) => void): Promise<void> {
  const existing = (await product.listComments(pullNumber)).find((entry) => entry.body.includes(COMMENT_MARKER));
  if (existing === undefined) {
    await product.createComment(pullNumber, body);
    log(`asked for a signature on #${pullNumber}.`);
    return;
  }
  if (existing.body.trim() === body.trim()) {
    log(`the request for a signature on #${pullNumber} is already there and already says this.`);
    return;
  }
  await product.updateComment(existing.id, body);
  log(`updated the request for a signature on #${pullNumber}.`);
}

/**
 * Re-run the pull request's own `pull_request_target` run, so the check attached to its head commit is
 * evaluated again against the record this run just changed.
 *
 * The filter is `event=pull_request_target`, which is also what keeps this from re-running the comment
 * run it is executing inside. A run that is still going cannot be re-run, so this waits for it; when it
 * never becomes re-runnable the gate says so and stops — the signature is recorded either way, and
 * `recheck` is the documented way to ask again.
 */
async function rerun(deps: GateDeps, headSha: string): Promise<void> {
  const { product, config, log, sleep } = deps;

  for (let attempt = 1; attempt <= config.rerunAttempts; attempt += 1) {
    const runs = await product.listWorkflowRuns(config.workflowFile, headSha);
    const run = runs[0];
    if (run === undefined) {
      log(`no ${config.workflowFile} run against ${headSha.slice(0, 7)} to re-run.`);
      return;
    }
    if (run.status === 'completed') {
      try {
        await product.rerunWorkflowRun(run.id);
        log(`re-ran ${config.workflowFile} #${run.id} against ${headSha.slice(0, 7)}.`);
        return;
      } catch (err) {
        if (!(err instanceof GitHubError) || attempt === config.rerunAttempts) throw err;
        log(`re-run of #${run.id} was refused (${err.status}); waiting and asking again.`);
      }
    }
    if (attempt === config.rerunAttempts) {
      log(`the run against ${headSha.slice(0, 7)} never became re-runnable; comment \`recheck\` once it has finished.`);
      return;
    }
    await sleep(5_000);
  }
}

function summarise(verdict: Verdict): string[] {
  if (verdict.passed) return ['Every commit author has granted a licence.'];
  const lines: string[] = [];
  for (const account of verdict.mustSign) lines.push(`@${account.login} has not signed.`);
  for (const commit of verdict.unlinked) {
    lines.push(`${commit.sha.slice(0, 7)} was authored by ${commit.email}, which is not linked to a GitHub account, so no account can sign for it.`);
  }
  return lines;
}
