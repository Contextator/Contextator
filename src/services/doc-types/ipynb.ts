/**
 * `.ipynb` → Markdown ([ADR-0115](../../../.ssot/ADR.md#adr-0115)).
 *
 * A notebook is JSON whose `cells` array is the document: markdown cells are prose and are kept as
 * they are, code cells are kept as fenced blocks in the notebook's language. **Outputs are left out.**
 * They are the run's result rather than the author's text, and they are where a notebook's size comes
 * from — base64 plots, 50 000-line tracebacks, dataframes printed in full. Indexing them would make a
 * notebook retrieve on whatever it happened to print once. Raw cells are configuration for a converter
 * (`nbconvert`) and are skipped for the same reason.
 *
 * Both the current layout (nbformat 4: top-level `cells`) and the old one (nbformat 3: `worksheets[].cells`)
 * are read; anything else is a refusal naming the file, because a `.json` file renamed `.ipynb` should
 * not index as an empty document.
 */

import { outputBudget } from './budget.js';
import { DocumentExtractionError, decodeUtf8, type ExtractLimits, titleFromPath, withTitle } from './index.js';

interface RawCell {
  cell_type?: unknown;
  source?: unknown;
  input?: unknown;
  language?: unknown;
}

/** `source` is a string or an array of lines that already carry their own newlines. */
function sourceOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('');
  return '';
}

/** A fence longer than any backtick run inside the code, so code that contains ``` cannot end it early. */
function fence(code: string): string {
  let longest = 2;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(longest + 1);
}

/**
 * An embedded image is megabytes of base64 and no words; keep its alt text, which is.
 *
 * Reads `![alt](data:...)` with `indexOf` and not a regex: a notebook can hold forty thousand `![a` that never
 * close, and a pattern that scans on to the end of the cell from each of them is quadratic. Here every `![`
 * that shares a `]` shares the outcome, so the scan moves past that `]` and each character is read once.
 */
function stripEmbeddedImages(markdown: string): string {
  let out = '';
  let cursor = 0;
  let from = 0;
  let close = -1;
  for (;;) {
    const start = markdown.indexOf('![', from);
    if (start === -1) break;
    if (close < start + 2) {
      close = markdown.indexOf(']', start + 2);
      if (close === -1) break;
    }
    let p = close + 1;
    if (markdown[p] === '(') {
      p++;
      while (p < markdown.length && /\s/.test(markdown[p])) p++;
      if (markdown.startsWith('data:', p)) {
        const end = markdown.indexOf(')', p + 5);
        if (end === -1) break; // no `)` here means none further on either
        out += markdown.slice(cursor, start) + markdown.slice(start + 2, close).trim();
        cursor = end + 1;
        from = end + 1;
        continue;
      }
    }
    from = close + 1; // every `![` before this `]` ends the same way
  }
  return out + markdown.slice(cursor);
}

/** A fence info string is one short word: anything else (a newline, a backtick) would break out of the fence. */
function safeLanguage(name: unknown): string {
  return typeof name === 'string' && /^[\w+#.-]{1,30}$/.test(name) ? name.toLowerCase() : '';
}

function languageOf(notebook: Record<string, unknown>): string {
  const metadata = notebook.metadata as Record<string, unknown> | undefined;
  const info = metadata?.language_info as Record<string, unknown> | undefined;
  const kernel = metadata?.kernelspec as Record<string, unknown> | undefined;
  const name = info?.name ?? kernel?.language;
  return safeLanguage(name);
}

function cellsOf(notebook: Record<string, unknown>): RawCell[] {
  if (Array.isArray(notebook.cells)) return notebook.cells as RawCell[];
  if (Array.isArray(notebook.worksheets)) {
    return (notebook.worksheets as Array<Record<string, unknown>>).flatMap((sheet) =>
      Array.isArray(sheet?.cells) ? (sheet.cells as RawCell[]) : [],
    );
  }
  throw new DocumentExtractionError('is not a Jupyter notebook: it has neither "cells" (nbformat 4) nor "worksheets" (nbformat 3)');
}

export async function ipynbToMarkdown(bytes: Buffer, relativePath: string, limits: ExtractLimits): Promise<string> {
  let notebook: unknown;
  try {
    notebook = JSON.parse(decodeUtf8(bytes));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DocumentExtractionError(`"${relativePath}" is not valid JSON, so it cannot be read as a Jupyter notebook: ${reason}`);
  }
  if (typeof notebook !== 'object' || notebook === null || Array.isArray(notebook)) {
    throw new DocumentExtractionError(`"${relativePath}" is not a Jupyter notebook: its top level is not a JSON object.`);
  }

  let cells: RawCell[];
  try {
    cells = cellsOf(notebook as Record<string, unknown>);
  } catch (err) {
    throw new DocumentExtractionError(`"${relativePath}" ${(err as Error).message}`);
  }
  const language = languageOf(notebook as Record<string, unknown>);

  // ADR-0115 §4: every block is paid for as it is written.
  const budget = outputBudget(relativePath, limits);
  const blocks: string[] = [];
  for (const cell of cells) {
    if (typeof cell !== 'object' || cell === null) continue;
    const kind = cell.cell_type;
    if (kind === 'markdown') {
      const text = stripEmbeddedImages(sourceOf(cell.source)).trim();
      if (text) blocks.push(budget.emit(text, 2));
    } else if (kind === 'code') {
      // nbformat 3 keeps the code under `input` and the language on the cell.
      const code = (cell.source !== undefined ? sourceOf(cell.source) : sourceOf(cell.input)).trimEnd();
      if (!code.trim()) continue;
      const lang = typeof cell.language === 'string' ? safeLanguage(cell.language) || language : language;
      const marks = fence(code);
      blocks.push(budget.emit(`${marks}${lang}\n${code}\n${marks}`, 2));
    }
  }
  return withTitle(blocks.join('\n\n'), titleFromPath(relativePath));
}
