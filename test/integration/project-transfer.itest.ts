import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import { and, eq } from 'drizzle-orm';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import {
  chunks,
  documentSources,
  documents,
  indexRuns,
  mcpTokens,
  projectMembers,
  projects,
  searchQueries,
  searchQueryHits,
  users,
} from '../../src/db/schema.js';
import { sourceCurrentDir } from '../../src/services/data-dir.js';
import { ConflictError } from '../../src/services/projects.js';
import { ImportRefusedError } from '../../src/services/transfer/manifest.js';
import { exportProject } from '../../src/services/transfer/export.js';
import { importProject } from '../../src/services/transfer/import.js';
import { type NewChunk, replaceDocument, searchChunks, type SearchHit } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The round trip ([ADR-0051](../../.ssot/ADR.md#adr-0051)), and it is the item's own "done when":
 * **a project moves from one instance to another and answers the same questions on the other side.**
 *
 * So there are two databases in this file, not one — `transfer_origin` and `transfer_destination` —
 * because an export that is read back into the database it came from proves nothing about the half of
 * the feature that is interesting. The harness carves a database per test file; this file carves two,
 * and two `DATA_DIR`s to go with them, since an upload source's files are the other half of the move.
 *
 * No model. The provider is the deterministic bag of words the other integration files use, which is
 * what makes "identical scores" a claim about the transfer rather than about floating point in an
 * encoder: the same text embeds to the same vector on both sides, so any difference in a score is a
 * difference the export introduced.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';

/** The generation the origin is serving. **Not 0**, which is the point of half the assertions below. */
const ORIGIN_LIVE = 3;

/** Values seeded on the origin that must not appear anywhere in the tarball, asserted against the bytes. */
const SECRETS = {
  sourceToken: 'v1.NEVER-EXPORT-THIS-CIPHERTEXT.aaa.bbb',
  webhookSecret: 'c0ffee1234567890deadbeefc0ffee12',
  notionToken: 'secret_notion_verification_token_value',
  loggedQuery: 'how do I rotate the SUPERSECRET credential',
  mcpTokenHash: createHash('sha256').update('an-mcp-token-nobody-should-get').digest('hex'),
  probeToken: 'etag-origin-only-9f2c',
  lastCommit: 'aaaaaaaabbbbbbbbccccccccdddddddd',
  supersededPath: 'manual/a-page-from-the-old-generation.md',
  abandonedPath: 'manual/a-page-from-an-abandoned-rebuild.md',
};

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

const chunk = (index: number, headingPath: string, content: string): NewChunk => ({
  chunkIndex: index,
  headingPath,
  content,
  tokenCount: content.split(/\s+/).length,
  embedding: stubVector(`${headingPath} ${content}`),
});

/** The four questions the round trip is judged on, chosen to exercise both halves of the fusion. */
const QUESTIONS = ['how do I install the collector', 'HLY-4019', 'rotating a credential', 'what does the retention window cover'];

const configFor = (dataDir: string): Config =>
  ({
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: undefined,
    EMBEDDING_DIMENSIONS: DIMS,
    ALLOWED_DOC_ROOTS: ['/docs'],
    ARCHIVE_MAX_ENTRIES: 20_000,
    ARCHIVE_MAX_TOTAL_BYTES: 1024 * 1024 * 1024,
    UPLOAD_MAX_FILE_BYTES: 50 * 1024 * 1024,
    MAX_STORED_DOCUMENT_BYTES: 1024 * 1024,
  }) as unknown as Config;

let origin: TestDatabase;
let destination: TestDatabase;
let originDataDir: string;
let destinationDataDir: string;
let projectId: string;
let uploadSourceId: string;
let specsSourceId: string;
let archive: string;
let extracted: string;

beforeAll(async () => {
  origin = await createTestDatabase(baseUrl, 'transfer_origin');
  destination = await createTestDatabase(baseUrl, 'transfer_destination');
  await Promise.all([applySchema(origin), applySchema(destination)]);
  originDataDir = await fs.mkdtemp(path.join(tmpdir(), 'contextator-origin-'));
  destinationDataDir = await fs.mkdtemp(path.join(tmpdir(), 'contextator-destination-'));
  await seedOrigin(origin.db);
}, 180_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, origin);
  await dropTestDatabase(baseUrl, destination);
  await fs.rm(originDataDir, { recursive: true, force: true });
  await fs.rm(destinationDataDir, { recursive: true, force: true });
  if (archive) await fs.rm(archive, { force: true });
  if (extracted) await fs.rm(extracted, { recursive: true, force: true });
});

