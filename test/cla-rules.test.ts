import { describe, expect, it } from 'vitest';

import {
  appendSignature,
  collectAuthors,
  COMMENT_MARKER,
  hasSigned,
  isBot,
  judge,
  maySignFor,
  parseSignatureRecord,
  readCommentIntent,
  renderComment,
  serialiseSignatureRecord,
  SignatureRecordError,
  SIGNATURE_SENTENCE,
  type Account,
  type CommitRecord,
} from '../scripts/cla/rules.js';

/**
 * The judgements the licence gate makes, asked the questions a contributor never will
 * ([ADR-0061](../../.ssot/ADR.md#adr-0061)).
 *
 * The gate defends something that cannot be recovered once it is lost, and the cases that matter are
 * the ones nobody opens a pull request for: a commit whose author e-mail belongs to no account, an
 * account signing for somebody else, a human login shaped like a bot's. None of them can be discovered
 * by running the thing on GitHub and looking at the result, which is why the decisions are functions
 * over plain data and why this file exists.
 */

const account = (over: Partial<Account> = {}): Account => ({ login: 'octo', id: 1, type: 'User', ...over });

const commit = (over: Partial<CommitRecord> = {}): CommitRecord => ({
  sha: 'a'.repeat(40),
  author: account(),
  commit: { author: { name: 'Octo Cat', email: 'octo@example.com' } },
  ...over,
});

/**
 * The record as it actually stands in `Contextator/cla-signatures` — one real signature, copied byte
 * for byte. Every assertion about the existing record is made against this and not against a
 * hand-built approximation, because "the new gate still honours the signature that is already there"
 * is not a claim that can be made about a fixture somebody wrote to suit the code.
 */
const LIVE_RECORD =
  '{"signedContributors":[{"name":"muhammetsafak","id":104234499,"comment_id":5743168568,"created_at":"2026-09-19T15:41:29Z","repoId":1374479673,"pullRequestNo":3}]}';

describe('the signature record already in the repository', () => {
  it('parses, and the signature in it counts', () => {
    const record = parseSignatureRecord(LIVE_RECORD);
    expect(record.signedContributors).toHaveLength(1);
    expect(hasSigned(record, 104234499)).toBe(true);
  });

  it('survives a parse and a write with every field of every row intact', () => {
    const record = parseSignatureRecord(LIVE_RECORD);
    const written = serialiseSignatureRecord(record);
    // The bytes change — it is written to be read in a diff — but the record does not.
    expect(JSON.parse(written)).toEqual(JSON.parse(LIVE_RECORD));
    expect(parseSignatureRecord(written).signedContributors[0]).toEqual({
      name: 'muhammetsafak',
      id: 104234499,
      comment_id: 5743168568,
      created_at: '2026-09-19T15:41:29Z',
      repoId: 1374479673,
      pullRequestNo: 3,
    });
  });

  it('lets the account that signed through, and nobody else', () => {
    const record = parseSignatureRecord(LIVE_RECORD);
    const authors = collectAuthors([commit({ author: account({ login: 'muhammetsafak', id: 104234499 }) })]);
    expect(judge(authors, record).passed).toBe(true);

    // The same login, a different account. A login is released when an account is deleted and can be
    // claimed by somebody else; the id cannot, which is why the id is what is matched.
    const impostor = collectAuthors([commit({ author: account({ login: 'muhammetsafak', id: 999 }) })]);
    expect(judge(impostor, record).passed).toBe(false);
  });

  it('refuses a record it cannot read rather than reporting that everybody signed', () => {
    expect(() => parseSignatureRecord('{"signedContributors":[{"name":"x"')).toThrow(SignatureRecordError);
    expect(() => parseSignatureRecord('{"signedContributors":[{"name":"x"}]}')).toThrow(SignatureRecordError);
    expect(() => parseSignatureRecord('{}')).toThrow(SignatureRecordError);
  });
});

