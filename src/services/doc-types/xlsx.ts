/**
 * `.xlsx` → Markdown, one table per visible sheet ([ADR-0115](../../../.ssot/ADR.md#adr-0115)).
 *
 * **A workbook is several documents, and the sheet is the unit.** Each visible sheet becomes
 * `## <sheet name>` followed by the table `csv.ts` would have written for it — header row first,
 * `Column N` for a blank header cell, the header repeated under `### Rows n–m` once a sheet passes
 * {@link ROWS_PER_SECTION} rows — so a table in a spreadsheet and a table in a `.csv` read the same.
 *
 * **Values are what the file already says, and nothing is calculated.** A formula cell carries its last
 * computed result beside the formula; that cached `<v>` is used and the `<f>` is never read, let alone
 * evaluated. A workbook that was never recalculated after a generator wrote it therefore shows what
 * its author saw. Dates arrive as the serial numbers the file stores (reading them as dates needs the
 * style table, which this product does not interpret). Hidden and very-hidden sheets are skipped: a
 * sheet someone hid is, by that act, not part of what the workbook shows.
 *
 * **The output is capped, and the cap is not redundant with the unpacked-size one.** A sheet may
 * declare a cell at column XFD on one row and at A on a million others; "drop empty columns" keeps the
 * table sensible, but a few thousand distinct columns times many rows still renders to far more than
 * the XML that described it. Rendering therefore stops, with a refusal, at `maxFileBytes`.
 */

import { renderRow, ROWS_PER_SECTION } from './csv.js';
import { DocumentExtractionError, type ExtractLimits, titleFromPath, withTitle } from './index.js';
import { documentTitle, parseRelationships, relationshipId, scanXml } from './xml.js';
import { openZip } from './zip.js';

const WORKSHEET_RELATIONSHIP = '/worksheet';
/** Excel's last column (XFD); a reference past it is corrupt and is ignored rather than allocated for. */
const MAX_COLUMN = 16384;

/** `_x000D_` is how a shared string spells a character XML cannot carry. */
function decodeEscapes(value: string): string {
  return value.includes('_x') ? value.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : value;
}

/** `C5` → 2 (zero-based column); `-1` when the reference is not one. */
function columnOf(reference: string | undefined): number {
  if (reference === undefined) return -1;
  const match = /^([A-Za-z]+)\d*$/.exec(reference);
  if (!match) return -1;
  let column = 0;
  for (const ch of match[1].toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
  return column >= 1 && column <= MAX_COLUMN ? column - 1 : -1;
}

function readSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const strings: string[] = [];
  let current: string | null = null;
  let phonetic = 0;
  let inText = false;
  scanXml(xml, {
    open(name) {
      if (name === 'si') current = '';
      else if (name === 'rPh') phonetic++;
      else if (name === 't') inText = true;
    },
    text(value) {
      if (current !== null && inText && phonetic === 0) current += value;
    },
    close(name) {
      if (name === 't') inText = false;
      else if (name === 'rPh') phonetic--;
      else if (name === 'si') {
        strings.push(decodeEscapes(current ?? ''));
        current = null;
      }
    },
  });
  return strings;
}

type Row = Map<number, string>;

/** The non-blank rows of one sheet, each as column → text. Formulas are skipped; cached values are read. */
function readSheet(xml: string, shared: string[]): Row[] {
  const rows: Row[] = [];
  let row: Row | null = null;
  let nextColumn = 0;

  let type = '';
  let column = -1;
  let value = '';
  let inline = '';
  let inCell = false;
  let inValue = false;
  let inInline = false;
  let phonetic = 0;
  let inInlineText = false;

  scanXml(xml, {
    open(name, attrs) {
      switch (name) {
        case 'row':
          row = new Map();
          nextColumn = 0;
          break;
        case 'c': {
          inCell = true;
          type = attrs.t ?? 'n';
          const at = columnOf(attrs.r);
          column = at === -1 ? nextColumn : at;
          nextColumn = column + 1;
          value = '';
          inline = '';
          break;
        }
        case 'v':
          if (inCell) inValue = true;
          break;
        case 'is':
          if (inCell) inInline = true;
          break;
        case 'rPh':
          phonetic++;
          break;
        case 't':
          if (inInline) inInlineText = true;
          break;
        // `<f>` is deliberately absent: its text is the formula, which is never read.
      }
    },
    text(chunk) {
      if (inValue) value += chunk;
      else if (inInlineText && phonetic === 0) inline += chunk;
    },
    close(name) {
      switch (name) {
        case 'v':
          inValue = false;
          break;
        case 't':
          inInlineText = false;
          break;
        case 'rPh':
          phonetic--;
          break;
        case 'is':
          inInline = false;
          break;
        case 'c': {
          inCell = false;
          if (!row) break;
          let text: string;
          if (type === 's') text = shared[Number.parseInt(value, 10)] ?? '';
          else if (type === 'inlineStr') text = decodeEscapes(inline);
          else if (type === 'b') text = value.trim() === '1' ? 'TRUE' : value.trim() === '0' ? 'FALSE' : value;
          else text = value;
          text = text.trim();
          if (text !== '' && column >= 0) row.set(column, text);
          break;
        }
        case 'row':
          if (row && row.size > 0) rows.push(row);
          row = null;
          break;
      }
    },
  });
  return rows;
}

