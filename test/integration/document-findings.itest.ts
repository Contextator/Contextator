import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import cookie from '@fastify/cookie';
import { and, count, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { type Config, loadConfig, WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { chunks, documentFindings, documentScans, documents, documentSources, projects } from '../../src/db/schema.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { AuditWriter } from '../../src/services/audit.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { createUser } from '../../src/services/auth/users.js';
import { secretKeyId } from '../../src/services/crypto.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { MetricsRegistry } from '../../src/services/metrics.js';
import { PII_RULESET_VERSION } from '../../src/services/pii-rules.js';
import { PiiScanner } from '../../src/services/pii-scan.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { exportProject } from '../../src/services/transfer/export.js';
import { UploadService } from '../../src/services/uploads.js';
import { searchChunks } from '../../src/services/vector-store.js';
import { stubEmbeddings, stubVector } from './support/mcp-instance.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The PII scan ([ADR-0130](../../.ssot/ADR.md#adr-0130)) over a real database, with the real indexer and the hook
 * wired as `server.ts` wires it: a local source directory is indexed, the scanner is asked afterwards, and what it
 * wrote is read back out of the tables and out of the admin API.
 *
 * The claims, each with a test of its own:
 *
 * 1. **A finding is not the leak it reports.** Every row of both tables, as JSON, holds none of the fixture's raw
 *    values and none of their plain SHA-256, SHA-1 or MD5; and the response of the API holds neither those nor a
 *    stored HMAC in full.
 * 2. **Only an `editor` sees them** — `403` for a viewer, `200` for an editor.
 * 3. **Without `SECRET_KEY` the findings are written without an HMAC, and a key arriving fills it** without a
 *    duplicate row.
 * 4. **Search does not notice the scan.** The same fixture, searched with the scanner off and again after it ran, gives
 *    identical results; the scanner reads `documents.content` and writes its own two tables.
 * 5. **The findings follow the document:** a deleted document, a rebuild's generation swap and a deleted project take
 *    theirs, and findings of a document that has since changed are not shown.
 */

const baseUrl = inject('postgresBaseUrl');
const SECRET = 'a-secret-key-that-is-at-least-thirty-two-characters-long';
const ADMIN = { authorization: 'Bearer a-token-for-a-test' };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'pii');
// Assembled from parts: no string in this repository is shaped like a GitHub token.
const GITHUB = ['gh', 'p_', 'a1B2'.repeat(9)].join('');
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const TCKN = '10000000146';
const IBANS = ['TR33 0006 1005 1978 6457 8413 26', 'TR330006100519786457841326', 'DE89 3704 0044 0532 0130 00', 'DE89370400440532013000'];
const JWT_SIGNATURE = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM_BODY = 'RkFLRUZBS0VGQUtFRkFLRUZBS0VGQUtFRkFLRUZBS0VGQUtFRkFLRQ==';
const RAW_VALUES = [AWS, GITHUB, TCKN, ...IBANS, JWT_SIGNATURE, PEM_BODY];

let database: TestDatabase;
let db: Db;
let base: string;
let config: Config;
let app: FastifyInstance;
let scanner: PiiScanner;
let metrics: MetricsRegistry;
let indexer: Indexer;
let locks: KeyedMutex;
let sequence = 0;

// The API's configuration is one object, so a test can take `SECRET_KEY` away and give it back.
const apiConfig: Record<string, unknown> = {
  ALLOWED_ORIGINS: [],
  ALLOWED_DOC_ROOTS: ['/docs'],
  AUTH_SESSION_IDLE_MS: 60_000,
  AUTH_COOKIE_SECURE: '0',
  DATA_DIR: '',
  DATA_DIR_MIN_FREE_BYTES: 0,
  SECRET_KEY: SECRET,
  PII_SCAN: true,
  PROJECT_MAX_DOCUMENTS: 0,
  PROJECT_MAX_CHUNKS: 0,
  PROJECT_MAX_UPLOAD_BYTES: 0,
  ADMIN_TOKEN: 'a-token-for-a-test',
  METRICS_PUBLIC: false,
};

const indexerConfig = {
  ...WEB_LIMIT_DEFAULTS,
  ALLOWED_DOC_ROOTS: [] as string[],
  IGNORE_GLOBS: [] as string[],
  CHUNK_MAX_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 64,
  EMBEDDING_BATCH_SIZE: 64,
  DATA_DIR: '',
  SECRET_KEY: SECRET,
  MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
  MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
  MAX_SPEC_FILE_BYTES: 8 * 1024 * 1024,
  MAX_PDF_PAGES: 2000,
  MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
  CONVERSION_TIMEOUT_MS: 120_000,
  CONVERSION_IDLE_MS: 60_000,
  PROJECT_MAX_DOCUMENTS: 0,
  PROJECT_MAX_CHUNKS: 0,
};

const newScanner = (overrides: { PII_SCAN?: boolean; SECRET_KEY?: string | undefined; batchSize?: number } = {}): PiiScanner =>
  new PiiScanner({
    db,
    config: { PII_SCAN: overrides.PII_SCAN ?? true, SECRET_KEY: 'SECRET_KEY' in overrides ? overrides.SECRET_KEY : SECRET },
    log: silentLogger,
    metrics,
    ...(overrides.batchSize ? { batchSize: overrides.batchSize } : {}),
  });

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'document_findings');
  await applySchema(database, TEST_EMBEDDING_DIMENSIONS);
  db = database.db;
  base = await fs.mkdtemp(path.join(tmpdir(), 'document-findings-'));
  apiConfig.DATA_DIR = path.join(base, '.api-data');
  config = loadConfig({
    DATABASE_URL: database.url,
    SECRET_KEY: SECRET,
    SEARCH_SCORE_FLOOR: '0',
    ALLOWED_DOC_ROOTS: base,
    DATA_DIR: path.join(base, '.data'),
    AUTH_COOKIE_SECURE: '0',
  });
  metrics = new MetricsRegistry();
  scanner = newScanner();
  locks = new KeyedMutex();
  indexer = new Indexer({
    db,
    embeddings: stubEmbeddings,
    config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [base], DATA_DIR: path.join(base, '.data') },
    log: silentLogger,
    locks,
    // As `server.ts` wires it. `scanner` is read at call time so a test can swap it.
    onIndexChanged: (projectId) => scanner.request(projectId),
  });

  const instance = Fastify({ logger: false });
  await instance.register(cookie);
  const ctx = {
    config: apiConfig,
    db,
    log: silentLogger,
    embeddings: stubEmbeddings,
    chunkBudget: { checked: true },
    indexer: {
      stats: () => ({ interactive: 0, scheduled: 0, running: 0 }),
      isBusy: () => false,
      getJob: () => undefined,
      queueInfo: () => undefined,
    },
    locks: new KeyedMutex(),
    uploads: new UploadService(apiConfig as unknown as ConstructorParameters<typeof UploadService>[0]),
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    metrics,
    audit: new AuditWriter(db, silentLogger),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  app = instance;
});

