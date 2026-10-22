import { promises as fs } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import git from 'isomorphic-git';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';
import type { Logger } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, documents, projects } from '../../src/db/schema.js';
import { sourceRepoDir } from '../../src/services/data-dir.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { sourceFieldsOf } from '../../src/services/source-url.js';
import { registerDriver } from '../../src/services/sources/driver.js';
import { GitDriver } from '../../src/services/sources/git.js';
import { searchChunks } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * Where a document came from, through the indexer and the database ([ADR-0116](../../.ssot/ADR.md#adr-0116)):
 * what a run stores, how a 0.3 index is filled in without being embedded again, and that a token pasted into a
 * git remote reaches neither the table, nor an answer, nor a log line.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

let embedCalls = 0;
const embeddings: EmbeddingProvider = {
  id: 'local:stub-bag-of-words:fp32',
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: (text) => Math.ceil(text.length / 4),
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => {
    embedCalls++;
    return texts.map(stubVector);
  },
  embedQuery: async (text: string) => stubVector(text),
};

const indexerConfig = {
  ...WEB_LIMIT_DEFAULTS,
  ALLOWED_DOC_ROOTS: [] as string[],
  IGNORE_GLOBS: [] as string[],
  CHUNK_MAX_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 64,
  EMBEDDING_BATCH_SIZE: 64,
  DATA_DIR: '',
  SECRET_KEY: '0'.repeat(64),
  MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
  MAX_CONVERTED_FILE_BYTES: 32 * 1024 * 1024,
  MAX_SPEC_FILE_BYTES: 8 * 1024 * 1024,
  MAX_PDF_PAGES: 2000,
  MAX_DOCX_UNPACKED_BYTES: 256 * 1024 * 1024,
  CONVERSION_TIMEOUT_MS: 120_000,
  CONVERSION_IDLE_MS: 60_000,
};

async function settle(db: Db, job: JobState): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  while (job.phase !== 'done' && job.phase !== 'error') {
    if (Date.now() > deadline) throw new Error(`index job never settled (phase ${job.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (;;) {
    const project = await getProjectById(db, job.projectId);
    if (project?.status !== 'indexing') return job;
    if (Date.now() > deadline) throw new Error(`project row still says "indexing" after the job settled as ${job.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Every line the indexer and its driver log, as one searchable string. */
function capturingLogger(lines: string[]): Logger {
  const record = (...args: unknown[]) => {
    lines.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)));
  };
  const logger: Logger = {
    ...silentLogger,
    level: 'trace',
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    child: () => logger,
  };
  return logger;
}

const QUERY = 'rotate the secret';
const body = (name: string) => `# ${name}\n\nThe handbook explains how to rotate the ${name} secret from the source panel.\n`;

describe('a local source', () => {
  let database: TestDatabase;
  let root: string;
  let indexer: Indexer;
  let projectId: string;
  const MTIME = new Date('2024-02-03T04:05:06.000Z');

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'source_url_local');
    await applySchema(database, DIMS);
    root = await mkdtemp(path.join(tmpdir(), 'source-url-local-'));
    await writeFile(path.join(root, 'alpha.md'), body('alpha'), 'utf8');
    await writeFile(path.join(root, 'bravo.md'), body('bravo'), 'utf8');
    await utimes(path.join(root, 'alpha.md'), MTIME, MTIME);
    await utimes(path.join(root, 'bravo.md'), MTIME, MTIME);

    const [project] = await database.db.insert(projects).values({ name: 'source-url-local' }).returning({ id: projects.id });
    projectId = project.id;
    await database.db.insert(documentSources).values({ projectId, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } });
    indexer = new Indexer({
      db: database.db,
      embeddings,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: path.join(root, '.data') },
      log: silentLogger,
      locks: new KeyedMutex(),
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  const rows = () => database.db.select().from(documents).where(eq(documents.projectId, projectId));

  it('stores the file mtime as the date and no address', async () => {
    const job = await settle(database.db, indexer.enqueue(projectId));
    indexer.forget(projectId);
    expect(job.phase).toBe('done');
    const stored = await rows();
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.sourceUrl).toBeNull();
      expect(row.sourceModifiedAt?.toISOString()).toBe(MTIME.toISOString());
    }
  });

  it('fills a 0.3 index in on the next run, without embedding anything again', async () => {
    // What an upgrade leaves behind: documents indexed before the columns existed.
    await database.db.update(documents).set({ sourceUrl: null, sourceModifiedAt: null }).where(eq(documents.projectId, projectId));
    expect((await rows()).every((r) => r.sourceModifiedAt === null)).toBe(true);

    const embeddedBefore = embedCalls;
    const job = await settle(database.db, indexer.enqueue(projectId));
    indexer.forget(projectId);
    expect(job.phase).toBe('done');

    expect(embedCalls).toBe(embeddedBefore);
    const stored = await rows();
    expect(stored.every((r) => r.sourceModifiedAt?.toISOString() === MTIME.toISOString())).toBe(true);
  });

  it('follows the file when only its date moves', async () => {
    const later = new Date('2025-06-07T08:09:10.000Z');
    await utimes(path.join(root, 'alpha.md'), later, later);
    const embeddedBefore = embedCalls;
    const job = await settle(database.db, indexer.enqueue(projectId));
    indexer.forget(projectId);
    expect(job.phase).toBe('done');
    expect(embedCalls).toBe(embeddedBefore);
    const alpha = (await rows()).find((r) => r.relativePath === 'handbook/alpha.md');
    expect(alpha?.sourceModifiedAt?.toISOString()).toBe(later.toISOString());
  });
});

