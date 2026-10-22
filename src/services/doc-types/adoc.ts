/**
 * `.adoc` → Markdown ([ADR-0115](../../../.ssot/ADR.md#adr-0115)).
 *
 * AsciiDoc is closer to Markdown than reStructuredText is, and the conversion keeps what a reader
 * would: headings (`= Title` is `#`, `==` is `##`), paragraphs, lists, listing and literal blocks as
 * fenced code with the `[source,lang]` language, `|===` tables as tables, admonitions (`NOTE:` and
 * `[NOTE]`) as a bold label, links, and the inline emphasis marks. What it drops is what drives a
 * toolchain and says nothing: comments, attribute entries (their values are substituted where `{name}`
 * appears), `include::`, `toc::`, conditionals, anchors, passthrough blocks and block attributes.
 *
 * It is a line scanner and not Asciidoctor. A construct it does not know stays as the text it was.
 */

import { renderRow } from './csv.js';
import { decodeUtf8, titleFromPath, withTitle } from './index.js';

/** Past this a nested block is read as flat text: nesting depth is the input's to choose, the stack is not. */
const MAX_DEPTH = 16;

const ADMONITIONS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
const PREDEFINED: Record<string, string> = { nbsp: ' ', empty: '', plus: '+', startsb: '[', endsb: ']', lt: '<', gt: '>', amp: '&', vbar: '|' };

interface Context {
  attrs: Map<string, string>;
}

const isBlank = (line: string): boolean => line.trim() === '';

function substitute(text: string, ctx: Context): string {
  return text.replace(/\{([\w-]+)\}/g, (whole, key: string) => ctx.attrs.get(key) ?? PREDEFINED[key] ?? whole);
}

function inline(raw: string, ctx: Context): string {
  let text = substitute(raw, ctx);
  // Macros first, while their brackets are still intact.
  text = text
    .replace(/footnote:\w*\[([^\]]*)\]/g, ' ($1)')
    .replace(/kbd:\[([^\]]*)\]/g, '$1')
    .replace(/btn:\[([^\]]*)\]/g, '$1')
    .replace(/menu:([^[\s]+)\[([^\]]*)\]/g, (_m, menu: string, items: string) =>
      [menu, ...items.split('>').map((s) => s.trim())].filter(Boolean).join(' > '),
    )
    .replace(/image::?[^\s[]+\[([^\]]*)\]/g, (_m, alt: string) => alt.split(',')[0].trim())
    .replace(/xref:([^[\s]+)\[([^\]]*)\]/g, (_m, target: string, label: string) => label || target.replace(/^.*#/, '').replace(/\.adoc$/, ''))
    .replace(/<<([^,>]+)(?:,([^>]*))?>>/g, (_m, id: string, label?: string) => (label ?? id).trim())
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/(?:link:)?((?:https?|ftp|mailto):[^\s[]+|link:[^\s[]+)\[([^\]]*)\]/g, (_m, url: string, label: string) => {
      const target = url.replace(/^link:/, '');
      return `[${label.split(',')[0].trim() || target}](${target})`;
    });
  // Inline marks. Constrained `*bold*` is Markdown's `**bold**`; `_x_` and `` `x` `` are already Markdown.
  text = text
    .replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*(?![\w*])/g, '$1**$2**')
    .replace(/`\+([^+]+)\+`/g, '`$1`')
    .replace(/(^|[\s(])\+([^\s+](?:[^+]*[^\s+])?)\+(?=[\s.,;:)]|$)/g, '$1`$2`');
  return text;
}

function fenced(code: string[], language: string): string[] {
  let end = code.length;
  while (end > 0 && isBlank(code[end - 1])) end--;
  let start = 0;
  while (start < end && isBlank(code[start])) start++;
  const body = code.slice(start, end);
  let longest = 2;
  for (const line of body) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const marks = '`'.repeat(longest + 1);
  return [marks + language, ...body, marks];
}