afterAll(async () => {
  await scanner?.stop();
  await app?.close();
  if (database) await dropTestDatabase(baseUrl, database);
  if (base) await fs.rm(base, { recursive: true, force: true });
});

/** A project with a local source over a fresh directory holding `files`, not yet indexed. */
async function newProject(files: Record<string, string>): Promise<{ id: string; root: string }> {
  const root = path.join(base, `source-${sequence++}`);
  await fs.mkdir(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(root, name), body, 'utf8');
  const [project] = await db
    .insert(projects)
    .values({ name: `findings-${sequence++}` })
    .returning({ id: projects.id });
  await db.insert(documentSources).values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
  return { id: project.id, root };
}

/** Indexes, then waits until the hook has fired and the scanner it asked has finished. */
async function index(projectId: string, force = false): Promise<JobState> {
  const job = indexer.enqueue(projectId, { force });
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await sleep(5);
  }
  await locks.runExclusive(projectId, async () => {});
  await sleep(30);
  await scanner.settled();
  indexer.forget(projectId);
  expect(job.error).toBeUndefined();
  return job;
}

async function fixtureFiles(): Promise<Record<string, string>> {
  return {
    'runbook.md': await fs.readFile(path.join(FIXTURES, 'runbook.md'), 'utf8'),
    'citizens.md': await fs.readFile(path.join(FIXTURES, 'citizens.md'), 'utf8'),
    'github.md': `# CI\n\nThe release job pushes with ${GITHUB}, which is why it was revoked.\n`,
    'clean.md': '# Nothing here\n\nA page about pancakes: flour, milk and eggs, whisked and rested before the pan.\n',
  };
}

