/**
 * Minimal Notion block → Markdown renderer (pure; no network). Covers the block types documentation
 * pages use. Anything unknown is skipped rather than failing the whole page.
 */

export interface RichText {
  plain_text?: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean };
  type?: string;
  equation?: { expression?: string };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  /** Children already fetched by the caller (rendering is offline). */
  children?: NotionBlock[];
  [key: string]: unknown;
}

export function renderRichText(parts: RichText[] | undefined): string {
  if (!parts) return '';
  return parts
    .map((t) => {
      if (t.type === 'equation' && t.equation?.expression) return `$${t.equation.expression}$`;
      let s = t.plain_text ?? '';
      if (!s) return '';
      const a = t.annotations ?? {};
      if (a.code) s = `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join('');
}

type Payload = { rich_text?: RichText[]; caption?: RichText[]; language?: string; checked?: boolean; icon?: { emoji?: string }; url?: string; external?: { url?: string }; file?: { url?: string }; expression?: string; title?: string; cells?: RichText[][]; has_column_header?: boolean; name?: string };

function payload(block: NotionBlock): Payload {
  return (block[block.type] as Payload | undefined) ?? {};
}

function fileUrl(p: Payload): string {
  return p.external?.url ?? p.file?.url ?? p.url ?? '';
}

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n');
}

/** Renders a list of sibling blocks; `numbered` counters restart per list run. */
export function renderBlocks(blocks: NotionBlock[]): string {
  const out: string[] = [];
  let numbered = 0;
  for (const block of blocks) {
    if (block.type !== 'numbered_list_item') numbered = 0;
    const md = renderBlock(block, () => ++numbered);
    if (md !== null) out.push(md);
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n');
}

function childrenMd(block: NotionBlock): string {
  return block.children?.length ? renderBlocks(block.children) : '';
}

function listItem(marker: string, block: NotionBlock, text: string): string {
  const kids = childrenMd(block);
  return `${marker} ${text}${kids ? `\n${indent(kids)}` : ''}`;
}

export function renderBlock(block: NotionBlock, nextNumber: () => number): string | null {
  const p = payload(block);
  const text = renderRichText(p.rich_text);
  switch (block.type) {
    case 'paragraph':
      return text + (childrenMd(block) ? `\n\n${childrenMd(block)}` : '');
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      // A toggleable heading owns the blocks folded under it; dropping them loses the whole section.
      const kids = childrenMd(block);
      return `${'#'.repeat(Number(block.type.slice(-1)))} ${text}${kids ? `\n\n${kids}` : ''}`;
    }
    case 'bulleted_list_item':
      return listItem('-', block, text);
    case 'numbered_list_item':
      return listItem(`${nextNumber()}.`, block, text);
    case 'to_do':
      return listItem(p.checked ? '- [x]' : '- [ ]', block, text);
    case 'toggle': {
      const kids = childrenMd(block);
      return `**${text}**${kids ? `\n\n${kids}` : ''}`;
    }
    case 'quote': {
      const kids = childrenMd(block);
      return `${text}${kids ? `\n\n${kids}` : ''}`
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    }
    case 'callout': {
      const icon = p.icon?.emoji ? `${p.icon.emoji} ` : '';
      const kids = childrenMd(block);
      return `> ${icon}${text}${kids ? `\n>\n${indent(kids, '> ')}` : ''}`;
    }
    case 'code':
      return `\`\`\`${p.language && p.language !== 'plain text' ? p.language : ''}\n${(p.rich_text ?? []).map((t) => t.plain_text ?? '').join('')}\n\`\`\``;
    case 'divider':
      return '---';
    case 'equation':
      return p.expression ? `$$\n${p.expression}\n$$` : null;
    case 'bookmark':
    case 'link_preview':
    case 'embed': {
      const url = p.url ?? '';
      const caption = renderRichText(p.caption);
      return url ? `[${caption || url}](${url})` : null;
    }
    case 'image': {
      const url = fileUrl(p);
      return url ? `![${renderRichText(p.caption) || 'image'}](${url})` : null;
    }
    case 'file':
    case 'pdf':
    case 'video':
    case 'audio': {
      const url = fileUrl(p);
      return url ? `[${p.name || renderRichText(p.caption) || block.type}](${url})` : null;
    }
    case 'child_page':
      return `→ ${p.title ?? 'Untitled page'}`;
    case 'child_database':
      return `→ Database: ${p.title ?? 'Untitled'}`;
    case 'table': {
      const rows = (block.children ?? []).filter((r) => r.type === 'table_row').map((r) => (payload(r).cells ?? []).map((c) => renderRichText(c).replace(/\|/g, '\\|')));
      if (rows.length === 0) return null;
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
      const header = p.has_column_header ? pad(rows[0]) : Array(width).fill('');
      const body = p.has_column_header ? rows.slice(1) : rows;
      return [`| ${header.join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
    }
    case 'column_list':
    case 'column':
    case 'synced_block':
      return childrenMd(block) || null;
    case 'table_of_contents':
    case 'breadcrumb':
    case 'template':
    case 'unsupported':
    default:
      return null;
  }
}

/** Title of a page object (`properties.<title property>.title`). */
export function pageTitle(page: { properties?: Record<string, { type?: string; title?: RichText[] }> }): string {
  const props = page.properties ?? {};
  for (const prop of Object.values(props)) {
    if (prop?.type === 'title') return (prop.title ?? []).map((t) => t.plain_text ?? '').join('').trim();
  }
  return '';
}

/** File-system-friendly stem for a page: `<slug>--<first 8 id chars>`. */
export function pageFileStem(title: string, id: string): string {
  const slug = title
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i') // dotless/dotted i do not decompose under NFKD
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'untitled'}--${id.replace(/-/g, '').slice(0, 8)}`;
}

export function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}
