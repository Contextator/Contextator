/**
 * Confluence **storage format** → Markdown ([ADR-0059](../../../.ssot/ADR.md#adr-0059)).
 *
 * **This module does not convert HTML.** `services/doc-types/html.ts` does, and it is called at the
 * bottom of this file with the whole of the page. What happens here is the one step before that:
 * storage format is XHTML *plus* Confluence's own `ac:` and `ri:` namespaces, and three of those
 * constructs do not survive an HTML parser at all. Writing a second converter was the obvious shape
 * and is the wrong one — the shared one has a turndown configuration, a GFM plugin, a `data:` image
 * rule, a blank-table-header repair and two review rounds behind it, and a parallel path would carry
 * none of them and would drift from the first day.
 *
 * The three that need help, and why an HTML parser cannot be left to do it:
 *
 * 1. **`<![CDATA[…]]>`.** In XML it is text; in HTML it is a *bogus comment*, and its contents are
 *    dropped on the floor. Every code block in a Confluence page lives inside one, so handing storage
 *    format straight to turndown silently loses exactly the part of a runbook anybody was searching
 *    for. This is the single reason this file exists.
 * 2. **`<ac:structured-macro>`.** A macro's configuration (`<ac:parameter>`) is not prose and must not
 *    be indexed as prose, while its `<ac:rich-text-body>` is the page's own text and must be. An HTML
 *    parser has no rule for either and turndown keeps the text of both.
 * 3. **`<ac:link>` and `<ac:image>`.** The target is in an `ri:` attribute on a child element, so an
 *    unknown-element walk yields the label with nothing attached to it.
 *
 * Everything else — headings, lists, tables, `<strong>`, `<code>` — is ordinary XHTML and is left
 * exactly as it is for the shared converter to handle.
 */

import { htmlFragmentToMarkdown } from '../doc-types/html.js';
import { withTitle } from '../doc-types/index.js';

/**
 * What one page's storage body may be before it is refused.
 *
 * **A local constant rather than `MAX_CONVERTED_FILE_BYTES`, and that is deliberate.** The config
 * value is reached through `DriverContext`, whose `config` is a `Pick` that `services/scheduler.ts`
 * also names — widening it would edit the scheduler, and a driver that makes the scheduler change
 * shape is a driver using the interface wrongly. The number is the same order as the file ceiling and
 * bounds the same thing: a string held whole in the process that also serves the dashboard and `/mcp`.
 * A Confluence page is a wiki page; 8 MiB of one is not a page.
 */
export const MAX_PAGE_BODY_BYTES = 8 * 1024 * 1024;

/** A page that cannot be rendered. Carries the page's own title, because the id alone is not a place. */
export class ConfluenceRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfluenceRenderError';
  }
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** The innermost `<ac:structured-macro>`: one with no other macro opening inside it. */
const INNERMOST_MACRO = /<ac:structured-macro\b([^>]*)>((?:(?!<ac:structured-macro\b)[\s\S])*?)<\/ac:structured-macro>/;
const SELF_CLOSING_MACRO = /<ac:structured-macro\b[^>]*\/>/g;
const MACRO_NAME = /ac:name="([^"]*)"/;
const PLAIN_TEXT_BODY = /<ac:plain-text-body\b[^>]*>([\s\S]*?)<\/ac:plain-text-body>/;
const RICH_TEXT_BODY = /<ac:rich-text-body\b[^>]*>([\s\S]*?)<\/ac:rich-text-body>/;
const LANGUAGE_PARAM = /<ac:parameter\b[^>]*ac:name="language"[^>]*>([\s\S]*?)<\/ac:parameter>/;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** `info`, `note`, `warning`, `tip` — Confluence's admonitions, and the only macros with a fixed meaning. */
const ADMONITIONS: Record<string, string> = { info: 'Info', note: 'Note', warning: 'Warning', tip: 'Tip', panel: 'Panel' };

function cdataText(fragment: string): string {
  const matches = [...fragment.matchAll(CDATA)];
  if (matches.length > 0) return matches.map((m) => m[1]).join('');
  return fragment;
}

