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
function bombDocx(size: number): Buffer {
  const payload = deflateRawSync(Buffer.alloc(size, 0x41));
  const name = Buffer.from('word/document.xml', 'utf8');

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
