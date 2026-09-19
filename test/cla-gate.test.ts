import { describe, expect, it } from 'vitest';

import {
  StaleWriteError,
  type IssueComment,
  type ProductRepo,
  type PullRequestInfo,
  type SignatureStore,
  type StoredFile,
  type WorkflowRun,
} from '../scripts/cla/github.js';
import { COMMENT_MARKER, parseSignatureRecord, SIGNATURE_SENTENCE, type Account, type CommitRecord } from '../scripts/cla/rules.js';
import { DEFAULT_CONFIG, runGate, type GateConfig, type GateOutcome } from '../scripts/cla/run.js';

/**
 * The licence gate, driven end to end with no network anywhere
 * ([ADR-0061](../../.ssot/ADR.md#adr-0061)).
 *
 * `test/cla-rules.test.ts` asks whether each judgement is right; this file asks whether the gate
 * actually makes them — that a `closed` event still verifies, that a signature from a passer-by
 * records nothing, that two runs writing at once do not lose one of the signatures, and that a
 * contributor is asked once rather than on every push. Those are properties of the wiring, and the
 * wiring is where the Action this replaced went wrong.
 */

const LIVE_RECORD =
  '{"signedContributors":[{"name":"muhammetsafak","id":104234499,"comment_id":5743168568,"created_at":"2026-09-19T15:41:29Z","repoId":1374479673,"pullRequestNo":3}]}';

const SIGNATORY: Account = { login: 'muhammetsafak', id: 104234499, type: 'User' };
const STRANGER: Account = { login: 'stranger', id: 555, type: 'User' };

const REPOSITORY = { id: 1374479673, name: 'Contextator', owner: { login: 'Contextator' } };

const commitBy = (author: Account | null, sha = 'a'.repeat(40), email = 'someone@example.com'): CommitRecord => ({
  sha,
  author,
  commit: { author: { name: author?.login ?? 'Someone', email } },
});

class FakeStore implements SignatureStore {
  file: StoredFile | null;
  version = 0;
  /** Runs inside `writeFile`, before the SHA is checked: how a competing run is injected. */
  beforeWrite: (() => void) | null = null;

  constructor(content = LIVE_RECORD) {
    this.file = { content, sha: 'sha-0' };
  }

  async readFile(): Promise<StoredFile | null> {
    return this.file === null ? null : { ...this.file };
  }

  async writeFile({ content, sha }: { content: string; sha: string; message: string }): Promise<void> {
    this.beforeWrite?.();
    if (this.file === null) throw new Error('no file');
    if (this.file.sha !== sha) throw new StaleWriteError(`expected ${this.file.sha}, given ${sha}`);
    this.version += 1;
    this.file = { content, sha: `sha-${this.version}` };
  }

  record() {
    if (this.file === null) throw new Error('no file');
    return parseSignatureRecord(this.file.content);
  }
}

class FakeProductRepo implements ProductRepo {
  comments: IssueComment[] = [];
  created: string[] = [];
  updated: string[] = [];
  reruns: number[] = [];
  runs: WorkflowRun[] = [{ id: 77, status: 'completed' }];
  nextCommentId = 1000;

  constructor(
    private readonly pull: PullRequestInfo,
    private readonly commits: CommitRecord[],
  ) {}

  async getPullRequest(): Promise<PullRequestInfo> {
    return this.pull;
  }

  async listCommits(): Promise<CommitRecord[]> {
    return this.commits;
  }

  async listComments(): Promise<IssueComment[]> {
    return this.comments;
  }

