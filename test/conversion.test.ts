import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConversionService } from '../src/services/conversion/client.js';
import { DocumentExtractionError, type ExtractLimits, extractDocument } from '../src/services/doc-types/index.js';
import { transformContent } from '../src/services/flavors.js';
import { type DerivedDocument, readOpenApi, type SpecLimits } from '../src/services/openapi.js';

/**
 * Conversion on its own thread ([ADR-0071](../.ssot/ADR.md#adr-0071)).
 *
 * **This phase is a move, not a rewrite, so the first thing here is that nothing changed.** Every
 * transform is the one `test/doc-types.test.ts` and `test/openapi.test.ts` already assert in full; what
 * is asserted below is that putting a thread between the indexer and them produces the same string,
 * character for character, and that a refusal still arrives as a refusal naming its file.
 *
 * The rest is the part a thread boundary adds and a function call never had: what happens when the
 * thread dies, when it stops answering, and when what comes back is a broken run rather than a bad
 * file. Those three are the whole reason this is a class and not an `await`.
 */

const DOCS = path.join(__dirname, 'fixtures', 'doc-types');
const SPECS = path.join(__dirname, 'fixtures', 'openapi');
const WORKERS = path.join(__dirname, 'fixtures', 'conversion');

const LIMITS: ExtractLimits = { maxFileBytes: 32 * 1024 * 1024, maxPdfPages: 2000, maxUnpackedBytes: 256 * 1024 * 1024 };
const SPEC_LIMITS: SpecLimits = { maxSpecBytes: 8 * 1024 * 1024 };

const services: ConversionService[] = [];

/** A service whose thread is the real one, unless a test needs one that misbehaves. */
function conversion(settings: Partial<{ timeoutMs: number; idleMs: number; entry: string }> = {}): ConversionService {
  const service = new ConversionService({
    timeoutMs: settings.timeoutMs ?? 30_000,
    idleMs: settings.idleMs ?? 30_000,
    entry: settings.entry ? new URL(`file://${path.join(WORKERS, settings.entry)}`) : undefined,
  });
  services.push(service);
  return service;
}

/** Waits for a condition rather than for a duration, so the idle window is a floor and not a race. */
async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition did not hold within the timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

describe('the conversion thread produces exactly what the in-process call did', () => {
  /**
   * One assertion per file type, and it is an equality against the in-process result rather than
   * against a recorded string — so it cannot pass by agreeing with a snapshot both sides got wrong.
   */
  it.each(['support-handbook.pdf', 'two-column-brief.pdf', 'service-owners.csv', 'release-notes.html', 'changelog.htm', 'onboarding-checklist.docx'])(
    'converts %s to the same Markdown',
    async (name) => {
      const bytes = await readFile(path.join(DOCS, name));
      const stored = `handbook/${name}`;
      const inProcess = transformContent('plain', await extractDocument(stored, bytes, LIMITS));

      expect(await conversion().convert(stored, 'plain', Buffer.from(bytes), LIMITS)).toBe(inProcess);
    },
  );

  /**
   * The flavor runs on the thread too, and not on the way back. It is the second half of the one
   * string ADR-0043 stores and chunks, and its transforms are regular expressions over a whole
   * document — which is work, and therefore work that belongs over there.
   */
  it('applies the flavor on the far side', async () => {
    const markdown = '# Ideas\n\n%%draft%%\n\n> [!warning] Mind the gap\n\n[[Runbook|the runbook]]';
    const converted = await conversion().convert('notes/ideas.md', 'obsidian', Buffer.from(markdown), LIMITS);

    expect(converted).toBe(transformContent('obsidian', markdown));
    expect(converted).toContain('[the runbook](Runbook.md)');
    expect(converted).toContain('**Warning:** Mind the gap');
    expect(converted).not.toContain('draft');
  });

  /**
   * **The bytes are handed over, not lent.** A file at `MAX_CONVERTED_FILE_BYTES` copied into the
   * message would be resident twice at the moment of the hand-over, which is memory this phase was
   * supposed to save rather than spend. Asserted because it is a contract on the caller: the indexer
   * takes `hash` and `sizeBytes` before this call and never reads the buffer again.
   */
  it('transfers the caller’s buffer instead of copying it', async () => {
    const bytes = Buffer.from(`# Big\n\n${'word '.repeat(200_000)}`);
    expect(bytes.byteLength).toBeGreaterThan(4096);

    await conversion().convert('notes/big.md', 'plain', bytes, LIMITS);

    expect(bytes.byteLength).toBe(0);
  });

  /**
   * A buffer that does not own its memory is copied first, because Node hands out small Buffers as
   * windows onto one shared pool and transferring that pool would detach it from every other Buffer
   * sharing it — a corruption with no error message anywhere near it.
   */
  it('copies a pooled buffer rather than detaching the pool under it', async () => {
    const pooled = Buffer.from('# Small\n\nnot worth a transfer\n');
    expect(pooled.byteLength).toBeLessThan(4096);

    const converted = await conversion().convert('notes/small.md', 'plain', pooled, LIMITS);

    expect(converted).toBe('# Small\n\nnot worth a transfer\n');
    expect(pooled.toString('utf8')).toContain('not worth a transfer');
  });
});

