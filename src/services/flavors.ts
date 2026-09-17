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

/** `[[Page]]`, `[[Page|Alias]]`, `[[Page#Heading]]`, `![[image.png]]` → standard Markdown links. */
function obsidianLinks(md: string): string {
  return md.replace(/(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, bang: string, target: string, heading: string | undefined, alias: string | undefined) => {
    const t = target.trim();
    const label = (alias ?? (heading ? `${t} › ${heading.trim()}` : t)).trim();
    const hasExt = /\.[a-z0-9]{1,5}$/i.test(t);
    const href = (hasExt ? t : `${t}.md`).replace(/ /g, '%20') + (heading ? `#${heading.trim().replace(/ /g, '-').toLowerCase()}` : '');
    return bang ? `![${label}](${href})` : `[${label}](${href})`;
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
      return obsidianLinks(content);
    case 'notion-export':
      return notionLinks(content);
    default:
      return content;
  }
}