/** A `|===` table as GFM. The first row is the header: Markdown tables need one, and AsciiDoc's implicit header is that row too. */
function table(inner: string[], colsAttr: string | undefined, ctx: Context): string[] {
  const firstLine = inner.find((l) => !isBlank(l)) ?? '';
  const text = inner.join('\n');
  const parts = text.split(/(?<!\\)\|/);
  parts.shift(); // whatever precedes the first `|`
  const cells = parts.map((part, k) => {
    const value = k < parts.length - 1 ? part.replace(/\s*\d+[+*]$/, '') : part;
    return inline(value.trim().replace(/\\\|/g, '|').replace(/\s+/g, ' '), ctx);
  });

  let width = 0;
  if (colsAttr) {
    const fields = colsAttr
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    width = fields.reduce((sum, f) => {
      const repeat = /^(\d+)\*/.exec(f);
      return sum + (repeat ? Number.parseInt(repeat[1], 10) : 1);
    }, 0);
  }
  if (width === 0) width = Math.max(1, (firstLine.match(/(?<!\\)\|/g) ?? []).length);
  width = Math.min(width, 64);

  const rows: string[][] = [];
  for (let k = 0; k < cells.length; k += width) rows.push(cells.slice(k, k + width));
  if (rows.length === 0) return [];
  return [renderRow(rows[0], width), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map((r) => renderRow(r, width))];
}

interface Pending {
  style: string;
  language: string;
  cols: string | undefined;
}

