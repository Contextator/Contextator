/**
 * `.pdf` → Markdown ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
 *
 * **A PDF does not contain paragraphs.** It contains glyphs with coordinates, and every structure a
 * reader sees — a heading, a column, a paragraph, a table, a running header — is something the eye
 * infers from where those glyphs sit. Concatenating them in file order is the extraction everybody
 * writes first and it produces text that embeds acceptably and reads as nonsense: the left column's
 * line one, the right column's line one, the footer, then line two. Since
 * [ADR-0043](../../../.ssot/ADR.md#adr-0043) that text is what `read_document` hands an agent, so the
 * geometry has to be read rather than discarded, and this module is that reading:
 *
 * 1. glyph runs are grouped into lines by baseline, and into cells by the gaps inside a line;
 * 2. a page is split at its gutter, so a two-column layout is read down one column and then the other;
 * 3. lines repeated at the top or bottom of most pages are dropped as running heads and feet;
 * 4. font size relative to the body size promotes a line to a heading;
 * 5. lines whose cells stay in the same columns become a table, bullets become a list, and the rest
 *    become paragraphs — joined across line ends, with hyphenation undone.
 *
 * **What it does not do is OCR, and that is a decision rather than a gap.** A PDF with no text layer
 * is rejected by name, because the alternative is a document that indexes to nothing and looks fine.
 *
 * `unpdf` is the reader: PDF.js, which is the only mature pure-JavaScript one, packaged in its
 * serverless build with *no dependencies at all* — where `pdfjs-dist` itself carries an optional
 * native `@napi-rs/canvas`, which is exactly the kind of thing that builds on one architecture of a
 * two-architecture image and not the other.
 */

import type { StructuredTextItem } from 'unpdf';
import { DocumentExtractionError, titleFromPath, withTitle } from './index.js';

/** Baselines within this fraction of the font size are the same line. */
const LINE_TOLERANCE = 0.35;

/** A gap wider than this many ems inside a line is a column boundary, not a word space. */
const CELL_GAP_EMS = 1.2;

/** A gutter must be at least this fraction of the page wide, and centred within the band below. */
const MIN_GUTTER_FRACTION = 0.035;

/** …and be covered by at most this share of what the busiest strip of the page is covered by. */
const GUTTER_OCCUPANCY = 0.08;
const GUTTER_BAND: readonly [number, number] = [0.3, 0.7];

/** Each side of a gutter must hold at least this share of the page's glyph runs for it to be one. */
const MIN_COLUMN_SHARE = 0.15;

/** The top and bottom slice of a page that a running head or foot can live in. */
const MARGIN_ZONE = 0.09;

/** A line is a heading when it is this much larger than the body text. */
const HEADING_RATIO = 1.12;

/** Deeper than this and a heading level says nothing, so every remaining size shares the last one. */
const MAX_HEADING_LEVEL = 4;

/** A vertical step this much larger than the page's usual leading ends the paragraph. */
const PARAGRAPH_GAP_RATIO = 1.45;

/** Lines a table run needs before it is called one: a header and two rows. */
const MIN_TABLE_ROWS = 3;

/**
 * Below this many non-blank characters per page the PDF has no text layer worth the name. A scanned
 * page yields nothing, or a page number; a typeset page yields hundreds.
 */
const MIN_CHARS_PER_PAGE = 8;
const MIN_CHARS_TOTAL = 24;

const BULLET_RE = /^[\u2022\u00b7\u25aa\u25e6\u2023\u2219*-]\s+/;
const ORDERED_RE = /^(\d{1,3})[.)]\s+/;

interface Cell {
  x: number;
  right: number;
  text: string;
}

