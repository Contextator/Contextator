/**
 * `.html` / `.htm` → Markdown, and the HTML→Markdown converter the `.docx` transform borrows
 * ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
 *
 * Turndown with the GFM plugin, which is the pairing that keeps tables, strikethrough and task lists
 * as structure instead of flattening them into sentences. Both are dependency-light pure JavaScript —
 * turndown parses through `@mixmark-io/domino`, a JS DOM — which matters more here than it looks: the
 * image this ships in is built for two architectures, and a native parser is a dependency whose
 * absence only shows up on the `arm64` half of it.
 */

import { gfm } from '@joplin/turndown-plugin-gfm';
import TurndownService from 'turndown';
import { decodeUtf8, titleFromPath, withTitle } from './index.js';

/**
 * Elements removed before conversion.
 *
 * `script` and `style` are the obvious two — their bodies are code, and turndown's default is to keep
 * the text of any element it has no rule for, so a page's stylesheet would otherwise be indexed as
 * prose. The rest are elements whose content is never text: an `svg`'s path data, a `canvas`'s
 * fallback, a `template`'s inert body. **Nothing structural is stripped** — no `nav`, no `footer`, no
 * `aside`: boilerplate removal guesses, and a documentation page whose entire body is inside a
 * `<nav>`-labelled shell is a page this would silently index as empty.
 *
 * `title` is on the list for a different reason. Turndown wraps the input in an element of its own
 * before parsing it, so a whole document's `<head>` is never a head and its `<title>` arrives as a
 * stray line of body text above the page's own `<h1>`. It is read off the raw HTML instead, below.
 */
const NON_CONTENT = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'svg', 'canvas', 'link', 'meta', 'title'];

/** `<title>Getting started</title>` — read off the raw text, because turndown only ever sees the body. */
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Enough of an entity decoder for the one string that never reaches the DOM parser: the `<title>`. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

let service: TurndownService | undefined;

function turndown(): TurndownService {
  if (service) return service;
  const created = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  created.use(gfm);
  // Cast because turndown's types spell a tag name as `keyof HTMLElementTagNameMap`, and `svg` is not
  // in that map — it is an SVG element, and it is one of the tags whose body is never prose.
  created.remove(NON_CONTENT as unknown as Parameters<TurndownService['remove']>[0]);
  /**
   * A `data:` image is the whole file inline. Word embeds every picture that way and so do exported
   * pages, and the default rule would put a base64 megabyte into `documents.content` where an agent
   * then reads it. The alt text is the part that was ever worth indexing, so it is what survives.
   */
  created.addRule('imagesWithoutPayloads', {
    filter: 'img',
    replacement: (_content: string, node: Node): string => {
      const element = node as unknown as { getAttribute(name: string): string | null };
      const alt = (element.getAttribute('alt') ?? '').trim();
      const src = (element.getAttribute('src') ?? '').trim();
      if (src && !src.toLowerCase().startsWith('data:')) return `![${alt}](${src})`;
      return alt ? `![${alt}]()` : '';
    },
  });
  service = created;
  return created;
}

const DIVIDER_RE = /^\|[\s\-:|]+\|$/;
const BLANK_ROW_RE = /^\|(?:\s*\|)+$/;

/**
 * Moves a table's first row up into its header when the header GFM produced is blank.
 *
 * A table whose first row is `<td>` rather than `<th>` — which is what Word writes unless somebody
 * ticked "header row", and what a hand-written page writes when nobody thought about it — converts to
 * a table with an empty header and its column names sitting in the body. The names are the part that
 * makes the rest mean anything, and in the header they are also what a reader sees above every row.
 */
export function promoteBlankTableHeader(markdown: string): string {
  const lines = markdown.split('\n');
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!BLANK_ROW_RE.test(lines[i]) || !DIVIDER_RE.test(lines[i + 1]) || !lines[i + 2].startsWith('|')) continue;
    if (DIVIDER_RE.test(lines[i + 2])) continue;
    lines[i] = lines[i + 2];
    lines.splice(i + 2, 1);
  }
  return lines.join('\n');
}

/** HTML (a document or a fragment) → Markdown, with no title handling. Shared with the `.docx` transform. */
export function htmlFragmentToMarkdown(html: string): string {
  return (
    promoteBlankTableHeader(turndown().turndown(html))
      // A non-breaking space is a typesetting instruction for a browser and an invisible oddity in a
      // Markdown file: it is not the character an agent searching for "5 s" will type.
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export async function htmlToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
  const html = decodeUtf8(bytes);
  const markdown = htmlFragmentToMarkdown(html);
  const declared = TITLE_RE.exec(html)?.[1];
  const title = declared ? decodeEntities(declared).replace(/\s+/g, ' ').trim() : '';
  return withTitle(markdown, title || titleFromPath(relativePath));
}
