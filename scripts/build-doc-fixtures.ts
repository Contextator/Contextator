/**
 * Builds the binary fixtures `test/doc-types.test.ts` reads: a `.pdf` with a real layout, a `.pdf`
 * that is a scan, and a `.docx`.
 *
 * **The fixtures are committed, and this script is how they were made.** It lives here rather than
 * beside them because `test/fixtures/` is excluded from the formatter and the linter — a fixture is a
 * specimen of what the world sends and must not be reformatted — and a generator is ordinary source
 * that should be held to the same bar as everything else.
 *
 * **The fixtures are committed, and this script is how they were made.** A test that asserts what a
 * PDF extractor produces is only worth reading if the PDF it reads is a real one — a stub whose text
 * was assembled in the test proves the assertion and nothing else. But a committed binary nobody can
 * regenerate is a fixture nobody can change, so the generator lives beside it. Run it with
 * `npx tsx scripts/build-doc-fixtures.ts` after editing, and commit what it writes.
 *
 * Both writers are deliberately dependency-free and deliberately small: a PDF with uncompressed
 * content streams and the base-14 Helvetica, and a stored (uncompressed) zip. Everything the
 * extractors are asked to recover — a running head, two paragraphs that wrap and hyphenate, a bullet
 * list, a column-aligned table — is positioned here by hand, the way a producer would position it.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'doc-types');

// ---------------------------------------------------------------- PDF writer

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

interface Run {
  /** Point size; the extractor reads heading level off this. */
  size: number;
  x: number;
  /** Distance from the top of the page, so the fixture reads the way the page looks. */
  top: number;
  text: string;
}

/**
 * Strings in a content stream are single-byte and the font below declares `WinAnsiEncoding`, so the
 * bullet is written as `\u0095` — the byte WinAnsi maps to U+2022, exactly as a real producer writes it.
 */
function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

function contentStream(runs: Run[]): string {
  return runs
    .map((run) => `BT /F1 ${run.size} Tf 1 0 0 1 ${run.x.toFixed(2)} ${(PAGE_HEIGHT - run.top).toFixed(2)} Tm (${escapePdfText(run.text)}) Tj ET`)
    .join('\n');
}

/** A page with no text at all — what a scan of paper is, plus the grey box the scanner produced. */
function imageOnlyStream(): string {
  return '0.85 g\n60 120 492 620 re f\n';
}

