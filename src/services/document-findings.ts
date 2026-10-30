import { createHmac } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { documentFindings, documentScans, documents, projects } from '../db/schema.js';
import { secretKeyId } from './crypto.js';
import { PII_RULES, PII_RULESET_VERSION, type Finding, type PiiRule } from './pii-rules.js';
import { ValidationError } from './projects.js';

/**
 * The PII scan's tables and the keys its findings are made under ([ADR-0130](../../.ssot/ADR.md#adr-0130)).
 *
 * Reading and writing only: which rules exist is `pii-rules.ts`, and when a document is scanned is
 * `pii-scan.ts`. What this file guarantees is the part that must not drift between the two: the shape of a stored
 * finding, which holds no value and no plain hash of one, and the statement that decides a document is due.
 */

/**
 * The label the findings key is derived under. A key derived from `SECRET_KEY` for this purpose alone, so that a
 * finding's HMAC is not an oracle for anything else `SECRET_KEY` keys: not the key the secrets are encrypted
 * under, and not the key id other rows carry.
 */
export const FINDINGS_HMAC_LABEL = 'contextator.findings-hmac.v1';

/** The findings key for a `SECRET_KEY`: `HMAC-SHA-256(SECRET_KEY, label)`. Only the current key is ever used, never the previous one. */
export function findingsKey(secretKey: string): Buffer {
  return createHmac('sha256', secretKey).update(FINDINGS_HMAC_LABEL).digest();
}

/** The value's HMAC under the findings key, as hex. The input is the rule's normalised value. */
export function valueHmac(key: Buffer, normalized: string): string {
  return createHmac('sha256', key).update(normalized, 'utf8').digest('hex');
}

/** What the instance keys findings with: the derived key and its id, or `null` when there is no `SECRET_KEY` (ADR-0130 decision 3). */
export interface FindingsKeying {
  key: Buffer;
  keyId: string;
}

export function keyingFor(secretKey: string | undefined): FindingsKeying | null {
  return secretKey ? { key: findingsKey(secretKey), keyId: secretKeyId(secretKey) } : null;
}

/** A finding as it is stored: the engine's finding with its value dropped and, when there is a key, keyed. */
export interface StoredFinding {
  rule: PiiRule;
  line: number;
  col: number;
  startOffset: number;
  length: number;
  preview: string;
  valueHmac: string | null;
  hmacKeyId: string | null;
}

/** The only place a {@link Finding}'s `normalized` is read: it is keyed here and goes no further. */
export function toStoredFinding(finding: Finding, keying: FindingsKeying | null): StoredFinding {
  return {
    rule: finding.rule,
    line: finding.line,
    col: finding.col,
    startOffset: finding.start,
    length: finding.length,
    preview: finding.preview,
    valueHmac: keying ? valueHmac(keying.key, finding.normalized) : null,
    hmacKeyId: keying ? keying.keyId : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Which documents are due
// ---------------------------------------------------------------------------------------------

/**
 * A document is due when it has no scan row, or its `content_hash` is not the one the scan read, or the rule set
 * or the key it was scanned under has moved. (ADR-0130 decision 5.) A document whose text is not stored is
 * `no_content` and is **not** retried because the rule set or the key moved: there is nothing to scan again.
 *
 * Over `documents` left-joined to `document_scans`; both statements that use it below build that join.
 */
function due(keyId: string | null) {
  return sql`(${documentScans.documentId} is null
    or ${documentScans.contentHash} <> ${documents.contentHash}
    or (${documentScans.status} = 'scanned'
      and (${documentScans.ruleset} <> ${PII_RULESET_VERSION} or ${documentScans.hmacKeyId} is distinct from ${keyId}::text)))`;
}

export interface DueDocument {
  id: string;
  contentHash: string;
  content: string | null;
  contentTruncated: boolean;
}

/**
 * The next documents of a project's live generation that are due, with their text, in id order and after `after`.
 *
 * **A keyset, and that is what keeps a pass linear.** A pass walks the ids upward and never looks back, so a batch
 * costs the index range it reads and not the project's whole document set, and a document that could not be written
 * or was replaced under the scan needs no list of its own: it is behind the cursor, and the next index change asks again.
 */
export async function selectDueDocuments(
  db: Db,
  projectId: string,
  keyId: string | null,
  limit: number,
  after: string | null,
): Promise<DueDocument[]> {
  return db
    .select({ id: documents.id, contentHash: documents.contentHash, content: documents.content, contentTruncated: documents.contentTruncated })
    .from(documents)
    .innerJoin(projects, and(eq(projects.id, documents.projectId), eq(documents.indexGeneration, projects.liveGeneration)))
    .leftJoin(documentScans, eq(documentScans.documentId, documents.id))
    .where(and(eq(documents.projectId, projectId), due(keyId), after === null ? undefined : gt(documents.id, after)))
    .orderBy(asc(documents.id))
    .limit(limit);
}

/** Every project that has at least one document due, for the sweep at startup. */
export async function projectsWithDueDocuments(db: Db, keyId: string | null): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: documents.projectId })
    .from(documents)
    .innerJoin(projects, and(eq(projects.id, documents.projectId), eq(documents.indexGeneration, projects.liveGeneration)))
    .leftJoin(documentScans, eq(documentScans.documentId, documents.id))
    .where(due(keyId));
  return rows.map((r) => r.projectId);
}