function convert(lines: string[], ctx: Context, depth: number): string[] {
  const out: string[] = [];
  const push = (...items: string[]): void => {
    out.push(...items);
  };
  const blank = (): void => {
    if (out.length > 0 && !isBlank(out[out.length - 1])) out.push('');
  };

  let pending: Pending = { style: '', language: '', cols: undefined };
  const clear = (): void => {
    pending = { style: '', language: '', cols: undefined };
  };
  let sawTitle = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      i++;
      continue;
    }

    // Delimited blocks: the closing line is the same delimiter, and an unclosed block runs to the end.
    const delimiter = /^(?:-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\+{4,}|\/{4,}|--|\|={3,})$/.exec(trimmed);
    if (delimiter) {
      let close = i + 1;
      while (close < lines.length && lines[close].trim() !== trimmed) close++;
      const inner = lines.slice(i + 1, close);
      i = close + 1;
      const kind = trimmed[0];
      if (kind === '/' || kind === '+') {
        clear();
        continue;
      }
      blank();
      if (kind === '-' && trimmed.length >= 4) push(...fenced(inner, pending.language), '');
      else if (kind === '.') push(...fenced(inner, ''), '');
      else if (kind === '|') push(...table(inner, pending.cols, ctx), '');
      else {
        const nested = depth < MAX_DEPTH ? convert(inner, ctx, depth + 1) : inner.map((l) => inline(l.trim(), ctx));
        const label = ADMONITIONS[pending.style.toUpperCase()];
        if (label) {
          const first = nested.findIndex((l) => !isBlank(l));
          if (first === -1) push(`**${label}:**`);
          else push(...nested.slice(0, first), `**${label}:** ${nested[first]}`, ...nested.slice(first + 1));
        } else if (kind === '_' || pending.style === 'quote') {
          push(...nested.map((l) => (isBlank(l) ? '>' : `> ${l}`)));
        } else {
          push(...nested);
        }
        push('');
      }
      clear();
      continue;
    }

    // Single-line comment (but not the `////` block handled above).
    if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
      i++;
      continue;
    }

    // Attribute entry: `:name: value`, `:name!:` or `:!name:`.
    const entry = /^:(!?)([\w-]+?)(!?):(?:\s+(.*))?$/.exec(trimmed);
    if (entry) {
      const name = entry[2];
      if (entry[1] === '!' || entry[3] === '!') ctx.attrs.delete(name);
      else ctx.attrs.set(name, substitute((entry[4] ?? '').trim(), ctx));
      i++;
      continue;
    }

    // Preprocessor and macros that carry no text of their own.
    if (/^(?:include|toc|ifdef|ifndef|ifeval|endif|video|audio)::.*\[.*\]$/.test(trimmed) || trimmed === '<<<') {
      i++;
      continue;
    }
    if (/^'{3,}$/.test(trimmed)) {
      blank();
      push('---', '');
      i++;
      continue;
    }

    // Block attribute line: `[source,python]`, `[NOTE]`, `[cols="1,2"]`, `[[anchor]]`.
    const attributes = /^\[(.*)\]$/.exec(trimmed);
    if (attributes && !/^\[\[/.test(trimmed)) {
      const fields = attributes[1].split(',').map((f) => f.trim());
      const cols = /cols\s*=\s*(?:"([^"]*)"|([^,\]]+))/.exec(attributes[1]);
      const style = fields[0].replace(/[#.%].*$/, '');
      const language = style === 'source' ? (fields[1] ?? '') : style === '' && /^[\w+#-]+$/.test(fields[1] ?? '') ? fields[1] : '';
      pending = { style: /=/.test(style) ? '' : style, language: language.toLowerCase(), cols: cols ? (cols[1] ?? cols[2]) : pending.cols };
      i++;
      continue;
    }
    if (/^\[\[.*\]\]$/.test(trimmed)) {
      i++;
      continue;
    }

    // Block title: `.Title` (not `. item` and not `..`).
    const blockTitle = /^\.([^\s.].*)$/.exec(trimmed);
    if (blockTitle) {
      blank();
      push(`**${inline(blockTitle[1].trim(), ctx)}**`, '');
      i++;
      continue;
    }

    // Section title.
    const heading = /^(={1,6}|#{1,6}) +(\S.*?)(?: +\1)?$/.exec(trimmed);
    if (heading) {
      blank();
      push(`${'#'.repeat(heading[1].length)} ${inline(heading[2], ctx)}`, '');
      i++;
      // The author and revision lines under a document title are metadata, and are not prose.
      if (!sawTitle && heading[1] === '=') {
        let skipped = 0;
        while (skipped < 2 && i < lines.length && !isBlank(lines[i]) && !lines[i].trim().startsWith(':')) {
          i++;
          skipped++;
        }
      }
      sawTitle = true;
      clear();
      continue;
    }

    // List continuation marker.
    if (trimmed === '+') {
      i++;
      continue;
    }

    // Admonition paragraph: `NOTE: text`.
    const admonition = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+(.*)$/.exec(trimmed);
    if (admonition) {
      blank();
      push(`**${ADMONITIONS[admonition[1]]}:** ${inline(admonition[2], ctx)}`);
      i++;
      clear();
      continue;
    }

    // Lists.
    const bullet = /^(\*{1,6}|-)\s+(.*)$/.exec(trimmed);
    if (bullet) {
      const level = bullet[1] === '-' ? 1 : bullet[1].length;
      push(`${'  '.repeat(level - 1)}- ${inline(bullet[2], ctx)}`);
      i++;
      continue;
    }
    const numbered = /^(\.{1,6})\s+(.*)$/.exec(trimmed);
    if (numbered) {
      push(`${'   '.repeat(numbered[1].length - 1)}1. ${inline(numbered[2], ctx)}`);
      i++;
      continue;
    }
    const term = /^([^\s].*?)(?:::{1,3}|;;)(?:\s+(.*))?$/.exec(trimmed);
    if (term && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      blank();
      push(`**${inline(term[1], ctx)}**:${term[2] ? ` ${inline(term[2], ctx)}` : ''}`);
      i++;
      continue;
    }

    // An indented paragraph after a blank line is a literal block.
    if (/^\s/.test(line) && (i === 0 || isBlank(lines[i - 1]))) {
      let j = i;
      while (j < lines.length && /^\s/.test(lines[j]) && !isBlank(lines[j])) j++;
      const block = lines.slice(i, j);
      const margin = Math.min(...block.map((l) => l.length - l.trimStart().length));
      blank();
      push(
        ...fenced(
          block.map((l) => l.slice(margin)),
          '',
        ),
        '',
      );
      i = j;
      continue;
    }

    // A paragraph: lines to the next blank, carrying the pending style ([NOTE], [quote]) if there is one.
    const para: string[] = [];
    let j = i;
    while (j < lines.length && !isBlank(lines[j]) && !(j > i && /^(?:[*-]+|\.+)\s/.test(lines[j].trim()))) para.push(lines[j++]);
    i = j;
    const text = para.map((l) => inline(l.trim(), ctx));
    blank();
    const label = ADMONITIONS[pending.style.toUpperCase()];
    if (label) text[0] = `**${label}:** ${text[0]}`;
    if (pending.style === 'quote') push(...text.map((l) => `> ${l}`));
    else push(...text);
    push('');
    clear();
  }
  return out;
}

export async function adocToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
  const lines = decodeUtf8(bytes)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());
  const markdown = convert(lines, { attrs: new Map() }, 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return withTitle(markdown, titleFromPath(relativePath));
}
