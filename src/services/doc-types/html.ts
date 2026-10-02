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
 * prose. The rest are elements whose content is never text: a `canvas`'s fallback, a `template`'s
 * inert body. An `svg` is not on the list any more: its path data is still dropped, but the words a
 * diagram carries are kept by the `svgText` rule below. **Nothing structural is stripped** — no `nav`, no `footer`, no
 * `aside`: boilerplate removal guesses, and a documentation page whose entire body is inside a
 * `<nav>`-labelled shell is a page this would silently index as empty.
 *
 * `title` is on the list for a different reason. Turndown wraps the input in an element of its own
 * before parsing it, so a whole document's `<head>` is never a head and its `<title>` arrives as a
 * stray line of body text above the page's own `<h1>`. It is read off the raw HTML instead, below.
 */
const NON_CONTENT = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'canvas', 'link', 'meta', 'title'];

/** The SVG elements whose content is text a reader sees (`text`) or is told (`title`, `desc`). */
const SVG_TEXT_ELEMENTS = new Set(['text', 'title', 'desc']);

/**
 * Parents an SVG is drawn *inside a line of* rather than between blocks: a heading's anchor icon, a
 * "copy" button, an icon in a sentence or a table cell. Text out of an SVG in one of these stays on
 * the line — a paragraph break there would split the heading or the sentence it sits in, and a table
 * cell cannot hold one at all.
 */
const PHRASING_PARENTS = new Set([
  'a',
  'abbr',
  'b',
  'button',
  'cite',
  'code',
  'em',
  'i',
  'kbd',
  'label',
  'mark',
  'p',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'u',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'dt',
  'caption',
  'figcaption',
  'legend',
]);

/** Just the DOM an SVG walk needs; turndown hands over domino nodes, typed as the browser's. */
interface SvgNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<SvgNode>;
  parentNode?: SvgNode | null;
  getAttribute?(name: string): string | null;
}

/** Whether the SVG draws any `<text>` — what tells a diagram with labels apart from an icon with a tooltip. */
function hasTextElement(node: SvgNode): boolean {
  return Array.from(node.childNodes).some((child) => child.nodeType === 1 && (child.nodeName.toLowerCase() === 'text' || hasTextElement(child)));
}

/**
 * Whether the SVG's words become paragraphs of their own or stay inside the line around it.
 *
 * **Paragraphs only for a drawing: an SVG that draws `<text>` and sits between blocks** — not inside a
 * phrasing element, and not beside text of its parent's own. Every other
 * SVG with words in it is an icon whose `<title>` is a tooltip — the anchor link beside a heading, the
 * copy button in a sentence — and breaking the line there would turn `## Setup` into `## Setup [`
 * followed by a stray paragraph.
 */
function svgIsBlock(svg: SvgNode): boolean {
  const parent = svg.parentNode;
  if (parent && parent.nodeType === 1) {
    if (PHRASING_PARENTS.has(parent.nodeName.toLowerCase())) return false;
    // A container that may hold either blocks or text (`li`, `dd`, `div`) is a line when it has
    // words of its own beside the SVG: `<li>Step <svg>…</svg> done</li>` reads as one sentence.
    if (Array.from(parent.childNodes).some((sibling) => sibling !== svg && sibling.nodeType === 3 && (sibling.textContent ?? '').trim() !== ''))
      return false;
  }
  return hasTextElement(svg);
}

/**
 * The words in an inline SVG, one line per `<text>`, `<title>` or `<desc>`, in document order.
 *
 * Architecture diagrams and charts exported as inline SVG carry their labels as `<text>`, and those
 * labels are the only part of the drawing anyone will ever search for. A text element's own content —
 * `<tspan>`s included — is taken whole and not descended into again, so a label is never counted
 * twice. Everything else — paths, shapes, gradients, `foreignObject` — is still dropped.
 */
function svgText(svg: SvgNode): string[] {
  const lines: string[] = [];
  const walk = (node: SvgNode): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (SVG_TEXT_ELEMENTS.has(child.nodeName.toLowerCase())) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        continue;
      }
      walk(child);
    }
  };
  walk(svg);
  return lines;
}

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
  // Cast because turndown's types spell the filter as `keyof HTMLElementTagNameMap` entries, and a
  // mutable `string[]` does not narrow to that union.
  created.remove(NON_CONTENT as unknown as Parameters<TurndownService['remove']>[0]);
  /**
   * An inline SVG becomes the text it shows and nothing else. A rule added with `addRule` is consulted
   * before the `remove` list, which is why this one can sit beside it; an SVG with no text at all is
   * blank to turndown and never reaches it.
   */
  created.addRule('svgText', {
    filter: (node: HTMLElement): boolean => node.nodeName.toLowerCase() === 'svg',
    replacement: (_content: string, node: Node): string => {
      const svg = node as unknown as SvgNode;
      // `aria-hidden` is the page's own statement that the drawing says nothing a reader needs —
      // decoration, or an icon whose meaning the text beside it already carries.
      if (svg.getAttribute?.('aria-hidden')?.trim().toLowerCase() === 'true') return '';
      // Escaped the way turndown escapes any other text, so a label like `1. Ingest` stays a label.
      const lines = svgText(svg).map((line) => created.escape(line));
      if (lines.length === 0) return '';
      return svgIsBlock(svg) ? `\n\n${lines.join('\n\n')}\n\n` : lines.join(' ');
    },
  });
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