export interface ScanRecord {
  documentId: string;
  projectId: string;
  /** The `content_hash` of the document as it was read. The write refuses to land if the document has since moved. */
  contentHash: string;
  status: 'scanned' | 'no_content';
  keyId: string | null;
  /** Every finding there was, whether or not all of them are kept. */
  findingCount: number;
  /** More findings than the per-document ceiling. Not "the text was cut": that is `documents.content_truncated`. */
  capped: boolean;
  findings: readonly StoredFinding[];
}

/**
 * Replaces a document's findings and its scan row in one transaction (ADR-0130 decision 5): the old findings are
 * deleted and the new ones written, so a reader never sees both and never sees neither.
 *
 * `stale` when the document is gone or its hash is no longer the one that was scanned: the indexer replaced it while
 * the scan was running, and the scan describes text that is no longer there. Nothing is written, and the document is
 * due again. The row is locked `FOR SHARE` for the length of the transaction, so a replacement waits for these few
 * statements and cannot slip in between the check and the write.
 */
export async function recordScan(db: Db, record: ScanRecord): Promise<'written' | 'stale'> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, record.documentId), eq(documents.contentHash, record.contentHash)))
      .for('share');
    if (!current) return 'stale';

    await tx.delete(documentFindings).where(eq(documentFindings.documentId, record.documentId));
    if (record.findings.length > 0) {
      await tx.insert(documentFindings).values(record.findings.map((f) => ({ ...f, projectId: record.projectId, documentId: record.documentId })));
    }
    const scan = {
      projectId: record.projectId,
      status: record.status,
      ruleset: PII_RULESET_VERSION,
      contentHash: record.contentHash,
      hmacKeyId: record.keyId,
      findingCount: record.findingCount,
      capped: record.capped,
      scannedAt: new Date(),
    };
    await tx
      .insert(documentScans)
      .values({ documentId: record.documentId, ...scan })
      .onConflictDoUpdate({ target: documentScans.documentId, set: scan });
    return 'written';
  });
}

// ---------------------------------------------------------------------------------------------
// Reading them back (ADR-0130 decision 6)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_FINDINGS_LIMIT = 50;
export const MAX_FINDINGS_LIMIT = 200;

/** How many hex characters of the HMAC a response shows as a group id. Enough to group; the HMAC itself never leaves. */
const GROUP_ID_CHARS = 12;

export interface FindingView {
  id: string;
  rule: PiiRule;
  path: string;
  title: string;
  line: number;
  col: number;
  preview: string;
  /** A short id shared by findings of the same value, or `null` when there is no key to group under. */
  group: string | null;
  sourceUrl: string | null;
}

export interface FindingsSummary {
  byRule: Record<PiiRule, number>;
  /** Documents of the live generation scanned as they now are. */
  documentsScanned: number;
  /** Documents the scanner has still to look at, including those whose scan predates the rule set or the key. */
  documentsPending: number;
  /** Documents whose text is not stored, so there was nothing to scan. */
  documentsWithoutText: number;
  /** Scanned documents that have more findings than are kept (`document_scans.capped`). */
  documentsCapped: number;
  /** Scanned documents whose stored text was cut at `MAX_STORED_DOCUMENT_BYTES`, so the end of the document was not read. */
  documentsTruncated: number;
}

/** An opaque cursor: the position of the last finding returned, in the order the list is sorted in. */
const Cursor = z.tuple([z.string(), z.number().int().min(0), z.uuid()]);

