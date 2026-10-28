import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/context.js';
import type { Db } from '../src/db/client.js';
import { secretKeyId } from '../src/services/crypto.js';
import { findingsKey, keyingFor, valueHmac } from '../src/services/document-findings.js';
import { type DocumentScanOutcome, MetricsRegistry, renderPrometheus } from '../src/services/metrics.js';
import { buildScanRecord, PiiScanner } from '../src/services/pii-scan.js';
import { MAX_FINDINGS_PER_DOCUMENT, PII_RULESET_VERSION } from '../src/services/pii-rules.js';

/**
 * The PII scanner ([ADR-0130](../.ssot/ADR.md#adr-0130)) without a database: what it writes down about a document,
 * and how it schedules itself. The statements that decide which documents are due, and the transaction that
 * replaces their findings, are held to a real Postgres in `test/integration/document-findings.itest.ts`.
 *
 * The claim carried here is the one the feature stands on: **a finding holds a place, a masked preview and a keyed
 * HMAC, and neither the value nor a plain hash of it is anywhere in what is written.**
 */

// What the scanner asks of the database is replaced by a small model of it. Only the scheduling is under test.
const store = vi.hoisted(() => ({
  documents: new Map<string, { projectId: string; content: string | null; done: boolean }>(),
  selects: [] as Array<{ projectId: string; limit: number; after: string | null }>,
  recorded: [] as Array<{ documentId: string; status: string }>,
  failOn: new Set<string>(),
  staleOn: new Set<string>(),
  active: 0,
  maxActive: 0,
  withDueProjects: [] as string[],
}));

vi.mock('../src/services/document-findings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/document-findings.js')>();
  return {
    ...original,
    selectDueDocuments: vi.fn(async (_db: unknown, projectId: string, _keyId: string | null, limit: number, after: string | null) => {
      store.selects.push({ projectId, limit, after });
      store.active++;
      store.maxActive = Math.max(store.maxActive, store.active);
      await new Promise((resolve) => setImmediate(resolve));
      store.active--;
      return [...store.documents.entries()]
        .filter(([id, d]) => d.projectId === projectId && !d.done && (after === null || id > after))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([id, d]) => ({ id, contentHash: `hash-${id}`, content: d.content, contentTruncated: false }));
    }),
    recordScan: vi.fn(async (_db: unknown, record: { documentId: string; status: string }) => {
      if (store.failOn.has(record.documentId)) throw new Error('write failed');
      if (store.staleOn.has(record.documentId)) return 'stale';
      store.recorded.push({ documentId: record.documentId, status: record.status });
      const doc = store.documents.get(record.documentId);
      if (doc) doc.done = true;
      return 'written';
    }),
    projectsWithDueDocuments: vi.fn(async () => store.withDueProjects),
  };
});

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const TCKN = '10000000146';
const IBAN = 'TR33 0006 1005 1978 6457 8413 26';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SECRET = 'a-secret-key-that-is-at-least-thirty-two-characters-long';