interface Line {
  page: number;
  y: number;
  x: number;
  right: number;
  fontSize: number;
  cells: Cell[];
  text: string;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Glyph runs → lines, and within each line → cells.
 *
 * Two thresholds do all the work. Baselines closer than `LINE_TOLERANCE` ems are one line, which
 * survives the sub-pixel drift every producer has. And a horizontal gap wider than `CELL_GAP_EMS` is a
 * cell boundary rather than a space — justified text stretches word spaces, but not that far, and
 * table columns are separated by far more.
 */
function buildLines(items: StructuredTextItem[], page: number): Line[] {
  // **Whitespace-only runs are dropped, and that is what makes a column a column.** PDF.js
  // synthesises a run of spaces to bridge a horizontal jump — a table's gutter arrives as a single
  // `" "` a hundred points wide — so a reader that keeps them sees no gaps anywhere and every table
  // flattens into a sentence. The geometry already carries the jump: drop the bridge and the distance
  // between two real runs is the distance on the page.
  const useful = items.filter((item) => item.str.trim() !== '');
  if (useful.length === 0) return [];
  const sorted = [...useful].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: StructuredTextItem[][] = [];
  let current: StructuredTextItem[] = [];
  let baseline = sorted[0].y;
  let baseSize = sorted[0].fontSize || 10;
  for (const item of sorted) {
    if (current.length > 0 && Math.abs(item.y - baseline) > Math.max(1, baseSize * LINE_TOLERANCE)) {
      groups.push(current);
      current = [];
    }
    if (current.length === 0) {
      baseline = item.y;
      baseSize = item.fontSize || baseSize;
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const fontSize = ordered.reduce((max, item) => Math.max(max, item.fontSize || 0), 0) || 10;
    const cells: Cell[] = [];
    let text = '';
    let cellStart = ordered[0].x;
    let cursor = ordered[0].x;

    for (const item of ordered) {
      const gap = item.x - cursor;
      const size = item.fontSize || fontSize;
      if (text !== '') {
        if (gap > Math.max(size * CELL_GAP_EMS, 6)) {
          cells.push({ x: cellStart, right: cursor, text: normalise(text) });
          cellStart = item.x;
          text = '';
        } else if (gap > size * 0.18) {
          text += ' ';
        }
      } else {
        cellStart = item.x;
      }
      text += item.str;
      cursor = item.x + item.width;
    }
    cells.push({ x: cellStart, right: cursor, text: normalise(text) });

    const kept = cells.filter((c) => c.text !== '');
    return {
      page,
      y: ordered[0].y,
      x: ordered[0].x,
      right: cursor,
      fontSize,
      cells: kept,
      text: normalise(kept.map((c) => c.text).join(' ')),
    };
  });
}

/**
 * The gutter of a two-column page, or `null`.
 *
 * It is a projection profile: how many glyph runs cover each vertical strip of the page. A gutter is a
 * strip in the middle that almost nothing covers — **almost**, and not nothing, which is the whole
 * reason this counts rather than marks. A two-column page nearly always carries a title across the top
 * and often a figure across the middle, and a search for a strip that is completely empty finds no
 * gutter on any page that has one of those. So the bar is occupancy near zero relative to the busiest
 * strip, and the runs that do cross are handled below as spanners.
 *
 * The share check is what keeps a single column from looking like two: in a one-column page the runs
 * start at the left margin and end past any candidate strip, so they are spanners, and neither side of
 * the supposed gutter holds enough of the page to be a column.
 */
function findGutter(items: StructuredTextItem[], pageWidth: number): [number, number] | null {
  if (items.length < 10 || pageWidth <= 0) return null;
  const buckets = 240;
  const step = pageWidth / buckets;
  const occupancy = new Array<number>(buckets).fill(0);
  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x / step));
    const to = Math.min(buckets - 1, Math.ceil((item.x + item.width) / step));
    for (let i = from; i <= to; i++) occupancy[i]++;
  }
  const busiest = Math.max(...occupancy);
  const threshold = Math.max(1, busiest * GUTTER_OCCUPANCY);

  let best: [number, number] | null = null;
  let bestWidth = pageWidth * MIN_GUTTER_FRACTION;
  let runStart = -1;
  for (let i = 0; i <= buckets; i++) {
    const free = i < buckets && occupancy[i] <= threshold;
    if (free && runStart === -1) runStart = i;
    if (!free && runStart !== -1) {
      const left = runStart * step;
      const right = i * step;
      const centre = (left + right) / 2 / pageWidth;
      if (right - left > bestWidth && centre >= GUTTER_BAND[0] && centre <= GUTTER_BAND[1]) {
        best = [left, right];
        bestWidth = right - left;
      }
      runStart = -1;
    }
  }
  if (!best) return null;

  const [left, right] = best;
  const inLeft = items.filter((item) => item.x + item.width <= left).length;
  const inRight = items.filter((item) => item.x >= right).length;
  const floor = items.length * MIN_COLUMN_SHARE;
  return inLeft >= floor && inRight >= floor ? best : null;
}

