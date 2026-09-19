/**
 * `.csv` → a Markdown table ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
 *
 * **A table and not a row dump, because a row dump loses the question the file answers.** `Ada,
 * Engineer, 2019` is three values; `| Name | Role | Joined |` above it is what makes them mean
 * anything, and an agent reading the document through `read_document` has nothing else to go on. The
 * header therefore has to survive into the text, and in a long file it has to survive more than once —
 * hence the sectioning below.
 *
 * The parser is written here rather than taken from a package. It is RFC 4180 with a delimiter sniff,
 * which is about sixty lines and has one behaviour worth arguing about (the sniff); a dependency would
 * be sixty lines of someone else's plus a transitive tree, for a format whose grammar fits in this
 * comment. Every quoting rule it implements is pinned by a test.
 */

import { decodeUtf8, titleFromPath, withTitle } from './index.js';

/** Sniffed in this order on ties, so a comma wins an ambiguous file. */
const DELIMITERS = [',', ';', '\t', '|'];

/** How much of the file the sniff looks at. One long line is still one line. */
const SNIFF_BYTES = 8192;

/**
 * Data rows per section. Past this the table is cut into `## Rows n–m` sections with the header
 * repeated, which is not cosmetic: `CHUNK_MAX_TOKENS` is small, a thousand-row table becomes hundreds
 * of chunks, and a chunk of bare rows with no breadcrumb naming its columns is a chunk that retrieves
 * for nothing and reads as nothing. The section heading is what `chunkMarkdown` puts in `heading_path`.
 */
const ROWS_PER_SECTION = 200;

/**
 * RFC 4180, with CRLF normalised inside quoted fields as well as outside.
 *
 * A quote only opens a field at its start (`a"b"c` is the literal `a"b"c`, which is what spreadsheets
 * write and read back); `""` inside a quoted field is an escaped quote.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
        continue;
      }
      if (ch === '\r') {
        field += '\n';
        if (text[i + 1] === '\n') i++;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Which delimiter the file uses, decided on its first line with quoting respected — a `;` inside
 * `"Smith; Ada"` is not a delimiter and counting it as one would split every row of the file wrongly.
 * Whichever candidate yields the most fields wins; a single-column file yields one field for all four
 * and gets the comma, which parses it identically.
 */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, SNIFF_BYTES);
  let best = DELIMITERS[0];
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const first = parseDelimited(head, delimiter)[0];
    const count = first ? first.length : 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** `|` ends a cell in GFM and a newline ends the row, so both have to stop being themselves. */
function cell(value: string): string {
  const text = value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').replace(/\s+/g, ' ').trim();
  return text === '' ? ' ' : text;
}

function renderRow(values: string[], width: number): string {
  const padded = Array.from({ length: width }, (_, i) => cell(values[i] ?? ''));
  return `| ${padded.join(' | ')} |`;
}

export async function csvToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
  const text = decodeUtf8(bytes);
  const rows = parseDelimited(text, sniffDelimiter(text)).filter((row) => row.some((value) => value.trim() !== ''));
  if (rows.length === 0) return withTitle('', titleFromPath(relativePath));

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  // A column the export left unnamed — a trailing comma, or a header shorter than its rows — is named
  // after its position. An empty header cell would otherwise be a column whose values have no label.
  const headerRow = Array.from({ length: width }, (_, i) => (rows[0][i] ?? '').trim() || `Column ${i + 1}`);
  const header = renderRow(headerRow, width);
  const divider = `|${' --- |'.repeat(width)}`;
  const body = rows.slice(1);

  const parts: string[] = [`# ${titleFromPath(relativePath)}`];
  for (let start = 0; start < body.length || start === 0; start += ROWS_PER_SECTION) {
    const slice = body.slice(start, start + ROWS_PER_SECTION);
    if (body.length > ROWS_PER_SECTION) parts.push(`## Rows ${start + 1}–${start + slice.length}`);
    parts.push([header, divider, ...slice.map((row) => renderRow(row, width))].join('\n'));
    if (slice.length === 0) break;
  }
  return withTitle(parts.join('\n\n'), titleFromPath(relativePath));
}
