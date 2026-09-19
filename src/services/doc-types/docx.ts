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

import mammoth from 'mammoth';
import { htmlFragmentToMarkdown } from './html.js';
import { DocumentExtractionError, type ExtractLimits, titleFromPath, withTitle } from './index.js';

/** Every `.docx` is a zip, and every zip starts `PK\x03\x04`. */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65 535. */
const EOCD_SEARCH = 22 + 0xffff;
/** A field of all ones is ZIP64's "look in the extra field"; this reader does not, and says so. */
const ZIP64_MARKER = 0xffffffff;

/**
 * What the zip's own central directory says its parts unpack to, or `null` when it cannot be read.
 *
 * **The ordinary zip bomb is a megabyte that unpacks to a terabyte**, and mammoth hands the file
 * straight to `jszip`, which has no size ceiling of its own and inflates into this process's heap. The
 * directory is read here first so the file can be refused before a single byte is inflated.
 *
 * It trusts the directory, which a hostile archive can understate — the local headers are what `jszip`
 * actually follows. That is worth saying rather than implying: this stops the bomb anybody can
 * generate with a standard tool, not one written specifically against this check. The raw-bytes cap in
 * `extractDocument` is the bound that holds regardless.
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

export async function docxToMarkdown(bytes: Buffer, relativePath: string, limits: ExtractLimits): Promise<string> {
  if (!isZip(bytes)) {
    throw new DocumentExtractionError(
      `"${relativePath}" is not a Word 2007+ document. A ".doc" file renamed to ".docx" stays the old binary format, which is not supported; re-save it as .docx.`,
    );
  }

  const unpacked = declaredUnpackedBytes(bytes);
  if (unpacked !== null && unpacked > limits.maxUnpackedBytes) {
    const claim = unpacked === Number.POSITIVE_INFINITY ? 'more than 4 GiB (ZIP64)' : `${(unpacked / (1024 * 1024)).toFixed(0)} MiB`;
    throw new DocumentExtractionError(
      `"${relativePath}" is a ${(bytes.byteLength / 1024).toFixed(0)} KiB file whose parts claim to unpack to ${claim}, over the ` +
        `${(limits.maxUnpackedBytes / (1024 * 1024)).toFixed(0)} MiB limit. A Word document does not compress like that; raise MAX_DOCX_UNPACKED_BYTES if this one really does.`,
    );
  }

  // The image is dropped and its alt text kept. Word stores every picture inside the file, so the
  // default — a `data:` URI — would put the picture's bytes into `documents.content`, base64'd and
  // a third larger than the original, for an agent to read as a wall of characters.
  //
  // Anything mammoth throws is left alone: `extractDocument` is the one place failures are named, and
  // a second message here would only differ from that one in wording.
  const result = await mammoth.convertToHtml({ buffer: bytes }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  return withTitle(htmlFragmentToMarkdown(result.value), titleFromPath(relativePath));
}
