import { z } from 'zod';

/**
 * Every decision the licence gate makes, with nothing in it that touches the network, the clock or the
 * environment ([ADR-0061](../../../.ssot/ADR.md#adr-0061)).
 *
 * The gate is what stands between the commercial licence of [ADR-0025](../../../.ssot/ADR.md#adr-0025)
 * and an unlicensed contribution, and a contribution merged without a grant is not recoverable by
 * reverting the commit. A mechanism like that cannot be tested by running it on GitHub and looking at
 * the result: the interesting cases are the ones nobody opens a pull request for. So the judgements
 * live here, as functions over plain data, and `test/cla-rules.test.ts` asks them the questions a
 * contributor never will — an author whose e-mail belongs to no account, an account signing for
 * somebody else, a name shaped like a bot's.
 *
 * `scripts/cla/run.ts` is the other half: it fetches, writes and exits, and decides nothing.
 */

/** The sentence a contributor leaves as a comment. `CLA.md` §3 and `CONTRIBUTING.md` both quote it. */
export const SIGNATURE_SENTENCE = 'I have read the CLA Document and I hereby sign the CLA';

/**
 * Internal spacing is flexible because a comment box reflows, and the leading/trailing text is not,
 * because `CONTRIBUTING.md` promises that a sentence buried in a longer comment is not read. The
 * surrounding contract is in `readCommentIntent`: a body carrying a line break is never a signature.
 */
const SIGNATURE_RE = /i\s+have\s+read\s+the\s+cla\s+document\s+and\s+i\s+hereby\s+sign\s+the\s+cla/;

export type CommentIntent = 'signature' | 'recheck' | 'none';

/**
 * What a pull request comment is asking for.
 *
 * A signature has to be a comment of its own — one line, nothing wrapped around it. That is not
 * fussiness: a quoted reply ("> I have read the CLA Document and I hereby sign the CLA — did that
 * work?") would otherwise sign on behalf of whoever is being quoted, and the person quoting has no
 * idea they just made a legal statement. `CONTRIBUTING.md` step 3 says so in the same words.
 */
export function readCommentIntent(body: string): CommentIntent {
  const trimmed = body.trim();
  if (trimmed.toLowerCase() === 'recheck') return 'recheck';
  if (/[\r\n]/.test(trimmed)) return 'none';
  return SIGNATURE_RE.test(trimmed.toLowerCase()) ? 'signature' : 'none';
}

/**
 * A GitHub account, as GitHub itself describes one. `type` is GitHub's field and the only thing this
 * gate will accept as proof that an account is a bot.
 *
 * There is no name here on purpose — see `collectAuthors`.
 */
export type Account = {
  login: string;
  id: number;
  type: string;
};

/** One commit of a pull request, in the shape the REST API returns it. */
export type CommitRecord = {
  sha: string;
  /** `null` when the commit's author e-mail address belongs to no GitHub account. */
  author: Account | null;
  /** The free text inside the commit object. Used for the explanation, never for a decision. */
  commit: { author: { name: string; email: string } };
};

/** A commit whose author cannot be resolved to an account, and therefore cannot have signed. */
export type UnlinkedCommit = {
  sha: string;
  email: string;
};

export type Authors = {
  /** One entry per distinct account id, in first-seen order. Bots included; `mustSign` drops them. */
  accounts: Account[];
  /** Every commit that resolved to no account at all. */
  unlinked: UnlinkedCommit[];
};

/**
 * Who authored this pull request.
 *
 * **Identity here is the GitHub account and nothing else.** The Action this replaced resolved a
 * committer as `login || name`, where `name` is the free text in the commit object — text an outsider
 * chooses with `git commit --author="Someone <unlinked@example.invalid>"`. Every comparison downstream
 * of that fallback was a comparison against a string the contributor wrote, which is the whole of the
 * bypass: pick a name that is already in the signature file, or already on an allowlist, and walk
 * through. `CommitRecord.commit.author` is carried into `UnlinkedCommit.email` so the contributor can
 * be told *which* commit to fix, and it reaches no other function in this file.
 *
 * The **author** is checked and not the committer. The author is who wrote the code and therefore who
 * holds the copyright the grant is about; the committer of a rebased or a web-edited commit is often
 * `web-flow` or whoever pressed the button, and asking them to licence somebody else's work would be
 * asking the wrong person.
 */
