/**
 * `.rst` → Markdown ([ADR-0115](../../../.ssot/ADR.md#adr-0115)).
 *
 * reStructuredText is what Python documentation is written in, and it is read here the way a person
 * skims it: **the heading hierarchy survives, the prose survives, the markup that only drives a build
 * does not.** Section titles become `#`..`######` — the level is the order in which each adornment style
 * first appears, which is what docutils itself does, so a file that underlines its title with `=` and its
 * sections with `-` reads the same as one that uses `#` and `*`. Literal blocks (`::`) and `code-block`
 * directives become fenced code, admonitions become a bold label on their text, tables become tables.
 * Comments, link targets, substitution definitions, `toctree`, `include`, `image` and `raw` are
 * dropped: they carry no sentence anybody would search for.
 *
 * This is a line scanner and not a docutils port. It reads the constructs above correctly and leaves
 * anything it does not recognise as the text it is, which is the right way to be wrong for retrieval:
 * a construct it does not understand costs some formatting, never a sentence.
 */

import { cell, parseDelimited, renderRow } from './csv.js';
import { decodeUtf8, titleFromPath, withTitle } from './index.js';

/** Past this a directive body is read as flat text: nesting depth is the input's to choose, the stack is not. */
const MAX_DEPTH = 16;

const ADMONITIONS: Record<string, string> = {
  note: 'Note',
  warning: 'Warning',
  tip: 'Tip',
  important: 'Important',
  caution: 'Caution',
  danger: 'Danger',
  attention: 'Attention',
  hint: 'Hint',
  error: 'Error',
  seealso: 'See also',
  versionadded: 'Added in',
  versionchanged: 'Changed in',
  deprecated: 'Deprecated since',
  admonition: '',
};
const VERSIONED = new Set(['versionadded', 'versionchanged', 'deprecated']);
const CODE_DIRECTIVES = new Set(['code-block', 'code', 'sourcecode', 'parsed-literal']);
/** Directives that configure a build and say nothing a reader would search for. */
const DROPPED_DIRECTIVES = new Set([
  'image',
  'toctree',
  'include',
  'contents',
  'raw',
  'index',
  'role',
  'default-role',
  'meta',
  'sectnum',
  'section-numbering',
  'literalinclude',
  'highlight',
  'tabularcolumns',
  'currentmodule',
  'module',
  'automodule',
  'autoclass',
  'autofunction',
  'only',
  'rst-class',
  'title',
]);
/** Sphinx domain objects: the argument is the signature, and a signature is code. */
const OBJECT_DIRECTIVES = new Set([
  'function',
  'class',
  'method',
  'data',
  'attribute',
  'exception',
  'staticmethod',
  'classmethod',
  'decorator',
  'option',
  'cmdoption',
  'envvar',
  'describe',
  'confval',
  'directive',
  'type',
  'macro',
  'member',
  'struct',
]);
const CODE_ROLES = new Set([
  'code',
  'literal',
  'func',
  'function',
  'class',
  'meth',
  'method',
  'mod',
  'module',
  'attr',
  'attribute',
  'data',
  'exc',
  'const',
  'obj',
  'file',
  'samp',
  'envvar',
  'option',
  'command',
  'program',
  'kbd',
  'macro',
  'type',
  'member',
  'path',
]);

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '';
/** One repeated punctuation character, nothing else: the shape of a title adornment or a transition. */
const isAdornment = (line: string): boolean => /^([!-/:-@[-`{-~])\1+\s*$/.test(line);
const SIMPLE_BORDER = /^=+( +=+)+\s*$/;
const DIRECTIVE = /^\.\. +([\w][\w:.+-]*)::(?:\s+(.*))?$/;

/** Roles, literals and hyperlink references, in one pass so that none of them is read inside another. */
function inline(text: string): string {
  return text.replace(
    /``([^`]+)``|:([\w:.+-]+):`([^`]+)`|`([^`<]*)<([^>]+)>`_{1,2}|`([^`]+)`_{1,2}/g,
    (_m, literal?: string, role?: string, roleText?: string, linkText?: string, target?: string, ref?: string) => {
      if (literal !== undefined) return `\`${literal}\``;
      if (role !== undefined && roleText !== undefined) {
        const base = role.split(':').pop() ?? role;
        const labelled = /^(.*?)\s*<([^>]+)>$/.exec(roleText);
        let shown = labelled ? labelled[1] || labelled[2] : roleText;
        if (CODE_ROLES.has(base)) {
          if (shown.startsWith('~')) shown = shown.slice(1).split('.').pop() ?? shown;
          return `\`${shown.replace(/^!/, '')}\``;
        }
        return shown;
      }
      if (target !== undefined) {
        const label = (linkText ?? '').trim();
        return /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i.test(target) ? `[${label || target}](${target})` : label || target;
      }
      return ref ?? '';
    },
  );
}

