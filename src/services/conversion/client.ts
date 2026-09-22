/**
 * The main process's half of conversion ([ADR-0071](../../../.ssot/ADR.md#adr-0071)).
 *
 * Conversion is third-party code reading hostile bytes: four document parsers and a YAML parser, any
 * of which can be handed a file written to make it misbehave. Until this existed they ran on the
 * thread that also serves the dashboard and `/mcp`, so a file that took two seconds to parse was two
 * seconds nobody could search, and a file that exhausted the heap took the MCP endpoint down with the
 * run ([ADR-0056](../../../.ssot/ADR.md#adr-0056) said as much and left it).
 *
 * **What this class owns is the failure modes a thread boundary adds, not the conversion.** The
 * conversion is unchanged and lives in `./worker.ts`. Here there are three:
 *
 * 1. **The thread dies.** An OOM inside a parser, a native crash, a `process.exit`. `error` and
 *    `exit` are watched, everything in flight is refused *by name*, and the next request spawns a new
 *    thread. The run finishes; the server never noticed.
 * 2. **The thread stops answering.** A parser in a loop cannot be interrupted from outside, so the
 *    only remedy is to stop waiting and replace the thread: every request carries `CONVERSION_TIMEOUT_MS`.
 *    Without it one crafted file hangs the queue for ever, which is a worse outcome than the
 *    synchronous version it replaced.
 * 3. **The reason gets lost on the way back.** A refusal has to arrive as a refusal. See
 *    `./protocol.ts`: the kind is a field, because structured clone flattens an `Error` subclass to
 *    `Error` and an `instanceof` check here would turn every refused file into a failed run.
 *
 * A thread is spawned on the first file and kept — a run is hundreds of files and paying tens of
 * milliseconds of startup and re-import for each of them would be a real cost for no benefit — and it
 * is dropped again after `CONVERSION_IDLE_MS` of quiet, so an idle server is not holding the heap a
 * PDF parser grew.
 */

import { Worker } from 'node:worker_threads';

import type { Logger } from '../../context.js';
import { DocumentExtractionError, type ExtractLimits } from '../doc-types/index.js';
import type { Flavor } from '../flavors.js';
import type { DerivedDocument, SpecLimits } from '../openapi.js';
import type { ConversionReply, ConversionRequest, ConversionSuccess } from './protocol.js';

/**
 * Whether this module is running from TypeScript source rather than from `dist/`.
 *
 * A worker is a *file path*, not a module the bundler resolved, so the thread starts with none of the
 * transformation the main thread is running under — under `tsx watch` and under vitest alike it would
 * be handed a `.ts` file and a Node that cannot read one. The repository already depends on `tsx` at
 * runtime (it is how `npm run dev` and every `scripts/*.ts` entry point runs), so the loader is
 * present in both cases; `dist/` needs none of it.
 */
const FROM_SOURCE = import.meta.url.endsWith('.ts');

export interface ConversionSettings {
  /** How long one request may take before the thread is replaced and the file refused. */
  timeoutMs: number;
  /** How long a thread with nothing to do is kept before it is dropped. */
  idleMs: number;
  /**
   * The worker entry, for tests that need a thread which crashes or never answers. Production has one
   * entry and does not pass this.
   */
  entry?: URL;
  /**
   * Where a thread that died or was given up on is written down.
   *
   * The *file* is already reported twice — `indexer.ts` logs every refusal and writes the reason onto
   * the owning source — but the thread going away is a fact about the server, not about the file, and
   * nothing else is in a position to say it. Optional so that a caller which has no logger (a script,
   * a test) does not have to invent one.
   */
  log?: Pick<Logger, 'warn'>;
}

/** One file's expansion, held open in the worker and stepped one document at a time (ADR-0057). */
export interface ConversionExpansion {
  /** How many documents this specification will produce, known once it has parsed. */
  readonly count: number;
  documents(): AsyncGenerator<DerivedDocument>;
}

/** A union's members minus their `id`; a plain `Omit` over a union keeps only the keys they share. */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never;