  async createComment(_number: number, body: string): Promise<void> {
    this.nextCommentId += 1;
    this.comments.push({ id: this.nextCommentId, body, user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' } });
    this.created.push(body);
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    const existing = this.comments.find((entry) => entry.id === commentId);
    if (existing === undefined) throw new Error('no such comment');
    existing.body = body;
    this.updated.push(body);
  }

  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    return this.runs;
  }

  async rerunWorkflowRun(runId: number): Promise<void> {
    this.reruns.push(runId);
  }
}

const openPull: PullRequestInfo = { number: 12, state: 'open', headSha: 'f'.repeat(40), commits: 1 };
const mergedPull: PullRequestInfo = { number: 12, state: 'closed', headSha: 'f'.repeat(40), commits: 1 };

function gate(
  product: FakeProductRepo,
  store: FakeStore,
  event: unknown,
  eventName: 'pull_request_target' | 'issue_comment',
  config: Partial<GateConfig> = {},
): Promise<GateOutcome> {
  return runGate({
    eventName,
    event,
    product,
    store,
    config: { ...DEFAULT_CONFIG, ...config },
    log: () => {},
    // No real waiting: every retry path in the gate is exercised here, and none of them may make the
    // suite depend on a timer.
    sleep: async () => {},
  });
}

const pullEvent = { repository: REPOSITORY, pull_request: { number: 12 } };

const commentEvent = (user: Account, body: string) => ({
  repository: REPOSITORY,
  issue: { number: 12, pull_request: { url: 'https://api.github.com/repos/Contextator/Contextator/pulls/12' } },
  comment: { id: 900, body, created_at: '2026-09-20T09:00:00Z', user },
});

describe('a pull request whose authors have all signed', () => {
  it('passes and says nothing at all', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(SIGNATORY)]);
    const store = new FakeStore();

    const outcome = await gate(product, store, pullEvent, 'pull_request_target');

    expect(outcome.passed).toBe(true);
    // `CONTRIBUTING.md` step 1: an already-signed pull request gets no comment and nothing to read.
    expect(product.created).toEqual([]);
    expect(product.updated).toEqual([]);
  });
});

describe('a pull request nobody has signed for', () => {
  it('fails, and asks once', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const outcome = await gate(product, new FakeStore(), pullEvent, 'pull_request_target');

    expect(outcome.passed).toBe(false);
    expect(product.created).toHaveLength(1);
    expect(product.created[0]).toContain('@stranger');
    expect(product.created[0]).toContain(SIGNATURE_SENTENCE);
  });

  it('does not ask again on the next push', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();

    await gate(product, store, pullEvent, 'pull_request_target');
    await gate(product, store, pullEvent, 'pull_request_target');
    await gate(product, store, pullEvent, 'pull_request_target');

    expect(product.created).toHaveLength(1);
    expect(product.updated).toEqual([]);
    expect(product.comments.filter((entry) => entry.body.includes(COMMENT_MARKER))).toHaveLength(1);
  });

  it('edits the one comment when a new author appears rather than posting a second', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();
    await gate(product, store, pullEvent, 'pull_request_target');

    const withColleague = new FakeProductRepo(openPull, [
      commitBy(STRANGER),
      commitBy({ login: 'colleague', id: 556, type: 'User' }, 'b'.repeat(40)),
    ]);
    withColleague.comments = product.comments;
    await gate(withColleague, store, pullEvent, 'pull_request_target');

    expect(withColleague.created).toEqual([]);
    expect(withColleague.updated).toHaveLength(1);
    expect(withColleague.updated[0]).toContain('@colleague');
  });
});

describe('a commit whose author belongs to no GitHub account', () => {
  it('fails the gate, and no comment can sign for it', async () => {
    // The bypass this gate was rebuilt to close: `git commit --author="muhammetsafak
    // <unlinked@example.invalid>"` puts a name that is already in the signature record into free text
    // inside the commit. The Action this replaced read that text as an identity.
    const forged = commitBy(null, 'c'.repeat(40), 'unlinked@example.invalid');
    forged.commit.author.name = 'muhammetsafak';
    const product = new FakeProductRepo(openPull, [forged]);

    const outcome = await gate(product, new FakeStore(), pullEvent, 'pull_request_target');

    expect(outcome.passed).toBe(false);
    expect(product.created[0]).toContain('not linked to any GitHub account');
  });

  it('is still unsigned after the account whose name the commit carries signs', async () => {
    const forged = commitBy(null, 'c'.repeat(40), 'unlinked@example.invalid');
    forged.commit.author.name = 'muhammetsafak';
    const product = new FakeProductRepo(openPull, [forged, commitBy(SIGNATORY, 'd'.repeat(40))]);
    const store = new FakeStore();

    const outcome = await gate(product, store, commentEvent(SIGNATORY, SIGNATURE_SENTENCE), 'issue_comment');

    expect(outcome.passed).toBe(false);
    expect(outcome.lines.join(' ')).toContain('not linked to a GitHub account');
  });
});

