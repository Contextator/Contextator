import type { GithubAuthor, GithubComment, GithubDiscussion, GithubIssue } from './github-client.js';
import { frontmatter } from './notion-render.js';

/**
 * An issue or a Discussion as one Markdown document ([ADR-0128](../../../.ssot/ADR.md#adr-0128) decision 4):
 * front matter with the title, the page URL (`url`, [ADR-0116](../../../.ssot/ADR.md#adr-0116)), the state, the
 * labels, the author and the update time (`updated_at`), then the body, then the comments (and, for a
 * Discussion, the replies) in order, each under a heading naming the author and the date.
 *
 * Pure: the same input is the same text, which is what lets the driver skip writing a file whose rendering did
 * not change and so leave the indexer a file it has no reason to read again.
 */

/**
 * The most a rendered document is allowed to weigh, in characters. A thread past it is cut at a comment
 * boundary and says so at the end, so that one runaway issue (a bot posting a build log on every push) cannot
 * make a single document of the source larger than everything else together.
 */
export const MAX_DOCUMENT_CHARS = 1_000_000;

const day = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso || 'unknown date');

/** The text of one body, trimmed of the line endings GitHub stores (`\r\n`). */
const clean = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

/** A comment heading: the author and the day. Not Markdown-escaped: a login is `[A-Za-z0-9-]` and `[bot]`. */
const heading = (level: number, author: GithubAuthor, createdAt: string, suffix = ''): string =>
  `${'#'.repeat(level)} ${author.login}${author.bot ? ' (bot)' : ''} — ${day(createdAt)}${suffix}`;

/** `true` for a comment this source keeps under `includeBots`. */
export const keepsAuthor = (author: GithubAuthor, includeBots: boolean): boolean => includeBots || !author.bot;

function assemble(head: string, sections: string[]): string {
  let text = head;
  let omitted = 0;
  for (const section of sections) {
    if (text.length + section.length + 2 > MAX_DOCUMENT_CHARS) {
      omitted++;
      continue;
    }
    text += `\n\n${section}`;
  }
  if (omitted > 0) text += `\n\n_${omitted} further comment(s) are not shown: the thread is longer than ${MAX_DOCUMENT_CHARS} characters._`;
  return `${text}\n`;
}

function clip(text: string): string {
  return text.length > MAX_DOCUMENT_CHARS
    ? `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n_The text is cut here: it is longer than ${MAX_DOCUMENT_CHARS} characters._`
    : text;
}

export function issueFileName(number: number): string {
  return `issues/${number}.md`;
}

export function discussionFileName(number: number): string {
  return `discussions/${number}.md`;
}

/** The issue and the comments left on it, in the order GitHub lists them. */
export function renderIssue(issue: GithubIssue, comments: readonly GithubComment[], includeBots: boolean): string {
  const state = issue.state === 'closed' && issue.stateReason ? `closed (${issue.stateReason.replaceAll('_', ' ')})` : issue.state;
  const head =
    frontmatter({
      // `url` and `updated_at` first: `documentMeta` reads the head of the file only, and a long title or label list must not push them out of it.
      url: issue.htmlUrl,
      updated_at: issue.updatedAt,
      title: issue.title,
      kind: 'issue',
      number: String(issue.number),
      state,
      labels: issue.labels.join(', '),
      author: issue.author.login,
      created_at: issue.createdAt,
    }) + `\n# ${issue.title} (#${issue.number})\n\n${clip(clean(issue.body)) || '_No description._'}`;
  const sections = comments
    .filter((comment) => keepsAuthor(comment.author, includeBots))
    .map((comment) => `${heading(2, comment.author, comment.createdAt)}\n\n${clip(clean(comment.body)) || '_Empty comment._'}`);
  return assemble(head, sections);
}

function renderThread(comment: GithubComment, includeBots: boolean): string {
  const mark = comment.isAnswer ? ' — accepted answer' : '';
  const parts = [`${heading(2, comment.author, comment.createdAt, mark)}\n\n${clip(clean(comment.body)) || '_Empty comment._'}`];
  for (const reply of comment.replies ?? []) {
    if (!keepsAuthor(reply.author, includeBots)) continue;
    parts.push(`${heading(3, reply.author, reply.createdAt, ' (reply)')}\n\n${clip(clean(reply.body)) || '_Empty reply._'}`);
  }
  return parts.join('\n\n');
}

/** The Discussion, its comments and the replies under each comment. */
export function renderDiscussion(discussion: GithubDiscussion, includeBots: boolean): string {
  const state = discussion.closed ? 'closed' : discussion.answered ? 'answered' : 'open';
  const head =
    frontmatter({
      url: discussion.htmlUrl,
      updated_at: discussion.updatedAt,
      title: discussion.title,
      kind: 'discussion',
      number: String(discussion.number),
      state,
      category: discussion.category,
      labels: discussion.labels.join(', '),
      author: discussion.author.login,
      created_at: discussion.createdAt,
    }) + `\n# ${discussion.title} (#${discussion.number})\n\n${clip(clean(discussion.body)) || '_No description._'}`;
  const sections = discussion.comments
    .filter((comment) => keepsAuthor(comment.author, includeBots))
    .map((comment) => renderThread(comment, includeBots));
  return assemble(head, sections);
}