const text = `key ${AWS}\ncitizen ${TCKN}\niban ${IBAN}\ntoken ${JWT}\n`;
const document = { id: 'd1', contentHash: 'h1', content: text, contentTruncated: false };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('what is written down about a document', () => {
  it('holds no value and no plain hash of one, with a key and without', () => {
    for (const keying of [keyingFor(SECRET), null]) {
      const record = buildScanRecord('p1', document, keying);
      const written = JSON.stringify(record);
      expect(record.findings.map((f) => f.rule)).toEqual(['aws_access_key', 'tckn', 'iban', 'jwt']);
      for (const value of [AWS, TCKN, IBAN, IBAN.replaceAll(' ', ''), JWT]) {
        expect(written).not.toContain(value);
        expect(written).not.toContain(sha256(value));
        expect(written).not.toContain(createHash('sha1').update(value).digest('hex'));
        expect(written).not.toContain(createHash('md5').update(value).digest('hex'));
      }
    }
  });

  it('keys each value under the key derived for findings, and records that key id', () => {
    const keying = keyingFor(SECRET);
    const record = buildScanRecord('p1', document, keying);
    const derived = createHmac('sha256', SECRET).update('contextator.findings-hmac.v1').digest();
    const tckn = record.findings.find((f) => f.rule === 'tckn');
    expect(tckn?.valueHmac).toBe(createHmac('sha256', derived).update(TCKN).digest('hex'));
    expect(tckn?.hmacKeyId).toBe(secretKeyId(SECRET));
    expect(record.keyId).toBe(secretKeyId(SECRET));
    // An IBAN is keyed without its spaces, so the same account written two ways is one value.
    const iban = record.findings.find((f) => f.rule === 'iban');
    expect(iban?.valueHmac).toBe(valueHmac(derived, 'TR330006100519786457841326'));
  });

  it('writes the findings without an HMAC when there is no SECRET_KEY (ADR-0130 decision 3)', () => {
    const record = buildScanRecord('p1', document, keyingFor(undefined));
    expect(record.findings).toHaveLength(4);
    for (const finding of record.findings) {
      expect(finding.valueHmac).toBeNull();
      expect(finding.hmacKeyId).toBeNull();
    }
    expect(record.keyId).toBeNull();
  });

  it('is a key of its own: not the encryption key, and not the key id other rows carry', () => {
    const encryptionKey = createHash('sha256').update(SECRET, 'utf8').digest();
    expect(findingsKey(SECRET).equals(encryptionKey)).toBe(false);
    expect(findingsKey(SECRET).toString('hex')).not.toBe(secretKeyId(SECRET));
    expect(findingsKey(SECRET).equals(findingsKey(SECRET))).toBe(true);
    expect(findingsKey(SECRET).equals(findingsKey(`${SECRET}x`))).toBe(false);
  });

  it('gives one value one HMAC wherever it is found, and two values two', () => {
    const keying = keyingFor(SECRET);
    const a = buildScanRecord('p1', { ...document, id: 'a', content: `one ${TCKN}` }, keying).findings[0].valueHmac;
    const b = buildScanRecord('p1', { ...document, id: 'b', content: `elsewhere: ${TCKN}.` }, keying).findings[0].valueHmac;
    expect(a).toBe(b);
    // 10000000214 is a second citizen number that passes the checksum.
    const second = buildScanRecord('p1', { ...document, id: 'c', content: 'one 10000000214' }, keying).findings[0].valueHmac;
    expect(a).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(a);
  });

  it('marks a document with no stored text and keeps the count of what it found when it caps', () => {
    const none = buildScanRecord('p1', { ...document, content: null }, keyingFor(SECRET));
    expect(none).toMatchObject({ status: 'no_content', findingCount: 0, capped: false, findings: [] });

    const many = Array.from({ length: MAX_FINDINGS_PER_DOCUMENT + 10 }, () => TCKN).join('\n');
    const capped = buildScanRecord('p1', { ...document, content: many }, null);
    expect(capped).toMatchObject({ status: 'scanned', findingCount: MAX_FINDINGS_PER_DOCUMENT + 10, capped: true });
    expect(capped.findings).toHaveLength(MAX_FINDINGS_PER_DOCUMENT);

    // Text that was cut when it was stored is not "more findings than are kept": the summary counts it from the document.
    const cut = buildScanRecord('p1', { ...document, content: `x ${TCKN}`, contentTruncated: true }, null);
    expect(cut.capped).toBe(false);
    expect(cut.findingCount).toBe(1);
  });

  it('names the rule-set version it scanned with', () => {
    expect(PII_RULESET_VERSION).toBeGreaterThanOrEqual(1);
  });
});

const logger = (): Logger => {
  const noop = () => undefined;
  return { warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop, child: () => logger() } as unknown as Logger;
};