interface Pending {
  /** The file this request is about, so a crash or a timeout can be reported by name. */
  relativePath: string;
  resolve: (reply: ConversionSuccess) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The bytes as something that can be **transferred** rather than copied.
 *
 * `fs.readFile` returns a `Buffer`, and a small one is a window onto Node's shared allocation pool —
 * transferring *that* `ArrayBuffer` would detach the pool out from under every other Buffer sharing
 * it. So a buffer that does not own its memory outright is copied first. Node gives any allocation
 * over 4 KiB its own `ArrayBuffer`, so every file large enough for the copy to matter takes the
 * zero-copy path, and the ones that take the copy are kilobytes.
 *
 * The caller's buffer is detached by the transfer and must not be read afterwards. That is the
 * contract of handing bytes over, and it is why `convert` and `expand` take the last reference to
 * them.
 */
function transferable(bytes: Buffer): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export class ConversionService {
  readonly #settings: ConversionSettings;
  readonly #entry: URL;
  readonly #pending = new Map<number, Pending>();
  /** Expansions the worker is holding open, so a crash can forget them and `close` can skip a dead thread. */
  readonly #sessions = new Set<number>();
  #worker: Worker | null = null;
  #nextId = 1;
  #idleTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(settings: ConversionSettings) {
    this.#settings = settings;
    this.#entry = settings.entry ?? new URL('./worker.js', import.meta.url);
  }

  /**
   * Whether a conversion thread is being held right now.
   *
   * The idle promise — ADR-0071 §3, `README.md` and `.env.example` all make it — is a promise about
   * exactly this bit: after `CONVERSION_IDLE_MS` with nothing to convert it goes false, and the heap a
   * large document grew goes back to the operating system with it.
   */
  get threadHeld(): boolean {
    return this.#worker !== null;
  }

  /**
   * One file's bytes → the Markdown that is chunked and stored.
   *
   * **The bytes are handed over, not lent**: they are transferred into the worker and the caller's
   * buffer is empty when this returns.
   */
  async convert(relativePath: string, flavor: Flavor, bytes: Buffer, limits: ExtractLimits): Promise<string> {
    const buffer = transferable(bytes);
    const reply = await this.#send({ kind: 'convert', relativePath, flavor, bytes: buffer, limits }, relativePath, [buffer]);
    if (reply.kind !== 'converted') throw new Error(`conversion answered "${reply.kind}" to a convert request`);
    return reply.markdown;
  }

  /**
   * A specification's bytes → the documents it expands into, pulled one at a time (ADR-0057).
   *
   * Parsing and validation happen before this resolves, so a file that is not a specification, is over
   * its ceiling, or will not parse is refused here — the same moment it was refused when the parse was
   * in-process. What comes back is a handle: the object graph stays in the worker, and each `next`
   * carries exactly one rendered document.
   *
   * The bytes are handed over, as in `convert`.
   */
  async expand(relativePath: string, bytes: Buffer, limits: SpecLimits): Promise<ConversionExpansion> {
    const buffer = transferable(bytes);
    const opened = await this.#send({ kind: 'expand', relativePath, bytes: buffer, limits }, relativePath, [buffer]);
    if (opened.kind !== 'opened') throw new Error(`conversion answered "${opened.kind}" to an expand request`);
    const session = opened.id;
    this.#sessions.add(session);
    const service = this;
    return {
      count: opened.count,
      async *documents(): AsyncGenerator<DerivedDocument> {
        try {
          for (;;) {
            const reply = await service.#send({ kind: 'next', session }, relativePath);
            if (reply.kind === 'end') {
              service.#sessions.delete(session);
              return;
            }
            if (reply.kind !== 'document') throw new Error(`conversion answered "${reply.kind}" to a next request`);
            yield reply.document;
          }
        } finally {
          // Every way out of the loop comes through here — the last document, a `break`, a throw — and
          // it has to, because letting the thread go is bookkeeping this class cannot do while a
          // session is still registered against it. `for await` runs this on all three.
          await service.#release(session);
        }
      },
    };
  }

