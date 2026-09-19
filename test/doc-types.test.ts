import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/services/chunker.js';
import { csvToMarkdown, parseDelimited, sniffDelimiter } from '../src/services/doc-types/csv.js';
import { declaredUnpackedBytes } from '../src/services/doc-types/docx.js';
import { htmlToMarkdown, promoteBlankTableHeader } from '../src/services/doc-types/html.js';
import {
  DocumentExtractionError,
  type ExtractLimits,
  extensionOf,
  extractDocument,
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

  it('reads what a .docx says its parts unpack to, and refuses one that claims too much', async () => {
    const real = declaredUnpackedBytes(bytesOf('onboarding-checklist.docx'));
    expect(real).toBeGreaterThan(0);
    expect(real).toBeLessThan(64 * 1024);
    await expect(extract('onboarding-checklist.docx', bytesOf('onboarding-checklist.docx'), { ...LIMITS, maxUnpackedBytes: 1024 })).rejects.toThrow(
      /claim to unpack to/,
    );
    // Nothing is inflated to find that out: the answer comes off the central directory.
    expect(declaredUnpackedBytes(Buffer.from('not a zip at all'))).toBeNull();
  });

  it('treats a ZIP64 archive as too large rather than as readable', () => {
    const bomb = Buffer.from(bytesOf('onboarding-checklist.docx'));
    // The first central-directory record's uncompressed size, set to ZIP64's "look elsewhere" marker.
    const at = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(0xffffffff, at + 24);
    expect(declaredUnpackedBytes(bomb)).toBe(Number.POSITIVE_INFINITY);
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
