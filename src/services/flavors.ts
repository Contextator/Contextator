/**
 * Source "flavors": small, pure transforms applied to paths (before prefixing) and to content
 * (after hashing, before chunking) so exports from other tools read as ordinary Markdown.
 *
 * Since [ADR-0057](../../.ssot/ADR.md#adr-0057) a flavor may also say something a transform cannot:
 * that a file is **not one document**. `openapi` is that flavor, and the two things below —
 * `allowedExtensionsFor` and `expandsToManyDocuments` — are the whole of what the rest of the product
 * has to know about it. The expansion itself lives in `services/openapi.ts`.
 */

import { SUPPORTED_EXTENSIONS } from './fs-scan.js';
import { isSpecificationFile } from './openapi.js';

export const FLAVORS = ['plain', 'obsidian', 'notion-export', 'openapi'] as const;
export type Flavor = (typeof FLAVORS)[number];

/**
 * Extensions a flavor's own reader takes, **on top of** `SUPPORTED_EXTENSIONS`.
 *
 * `.yaml` and `.json` are not document types and deliberately never became one
 * ([ADR-0056](../../.ssot/ADR.md#adr-0056) keys off the extension because a `.pdf` is a PDF whatever
 * anyone believes). A `.yaml` is a CI config, a Helm values file, a test fixture — the extension
 * implies nothing. Only the operator choosing this flavor says "the structured files in this source are
 * API specifications", so these extensions are reachable only from here, and a `plain` source cannot be
 * talked into parsing its lockfile as an API.
 */
const FLAVOR_EXTENSIONS: Partial<Record<Flavor, readonly string[]>> = {
  openapi: ['yaml', 'yml', 'json'],
};

/** Every extension any flavor adds — the widened value set `document_sources.config` may hold. */
export const FLAVOR_ONLY_EXTENSIONS = ['yaml', 'yml', 'json'] as const;

/** The extensions a source of this flavor may be configured with, and the set its scan is filtered to. */
export function allowedExtensionsFor(flavor: Flavor): readonly string[] {
  const extra = FLAVOR_EXTENSIONS[flavor];
  return extra ? [...SUPPORTED_EXTENSIONS, ...extra] : SUPPORTED_EXTENSIONS;
}

/**
 * Whether this flavor turns this one file into several documents rather than one.
 *
 * It is per **file** and not per source, because a repository of specifications nearly always has a
 * `README.md` beside them and that file is an ordinary Markdown document. Everything this returns
 * `false` for stays on the path it has always been on.
 */
export function expandsToManyDocuments(flavor: Flavor, relativePath: string): boolean {
  return flavor === 'openapi' && isSpecificationFile(relativePath);
}

/** Notion export names look like `Getting started 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md` (also on directories). */
const NOTION_ID_SUFFIX = /[ _-]?[0-9a-f]{32}(?=(\.[a-z0-9]+)?$)/i;

export function transformPath(flavor: Flavor, relativePath: string): string {
  if (flavor !== 'notion-export') return relativePath;
  return relativePath
    .split('/')
    .map((segment) => segment.replace(NOTION_ID_SUFFIX, '').trim() || segment)
    .join('/');
}

/** Only these stay embeds; `![[Note]]` embeds another note's text, which flattens to a link. */
const EMBEDDABLE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/**
 * `[[Page]]`, `[[Page|Alias]]`, `[[Page#Heading]]`, `[[Page#^block]]`, `[[#Heading]]`, `![[image.png]]`
 * → standard Markdown links. The target may be empty: a link inside the same note.
 */
function obsidianLinks(md: string): string {
  return md.replace(
    /(!?)\[\[([^\]|#^]*)(?:#(\^?[^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (match: string, bang: string, rawTarget: string, rawAnchor: string | undefined, rawAlias: string | undefined) => {
      const target = rawTarget.trim();
      const anchor = rawAnchor?.trim() ?? '';
      const alias = rawAlias?.trim() ?? '';
      if (!target && !anchor) return match; // `[[]]` and `[[|x]]` are not links
      const isBlockRef = anchor.startsWith('^');
      const hasExt = /\.[a-z0-9]{1,5}$/i.test(target);
      const fragment = anchor ? `#${isBlockRef ? anchor : anchor.replace(/\s+/g, '-').toLowerCase()}` : '';
      const href = target ? `${(hasExt ? target : `${target}.md`).replace(/ /g, '%20')}${fragment}` : fragment;
      const label = alias || (target ? (anchor && !isBlockRef ? `${target} › ${anchor}` : target) : anchor);
      return bang && EMBEDDABLE_EXT.test(target) ? `![${label}](${href})` : `[${label}](${href})`;
    },
  );
}

/** `%%…%%` is Obsidian's "not for readers" comment; it should never reach the index. */
function stripObsidianComments(md: string): string {
  return md.replace(/%%[\s\S]*?%%/g, '');
}

/** `> [!note] Title` → `> **Note:** Title`, so the callout's kind stays a searchable word. */
function obsidianCallouts(md: string): string {
  return md.replace(/^(\s*>\s*)\[!([A-Za-z-]+)\][+-]?[ \t]*/gm, (_m: string, quote: string, kind: string) => {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
    return `${quote}**${label}:** `;
  });
}

/** Notion export links: `[Text](Page%20Name%201a2b…3d.md)` → `[Text](Page%20Name.md)`; keeps external links. */
function notionLinks(md: string): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (m, href: string) => {
    if (/^[a-z]+:/i.test(href)) return m;
    let decoded: string;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      return m;
    }
    const cleaned = decoded
      .split('/')
      .map((s) => s.replace(NOTION_ID_SUFFIX, '').trim() || s)
      .join('/');
    return `](${encodeURI(cleaned)})`;
  });
}

export function transformContent(flavor: Flavor, content: string): string {
  switch (flavor) {
    case 'obsidian':
      return obsidianLinks(obsidianCallouts(stripObsidianComments(content)));
    case 'notion-export':
      return notionLinks(content);
    default:
      return content;
  }
}
