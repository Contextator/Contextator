import type { Config } from '../config.js';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import {
  type DueDocument,
  type FindingsKeying,
  keyingFor,
  projectsWithDueDocuments,
  recordScan,
  type ScanRecord,
  selectDueDocuments,
  toStoredFinding,
} from './document-findings.js';
import type { PiiScanObserver } from './metrics.js';
import { PII_RULES, type PiiRule, scanText } from './pii-rules.js';

/**
 * The PII scanner ([ADR-0130](../../.ssot/ADR.md#adr-0130)): looks through the stored text of the documents a
 * project serves and records where it finds a secret or a personal number. **Report only** — it reads
 * `documents.content` and writes `document_findings` and `document_scans`, and nothing it does changes a document,
 * a chunk, a vector or a search result (ADR-0043, FR-523, FR-404; K-13).
 *
 * **It is not part of the indexer.** It is asked after the index changed, through the same hook the eval runner
 * uses (`IndexerDeps.onIndexChanged`, ADR-0124), and once at startup for everything that is due, so a corpus indexed
 * before this feature existed is scanned without being re-embedded. The indexer's write path, which is the hottest
 * one there is, carries nothing for a feature that does not affect search.
 *
 * One scanner for the whole instance, and one project at a time: a request for a project that is waiting is
 * already covered by the wait, one for the project being scanned queues it once more, and between batches the
 * event loop is given back, so a large corpus does not hold up the searches the process is also serving.
 */

/** Documents read per statement. A batch holds up to this many stored texts in memory at once, each at most `MAX_STORED_DOCUMENT_BYTES`. */
export const PII_SCAN_BATCH_SIZE = 20;

export interface PiiScannerDeps {
  db: Db;
  config: Pick<Config, 'PII_SCAN' | 'SECRET_KEY'>;
  log: Logger;
  metrics?: PiiScanObserver;
  /** Overridable so a test can see a project scanned in more than one batch. */
  batchSize?: number;
}

/** What scanning one document comes to, before it is written. The value of a finding has already been dropped. */
export function buildScanRecord(projectId: string, document: DueDocument, keying: FindingsKeying | null): ScanRecord {
  const base = { documentId: document.id, projectId, contentHash: document.contentHash, keyId: keying?.keyId ?? null };
  // A row written before `documents.content` existed. There is nothing to read and nothing will change that for this
  // row, so it is marked and not asked again.
  if (document.content === null) return { ...base, status: 'no_content', findingCount: 0, capped: false, findings: [] };
  const outcome = scanText(document.content);
  return {
    ...base,
    status: 'scanned',
    findingCount: outcome.total,
    // The ceiling only. Text cut when it was stored is `documents.content_truncated`, which the summary counts on its own.
    capped: outcome.capped,
    findings: outcome.findings.map((finding) => toStoredFinding(finding, keying)),
  };
}

/** The message of a driver error, or the name of whatever else was thrown; never the statement drizzle puts in its own wrapper's message. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'DrizzleQueryError' ? 'query failed' : err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class PiiScanner {
  private readonly pending = new Set<string>();
  private readonly keying: FindingsKeying | null;
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: PiiScannerDeps) {
    this.keying = keyingFor(deps.config.SECRET_KEY);
  }

  /**
   * The index of a project changed. Fire and forget, and never throws: it is called from the indexer's hook after
   * the run, and must not hold or fail it. With `PII_SCAN=0` it does nothing, and findings that exist stay.
   */
  request(projectId: string): void {
    if (this.stopped || !this.deps.config.PII_SCAN) return;
    this.pending.add(projectId);
    this.kick();
  }

  /** Startup: every project that has a document due, which on a first start after the upgrade is all of them. */
  async sweep(): Promise<void> {
    if (this.stopped || !this.deps.config.PII_SCAN) return;
    const ids = await projectsWithDueDocuments(this.deps.db, this.keying?.keyId ?? null);
    for (const id of ids) this.request(id);
    if (ids.length > 0) this.deps.log.info({ projects: ids.length }, 'pii scan: projects with documents to scan');
  }

  /** Resolves when nothing is waiting or running; for tests, never for a request. */
  async settled(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Shutdown: nothing new starts and the scan in hand stops at the end of its document. The next start finds what is left. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    await this.settled();
  }

  private kick(): void {
    if (this.draining || this.stopped) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      // A request that arrived after the loop saw an empty queue and before this ran.
      if (this.pending.size > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const next = this.pending.values().next();
      if (next.done) return;
      const projectId = next.value;
      // Removed before it is scanned, so a request that arrives meanwhile queues one more pass and is not lost.
      this.pending.delete(projectId);
      try {
        await this.scanProject(projectId);
      } catch (err) {
        this.deps.log.warn({ err, projectId }, 'pii scan of a project failed');
      }
    }
  }

  private async scanProject(projectId: string): Promise<void> {
    const { db, log } = this.deps;
    const batchSize = this.deps.batchSize ?? PII_SCAN_BATCH_SIZE;
    const keyId = this.keying?.keyId ?? null;
    // The pass walks ids upward and never looks back (`selectDueDocuments`): a document it could not write, or that was
    // replaced under the scan, is behind the cursor and is due again after the run that replaced it, which calls the hook.
    let after: string | null = null;
    let scanned = 0;
    for (;;) {
      if (this.stopped) return;
      const batch = await selectDueDocuments(db, projectId, keyId, batchSize, after);
      const last = batch.at(-1);
      if (!last) break;
      for (const document of batch) {
        if (this.stopped) return;
        if (await this.scanOne(projectId, document)) scanned++;
      }
      after = last.id;
      await yieldToEventLoop();
    }
    if (scanned > 0) log.debug({ projectId, scanned }, 'pii scan finished');
  }

  /** Whether the document's scan was written. A failure is counted and logged, and never stops the pass. */
  private async scanOne(projectId: string, document: DueDocument): Promise<boolean> {
    const { db, log, metrics } = this.deps;
    try {
      const record = buildScanRecord(projectId, document, this.keying);
      if ((await recordScan(db, record)) === 'stale') return false;
      metrics?.countDocumentScan(record.status);
      const perRule = new Map<PiiRule, number>();
      for (const finding of record.findings) perRule.set(finding.rule, (perRule.get(finding.rule) ?? 0) + 1);
      for (const rule of PII_RULES) {
        const n = perRule.get(rule);
        if (n) metrics?.countDocumentFindings(rule, n);
      }
      return true;
    } catch (err) {
      // No text and no finding goes into the log, and so not the error object either. drizzle wraps a failed statement
      // in an error whose message is the statement and its parameters (every preview and HMAC of the document), and
      // the driver's own error, with the SQLSTATE, is its `cause`. Only that one's message (which carries no
      // parameters) and code are logged, and where it happened.
      const root = err instanceof Error && err.cause instanceof Error ? err.cause : err;
      log.warn(
        { error: errorMessage(root), code: (root as { code?: unknown }).code, projectId, documentId: document.id },
        'pii scan of a document failed',
      );
      metrics?.countDocumentScan('failed');
      return false;
    }
  }
}