function encodeCursor(row: { path: string; startOffset: number; id: string }): string {
  return Buffer.from(JSON.stringify([row.path, row.startOffset, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new ValidationError('cursor is not one this server issued');
  }
}

export interface ListFindingsOptions {
  rule?: PiiRule | undefined;
  limit: number;
  cursor?: string | undefined;
  /** The current key id; a group id is shown only for an HMAC made under it. */
  keyId: string | null;
}

/**
 * A project's findings, in document path and reading order, for the live generation and only where the scan read
 * the document as it is now. A page of at most `limit`, and the cursor for the next one when there is one.
 */
export async function listFindings(
  db: Db,
  projectId: string,
  options: ListFindingsOptions,
): Promise<{ findings: FindingView[]; nextCursor: string | null }> {
  const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
  const rows = await db
    .select({
      id: documentFindings.id,
      rule: documentFindings.rule,
      path: documents.relativePath,
      title: documents.title,
      line: documentFindings.line,
      col: documentFindings.col,
      startOffset: documentFindings.startOffset,
      preview: documentFindings.preview,
      valueHmac: documentFindings.valueHmac,
      hmacKeyId: documentFindings.hmacKeyId,
      sourceUrl: documents.sourceUrl,
    })
    .from(documentFindings)
    .innerJoin(documents, eq(documents.id, documentFindings.documentId))
    .innerJoin(projects, and(eq(projects.id, documents.projectId), eq(documents.indexGeneration, projects.liveGeneration)))
    .innerJoin(documentScans, and(eq(documentScans.documentId, documents.id), eq(documentScans.contentHash, documents.contentHash)))
    .where(
      and(
        eq(documentFindings.projectId, projectId),
        options.rule === undefined ? undefined : eq(documentFindings.rule, options.rule),
        after === null
          ? undefined
          : sql`(${documents.relativePath}, ${documentFindings.startOffset}, ${documentFindings.id}) > (${after[0]}::text, ${after[1]}::integer, ${after[2]}::uuid)`,
      ),
    )
    .orderBy(asc(documents.relativePath), asc(documentFindings.startOffset), asc(documentFindings.id))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    findings: page.map((row) => ({
      id: row.id,
      rule: row.rule as PiiRule,
      path: row.path,
      title: row.title,
      line: row.line,
      col: row.col,
      preview: row.preview,
      group: options.keyId !== null && row.hmacKeyId === options.keyId && row.valueHmac ? row.valueHmac.slice(0, GROUP_ID_CHARS) : null,
      sourceUrl: row.sourceUrl,
    })),
    nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
  };
}

/** The counts behind the dashboard's header; every rule has an entry, including the ones with no findings. */
export async function summarizeFindings(db: Db, projectId: string, keyId: string | null): Promise<FindingsSummary> {
  const [byRuleRows, [docs]] = await Promise.all([
    db
      .select({ rule: documentFindings.rule, n: count() })
      .from(documentFindings)
      .innerJoin(documents, eq(documents.id, documentFindings.documentId))
      .innerJoin(projects, and(eq(projects.id, documents.projectId), eq(documents.indexGeneration, projects.liveGeneration)))
      .innerJoin(documentScans, and(eq(documentScans.documentId, documents.id), eq(documentScans.contentHash, documents.contentHash)))
      .where(and(eq(documentFindings.projectId, projectId), inArray(documentFindings.rule, [...PII_RULES])))
      .groupBy(documentFindings.rule),
    db
      .select({
        pending: sql<number>`(count(*) filter (where ${due(keyId)}))::int`,
        scanned: sql<number>`(count(*) filter (where not ${due(keyId)} and ${documentScans.status} = 'scanned'))::int`,
        withoutText: sql<number>`(count(*) filter (where not ${due(keyId)} and ${documentScans.status} = 'no_content'))::int`,
        capped: sql<number>`(count(*) filter (where not ${due(keyId)} and ${documentScans.status} = 'scanned' and ${documentScans.capped}))::int`,
        truncated: sql<number>`(count(*) filter (where not ${due(keyId)} and ${documentScans.status} = 'scanned' and ${documents.contentTruncated}))::int`,
      })
      .from(documents)
      .innerJoin(projects, and(eq(projects.id, documents.projectId), eq(documents.indexGeneration, projects.liveGeneration)))
      .leftJoin(documentScans, eq(documentScans.documentId, documents.id))
      .where(eq(documents.projectId, projectId)),
  ]);
  const byRule = Object.fromEntries(PII_RULES.map((rule) => [rule, 0])) as Record<PiiRule, number>;
  for (const row of byRuleRows) byRule[row.rule as PiiRule] = row.n;
  return {
    byRule,
    documentsScanned: docs?.scanned ?? 0,
    documentsPending: docs?.pending ?? 0,
    documentsWithoutText: docs?.withoutText ?? 0,
    documentsCapped: docs?.capped ?? 0,
    documentsTruncated: docs?.truncated ?? 0,
  };
}

/** How many findings a project holds, for the export manifest's `excluded` counts. */
export async function countFindings(db: Db, projectId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(documentFindings).where(eq(documentFindings.projectId, projectId));
  return row?.n ?? 0;
}
