import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, projects } from '../../src/db/schema.js';
import { SessionRegistry } from '../../src/mcp/sessions.js';
import { setMemberRole } from '../../src/services/auth/memberships.js';
import { createSession } from '../../src/services/auth/sessions.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { createUser } from '../../src/services/auth/users.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
import { type NewChunk, replaceDocument, searchChunks } from '../../src/services/vector-store.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * `GET /api/projects/:id/search` end to end: the policy hook, the guards in services/search.ts, the
 * HNSW query and the JSON that comes back — against a real PostgreSQL, because everything worth
 * asserting here is either a row or a distance (ADR-0031).
 *
 * No model. The embedding provider below is a deterministic bag of words, which is enough to rank
 * an excerpt above an unrelated one and has the property a real model does not: the same query
 * embeds to the same vector in the test as it did when the chunks were written, so the route's
 * hits can be compared with `searchChunks`'s directly.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';
/** Every project here is freshly created, so its live generation is the column's default (ADR-0039). */
const LIVE = 0;

/** Word-hash bag of words, L2-normalised. Shared vocabulary is the whole of the similarity. */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  // pgvector's cosine distance is undefined for a zero vector, and text with no word characters
  // would produce one. Nothing in this file does, but a NaN would be a confusing way to find out.
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

const embeddings: EmbeddingProvider = {
  id: MODEL_ID,
  provider: 'local',
  model: 'stub-bag-of-words',
  dimensions: DIMS,
  ready: true,
  // No model here, so no window to discover; nothing in the search path reads these three.
  maxInputTokens: 512,
  truncatesAtTokens: 512,
  windowSource: 'default',
  countTokens: (text) => Math.ceil(text.length / 4),
  // Symmetric on purpose: this stub is a bag of words, and the two sides being the same function is
  // exactly what an empty prefix pair means (ADR-0038).
  queryPrefix: '',
  passagePrefix: '',
  warmup: async () => {},
  embedPassages: async (texts: string[]) => texts.map(stubVector),
  embedQuery: async (text: string) => stubVector(text),
};

interface Excerpt {
  path: string;
  title: string;
  headingPath: string;
  content: string;
}

const HANDBOOK: Excerpt[] = [
  {
    path: 'handbook/webhooks.md',
    title: 'Webhooks',
    headingPath: 'Webhooks > Rotating the secret',
    content: 'Rotate the webhook secret from the source panel. The old secret stops verifying push payloads immediately.',
  },
  {
    path: 'handbook/uploads.md',
    title: 'Uploads',
    headingPath: 'Uploads > Archives',
    content: 'An uploaded archive is unpacked on the server into a staging directory and swapped in when the upload is committed.',
  },
  {
    path: 'handbook/notion.md',
    title: 'Notion',
    headingPath: 'Notion > Sharing pages',
    content: 'Pages shared with an internal integration are pulled on every sync and rendered to Markdown before chunking.',
  },
];

/** The query is the one the first excerpt answers, and shares no word with the other two. */
const QUERY = 'rotate the webhook secret';

let database: TestDatabase;
let app: FastifyInstance;
let indexedId: string;
let barrenId: string;
let staleId: string;
const cookies: Record<string, string> = {};

async function buildApi(db: Db): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie);
  const ctx = {
    config: {
      ALLOWED_ORIGINS: [],
      ALLOWED_DOC_ROOTS: ['/docs'],
      AUTH_SESSION_IDLE_MS: 60_000,
      AUTH_COOKIE_SECURE: '0',
      DATA_DIR: '/tmp/contextator-search-itest',
      EMBEDDING_DTYPE: 'fp32',
      SECRET_KEY: undefined,
      UPLOAD_MAX_FILE_BYTES: 1024,
      UPLOAD_MAX_FILES_PER_REQUEST: 1,
      UPLOAD_MAX_ARCHIVE_BYTES: 1024,
    },
    db,
    log: silentLogger,
    embeddings,
    indexer: { getJob: () => null, queueInfo: () => undefined },
    locks: {},
    uploads: {},
    sessions: new SessionRegistry(silentLogger),
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  return instance;
}

async function seedProject(name: string, excerpts: Excerpt[], embeddingModel: string | null): Promise<string> {
  const [project] = await database.db.insert(projects).values({ name }).returning({ id: projects.id });
  if (excerpts.length > 0) {
    const [source] = await database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'handbook' })
      .returning({ id: documentSources.id });
    for (const excerpt of excerpts) {
      const chunk: NewChunk = {
        chunkIndex: 0,
        headingPath: excerpt.headingPath,
        content: excerpt.content,
        tokenCount: 40,
        // The same text the indexer would embed: breadcrumb, blank line, content (ADR-0008).
        embedding: stubVector(`${excerpt.headingPath}\n\n${excerpt.content}`),
      };
      await replaceDocument(
        database.db,
        {
          projectId: project.id,
          sourceId: source.id,
          relativePath: excerpt.path,
          title: excerpt.title,
          contentHash: excerpt.path,
          sizeBytes: 512,
          indexGeneration: LIVE,
        },
        [chunk],
      );
    }
  }
  await database.db
    .update(projects)
    .set({ chunkCount: excerpts.length, documentCount: excerpts.length, embeddingModel, lastIndexedAt: new Date() })
    .where(eq(projects.id, project.id));
  return project.id;
}