const scanner = (overrides: { PII_SCAN?: boolean; batchSize?: number; metrics?: MetricsRegistry; SECRET_KEY?: string } = {}): PiiScanner =>
  new PiiScanner({
    db: {} as Db,
    config: { PII_SCAN: overrides.PII_SCAN ?? true, SECRET_KEY: overrides.SECRET_KEY },
    log: logger(),
    ...(overrides.metrics ? { metrics: overrides.metrics } : {}),
    ...(overrides.batchSize ? { batchSize: overrides.batchSize } : {}),
  });

const addDocuments = (projectId: string, ids: string[], content: string | null = `x ${AWS}`): void => {
  for (const id of ids) store.documents.set(id, { projectId, content, done: false });
};

beforeEach(() => {
  store.documents.clear();
  store.selects.length = 0;
  store.recorded.length = 0;
  store.failOn.clear();
  store.staleOn.clear();
  store.active = 0;
  store.maxActive = 0;
  store.withDueProjects = [];
});

describe('the scanner', () => {
  it('scans a project in batches until nothing is due, and counts what it did', async () => {
    addDocuments('p1', ['a', 'b', 'c', 'd', 'e']);
    addDocuments('p1', ['empty'], null);
    const metrics = new MetricsRegistry();
    const s = scanner({ batchSize: 2, metrics });
    s.request('p1');
    await s.settled();

    expect(store.recorded).toHaveLength(6);
    // Three full batches, then the one that finds nothing.
    expect(store.selects.map((q) => q.limit)).toEqual([2, 2, 2, 2]);
    expect(metrics.piiScan().scans).toEqual({ scanned: 5, no_content: 1, failed: 0 });
    expect(metrics.piiScan().findings.aws_access_key).toBe(5);
  });

  it('does nothing with PII_SCAN=0, at a request and at the startup sweep', async () => {
    addDocuments('p1', ['a']);
    store.withDueProjects = ['p1'];
    const s = scanner({ PII_SCAN: false });
    s.request('p1');
    await s.sweep();
    await s.settled();
    expect(store.selects).toHaveLength(0);
    expect(store.recorded).toHaveLength(0);
  });

  it('scans one project at a time, however many ask', async () => {
    addDocuments('p1', ['a', 'b']);
    addDocuments('p2', ['c', 'd']);
    addDocuments('p3', ['e']);
    const s = scanner({ batchSize: 1 });
    s.request('p1');
    s.request('p2');
    s.request('p3');
    s.request('p1');
    await s.settled();
    expect(store.maxActive).toBe(1);
    expect(store.recorded).toHaveLength(5);
  });

  it('scans again what was asked for while it was scanning', async () => {
    addDocuments('p1', ['a']);
    const s = scanner();
    s.request('p1');
    // The pass has taken the project off the queue and is reading; a document arrives and the hook fires again.
    await new Promise((resolve) => setImmediate(resolve));
    addDocuments('p1', ['b']);
    s.request('p1');
    await s.settled();
    expect(store.recorded.map((r) => r.documentId).sort()).toEqual(['a', 'b']);
  });

  it('sweeps the projects that have something due, at startup', async () => {
    addDocuments('p1', ['a']);
    addDocuments('p2', ['b']);
    store.withDueProjects = ['p1', 'p2'];
    const s = scanner();
    await s.sweep();
    await s.settled();
    expect(store.recorded).toHaveLength(2);
  });

  it('counts a document it could not write as failed, does not ask for it again in the pass, and finishes the rest', async () => {
    addDocuments('p1', ['a', 'bad', 'c']);
    store.failOn.add('bad');
    const metrics = new MetricsRegistry();
    const s = scanner({ batchSize: 10, metrics });
    s.request('p1');
    await s.settled();
    expect(store.recorded.map((r) => r.documentId)).toEqual(['a', 'c']);
    expect(metrics.piiScan().scans).toEqual({ scanned: 2, no_content: 0, failed: 1 });
    // Behind the cursor: it was asked for once and the pass went on past it.
    expect(store.selects.at(-1)?.after).toBe('c');
    expect(store.selects.map((q) => q.after)).toEqual([null, 'c']);
  });

  it('writes nothing and counts nothing for a document replaced under the scan', async () => {
    addDocuments('p1', ['a', 'moved']);
    store.staleOn.add('moved');
    const metrics = new MetricsRegistry();
    const s = scanner({ metrics });
    s.request('p1');
    await s.settled();
    expect(metrics.piiScan().scans).toEqual({ scanned: 1, no_content: 0, failed: 0 });
    expect(store.selects.map((q) => q.after)).toEqual([null, 'moved']);
  });

  it('logs a failed write without the statement drizzle puts in its error, which holds every preview and HMAC', async () => {
    addDocuments('p1', ['bad']);
    const secretParams = `params: ${'a'.repeat(64)}, AKIA…MPLE`;
    // What drizzle throws: its own wrapper, whose message is the statement and its parameters, over the driver's error.
    const driver = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const wrapped = Object.assign(new Error(`Failed query: insert into "document_findings" ...\n${secretParams}`, { cause: driver }), {
      name: 'DrizzleQueryError',
    });
    const recordScan = (await import('../src/services/document-findings.js')).recordScan as unknown as { mockRejectedValueOnce(e: unknown): void };
    recordScan.mockRejectedValueOnce(wrapped);

    const lines: unknown[][] = [];
    const log = { ...logger(), warn: (...args: unknown[]) => lines.push(args) } as unknown as Logger;
    const s = new PiiScanner({ db: {} as Db, config: { PII_SCAN: true, SECRET_KEY: undefined }, log });
    s.request('p1');
    await s.settled();
    expect(lines).toHaveLength(1);
    const logged = JSON.stringify(lines[0]);
    expect(logged).not.toContain('AKIA');
    expect(logged).not.toContain('a'.repeat(64));
    expect(logged).not.toContain('Failed query');
    expect(lines[0][0]).toMatchObject({ code: '57P01', error: 'terminating connection due to administrator command', documentId: 'bad' });
  });

  it('stops asking once stopped', async () => {
    addDocuments('p1', ['a']);
    const s = scanner();
    await s.stop();
    s.request('p1');
    await s.sweep();
    expect(store.selects).toHaveLength(0);
  });
});