/** Renders one sheet's rows as the csv driver would, or `''` when nothing is left. Throws once `budget` is passed. */
function renderSheet(rows: Row[], budget: { left: number }, tooBig: () => DocumentExtractionError): string {
  if (rows.length === 0) return '';

  // Only the columns some row actually uses, in order: a sheet with data in A and in Z is a two-column table.
  const used = [...new Set(rows.flatMap((r) => [...r.keys()]))].sort((a, b) => a - b);
  const width = used.length;
  const dense = (r: Row): string[] => used.map((c) => r.get(c) ?? '');
  const spend = (line: string): string => {
    budget.left -= line.length + 1;
    if (budget.left < 0) throw tooBig();
    return line;
  };

  const headerRow = dense(rows[0]).map((v, i) => v.trim() || `Column ${i + 1}`);
  const header = spend(renderRow(headerRow, width));
  const divider = `|${' --- |'.repeat(width)}`;
  const body = rows.slice(1);

  const parts: string[] = [];
  for (let start = 0; start < body.length || start === 0; start += ROWS_PER_SECTION) {
    const slice = body.slice(start, start + ROWS_PER_SECTION);
    if (body.length > ROWS_PER_SECTION) parts.push(`### Rows ${start + 1}–${start + slice.length}`);
    parts.push([header, divider, ...slice.map((r) => spend(renderRow(dense(r), width)))].join('\n'));
    if (slice.length === 0) break;
  }
  return parts.join('\n\n');
}

export async function xlsxToMarkdown(bytes: Buffer, relativePath: string, limits: ExtractLimits): Promise<string> {
  const zip = openZip(bytes, relativePath, 'Excel 2007+ workbook', limits);
  const workbook = zip.readText('xl/workbook.xml');
  if (workbook === null) {
    throw new DocumentExtractionError(
      `"${relativePath}" is a zip archive but not an Excel workbook (it has no xl/workbook.xml). A ".xls" file renamed to ".xlsx" stays the old binary format, which is not supported; re-save it as .xlsx.`,
    );
  }

  const relsXml = zip.readText('xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (relsXml !== null) {
    for (const rel of parseRelationships(relsXml, 'xl/workbook.xml')) {
      if (!rel.external && rel.type.endsWith(WORKSHEET_RELATIONSHIP)) targets.set(rel.id, rel.target);
    }
  }

  const sheets: Array<{ name: string; part: string }> = [];
  scanXml(workbook, {
    open(name, attrs) {
      if (name !== 'sheet') return;
      if (attrs.state === 'hidden' || attrs.state === 'veryHidden') return;
      const id = relationshipId(attrs);
      const part = id === undefined ? undefined : targets.get(id);
      if (part !== undefined && zip.has(part)) sheets.push({ name: (attrs.name ?? '').replace(/\s+/g, ' ').trim(), part });
    },
  });

  const shared = readSharedStrings(zip.readText('xl/sharedStrings.xml'));
  const budget = { left: limits.maxFileBytes };
  const tooBig = (): DocumentExtractionError =>
    new DocumentExtractionError(
      `"${relativePath}" renders to more than the ${Math.round(limits.maxFileBytes / (1024 * 1024))} MiB a converted file may be: ` +
        `its sheets use so many columns and rows that the tables are far larger than the file. Remove the unused cells, or raise MAX_CONVERTED_FILE_BYTES if the data is real.`,
    );

  const sections: string[] = [];
  for (const sheet of sheets) {
    const xml = zip.readText(sheet.part);
    if (xml === null) continue;
    const table = renderSheet(readSheet(xml, shared), budget, tooBig);
    if (table === '') continue;
    sections.push(`## ${sheet.name || 'Sheet'}\n\n${table}`);
  }

  const bookTitle = documentTitle(zip.readText('docProps/core.xml')) || titleFromPath(relativePath);
  return withTitle(sections.join('\n\n'), bookTitle);
}