describe('what counts as a signature comment', () => {
  it('reads the sentence, in any case and with a full stop', () => {
    expect(readCommentIntent(SIGNATURE_SENTENCE)).toBe('signature');
    expect(readCommentIntent('  i have read the cla document and i hereby sign the cla.  ')).toBe('signature');
    expect(readCommentIntent('I HAVE READ THE CLA DOCUMENT AND I HEREBY SIGN THE CLA')).toBe('signature');
    expect(readCommentIntent('I  have   read the CLA Document and I hereby sign the CLA')).toBe('signature');
  });

  it('does not read a sentence buried in a longer comment', () => {
    // `CONTRIBUTING.md` step 3 promises exactly this, and the reason is not fussiness: a quoted reply
    // would otherwise sign on behalf of whoever is being quoted.
    expect(readCommentIntent(`Sure thing!\n\n${SIGNATURE_SENTENCE}`)).toBe('none');
    expect(readCommentIntent(`> ${SIGNATURE_SENTENCE}\n\nDid that work?`)).toBe('none');
  });

  it('reads the recovery word', () => {
    expect(readCommentIntent('recheck')).toBe('recheck');
    expect(readCommentIntent('  Recheck\n')).toBe('recheck');
    expect(readCommentIntent('recheck please')).toBe('none');
  });

  it('reads an ordinary comment as nothing at all', () => {
    expect(readCommentIntent('LGTM')).toBe('none');
    expect(readCommentIntent('')).toBe('none');
  });
});

describe('who authored a pull request', () => {
  it('is the GitHub account, and never the name inside the commit', () => {
    // `git commit --author="muhammetsafak <unlinked@example.invalid>"` is free text an outsider picks.
    // The Action this replaced resolved a committer as `login || name` and compared that string against
    // the signature file, so the line below was the whole of the bypass.
    const forged = commit({
      author: null,
      commit: { author: { name: 'muhammetsafak', email: 'unlinked@example.invalid' } },
    });
    const authors = collectAuthors([forged]);
    expect(authors.accounts).toEqual([]);
    expect(authors.unlinked).toEqual([{ sha: 'a'.repeat(40), email: 'unlinked@example.invalid' }]);

    // And it fails the gate against the record that already carries that very name.
    const verdict = judge(authors, parseSignatureRecord(LIVE_RECORD));
    expect(verdict.passed).toBe(false);
    expect(verdict.unlinked).toHaveLength(1);
  });

  it('counts each account once, in the order they first appear', () => {
    const authors = collectAuthors([
      commit({ sha: '1'.repeat(40), author: account({ login: 'one', id: 1 }) }),
      commit({ sha: '2'.repeat(40), author: account({ login: 'two', id: 2 }) }),
      commit({ sha: '3'.repeat(40), author: account({ login: 'one', id: 1 }) }),
    ]);
    expect(authors.accounts.map((entry) => entry.login)).toEqual(['one', 'two']);
  });
});

describe('who is exempt', () => {
  it('is whoever GitHub says is a Bot, and nobody else', () => {
    expect(isBot(account({ login: 'dependabot[bot]', id: 49699333, type: 'Bot' }))).toBe(true);
    expect(isBot(account({ login: 'github-actions[bot]', id: 41898282, type: 'Bot' }))).toBe(true);
    expect(isBot(account({ login: 'renovate[bot]', id: 29139614, type: 'Bot' }))).toBe(true);
  });

  it('is not decided by what an account is called', () => {
    // A name-matched allowlist is the defect this gate was rebuilt to close, and it is not reopened by
    // a name-matched bot check. `[bot]` in a login is a string GitHub will issue to a human account.
    expect(isBot(account({ login: 'dependabot[bot]', id: 700, type: 'User' }))).toBe(false);
    expect(isBot(account({ login: 'github-actions[bot]', id: 701, type: 'User' }))).toBe(false);
    expect(isBot(account({ login: 'not-a-bot-bot', id: 702, type: 'User' }))).toBe(false);

    const authors = collectAuthors([commit({ author: account({ login: 'dependabot[bot]', id: 700, type: 'User' }) })]);
    const verdict = judge(authors, parseSignatureRecord(LIVE_RECORD));
    expect(verdict.passed).toBe(false);
    expect(verdict.mustSign.map((entry) => entry.login)).toEqual(['dependabot[bot]']);
  });

  it('lets a real bot through without a signature', () => {
    const authors = collectAuthors([commit({ author: account({ login: 'dependabot[bot]', id: 49699333, type: 'Bot' }) })]);
    expect(judge(authors, parseSignatureRecord(LIVE_RECORD)).passed).toBe(true);
  });
});