describe('/metrics', () => {
  it('states both families from closed sets, with no project, document or value', () => {
    const metrics = new MetricsRegistry();
    metrics.countDocumentScan('scanned' satisfies DocumentScanOutcome);
    metrics.countDocumentFindings('tckn', 3);
    const text = renderPrometheus({
      version: '0',
      uptimeSeconds: 0,
      embeddingId: 'x',
      embeddingReady: true,
      dbUp: true,
      pool: null,
      queue: { interactive: 0, scheduled: 0, running: 0 },
      lastIndexRun: null,
      searches: { mcp: 0, dashboard: 0 },
      audit: { written: 0, failed: 0 },
      piiScan: metrics.piiScan(),
    });
    expect(text).toContain('# TYPE contextator_document_scans_total counter');
    expect(text).toContain('contextator_document_scans_total{outcome="scanned"} 1');
    expect(text).toContain('contextator_document_scans_total{outcome="no_content"} 0');
    expect(text).toContain('contextator_document_scans_total{outcome="failed"} 0');
    expect(text).toContain('# TYPE contextator_document_findings_total counter');
    expect(text).toContain('contextator_document_findings_total{rule="tckn"} 3');
    expect(text).toContain('contextator_document_findings_total{rule="aws_access_key"} 0');
    const labels = [...text.matchAll(/^contextator_document_(?:scans|findings)_total\{([^}]*)\}/gm)].map((m) => m[1]);
    expect(labels).toHaveLength(9);
    for (const label of labels) expect(label).toMatch(/^(?:outcome|rule)="[a-z_]+"$/);
  });
});