const findingsOf = (projectId: string) => db.select().from(documentFindings).where(eq(documentFindings.projectId, projectId));
const scansOf = (projectId: string) => db.select().from(documentScans).where(eq(documentScans.projectId, projectId));
const documentsOf = (projectId: string) => db.select().from(documents).where(eq(documents.projectId, projectId));
const rulesIn = (rows: Array<{ rule: string }>): string[] => rows.map((r) => r.rule).sort();

async function viewerAndEditor(projectId: string): Promise<{ viewer: Record<string, string>; editor: Record<string, string> }> {
  const make = async (role: 'viewer' | 'editor') => {
    const user = await createUser(db, { username: `findings-${role}-${sequence++}`, role: 'member', password: 'a-member-password-1!' });
    await setMemberRole(db, projectId, user.id, role, null);
    return { [SESSION_COOKIE]: (await createSession(db, user.id, 1, { userAgent: 'probe' })).token };
  };
  return { viewer: await make('viewer'), editor: await make('editor') };
}

const plainHashes = (value: string): string[] => [
  createHash('sha256').update(value).digest('hex'),
  createHash('sha1').update(value).digest('hex'),
  createHash('md5').update(value).digest('hex'),
];

describe('the fixture, indexed', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await newProject(await fixtureFiles())).id;
    await index(projectId);
  });

  it('records the rules the fixture holds, once per place, with a position and a masked preview', async () => {
    const rows = await findingsOf(projectId);
    expect(rulesIn(rows)).toEqual(['aws_access_key', 'github_token', 'iban', 'iban', 'jwt', 'private_key', 'tckn']);
    const aws = rows.find((r) => r.rule === 'aws_access_key');
    expect(aws).toMatchObject({ line: 8, preview: 'AKIA…MPLE' });
    const [runbook] = (await documentsOf(projectId)).filter((d) => d.relativePath.endsWith('runbook.md'));
    expect(runbook.content?.slice(aws?.startOffset, (aws?.startOffset ?? 0) + (aws?.length ?? 0))).toBe(AWS);
    expect(rows.find((r) => r.rule === 'tckn')?.preview).toBe('*********46');
    expect(rows.find((r) => r.rule === 'private_key')?.preview).toBe('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('writes one scan row per document, the clean one included, at the document hash and the rule set', async () => {
    const docs = await documentsOf(projectId);
    const scans = await scansOf(projectId);
    expect(docs).toHaveLength(4);
    expect(scans).toHaveLength(4);
    for (const scan of scans) {
      const doc = docs.find((d) => d.id === scan.documentId);
      expect(scan).toMatchObject({
        status: 'scanned',
        ruleset: PII_RULESET_VERSION,
        contentHash: doc?.contentHash,
        hmacKeyId: secretKeyId(SECRET),
        capped: false,
      });
    }
    expect(scans.filter((s) => s.findingCount === 0)).toHaveLength(1);
  });

  it('holds no raw value and no plain hash of one in any row of either table (claim 1)', async () => {
    const dump = JSON.stringify({ findings: await findingsOf(projectId), scans: await scansOf(projectId) });
    for (const value of RAW_VALUES) {
      expect(dump, value.slice(0, 6)).not.toContain(value);
      for (const hash of plainHashes(value)) expect(dump).not.toContain(hash);
      // The normalised forms too: an IBAN without its spaces is what is keyed.
      for (const hash of plainHashes(value.replaceAll(' ', ''))) expect(dump).not.toContain(hash);
    }
    for (const row of await findingsOf(projectId)) {
      expect(row.valueHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hmacKeyId).toBe(secretKeyId(SECRET));
    }
  });

  it('keys two different accounts to two HMACs', async () => {
    const ibans = (await findingsOf(projectId)).filter((r) => r.rule === 'iban');
    expect(ibans).toHaveLength(2);
    expect(new Set(ibans.map((r) => r.valueHmac)).size).toBe(2);
  });

  it('serves the findings to an editor and refuses a viewer (claim 2)', async () => {
    const { viewer, editor } = await viewerAndEditor(projectId);
    const url = `/api/projects/${projectId}/findings`;
    expect((await app.inject({ method: 'GET', url, cookies: viewer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url, cookies: editor });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: ADMIN })).statusCode).toBe(200);

    const body = res.json();
    expect(body.findings).toHaveLength(7);
    expect(body.summary).toMatchObject({
      byRule: { aws_access_key: 1, github_token: 1, private_key: 1, jwt: 1, tckn: 1, iban: 2 },
      documentsScanned: 4,
      documentsPending: 0,
      documentsWithoutText: 0,
      documentsCapped: 0,
      documentsTruncated: 0,
      enabled: true,
      grouped: true,
    });
    expect(Object.keys(body.findings[0]).sort()).toEqual(['col', 'group', 'id', 'line', 'path', 'preview', 'rule', 'sourceUrl', 'title']);
  });

  it('returns neither a value nor a stored HMAC in full (claim 1)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/findings?limit=200`, headers: ADMIN });
    const text = res.body;
    for (const value of RAW_VALUES) expect(text).not.toContain(value);
    const stored = await findingsOf(projectId);
    for (const row of stored) {
      expect(text).not.toContain(row.valueHmac as string);
      expect(text).not.toContain((row.valueHmac as string).slice(0, 20));
    }
    const groups = res.json().findings.map((f: { group: string }) => f.group);
    for (const group of groups) expect(group).toMatch(/^[0-9a-f]{12}$/);
    for (const row of stored) expect(groups).toContain((row.valueHmac as string).slice(0, 12));
  });

  it('filters by rule, pages with an opaque cursor in path order, and refuses a cursor it did not issue', async () => {
    const url = `/api/projects/${projectId}/findings`;
    const only = await app.inject({ method: 'GET', url: `${url}?rule=iban`, headers: ADMIN });
    expect(only.json().findings.map((f: { rule: string }) => f.rule)).toEqual(['iban', 'iban']);
    // The summary counts the project, not the page.
    expect(only.json().summary.byRule.tckn).toBe(1);

    const seen: Array<{ path: string; line: number }> = [];
    let cursor: string | null = null;
    let pages = 0;
    type Page = { findings: Array<{ path: string; line: number }>; nextCursor: string | null };
    do {
      const res: LightMyRequestResponse = await app.inject({
        method: 'GET',
        url: `${url}?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers: ADMIN,
      });
      expect(res.statusCode, res.body).toBe(200);
      const page: Page = res.json();
      expect(page.findings.length).toBeLessThanOrEqual(3);
      seen.push(...page.findings.map((f) => ({ path: f.path, line: f.line })));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    const paths = seen.map((s) => s.path);
    expect([...paths].sort()).toEqual(paths);

    expect((await app.inject({ method: 'GET', url: `${url}?cursor=not-a-cursor`, headers: ADMIN })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${url}?rule=password`, headers: ADMIN })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${url}?limit=0`, headers: ADMIN })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/projects/00000000-0000-4000-8000-000000000000/findings', headers: ADMIN })).statusCode).toBe(
      404,
    );
  });

  it('counts findings and scans in /metrics terms', () => {
    const sample = metrics.piiScan();
    expect(sample.scans.scanned).toBeGreaterThanOrEqual(4);
    expect(sample.findings.tckn).toBeGreaterThanOrEqual(1);
    expect(sample.scans.failed).toBe(0);
  });

  it('is left out of an export, which counts it in the manifest (ADR-0130 decision 8)', async () => {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    const exportConfig = { ...config, DATA_DIR: path.join(base, '.export') } as Config;
    const result = await exportProject({ db, config: exportConfig, product: { name: 'contextator', version: '0.0.0-test' } }, project);
    const archive = path.join(base, 'export.tar.gz');
    await pipeline(result.stream, createWriteStream(archive));
    await result.cleanup();

    expect(result.manifest.excluded.documentFindings).toBe(7);
    const entries: string[] = [];
    await tar.t({ file: archive, onReadEntry: (entry) => entries.push(entry.path) });
    expect(entries.some((name) => name.includes('finding'))).toBe(false);
    expect(entries).toContain('manifest.json');
  }, 60_000);
});

describe('a document that changes (claim 5)', () => {
  it('replaces its findings when the text moves, and does not show the old ones while the new scan is pending', async () => {
    const project = await newProject({ 'runbook.md': await fs.readFile(path.join(FIXTURES, 'runbook.md'), 'utf8') });
    await index(project.id);
    const before = await findingsOf(project.id);
    expect(rulesIn(before)).toEqual(['aws_access_key', 'jwt', 'private_key']);

    // The document is replaced and the scan has not run yet: the stored scan describes other text, so nothing is shown.
    const [doc] = await documentsOf(project.id);
    await db.update(documents).set({ contentHash: 'replaced-and-not-yet-scanned' }).where(eq(documents.id, doc.id));
    const url = `/api/projects/${project.id}/findings`;
    const during = (await app.inject({ method: 'GET', url, headers: ADMIN })).json();
    expect(during.findings).toEqual([]);
    expect(during.summary).toMatchObject({ documentsPending: 1, documentsScanned: 0 });
    expect(during.summary.byRule).toEqual({ aws_access_key: 0, github_token: 0, private_key: 0, jwt: 0, tckn: 0, iban: 0 });

    // The real thing: the file loses its key, the indexer rewrites the document and the hook asks the scanner.
    await db.update(documents).set({ contentHash: doc.contentHash }).where(eq(documents.id, doc.id));
    const text = (await fs.readFile(path.join(project.root, 'runbook.md'), 'utf8')).replace(AWS, 'REDACTED');
    await fs.writeFile(path.join(project.root, 'runbook.md'), text, 'utf8');
    await index(project.id);
    const after = await findingsOf(project.id);
    expect(rulesIn(after)).toEqual(['jwt', 'private_key']);
    const [scan] = await scansOf(project.id);
    const [moved] = await documentsOf(project.id);
    expect(scan.contentHash).toBe(moved.contentHash);
    expect(moved.contentHash).not.toBe(doc.contentHash);
  });

  it('is scanned again when the rule set or the key moved, and not when it is already as scanned', async () => {
    const project = await newProject({ 'citizens.md': await fs.readFile(path.join(FIXTURES, 'citizens.md'), 'utf8') });
    await index(project.id);
    const [first] = await scansOf(project.id);
    const findingIds = (await findingsOf(project.id)).map((f) => f.id).sort();

    scanner.request(project.id);
    await scanner.settled();
    const [untouched] = await scansOf(project.id);
    expect(untouched.scannedAt.getTime()).toBe(first.scannedAt.getTime());
    expect((await findingsOf(project.id)).map((f) => f.id).sort()).toEqual(findingIds);

    // An older rule set: the document is due, and after the pass the row is current again and the findings are new rows.
    await db
      .update(documentScans)
      .set({ ruleset: PII_RULESET_VERSION - 1 })
      .where(eq(documentScans.documentId, first.documentId));
    const pending = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN });
    expect(pending.json().summary).toMatchObject({ documentsPending: 1, documentsScanned: 0 });
    scanner.request(project.id);
    await scanner.settled();
    const [current] = await scansOf(project.id);
    expect(current.ruleset).toBe(PII_RULESET_VERSION);
    const rescanned = await findingsOf(project.id);
    expect(rescanned).toHaveLength(findingIds.length);
    expect(rescanned.map((f) => f.id).sort()).not.toEqual(findingIds);
  });

  it('marks a document with no stored text, once, and does not ask again (ADR-0130 decision 5)', async () => {
    const project = await newProject({ 'old.md': '# Old\n\nA page written before the text was kept.\n' });
    await index(project.id);
    const [doc] = await documentsOf(project.id);
    await db.update(documents).set({ content: null }).where(eq(documents.id, doc.id));
    await db.delete(documentScans).where(eq(documentScans.documentId, doc.id));

    scanner.request(project.id);
    await scanner.settled();
    const [scan] = await scansOf(project.id);
    expect(scan).toMatchObject({ status: 'no_content', findingCount: 0, capped: false });
    expect((await findingsOf(project.id)).length).toBe(0);

    scanner.request(project.id);
    await scanner.settled();
    expect((await scansOf(project.id))[0].scannedAt.getTime()).toBe(scan.scannedAt.getTime());
    const summary = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN })).json().summary;
    expect(summary).toMatchObject({ documentsWithoutText: 1, documentsScanned: 0, documentsPending: 0 });
  });

  it('keeps the first findings and counts all of a document that has more than the ceiling', async () => {
    const dump = Array.from({ length: 130 }, (_, i) => `${TCKN} row ${i}`).join('\n');
    const project = await newProject({ 'dump.md': `# Export\n\n${dump}\n` });
    await index(project.id);
    const [scan] = await scansOf(project.id);
    expect(scan).toMatchObject({ findingCount: 130, capped: true });
    expect(await findingsOf(project.id)).toHaveLength(100);
    const summary = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN })).json().summary;
    expect(summary).toMatchObject({ documentsCapped: 1 });
  });
});

