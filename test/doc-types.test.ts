import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/services/chunker.js';
import { csvToMarkdown, parseDelimited, sniffDelimiter } from '../src/services/doc-types/csv.js';
import { declaredUnpackedBytes, measureUnpackedBytes } from '../src/services/doc-types/docx.js';
import { htmlToMarkdown, promoteBlankTableHeader } from '../src/services/doc-types/html.js';
import {
  DocumentExtractionError,
  type ExtractLimits,
  checkFileSize,
  extensionOf,
  extractDocument,
  readFailure,
  titleFromPath,
  withTitle,
} from '../src/services/doc-types/index.js';
import { transformContent } from '../src/services/flavors.js';
import { SUPPORTED_EXTENSIONS, extensionMatcher } from '../src/services/fs-scan.js';
import { storedDocumentContent } from '../src/services/vector-store.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'doc-types');
const bytesOf = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

/** The product's defaults, so nothing here passes because it was given a limit the server would not. */
const LIMITS: ExtractLimits = { maxFileBytes: 32 * 1024 * 1024, maxPdfPages: 2000, maxUnpackedBytes: 256 * 1024 * 1024 };
const extract = (name: string, bytes: Buffer, limits: ExtractLimits = LIMITS): Promise<string> => extractDocument(name, bytes, limits);

/**
 * **What `read_document` would hand an agent**, and the reason this helper exists rather than a bare
 * call to `extractDocument`.
 *
 * Since [ADR-0043](../.ssot/ADR.md#adr-0043) the indexer stores `transformContent(flavor, …)` through
 * `storedDocumentContent` and the tool serves that column back. Every expectation below is therefore
 * written against the end of that pipe and not against the extractor's return value: the bar
 * [ADR-0056](../.ssot/ADR.md#adr-0056) sets is that a person can read the result, and a test that
 * asserted an intermediate string could pass while the thing a person reads was wrong.
 */
async function readable(name: string): Promise<string> {
  const markdown = await extract(name, bytesOf(name));
  const stored = storedDocumentContent(transformContent('plain', markdown), 1024 * 1024);
  expect(stored.contentTruncated).toBe(false);
  return stored.content;
}

/**
 * **Whether a phrase in a fixture can be found**, in the two places a search looks: the stored content
 * `read_document` serves, and the chunks the lexical and dense indexes are built from. A phrase that
 * survives extraction but is split across chunks, or dropped by the chunker, is not searchable.
 */
async function searchable(name: string, phrase: string): Promise<boolean> {
  const content = await readable(name);
  const { chunks } = chunkMarkdown(await extract(name, bytesOf(name)), `handbook/${name}`, { maxTokens: 400, overlapTokens: 40 });
  const flat = (text: string): string => text.replace(/\s+/g, ' ');
  return flat(content).includes(phrase) && chunks.some((chunk) => flat(chunk.content).includes(phrase));
}

/**
 * A zip whose parts inflate to `size` bytes and whose directory claims they inflate to almost nothing.
 * Written here rather than committed as a fixture: an archive built to break a reader is an artefact
 * of this test, not a specimen of what the world sends.
 */
function bombDocx(size: number, part = 'word/document.xml'): Buffer {
  const payload = deflateRawSync(Buffer.alloc(size, 0x41));
  const name = Buffer.from(part, 'utf8');

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(64, 22); // the lie: "this unpacks to 64 bytes"
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(64, 24); // the same lie, where the reader looks for it
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + payload.length, 16);
  return Buffer.concat([local, payload, central, end]);
}

interface ArchivePart {
  name: string;
  data: Buffer;
  /** 0 stores the data, 8 deflates it; anything else is written into the directory as given. */
  method?: number;
  flags?: number;
  /** What the directory claims the part unpacks to, when that should differ from the truth. */
  declared?: number;
}