/**
 * Macros, innermost first, until none is left.
 *
 * The loop is bounded because a regex that can fail to shrink its input is a hang in a server: a
 * malformed body whose closing tags do not match would otherwise spin here rather than be reported as
 * a page that could not be rendered. The cap is far above any real page — a busy runbook has tens of
 * macros, not thousands — and reaching it is a refusal, not a silent truncation.
 */
const MAX_MACRO_PASSES = 2000;

function expandMacros(xhtml: string): string {
  let out = xhtml.replace(SELF_CLOSING_MACRO, '');
  for (let pass = 0; pass < MAX_MACRO_PASSES; pass++) {
    const match = INNERMOST_MACRO.exec(out);
    if (!match) return out;
    out = out.slice(0, match.index) + renderMacro(match[1], match[2]) + out.slice(match.index + match[0].length);
  }
  throw new ConfluenceRenderError('the page nests more macros than this product will expand; it is probably not a document');
}

function renderMacro(attributes: string, body: string): string {
  const name = (MACRO_NAME.exec(attributes)?.[1] ?? '').toLowerCase();

  if (name === 'code' || name === 'noformat') {
    const plain = PLAIN_TEXT_BODY.exec(body)?.[1] ?? '';
    const language = name === 'code' ? cdataText(LANGUAGE_PARAM.exec(body)?.[1] ?? '').trim() : '';
    const klass = /^[A-Za-z0-9+#-]{1,30}$/.test(language) ? ` class="language-${language}"` : '';
    return `<pre><code${klass}>${escapeText(cdataText(plain))}</code></pre>`;
  }

  const rich = RICH_TEXT_BODY.exec(body)?.[1];
  const label = ADMONITIONS[name];
  if (label) {
    // The kind of the callout stays a searchable word, which is the same decision `flavors.ts` makes
    // for an Obsidian `> [!note]`. A warning that reads as an ordinary paragraph has lost the one
    // thing that made it a warning.
    return `<blockquote><p><strong>${label}:</strong></p>${rich ?? ''}</blockquote>`;
  }
  // Any other macro: its body is the page's own text and is kept; the macro itself is configuration
  // and is not. A macro with no rich body — a table of contents, a children list, a Jira query — has
  // nothing of this page in it and leaves nothing behind.
  return rich ?? '';
}

const LINK = /<ac:link\b([^>]*)>([\s\S]*?)<\/ac:link>/g;
const RI_PAGE_TITLE = /<ri:page\b[^>]*ri:content-title="([^"]*)"/;
const RI_ATTACHMENT = /<ri:attachment\b[^>]*ri:filename="([^"]*)"/;
const RI_URL = /<ri:url\b[^>]*ri:value="([^"]*)"/;
const LINK_BODY = /<ac:(?:plain-text-link-body|link-body)\b[^>]*>([\s\S]*?)<\/ac:(?:plain-text-link-body|link-body)>/;
const AC_ANCHOR = /ac:anchor="([^"]*)"/;

/**
 * `<ac:link>` → `<a>`.
 *
 * The href of a link to another Confluence page is that page's **title**, not a URL: a storage-format
 * link names its target by title and this product does not have the other page's URL in hand while it
 * is rendering this one. That is the shape `flavors.ts` already gives a Notion export link
 * (`[Text](Page%20Name.md)`) and it keeps the label — the part anybody searches for — attached to a
 * target a reader can recognise.
 */
function expandLinks(xhtml: string): string {
  return xhtml.replace(LINK, (_match, attributes: string, body: string) => {
    const anchor = AC_ANCHOR.exec(attributes)?.[1] ?? '';
    const target = RI_PAGE_TITLE.exec(body)?.[1] ?? RI_ATTACHMENT.exec(body)?.[1] ?? RI_URL.exec(body)?.[1] ?? '';
    const rawLabel = cdataText(LINK_BODY.exec(body)?.[1] ?? '').trim();
    const label = rawLabel || target || anchor;
    if (!label) return '';
    const href = target ? encodeURI(target) : '';
    const fragment = anchor ? `#${encodeURIComponent(anchor)}` : '';
    if (!href && !fragment) return escapeText(label);
    return `<a href="${escapeAttribute(`${href}${fragment}`)}">${label.startsWith('<') ? label : escapeText(label)}</a>`;
  });
}