describe('a document whose stored text was cut', () => {
  it('is counted as truncated, and not as having more findings than are kept', async () => {
    const project = await newProject({ 'big.md': '# Big\n\nA long page about pancakes, cut when it was stored.\n' });
    await index(project.id);
    const [doc] = await documentsOf(project.id);
    await db.update(documents).set({ contentTruncated: true }).where(eq(documents.id, doc.id));
    await db.delete(documentScans).where(eq(documentScans.documentId, doc.id));

    scanner.request(project.id);
    await scanner.settled();
    const [scan] = await scansOf(project.id);
    expect(scan).toMatchObject({ status: 'scanned', findingCount: 0, capped: false });
    const summary = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN })).json().summary;
    expect(summary).toMatchObject({ documentsScanned: 1, documentsCapped: 0, documentsTruncated: 1 });
  });
});

describe('the findings follow the document (claim 5)', () => {
  it("goes with a deleted document, with a rebuild's swap and with the project", async () => {
    const project = await newProject(await fixtureFiles());
    await index(project.id);
    const first = await findingsOf(project.id);
    expect(first.length).toBe(7);

    // A deleted document takes its findings and its scan row.
    const docs = await documentsOf(project.id);
    const runbook = docs.find((d) => d.relativePath.endsWith('runbook.md')) as (typeof docs)[number];
    await db.delete(documents).where(eq(documents.id, runbook.id));
    expect((await findingsOf(project.id)).filter((f) => f.documentId === runbook.id)).toHaveLength(0);
    expect((await scansOf(project.id)).filter((s) => s.documentId === runbook.id)).toHaveLength(0);
    const remaining = await findingsOf(project.id);
    expect(remaining.length).toBe(first.length - first.filter((f) => f.documentId === runbook.id).length);

    // A rebuild writes a new generation's documents and the swap deletes the old ones; no finding of the old
    // generation outlives the swap, and the new documents are scanned by the hook that follows.
    const oldIds = new Set((await findingsOf(project.id)).map((f) => f.id));
    const [before] = await db.select({ live: projects.liveGeneration }).from(projects).where(eq(projects.id, project.id));
    await index(project.id, true);
    const [after] = await db.select({ live: projects.liveGeneration }).from(projects).where(eq(projects.id, project.id));
    expect(after.live).toBe(before.live + 1);
    const rebuilt = await findingsOf(project.id);
    expect(rebuilt.some((f) => oldIds.has(f.id))).toBe(false);
    // The deleted file is on disk still, so the rebuild brings its document and its findings back, as new rows.
    expect(rebuilt.length).toBe(first.length);
    const liveDocs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, project.id), eq(documents.indexGeneration, after.live)));
    const live = new Set(liveDocs.map((d) => d.id));
    for (const finding of rebuilt) expect(live.has(finding.documentId)).toBe(true);
    for (const scan of await scansOf(project.id)) expect(live.has(scan.documentId)).toBe(true);

    // The project takes everything.
    await db.delete(projects).where(eq(projects.id, project.id));
    expect(await findingsOf(project.id)).toHaveLength(0);
    expect(await scansOf(project.id)).toHaveLength(0);
  });
});