describe('a signature comment', () => {
  it('is recorded against the account that left it, and turns the check green', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();

    const outcome = await gate(product, store, commentEvent(STRANGER, SIGNATURE_SENTENCE), 'issue_comment');

    expect(outcome.passed).toBe(true);
    expect(outcome.recorded).toBe(true);
    const record = store.record();
    expect(record.signedContributors).toHaveLength(2);
    expect(record.signedContributors[1]).toEqual({
      name: 'stranger',
      id: 555,
      comment_id: 900,
      created_at: '2026-09-20T09:00:00Z',
      repoId: 1374479673,
      pullRequestNo: 12,
    });
    // And the pull request's own run is asked to conclude again, because this run's check is attached
    // to the wrong commit.
    expect(product.reruns).toEqual([77]);
  });

  it('records nothing when the account that left it authored none of the commits', async () => {
    // `CLA.md` §3: nobody signs on somebody else's behalf.
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();

    const outcome = await gate(product, store, commentEvent({ login: 'passer-by', id: 777, type: 'User' }, SIGNATURE_SENTENCE), 'issue_comment');

    expect(outcome.passed).toBe(false);
    expect(outcome.recorded).toBe(false);
    expect(store.record().signedContributors).toHaveLength(1);
    expect(product.reruns).toEqual([]);
  });

  it('is not read out of a longer comment', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();

    const outcome = await gate(product, store, commentEvent(STRANGER, `> ${SIGNATURE_SENTENCE}\n\nis that all I do?`), 'issue_comment');

    expect(outcome.passed).toBe(false);
    expect(store.record().signedContributors).toHaveLength(1);
  });

  it('writes nothing twice when the same account signs again', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(SIGNATORY)]);
    const store = new FakeStore();

    const outcome = await gate(product, store, commentEvent(SIGNATORY, SIGNATURE_SENTENCE), 'issue_comment');

    expect(outcome.passed).toBe(true);
    expect(outcome.recorded).toBe(false);
    expect(store.record().signedContributors).toHaveLength(1);
  });
});

describe('two signatures arriving at once', () => {
  it('keeps both', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();

    // A competing run lands its signature in the window between this run's read and its write. The
    // blob SHA moves with it, so the prepared write is refused — and the only correct answer is to
    // read the file again and append to what is actually there. Retrying the prepared content against
    // a fresh SHA would write back a record missing the other signature, and no check would ever go
    // red over a licence grant silently deleted.
    store.beforeWrite = () => {
      store.beforeWrite = null;
      store.file = {
        content: JSON.stringify({
          signedContributors: [
            ...store.record().signedContributors,
            { name: 'colleague', id: 556, comment_id: 901, created_at: '2026-09-20T09:00:01Z', repoId: 1374479673, pullRequestNo: 12 },
          ],
        }),
        sha: 'sha-other',
      };
    };

    const outcome = await gate(product, store, commentEvent(STRANGER, SIGNATURE_SENTENCE), 'issue_comment');

    expect(outcome.passed).toBe(true);
    expect(store.record().signedContributors.map((entry) => entry.id)).toEqual([104234499, 556, 555]);
  });

  it('fails the check rather than dropping a signature when the retries run out', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();
    // Somebody writes first, every single time.
    store.beforeWrite = () => {
      store.file = { content: store.file?.content ?? LIVE_RECORD, sha: `sha-moved-${Math.random()}` };
    };

    await expect(gate(product, store, commentEvent(STRANGER, SIGNATURE_SENTENCE), 'issue_comment', { writeAttempts: 3 })).rejects.toThrow(
      StaleWriteError,
    );
  });
});