async function signIn(username: string, role: 'root' | 'member'): Promise<string> {
  const user = await createUser(database.db, { username, role, password: 'a-password-worth-having-1!' });
  const { token } = await createSession(database.db, user.id, 1, { userAgent: 'itest' });
  cookies[username] = token;
  return user.id;
}

const search = (as: string, projectId: string, query: string) =>
  app.inject({ method: 'GET', url: `/api/projects/${projectId}/search?${query}`, cookies: { [SESSION_COOKIE]: cookies[as] } });

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'search_api');
  await applySchema(database, DIMS);
  app = await buildApi(database.db);

  indexedId = await seedProject('handbook', HANDBOOK, MODEL_ID);
  barrenId = await seedProject('barren', [], null);
  staleId = await seedProject('stale', HANDBOOK, 'local:a-model-this-server-no-longer-runs:fp32');

  await signIn('owner', 'root');
  const readerId = await signIn('reader', 'member');
  await signIn('stranger', 'member');
  await setMemberRole(database.db, indexedId, readerId, 'viewer', null);
  await setMemberRole(database.db, staleId, readerId, 'viewer', null);
  await setMemberRole(database.db, barrenId, readerId, 'viewer', null);
});

afterAll(async () => {
  await app.close();
  await dropTestDatabase(baseUrl, database);
});

describe('a viewer searching a project they are a member of', () => {
  it('gets ranked excerpts with the score and the path of each', async () => {
    const res = await search('reader', indexedId, `q=${encodeURIComponent(QUERY)}`);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.query).toBe(QUERY);
    expect(body.limit).toBe(5);
    expect(body.hits).toHaveLength(HANDBOOK.length);

    const best = body.hits[0];
    expect(best.path).toBe('handbook/webhooks.md');
    expect(best.title).toBe('Webhooks');
    expect(best.headingPath).toBe('Webhooks > Rotating the secret');
    expect(best.chunkIndex).toBe(0);
    expect(best.content).toBe(HANDBOOK[0].content);
    // The number the panel shows and Phase 1 will be judged on: a raw cosine similarity, not a rank.
    expect(typeof best.score).toBe('number');
    expect(best.score).toBeGreaterThan(0);
    for (const [rank, hit] of body.hits.entries()) if (rank > 0) expect(hit.score).toBeLessThanOrEqual(body.hits[rank - 1].score);
  });

  it('answers with exactly what searchChunks returns for the same query', async () => {
    const res = await search('reader', indexedId, `q=${encodeURIComponent(QUERY)}&limit=2`);
    expect(res.statusCode).toBe(200);

    const vector = await embeddings.embedQuery(QUERY);
    const expected = await searchChunks(database.db, indexedId, LIVE, vector, 2);

    expect(res.json().limit).toBe(2);
    expect(res.json().hits).toEqual(
      expected.map((hit) => ({
        score: hit.score,
        path: hit.file,
        title: hit.title,
        headingPath: hit.headingPath,
        chunkIndex: hit.chunkIndex,
        content: hit.content,
      })),
    );
  });

  it('honours the limit rather than always returning five', async () => {
    const res = await search('reader', indexedId, `q=${encodeURIComponent(QUERY)}&limit=1`);
    expect(res.json().hits).toHaveLength(1);
  });
});

describe('a member with no membership on the project', () => {
  it('is answered 404 and not 403, so a project id cannot be probed', async () => {
    // `stranger` is an ordinary account; this project exists and holds three documents. The only
    // thing the answer may reveal is that the caller cannot see it, which is what 404 says.
    const res = await search('stranger', indexedId, `q=${encodeURIComponent(QUERY)}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Project not found' });
  });

  it('gets the same 404 for a project id that does not exist at all', async () => {
    const res = await search('stranger', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'q=anything');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});

describe('a project that cannot answer', () => {
  it('refuses a project with nothing indexed, naming the remedy rather than returning no hits', async () => {
    const res = await search('reader', barrenId, `q=${encodeURIComponent(QUERY)}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_indexed');
    expect(res.json().message).toMatch(/no indexed content/i);
  });

  it('refuses a project indexed with another embedding model, and says which', async () => {
    // The read-side twin of the indexer's wipe: these chunks and this query are not comparable, and
    // the scores that would come back would be arithmetic rather than retrieval.
    const res = await search('reader', staleId, `q=${encodeURIComponent(QUERY)}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('model_mismatch');
    expect(res.json().message).toContain('local:a-model-this-server-no-longer-runs:fp32');
    expect(res.json().message).toContain(MODEL_ID);
  });

  it('still refuses both for an administrator, who reaches every project', async () => {
    expect((await search('owner', barrenId, 'q=anything')).json().error).toBe('not_indexed');
    expect((await search('owner', staleId, 'q=anything')).json().error).toBe('model_mismatch');
  });
});