/**
 * One page's glyph runs → reading order.
 *
 * With no gutter the page is one block. With one, the page is walked top to bottom and cut wherever
 * full-width runs start or stop: a run of spanners is its own block, and everything between two of
 * them is read down the left column and then down the right. That is a two-level XY cut, which is
 * enough for the layouts a documentation PDF actually uses — a title across the top, two columns
 * under it, a figure or a table spanning both partway down.
 */
function pageBlocks(items: StructuredTextItem[], pageWidth: number): StructuredTextItem[][] {
  const gutter = findGutter(items, pageWidth);
  if (!gutter) return items.length > 0 ? [items] : [];
  const [left, right] = gutter;
  const spans = (item: StructuredTextItem): boolean => item.x < left && item.x + item.width > right;
  const isLeft = (item: StructuredTextItem): boolean => item.x + item.width <= right;

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const blocks: StructuredTextItem[][] = [];
  let bucket: StructuredTextItem[] = [];
  let spanning: boolean | null = null;

  const flush = (): void => {
    if (bucket.length === 0) return;
    if (spanning) blocks.push(bucket);
    else {
      const column = [bucket.filter(isLeft), bucket.filter((item) => !isLeft(item))];
      for (const part of column) if (part.length > 0) blocks.push(part);
    }
    bucket = [];
  };

  for (const item of sorted) {
    const mode = spans(item);
    if (spanning !== null && mode !== spanning) flush();
    spanning = mode;
    bucket.push(item);
  }
  flush();
  return blocks;
}

/** A line's identity for the purpose of "is this the same running head": digits are what varies. */
function marginKey(text: string): string {
  return text.replace(/\d+/g, '#').toLowerCase().trim();
}

/**
 * Drops running heads and feet: a line in a page's top or bottom margin whose text — page number
 * aside — repeats on at least half the pages.
 *
 * It needs three pages to say anything. On two, "repeats on half the pages" is "appears twice", which
 * a two-page document's own sentence can do.
 */
function stripRunningMargins(pages: Line[][], heights: number[]): Line[][] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, Set<number>>();
  pages.forEach((lines, index) => {
    const height = heights[index] || 0;
    for (const line of lines) {
      if (!inMargin(line, height)) continue;
      const key = marginKey(line.text);
      if (key === '') continue;
      const seen = counts.get(key) ?? new Set<number>();
      seen.add(index);
      counts.set(key, seen);
    }
  });
  const repeated = new Set([...counts].filter(([, seen]) => seen.size >= Math.ceil(pages.length / 2)).map(([key]) => key));
  if (repeated.size === 0) return pages;
  return pages.map((lines, index) => lines.filter((line) => !(inMargin(line, heights[index] || 0) && repeated.has(marginKey(line.text)))));
}

function inMargin(line: Line, height: number): boolean {
  if (height <= 0) return false;
  return line.y >= height * (1 - MARGIN_ZONE) || line.y <= height * MARGIN_ZONE;
}