describe('without SECRET_KEY (claim 3)', () => {
  it('writes the findings without an HMAC, says nothing is grouped, and fills the HMAC when a key arrives', async () => {
    const keyed = scanner;
    scanner = newScanner({ SECRET_KEY: undefined });
    apiConfig.SECRET_KEY = undefined;
    try {
      const project = await newProject(await fixtureFiles());
      await index(project.id);

      const bare = await findingsOf(project.id);
      expect(bare).toHaveLength(7);
      for (const row of bare) {
        expect(row.valueHmac).toBeNull();
        expect(row.hmacKeyId).toBeNull();
      }
      for (const scan of await scansOf(project.id)) expect(scan.hmacKeyId).toBeNull();
      const response = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN })).json();
      expect(response.findings).toHaveLength(7);
      expect(response.summary.grouped).toBe(false);
      for (const finding of response.findings) expect(finding.group).toBeNull();

      // The key arrives: nothing is re-indexed, the documents are due, and the same findings come back with an HMAC.
      apiConfig.SECRET_KEY = SECRET;
      scanner = newScanner();
      const pending = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN })).json();
      expect(pending.summary.documentsPending).toBe(4);
      scanner.request(project.id);
      await scanner.settled();
      const filled = await findingsOf(project.id);
      expect(filled).toHaveLength(7);
      for (const row of filled) {
        expect(row.valueHmac).toMatch(/^[0-9a-f]{64}$/);
        expect(row.hmacKeyId).toBe(secretKeyId(SECRET));
      }
      const grouped = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN })).json();
      expect(grouped.summary.grouped).toBe(true);
      expect(grouped.summary.documentsPending).toBe(0);

      // A different key is a different id: the documents are due again, and the group ids follow the new key.
      const other = 'another-secret-key-that-is-at-least-thirty-two-chars';
      scanner = newScanner({ SECRET_KEY: other });
      apiConfig.SECRET_KEY = other;
      scanner.request(project.id);
      await scanner.settled();
      const rekeyed = await findingsOf(project.id);
      expect(rekeyed).toHaveLength(7);
      for (const row of rekeyed) expect(row.hmacKeyId).toBe(secretKeyId(other));
      expect(new Set(rekeyed.map((r) => r.valueHmac))).not.toEqual(new Set(filled.map((r) => r.valueHmac)));
    } finally {
      apiConfig.SECRET_KEY = SECRET;
      scanner = keyed;
    }
  });
});