export function collectAuthors(commits: readonly CommitRecord[]): Authors {
  const accounts: Account[] = [];
  const seen = new Set<number>();
  const unlinked: UnlinkedCommit[] = [];

  for (const commit of commits) {
    if (commit.author === null) {
      unlinked.push({ sha: commit.sha, email: commit.commit.author.email });
      continue;
    }
    if (seen.has(commit.author.id)) continue;
    seen.add(commit.author.id);
    accounts.push(commit.author);
  }

  return { accounts, unlinked };
}

/**
 * Bots are exempt because they cannot agree to anything, and `type` is how GitHub says an account is
 * one. It is deliberately not a name match: `github-actions[bot]` and `dependabot[bot]` are logins
 * anybody could have been issued in some other shape, and an allowlist of *names* is precisely the
 * hole this gate was rebuilt to close. There is no configuration for this and no way to add an
 * account to it — a human is never a `Bot`, and a maintainer signs like everybody else.
 */
export function isBot(account: Account): boolean {
  return account.type === 'Bot';
}

/** One row of `signatures/v1/cla.json`, in the shape the record has carried since the first signature. */
export const SignatureSchema = z.object({
  /** The signatory's GitHub login at the time of signing. Kept for readability; never matched on. */
  name: z.string(),
  /** The account's numeric id — immutable, unlike the login. This is the identity that counts. */
  id: z.number().int(),
  comment_id: z.number().int(),
  created_at: z.string(),
  repoId: z.number().int(),
  pullRequestNo: z.number().int(),
});

export type Signature = z.infer<typeof SignatureSchema>;

/**
 * The file as a whole. `z.object` rather than `z.strictObject`: an unknown key is somebody's later
 * addition to a record this repository must keep reading, and refusing to parse it would turn the
 * gate red for every contributor at once.
 */
export const SignatureRecordSchema = z.object({
  signedContributors: z.array(SignatureSchema),
});

export type SignatureRecord = z.infer<typeof SignatureRecordSchema>;

export class SignatureRecordError extends Error {}

/**
 * Parse the record, or refuse.
 *
 * Refusing is the safe direction: a record this gate cannot read is a record it cannot prove anybody
 * signed, and the only honest answer to that is a red check. A tolerant parser here would report
 * "everybody has signed" over a truncated file.
 */