function buildPdf(pages: string[], title: string | undefined): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;
  // 1 catalog, 2 pages, then per page: page object and content object; then the font, then the info.
  const pageIds = pages.map((_, i) => 3 + i * 2);
  const contentIds = pages.map((_, i) => 4 + i * 2);
  const fontId = 3 + pageCount * 2;
  const infoId = fontId + 1;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  pages.forEach((stream, i) => {
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
    objects[contentIds[i]] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[infoId] = title ? `<< /Title (${escapePdfText(title)}) >>` : '<< >>';

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id <= infoId; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${infoId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= infoId; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${infoId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

/** Three pages of an internal handbook: running head and foot, headings, a wrapped and hyphenated paragraph, a list, a table. */
function handbookPdf(): Buffer {
  const head = (page: number): Run[] => [
    { size: 8, x: 72, top: 36, text: 'Acme Support — Internal' },
    { size: 8, x: 300, top: 756, text: `Page ${page} of 3` },
  ];

  const one: Run[] = [
    ...head(1),
    { size: 18, x: 72, top: 96, text: 'Support Handbook' },
    { size: 13, x: 72, top: 140, text: 'Escalation levels' },
    { size: 10, x: 72, top: 168, text: 'Every report opens at level one. A report is raised to level two when it blocks a customer' },
    { size: 10, x: 72, top: 183, text: 'from working, and to level three when it affects more than one customer at once. Escala-' },
    { size: 10, x: 72, top: 198, text: 'tion is a judgement the duty engineer makes and writes down.' },
    { size: 13, x: 72, top: 236, text: 'What each level owes' },
    { size: 10, x: 72, top: 264, text: '\u0095 Level one is answered during office hours.' },
    { size: 10, x: 72, top: 282, text: '\u0095 Level two is answered within the hour, every day.' },
    { size: 10, x: 72, top: 300, text: '\u0095 Level three wakes the on-call engineer.' },
  ];

  const two: Run[] = [
    ...head(2),
    { size: 13, x: 72, top: 96, text: 'Response targets' },
    { size: 10, x: 72, top: 132, text: 'Level' },
    { size: 10, x: 200, top: 132, text: 'First reply' },
    { size: 10, x: 360, top: 132, text: 'Resolution' },
    { size: 10, x: 72, top: 152, text: 'One' },
    { size: 10, x: 200, top: 152, text: 'Two working days' },
    { size: 10, x: 360, top: 152, text: 'Ten working days' },
    { size: 10, x: 72, top: 172, text: 'Two' },
    { size: 10, x: 200, top: 172, text: 'One hour' },
    { size: 10, x: 360, top: 172, text: 'Two working days' },
    { size: 10, x: 72, top: 192, text: 'Three' },
    { size: 10, x: 200, top: 192, text: 'Fifteen minutes' },
    { size: 10, x: 360, top: 192, text: 'Same day' },
    { size: 10, x: 72, top: 240, text: 'The targets are measured from the moment the report is filed, not from the moment somebody' },
    { size: 10, x: 72, top: 255, text: 'reads it.' },
  ];

  const three: Run[] = [
    ...head(3),
    { size: 13, x: 72, top: 96, text: 'Who to call' },
    { size: 10, x: 72, top: 132, text: 'The duty roster lives in the team calendar. Outside office hours the on-call engineer is the' },
    { size: 10, x: 72, top: 147, text: 'only person who may change a level three, and the change is recorded in the incident.' },
  ];

  return buildPdf([contentStream(one), contentStream(two), contentStream(three)], 'Support Handbook');
}

/**
 * One page set in two columns under a full-width title: read down the page it interleaves the two
 * columns into nonsense, and read as a layout it is two paragraphs.
 */
function twoColumnPdf(): Buffer {
  const left = [
    'The platform team spent the quarter on',
    'the queue. Two lanes replaced the single',
    'one, and a person pressing a button no',
    'longer waits behind an hour of timers.',
    'Nothing else about the queue changed.',
    'The dashboard now says how many runs',
    'are ahead of the one being waited on,',
    'and says it in the queue lane the run',
    'actually sits in rather than in total.',
  ];
  const right = [
    'Retrieval moved less. The model is the',
    'one it was, the chunk budget is the one',
    'it was, and the only number that moved',
    'was the cap on how many results one',
    'document may contribute to an answer.',
    'That cap is per document and not per',
    'source, which is the distinction the',
    'previous release got wrong and the',
    'reason two answers looked identical.',
  ];
  const runs: Run[] = [
    { size: 16, x: 60, top: 80, text: 'Quarterly Platform Brief \u0097 Q3 Summary' },
    ...left.map((text, i) => ({ size: 10, x: 60, top: 130 + i * 15, text })),
    ...right.map((text, i) => ({ size: 10, x: 330, top: 130 + i * 15, text })),
  ];
  return buildPdf([contentStream(runs)], 'Quarterly Platform Brief');
}

/** Two pages that are pictures of paper: the case the extractor has to refuse by name. */
function scannedPdf(): Buffer {
  return buildPdf([imageOnlyStream(), imageOnlyStream()], undefined);
}

/**
 * A PDF cut in half — a partial download, a truncated copy, a file half-written by a crashed tool.
 *
 * It is here for the *boundary* rather than for the reader: PDF.js answers this one with an
 * `InvalidPDFException`, which is not a type the indexer knows, and an exception of that shape
 * escaping `extractDocument` fails the whole run rather than the file. The trailer is kept so the file
 * still looks like a PDF to anything that only checks the ends of it.
 */
function damagedPdf(): Buffer {
  const whole = handbookPdf();
  return Buffer.concat([whole.subarray(0, 900), Buffer.from('\ntrailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n20\n%%EOF\n', 'latin1')]);
}

// ---------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip. A `.docx` is a zip, and nothing in the format requires deflate. */
function buildZip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time+date, fixed so the file is reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const entryHeader = Buffer.alloc(46 + name.length);
    entryHeader.writeUInt32LE(0x02014b50, 0);
    entryHeader.writeUInt16LE(20, 4);
    entryHeader.writeUInt16LE(20, 6);
    entryHeader.writeUInt32LE(0, 8);
    entryHeader.writeUInt32LE(0, 12);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(data.length, 20);
    entryHeader.writeUInt32LE(data.length, 24);
    entryHeader.writeUInt16LE(name.length, 28);
    entryHeader.writeUInt32LE(offset, 42);
    name.copy(entryHeader, 46);
    central.push(entryHeader);

    offset += local.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const paragraph = (style: string | null, text: string, extra = ''): string =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const bullet = (text: string): string => paragraph('ListParagraph', text, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');

const cell = (text: string): string => `<w:tc><w:tcPr/>${paragraph(null, text)}</w:tc>`;
const row = (cells: string[]): string => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

/** An onboarding note: heading levels, a paragraph, a bullet list, a table. */
function onboardingDocx(): Buffer {
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>` +
    paragraph('Heading1', 'Onboarding checklist') +
    paragraph(
      null,
      'A new engineer is productive on the day their access works, and not before. This note is the list somebody walks through with them.',
    ) +
    paragraph('Heading2', 'First morning') +
    bullet('Sign the handbook acknowledgement.') +
    bullet('Collect the laptop and the hardware key.') +
    bullet('Pair with the buddy on one real ticket.') +
    paragraph('Heading2', 'Accounts to open') +
    `<w:tbl><w:tblPr/><w:tblGrid/>${row(['System', 'Owner', 'Opened by'])}${row(['Payroll', 'People team', 'Day one'])}${row(['Repository', 'Platform team', 'Day one'])}${row(['Production console', 'On-call lead', 'After review'])}</w:tbl>` +
    paragraph(null, 'Anything still missing on day three is escalated to the hiring manager.') +
    '</w:body></w:document>';

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NS}>` +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>' +
    '</w:styles>';

  const numbering =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NS}>` +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '</w:numbering>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    '</Relationships>';

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/numbering.xml', data: numbering },
  ]);
}

/**
 * A zip of notes that somebody renamed to `.docx`. It passes the `PK` check — it is a real zip — and
 * mammoth then throws a plain `Error` at it, which is the second path `extractDocument`'s boundary has
 * to turn into something the indexer can report against one file instead of against the run.
 */
function renamedZipDocx(): Buffer {
  return buildZip([{ name: 'readme.txt', data: 'Notes about the onboarding process. This archive was renamed, not exported.\n' }]);
}

/**
 * A Word document that is entirely a picture: real styles, real structure, and not one word of text.
 * Word writes exactly this when somebody pastes a screenshot into an empty file and saves it, and it
 * is the case whose refusal has to tell an operator to re-export rather than merely that it failed.
 */
function picturesOnlyDocx(): Buffer {
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>` +
    '<w:p><w:pPr/><w:r><w:drawing/></w:r></w:p>' +
    '<w:p><w:pPr/><w:r><w:drawing/></w:r></w:p>' +
    '</w:body></w:document>';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NS}></w:styles>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
  ]);
}

async function main(): Promise<void> {
  const files: Array<[string, Buffer]> = [
    ['support-handbook.pdf', handbookPdf()],
    ['two-column-brief.pdf', twoColumnPdf()],
    ['scanned-invoice.pdf', scannedPdf()],
    ['damaged-report.pdf', damagedPdf()],
    ['onboarding-checklist.docx', onboardingDocx()],
    ['notes-renamed.docx', renamedZipDocx()],
    ['pictures-only.docx', picturesOnlyDocx()],
  ];
  for (const [name, data] of files) {
    await fs.writeFile(path.join(OUT, name), data);
    process.stdout.write(`${name} — ${data.byteLength} bytes, sha256 ${createHash('sha256').update(data).digest('hex').slice(0, 16)}\n`);
  }
}

await main();