/** The size most of the document's characters are set in — its body text, whatever the headings do. */
function bodyFontSize(lines: Line[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.fontSize * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + line.text.length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** Heading size → `#` depth, largest size first, everything past the fourth sharing `####`. */
function headingLevels(lines: Line[], body: number): Map<number, number> {
  const sizes = [...new Set(lines.filter((l) => l.fontSize >= body * HEADING_RATIO).map((l) => Math.round(l.fontSize * 2) / 2))].sort(
    (a, b) => b - a,
  );
  return new Map(sizes.map((size, index) => [size, Math.min(index + 1, MAX_HEADING_LEVEL)]));
}

/** The usual baseline-to-baseline step, so a bigger one can be read as a paragraph break. */
function medianLeading(lines: Line[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0 && lines[i - 1].page === lines[i].page) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * How many lines starting at `from` form a table: consecutive lines with the same number of cells (at
 * least two), whose columns stay put. A column counts as staying put when either its left edge or its
 * right edge holds — left-aligned text keeps the former, a column of numbers keeps the latter.
 */
function tableRun(lines: Line[], from: number, headings: Map<number, number>): number {
  const first = lines[from];
  const columns = first.cells.length;
  if (columns < 2 || headings.has(Math.round(first.fontSize * 2) / 2)) return 0;
  const tolerance = Math.max(6, first.fontSize * 1.2);
  let end = from + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.page !== first.page || line.cells.length !== columns) break;
    if (headings.has(Math.round(line.fontSize * 2) / 2)) break;
    if (BULLET_RE.test(line.text) || ORDERED_RE.test(line.text)) break;
    const aligned = line.cells.every(
      (cell, i) => Math.abs(cell.x - first.cells[i].x) <= tolerance || Math.abs(cell.right - first.cells[i].right) <= tolerance,
    );
    if (!aligned) break;
    end++;
  }
  const rows = end - from;
  return rows >= MIN_TABLE_ROWS ? rows : 0;
}

function tableCell(value: string): string {
  const text = value.replace(/\|/g, '\\|').trim();
  return text === '' ? ' ' : text;
}

function renderTable(rows: Line[]): string {
  const width = rows[0].cells.length;
  const row = (line: Line): string => `| ${line.cells.map((c) => tableCell(c.text)).join(' | ')} |`;
  return [row(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(row)].join('\n');
}

/** `example-` + `continued` is one word split by a line break; `example` + `continued` is two. */
function joinWrapped(previous: string, next: string): string {
  if (/[\p{Ll}\p{Lu}]-$/u.test(previous) && /^[\p{Ll}]/u.test(next)) return previous.slice(0, -1) + next;
  return `${previous} ${next}`;
}

/**
 * Does a line start a new block, or continue the one above it?
 *
 * A bigger vertical step than the page's usual leading is a paragraph break, and so is a baseline
 * that moves *up* — which is what the top of the next column looks like after the bottom of the last
 * one. A page boundary is the one break that is not always a break: a sentence that runs off the
 * bottom of page four continues at the top of page five, so a page change only breaks the paragraph
 * when the text so far reads as finished.
 */
function startsNewBlock(previous: Line | undefined, line: Line, leading: number, pending: string): boolean {
  if (previous === undefined) return true;
  if (previous.page !== line.page) return pending.trim() === '' || /[.!?:;]["')\]]?$/.test(pending.trim());
  if (previous.y < line.y) return true;
  return leading > 0 && previous.y - line.y > leading * PARAGRAPH_GAP_RATIO;
}

function assemble(lines: Line[]): string {
  const body = bodyFontSize(lines);
  const headings = headingLevels(lines, body);
  const leading = medianLeading(lines);
  const out: string[] = [];
  /** The block being built: a paragraph, or a run of list items separated by newlines. */
  let pending = '';
  let pendingIsList = false;

  const flush = (): void => {
    if (pending.trim() !== '') out.push(pending.trim());
    pending = '';
    pendingIsList = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = i > 0 ? lines[i - 1] : undefined;

    const rows = tableRun(lines, i, headings);
    if (rows > 0) {
      flush();
      out.push(renderTable(lines.slice(i, i + rows)));
      i += rows - 1;
      continue;
    }

    const level = headings.get(Math.round(line.fontSize * 2) / 2);
    if (level !== undefined && line.text !== '') {
      flush();
      out.push(`${'#'.repeat(level)} ${line.text}`);
      continue;
    }

    const bullet = BULLET_RE.exec(line.text);
    const ordered = bullet ? null : ORDERED_RE.exec(line.text);
    if (bullet || ordered) {
      const item = bullet ? `- ${line.text.slice(bullet[0].length)}` : `${ordered?.[1]}. ${line.text.slice(ordered?.[0].length ?? 0)}`;
      // Items of one list belong to one block, separated by single newlines. Pushed separately they
      // would be paragraphs that happen to start with a dash, and a reader has to guess which is which.
      if (pendingIsList) pending = `${pending}\n${item}`;
      else {
        flush();
        pending = item;
        pendingIsList = true;
      }
      continue;
    }

    if (startsNewBlock(previous, line, leading, pending)) {
      flush();
      pending = line.text;
      continue;
    }
    // A line under a list item that is not one itself is that item wrapping onto a second line.
    pending = pending === '' ? line.text : joinWrapped(pending, line.text);
  }
  flush();
  return out.join('\n\n');
}

function openFailure(err: unknown, relativePath: string): DocumentExtractionError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'PasswordException') {
    return new DocumentExtractionError(
      `"${relativePath}" is password-protected. Remove the password from the copy in the source; the indexer cannot be given one.`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new DocumentExtractionError(`"${relativePath}" could not be opened as a PDF: ${message}`);
}

export async function pdfToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
  const { extractTextItems, getDocumentProxy, getMeta } = await import('unpdf');

  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // `verbosity: 0` is `VerbosityLevel.ERRORS`: a PDF written by a tool with a loose idea of the
    // specification warns on nearly every page, and those warnings would go to the server's stdout
    // unstructured, beside the log lines an operator actually reads.
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (err) {
    throw openFailure(err, relativePath);
  }

  try {
    const { totalPages, items } = await extractTextItems(doc);
    const heights: number[] = [];
    const pages: Line[][] = [];
    for (let page = 1; page <= totalPages; page++) {
      const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
      heights.push(viewport.height);
      // Filtered here as well as in `buildLines`, because the gutter search reads coverage: one
      // synthesised space bridging two columns covers the gutter and hides it.
      const pageItems = (items[page - 1] ?? []).filter((item) => item.str.trim() !== '');
      const lines = pageBlocks(pageItems, viewport.width).flatMap((block) => buildLines(block, page));
      pages.push(lines.filter((line) => line.text !== ''));
    }

    const lines = stripRunningMargins(pages, heights).flat();
    const markdown = assemble(lines);
    const characters = markdown.replace(/\s/g, '').length;
    if (characters < Math.max(MIN_CHARS_TOTAL, MIN_CHARS_PER_PAGE * totalPages)) {
      throw new DocumentExtractionError(
        `"${relativePath}" has no text layer — ${totalPages} page(s) yielded ${characters} characters, which is what a scan of paper looks like. ` +
          `Optical character recognition is out of scope for this product; run the file through OCR before indexing it, or remove it from the source.`,
      );
    }

    const meta = await getMeta(doc).catch(() => undefined);
    const declared = typeof meta?.info?.Title === 'string' ? meta.info.Title.trim() : '';
    return withTitle(markdown, declared || titleFromPath(relativePath));
  } finally {
    // The loading task owns the worker; the proxy only owns the pages. Releasing the task is what
    // actually frees a large document, and a run indexes them one after another.
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}
