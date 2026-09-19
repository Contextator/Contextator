/**
 * `.docx` → Markdown ([ADR-0056](../../../.ssot/ADR.md#adr-0056)).
 *
 * Through mammoth, which reads a Word document the way Word means it: it resolves `styles.xml` so a
 * paragraph styled "Heading 2" becomes an `<h2>` rather than a line that merely looks big, follows
 * `numbering.xml` so a numbered list stays numbered, and keeps tables as tables. That mapping is the
 * whole difference between a document and its words, and it is why this is not a zip reader plus a
 * regex over `word/document.xml`.
 *
 * It answers HTML, which `html.ts` then converts — one converter for both types, so a table in a Word
 * file and a table on a page come out as the same Markdown.
 *
 * `.doc` (the pre-2007 binary format) is not supported and is not in `SUPPORTED_EXTENSIONS`: it is an
 * OLE compound file with no pure-JavaScript reader worth the name, and a file that is renamed to
 * `.docx` is rejected below by the check that it is a zip at all.
 */

import { createInflateRaw } from 'node:zlib';
import mammoth from 'mammoth';
import { htmlFragmentToMarkdown } from './html.js';
import { DocumentExtractionError, type ExtractLimits, titleFromPath, withTitle } from './index.js';

/** Every `.docx` is a zip, and every zip starts `PK\x03\x04`. */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65 535. */
const EOCD_SEARCH = 22 + 0xffff;
/** A field of all ones is ZIP64's "look in the extra field"; this reader does not, and says so. */
const ZIP64_MARKER = 0xffffffff;

/**
 * What the zip's own central directory *says* its parts unpack to, or `null` when it cannot be read.
 *
 * **This is a claim, not a measurement**, and it is used only as a cheap way to refuse an honest large
 * file before anything is inflated. A hostile archive writes whatever it likes in this field — `jszip`
 * reads the same number and only notices the discrepancy *after* it has inflated the part, at which
 * point the memory is already spent — so the decision that matters is `measureUnpackedBytes` below.
 */
export function declaredUnpackedBytes(bytes: Buffer): number | null {
  const from = Math.max(0, bytes.length - EOCD_SEARCH);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= from; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entries = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  if (at === ZIP64_MARKER || entries === 0xffff) return Number.POSITIVE_INFINITY;

  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
    const unpacked = bytes.readUInt32LE(at + 24);
    if (unpacked === ZIP64_MARKER) return Number.POSITIVE_INFINITY;
    total += unpacked;
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return total;
}

/** Where each part's compressed bytes actually are, read from the central directory. */
interface ZipPart {
  method: number;
  offset: number;
  compressedSize: number;
}

function centralDirectoryParts(bytes: Buffer): ZipPart[] | null {
  const from = Math.max(0, bytes.length - EOCD_SEARCH);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= from; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const entries = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  if (at === ZIP64_MARKER || entries === 0xffff) return null;

  const parts: ZipPart[] = [];
  for (let i = 0; i < entries; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
    const compressedSize = bytes.readUInt32LE(at + 20);
    const offset = bytes.readUInt32LE(at + 42);
    if (compressedSize === ZIP64_MARKER || offset === ZIP64_MARKER) return null;
    parts.push({ method: bytes.readUInt16LE(at + 10), offset, compressedSize });
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return parts;
}

/**
 * How many bytes one deflate stream really produces, counted and thrown away, giving up the moment it
 * passes `budget`.
 *
 * Nothing is kept: the inflater's chunks are added to a number and dropped, so the memory this costs
 * is one chunk regardless of what the stream expands to. An inflate error resolves with what was
 * counted rather than rejecting — a corrupt part is a real problem, but it is mammoth's to describe,
 * and the error it gives names the actual defect better than "could not measure it" would.
 */
function inflatedSize(slice: Buffer, budget: number): Promise<number> {
  return new Promise((resolve) => {
    const stream = createInflateRaw();
    let total = 0;
    let settled = false;
    const settle = (value: number): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > budget) settle(Number.POSITIVE_INFINITY);
    });
    stream.on('end', () => settle(total));
    stream.on('error', () => settle(total));
    stream.end(slice);
  });
}