describe('a closed pull request', () => {
  it('is still judged, so the check by this name never concludes without checking', async () => {
    // The Action this replaced, given a `closed` event with locking on, locked the thread and returned
    // successfully without verifying anything. Under the job name branch protection requires, that is
    // a green required check over an unsigned merge.
    const product = new FakeProductRepo(mergedPull, [commitBy(STRANGER)]);

    const outcome = await gate(product, new FakeStore(), pullEvent, 'pull_request_target');

    expect(outcome.passed).toBe(false);
    expect(outcome.lines.join(' ')).toContain('@stranger has not signed');
  });

  it('is not commented on', async () => {
    const product = new FakeProductRepo(mergedPull, [commitBy(STRANGER)]);
    await gate(product, new FakeStore(), pullEvent, 'pull_request_target');
    expect(product.created).toEqual([]);
  });
});

describe('bots', () => {
  it('are exempt when GitHub says they are bots', async () => {
    const product = new FakeProductRepo(openPull, [commitBy({ login: 'dependabot[bot]', id: 49699333, type: 'Bot' })]);
    expect((await gate(product, new FakeStore(), pullEvent, 'pull_request_target')).passed).toBe(true);
  });

  it('are not exempt because of what they are called', async () => {
    const product = new FakeProductRepo(openPull, [commitBy({ login: 'dependabot[bot]', id: 700, type: 'User' })]);
    const outcome = await gate(product, new FakeStore(), pullEvent, 'pull_request_target');
    expect(outcome.passed).toBe(false);
    expect(outcome.lines.join(' ')).toContain('@dependabot[bot] has not signed');
  });
});

describe('recovery and refusal', () => {
  it('re-runs the pull request when somebody comments recheck', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(SIGNATORY)]);
    const outcome = await gate(product, new FakeStore(), commentEvent(STRANGER, 'recheck'), 'issue_comment');
    expect(outcome.passed).toBe(true);
    expect(product.reruns).toEqual([77]);
  });

  it('waits for a run that is still going rather than giving up on the first refusal', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(SIGNATORY)]);
    product.runs = [{ id: 77, status: 'in_progress' }];
    const outcome = await gate(product, new FakeStore(), commentEvent(STRANGER, 'recheck'), 'issue_comment', { rerunAttempts: 2 });
    // It never became re-runnable, so nothing was re-run — and the check still concluded honestly.
    expect(product.reruns).toEqual([]);
    expect(outcome.passed).toBe(true);
  });

  it('refuses outright when the record is not there', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(SIGNATORY)]);
    const store = new FakeStore();
    store.file = null;
    // An absent record is not "nobody has signed yet": it is a gate that cannot see its own evidence.
    await expect(gate(product, store, pullEvent, 'pull_request_target')).rejects.toThrow(/missing/);
  });

  it('ignores a comment on an ordinary issue', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const event = {
      repository: REPOSITORY,
      issue: { number: 12 },
      comment: { id: 900, body: 'hello', created_at: '2026-09-20T09:00:00Z', user: STRANGER },
    };
    const outcome = await gate(product, new FakeStore(), event, 'issue_comment');
    expect(outcome.passed).toBe(true);
    expect(product.created).toEqual([]);
  });

  it('judges an ordinary pull request comment for real, saying nothing and writing nothing', async () => {
    const product = new FakeProductRepo(openPull, [commitBy(STRANGER)]);
    const store = new FakeStore();
    const outcome = await gate(product, store, commentEvent(STRANGER, 'LGTM'), 'issue_comment');
    expect(outcome.passed).toBe(false);
    expect(store.record().signedContributors).toHaveLength(1);
    expect(product.reruns).toEqual([]);
  });
});