const IMAGE = /<ac:image\b([^>]*)(?:\/>|>([\s\S]*?)<\/ac:image>)/g;
const AC_ALT = /ac:alt="([^"]*)"/;

/** `<ac:image>` → `<img>`, so the shared converter's own image rule decides what survives. */
function expandImages(xhtml: string): string {
  return xhtml.replace(IMAGE, (_match, attributes: string, body: string | undefined) => {
    const inner = body ?? '';
    const src = RI_URL.exec(inner)?.[1] ?? RI_ATTACHMENT.exec(inner)?.[1] ?? '';
    const alt = AC_ALT.exec(attributes)?.[1] ?? RI_ATTACHMENT.exec(inner)?.[1] ?? '';
    if (!src && !alt) return '';
    return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" />`;
  });
}

const TASK = /<ac:task\b[^>]*>([\s\S]*?)<\/ac:task>/g;
const TASK_STATUS = /<ac:task-status\b[^>]*>([\s\S]*?)<\/ac:task-status>/;
const TASK_BODY = /<ac:task-body\b[^>]*>([\s\S]*?)<\/ac:task-body>/;

/** `<ac:task-list>` → a GFM task list, which the shared converter's GFM plugin already renders. */
function expandTasks(xhtml: string): string {
  return xhtml
    .replace(TASK, (_match, body: string) => {
      const done = (TASK_STATUS.exec(body)?.[1] ?? '').trim() === 'complete';
      const text = TASK_BODY.exec(body)?.[1] ?? '';
      return `<li><input type="checkbox" disabled${done ? ' checked' : ''} />${text}</li>`;
    })
    .replace(/<ac:task-list\b[^>]*>/g, '<ul>')
    .replace(/<\/ac:task-list>/g, '</ul>');
}

/** Elements whose content is configuration rather than text, removed whole. */
const CONFIGURATION = /<ac:(parameter|task-id|task-status|placeholder)\b[^>]*>[\s\S]*?<\/ac:\1>/g;
/** Whatever `ac:`/`ri:` tags are left: unwrapped, so their text survives and their markup does not. */
const REMAINING_NAMESPACED = /<\/?(?:ac|ri):[A-Za-z0-9_-]+(?:\s[^>]*?)?\/?>/g;

/**
 * Storage format → the plain XHTML the shared converter understands.
 *
 * Exported so that `test/confluence-driver.test.ts` can assert on the intermediate form: the claim
 * worth pinning is *what this hands over*, and asserting it through the Markdown would also be
 * asserting turndown's behaviour, which is `test/doc-types.test.ts`' job.
 */
export function storageToHtml(storage: string): string {
  const macros = expandMacros(storage);
  const linked = expandLinks(macros);
  const imaged = expandImages(linked);
  const tasked = expandTasks(imaged);
  return (
    tasked
      .replace(CONFIGURATION, '')
      // Any CDATA still standing is text that belonged to a construct with no special handling. It is
      // escaped rather than dropped, because dropping it is how a page silently loses a paragraph.
      .replace(CDATA, (_match, text: string) => escapeText(text))
      .replace(REMAINING_NAMESPACED, '')
  );
}

/**
 * One Confluence page as the Markdown that will be written to disk and then indexed.
 *
 * The title comes from Confluence rather than from the body: a storage-format page has no `<h1>` of
 * its own — the title is a property of the page, which is exactly the case `withTitle` exists for.
 */
export function storageToMarkdown(storage: string, title: string): string {
  const bytes = Buffer.byteLength(storage, 'utf8');
  if (bytes > MAX_PAGE_BODY_BYTES) {
    throw new ConfluenceRenderError(
      `"${title}" is ${Math.ceil(bytes / 1024)} KiB of storage format, over the ${MAX_PAGE_BODY_BYTES / (1024 * 1024)} MiB one page may be. ` +
        'Converting a page happens on the thread that answers requests — unlike an indexed file, which is converted off it — so split the page, or exclude its space from this source.',
    );
  }
  return withTitle(htmlFragmentToMarkdown(storageToHtml(storage)), title);
}