  /** Drop the worker and refuse whatever it was doing. Called on shutdown; idempotent. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const worker = this.#worker;
    this.#worker = null;
    this.#failAll('the server is shutting down');
    await worker?.terminate();
  }

  /**
   * An expansion is over, however it ended.
   *
   * **Two things happen here and only one of them is conditional, which is the bug this shape exists
   * to prevent.** A reader that walked away leaves the specification's object graph live on the far
   * side, so that session is closed — the indexer stops reading whenever a document fails to embed or
   * to write, and the graph would otherwise stay until some later file replaced it. An expansion read
   * to its end needs no `close`: the worker dropped that session itself when its generator finished.
   *
   * But **the thread has to be let go in both cases**, and `#armIdle` cannot be the one to notice: it
   * runs from `#settle`, which for the final `next` fires while the session is still registered and so
   * correctly declines to release anything. Leaving the release to the `close` message meant an
   * expansion read to the end — the ordinary path, and the one ADR-0057 calls the heaviest — never
   * armed the idle timer and never unref'd the thread. A run whose last converted file was a
   * specification held its thread for ever, against four documents that promise otherwise.
   */
  async #release(session: number): Promise<void> {
    const abandoned = this.#sessions.delete(session);
    if (abandoned && this.#worker) {
      // A failure here is not worth reporting: the expansion is already being abandoned, and the only
      // thing a dead worker can cost is memory it no longer has.
      await this.#send({ kind: 'close', session }, 'an abandoned specification').catch(() => undefined);
    }
    this.#armIdle();
  }

  #send(request: WithoutId<ConversionRequest>, relativePath: string, transfer: readonly ArrayBuffer[] = []): Promise<ConversionSuccess> {
    if (this.#stopped) return Promise.reject(new DocumentExtractionError(`"${relativePath}" was not converted: the server is shutting down.`));
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise<ConversionSuccess>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // The thread cannot be asked to stop; a parser in a loop never returns to the event loop where
        // a "cancel" message would be read. Replacing it is the only way to get the process back.
        this.#replaceWorker(`it did not answer within ${seconds(this.#settings.timeoutMs)}`);
        reject(
          new DocumentExtractionError(
            `"${relativePath}" was still being converted after ${seconds(this.#settings.timeoutMs)} and was abandoned. ` +
              `Conversion runs on its own thread and that thread was replaced, so the run carried on and the server was unaffected; ` +
              `raise CONVERSION_TIMEOUT_MS if a file this size is genuinely a document, or remove it from the source.`,
          ),
        );
      }, this.#settings.timeoutMs);
      timer.unref();
      this.#pending.set(id, { relativePath, resolve, reject, timer });
      this.#armIdle();
      worker.postMessage({ ...request, id } as ConversionRequest, transfer as ArrayBuffer[]);
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.#entry, { execArgv: FROM_SOURCE ? ['--import', 'tsx'] : [] });
    worker.on('message', (reply: ConversionReply) => this.#settle(reply));
    // A reply that would not deserialize tells us nothing about which request it belonged to, so it is
    // handled the way a dead thread is rather than guessed at.
    worker.on('messageerror', (err) => this.#replaceWorker(`it sent a message that could not be read: ${err.message}`));
    worker.on('error', (err) => this.#replaceWorker(`it failed: ${err.message}`));
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#replaceWorker(`it exited with code ${code}`);
    });
    this.#worker = worker;
    return worker;
  }

  #settle(reply: ConversionReply): void {
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    this.#pending.delete(reply.id);
    clearTimeout(pending.timer);
    this.#armIdle();
    if (reply.ok) pending.resolve(reply);
    // `refusal` is the one bit that decides between a refused file and a failed run, and it is read
    // here rather than re-derived from the message.
    else pending.reject(reply.refusal ? new DocumentExtractionError(reply.message) : new Error(reply.message));
  }

  /**
   * The thread is gone or is being given up on: forget it, refuse everything it was holding, and let
   * the next request spawn a fresh one.
   *
   * **This is the criterion the phase exists for.** A parser that crashes its thread used to crash the
   * process; now it fails the files it was holding, by name, with the reason ending up on the owning
   * source, and the dashboard and `/mcp` never noticed.
   */
  #replaceWorker(reason: string): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#sessions.clear();
    // Said once, here, because this is a fact about the server rather than about a file: the files are
    // each reported by `indexer.ts` as it refuses them, and an operator reading a log full of refused
    // documents has nothing telling them the thread underneath went away.
    if (worker) this.#settings.log?.warn({ reason, files: this.#pending.size }, 'conversion thread replaced');
    this.#failAll(reason);
    void worker?.terminate();
  }

  #failAll(reason: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const one of pending) {
      clearTimeout(one.timer);
      one.reject(
        new DocumentExtractionError(
          `"${one.relativePath}" could not be converted: the conversion thread stopped before it answered — ${reason}. ` +
            `Conversion runs off the server's own thread, so nothing else was affected. ` +
            `A file that was already indexed keeps the document it had until its bytes change or the project is rebuilt; one that was not is converted again on the next run.`,
        ),
      );
    }
  }

  /** Nothing in flight and nothing held open: let the thread go, after a while. */
  #armIdle(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    const worker = this.#worker;
    if (!worker) return;
    if (this.#pending.size > 0 || this.#sessions.size > 0) {
      worker.ref();
      return;
    }
    // An idle thread must not be what keeps the process alive — a `scripts/*.ts` entry point that
    // converted one file would otherwise never exit.
    worker.unref();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#pending.size > 0 || this.#sessions.size > 0 || this.#worker !== worker) return;
      this.#worker = null;
      void worker.terminate();
    }, this.#settings.idleMs);
    this.#idleTimer.unref();
  }
}