function dedent(lines: string[]): string[] {
  // A loop, not `Math.min(...)`: the number of lines is the input's to choose, the call stack is not.
  let margin = Number.POSITIVE_INFINITY;
  for (const l of lines) if (!isBlank(l)) margin = Math.min(margin, indentOf(l));
  return Number.isFinite(margin) ? lines.map((l) => (isBlank(l) ? '' : l.slice(margin))) : lines.map(() => '');
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start++;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

function fenced(code: string[], language: string): string[] {
  const body = trimBlankEdges(code);
  let longest = 2;
  for (const line of body) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const marks = '`'.repeat(longest + 1);
  return [marks + language, ...body, marks];
}

/** The lines after `start` that are blank or indented deeper than `base`: the body a directive or literal block owns. */
function takeBlock(lines: string[], start: number, base: number): { body: string[]; next: number } {
  let j = start;
  while (j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) > base)) j++;
  return { body: lines.slice(start, j), next: j };
}

function gridTable(rows: string[]): string[] {
  const out: string[] = [];
  let sawHeaderBorder = false;
  let emittedDivider = false;
  let rowCount = 0;
  let width = 0;
  for (const raw of rows) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|');
      width = cells.length;
      out.push(`| ${cells.map((c) => cell(inline(c))).join(' | ')} |`);
      rowCount++;
    } else if (/^\+[=+:]+\+?$/.test(line) && line.includes('=') && rowCount > 0 && !emittedDivider) {
      out.push(`|${' --- |'.repeat(width)}`);
      emittedDivider = true;
      sawHeaderBorder = true;
    }
  }
  if (!sawHeaderBorder && rowCount > 0) out.splice(1, 0, `|${' --- |'.repeat(width)}`);
  return out;
}

/** A "simple table": column spans come from the `=== ===` border, rows are the lines between borders. */
function simpleTable(lines: string[], start: number): { out: string[]; next: number } | null {
  const borders = [start];
  let end = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (SIMPLE_BORDER.test(lines[j].trim()) && indentOf(lines[j]) === indentOf(lines[start])) {
      borders.push(j);
      if (j + 1 >= lines.length || isBlank(lines[j + 1])) {
        end = j;
        break;
      }
    } else if (isBlank(lines[j]) && borders.length < 2 && isBlank(lines[j - 1])) {
      return null;
    }
  }
  if (end === -1 || borders.length < 2) return null;

  const indent = indentOf(lines[start]);
  const spans = [...lines[start].trim().matchAll(/=+/g)].map((m) => (m.index ?? 0) + indent);
  const split = (line: string): string[] => spans.map((from, k) => line.slice(from, spans[k + 1]).trim());

  const header: string[] = [];
  const body: string[][] = [];
  const headerEnd = borders.length >= 3 ? borders[1] : -1;
  for (let j = start + 1; j < end; j++) {
    if (borders.includes(j) || isBlank(lines[j])) continue;
    const cells = split(lines[j]);
    if (headerEnd !== -1 && j < headerEnd) {
      cells.forEach((c, k) => {
        header[k] = [header[k], c].filter(Boolean).join(' ');
      });
    } else if (cells[0] === '' && body.length > 0) {
      const last = body[body.length - 1];
      cells.forEach((c, k) => {
        last[k] = [last[k], c].filter(Boolean).join(' ');
      });
    } else {
      body.push(cells);
    }
  }
  const head = header.length > 0 ? header : (body.shift() ?? []);
  const width = spans.length;
  const render = (row: string[]): string => renderRow(row.map(inline), width);
  return { out: [render(head), `|${' --- |'.repeat(width)}`, ...body.map(render)], next: end + 1 };
}

