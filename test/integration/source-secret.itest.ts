import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { adminRoutes } from '../../src/admin/routes.js';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { documentSources, projects } from '../../src/db/schema.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { SetupGate } from '../../src/services/auth/setup.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { SlidingWindow } from '../../src/services/rate-limit.js';
// Registered for their side effect, as `server.ts` does: without a driver the route answers 409.
import '../../src/services/sources/git.js';
import '../../src/services/sources/web.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * Which source types may hold a secret, as the admin API enforces it
 * ([ADR-0091](../../.ssot/ADR.md#adr-0091), FR-618).
 *
 * Driven through the real `POST` and `PATCH` routes, so what is asserted is the status and body a
 * client gets — `400 invalid_request` naming the type — and not only what the service throws.
 */

const baseUrl = inject('postgresBaseUrl');
const ADMIN_TOKEN = 'a-token-for-the-secret-test';

const embeddings: EmbeddingProvider = {
  id: 'local:stub:fp32',
  dimensions: TEST_EMBEDDING_DIMENSIONS,
  embedDocuments: async (texts: string[]) => texts.map(() => new Array<number>(TEST_EMBEDDING_DIMENSIONS).fill(0)),
  embedQuery: async () => new Array<number>(TEST_EMBEDDING_DIMENSIONS).fill(0),
} as unknown as EmbeddingProvider;

let database: TestDatabase;
let root: string;
let docs: string;
let projectId: string;
let app: FastifyInstance;

async function adminApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie);
  const ctx = {
    config: loadConfig({
      DATABASE_URL: database.url,
      ALLOWED_DOC_ROOTS: root,
      DATA_DIR: path.join(root, '.data'),
      SECRET_KEY: '0'.repeat(64),
      ADMIN_TOKEN,
    }),
    db: database.db,
    log: silentLogger,
    embeddings,
    // Nothing here indexes: every create sends `index: false`, and a PATCH that changes no setting
    // asks for no run.
    indexer: {
      enqueue: () => ({}),
      isBusy: () => false,
      getJob: () => null,
      queueInfo: () => undefined,
    },
    locks: new KeyedMutex(),
    uploads: {},
    sessions: {},
    setup: new SetupGate(),
    loginLimiter: new SlidingWindow(10, 1000),
    version: '0.0.0-test',
    startedAt: Date.now(),
  } as unknown as AppContext;
  await instance.register(adminRoutes, { ctx });
  await instance.ready();
  return instance;
}

function post(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/sources`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { index: false, ...payload },
  });
}

function patch(sourceId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}/sources/${sourceId}`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload,
  });
}

async function stored(sourceId: string): Promise<string | null> {
  const [row] = await database.db.select({ secretEnc: documentSources.secretEnc }).from(documentSources).where(eq(documentSources.id, sourceId));
  return row.secretEnc;
}

/** The settings each type needs to get past its own validation, so the secret is what decides. */
function configFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'local':
      return { path: docs };
    case 'upload':
      return {};
    case 'web':
      return { entryUrl: 'https://docs.example.com/sitemap.xml' };
    case 'git':
      return { url: 'https://git.example.com/acme/handbook.git' };
    default:
      throw new Error(`no fixture config for ${type}`);
  }
}

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'source_secret');
  await applySchema(database, TEST_EMBEDDING_DIMENSIONS);
  root = await mkdtemp(path.join(tmpdir(), 'contextator-source-secret-'));
  docs = path.join(root, 'docs');
  await mkdir(docs);
  const [project] = await database.db.insert(projects).values({ name: 'secrets' }).returning();
  projectId = project.id;
  app = await adminApp();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
  if (database) await dropTestDatabase(baseUrl, database);
});

describe('a secret on a source type that uses none (ADR-0091)', () => {
  it.each(['local', 'upload', 'web'])('refuses a %s source created with a secret, naming the type, and stores nothing', async (type) => {
    const response = await post({ type, name: `${type}-with-secret`, config: configFor(type), secret: 'hunter2' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toContain(`A ${type} source takes no secret`);
    const rows = await database.db
      .select()
      .from(documentSources)
      .where(eq(documentSources.name, `${type}-with-secret`));
    expect(rows).toHaveLength(0);
  });

  it.each(['local', 'upload', 'web', 'git'])('accepts `secret: null` on a %s source, which is "no secret"', async (type) => {
    const response = await post({ type, name: `${type}-null-secret`, config: configFor(type), secret: null });
    expect(response.statusCode).toBe(201);
    const view = response.json() as { id: string; hasSecret: boolean };
    expect(view.hasSecret).toBe(false);
    expect(await stored(view.id)).toBeNull();
  });

  it('still takes a secret on a git source', async () => {
    const response = await post({ type: 'git', name: 'git-with-secret', config: configFor('git'), secret: 'a-deploy-token' });
    expect(response.statusCode).toBe(201);
    const view = response.json() as { id: string; hasSecret: boolean };
    expect(view.hasSecret).toBe(true);
    expect(await stored(view.id)).not.toBeNull();
  });

  it('refuses a secret patched onto a local source, and leaves the row as it was', async () => {
    const created = await post({ type: 'local', name: 'local-patched', config: configFor('local') });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const response = await patch(id, { secret: 'hunter2' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toContain('A local source takes no secret');
    expect(await stored(id)).toBeNull();

    const cleared = await patch(id, { secret: null });
    expect(cleared.statusCode).toBe(200);
  });

  it('leaves a secret already stored on a local source in place, and does not block its other edits', async () => {
    const [row] = await database.db
      .insert(documentSources)
      .values({ projectId, type: 'local', name: 'local-legacy', config: { path: docs }, secretEnc: 'v1:legacy-ciphertext' })
      .returning();

    const response = await patch(row.id, { label: 'Handbook' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { label: string }).label).toBe('Handbook');
    expect(await stored(row.id)).toBe('v1:legacy-ciphertext');

    // And `null` removes it, which is the way out for an operator who wants it gone before a restore.
    expect((await patch(row.id, { secret: null })).statusCode).toBe(200);
    expect(await stored(row.id)).toBeNull();
  });
});
