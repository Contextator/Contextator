/**
 * `.pptx` → Markdown, one section per slide ([ADR-0115](../../../.ssot/ADR.md#adr-0115)).
 *
 * **A slide is the unit a person remembers a deck by, so it is the unit of the output.** Each slide
 * becomes `## Slide N: <title>` — the title placeholder's text, which is what `chunkMarkdown` then
 * carries into `heading_path` — followed by its body text and, as a final line starting `Notes:`, the
 * speaker notes. Notes are often where a deck's actual content is (the slides are prompts, the notes
 * are the argument), and putting them under their slide keeps each claim next to the thing it explains.
 *
 * Only text is read: placeholders and text boxes (paragraphs, with bullet levels kept) and tables
 * (as GFM rows). Pictures, charts and SmartArt carry no text this product can read and are skipped;
 * footer, date and slide-number placeholders are dropped because they repeat on every slide and would
 * make every section look alike to a search. Slide order is the presentation's own (`sldIdLst`), not
 * the order of the files in the zip.
 */

import { type OutputBudget, outputBudget } from './budget.js';
import { DocumentExtractionError, type ExtractLimits, titleFromPath, withTitle } from './index.js';
import { documentTitle, parseRelationships, relationshipId, relsPathFor, scanXml } from './xml.js';
import { openZip, type ZipArchive } from './zip.js';

const NOTES_RELATIONSHIP = '/notesSlide';
const SLIDE_RELATIONSHIP = '/slide';
/** Placeholders that repeat on every slide and say nothing about it. */
const BOILERPLATE_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

interface Paragraph {
  text: string;
  level: number;
  bullet: boolean;
}

type Item = { kind: 'shape'; placeholder: string | undefined; isPlaceholder: boolean; paragraphs: Paragraph[] } | { kind: 'table'; rows: string[][] };

/** The text-bearing shapes and tables of one slide or notes part, in document order. */
function readItems(xml: string): Item[] {
  const items: Item[] = [];

  let shape: { placeholder: string | undefined; isPlaceholder: boolean; paragraphs: Paragraph[] } | null = null;
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string[] | null = null;

  let paragraph: { text: string; level: number; bullet: boolean; bulletNone: boolean } | null = null;
  let inText = false;

  scanXml(xml, {
    open(name, attrs) {
      switch (name) {
        case 'sp':
          shape = { placeholder: undefined, isPlaceholder: false, paragraphs: [] };
          break;
        case 'ph':
          if (shape) {
            shape.isPlaceholder = true;
            shape.placeholder = attrs.type;
          }
          break;
        case 'tbl':
          table = [];
          break;
        case 'tr':
          if (table) row = [];
          break;
        case 'tc':
          if (row) cell = [];
          break;
        case 'p':
          paragraph = { text: '', level: 0, bullet: false, bulletNone: false };
          break;
        case 'pPr':
          if (paragraph) paragraph.level = Number.parseInt(attrs.lvl ?? '0', 10) || 0;
          break;
        case 'buChar':
        case 'buAutoNum':
          if (paragraph) paragraph.bullet = true;
          break;
        case 'buNone':
          if (paragraph) paragraph.bulletNone = true;
          break;
        case 'br':
          if (paragraph) paragraph.text += ' ';
          break;
        case 't':
          inText = true;
          break;
      }
    },
    text(value) {
      if (inText && paragraph) paragraph.text += value;
    },
    close(name) {
      switch (name) {
        case 't':
          inText = false;
          break;
        case 'p': {
          if (!paragraph) break;
          const text = paragraph.text.replace(/\s+/g, ' ').trim();
          if (text !== '') {
            if (cell) cell.push(text);
            else if (shape) {
              // A body-like placeholder inherits its bullets from the layout; a text box has them only
              // when the paragraph says so. Either way an explicit `buNone` wins.
              const inherited = shape.isPlaceholder && (shape.placeholder === undefined || shape.placeholder === 'body');
              shape.paragraphs.push({
                text,
                level: paragraph.level,
                bullet: !paragraph.bulletNone && (paragraph.bullet || paragraph.level > 0 || inherited),
              });
            }
          }
          paragraph = null;
          break;
        }
        case 'tc':
          if (row && cell) row.push(cell.join(' '));
          cell = null;
          break;
        case 'tr':
          if (table && row) table.push(row);
          row = null;
          break;
        case 'tbl':
          if (table && table.length > 0) items.push({ kind: 'table', rows: table });
          table = null;
          break;
        case 'sp':
          if (shape) items.push({ kind: 'shape', ...shape });
          shape = null;
          break;
      }
    },
  });
  return items;
}

/**
 * A line of prose must not turn into a heading by starting with `#`, nor a table row by starting with `|`,
 * nor open a code fence with ``` or ~~~: the chunker follows fences, and an unclosed one swallows every
 * later `## Slide N` heading into a code block.
 */