describe('a refused file keeps its name and its reason across the boundary', () => {
  /**
   * **Criterion four, and the reason `protocol.ts` carries the kind as a field.** Structured clone
   * flattens an `Error` subclass to a plain `Error` — the name of anything that is not one of the
   * eight standard types does not survive — so an `instanceof` check on this side would turn every
   * refused file into a failed run, which is precisely the defect ADR-0056's boundary exists to close.
   */
  it('refuses a PDF with no text layer, by name and with the next step', async () => {
    const bytes = await readFile(path.join(DOCS, 'scanned-invoice.pdf'));
    const inProcess = await extractDocument('handbook/scanned-invoice.pdf', Buffer.from(bytes), LIMITS).catch((err: unknown) => err);

    const refusal = await conversion()
      .convert('handbook/scanned-invoice.pdf', 'plain', Buffer.from(bytes), LIMITS)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toBe((inProcess as Error).message);
    expect((refusal as Error).message).toContain('handbook/scanned-invoice.pdf');
    expect((refusal as Error).message).toMatch(/OCR/);
  });

  it('refuses a damaged file with the same sentence it always had', async () => {
    const bytes = await readFile(path.join(DOCS, 'damaged-report.pdf'));
    const inProcess = await extractDocument('handbook/damaged-report.pdf', Buffer.from(bytes), LIMITS).catch((err: unknown) => err);

    const refusal = await conversion()
      .convert('handbook/damaged-report.pdf', 'plain', Buffer.from(bytes), LIMITS)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toBe((inProcess as Error).message);
  });

  /**
   * **All three caps of FR-406, one case each, because two of them used to be unasserted.**
   *
   * The earlier version of this case set all three low and then put `maxFileBytes` back, so only
   * `maxPdfPages` was ever exercised — and raising `maxUnpackedBytes` to `MAX_SAFE_INTEGER` on the way
   * into the worker left all 871 unit tests green. A limit nothing measures is a limit that can be
   * dropped at the boundary in silence, which is the whole failure mode the caps exist against.
   */
  it.each([
    ['support-handbook.pdf', { maxFileBytes: 1024 }, /over the 1 KiB a file of this type may be/, 'MAX_CONVERTED_FILE_BYTES'],
    ['support-handbook.pdf', { maxPdfPages: 1 }, /pages/, 'MAX_PDF_PAGES'],
    ['onboarding-checklist.docx', { maxUnpackedBytes: 1024 }, /unpack past the limit/, 'MAX_DOCX_UNPACKED_BYTES'],
  ] as Array<[string, Partial<ExtractLimits>, RegExp, string]>)('applies %s inside the thread when %o is lowered', async (name, lowered, matcher) => {
    const bytes = await readFile(path.join(DOCS, name));
    const limits: ExtractLimits = { ...LIMITS, ...lowered };
    const stored = `handbook/${name}`;
    const inProcess = await extractDocument(stored, Buffer.from(bytes), limits).catch((err: unknown) => err);

    const refusal = await conversion()
      .convert(stored, 'plain', Buffer.from(bytes), limits)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toMatch(matcher);
    // The cap that fired over there is the one that fires here, with the same sentence: a limit
    // quietly widened on the way across would produce a different refusal, or none.
    expect((refusal as Error).message).toBe((inProcess as Error).message);
  });
});