describe('who may sign', () => {
  const authors = collectAuthors([commit({ author: account({ login: 'author', id: 5 }) })]);

  it('is an account that authored a commit in this pull request', () => {
    expect(maySignFor(account({ login: 'author', id: 5 }), authors)).toBe(true);
  });

  it('is not a passer-by signing on the author’s behalf', () => {
    // `CLA.md` §3: nobody signs for anybody else. Without this, anybody who can comment on a pull
    // request could grant a licence over code they have no rights to.
    expect(maySignFor(account({ login: 'bystander', id: 6 }), authors)).toBe(false);
    // Same login, different account — the id is what is compared.
    expect(maySignFor(account({ login: 'author', id: 7 }), authors)).toBe(false);
  });

  it('is not a bot', () => {
    const botAuthors = collectAuthors([commit({ author: account({ login: 'bot[bot]', id: 8, type: 'Bot' }) })]);
    expect(maySignFor(account({ login: 'bot[bot]', id: 8, type: 'Bot' }), botAuthors)).toBe(false);
  });
});

describe('appending a signature', () => {
  it('adds one row and leaves the existing one alone', () => {
    const record = parseSignatureRecord(LIVE_RECORD);
    const next = appendSignature(record, {
      name: 'new',
      id: 42,
      comment_id: 1,
      created_at: '2026-09-20T00:00:00Z',
      repoId: 1374479673,
      pullRequestNo: 9,
    });
    expect(next.signedContributors).toHaveLength(2);
    expect(next.signedContributors[0]).toEqual(record.signedContributors[0]);
    expect(hasSigned(next, 104234499)).toBe(true);
    expect(hasSigned(next, 42)).toBe(true);
  });

  it('never writes the same account twice', () => {
    const record = parseSignatureRecord(LIVE_RECORD);
    const again = appendSignature(record, {
      name: 'muhammetsafak',
      id: 104234499,
      comment_id: 2,
      created_at: '2026-09-20T00:00:00Z',
      repoId: 1374479673,
      pullRequestNo: 9,
    });
    expect(again.signedContributors).toHaveLength(1);
  });
});

describe('the comment left on an unsigned pull request', () => {
  it('names who has to sign, quotes the sentence, and carries the marker that stops a second one', () => {
    const verdict = judge(collectAuthors([commit({ author: account({ login: 'someone', id: 3 }) })]), parseSignatureRecord(LIVE_RECORD));
    const body = renderComment({ verdict, documentUrl: 'https://example.invalid/CLA.md' });
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain('@someone');
    expect(body).toContain(SIGNATURE_SENTENCE);
    expect(body).toContain('recheck');
  });

  it('says what an unlinked commit is, by its own name', () => {
    const verdict = judge(
      collectAuthors([
        commit({ sha: `deadbeef${'0'.repeat(32)}`, author: null, commit: { author: { name: 'X', email: 'unlinked@example.invalid' } } }),
      ]),
      parseSignatureRecord(LIVE_RECORD),
    );
    const body = renderComment({ verdict, documentUrl: 'https://example.invalid/CLA.md' });
    expect(body).toContain('deadbee');
    expect(body).toContain('unlinked@example.invalid');
    expect(body).toContain('not linked to any GitHub account');
  });

  it('does not let a commit e-mail break out of the code span it is rendered in', () => {
    // The address comes out of a commit object, which is free text a stranger writes. It reaches no
    // decision anywhere in this gate, but it does reach a comment body, so it is flattened first.
    const verdict = judge(
      collectAuthors([commit({ author: null, commit: { author: { name: 'X', email: '`](https://evil.invalid)\n\n## Merged\n\n`' } } })]),
      parseSignatureRecord(LIVE_RECORD),
    );
    const body = renderComment({ verdict, documentUrl: 'https://example.invalid/CLA.md' });
    expect(body).toContain('authored by `](https://evil.invalid) ## Merged`');
    expect(body.split('\n').some((line) => line.startsWith('## Merged'))).toBe(false);
  });
});