/** A zip written part by part, with the knobs a hostile archive turns: a false size, a flag, a method. */
function archiveOf(parts: ArchivePart[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const method = part.method ?? 8;
    const payload = method === 8 ? deflateRawSync(part.data) : part.data;
    const declared = part.declared ?? part.data.length;
    const name = Buffer.from(part.name, 'utf8');

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(part.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(part.flags ?? 0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(declared, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);

    locals.push(local, payload);
    directory.push(entry);
    offset += local.length + payload.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');
const SLIDE_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const textBox = (text: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slideOf = (inner: string): string => `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;
const cellOf = (text: string): string => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const tableOf = (rows: string[][]): string =>
  `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows.map((r) => `<a:tr>${r.map(cellOf).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const deckOf = (slides: string[]): Buffer =>
  archiveOf([
    { name: 'ppt/presentation.xml', data: utf8(`<p:presentation ${SLIDE_NS}/>`) },
    ...slides.map((xml, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: utf8(xml) })),
  ]);

/** The spreadsheet column letters of a zero-based column: 0 → A, 26 → AA. */
const columnName = (index: number): string => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

/** The `#` lines of a document, which is the structure a reader navigates by and the chunker splits on. */
const headings = (markdown: string): string[] => markdown.split('\n').filter((line) => /^#{1,6}\s/.test(line));

/** The `| … |` lines, so a table can be asserted as a table rather than as a substring. */
const tableRows = (markdown: string): string[] => markdown.split('\n').filter((line) => line.startsWith('|'));

describe('the document type registry', () => {
  it('has a transform for every supported extension, and nothing else', async () => {
    // Every listed extension has to reach *a* transform. What that transform then says about an empty
    // buffer is its own business — several refuse it, which is the point of them.
    for (const ext of SUPPORTED_EXTENSIONS) {
      await extract(`a.${ext}`, Buffer.from('')).catch((err: unknown) => {
        expect(err).toBeInstanceOf(DocumentExtractionError);
        expect((err as Error).message).not.toMatch(/no supported file type/);
      });
    }
    await expect(extract('notes.rtf', Buffer.from('x'))).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(extract('Makefile', Buffer.from('x'))).rejects.toThrow(/no supported file type/);
  });

  it('accepts the new extensions in the scanner filter, and still rejects what is not on the list', () => {
    const matcher = extensionMatcher(['md', 'html', 'htm', 'csv', 'docx', 'pdf']);
    for (const name of ['a.md', 'a.html', 'a.HTM', 'a.csv', 'report.docx', 'book.PDF']) expect(matcher.test(name)).toBe(true);
    for (const name of ['a.doc', 'a.pptx', 'a.xlsx', 'a.htmlx', 'a.pdf.bak']) expect(matcher.test(name)).toBe(false);
    // ADR-0115: the newer types are on the list, and are matched once a source opts in.
    const opted = extensionMatcher(['pptx', 'xlsx', 'ipynb', 'rst', 'adoc', 'asciidoc']);
    for (const name of ['deck.pptx', 'book.XLSX', 'nb.ipynb', 'guide.rst', 'manual.adoc', 'manual.asciidoc']) expect(opted.test(name)).toBe(true);
    for (const name of ['deck.ppt', 'book.xls', 'guide.rest', 'manual.asc']) expect(opted.test(name)).toBe(false);
  });

  it('leaves Markdown exactly as it was, byte for byte', async () => {
    const source = '---\ntitle: Kept\n---\n\n# Kept\n\n﻿text with a bom in the middle\n';
    expect(await extract('notes.md', Buffer.from(source, 'utf8'))).toBe(source);
  });

  it('names a document the format knows nothing about after its file', () => {
    expect(titleFromPath('docs/quarterly-report.pdf')).toBe('Quarterly Report');
    expect(withTitle('a paragraph', 'Quarterly Report')).toBe('# Quarterly Report\n\na paragraph');
    expect(withTitle('# Already titled\n\nbody', 'Quarterly Report')).toBe('# Already titled\n\nbody');
    // A `#` inside a fence is a shell comment, not this document's title.
    expect(withTitle('```\n# not a heading\n```', 'Runbook')).toBe('# Runbook\n\n```\n# not a heading\n```');
    expect(extensionOf('a/b/c.TAR.GZ')).toBe('gz');
    expect(extensionOf('Makefile')).toBe('');
  });
});

describe('.html', () => {
  it('reads as the page did: headings, a list, a table, code and links', async () => {
    expect(await readable('release-notes.html')).toBe(
      [
        '[Docs](/docs/) / [Releases](/docs/releases/)',
        '',
        '# Release 4.2',
        '',
        'This release closes the gap between what the scheduler *reports* and what it **does**. Upgrading is safe from 4.0 and 4.1; from 3.x, read [the 4.0 notes](/docs/releases/4.0/) first.',
        '',
        '## Fixed',
        '',
        '-   A queued run no longer loses its place when a second one is requested.',
        '-   Webhook deliveries are de-duplicated on their id, not on their `timestamp`.',
        '-   ~~Retry storms after a failed sync.~~ Still open — tracked as #4117.',
        '',
        '## Limits that moved',
        '',
        '| Setting | Was | Now |',
        '| --- | --- | --- |',
        '| Queue depth | 64  | 256 |',
        '| Delivery timeout | 5 s | 30 s |',
        '| Retained runs | 50  | 500 |',
        '',
        '## Upgrading',
        '',
        'Stop the workers, apply the migration, then start them again:',
        '',
        '```',
        'systemctl stop acme-worker',
        'acme migrate --to 4.2',
        'systemctl start acme-worker',
        '```',
        '',
        '![Queue depth before and after the change]()',
        '',
        'Queue depth over the first week on 4.2.',
        '',
        'Questions go to [support@example.com](mailto:support@example.com).',
        '',
        '© 2026 Acme. Internal documentation.',
      ].join('\n'),
    );
  });

  it('keeps the heading levels and the table as structure', async () => {
    const markdown = await readable('release-notes.html');
    expect(headings(markdown)).toEqual(['# Release 4.2', '## Fixed', '## Limits that moved', '## Upgrading']);
    expect(tableRows(markdown)).toHaveLength(5);
    expect(tableRows(markdown)[0]).toBe('| Setting | Was | Now |');
  });

  it('indexes no stylesheet, no script and no image payload', async () => {
    const markdown = await readable('release-notes.html');
    expect(markdown).not.toContain('font-family');
    expect(markdown).not.toContain('window.analytics');
    expect(markdown).not.toContain('base64');
    // The `<title>` is read for the title and never as a line of the page's own text.
    expect(markdown).not.toContain('Release notes —');
  });

  it('uses <title> only when the page has no heading of its own', async () => {
    const withHeading = await htmlToMarkdown(Buffer.from('<title>Tab name</title><h1>Page name</h1><p>body</p>'), 'page.html');
    expect(withHeading).toBe('# Page name\n\nbody');
    const without = await htmlToMarkdown(Buffer.from('<title>Install &amp; upgrade</title><p>body</p>'), 'install.html');
    expect(without).toBe('# Install & upgrade\n\nbody');
    const neither = await htmlToMarkdown(Buffer.from('<p>body</p>'), 'guides/deep-dive.html');
    expect(neither).toBe('# Deep Dive\n\nbody');
  });

  /**
   * An architecture diagram drawn as inline SVG carries its labels as `<text>`, and its `<title>` and
   * `<desc>` say what it shows. Those are searchable; the geometry around them is not indexed.
   */
  it('keeps the text an inline SVG shows and drops the drawing', async () => {
    expect(await searchable('architecture-diagram.html', 'ledger-settlement-7')).toBe(true);
    expect(await searchable('architecture-diagram.html', 'Intake gateway')).toBe(true);
    expect(await searchable('architecture-diagram.html', 'Ingestion pipeline overview')).toBe(true);
    expect(await searchable('architecture-diagram.html', 'hands each batch to the reconciliation worker')).toBe(true);

    const markdown = await readable('architecture-diagram.html');
    // `<tspan>`s of one label are one line, and the label is not repeated by a nested walk.
    expect(markdown).toContain('Reconciliation worker');
    expect(markdown.match(/Reconciliation worker/g)).toHaveLength(1);
    // Path data, gradients and attributes are not text.
    expect(markdown).not.toContain('M190');
    expect(markdown).not.toContain('stop-color');
    expect(markdown).not.toContain('linearGradient');
    // The page's own text around the drawing is untouched, in order.
    expect(markdown.indexOf('only place the queue names')).toBeLessThan(markdown.indexOf('Intake gateway'));
    expect(markdown.indexOf('Intake gateway')).toBeLessThan(markdown.indexOf('Retries are described'));
    expect(headings(markdown)).toEqual(['# Ingestion architecture']);
  });

  it('drops an SVG that has no text at all', async () => {
    const markdown = await htmlToMarkdown(
      Buffer.from('<h1>Icons</h1><p>before</p><svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg><p>after</p>'),
      'icons.html',
    );
    expect(markdown).toBe('# Icons\n\nbefore\n\nafter');
  });

  /**
   * **An icon is not a diagram.** Doc sites put an SVG with a `<title>` beside every heading (the
   * anchor link) and inside sentences (the copy button). Its words are a tooltip: they stay on the line
   * they sit in, and `aria-hidden` ones are not indexed at all — the page said so itself.
   */
  const page = (body: string): Buffer => Buffer.from(`<html><head><title>Guide</title></head><body>${body}</body></html>`);

  it('drops an aria-hidden icon without splitting the heading it sits in', async () => {
    const markdown = await htmlToMarkdown(
      page('<h2>Setup <a href="#setup"><svg aria-hidden="true"><title>Link to this section</title><path/></svg></a></h2><p>Body text.</p>'),
      'guide.html',
    );
    expect(markdown).toBe('# Guide\n\n## Setup [](#setup)\n\nBody text.');
    expect(headings(markdown)).toEqual(['# Guide', '## Setup [](#setup)']);
  });

  it('drops an aria-hidden icon without splitting the sentence it sits in', async () => {
    const markdown = await htmlToMarkdown(
      page('<p>Press <svg aria-hidden="true" viewBox="0 0 8 8"><title>Copy</title><path d="M0 0h8v8"/></svg> to copy the command.</p>'),
      'guide.html',
    );
    expect(markdown).toBe('# Guide\n\nPress  to copy the command.');
    expect(markdown).not.toContain('Copy');
  });

  it('keeps the words of an icon that is not hidden, on the line it sits in', async () => {
    const heading = await htmlToMarkdown(
      page('<h2>Setup <a href="#setup"><svg><title>Link to this section</title><path/></svg></a></h2><p>Body text.</p>'),
      'guide.html',
    );
    expect(heading).toBe('# Guide\n\n## Setup [Link to this section](#setup)\n\nBody text.');

    const sentence = await htmlToMarkdown(page('<p>Press <svg><title>Copy</title><desc>Clipboard</desc><path/></svg> to copy.</p>'), 'guide.html');
    expect(sentence).toBe('# Guide\n\nPress Copy Clipboard to copy.');

    // Between blocks but drawing no `<text>`, a logo is still a tooltip and not a paragraph of labels.
    const logo = await htmlToMarkdown(page('<p>before</p><svg><title>Logo</title><desc>Company mark</desc><path/></svg><p>after</p>'), 'guide.html');
    expect(logo).toBe('# Guide\n\nbefore\n\nLogo Company mark\n\nafter');
  });

  it('gives a labelled diagram inside a table cell its labels without breaking the table', async () => {
    const markdown = await htmlToMarkdown(
      page(
        '<table><tr><th>Stage</th><th>Shape</th></tr><tr><td>Intake</td><td><svg><text>Queue A</text><text>Queue B</text></svg></td></tr></table>',
      ),
      'guide.html',
    );
    expect(markdown).toContain('| Intake | Queue A Queue B |');
  });

  it('keeps a labelled diagram in the sentence of the list item it sits in', async () => {
    const inline = await htmlToMarkdown(page('<ul><li>Step <svg><text>A</text><text>B</text></svg> done</li></ul>'), 'guide.html');
    expect(inline).toMatch(/^-\s+Step A B done$/m);

    // Alone in its item, the same drawing is still a diagram: each label gets a paragraph.
    const alone = await htmlToMarkdown(page('<ul><li><svg><text>A</text><text>B</text></svg></li></ul>'), 'guide.html');
    expect(alone).not.toMatch(/A B/);
    expect(alone).toMatch(/A\n\s*\n\s*B/);
  });

  it('moves a table header up when the converter produced a blank one', () => {
    const blank = ['|     |     |', '| --- | --- |', '| Name | Role |', '| Ada | Engineer |'].join('\n');
    expect(promoteBlankTableHeader(blank)).toBe(['| Name | Role |', '| --- | --- |', '| Ada | Engineer |'].join('\n'));
    const real = ['| Name | Role |', '| --- | --- |', '| Ada | Engineer |'].join('\n');
    expect(promoteBlankTableHeader(real)).toBe(real);
  });
});

describe('.docx', () => {
  it('reads as the document did: styled headings, a numbered-format list, a table', async () => {
    expect(await readable('onboarding-checklist.docx')).toBe(
      [
        '# Onboarding checklist',
        '',
        'A new engineer is productive on the day their access works, and not before. This note is the list somebody walks through with them.',
        '',
        '## First morning',
        '',
        '-   Sign the handbook acknowledgement.',
        '-   Collect the laptop and the hardware key.',
        '-   Pair with the buddy on one real ticket.',
        '',
        '## Accounts to open',
        '',
        '| System | Owner | Opened by |',
        '| --- | --- | --- |',
        '| Payroll | People team | Day one |',
        '| Repository | Platform team | Day one |',
        '| Production console | On-call lead | After review |',
        '',
        'Anything still missing on day three is escalated to the hiring manager.',
      ].join('\n'),
    );
  });

  it('keeps the heading levels, the bullets and the table as structure', async () => {
    const markdown = await readable('onboarding-checklist.docx');
    expect(headings(markdown)).toEqual(['# Onboarding checklist', '## First morning', '## Accounts to open']);
    expect(markdown.split('\n').filter((line) => line.startsWith('-'))).toHaveLength(3);
    expect(tableRows(markdown)).toHaveLength(5);
  });

  it('refuses a file that is not a Word 2007+ document, and says which format it is not', async () => {
    const renamed = Buffer.from('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 old binary word file', 'latin1');
    await expect(extract('legacy.docx', renamed)).rejects.toThrow(/not a Word 2007\+ document/);
  });
});

describe('.csv', () => {
  it('reads as a table, with the header above the rows', async () => {
    expect(await readable('service-owners.csv')).toBe(
      [
        '# Service Owners',
        '',
        '| Service | Owner | Escalation contact | Runbook |',
        '| --- | --- | --- | --- |',
        '| billing-api | Payments, core | Duty engineer (pager) | https://runbooks.example.com/billing-api |',
        '| search-indexer | Platform | On-call lead | https://runbooks.example.com/search-indexer |',
        '| notify | Growth | Weekday hours only<br>see the roster | https://runbooks.example.com/notify |',
        '| invoice-pdf | Payments, core | Duty engineer (pager) | https://runbooks.example.com/invoice-pdf |',
      ].join('\n'),
    );
  });

  it('keeps the heading and the table as structure, not as a row dump', async () => {
    const markdown = await readable('service-owners.csv');
    expect(headings(markdown)).toEqual(['# Service Owners']);
    expect(tableRows(markdown)).toHaveLength(6);
    for (const row of tableRows(markdown)) expect(row.split('|')).toHaveLength(6);
  });

  it('parses the quoting rules a spreadsheet writes', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('"a,b",c', ',')).toEqual([['a,b', 'c']]);
    expect(parseDelimited('"say ""hi""",c', ',')).toEqual([['say "hi"', 'c']]);
    expect(parseDelimited('"two\r\nlines",c', ',')).toEqual([['two\nlines', 'c']]);
    // A quote that does not open the field is a literal quote, which is what a spreadsheet reads back.
    expect(parseDelimited('a"b"c,d', ',')).toEqual([['a"b"c', 'd']]);
    expect(parseDelimited('a,,c', ',')).toEqual([['a', '', 'c']]);
    expect(parseDelimited('', ',')).toEqual([]);
  });

  it('sniffs the delimiter without being fooled by one inside a quoted field', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(sniffDelimiter('"Smith; Ada",Engineer\n"Lee; Bo",Designer')).toBe(',');
    expect(sniffDelimiter('one column\nonly')).toBe(',');
  });

  it('escapes what would otherwise end a cell, and strips a spreadsheet BOM', async () => {
    const markdown = await csvToMarkdown(Buffer.from('﻿Name,Pattern\nlogs,"a|b"\n', 'utf8'), 'filters.csv');
    expect(markdown).toBe(['# Filters', '', '| Name | Pattern |', '| --- | --- |', '| logs | a\\|b |'].join('\n'));
  });

  it('names a column the export left unnamed after its position', async () => {
    const markdown = await csvToMarkdown(Buffer.from('Service,,Runbook\nbilling,eu-west,https://x\n', 'utf8'), 'rows.csv');
    expect(markdown).toContain('| Service | Column 2 | Runbook |');
  });

  it('repeats the header in every section of a long table', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => `row-${i},${i}`).join('\n');
    const markdown = await csvToMarkdown(Buffer.from(`Name,Index\n${rows}\n`, 'utf8'), 'long.csv');
    expect(headings(markdown)).toEqual(['# Long', '## Rows 1–200', '## Rows 201–400', '## Rows 401–450']);
    expect(markdown.split('| Name | Index |')).toHaveLength(4);
  });
});

describe('.pdf', () => {
  it('reads as the page did: headings, a paragraph rejoined across line ends, a list, a table', async () => {
    expect(await readable('support-handbook.pdf')).toBe(
      [
        '# Support Handbook',
        '',
        '## Escalation levels',
        '',
        'Every report opens at level one. A report is raised to level two when it blocks a customer from working, and to level three when it affects more than one customer at once. Escalation is a judgement the duty engineer makes and writes down.',
        '',
        '## What each level owes',
        '',
        '- Level one is answered during office hours.',
        '- Level two is answered within the hour, every day.',
        '- Level three wakes the on-call engineer.',
        '',
        '## Response targets',
        '',
        '| Level | First reply | Resolution |',
        '| --- | --- | --- |',
        '| One | Two working days | Ten working days |',
        '| Two | One hour | Two working days |',
        '| Three | Fifteen minutes | Same day |',
        '',
        'The targets are measured from the moment the report is filed, not from the moment somebody reads it.',
        '',
        '## Who to call',
        '',
        'The duty roster lives in the team calendar. Outside office hours the on-call engineer is the only person who may change a level three, and the change is recorded in the incident.',
      ].join('\n'),
    );
  });

  it('keeps the heading levels, the bullets and the table as structure', async () => {
    const markdown = await readable('support-handbook.pdf');
    expect(headings(markdown)).toEqual([
      '# Support Handbook',
      '## Escalation levels',
      '## What each level owes',
      '## Response targets',
      '## Who to call',
    ]);
    expect(markdown.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(3);
    expect(tableRows(markdown)).toHaveLength(5);
    expect(tableRows(markdown)[0]).toBe('| Level | First reply | Resolution |');
  });

  it('drops the running head and foot, and undoes the hyphen the line break introduced', async () => {
    const markdown = await readable('support-handbook.pdf');
    expect(markdown).not.toContain('Acme Support');
    expect(markdown).not.toMatch(/Page \d of 3/);
    expect(markdown).toContain('at once. Escalation is a judgement');
    expect(markdown).not.toContain('Escala-');
  });

  it('reads a two-column page down one column and then the other', async () => {
    expect(await readable('two-column-brief.pdf')).toBe(
      [
        '# Quarterly Platform Brief — Q3 Summary',
        '',
        'The platform team spent the quarter on the queue. Two lanes replaced the single one, and a person pressing a button no longer waits behind an hour of timers. Nothing else about the queue changed. The dashboard now says how many runs are ahead of the one being waited on, and says it in the queue lane the run actually sits in rather than in total.',
        '',
        'Retrieval moved less. The model is the one it was, the chunk budget is the one it was, and the only number that moved was the cap on how many results one document may contribute to an answer. That cap is per document and not per source, which is the distinction the previous release got wrong and the reason two answers looked identical.',
      ].join('\n'),
    );
  });

  it('refuses a PDF with no text layer by name, instead of indexing an empty document', async () => {
    const promise = extract('scanned-invoice.pdf', bytesOf('scanned-invoice.pdf'));
    await expect(promise).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(promise).rejects.toThrow(/no text layer/);
    await expect(promise).rejects.toThrow(/character recognition is out of scope/);
  });

  it('refuses a file that is not a PDF at all', async () => {
    await expect(extract('broken.pdf', Buffer.from('not a pdf, just some bytes'))).rejects.toBeInstanceOf(DocumentExtractionError);
  });
});

/**
 * **Is the text of a footnote searchable?** Measured, not assumed, on one fixture per format whose
 * only copy of the phrase "quarterly reconciliation ledger" is the footnote. Both answers are yes as
 * of 0.2.1: mammoth writes a `.docx`'s footnotes as a list at the end of the document, and a PDF has no
 * footnotes at all — the note is text set small at the foot of the page, which the extractor reads
 * like any other line. If either of these turns red, the footnote went missing; that is a regression,
 * not a test to relax.
 */
describe('.pptx', () => {
  const NAME = 'platform-roadmap.pptx';

  it('gives each slide its own section, in the presentation order and not the file order', async () => {
    const markdown = await readable(NAME);
    expect(headings(markdown)).toEqual([
      '# Platform Roadmap Review',
      '## Slide 1: Platform Roadmap',
      '## Slide 2: Cutover Plan',
      '## Slide 3: Open Risks',
    ]);
  });

  it('puts the speaker notes under their slide, on a Notes line', async () => {
    const markdown = await readable(NAME);
    const cutover = markdown.slice(markdown.indexOf('## Slide 2'), markdown.indexOf('## Slide 3'));
    expect(cutover).toContain('- Freeze writes on the legacy ledger');
    expect(cutover).toContain('Notes: Mention the pelican rollback rehearsal and the Friday freeze window.');
    // Only that slide has notes, and the notes page's slide number is not a note.
    expect(markdown.match(/^Notes:/gm)).toHaveLength(1);
    expect(markdown).not.toMatch(/Notes: .*\b7\b/);
  });

  it('reads a table as a table and leaves the slide-number placeholder out', async () => {
    const markdown = await readable(NAME);
    expect(tableRows(markdown)).toEqual(['| Risk | Owner |', '| --- | --- |', '| Journal lag | Ingrid |', '| Quota exhaustion | Tomas |']);
    expect(markdown).not.toMatch(/^2$/m);
  });

  it('can be found by a phrase from a slide and by one from the notes', async () => {
    expect(await searchable(NAME, 'Replay the journal into the new cluster')).toBe(true);
    expect(await searchable(NAME, 'pelican rollback rehearsal')).toBe(true);
  });

  it('refuses a zip that is not a presentation, and a file that is not a zip', async () => {
    await expect(extract('book.pptx', bytesOf('warehouse-inventory.xlsx'))).rejects.toThrow(/not a PowerPoint presentation/);
    await expect(extract('old.pptx', Buffer.from('\xd0\xcf\x11\xe0 an old binary deck'))).rejects.toThrow(/not a zip archive/);
  });
});

describe('.xlsx', () => {
  const NAME = 'warehouse-inventory.xlsx';

  it('gives each visible sheet its own section, as a table', async () => {
    const markdown = await readable(NAME);
    expect(headings(markdown)).toEqual(['# Warehouse Inventory', '## Stock', '## Sites']);
    expect(tableRows(markdown)).toEqual([
      '| Item | Quantity | Total |',
      '| --- | --- | --- |',
      '| Anvil | 12 | 480 |',
      '| Crowbar | 30 | 210 |',
      '| Warehouse | Reorder level |',
      '| --- | --- |',
      '| Rotterdam | 75 |',
    ]);
  });

  it('skips a hidden sheet entirely', async () => {
    const markdown = await readable(NAME);
    expect(markdown).not.toContain('Vault');
    expect(markdown).not.toContain('Hiddenvault-ledger');
  });

  it('reads the cached value of a formula and never the formula', async () => {
    const markdown = await readable(NAME);
    expect(markdown).toContain('| Anvil | 12 | 480 |');
    expect(markdown).not.toMatch(/B2\*40|SUM\(/);
  });

  it('can be found by a cell value', async () => {
    expect(await searchable(NAME, 'Rotterdam | 75')).toBe(true);
  });

  it('refuses a zip that is not a workbook', async () => {
    await expect(extract('deck.xlsx', bytesOf('platform-roadmap.pptx'))).rejects.toThrow(/not an Excel workbook/);
  });
});

describe('.ipynb', () => {
  const NAME = 'analysis-notebook.ipynb';

  it('keeps markdown and code cells and leaves outputs and raw cells out', async () => {
    const markdown = await readable(NAME);
    expect(headings(markdown)).toEqual(['# Latency Investigation', '## Conclusion']);
    expect(markdown).toContain("```python\nimport pandas as pd\nframe = pd.read_csv('latency.csv')\nframe.describe()\n```");
    expect(markdown).not.toContain('SECRET-OUTPUT-MARKER');
    expect(markdown).not.toContain('raw cell that is not content');
  });

  it('can be found by a phrase from a markdown cell', async () => {
    expect(await searchable(NAME, 'before and after the vortexcache rollout')).toBe(true);
  });

  it('refuses JSON that is not a notebook, as a refusal naming the file', async () => {
    await expect(extract('broken.ipynb', Buffer.from('{ not json'))).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(extract('empty.ipynb', Buffer.from('{"cells": []}'))).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it('reads a version 3 notebook', async () => {
    const v3 = JSON.stringify({
      nbformat: 3,
      worksheets: [
        {
          cells: [
            { cell_type: 'heading', level: 1, source: ['Old Notebook'] },
            { cell_type: 'markdown', source: ['Legacy text about the zebrafish pipeline.'] },
            { cell_type: 'code', language: 'python', input: ['print(1)'], outputs: [{ text: ['LEAKED-V3'] }] },
          ],
        },
      ],
    });
    const markdown = await extract('old.ipynb', Buffer.from(v3));
    expect(markdown).toContain('zebrafish pipeline');
    expect(markdown).toContain('print(1)');
    expect(markdown).not.toContain('LEAKED-V3');
  });
});

describe('.rst', () => {
  const NAME = 'deployment-guide.rst';

  it('keeps the heading hierarchy by order of appearance', async () => {
    expect(headings(await readable(NAME))).toEqual(['# Deployment Guide', '## Overview', '### Prerequisites', '## Installation', '## Configuration']);
  });

  it('turns code, admonitions, links and tables into their Markdown forms', async () => {
    const markdown = await readable(NAME);
    expect(markdown).toContain('```yaml\nreplicas: 3\nport: 8080\n```');
    expect(markdown).toContain('curl -fsSL https://example.com/install.sh | sh');
    expect(markdown).toContain('**Note:** Back up the `/var/lib/quokka` directory before upgrading.');
    expect(markdown).toContain('[the runbook](https://example.com/runbook)');
    expect(tableRows(markdown)).toContain('| workers | 4 | per CPU |');
    // Directives that drive the toolchain and carry no text are dropped.
    expect(markdown).not.toContain('contents::');
    expect(markdown).not.toContain('internal-target');
  });

  it('can be found by a phrase from the prose', async () => {
    expect(await searchable(NAME, 'ships as a single container')).toBe(true);
  });

  it('survives a pathological nesting of directives without overflowing the stack', async () => {
    const deep = Array.from({ length: 5000 }, (_, i) => `${' '.repeat(Math.min(i, 400))}.. note::`).join('\n');
    await expect(extract('deep.rst', Buffer.from(`Title\n=====\n\n${deep}\n\nbody text\n`))).resolves.toContain('# Title');
  });
});

describe('.adoc', () => {
  const NAME = 'operations-manual.adoc';

  it('keeps the heading hierarchy and drops the attribute entries', async () => {
    const markdown = await readable(NAME);
    expect(headings(markdown)).toEqual(['# Operations Manual', '## Overview', '## Procedures', '### Rotating credentials']);
    expect(markdown).not.toContain(':author:');
    expect(markdown).not.toContain('Platform Team');
  });

  it('converts a `.asciidoc` file exactly as it converts the same bytes under `.adoc` (#26)', async () => {
    expect(await extract('operations-manual.asciidoc', bytesOf(NAME))).toBe(await extract(NAME, bytesOf(NAME)));
  });

  it('substitutes attributes and converts macros, lists, code, tables and admonitions', async () => {
    const markdown = await readable(NAME);
    expect(markdown).toContain('The marmot scheduler runs **nightly**');
    expect(markdown).toContain('[the status page](https://example.com/status)');
    expect(markdown).toContain('**Note:** Never restart the scheduler during the reconciliation window.');
    expect(markdown).toContain('```bash\nmarmot rotate --all\n```');
    expect(tableRows(markdown)).toEqual(['| Dataset | Retention |', '| --- | --- |', '| Audit log | 400 days |', '| Metrics | 30 days |']);
    expect(markdown).toContain('**Escalation**: Page the on-call engineer.');
  });

  it('drops comments', async () => {
    expect(await readable(NAME)).not.toContain('internal reviewer comment');
  });

  it('can be found by a phrase from the prose', async () => {
    expect(await searchable(NAME, 'Update the secret store')).toBe(true);
  });
});

describe('the zip guard on the OOXML types (ADR-0115)', () => {
  const SMALL = { ...LIMITS, maxUnpackedBytes: 1024 };

  it.each([
    ['platform-roadmap.pptx', 'a.pptx'],
    ['warehouse-inventory.xlsx', 'a.xlsx'],
  ])('refuses %s past the declared limit, before inflating any part', async (fixture, name) => {
    await expect(extract(name, bytesOf(fixture), SMALL)).rejects.toThrow(/declare that they unpack past the limit.*MAX_DOCX_UNPACKED_BYTES/);
  });

  it('does not inflate when the declaration alone is over the limit', async () => {
    // The part is not valid DEFLATE: had it been inflated, the refusal would read "damaged part".
    const raw = archiveOf([{ name: 'ppt/presentation.xml', data: utf8('this is not a deflate stream'), method: 0, declared: 10 * 1024 * 1024 }]);
    raw.writeUInt16LE(8, 8); // local header: deflate
    raw.writeUInt16LE(8, raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // directory: deflate
    await expect(extract('a.pptx', raw, { ...LIMITS, maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(/declare that they unpack/);
  });

  it('refuses ZIP64 markers, an encrypted part and a compression method it does not read', async () => {
    const zip64 = archiveOf([{ name: 'ppt/presentation.xml', data: utf8('<p/>'), declared: 0xffffffff }]);
    await expect(extract('a.pptx', zip64)).rejects.toThrow(/ZIP64/);

    const encrypted = archiveOf([{ name: 'ppt/presentation.xml', data: utf8('<p/>'), flags: 1 }]);
    await expect(extract('a.pptx', encrypted)).rejects.toThrow(/password-protected/);

    const bzip = archiveOf([{ name: 'xl/workbook.xml', data: utf8('<workbook/>'), method: 12 }]);
    await expect(extract('a.xlsx', bzip)).rejects.toThrow(/method this product does not read/);
  });

  it('bounds a stored part by what it holds, not by what the directory says', async () => {
    const stored = archiveOf([{ name: 'ppt/presentation.xml', data: Buffer.alloc(2 * 1024 * 1024, 0x41), method: 0, declared: 64 }]);
    await expect(extract('a.pptx', stored, { ...LIMITS, maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(/actually unpack past the limit/);
  });

  it('shares one budget between the parts, so many small lies add up', async () => {
    const half = Buffer.alloc(600 * 1024, 0x41);
    const deck = archiveOf([
      { name: 'ppt/presentation.xml', data: half, declared: 64 },
      { name: 'ppt/slides/slide1.xml', data: half, declared: 64 },
    ]);
    await expect(extract('a.pptx', deck, { ...LIMITS, maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(/actually unpack past the limit/);
    // Either part alone is within the budget, so it is the sum that is refused.
    const one = archiveOf([{ name: 'ppt/presentation.xml', data: half, declared: 64 }]);
    await expect(extract('a.pptx', one, { ...LIMITS, maxUnpackedBytes: 1024 * 1024 })).rejects.not.toThrow(/actually unpack/);
  });

  it.each([
    ['a.pptx', 'ppt/presentation.xml'],
    ['a.xlsx', 'xl/workbook.xml'],
  ])('refuses a %s that lies about its size, by bounding what it really unpacks to', async (name, part) => {
    const bomb = bombDocx(64 * 1024 * 1024, part);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    await expect(extract(name, bomb, { ...LIMITS, maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(/actually unpack past the limit/);
  });

  it('turns a damaged or truncated archive into a refusal, not a crash', async () => {
    const full = bytesOf('warehouse-inventory.xlsx');
    await expect(extract('cut.xlsx', full.subarray(0, full.length - 40))).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(extract('cut.pptx', full.subarray(0, 12))).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it('refuses a workbook whose sheet renders far past the converted-file ceiling', async () => {
    // One cell on each of 2 000 rows, every one in a column of its own: 2 000 columns, padded on every row.
    const rows = Array.from(
      { length: 2000 },
      (_, i) => `<row r="${i + 1}"><c r="${columnName(i)}${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`,
    );
    const book = archiveOf([
      {
        name: 'xl/workbook.xml',
        data: utf8(
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Wide" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: utf8(
          '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
      },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`) },
    ]);
    const limits = { ...LIMITS, maxFileBytes: 4 * 1024 * 1024 };
    expect(book.byteLength).toBeLessThan(limits.maxFileBytes / 100);
    await expect(extract('wide.xlsx', book, limits)).rejects.toThrow(/renders to more than/);
    // The workbook is fine when the ceiling is not in the way: it is the render that was refused.
    await expect(extract('wide.xlsx', book)).resolves.toContain('## Wide');
  });
});

describe('what a small file may render to (ADR-0115 §4)', () => {
  /** A table whose first row is `width` cells wide and whose next `width` rows are one cell each. */
  const padded = (width: number): Buffer =>
    deckOf([slideOf(tableOf([Array.from({ length: width }, () => 'x'), ...Array.from({ length: width }, () => ['x'])]))]);

  it('refuses a 1.6 KB presentation that would render to 16 MB', async () => {
    const attack = padded(2000);
    expect(attack.byteLength).toBeLessThan(2048);
    const limits = { ...LIMITS, maxFileBytes: 4 * 1024 * 1024 };
    await expect(extract('attack.pptx', attack, limits)).rejects.toThrow(/renders to more than the 4 MiB/);
    await expect(extract('attack.pptx', attack, limits)).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it('refuses a larger one at the default ceiling, without building it', async () => {
    const attack = padded(20_000);
    expect(attack.byteLength).toBeLessThan(64 * 1024);
    const started = Date.now();
    await expect(extract('attack.pptx', attack)).rejects.toThrow(/renders to more than the 32 MiB/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('still renders an ordinary wide table', async () => {
    const deck = deckOf([
      slideOf(
        tableOf([
          ['A', 'B', 'C'],
          ['1', '2', '3'],
        ]),
      ),
    ]);
    expect(tableRows(await extract('ok.pptx', deck))).toEqual(['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |']);
  });

  it('does not let a paragraph that is only a code fence swallow the slides after it', async () => {
    const deck = deckOf([slideOf(textBox('```')), slideOf(textBox('~~~ shell')), slideOf(textBox('Later slide text'))]);
    const markdown = await extract('fence.pptx', deck);
    expect(markdown.split('\n').filter((line) => /^(`{3}|~{3})/.test(line))).toEqual([]);
    expect(headings(markdown)).toEqual(['# Fence', '## Slide 1', '## Slide 2', '## Slide 3']);
    const { chunks } = chunkMarkdown(markdown, 'fence.pptx', { maxTokens: 400, overlapTokens: 40 });
    expect(chunks.map((c) => c.content).join('\n')).toContain('Later slide text');
  });

  // 357 bytes: five levels of ten references, then ten paragraphs of the last. It is 11 000 023 characters.
  const laughs = (): string => {
    const lines = [':a0: lorem ipsum'];
    for (let level = 1; level <= 5; level++) lines.push(`:a${level}: ${`{a${level - 1}}`.repeat(10)}`);
    lines.push('', ...Array.from({ length: 10 }, () => '{a5}\n'));
    return lines.join('\n');
  };

  it('does not expand attributes that refer to attributes into megabytes', async () => {
    const attack = Buffer.from(laughs());
    expect(attack.byteLength).toBeLessThan(400);
    const markdown = await extract('laughs.adoc', attack);
    expect(markdown.length).toBeLessThan(100_000);
    // What would not fit is not defined, so its references stay as written, as for any unknown attribute.
    expect(markdown).toContain('{a3}');
  });

  it('refuses many references to a large attribute on one line', async () => {
    const value = 'x'.repeat(4000);
    const line = '{big}'.repeat(200);
    const source = `:big: ${value}\n\n${Array.from({ length: 20 }, () => `${line}\n`).join('\n')}`;
    const limits = { ...LIMITS, maxFileBytes: 4 * 1024 * 1024 };
    expect(Buffer.byteLength(source)).toBeLessThan(limits.maxFileBytes);
    await expect(extract('many.adoc', Buffer.from(source), limits)).rejects.toThrow(/renders to more than/);
  });

  it('keeps an ordinary attribute chain', async () => {
    const markdown = await extract('chain.adoc', Buffer.from(':product: Marmot\n:long: {product} Scheduler\n\nThe {long} runs nightly.\n'));
    expect(markdown).toContain('The Marmot Scheduler runs nightly.');
  });
});

/**
 * **The multiplier is the input's to choose, and so is paid for as the output is written** (ADR-0115 §4).
 * Each case below is a few kilobytes that renders to far more than the ceiling by *repeating* something
 * small: a shared string, a padded column, a quote marker. The refusal must be the budget's, raised while the
 * output is written, and quick — not a `RangeError` out of `join`, and not seconds spent building the result.
 */
describe('output that repetition multiplies (ADR-0115 §4)', () => {
  const SMALL = { ...LIMITS, maxFileBytes: 4 * 1024 * 1024 };
  const refused = /renders to more than the \d+ MiB/;

  /** A workbook whose one sheet holds `sheetData`, with `shared` as its shared strings. */
  const workbookOf = (sheetData: string, shared?: string): Buffer =>
    archiveOf([
      {
        name: 'xl/workbook.xml',
        data: utf8(
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: utf8(
          '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
      },
      ...(shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: utf8(shared) }]),
      { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet><sheetData>${sheetData}</sheetData></worksheet>`) },
    ]);

  async function refusal(name: string, bytes: Buffer, limits: ExtractLimits = LIMITS): Promise<void> {
    const started = Date.now();
    const promise = extract(name, bytes, limits);
    await expect(promise).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(promise).rejects.toThrow(refused);
    expect(Date.now() - started).toBeLessThan(5000);
  }

  it('refuses a row of cells that all point at one megabyte-long shared string', async () => {
    // A cell is a reference to a string, not a copy: 1 000 cells of `<v>0</v>` are 1 GB of text.
    const big = 'lorem ipsum '.repeat(90_000); // ~1 MB, with spaces so it is not one unbreakable word
    const cells = Array.from({ length: 1000 }, (_, i) => `<c r="${columnName(i)}1" t="s"><v>0</v></c>`).join('');
    const book = workbookOf(`<row r="1">${cells}</row>`, `<sst><si><t>${big}</t></si></sst>`);
    expect(book.byteLength).toBeLessThan(16 * 1024);
    await refusal('repeat.xlsx', book);
  });

  it('refuses the same repetition spread over many rows, and a repeated header', async () => {
    const big = 'lorem ipsum '.repeat(9_000); // ~100 KB
    const row = (n: number): string =>
      `<row r="${n}">${Array.from({ length: 40 }, (_, i) => `<c r="${columnName(i)}${n}" t="s"><v>0</v></c>`).join('')}</row>`;
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1)).join('');
    await refusal('rows.xlsx', workbookOf(rows, `<sst><si><t>${big}</t></si></sst>`), SMALL);
  });

  it('refuses a csv-table whose first row is wide and the rest are one cell', async () => {
    const width = 30_000;
    const source = `Title\n=====\n\n.. csv-table::\n\n   ${'a,'.repeat(width)}\n${'   a\n'.repeat(width)}`;
    const bytes = Buffer.from(source);
    expect(bytes.byteLength).toBeLessThan(256 * 1024);
    await refusal('wide.rst', bytes);
    await refusal('wide-small.rst', Buffer.from(`.. csv-table::\n\n   ${'a,'.repeat(2000)}\n${'   a\n'.repeat(2000)}`), SMALL);
  });

  it('refuses a simple table with a border of thousands of columns above one-word rows', async () => {
    const border = Array.from({ length: 5000 }, () => '=').join(' ');
    const source = `${border}\nhead\n${border}\n${'x\n'.repeat(3000)}${border}\n\nafter\n`;
    await refusal('border.rst', Buffer.from(source), SMALL);
  });

  it('refuses single-cell AsciiDoc tables declared 64 columns wide', async () => {
    const source = '[cols="64*"]\n|===\n|x\n|===\n\n'.repeat(10_000);
    const bytes = Buffer.from(source);
    expect(bytes.byteLength).toBeLessThan(SMALL.maxFileBytes / 10);
    await refusal('cols.adoc', bytes, SMALL);
  });

  it('refuses quote markers added at every level of a 16-deep nest', async () => {
    // A block closes at the same delimiter, so each level needs its own length: 19 underscores down to 4.
    const fence = (level: number): string => '_'.repeat(4 + level);
    const levels = Array.from({ length: 16 }, (_, k) => 15 - k);
    const open = levels.map((level) => `${fence(level)}\n`).join('');
    const close = [...levels]
      .reverse()
      .map((level) => `${fence(level)}\n`)
      .join('');
    // Each line is "x", and leaves 16 levels deep as "> > ... > x".
    const source = `${open}${'x\n\n'.repeat(250_000)}${close}`;
    await refusal('nest.adoc', Buffer.from(source), SMALL);
  });

  it('refuses a slide of paragraphs and notes that outgrow a small ceiling', async () => {
    const paragraph = (text: string): string => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraph('word '.repeat(40)).repeat(200)}</p:txBody></p:sp>`;
    await refusal('text.pptx', deckOf([slideOf(body)]), { ...LIMITS, maxFileBytes: 4096 });
  });

  it('still renders ordinary workbooks, tables and nests', async () => {
    const shared = '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>';
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>';
    expect(tableRows(await extract('ok.xlsx', workbookOf(sheet, shared)))).toEqual(['| Name |', '| --- |', '| Ada |']);
    expect(tableRows(await extract('ok.adoc', Buffer.from('[cols="3*"]\n|===\n|a |b |c\n|1 |2 |3\n|===\n')))).toEqual([
      '| a | b | c |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
    ]);
    expect(tableRows(await extract('ok.rst', Buffer.from('.. csv-table::\n\n   a,b\n   1,2\n')))).toEqual([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ]);
    const quote = await extract('ok-quote.adoc', Buffer.from('[quote]\n____\nfirst\n\nsecond\n____\n'));
    expect(quote).toContain('> first');
    expect(quote).toContain('> second');
  });
});

describe('input shapes that are quadratic or overflow the stack', () => {
  it('converts an AsciiDoc listing block of 80 000 lines', async () => {
    const source = `----\n${'line of code\n'.repeat(80_000)}----\n`;
    const markdown = await extract('big.adoc', Buffer.from(source));
    expect(markdown).toContain('line of code');
  });

  it('converts a reStructuredText code-block of 100 000 lines', async () => {
    const source = `Title\n=====\n\n.. code-block:: python\n\n${'   x = 1\n'.repeat(100_000)}\nafter\n`;
    const markdown = await extract('big.rst', Buffer.from(source));
    expect(markdown).toContain('x = 1');
    expect(markdown).toContain('after');
  });

  it('reads a reStructuredText csv-table of 100 000 rows', async () => {
    const source = `Title\n=====\n\n.. csv-table::\n   :header: "a","b"\n\n${'   1,2\n'.repeat(100_000)}`;
    const markdown = await extract('rows.rst', Buffer.from(source));
    expect(tableRows(markdown).length).toBeGreaterThan(100_000);
  });

  it('reads a long run of spaces in a reStructuredText link, an XML attribute and a notebook cell quickly', async () => {
    const started = Date.now();
    await extract('link.rst', Buffer.from(`Title\n=====\n\n\`${' '.repeat(100_000)}\`\n\ntext\n`));
    const deck = deckOf([
      `<p:sld ${SLIDE_NS}><p:cSld><p:spTree><p:sp ${'a'.repeat(200_000)}>${'<p:nvSpPr/>'}</p:sp>${textBox('Still here')}</p:spTree></p:cSld></p:sld>`,
    ]);
    await extract('attr.pptx', deck);
    const notebook = JSON.stringify({ cells: [{ cell_type: 'code', source: [`a${' '.repeat(50_000)}x`], metadata: {} }] });
    await extract('spaces.ipynb', Buffer.from(notebook));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reads unclosed image markers, link openers and role colons in linear time', async () => {
    const notebook = (markdown: string): Buffer => Buffer.from(JSON.stringify({ cells: [{ cell_type: 'markdown', source: markdown }] }));
    const cases: Array<[string, Buffer]> = [
      ['open-image.ipynb', notebook(`${'![a'.repeat(40_000)}\n\ntail`)],
      ['data-image.ipynb', notebook(`${'![](data:'.repeat(40_000)}\n\ntail`)],
      ['link.rst', Buffer.from(`Title\n=====\n\n${'`<'.repeat(40_000)}\n\ntext\n`)],
      ['role.rst', Buffer.from(`Title\n=====\n\n${':a'.repeat(40_000)}\n\ntext\n`)],
      ['labelled.rst', Buffer.from(`Title\n=====\n\n:ref:\`${'<'.repeat(40_000)}\`\n\n:ref:\`${' '.repeat(40_000)}x>\`\n`)],
      ['tables.rst', Buffer.from(`${'= =\n= =\nx\n\n'.repeat(20_000)}`)],
    ];
    for (const [name, bytes] of cases) {
      const started = Date.now();
      await extract(name, bytes);
      expect(Date.now() - started, name).toBeLessThan(1500);
    }
  });

  it('keeps the alt text of an embedded image and nothing else of it', async () => {
    const source =
      'See ![the plot](data:image/png;base64,AAAA) and ![ logo ]( data:image/png;base64,BBBB) but keep ![x](https://example.com/x.png) and ![open';
    const notebook = Buffer.from(JSON.stringify({ cells: [{ cell_type: 'markdown', source }] }));
    const markdown = await extract('images.ipynb', notebook);
    expect(markdown).toContain('See the plot and logo but keep ![x](https://example.com/x.png) and ![open');
    expect(markdown).not.toContain('base64');
  });

  it('takes a notebook cell language as one safe word and falls back to the notebook language', async () => {
    const notebook = JSON.stringify({
      metadata: { language_info: { name: 'Python' } },
      cells: [{ cell_type: 'code', language: 'js\n```\n# injected', source: ['print(1)'] }],
    });
    const markdown = await extract('lang.ipynb', Buffer.from(notebook));
    expect(markdown).toContain('```python\nprint(1)\n```');
    expect(markdown).not.toContain('injected');
  });
});

describe('footnotes', () => {
  const PHRASE = 'quarterly reconciliation ledger';

  it('.docx: the footnote text is searchable', async () => {
    expect(await searchable('footnoted-policy.docx', PHRASE)).toBe(true);
    const markdown = await readable('footnoted-policy.docx');
    // Once, at the end, after the body it annotates — not inlined into the sentence, not twice.
    expect(markdown.match(/quarterly reconciliation ledger/g)).toHaveLength(1);
    expect(markdown.indexOf('approved by finance')).toBeLessThan(markdown.indexOf(PHRASE));
    // The separator notes Word always writes (ids -1 and 0) are not text.
    expect(markdown).not.toContain('separator');
  });

  it('.pdf: the footnote text is searchable', async () => {
    expect(await searchable('footnoted-policy.pdf', PHRASE)).toBe(true);
    const markdown = await readable('footnoted-policy.pdf');
    expect(markdown.match(/quarterly reconciliation ledger/g)).toHaveLength(1);
    expect(markdown.indexOf('approved by finance')).toBeLessThan(markdown.indexOf(PHRASE));
  });
});

describe('the boundary every failure leaves through', () => {
  /**
   * **This is the difference between a bad document and a failed run.** `indexer.ts` rethrows
   * anything that is not a `DocumentExtractionError`, and a rethrow from inside the file loop marks
   * the project `error`, writes the library's own message — which names no file — to `last_error`, and
   * then, because the failure is deterministic, does it again on every run until somebody finds the
   * file by hand. The other three hundred and ninety-nine documents stop being updated meanwhile.
   *
   * Both fixtures below throw a type the indexer does not know: PDF.js an `InvalidPDFException`, and
   * mammoth a plain `Error`. Neither transform catches it. The boundary is the only thing between
   * them and a broken project.
   */
  it('turns a damaged PDF into a named refusal rather than a thrown library exception', async () => {
    const promise = extract('damaged-report.pdf', bytesOf('damaged-report.pdf'));
    await expect(promise).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(promise).rejects.toThrow(/"damaged-report\.pdf" could not be read as a "\.pdf" file/);
  });

  it('turns a zip renamed to .docx into a named refusal', async () => {
    const promise = extract('notes-renamed.docx', bytesOf('notes-renamed.docx'));
    await expect(promise).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(promise).rejects.toThrow(/"notes-renamed\.docx" could not be read as a "\.docx" file/);
  });

  it('names the file in every refusal, because the library never does', async () => {
    for (const name of ['damaged-report.pdf', 'notes-renamed.docx', 'scanned-invoice.pdf']) {
      await expect(extract(name, bytesOf(name))).rejects.toThrow(new RegExp(name.replace('.', '\\.')));
    }
  });
});

describe('a conversion that produced nothing', () => {
  /**
   * `.pdf` and `.docx` had their own empty check and `.csv` and `.html` did not, which made the worst
   * outcome in [ADR-0056](../.ssot/ADR.md#adr-0056) reachable through the two easiest types: a
   * document that exists, is listed, matches nothing and reads as blank. `chunkMarkdown` does not
   * catch it either — the `# Heading` this module adds is itself one chunk, so the indexer's
   * `chunks.length === 0` branch never fires.
   */
  it('refuses a CSV that is nothing but blank lines', async () => {
    await expect(extract('quarterly-report.csv', Buffer.from('\n\n \n', 'utf8'))).rejects.toThrow(/converted to nothing/);
  });

  it('refuses an HTML page whose only content was removed as machinery', async () => {
    const page = Buffer.from('<html><head><title>Dashboard</title><style>b{}</style></head><body><script>run()</script></body></html>', 'utf8');
    await expect(extract('dashboard.html', page)).rejects.toThrow(/converted to nothing/);
  });

  it('still accepts a CSV of nothing but a header, which is a list of column names', async () => {
    const markdown = await extract('columns.csv', Buffer.from('Service,Owner\n', 'utf8'));
    expect(markdown).toBe(['# Columns', '', '| Service | Owner |', '| --- | --- |'].join('\n'));
  });

  /**
   * A refusal that only diagnoses is a refusal an operator cannot act on, and the next step is
   * different for each type: a Word file of nothing but pictures is re-exported, a spreadsheet with no
   * rows is removed, a page that was all script was never a document.
   */
  it('says what to do about it, per type', async () => {
    const cases: Array<[string, Buffer, RegExp]> = [
      ['pictures-only.docx', bytesOf('pictures-only.docx'), /re-export it with its text/],
      ['blank.csv', Buffer.from('\n\n', 'utf8'), /remove it from the source, or export it with its data/],
      ['app.html', Buffer.from('<body><script>x()</script></body>', 'utf8'), /point the source at the rendered documentation/],
      ['app.htm', Buffer.from('<body><style>b{}</style></body>', 'utf8'), /point the source at the rendered documentation/],
    ];
    for (const [name, bytes, remedy] of cases) {
      await expect(extract(name, bytes)).rejects.toThrow(remedy);
      await expect(extract(name, bytes)).rejects.toThrow(/converted to nothing/);
    }
  });

  /**
   * Excluding *every* heading line made a document whose content **is** headings — an index page of
   * links, a Word outline written in heading styles — "converted to nothing". That is a real document,
   * and on a rebuild refusing it drops the one that was already indexed.
   */
  it('keeps a document whose content is headings, and refuses only one that is a title and nothing else', async () => {
    const index = Buffer.from('<h1>Handbook</h1><h2>Escalation</h2><h2>Rotas</h2>', 'utf8');
    expect(await extract('index.html', index)).toBe('# Handbook\n\n## Escalation\n\n## Rotas');
    // A fenced `#` is content too, and needs no fence tracking now that only the first line is taken.
    const fenced = Buffer.from('<pre><code># not a heading\n</code></pre>', 'utf8');
    expect(await extract('snippet.html', fenced)).toContain('# not a heading');
    await expect(extract('empty.html', Buffer.from('<title>Nothing</title>', 'utf8'))).rejects.toThrow(/converted to nothing/);
  });

  it('leaves an empty .md alone, because an empty file is not a failed conversion', async () => {
    expect(await extract('stub.md', Buffer.from('', 'utf8'))).toBe('');
    expect(await extract('stub.txt', Buffer.from('   \n', 'utf8'))).toBe('   \n');
  });
});

describe('what one file may cost', () => {
  /**
   * `UPLOAD_MAX_FILE_BYTES` only ever applied to the upload path, so a file reached through a local
   * directory or a git checkout was parsed at whatever size it happened to be — in the server's own
   * process, beside the dashboard and `/mcp`. These three caps are what bound that, and each one
   * closes a hole the other two do not: bytes, declared pages, and declared unpacked size.
   */
  it('refuses a converted file over the byte ceiling, before parsing it', async () => {
    const tiny = { ...LIMITS, maxFileBytes: 512 };
    await expect(extract('support-handbook.pdf', bytesOf('support-handbook.pdf'), tiny)).rejects.toThrow(/over the .* a file of this type may be/);
    // The three types that are decoded rather than parsed are not capped, and are not affected.
    await expect(extract('notes.md', Buffer.alloc(4096, 0x61), tiny)).resolves.toHaveLength(4096);
  });

  it('refuses a PDF that declares more pages than the limit, before reading any of them', async () => {
    const twoPages = { ...LIMITS, maxPdfPages: 2 };
    await expect(extract('support-handbook.pdf', bytesOf('support-handbook.pdf'), twoPages)).rejects.toThrow(/declares 3 pages, over the limit of 2/);
  });

  it('refuses a .docx that declares more than the limit, without inflating anything', async () => {
    const declared = declaredUnpackedBytes(bytesOf('onboarding-checklist.docx'));
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(64 * 1024);
    await expect(extract('onboarding-checklist.docx', bytesOf('onboarding-checklist.docx'), { ...LIMITS, maxUnpackedBytes: 1024 })).rejects.toThrow(
      /declare that they unpack past the limit/,
    );
    expect(declaredUnpackedBytes(Buffer.from('not a zip at all'))).toBeNull();
  });

  /**
   * **The declared size is a number the attacker writes, so the cap cannot be a check on it.** `jszip`
   * reads the same field and only compares it against reality *after* inflating the part, by which
   * time the memory is spent — and DEFLATE reaches about 1030:1 on repetitive input, so a megabyte of
   * archive really can become a gigabyte of heap in the process that also serves `/mcp`.
   */
  it('refuses a .docx that lies about its size, by measuring what it really unpacks to', async () => {
    const bomb = bombDocx(64 * 1024 * 1024);
    // The lie: every part claims to be tiny, and the archive is under the raw-bytes ceiling.
    expect(declaredUnpackedBytes(bomb)).toBeLessThan(4096);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    // The measurement disagrees, and gives up rather than counting all of it.
    await expect(measureUnpackedBytes(bomb, 1024 * 1024)).resolves.toBe(Number.POSITIVE_INFINITY);
    await expect(extract('bomb.docx', bomb, { ...LIMITS, maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(/actually unpack past the limit/);
  });

  it('measures an honest .docx as its real size and lets it through', async () => {
    const measured = await measureUnpackedBytes(bytesOf('onboarding-checklist.docx'), 256 * 1024 * 1024);
    expect(measured).toBe(declaredUnpackedBytes(bytesOf('onboarding-checklist.docx')));
    await expect(extract('onboarding-checklist.docx', bytesOf('onboarding-checklist.docx'))).resolves.toContain('# Onboarding checklist');
  });

  it('treats a ZIP64 archive as unreadable rather than as small', async () => {
    const at = (b: Buffer): number => b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    // ZIP64 in the field the declaration is read from: the claim is "look elsewhere", not "it is tiny".
    const declaredElsewhere = Buffer.from(bytesOf('onboarding-checklist.docx'));
    declaredElsewhere.writeUInt32LE(0xffffffff, at(declaredElsewhere) + 24);
    expect(declaredUnpackedBytes(declaredElsewhere)).toBe(Number.POSITIVE_INFINITY);

    // ZIP64 in a field the measurement needs: it declines rather than measuring the wrong bytes.
    const sizeElsewhere = Buffer.from(bytesOf('onboarding-checklist.docx'));
    sizeElsewhere.writeUInt32LE(0xffffffff, at(sizeElsewhere) + 20);
    await expect(measureUnpackedBytes(sizeElsewhere, 256 * 1024 * 1024)).resolves.toBeNull();
    await expect(extract('huge.docx', sizeElsewhere)).rejects.toThrow(/not a readable zip archive/);
  });

  /**
   * The size is read from the scan's `stat` and refused *before* `readAndHash` puts the file in the
   * heap. A limit applied to the buffer that call returns is a limit that has already been exceeded.
   */
  it('refuses on a size, with no bytes in hand at all', () => {
    expect(() => checkFileSize('handbook/manual.pdf', 2 * 1024 * 1024 * 1024, LIMITS)).toThrow(/over the 32\.0 MiB/);
    expect(() => checkFileSize('handbook/manual.pdf', 1024, LIMITS)).not.toThrow();
    // The three decoded types are not parsed and are not capped, whatever their size.
    expect(() => checkFileSize('handbook/huge.md', 2 * 1024 * 1024 * 1024, LIMITS)).not.toThrow();
  });

  /**
   * The scan and the read are two moments, and the directory belongs to somebody else in between.
   * None of these is a `DocumentExtractionError` on its own, and each used to fail the run instead of
   * the file — `ERR_FS_FILE_TOO_LARGE` deterministically, on every run after the first.
   */
  it('turns what the filesystem says into a refusal that names the file', () => {
    const cases: Array<[string, RegExp]> = [
      ['ENOENT', /disappeared between the scan and the read/],
      ['EACCES', /permission denied/],
      ['ERR_FS_FILE_TOO_LARGE', /could not be read from disk/],
    ];
    for (const [code, expected] of cases) {
      const err = Object.assign(new Error(`${code}: something`), { code });
      const refusal = readFailure(err, 'handbook/notes.md');
      expect(refusal).toBeInstanceOf(DocumentExtractionError);
      expect(refusal.message).toContain('handbook/notes.md');
      expect(refusal.message).toMatch(expected);
    }
  });
});

describe('.txt and .htm', () => {
  it('passes a .txt through byte for byte, tabs, trailing newline and all', async () => {
    const bytes = bytesOf('escalation-policy.txt');
    expect(await extract('escalation-policy.txt', bytes)).toBe(bytes.toString('utf8'));
  });

  it('converts a .htm exactly as it converts a .html, and titles it from <title>', async () => {
    expect(await readable('changelog.htm')).toBe(
      [
        '# Changelog',
        '',
        '## 4.1.3',
        '',
        'Corrected the retry counter, which reset on every SIGHUP.',
        '',
        '-   Queue depth is reported per lane.',
        '-   The spool directory is created with mode 0700.',
        '',
        '## 4.1.2',
        '',
        'Security release — see [the advisory](/security/).',
      ].join('\n'),
    );
  });
});

describe('what the chunker is handed', () => {
  /**
   * The point of `withTitle`, checked where it matters. `extractTitle` only strips `.md`, `.mdx` and
   * `.txt` from a filename, so a `.csv` or a `.pdf` with no heading would be titled "Service owners.csv".
   * Every transform gives its document an H1, so the chunker needs no change and never reaches that path.
   */
  it('gives every converted type a title the chunker can read, with no change to the chunker', async () => {
    const cases: Array<[string, string]> = [
      ['service-owners.csv', 'Service Owners'],
      ['support-handbook.pdf', 'Support Handbook'],
      ['onboarding-checklist.docx', 'Onboarding checklist'],
      ['release-notes.html', 'Release 4.2'],
    ];
    for (const [name, title] of cases) {
      const markdown = await extract(name, bytesOf(name));
      expect(chunkMarkdown(markdown, `handbook/${name}`, { maxTokens: 120, overlapTokens: 20 }).title).toBe(title);
    }
  });

  it('produces chunks whose breadcrumbs follow the converted headings', async () => {
    const markdown = await extract('support-handbook.pdf', bytesOf('support-handbook.pdf'));
    const { chunks } = chunkMarkdown(markdown, 'handbook/support-handbook.pdf', { maxTokens: 120, overlapTokens: 20 });
    expect(new Set(chunks.map((c) => c.headingPath))).toEqual(
      new Set([
        'Support Handbook > Escalation levels',
        'Support Handbook > What each level owes',
        'Support Handbook > Response targets',
        'Support Handbook > Who to call',
      ]),
    );
  });
});