describe('search does not notice the scan (claim 4)', () => {
  const QUESTIONS = [
    'access key for the deploy role',
    'citizen number of each customer',
    'rotated host key pasted by mistake',
    'pancakes flour milk eggs',
  ];

  async function resultsOf(projectId: string) {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    const out = [];
    for (const question of QUESTIONS) {
      out.push(
        await searchChunks(db, {
          projectId,
          generation: project.liveGeneration,
          queryEmbedding: stubVector(question),
          queryText: question,
          limit: 10,
        }),
      );
    }
    return out;
  }

  it('gives the same results with PII_SCAN=0 and with the scan having run, and the off scanner writes and deletes nothing', async () => {
    const enabled = scanner;
    scanner = newScanner({ PII_SCAN: false });
    try {
      const project = await newProject(await fixtureFiles());
      await index(project.id);
      expect(await findingsOf(project.id)).toHaveLength(0);
      expect(await scansOf(project.id)).toHaveLength(0);
      const chunkCount = async (): Promise<number> => (await db.select({ n: count() }).from(chunks).where(eq(chunks.projectId, project.id)))[0].n;
      const chunksBefore = await chunkCount();
      const off = await resultsOf(project.id);
      expect(off.some((hits) => hits.length > 0)).toBe(true);
      const docsBefore = (await documentsOf(project.id)).map((d) => [d.id, d.contentHash, d.content, d.chunkCount]);

      scanner = enabled;
      scanner.request(project.id);
      await scanner.settled();
      expect((await findingsOf(project.id)).length).toBe(7);
      const on = await resultsOf(project.id);
      expect(on).toEqual(off);
      // And the documents are what they were: the scanner masks nothing and skips nothing.
      expect((await documentsOf(project.id)).map((d) => [d.id, d.contentHash, d.content, d.chunkCount])).toEqual(docsBefore);
      expect(await chunkCount()).toBe(chunksBefore);
      expect(chunksBefore).toBeGreaterThan(0);

      // Switched off again, it leaves the findings that exist in place.
      scanner = newScanner({ PII_SCAN: false });
      scanner.request(project.id);
      await scanner.settled();
      expect((await findingsOf(project.id)).length).toBe(7);
      const stillThere = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/findings`, headers: ADMIN });
      expect(stillThere.json().findings).toHaveLength(7);
    } finally {
      scanner = enabled;
    }
  });

  it('scans a corpus that was indexed before the scan existed, from the startup sweep, without indexing it again', async () => {
    const enabled = scanner;
    scanner = newScanner({ PII_SCAN: false });
    try {
      const project = await newProject(await fixtureFiles());
      await index(project.id);
      expect(await scansOf(project.id)).toHaveLength(0);

      const sweeper = newScanner({ batchSize: 2 });
      await sweeper.sweep();
      await sweeper.settled();
      expect(await scansOf(project.id)).toHaveLength(4);
      expect(await findingsOf(project.id)).toHaveLength(7);
      await sweeper.stop();
    } finally {
      scanner = enabled;
    }
  });
});