/**
 * One project with everything the enumeration in ADR-0051 has an opinion about: two sources, three
 * generations of documents, a query log, an MCP token, a membership and a run history.
 */
async function seedOrigin(db: Db): Promise<void> {
  const [project] = await db
    .insert(projects)
    .values({
      name: 'handbook',
      liveGeneration: ORIGIN_LIVE,
      embeddingModel: MODEL_ID,
      mcpAuth: 'token',
      queryLogEnabled: false,
      lastIndexedAt: new Date('2026-09-10T08:00:00Z'),
      status: 'idle',
    })
    .returning();
  projectId = project.id;

  const [upload] = await db
    .insert(documentSources)
    .values({
      projectId,
      type: 'upload',
      name: 'manual',
      label: 'The operations manual',
      // `english` and not the default, so the destination has to rebuild `content_tsv` with the
      // configuration the source names rather than carrying the origin's column.
      config: { extensions: ['md'], language: 'english' },
      flavor: 'plain',
      syncIntervalMinutes: 60,
    })
    .returning();
  uploadSourceId = upload.id;

  // **A second upload source whose content type decides which extensions it may hold**
  // ([ADR-0057](../../.ssot/ADR.md#adr-0057)). `importTree` takes the path cleanup and the extension
  // permission as two fields, and they used to be one: `transfer/import` passes `plain` for the
  // cleanup on purpose — the tree in the tarball is already materialised — and reading the permission
  // off the same field meant a restored `openapi` source arrived with none of its specifications.
  const [specs] = await db
    .insert(documentSources)
    .values({
      projectId,
      type: 'upload',
      name: 'specs',
      label: 'The API specifications',
      config: { extensions: ['md', 'yaml'] },
      flavor: 'openapi',
    })
    .returning();
  specsSourceId = specs.id;

  await db.insert(documentSources).values({
    projectId,
    type: 'git',
    name: 'wiki',
    label: 'The engineering wiki',
    config: {
      url: 'https://git.example.invalid/wiki.git',
      branch: 'main',
      subdir: '',
      username: '',
      provider: 'auto',
      extensions: ['md'],
      lastCommit: SECRETS.lastCommit,
      syncProbeToken: SECRETS.probeToken,
    },
    secretEnc: SECRETS.sourceToken,
    webhookSecret: SECRETS.webhookSecret,
    flavor: 'plain',
    syncIntervalMinutes: 15,
    nextSyncAt: new Date('2026-09-20T00:00:00Z'),
  });

  await db.insert(documentSources).values({
    projectId,
    type: 'notion',
    name: 'notes',
    label: 'Notion notes',
    config: { rootIds: [], extensions: ['md'] },
    // The other provenance of the same column: a token Notion minted for *this* instance's
    // subscription ([ADR-0049](../../.ssot/ADR.md#adr-0049)).
    webhookSecret: SECRETS.notionToken,
    webhookVerificationExpiresAt: new Date('2026-09-20T00:00:00Z'),
    flavor: 'notion-export',
  });

  const live: Array<[string, string, NewChunk[]]> = [
    [
      'manual/install.md',
      'Installing the collector',
      [
        chunk(0, 'Installing the collector', 'Install the collector with the package manager and start it as a service.'),
        chunk(1, 'Installing the collector > Verifying', 'Verify the install by asking the collector for its version.'),
      ],
    ],
    [
      'manual/errors.md',
      'Error reference',
      [chunk(0, 'Error reference > HLY-4019', 'HLY-4019 means the upstream refused the handshake. Retry after checking the certificate.')],
    ],
    [
      'wiki/credentials.md',
      'Credentials',
      [
        chunk(0, 'Credentials > Rotation', 'Rotating a credential replaces the stored token and invalidates the previous one.'),
        chunk(1, 'Credentials > Retention', 'The retention window covers thirty days of recorded activity and nothing older.'),
      ],
    ],
  ];

  for (const [relativePath, title, rows] of live) {
    await replaceDocument(
      db,
      {
        projectId,
        sourceId: relativePath.startsWith('manual/') ? uploadSourceId : null,
        relativePath,
        title,
        contentHash: createHash('sha256').update(relativePath).digest('hex'),
        sizeBytes: 1024,
        indexGeneration: ORIGIN_LIVE,
        content: `# ${title}\n\n${rows.map((r) => r.content).join('\n\n')}\n`,
        contentTruncated: false,
        version: '',
      },
      rows,
      relativePath.startsWith('manual/') ? 'english' : 'simple',
    );
  }

  // A generation behind the live one, and one ahead of it: what a finished swap left and what an
  // abandoned rebuild left ([ADR-0039](../../.ssot/ADR.md#adr-0039)). Neither may travel.
  for (const [generation, relativePath] of [
    [ORIGIN_LIVE - 1, SECRETS.supersededPath],
    [ORIGIN_LIVE + 1, SECRETS.abandonedPath],
  ] as const) {
    await replaceDocument(
      db,
      {
        projectId,
        sourceId: uploadSourceId,
        relativePath,
        title: 'Not the live generation',
        contentHash: createHash('sha256').update(relativePath).digest('hex'),
        sizeBytes: 10,
        indexGeneration: generation,
        content: `This page belongs to generation ${generation}.`,
        contentTruncated: false,
        version: '',
      },
      [chunk(0, 'Not the live generation', `This page belongs to generation ${generation}.`)],
      'simple',
    );
  }

  const [user] = await db
    .insert(users)
    .values({ username: 'someone-on-the-origin', passwordHash: 'scrypt$not-a-real-hash', role: 'member' })
    .returning();
  await db.insert(projectMembers).values({ userId: user.id, projectId, role: 'viewer' });

  await db.insert(mcpTokens).values({ projectId, name: 'Cursor on my laptop', tokenHash: SECRETS.mcpTokenHash, prefix: 'ctx_abc' });

  const [query] = await db
    .insert(searchQueries)
    .values({
      projectId,
      actor: 'mcp',
      query: SECRETS.loggedQuery,
      queryNorm: SECRETS.loggedQuery.toLowerCase(),
      resultLimit: 5,
      hitCount: 1,
      topScore: 0.42,
      embeddingModel: MODEL_ID,
      liveGeneration: ORIGIN_LIVE,
    })
    .returning();
  await db
    .insert(searchQueryHits)
    .values({ queryId: query.id, rank: 1, relativePath: 'wiki/credentials.md', headingPath: 'Credentials > Rotation', chunkIndex: 0, score: 0.42 });

  await db.insert(indexRuns).values({
    projectId,
    mode: 'force',
    status: 'done',
    startedAt: new Date('2026-09-10T07:00:00Z'),
    finishedAt: new Date('2026-09-10T08:00:00Z'),
    generation: ORIGIN_LIVE,
    trigger: 'manual',
  });

  // The upload source's `current/` tree: the only copy of its content anywhere, which is why it is
  // the one part of `DATA_DIR` that travels.
  const current = sourceCurrentDir(originDataDir, projectId, uploadSourceId);
  await fs.mkdir(path.join(current, 'nested'), { recursive: true });
  await fs.writeFile(path.join(current, 'install.md'), '# Installing the collector\n');
  await fs.writeFile(path.join(current, 'errors.md'), '# Error reference\n');
  await fs.writeFile(path.join(current, 'nested', 'extra.md'), '# Something nested\n');
  // Two files `importTree` must refuse on the way back in, whatever a tarball says about them.
  await fs.writeFile(path.join(current, 'notes.exe'), 'not a document');
  await fs.mkdir(path.join(current, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(current, '.obsidian', 'workspace.md'), '# a dot directory');

  const specsCurrent = sourceCurrentDir(originDataDir, projectId, specsSourceId);
  await fs.mkdir(specsCurrent, { recursive: true });
  await fs.writeFile(path.join(specsCurrent, 'petstore.yaml'), 'openapi: 3.0.3\ninfo: {title: Petstore, version: "1"}\n');
  await fs.writeFile(path.join(specsCurrent, 'README.md'), '# The specifications\n');
  // Still refused: the content type widens what may be carried, it does not remove the filter.
  await fs.writeFile(path.join(specsCurrent, 'notes.exe'), 'not a document');
}

/** Searches one database, at one generation, for the four questions, in one array. */
async function answers(db: Db, id: string, generation: number): Promise<SearchHit[][]> {
  const out: SearchHit[][] = [];
  for (const question of QUESTIONS) {
    out.push(await searchChunks(db, { projectId: id, generation, queryEmbedding: stubVector(question), queryText: question, limit: 5 }));
  }
  return out;
}

describe('exporting a project', () => {
  it('writes a tarball whose manifest describes the live generation and names everything left behind', async () => {
    const [project] = await origin.db.select().from(projects).where(eq(projects.id, projectId));
    const result = await exportProject(
      { db: origin.db, config: configFor(originDataDir), product: { name: 'contextator', version: '0.1.0-test' } },
      project,
    );

    archive = path.join(tmpdir(), `contextator-transfer-${Date.now()}.tar.gz`);
    await pipeline(result.stream, createWriteStream(archive));
    await result.cleanup();

    const manifest = result.manifest;
    expect(manifest.project.exportedGeneration).toBe(ORIGIN_LIVE);
    expect(manifest.counts.documents).toBe(3);
    expect(manifest.counts.chunks).toBe(5);
    expect(manifest.counts.sources).toBe(4);
    // Three of the first source's five files on disk are documents and two of the second's three are;
    // `.obsidian/` and the two `.exe`s are not the export's business either — it carries the tree and
    // `importTree` is what filters it back in.
    expect(manifest.counts.uploadFiles).toBe(8);
    expect(manifest.excluded).toEqual({
      searchQueries: 1,
      searchQueryHits: 1,
      mcpTokens: 1,
      indexRuns: 1,
      projectMembers: { viewer: 1, editor: 0 },
    });
    expect(manifest.sources.find((s) => s.name === 'wiki')?.needs).toEqual(['credential', 'webhook-secret', 'never-scheduled']);
    expect(manifest.sources.find((s) => s.name === 'notes')?.needs).toEqual(['webhook-secret']);
    expect(manifest.sources.find((s) => s.name === 'manual')?.needs).toEqual(['files-carried', 'never-scheduled']);

    // The staging directory is gone, and it was never inside `projects/` where the orphan sweep looks.
    expect(await fs.readdir(path.join(originDataDir, '.transfer')).catch(() => [])).toEqual([]);
  }, 120_000);

  /**
   * **Asserted against the bytes, not against the code that wrote them.** Every entry of the tarball
   * is read back off the disk and searched for each value the exclusion list says stayed behind. A
   * test that asked `exportedSource()` what it emitted would pass just as happily if some other part
   * of the export had written a secret into the manifest.
   */
  it('contains nothing from the exclusion list, anywhere in it', async () => {
    extracted = await fs.mkdtemp(path.join(tmpdir(), 'contextator-bytes-'));
    await tar.extract({ file: archive, cwd: extracted });

    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else files.push(abs);
      }
    };
    await walk(extracted);
    expect(files.length).toBeGreaterThan(4);

    const everything = (await Promise.all(files.map((f) => fs.readFile(f, 'utf8')))).join('\n');
    for (const [what, value] of Object.entries(SECRETS)) {
      expect(everything, `${what} was found in the tarball`).not.toContain(value);
    }
    // The member's username is a fact about accounts on an instance that did not move, so it does not
    // travel either — only the count does.
    expect(everything).not.toContain('someone-on-the-origin');
    expect(everything).toContain('"viewer": 1');
  });

  it('carries the live generation of the corpus and neither of the other two', async () => {
    const documentsFile = await fs.readFile(path.join(extracted, 'documents.ndjson'), 'utf8');
    const paths = documentsFile
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { relativePath: string }).relativePath);
    expect(paths.sort()).toEqual(['manual/errors.md', 'manual/install.md', 'wiki/credentials.md']);
    // The generation number itself is not in the file: it is one generation by construction, and the
    // number it had at home is recorded in the manifest as provenance rather than as data.
    expect(documentsFile).not.toContain('indexGeneration');
  });
});