describe('a specification is expanded on the thread and pulled back one document at a time', () => {
  async function collect(iterable: AsyncIterable<DerivedDocument>): Promise<DerivedDocument[]> {
    const out: DerivedDocument[] = [];
    for await (const document of iterable) out.push(document);
    return out;
  }

  /**
   * The object graph a specification parses into is about fifty-five times the file (ADR-0057) and it
   * stays on the far side; what crosses is one rendered operation at a time. The assertion is again an
   * equality against the in-process expansion, document for document.
   */
  it('produces the same documents in the same order', async () => {
    const bytes = await readFile(path.join(SPECS, 'petstore.yaml'));
    const inProcess = [...readOpenApi('api/petstore.yaml', Buffer.from(bytes), SPEC_LIMITS).documents()];

    const expansion = await conversion().expand('api/petstore.yaml', Buffer.from(bytes), SPEC_LIMITS);

    expect(expansion.count).toBe(inProcess.length);
    expect(await collect(expansion.documents())).toEqual(inProcess);
  });

  it('refuses a structured file that is not a specification, with its own sentence', async () => {
    const bytes = await readFile(path.join(SPECS, 'deploy-values.yaml'));
    let inProcess: unknown;
    try {
      readOpenApi('api/deploy-values.yaml', Buffer.from(bytes), SPEC_LIMITS);
    } catch (err) {
      inProcess = err;
    }

    const refusal = await conversion()
      .expand('api/deploy-values.yaml', Buffer.from(bytes), SPEC_LIMITS)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toBe((inProcess as Error).message);
  });

  /**
   * The indexer stops reading an expansion whenever a document fails to embed or to write. The
   * specification's graph would otherwise stay live on the far side until some later file replaced it,
   * so an abandoned expansion is closed — and the service is still usable straight afterwards, which
   * is what says the session was released rather than leaked.
   */
  it('closes an expansion the reader walked away from, and keeps working', async () => {
    const service = conversion();
    const bytes = await readFile(path.join(SPECS, 'petstore.yaml'));
    const expansion = await service.expand('api/petstore.yaml', bytes, SPEC_LIMITS);

    let taken = 0;
    for await (const _document of expansion.documents()) {
      taken++;
      break;
    }
    expect(taken).toBe(1);

    // The session is gone on the far side, and asking for another document out of it is a programming
    // error rather than a bad file — which is what makes the close observable at all, and what would
    // notice if `#discard` ever stopped sending it.
    const reused = await (async () => {
      for await (const _document of expansion.documents()) return null;
      return null;
    })().catch((err: unknown) => err);
    expect(reused).toBeInstanceOf(Error);
    expect(reused).not.toBeInstanceOf(DocumentExtractionError);
    expect((reused as Error).message).toContain('is not open');

    expect(await service.convert('notes/after.md', 'plain', Buffer.from('# After\n\nstill here\n'), LIMITS)).toBe('# After\n\nstill here\n');
  });

  /**
   * **The thread is let go after an expansion is read to its end, and not only after one that was
   * abandoned.** ADR-0071 §3, `config.ts`, `README.md` and `.env.example` all promise that a thread
   * with nothing to do is dropped after `CONVERSION_IDLE_MS`; the first version of this class did that
   * for every path except the ordinary one. Releasing the session inside the loop and closing it in
   * `finally` meant the release ran, found nothing to close, and returned before it armed anything —
   * so a run whose last converted file was a specification held its thread, `ref`'d, for ever.
   *
   * Two assertions, because the leak had two halves. `MessagePort` is what a live, `ref`'d worker
   * registers with the event loop, and it disappears the moment the worker is `unref`'d — so the count
   * returning to its baseline is the process no longer being held open. `threadHeld` going false is
   * the memory actually going back.
   */
  it('lets the thread go once an expansion has been read to the end', async () => {
    const livePorts = (): number => process.getActiveResourcesInfo().filter((resource) => resource === 'MessagePort').length;
    const baseline = livePorts();
    const service = conversion({ idleMs: 150 });
    const bytes = await readFile(path.join(SPECS, 'petstore.yaml'));

    const expansion = await service.expand('api/petstore.yaml', bytes, SPEC_LIMITS);
    let read = 0;
    for await (const _document of expansion.documents()) read++;
    expect(read).toBe(expansion.count);

    // Nothing left to convert: the thread stops holding the event loop open immediately…
    expect(livePorts()).toBe(baseline);
    expect(service.threadHeld).toBe(true);

    // …and is gone once the idle window passes.
    await until(() => !service.threadHeld, 3000);
    expect(service.threadHeld).toBe(false);

    // And the next file gets a new one, rather than the service being left unusable by its own tidying.
    expect(await service.convert('notes/after.md', 'plain', Buffer.from('# After\n\nstill here\n'), LIMITS)).toBe('# After\n\nstill here\n');
    expect(service.threadHeld).toBe(true);
  });

  /**
   * **An expansion that is opened and never read is the same leak one step further out.**
   *
   * Nothing in the product reaches it today — `indexer.ts` opens the expansion and enters the loop in
   * the same turn, with no branch between them — and that is exactly why the case is here. The leak it
   * guards against is one `continue` away, and it is silent: the run finishes, every document is
   * correct, and a thread is held for the life of the process.
   *
   * Two of them, because a handle can be dropped at two different moments and only one of them is
   * obvious. An async generator's body does not run when `documents()` is *called*; it runs on the
   * first `next()`. So a fix that treated the call as a claim would close the first case and leave the
   * second one open, looking closed.
   */
  it('lets the thread go when an expansion is opened and the handle is thrown away', async () => {
    const service = conversion({ idleMs: 120 });
    const bytes = await readFile(path.join(SPECS, 'petstore.yaml'));

    const expansion = await service.expand('api/petstore.yaml', bytes, SPEC_LIMITS);
    expect(expansion.count).toBeGreaterThan(0);
    expect(service.threadHeld).toBe(true);

    await until(() => !service.threadHeld, 5000);
    expect(service.threadHeld).toBe(false);
  });

  it('lets the thread go when documents() is called and never stepped', async () => {
    const service = conversion({ idleMs: 120 });
    const bytes = await readFile(path.join(SPECS, 'petstore.yaml'));

    const expansion = await service.expand('api/petstore.yaml', bytes, SPEC_LIMITS);
    // Created, not started: the generator body — and therefore the `finally` that would release the
    // session — has not run and never will.
    const iterator = expansion.documents();
    expect(typeof iterator.next).toBe('function');

    await until(() => !service.threadHeld, 5000);
    expect(service.threadHeld).toBe(false);
  });

  /**
   * **The reason the watchdog measures "unread" and not "idle", stated as a test.**
   *
   * Between two documents the caller is chunking and embedding the last one, so a sweep that released
   * a thread because nothing had been asked of it recently would abandon a live expansion — and the
   * next `next` would answer "session is not open", which is a **failed run** rather than a refused
   * file. The gap below is longer than the whole idle window, deliberately.
   */
  it('does not abandon an expansion whose reader is slow between documents', async () => {
    const service = conversion({ idleMs: 100 });
    const bytes = await readFile(path.join(SPECS, 'petstore.yaml'));

    const expansion = await service.expand('api/petstore.yaml', bytes, SPEC_LIMITS);
    const read: DerivedDocument[] = [];
    for await (const document of expansion.documents()) {
      read.push(document);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(read.length).toBe(expansion.count);
  });

  /** The same promise on the ordinary path: one file converted, then quiet. */
  it('lets the thread go after an ordinary conversion too', async () => {
    const service = conversion({ idleMs: 150 });
    await service.convert('notes/one.md', 'plain', Buffer.from('# One\n\nhere\n'), LIMITS);
    expect(service.threadHeld).toBe(true);

    await until(() => !service.threadHeld, 3000);
    expect(service.threadHeld).toBe(false);
  });
});

/**
 * **Criterion two, and the only claim this phase actually makes.** The phase promises isolation, not
 * speed: the same work, off the thread that answers `/mcp` and the dashboard.
 *
 * The measurement is a 5 ms interval counting how often the main thread got to run while one file was
 * converted. It is asserted against the *same conversion done in-process*, in the same test, so it
 * cannot pass by being run on a fast machine — the in-process half is the control, and it is starved
 * by construction.
 */
describe('the main thread keeps running while a file is converted', () => {
  function bigCsv(rows: number): Buffer {
    const lines = ['id,name,team,email,region,tier,notes,updated'];
    for (let i = 0; i < rows; i++) {
      lines.push(
        `${i},Service ${i},Team ${i % 40},svc${i}@example.com,eu-west-${i % 4},tier-${i % 3},"Owns the ${i} pipeline, on call",2026-01-${(i % 28) + 1}`,
      );
    }
    return Buffer.from(lines.join('\n'));
  }

  async function ticksDuring(work: () => Promise<unknown>): Promise<{ ticks: number; ms: number }> {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const started = performance.now();
    await work();
    const ms = performance.now() - started;
    clearInterval(timer);
    return { ticks, ms };
  }

  it('is starved by an in-process conversion and is not by a threaded one', async () => {
    const service = conversion();
    const csv = bigCsv(60_000);
    // Both sides warmed first: the lazy `import('./csv.js')` and the worker's startup are one-off costs
    // and neither is what is being measured.
    await extractDocument('data/warm.csv', Buffer.from('a,b\n1,2\n'), LIMITS);
    await service.convert('data/warm.csv', 'plain', Buffer.from('a,b\n1,2\n'), LIMITS);

    const inProcess = await ticksDuring(() => extractDocument('data/big.csv', Buffer.from(csv), LIMITS));
    const threaded = await ticksDuring(() => service.convert('data/big.csv', 'plain', Buffer.from(csv), LIMITS));

    // The file is genuinely slow to convert, or neither number means anything.
    expect(inProcess.ms).toBeGreaterThan(50);
    expect(threaded.ms).toBeGreaterThan(50);
    // In-process, the loop is blocked for the whole parse: at most a tick or two either side of it.
    expect(inProcess.ticks).toBeLessThanOrEqual(3);
    // On the thread, it keeps ticking — and by a margin no ordinary scheduling noise closes.
    expect(threaded.ticks).toBeGreaterThan(inProcess.ticks * 4);
    expect(threaded.ticks).toBeGreaterThan(5);
  });
});

/**
 * **Criterion three and criterion five.** A boundary that only handles the failures it can see is not
 * an isolation boundary: the thread can die without answering, and it can decline to answer at all.
 */
describe('the thread going away is one refused file, not a dead server', () => {
  it('refuses the file by name when the thread exits under it', async () => {
    const service = conversion({ entry: 'exiting-worker.ts' });

    const refusal = await service.convert('handbook/manual.pdf', 'plain', Buffer.from('%PDF-1.4\n'), LIMITS).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toContain('handbook/manual.pdf');
    expect((refusal as Error).message).toContain('exited with code 3');
  });

  it('refuses the file by name when the thread throws out of its own handler', async () => {
    const service = conversion({ entry: 'throwing-worker.ts' });

    const refusal = await service.convert('handbook/manual.pdf', 'plain', Buffer.from('%PDF-1.4\n'), LIMITS).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toContain('handbook/manual.pdf');
    expect((refusal as Error).message).toContain('the parser took the thread with it');
  });

  /**
   * A thread replaced after a crash has to be replaced *again* after the next one — a service that
   * gave up after the first would turn one bad file into every later file failing, which is the same
   * whole-run failure in slower motion.
   */
  it('spawns a new thread for the next file, every time', async () => {
    const service = conversion({ entry: 'exiting-worker.ts' });

    for (const name of ['one.pdf', 'two.pdf', 'three.pdf']) {
      const refusal = await service.convert(name, 'plain', Buffer.from('%PDF-1.4\n'), LIMITS).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(DocumentExtractionError);
      expect((refusal as Error).message).toContain(name);
    }
  });

  /**
   * A thread cannot be interrupted from outside: a parser in a loop never returns to the event loop
   * where a "stop" message would be read. So the request stops waiting and the thread is replaced —
   * without which one crafted file holds the indexing queue for ever.
   */
  it('gives up on a thread that never answers, and settles', async () => {
    const service = conversion({ entry: 'silent-worker.ts', timeoutMs: 150 });

    const started = performance.now();
    const refusal = await service.convert('handbook/loop.pdf', 'plain', Buffer.from('%PDF-1.4\n'), LIMITS).catch((err: unknown) => err);
    const waited = performance.now() - started;

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toContain('handbook/loop.pdf');
    expect((refusal as Error).message).toContain('abandoned');
    expect((refusal as Error).message).toContain('CONVERSION_TIMEOUT_MS');
    expect(waited).toBeLessThan(5_000);
  });

  /**
   * **The other half of criterion four.** `refusal: false` has to stay a failed run. If everything
   * coming back were turned into a `DocumentExtractionError`, a pool that had gone away would be
   * reported to an operator as "this PDF is not a document" and the run would report success.
   */
  it('lets a failure that is not a refusal stay a failed run', async () => {
    const service = conversion({ entry: 'failing-worker.ts' });

    const err = await service.convert('handbook/manual.pdf', 'plain', Buffer.from('%PDF-1.4\n'), LIMITS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DocumentExtractionError);
    expect((err as Error).message).toBe('the connection pool is gone');
  });

  /** Shutdown is not a crash: a request made after `stop()` is refused rather than left hanging. */
  it('refuses work after it has been stopped', async () => {
    const service = conversion();
    await service.convert('notes/one.md', 'plain', Buffer.from('# One\n\nhere\n'), LIMITS);
    await service.stop();

    const refusal = await service.convert('notes/two.md', 'plain', Buffer.from('# Two\n\nhere\n'), LIMITS).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(DocumentExtractionError);
    expect((refusal as Error).message).toContain('shutting down');
  });
});