function csvTable(body: string[], options: string[]): string[] {
  const rows = parseDelimited(body.join('\n'), ',').filter((r) => r.some((c) => c.trim() !== ''));
  const header = options.find((o) => /^:header:/i.test(o));
  if (header) rows.splice(0, 0, ...parseDelimited(header.replace(/^:header:\s*/i, ''), ','));
  if (rows.length === 0) return [];
  let width = 0;
  for (const r of rows) width = Math.max(width, r.length);
  return [renderRow(rows[0], width), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map((r) => renderRow(r, width))];
}

function convert(lines: string[], levels: string[], depth: number): string[] {
  const out: string[] = [];
  const push = (...items: string[]): void => {
    out.push(...items);
  };
  // For arrays whose length the input chooses: spreading one into a call is bounded by the stack.
  const pushAll = (items: readonly string[]): void => {
    for (const item of items) out.push(item);
  };
  const lastIsBlank = (): boolean => out.length === 0 || isBlank(out[out.length - 1]);
  const blank = (): void => {
    if (!lastIsBlank()) out.push('');
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (indent === 0) {
      // Title with an overline: adornment, text, adornment.
      if (
        isAdornment(trimmed) &&
        i + 2 < lines.length &&
        !isBlank(lines[i + 1]) &&
        isAdornment(lines[i + 2].trim()) &&
        lines[i + 2].trim()[0] === trimmed[0]
      ) {
        const text = lines[i + 1].trim();
        const key = `o${trimmed[0]}`;
        if (!levels.includes(key)) levels.push(key);
        blank();
        push(`${'#'.repeat(Math.min(levels.indexOf(key) + 1, 6))} ${inline(text)}`, '');
        i += 3;
        continue;
      }
      // Title with an underline.
      if (!isAdornment(trimmed) && i + 1 < lines.length) {
        const under = lines[i + 1].trim();
        if (isAdornment(under) && indentOf(lines[i + 1]) === 0 && under.length >= Math.min(trimmed.length, 4) && !/^\.\. /.test(trimmed)) {
          const key = `u${under[0]}`;
          if (!levels.includes(key)) levels.push(key);
          blank();
          push(`${'#'.repeat(Math.min(levels.indexOf(key) + 1, 6))} ${inline(trimmed)}`, '');
          i += 2;
          continue;
        }
      }
      // Transition.
      if (isAdornment(trimmed) && trimmed.length >= 4 && (i + 1 >= lines.length || isBlank(lines[i + 1]))) {
        blank();
        push('---', '');
        i++;
        continue;
      }
      if (SIMPLE_BORDER.test(trimmed)) {
        const table = simpleTable(lines, i);
        if (table) {
          blank();
          pushAll(table.out);
          push('');
          i = table.next;
          continue;
        }
      }
      if (trimmed.startsWith('+') && /^\+[-=+:]+\+?$/.test(trimmed)) {
        let j = i;
        while (j < lines.length && /^[+|]/.test(lines[j].trim()) && indentOf(lines[j]) === 0) j++;
        blank();
        pushAll(gridTable(lines.slice(i, j)));
        push('');
        i = j;
        continue;
      }
    }

    // Comments, targets, substitution definitions, footnotes and directives all start with `.. `.
    if (trimmed === '..' || trimmed.startsWith('.. ')) {
      const { body: rawBody, next } = takeBlock(lines, i + 1, indent);
      const directive = DIRECTIVE.exec(trimmed);
      const footnote = /^\.\. +\[([^\]]+)\]\s*(.*)$/.exec(trimmed);
      i = next;
      if (footnote) {
        blank();
        push(inline(`[${footnote[1]}] ${[footnote[2], ...rawBody.map((l) => l.trim())].join(' ').trim()}`.trim()), '');
        continue;
      }
      if (!directive) continue; // comment, `.. _target:`, `.. |sub| replace::`

      const name = directive[1].toLowerCase();
      const base = name.includes(':') ? (name.split(':').pop() ?? name) : name;
      const arg = (directive[2] ?? '').trim();
      const options: string[] = [];
      const body = dedent(rawBody);
      while (body.length > 0 && /^:[\w-]+:/.test(body[0].trim())) options.push((body.shift() as string).trim());
      // For a plain admonition the text after `::` is the first line of its content, not an argument.
      const argIsContent = base in ADMONITIONS && base !== 'admonition' && !VERSIONED.has(base) && arg !== '';
      const content = trimBlankEdges(argIsContent ? [arg, ...body] : body);

      if (DROPPED_DIRECTIVES.has(base)) continue;
      if (CODE_DIRECTIVES.has(base)) {
        blank();
        pushAll(fenced(content, base === 'parsed-literal' ? '' : arg.split(/\s+/)[0].toLowerCase()));
        push('');
        continue;
      }
      if (base === 'csv-table') {
        const table = csvTable(content, options);
        if (table.length > 0) {
          blank();
          pushAll(table);
          push('');
        }
        continue;
      }
      const inner = depth < MAX_DEPTH ? convert(content, levels, depth + 1) : content.map((l) => inline(l.trim()));
      if (base in ADMONITIONS) {
        const label = base === 'admonition' ? inline(arg) : ADMONITIONS[base];
        const head = `**${VERSIONED.has(base) && arg ? `${label} ${arg}` : label}:**`;
        blank();
        const firstText = inner.findIndex((l) => !isBlank(l));
        if (firstText === -1) push(head);
        else {
          pushAll(inner.slice(0, firstText));
          push(`${head} ${inner[firstText]}`);
          pushAll(inner.slice(firstText + 1));
        }
        push('');
        continue;
      }
      blank();
      if (OBJECT_DIRECTIVES.has(base) && arg) push(`\`${arg}\``, '');
      else if (base !== 'figure' && arg) push(inline(arg), '');
      pushAll(inner);
      push('');
      continue;
    }

    // A paragraph: lines up to the next blank. A trailing `::` means an indented literal block follows.
    const para: string[] = [];
    let j = i;
    while (j < lines.length && !isBlank(lines[j])) para.push(lines[j++]);
    i = j;

    if (para[0].trim().startsWith('>>>')) {
      blank();
      pushAll(
        fenced(
          para.map((l) => l.trim()),
          'python',
        ),
      );
      push('');
      continue;
    }

    let literal = false;
    const lastLine = para[para.length - 1].trimEnd();
    if (lastLine.endsWith('::')) {
      literal = true;
      if (lastLine.trim() === '::') para.pop();
      else if (lastLine.endsWith(' ::')) para[para.length - 1] = lastLine.slice(0, -3);
      else para[para.length - 1] = `${lastLine.slice(0, -2)}:`;
    }
    if (para.length > 0) {
      blank();
      for (const raw of para) {
        let text = inline(raw.trim()).replace(/^(\s*)#\.(\s)/, '$11.$2');
        // A line that begins `# ` would become a heading in Markdown; it was prose in the source.
        if (/^#{1,6}\s/.test(text)) text = `\\${text}`;
        if (/^\|\s/.test(text)) text = `\\${text}`;
        push(text);
      }
      push('');
    }
    if (literal) {
      const { body, next } = takeBlock(lines, i, indent);
      const code = trimBlankEdges(body);
      if (code.length > 0) {
        blank();
        pushAll(fenced(dedent(code), ''));
        push('');
        i = next;
      }
    }
  }
  return out;
}

export async function rstToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
  const lines = decodeUtf8(bytes)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, '        ').trimEnd());
  const markdown = convert(lines, [], 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return withTitle(markdown, titleFromPath(relativePath));
}