/**
 * What the archive's parts **actually** unpack to, or `Number.POSITIVE_INFINITY` once that passes
 * `budget`; `null` when the archive cannot be walked at all.
 *
 * **This is the cap, and the reason it is a measurement rather than a check on the declared size.**
 * DEFLATE reaches about 1030:1 on repetitive input — fifty megabytes of one byte compresses to fifty
 * kilobytes — so neither of the two cheap answers works. Trusting `uncompressedSize` trusts a field
 * the attacker writes, and `jszip` compares it against reality only after inflating the part, by which
 * time the heap is gone. Bounding `compressedSize × worst-case ratio` is sound but useless: it would
 * refuse an ordinary one-megabyte Word file on the grounds that it *could* have been a gigabyte.
 *
 * So each part is inflated here, counted, and discarded, with the running total as the ceiling. It
 * costs one extra inflate pass over a file mammoth is about to inflate anyway, in constant memory, and
 * it is the only version of this check that a crafted archive cannot talk its way past.
 */
export async function measureUnpackedBytes(bytes: Buffer, budget: number): Promise<number | null> {
  const parts = centralDirectoryParts(bytes);
  if (parts === null) return null;

  let total = 0;
  for (const part of parts) {
    if (part.offset + 30 > bytes.length || bytes.readUInt32LE(part.offset) !== LOCAL_SIGNATURE) return null;
    const dataAt = part.offset + 30 + bytes.readUInt16LE(part.offset + 26) + bytes.readUInt16LE(part.offset + 28);
    const end = Math.min(dataAt + part.compressedSize, bytes.length);
    if (dataAt > bytes.length) return null;

    if (part.method === METHOD_STORED) total += end - dataAt;
    else if (part.method === METHOD_DEFLATE) total += await inflatedSize(bytes.subarray(dataAt, end), budget - total);
    // Anything else — an archive using a method a `.docx` never uses — is not measurable here, and an
    // unmeasurable part is treated as one that does not fit rather than as one that does.
    else return Number.POSITIVE_INFINITY;

    if (total > budget) return Number.POSITIVE_INFINITY;
  }
  return total;
}

export async function docxToMarkdown(bytes: Buffer, relativePath: string, limits: ExtractLimits): Promise<string> {
  if (!isZip(bytes)) {
    throw new DocumentExtractionError(
      `"${relativePath}" is not a Word 2007+ document. A ".doc" file renamed to ".docx" stays the old binary format, which is not supported; re-save it as .docx.`,
    );
  }

  const tooBig = (what: string): DocumentExtractionError =>
    new DocumentExtractionError(
      `"${relativePath}" is a ${(bytes.byteLength / 1024).toFixed(0)} KiB file whose parts ${what}, over the ` +
        `${(limits.maxUnpackedBytes / (1024 * 1024)).toFixed(0)} MiB a Word document may unpack to. A real one does not compress like that; ` +
        `raise MAX_DOCX_UNPACKED_BYTES if this one really does, or remove the file from the source.`,
    );

  // The cheap refusal first: an honest large file says so in its own directory and never needs to be
  // inflated to be turned away.
  const declared = declaredUnpackedBytes(bytes);
  if (declared !== null && declared > limits.maxUnpackedBytes) throw tooBig('declare that they unpack past the limit');

  // Then the one that holds against a file that lies about itself.
  const measured = await measureUnpackedBytes(bytes, limits.maxUnpackedBytes);
  if (measured === null) throw new DocumentExtractionError(`"${relativePath}" is not a readable zip archive, so it is not a Word document.`);
  if (measured > limits.maxUnpackedBytes) throw tooBig('actually unpack past the limit');

  // The image is dropped and its alt text kept. Word stores every picture inside the file, so the
  // default — a `data:` URI — would put the picture's bytes into `documents.content`, base64'd and
  // a third larger than the original, for an agent to read as a wall of characters.
  //
  // Anything mammoth throws is left alone: `extractDocument` is the one place failures are named, and
  // a second message here would only differ from that one in wording.
  const result = await mammoth.convertToHtml({ buffer: bytes }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  return withTitle(htmlFragmentToMarkdown(result.value), titleFromPath(relativePath));
}
