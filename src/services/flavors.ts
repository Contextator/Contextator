/**
 * Source "flavors": small, pure transforms applied to paths (before prefixing) and to content
 * (after hashing, before chunking) so exports from other tools read as ordinary Markdown.
 */

export const FLAVORS = ['plain', 'obsidian', 'notion-export'] as const;
export type Flavor = (typeof FLAVORS)[number];

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
