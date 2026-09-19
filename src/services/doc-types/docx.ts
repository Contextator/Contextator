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
import { DocumentExtractionError, titleFromPath, withTitle } from './index.js';

/** Every `.docx` is a zip, and every zip starts `PK\x03\x04`. */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function docxToMarkdown(bytes: Buffer, relativePath: string): Promise<string> {
  if (!isZip(bytes)) {
    throw new DocumentExtractionError(
      `"${relativePath}" is not a Word 2007+ document. A ".doc" file renamed to ".docx" stays the old binary format, which is not supported; re-save it as .docx.`,
    );
  }

  let html: string;
  try {
    // The image is dropped and its alt text kept. Word stores every picture inside the file, so the
    // default — a `data:` URI — would put the picture's bytes into `documents.content`, base64'd and
    // a third larger than the original, for an agent to read as a wall of characters.
    const result = await mammoth.convertToHtml({ buffer: bytes }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
    html = result.value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DocumentExtractionError(`"${relativePath}" could not be read as a Word document: ${message}`);
  }

  const markdown = htmlFragmentToMarkdown(html);
  if (markdown.trim() === '') {
    throw new DocumentExtractionError(
      `"${relativePath}" holds no text. A Word file whose content is entirely images or drawings has nothing to index; export it with its text, or remove it from the source.`,
    );
  }
  return withTitle(markdown, titleFromPath(relativePath));
}