export function parseSignatureRecord(text: string): SignatureRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new SignatureRecordError(`the signature record is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = SignatureRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new SignatureRecordError(`the signature record does not have the expected shape: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

/**
 * Serialised the way the record is read: by a person, in a diff, years after the fact. Two-space
 * indentation and a trailing newline make one new signature one added block rather than one rewritten
 * line, which is what the evidence is for.
 */
export function serialiseSignatureRecord(record: SignatureRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Has this account signed?
 *
 * Matched on the numeric id and never on the login. A login is released when an account is deleted and
 * can be claimed by somebody else; the id cannot. Matching on the name would mean a signature keeps
 * counting for whoever picks the name up next.
 */
export function hasSigned(record: SignatureRecord, accountId: number): boolean {
  return record.signedContributors.some((entry) => entry.id === accountId);
}

/** Append, unless it is already there. The caller re-reads before calling this; see `run.ts`. */
export function appendSignature(record: SignatureRecord, signature: Signature): SignatureRecord {
  if (hasSigned(record, signature.id)) return record;
  return { ...record, signedContributors: [...record.signedContributors, signature] };
}

export type Verdict = {
  /** True only when every author is accounted for: signed, or a bot, and no unlinked commit at all. */
  passed: boolean;
  /** Accounts that have to sign and have not. Bots are not here; signatories are not here. */
  mustSign: Account[];
  /** Commits whose author belongs to no account. Their presence alone fails the gate. */
  unlinked: UnlinkedCommit[];
};

/**
 * The judgement, over the authors of a pull request and the record as it stands.
 *
 * An unlinked commit fails the gate on its own and there is no way to sign for one. That is the
 * fail-closed half of this function and the reason it exists: an address belonging to no account names
 * nobody, so no account can grant a licence over what it wrote, and treating it as signed would be
 * treating free text as an identity.
 */
export function judge(authors: Authors, record: SignatureRecord): Verdict {
  const mustSign = authors.accounts.filter((account) => !isBot(account) && !hasSigned(record, account.id));
  return { passed: mustSign.length === 0 && authors.unlinked.length === 0, mustSign, unlinked: authors.unlinked };
}

/**
 * May this comment record a signature for this account?
 *
 * Two conditions, and the second is the one that matters. The signature is written against the account
 * that left the comment — never against a name inside it — and it only counts when that account
 * actually authored one of the commits. Without the second condition anybody who can comment on a pull
 * request could sign for its author, which is a licence grant made by somebody with no rights to
 * grant. `CLA.md` §3 says nobody can sign on somebody else's behalf; this is the sentence that makes
 * it true.
 */
export function maySignFor(commenter: Account, authors: Authors): boolean {
  if (isBot(commenter)) return false;
  return authors.accounts.some((account) => account.id === commenter.id);
}

/** Free text from a commit, made safe to drop into a Markdown comment body. */
function inlineCode(text: string): string {
  const flattened = text.replace(/[\s`]+/g, ' ').trim();
  const clipped = flattened.length > 120 ? `${flattened.slice(0, 117)}...` : flattened;
  return clipped === '' ? '`(empty)`' : `\`${clipped}\``;
}

/**
 * The marker that makes the gate's own comment findable on a later run. It is an HTML comment, so it
 * is invisible in the rendered thread, and it is matched on rather than the author login so that a
 * comment from some other automation is never mistaken for this one and edited.
 */
export const COMMENT_MARKER = '<!-- contextator:licence-grant -->';

export type CommentContext = {
  verdict: Verdict;
  /** Absolute, because this is read on github.com and a relative link would resolve against the fork. */
  documentUrl: string;
};

/**
 * The comment left on a pull request that has not been signed for.
 *
 * It is written once and thereafter edited in place (see `run.ts`): a contributor who pushes four more
 * commits before signing should not come back to four identical demands. `CONTRIBUTING.md` step 1
 * promises that a signed pull request gets no comment at all, which is why nothing here has a
 * "thank you, that is recorded" branch.
 */
export function renderComment(context: CommentContext): string {
  const lines: string[] = [COMMENT_MARKER, ''];
  lines.push('## Licence grant');
  lines.push('');
  lines.push(
    `Contextator is AGPL-3.0-or-later with a commercial licence offered alongside it, and that second half only holds while the copyright is held in full. Before this is merged, everybody who authored a commit in it grants a licence — the text is [\`CLA.md\`](${context.documentUrl}).`,
  );

  if (context.verdict.mustSign.length > 0) {
    lines.push('');
    lines.push('**Waiting on a signature from:**');
    lines.push('');
    for (const account of context.verdict.mustSign) {
      lines.push(`- @${account.login}`);
    }
    lines.push('');
    lines.push('Each of them posts this as a comment of its own on this pull request, from their own account:');
    lines.push('');
    lines.push('```');
    lines.push(SIGNATURE_SENTENCE);
    lines.push('```');
    lines.push('');
    lines.push(
      'Capitalisation does not matter and a trailing full stop is fine; the sentence inside a longer or multi-line comment is not read. Nobody can sign for anybody else.',
    );
  }

  if (context.verdict.unlinked.length > 0) {
    lines.push('');
    lines.push('**Commits that cannot be signed for yet:**');
    lines.push('');
    for (const commit of context.verdict.unlinked) {
      lines.push(`- \`${commit.sha.slice(0, 7)}\` — authored by ${inlineCode(commit.email)}, which is not linked to any GitHub account.`);
    }
    lines.push('');
    lines.push(
      'An address that belongs to no account names nobody, so no account can grant a licence over what that commit wrote. Add the address to your GitHub account (Settings → Emails), or rewrite the commit with an address that is already on one, and push again.',
    );
  }

  lines.push('');
  lines.push('If you have signed and this check is still red, comment `recheck`.');
  return `${lines.join('\n')}\n`;
}
