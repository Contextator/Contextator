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

import { DocumentExtractionError, decodeUtf8, titleFromPath, withTitle } from './index.js';

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

/** An embedded image is megabytes of base64 and no words; keep its alt text, which is. */
function stripEmbeddedImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(\s*data:[^)]*\)/g, (_, alt: string) => alt.trim());
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

export async function ipynbToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
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

  const blocks: string[] = [];
  for (const cell of cells) {
    if (typeof cell !== 'object' || cell === null) continue;
    const kind = cell.cell_type;
    if (kind === 'markdown') {
      const text = stripEmbeddedImages(sourceOf(cell.source)).trim();
      if (text) blocks.push(text);
    } else if (kind === 'code') {
      // nbformat 3 keeps the code under `input` and the language on the cell.
      const code = (cell.source !== undefined ? sourceOf(cell.source) : sourceOf(cell.input)).trimEnd();
      if (!code.trim()) continue;
      const lang = typeof cell.language === 'string' ? safeLanguage(cell.language) || language : language;
      const marks = fence(code);
      blocks.push(`${marks}${lang}\n${code}\n${marks}`);
    }
  }
  return withTitle(blocks.join('\n\n'), titleFromPath(relativePath));
}
