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

/** Takes the file's raw bytes, its stored path (for the title fallback) and the run's caps; answers Markdown. */
export type DocumentExtractor = (bytes: Buffer, relativePath: string, limits: ExtractLimits) => Promise<string>;

/**
 * What one file is allowed to cost while it is being converted
 * ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
 *
 * **These bound the indexer's own process, and that is why they are not the upload limits.**
 * `UPLOAD_MAX_FILE_BYTES` governs what may be *stored*, and it only ever applied to the upload path —
 * a file reached through a local directory or a git checkout passed no size check at all. What runs
 * here is a parser holding a whole document in memory, in the same process as the dashboard and
 * `/mcp`, so the ceiling that matters is the one on what may be *parsed*, and it has to apply to every
 * source type.
 */
export interface ExtractLimits {
  /** Raw bytes of a file of a converted type. `.md` and friends are not parsed and are not capped. */
  maxFileBytes: number;
  /** Pages a PDF may declare. A few kilobytes of PDF can claim a hundred thousand of them. */
  maxPdfPages: number;
  /** What a `.docx`'s central directory may claim its parts unpack to — the ordinary zip bomb. */
  maxUnpackedBytes: number;
}

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
  // html and csv take no limits: neither unpacks anything and neither can be asked to do more work
  // than its bytes, which `maxFileBytes` has already bounded by the time they are called.
  html: async (bytes, rel) => (await import('./html.js')).htmlToMarkdown(bytes, rel),
  htm: async (bytes, rel) => (await import('./html.js')).htmlToMarkdown(bytes, rel),
  csv: async (bytes, rel) => (await import('./csv.js')).csvToMarkdown(bytes, rel),
  docx: async (bytes, rel, limits) => (await import('./docx.js')).docxToMarkdown(bytes, rel, limits),
  pdf: async (bytes, rel, limits) => (await import('./pdf.js')).pdfToMarkdown(bytes, rel, limits),
};

/**
 * The types that are *converted*, as opposed to the three that are already Markdown.
 *
 * The distinction earns its keep twice below: only these are parsed, so only these are capped; and an
 * empty result means something different for each side. An empty `.md` is an empty file, which is a
 * thing people commit and which this product has always skipped quietly. An empty `.pdf` is a
 * conversion that produced nothing from a file that plainly held something, and that is a failure.
 */
const CONVERTED: ReadonlySet<string> = new Set(['html', 'htm', 'csv', 'docx', 'pdf']);

/** Heading lines are the title this module adds; they are not evidence that the document has content. */
function hasBodyText(markdown: string): boolean {
  return markdown.split('\n').some((line) => !/^#{1,6}\s/.test(line) && line.trim() !== '');
}

function bytesLabel(count: number): string {
  return count >= 1024 * 1024 ? `${(count / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(count / 1024)} KiB`;
}

/**
 * The Markdown of one indexed file.
 *
 * **Every failure leaves here as a `DocumentExtractionError`, and that is the point of the boundary.**
 * Four third-party parsers run under this call, and between them they throw a catalogue nobody has
 * enumerated: a `FormatError` from a truncated cross-reference table, a DOM exception from a page that
 * ends mid-tag, whatever `jszip` says about a corrupt part. Any one of those escaping is not a bad
 * document, it is a **failed run** — `indexer.ts` rethrows what it does not recognise, the project goes
 * to `error`, and because the failure is deterministic the project cannot be indexed again until
 * somebody finds and deletes the file. Three hundred and ninety-nine healthy documents stop being
 * updated because of one. So the rule is that the only thing this function throws is the type the
 * indexer knows how to report, and the message always names the file — the library's own message
 * usually does not, and "Invalid XRef stream header" with no filename is not something an operator can
 * act on.
 */
export async function extractDocument(relativePath: string, bytes: Buffer, limits: ExtractLimits): Promise<string> {
  const ext = extensionOf(relativePath);
  const extractor = (EXTRACTORS as Record<string, DocumentExtractor | undefined>)[ext];
  if (!extractor) throw new DocumentExtractionError(`"${relativePath}" has no supported file type (".${ext}")`);

  const converted = CONVERTED.has(ext);
  if (converted && bytes.byteLength > limits.maxFileBytes) {
    throw new DocumentExtractionError(
      `"${relativePath}" is ${bytesLabel(bytes.byteLength)}, over the ${bytesLabel(limits.maxFileBytes)} a file of this type may be when it is converted. ` +
        `Converting it happens in the server's own process, so the limit is there to keep one document from taking the dashboard and the MCP endpoint down with it; ` +
        `raise MAX_CONVERTED_FILE_BYTES if this file is genuinely a document, or split it.`,
    );
  }

  let markdown: string;
  try {
    markdown = await extractor(bytes, relativePath, limits);
  } catch (err) {
    if (err instanceof DocumentExtractionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DocumentExtractionError(`"${relativePath}" could not be read as a ".${ext}" file: ${message}`);
  }

  if (converted && !hasBodyText(markdown)) {
    throw new DocumentExtractionError(
      `"${relativePath}" converted to nothing — the file holds no text this product can index. ` +
        `Indexing it anyway would add a document that is listed, matches nothing and reads as blank, which is the one failure nobody ever notices.`,
    );
  }
  return markdown;
}