describe('a git source whose remote carries a token', () => {
  const PASTED = 'https://alice:ghp_s3cretT0ken@github.com/org/repo.git';
  const COMMITTED_AT = 1_700_000_000;
  let database: TestDatabase;
  let dataDir: string;
  let projectId: string;
  let sourceId: string;
  let head: string;
  const logLines: string[] = [];
  let indexer: Indexer;

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'source_url_git');
    await applySchema(database, DIMS);
    dataDir = await mkdtemp(path.join(tmpdir(), 'source-url-git-'));

    const [project] = await database.db.insert(projects).values({ name: 'source-url-git' }).returning({ id: projects.id });
    projectId = project.id;
    const [source] = await database.db
      .insert(documentSources)
      .values({
        projectId,
        type: 'git',
        name: 'wiki',
        // Stored the way a pre-0.4 form could leave it: with the credential still in the address.
        config: { url: PASTED, branch: 'main', subdir: '', username: '', provider: 'auto', extensions: ['md'] },
      })
      .returning({ id: documentSources.id });
    sourceId = source.id;

    // A real one-commit checkout where the driver keeps its clone; the network step of `sync` is the only
    // thing replaced, so the address, the permalink and the date are the production ones.
    const dir = sourceRepoDir(dataDir, projectId, sourceId);
    await fs.mkdir(dir, { recursive: true });
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.writeFile(path.join(dir, 'guide.md'), body('guide'));
    await git.add({ fs, dir, filepath: 'guide.md' });
    const author = { name: 'A', email: 'a@example.com', timestamp: COMMITTED_AT - 100, timezoneOffset: 0 };
    head = await git.commit({ fs, dir, message: 'init', author, committer: { ...author, timestamp: COMMITTED_AT } });

    class OfflineGit extends GitDriver {
      override async sync() {
        return { note: 'offline' };
      }
    }
    registerDriver('git', (row, ctx) => new OfflineGit(row, ctx));

    indexer = new Indexer({
      db: database.db,
      embeddings,
      config: { ...indexerConfig, ALLOWED_DOC_ROOTS: [dataDir], DATA_DIR: dataDir },
      log: capturingLogger(logLines),
      locks: new KeyedMutex(),
    });
  });

  afterAll(async () => {
    registerDriver('git', (row, ctx) => new GitDriver(row, ctx));
    await rm(dataDir, { recursive: true, force: true });
    await dropTestDatabase(baseUrl, database);
  });

  it('links the commit, dates it, and shows no credential in the table, the answer or the log', async () => {
    const job = await settle(database.db, indexer.enqueue(projectId));
    indexer.forget(projectId);
    expect(job.phase).toBe('done');

    const [row] = await database.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.relativePath, 'wiki/guide.md')));
    expect(row.sourceUrl).toBe(`https://github.com/org/repo/blob/${head}/guide.md`);
    expect(row.sourceModifiedAt?.toISOString()).toBe(new Date(COMMITTED_AT * 1000).toISOString());

    const hits = await searchChunks(database.db, {
      projectId,
      generation: 0,
      queryEmbedding: await embeddings.embedQuery(QUERY),
      queryText: QUERY,
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    const answer = JSON.stringify(hits.map((hit) => ({ file: hit.file, ...sourceFieldsOf(hit, 365) })));
    expect(answer).toContain(head);

    // The whole row, every column, and everything the run logged.
    const everything = JSON.stringify(await database.db.select().from(documents).where(eq(documents.projectId, projectId)));
    for (const text of [everything, answer, logLines.join('\n')]) {
      expect(text).not.toContain('alice:ghp_s3cretT0ken@');
      expect(text).not.toContain('ghp_s3cretT0ken');
    }
  });
});