describe('importing it into a second instance', () => {
  let report: Awaited<ReturnType<typeof importProject>>;

  it('lands the project, renumbered to generation 0', async () => {
    report = await importProject(
      { db: destination.db, config: configFor(destinationDataDir), embeddings: { id: MODEL_ID, dimensions: DIMS } },
      archive,
    );
    const [landed] = await destination.db.select().from(projects).where(eq(projects.id, report.projectId));
    expect(landed.name).toBe('handbook');
    expect(landed.liveGeneration).toBe(0);
    expect(landed.embeddingModel).toBe(MODEL_ID);
    expect(landed.documentCount).toBe(3);
    expect(landed.chunkCount).toBe(5);
    // Two project-level decisions that are the project's and not the instance's, so they travel.
    expect(landed.mcpAuth).toBe('token');
    expect(landed.queryLogEnabled).toBe(false);

    const rows = await destination.db.select().from(documents).where(eq(documents.projectId, report.projectId));
    expect(rows.every((r) => r.indexGeneration === 0)).toBe(true);
    const chunkRows = await destination.db.select().from(chunks).where(eq(chunks.projectId, report.projectId));
    expect(chunkRows.every((r) => r.indexGeneration === 0)).toBe(true);
  }, 120_000);

  /**
   * **The item's own "done when", and the shape of the assertion is a finding in its own right.**
   *
   * `searchChunks` orders its dense candidates by `<=>` with **no tie-break** — deliberately, because
   * a second sort key is unsatisfiable by the HNSW index, which is the same property
   * [ADR-0046](../../.ssot/ADR.md#adr-0046) had to reason about for the restore. Two chunks at the
   * *same* distance from a query come back in whichever order the executor reached them; and since the
   * fused score is `1/(k + rank)`, an arbitrary rank becomes an arbitrary fused score — the same two
   * chunks came back as 1/64 and 1/65 on one database and 1/65 and 1/64 on the other. The lexical half
   * breaks its own ties with `c.id`, which is a fresh uuid on the destination, so it is no more
   * orderable across two instances than the dense half is.
   *
   * So the test asserts exactly what the product actually promises, in three parts:
   *
   * - **Every returned chunk, and its cosine similarity, is identical.** This is the assertion the
   *   export exists to pass: `score` is a pure function of the query vector and the stored vector, so
   *   a single float that did not survive the tarball shows up here and nowhere else.
   * - **The fused scores are the same multiset**, so the ranking structure is unchanged — a hit that
   *   moved from the dense list to nowhere would change it.
   * - **A chunk whose similarity is unique in its answer sits at the same position.** That is "the
   *   same order" for every row the product orders at all, and it is silent about the rows it does not.
   */
  it('answers the same questions, with the same hits and the same scores, ranked the same way', async () => {
    const before = await answers(origin.db, projectId, ORIGIN_LIVE);
    const after = await answers(destination.db, report.projectId, 0);

    const identity = (hit: SearchHit) => ({
      score: hit.score,
      file: hit.file,
      headingPath: hit.headingPath,
      chunkIndex: hit.chunkIndex,
      content: hit.content,
    });
    const settled = (hits: SearchHit[]): ReturnType<typeof identity>[] =>
      hits.map(identity).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.chunkIndex - b.chunkIndex);
    /** Where each chunk whose similarity nothing else in this answer shares was printed. */
    const placed = (hits: SearchHit[]): Array<[string, number]> =>
      hits
        .map((hit, position) => [hit, position] as const)
        .filter(([hit]) => hits.filter((other) => other.score === hit.score).length === 1)
        .map(([hit, position]) => [`${hit.file}#${hit.chunkIndex}`, position] as [string, number]);

    // Guard the comparison itself: assertions over empty lists would pass for the wrong reason.
    expect(before.flat().length).toBeGreaterThanOrEqual(8);
    expect(before.flatMap(placed).length).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < QUESTIONS.length; i++) {
      expect(settled(after[i]), `"${QUESTIONS[i]}" answered differently after the move`).toEqual(settled(before[i]));
      expect(after[i].map((h) => h.fusedScore).sort(), `"${QUESTIONS[i]}" was ranked differently after the move`).toEqual(
        before[i].map((h) => h.fusedScore).sort(),
      );
      expect(placed(after[i]), `"${QUESTIONS[i]}" put an unambiguously ranked hit somewhere else`).toEqual(placed(before[i]));
    }

    // And the lexical half is genuinely running on the other side: at least one hit was found by it.
    expect(after.flat().some((hit) => hit.lexicalRank !== null)).toBe(true);
  }, 120_000);

  it('lands the sources with neither secret, and with nothing scheduled', async () => {
    const rows = await destination.db.select().from(documentSources).where(eq(documentSources.projectId, report.projectId));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.secretEnc).toBeNull();
      expect(row.webhookSecret).toBeNull();
      expect(row.webhookVerificationExpiresAt).toBeNull();
      // NFR-10: an import is not an operator asking this instance to call somebody else's API.
      expect(row.syncIntervalMinutes).toBeNull();
      expect(row.nextSyncAt).toBeNull();
    }
    const git = rows.find((r) => r.name === 'wiki');
    expect(git).toBeDefined();
    const gitConfig = git?.config as { url: string };
    expect(gitConfig.url).toBe('https://git.example.invalid/wiki.git');
    expect(gitConfig).not.toHaveProperty('lastCommit');
    expect(gitConfig).not.toHaveProperty('syncProbeToken');
  });

  it("carries the upload source's files, and only the ones importTree accepts", async () => {
    const source = (
      await destination.db
        .select()
        .from(documentSources)
        .where(and(eq(documentSources.projectId, report.projectId), eq(documentSources.name, 'manual')))
    )[0];
    const current = sourceCurrentDir(destinationDataDir, report.projectId, source.id);
    const landed: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        else landed.push(`${prefix}${entry.name}`);
      }
    };
    await walk(current, '');
    // `notes.exe` fails the source's own extension filter and `.obsidian/` is a dot directory: both
    // are refused by `importTree`, which is the extractor this feature reuses rather than replaces.
    expect(landed.sort()).toEqual(['errors.md', 'install.md', 'nested/extra.md']);
  });

  it("carries a specification source's .yaml, which its content type is the only reason it may hold", async () => {
    const source = (
      await destination.db
        .select()
        .from(documentSources)
        .where(and(eq(documentSources.projectId, report.projectId), eq(documentSources.name, 'specs')))
    )[0];
    expect(source.flavor).toBe('openapi');
    const landed = await fs.readdir(sourceCurrentDir(destinationDataDir, report.projectId, source.id));
    // The `.yaml` is here only because the permission is read off the source's own content type; the
    // `.exe` is still refused, so the filter is doing its job rather than being switched off.
    expect(landed.sort()).toEqual(['README.md', 'petstore.yaml']);
  });

  it('says out loud what happened to the memberships and to the tokens', () => {
    expect(report.memberships.carried).toBe(0);
    expect(report.memberships.sourceHad).toEqual({ viewer: 1, editor: 0 });
    expect(report.memberships.note).toContain('1 viewer and 0 editor membership(s)');
    expect(report.memberships.note).toContain('root and admin');
    expect(report.mcpTokens.carried).toBe(0);
    expect(report.mcpTokens.sourceHad).toBe(1);
    // This project is `token`-authenticated, so "mint new ones" is not advice, it is the next step.
    expect(report.mcpTokens.note).toContain('before any agent can reach it');

    // Nothing on the exclusion list arrived as a row either.
    expect(report.manifest.excluded.indexRuns).toBe(1);
  });

  it('leaves no membership, token, query or run behind on the destination', async () => {
    const counts = await Promise.all([
      destination.db.select().from(projectMembers).where(eq(projectMembers.projectId, report.projectId)),
      destination.db.select().from(mcpTokens).where(eq(mcpTokens.projectId, report.projectId)),
      destination.db.select().from(searchQueries).where(eq(searchQueries.projectId, report.projectId)),
      destination.db.select().from(indexRuns).where(eq(indexRuns.projectId, report.projectId)),
      destination.db.select().from(users),
    ]);
    expect(counts.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it('is a different instance, and says so', () => {
    expect(report.sameInstance).toBe(false);
  });
});

/**
 * A complete census of the destination: every row of every table an import can write, and every
 * directory it can create under `DATA_DIR`.
 *
 * It is a **census and not a lookup by name** on purpose. "No project called `handbook-3`" would pass
 * for a half-written project under any other name, and would say nothing at all about source rows,
 * document rows or a directory left behind — which are exactly what a refusal that fires late leaves.
 * The destination already holds one successfully imported project, so this is a populated baseline and
 * a leak shows up as a delta rather than as the difference between zero and zero.
 */
async function census(db: Db, dataDir: string): Promise<Record<string, unknown>> {
  const [projectRows, sourceRows, documentRows, chunkRows] = await Promise.all([
    db.select({ id: projects.id, name: projects.name }).from(projects),
    db.select({ id: documentSources.id }).from(documentSources),
    db.select({ id: documents.id }).from(documents),
    db.select({ id: chunks.id }).from(chunks),
  ]);
  const dirs = await fs.readdir(path.join(dataDir, 'projects')).catch(() => [] as string[]);
  return {
    projects: projectRows.map((r) => r.name).sort(),
    sources: sourceRows.length,
    documents: documentRows.length,
    chunks: chunkRows.length,
    dataDirs: [...dirs].sort(),
  };
}

/**
 * **"Refused before anything is written", asserted rather than read off the code.**
 *
 * A refusal that fires late looks identical to a refusal that fires early from outside the call — until
 * somebody has to clean up the rows. `importProject` opens no transaction, so nothing but this assertion
 * stands between a mismatched archive and a half-written project.
 */
async function expectRefusedWithoutWriting(
  what: string,
  attempt: () => Promise<unknown>,
  message: RegExp,
  /** The class it must be, because that is what decides the status the route answers with. */
  type: new (...args: never[]) => Error = ImportRefusedError,
): Promise<void> {
  const before = await census(destination.db, destinationDataDir);
  const rejection = expect(attempt(), `${what} was not refused`).rejects;
  // The message, because several refusals share a code and only the sentence says which check ran;
  // and the class, because `ImportRefusedError` is what `adminRoutes` turns into a 409 rather than a 500.
  await rejection.toThrow(message);
  const after = await census(destination.db, destinationDataDir);
  expect(after, `${what} was refused, but not before it had written to the destination`).toEqual(before);

  // Re-run it to inspect the error itself: `rejects` consumed the first one.
  await expect(attempt(), `${what} was not refused as a ${type.name}`).rejects.toBeInstanceOf(type);
  expect(await census(destination.db, destinationDataDir), `${what} wrote to the destination on a second attempt`).toEqual(before);
}

describe('the refusals', () => {
  const here = (embeddings: { id: string; dimensions: number }) => ({
    db: destination.db,
    config: configFor(destinationDataDir),
    embeddings,
  });

  it('refuses an instance running a different model, loudly, and writes nothing', async () => {
    await expectRefusedWithoutWriting(
      'a different model',
      () => importProject(here({ id: 'local:some-other-model:fp32', dimensions: DIMS }), archive, 'handbook-2'),
      /indexed with "local:stub-bag-of-words:fp32" and this instance embeds with "local:some-other-model:fp32"/,
    );
  });

  /**
   * The matcher is the **manifest check's own sentence** and not `ImportRefusedError`. Both the
   * manifest check and the per-chunk re-check raise `dimension_mismatch`, so an assertion that only
   * asked whether *something* threw would stay green with the manifest check deleted — the late one
   * would catch it instead, and the test would be pinning "it is refused" rather than "it is refused
   * by the check that runs first".
   */
  it('refuses an instance storing a different dimension, and writes nothing', async () => {
    await expectRefusedWithoutWriting(
      'a different dimension',
      () => importProject(here({ id: MODEL_ID, dimensions: 768 }), archive, 'handbook-3'),
      /vectors are 384-dimensional and this instance stores 768-dimensional ones/,
    );
  });

  it('refuses a manifest format it does not read, and writes nothing', async () => {
    const tarball = await archiveWith({ manifestVersion: 99 });
    try {
      await expectRefusedWithoutWriting(
        'a newer manifest format',
        () => importProject(here({ id: MODEL_ID, dimensions: DIMS }), tarball, 'handbook-4'),
        /manifest format 99/,
      );
    } finally {
      await fs.rm(tarball, { force: true });
    }
  });

  it('refuses an export from a newer schema, and writes nothing', async () => {
    const tarball = await archiveWith({ schema: { version: '5', migrations: 999 } });
    try {
      await expectRefusedWithoutWriting(
        'a newer schema',
        () => importProject(here({ id: MODEL_ID, dimensions: DIMS }), tarball, 'handbook-5'),
        /999 migrations in/,
      );
    } finally {
      await fs.rm(tarball, { force: true });
    }
  });

  it('refuses an archive that is not a project export, and writes nothing', async () => {
    const notAnExport = path.join(tmpdir(), `contextator-not-an-export-${Date.now()}.tar.gz`);
    const stage = await fs.mkdtemp(path.join(tmpdir(), 'contextator-stage-'));
    await fs.writeFile(path.join(stage, 'readme.md'), '# just a tarball');
    await tar.create({ gzip: true, cwd: stage, file: notAnExport }, ['readme.md']);
    try {
      await expectRefusedWithoutWriting(
        'a tarball that is not an export',
        () => importProject(here({ id: MODEL_ID, dimensions: DIMS }), notAnExport, 'handbook-6'),
        /not a Contextator project export/,
      );
    } finally {
      await fs.rm(notAnExport, { force: true });
      await fs.rm(stage, { recursive: true, force: true });
    }
  });

  it('refuses a name that is already taken rather than merging into it, and writes nothing', async () => {
    await expectRefusedWithoutWriting(
      'a name that is taken',
      () => importProject(here({ id: MODEL_ID, dimensions: DIMS }), archive),
      /already exists/,
      ConflictError,
    );
  });

  /**
   * **The manifest is a claim about bytes, and this is the tarball where the claim is false.**
   *
   * Its manifest says exactly what this instance runs, so `checkManifest` passes it; its first chunk
   * carries a vector of the wrong length, which only the per-chunk re-check can see — and that check
   * runs *after* the project row, the source rows and the carried files exist. This is the one refusal
   * that cannot be made early, and therefore the one that has to clean up after itself.
   */
  it('refuses a tarball that lies about its dimension, and leaves nothing behind when it does', async () => {
    const tarball = await archiveWith({}, (line) => {
      const doc = JSON.parse(line) as { chunks: Array<{ embedding: number[] }> };
      if (doc.chunks.length > 0) doc.chunks[0].embedding = [...doc.chunks[0].embedding, 0];
      return JSON.stringify(doc);
    });
    try {
      await expectRefusedWithoutWriting(
        'a tarball whose manifest lies',
        () => importProject(here({ id: MODEL_ID, dimensions: DIMS }), tarball, 'handbook-7'),
        /makes this file inconsistent with itself/,
      );
    } finally {
      await fs.rm(tarball, { force: true });
    }
  });

  /**
   * **"Before a byte of data is read", asserted as an ordering rather than as an outcome.**
   *
   * The census two dozen lines up cannot see this any more, and that is a consequence of the fix
   * rather than a gap in it: now that a failed landing is unwound, a refusal that fires late leaves
   * exactly the nothing that a refusal firing early leaves — which is the point, and which also erases
   * the evidence of which one fired.
   *
   * So the ordering is pinned by a different observable. Each archive below has a manifest this
   * instance must refuse **and** a `documents.ndjson` that is not JSON at all. If the refusal is
   * decided from the manifest, the corrupt data is never parsed and the manifest's own sentence comes
   * back. If it is ever decided later, the parse error arrives first and the expected sentence does
   * not — which is precisely what deleting a manifest check looks like from outside.
   */
  const MANIFEST_REFUSALS: Array<{ what: string; patch: Record<string, unknown>; embeddings: { id: string; dimensions: number }; message: RegExp }> =
    [
      {
        what: 'a different model',
        patch: {},
        embeddings: { id: 'local:some-other-model:fp32', dimensions: DIMS },
        message: /this instance embeds with "local:some-other-model:fp32"/,
      },
      {
        what: 'a different dimension',
        patch: {},
        embeddings: { id: MODEL_ID, dimensions: 768 },
        message: /vectors are 384-dimensional and this instance stores 768-dimensional ones/,
      },
      {
        what: 'a newer manifest format',
        patch: { manifestVersion: 99 },
        embeddings: { id: MODEL_ID, dimensions: DIMS },
        message: /manifest format 99/,
      },
      {
        what: 'a newer schema',
        patch: { schema: { version: '5', migrations: 999 } },
        embeddings: { id: MODEL_ID, dimensions: DIMS },
        message: /999 migrations in/,
      },
    ];

  for (const [index, refusal] of MANIFEST_REFUSALS.entries()) {
    it(`refuses ${refusal.what} from the manifest alone, without reading the data`, async () => {
      // Data that would fail loudly if anything ever reached it, and differently from the manifest.
      const tarball = await archiveWith(refusal.patch, () => 'this line is not JSON');
      try {
        await expectRefusedWithoutWriting(
          refusal.what,
          () => importProject(here(refusal.embeddings), tarball, `handbook-ordering-${index}`),
          refusal.message,
        );
      } finally {
        await fs.rm(tarball, { force: true });
      }
    });
  }
});

/**
 * A copy of the real export with its manifest patched, and optionally each of its document lines
 * rewritten. Built from the genuine archive rather than from hand-written JSON, so the only thing
 * these cases differ by is the thing under test.
 */
async function archiveWith(patch: Record<string, unknown>, rewriteDocument?: (line: string) => string): Promise<string> {
  const stage = await fs.mkdtemp(path.join(tmpdir(), 'contextator-patch-'));
  const out = path.join(tmpdir(), `contextator-patched-${randomUUID()}.tar.gz`);
  await tar.extract({ file: archive, cwd: stage });

  const manifestPath = path.join(stage, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, ...patch }, null, 2));

  if (rewriteDocument) {
    const documentsPath = path.join(stage, 'documents.ndjson');
    const lines = (await fs.readFile(documentsPath, 'utf8')).trim().split('\n');
    await fs.writeFile(documentsPath, `${lines.map(rewriteDocument).join('\n')}\n`);
  }

  const entries = await fs.readdir(stage);
  await tar.create({ gzip: true, cwd: stage, file: out, portable: true }, entries);
  await fs.rm(stage, { recursive: true, force: true });
  return out;
}
