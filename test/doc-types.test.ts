import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/services/chunker.js';
import { csvToMarkdown, parseDelimited, sniffDelimiter } from '../src/services/doc-types/csv.js';
import { htmlToMarkdown, promoteBlankTableHeader } from '../src/services/doc-types/html.js';
import { DocumentExtractionError, extensionOf, extractDocument, titleFromPath, withTitle } from '../src/services/doc-types/index.js';
import { transformContent } from '../src/services/flavors.js';
import { SUPPORTED_EXTENSIONS, extensionMatcher } from '../src/services/fs-scan.js';
import { storedDocumentContent } from '../src/services/vector-store.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'doc-types');
const bytesOf = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

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
  const markdown = await extractDocument(name, bytesOf(name));
  const stored = storedDocumentContent(transformContent('plain', markdown), 1024 * 1024);
  expect(stored.contentTruncated).toBe(false);
  return stored.content;
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
      await extractDocument(`a.${ext}`, Buffer.from('')).catch((err: unknown) => {
        expect(err).toBeInstanceOf(DocumentExtractionError);
        expect((err as Error).message).not.toMatch(/no supported file type/);
      });
    }
    await expect(extractDocument('notes.rtf', Buffer.from('x'))).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(extractDocument('Makefile', Buffer.from('x'))).rejects.toThrow(/no supported file type/);
  });

  it('accepts the new extensions in the scanner filter, and still rejects what is not on the list', () => {
    const matcher = extensionMatcher(['md', 'html', 'htm', 'csv', 'docx', 'pdf']);
    for (const name of ['a.md', 'a.html', 'a.HTM', 'a.csv', 'report.docx', 'book.PDF']) expect(matcher.test(name)).toBe(true);
    for (const name of ['a.doc', 'a.pptx', 'a.xlsx', 'a.htmlx', 'a.pdf.bak']) expect(matcher.test(name)).toBe(false);
  });

  it('leaves Markdown exactly as it was, byte for byte', async () => {
    const source = '---\ntitle: Kept\n---\n\n# Kept\n\n﻿text with a bom in the middle\n';
    expect(await extractDocument('notes.md', Buffer.from(source, 'utf8'))).toBe(source);
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
    await expect(extractDocument('legacy.docx', renamed)).rejects.toThrow(/not a Word 2007\+ document/);
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
    const promise = extractDocument('scanned-invoice.pdf', bytesOf('scanned-invoice.pdf'));
    await expect(promise).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(promise).rejects.toThrow(/no text layer/);
    await expect(promise).rejects.toThrow(/character recognition is out of scope/);
  });

  it('refuses a file that is not a PDF at all', async () => {
    await expect(extractDocument('broken.pdf', Buffer.from('not a pdf, just some bytes'))).rejects.toBeInstanceOf(DocumentExtractionError);
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
      const markdown = await extractDocument(name, bytesOf(name));
      expect(chunkMarkdown(markdown, `handbook/${name}`, { maxTokens: 120, overlapTokens: 20 }).title).toBe(title);
    }
  });

  it('produces chunks whose breadcrumbs follow the converted headings', async () => {
    const markdown = await extractDocument('support-handbook.pdf', bytesOf('support-handbook.pdf'));
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
