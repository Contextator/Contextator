/**
 * Document types: one transform per file extension, every one of them answering in Markdown
 * ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
 *
 * This is `services/flavors.ts`'s shape applied to a different question. A flavor asks *which tool
 * wrote this Markdown* and rewrites the dialect; a document type asks *what is this file at all* and
 * produces the Markdown in the first place. They compose in that order — extract, then flavor — and
 * the chunker below them keeps seeing exactly one input format, which is the whole point of doing the
 * work out here at the edge.
 *
 * **What comes out is read by a person, not only by an embedder.** Since
 * [ADR-0043](../../../.ssot/ADR.md#adr-0043) the string a transform returns is stored in
 * `documents.content` and served verbatim by `read_document`, so "good enough to embed" is no longer
 * the bar: a PDF flattened into a column-interleaved word soup would retrieve acceptably and read as
 * nonsense, and it is the reading that this module is written against.
 *
 * Every transform is lazily imported. A server that indexes Markdown should not pay for a PDF parser
 * at boot, and three of the four libraries here are large.
 */

import type { SupportedExtension } from '../fs-scan.js';

/**
 * A file that cannot be turned into Markdown at all — a PDF with no text layer, an encrypted one, a
 * `.docx` that is not a zip. The message is written to the owning source's `last_error` and shown in
 * the dashboard, so it is addressed to an operator and says what to do.
 *
 * **It is thrown rather than swallowed, and that is the decision.** The alternative — indexing the
 * empty string — produces a document that exists, is searchable, matches nothing, and reads as blank.
 * Nobody would ever look for the cause, because nothing would look wrong.
 */
export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

/** Takes the file's raw bytes and its stored path (for the title fallback); answers Markdown. */
export type DocumentExtractor = (bytes: Buffer, relativePath: string) => Promise<string>;

/** The extension of a stored path, lower-cased and without the dot; `''` when there is none. */
export function extensionOf(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** `quarterly-report.pdf` → `Quarterly Report`. The same rule `extractTitle` uses on a filename. */
export function titleFromPath(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  const stem = base.replace(/\.[^.]+$/, '');
  const words = stem.split(/[-_\s]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : stem;
}

/** A UTF-8 BOM decodes to `﻿`, which is invisible and is enough to hide the `#` of a first heading. */
export function decodeUtf8(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/^﻿/, '');
}

/**
 * Whether the Markdown already carries a top-level heading, ignoring the inside of fenced code blocks
 * — the same reading `chunkMarkdown`'s own `findFirstH1` does, and it has to be the same one or the
 * title we add below would lose to a `#` line in a code sample.
 */
function hasTopLevelHeading(markdown: string): boolean {
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^#\s+\S/.test(line)) return true;
  }
  return false;
}

/**
 * Guarantees the converted document opens with an `# H1`.
 *
 * A `.pdf` or a `.csv` reaching `extractTitle` with no heading falls through to its filename — and
 * that fallback only strips `.md`, `.mdx` and `.txt`, so the title of `handbook.pdf` would be
 * "Handbook.pdf", extension and all. Naming the document here, where the extension is known and the
 * format's own idea of a title (a `<title>` element, a PDF's `Title` metadata) is in hand, is both the
 * correct place for it and the reason `services/chunker.ts` needs no change for any of this.
 */
export function withTitle(markdown: string, title: string): string {
  const body = markdown.replace(/^\n+/, '').trimEnd();
  if (hasTopLevelHeading(body)) return body;
  const heading = title.trim();
  return heading ? (body ? `# ${heading}\n\n${body}` : `# ${heading}`) : body;
}

const text: DocumentExtractor = async (bytes) => bytes.toString('utf8');

/**
 * Extension → transform. `Record<SupportedExtension, …>` and not a `Map`, so that the compiler is the
 * thing that notices when `SUPPORTED_EXTENSIONS` grows an entry nobody wrote a transform for.
 *
 * `.md`, `.mdx` and `.txt` decode and stop — deliberately including the BOM, which they have always
 * carried; the types added by ADR-0056 strip it, because a BOM is what a spreadsheet export starts
 * with and it is not what the file says.
 */
const EXTRACTORS: Record<SupportedExtension, DocumentExtractor> = {
  md: text,
  mdx: text,
  txt: text,
  html: async (bytes, rel) => (await import('./html.js')).htmlToMarkdown(bytes, rel),
  htm: async (bytes, rel) => (await import('./html.js')).htmlToMarkdown(bytes, rel),
  csv: async (bytes, rel) => (await import('./csv.js')).csvToMarkdown(bytes, rel),
  docx: async (bytes, rel) => (await import('./docx.js')).docxToMarkdown(bytes, rel),
  pdf: async (bytes, rel) => (await import('./pdf.js')).pdfToMarkdown(bytes, rel),
};

/** The Markdown of one indexed file. Throws `DocumentExtractionError` when the file cannot become one. */
export async function extractDocument(relativePath: string, bytes: Buffer): Promise<string> {
  const ext = extensionOf(relativePath);
  const extractor = (EXTRACTORS as Record<string, DocumentExtractor | undefined>)[ext];
  if (!extractor) throw new DocumentExtractionError(`"${relativePath}" has no supported file type (".${ext}")`);
  return extractor(bytes, relativePath);
}