function plain(text: string): string {
  return text.replace(/^([#|>]|`{3}|~{3})/, '\\$1');
}

function cellText(value: string): string {
  const text = value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return text === '' ? ' ' : text;
}

/**
 * Every row is padded to the widest one, so a table costs `width × rows` whatever the cells hold: one
 * wide row and a few thousand narrow ones is megabytes from a kilobyte of XML. Each line is therefore
 * paid for out of `budget` — and reserved *before* it is built, because a single row can itself be
 * wider than the whole budget.
 */
function renderTable(rows: string[][], budget: OutputBudget): string {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  // The least a row can take: `| ` + one character per cell + ` | ` between them + ` |`.
  const floor = 4 * width + 1;
  const line = (r: string[]): string => {
    budget.reserve(floor);
    const text = `| ${Array.from({ length: width }, (_, i) => cellText(r[i] ?? '')).join(' | ')} |`;
    budget.spend(text.length + 1);
    return text;
  };
  const header = line(rows[0]);
  const divider = `|${' --- |'.repeat(width)}`;
  budget.spend(divider.length + 1);
  return [header, divider, ...rows.slice(1).map(line)].join('\n');
}

function renderBody(items: Item[], budget: OutputBudget): string[] {
  const blocks: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length > 0) blocks.push(list.join('\n'));
    list = [];
  };
  for (const item of items) {
    if (item.kind === 'table') {
      flush();
      blocks.push(renderTable(item.rows, budget));
      continue;
    }
    if (
      item.isPlaceholder &&
      item.placeholder !== undefined &&
      (TITLE_PLACEHOLDERS.has(item.placeholder) || BOILERPLATE_PLACEHOLDERS.has(item.placeholder))
    )
      continue;
    for (const p of item.paragraphs) {
      if (p.bullet) list.push(`${'  '.repeat(Math.min(p.level, 6))}- ${plain(p.text)}`);
      else {
        flush();
        blocks.push(plain(p.text));
      }
    }
    flush();
  }
  return blocks;
}

function slideTitle(items: Item[]): string {
  for (const item of items) {
    if (item.kind === 'shape' && item.placeholder !== undefined && TITLE_PLACEHOLDERS.has(item.placeholder)) {
      return item.paragraphs.map((p) => p.text).join(' ');
    }
  }
  return '';
}

/** The speaker notes of a slide: the notes page's body placeholder, not the slide thumbnail or the page number. */
function readNotes(zip: ZipArchive, slidePart: string): string {
  const rels = zip.readText(relsPathFor(slidePart));
  if (rels === null) return '';
  const link = parseRelationships(rels, slidePart).find((r) => !r.external && r.type.endsWith(NOTES_RELATIONSHIP));
  if (!link) return '';
  const xml = zip.readText(link.target);
  if (xml === null) return '';
  return readItems(xml)
    .filter((item): item is Extract<Item, { kind: 'shape' }> => item.kind === 'shape' && item.placeholder === 'body')
    .flatMap((item) => item.paragraphs.map((p) => p.text))
    .join(' ');
}

/** Slide parts in presentation order, falling back to the file numbering when the presentation is not readable. */
function slideParts(zip: ZipArchive, presentationXml: string): string[] {
  const relsXml = zip.readText('ppt/_rels/presentation.xml.rels');
  const targets = new Map<string, string>();
  if (relsXml !== null) {
    for (const rel of parseRelationships(relsXml, 'ppt/presentation.xml')) {
      if (!rel.external && rel.type.endsWith(SLIDE_RELATIONSHIP)) targets.set(rel.id, rel.target);
    }
  }
  const ordered: string[] = [];
  scanXml(presentationXml, {
    open(name, attrs) {
      if (name !== 'sldId') return;
      const id = relationshipId(attrs);
      const target = id === undefined ? undefined : targets.get(id);
      if (target !== undefined && zip.has(target) && !ordered.includes(target)) ordered.push(target);
    },
  });
  if (ordered.length > 0) return ordered;
  return zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number.parseInt(a.replace(/\D+/g, ''), 10) - Number.parseInt(b.replace(/\D+/g, ''), 10));
}

export async function pptxToMarkdown(bytes: Buffer, relativePath: string, limits: ExtractLimits): Promise<string> {
  const zip = openZip(bytes, relativePath, 'PowerPoint 2007+ presentation', limits);
  const presentation = zip.readText('ppt/presentation.xml');
  if (presentation === null) {
    throw new DocumentExtractionError(
      `"${relativePath}" is a zip archive but not a PowerPoint presentation (it has no ppt/presentation.xml). A ".ppt" file renamed to ".pptx" stays the old binary format, which is not supported; re-save it as .pptx.`,
    );
  }

  // ADR-0115 §4: everything a slide renders, tables above all, is paid for out of one budget.
  const budget = outputBudget(relativePath, limits);
  const sections: string[] = [];
  const parts = slideParts(zip, presentation);
  for (let index = 0; index < parts.length; index++) {
    const xml = zip.readText(parts[index]);
    if (xml === null) continue;
    const items = readItems(xml);
    const title = slideTitle(items);
    const body = renderBody(items, budget);
    const notes = readNotes(zip, parts[index]);
    if (title === '' && body.length === 0 && notes === '') continue;

    const heading = `## Slide ${index + 1}${title === '' ? '' : `: ${title.replace(/[\r\n]+/g, ' ')}`}`;
    sections.push([heading, ...body, ...(notes === '' ? [] : [`Notes: ${notes}`])].join('\n\n'));
  }

  const deckTitle = documentTitle(zip.readText('docProps/core.xml')) || titleFromPath(relativePath);
  return withTitle(sections.join('\n\n'), deckTitle);
}
