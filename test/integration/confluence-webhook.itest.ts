import { createHmac } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { webhookRoutes } from '../../src/admin/webhooks.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, projects, type DocumentSourceRow } from '../../src/db/schema.js';
import { decryptWebhookSecret, keyringOf } from '../../src/services/crypto.js';
import { runSyncTick, type SchedulerIndexer } from '../../src/services/scheduler.js';
import { createSource, disableWebhook, regenerateWebhookSecret, toSourceView } from '../../src/services/sources.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';
import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';

/**
 * The Confluence webhook, held to [ADR-0049](../../../.ssot/ADR.md#adr-0049)'s three claims on a real
 * `document_sources` row:
 *
 * 1. **A delivery with the right secret queues a run**, in the interactive lane, and a burst of them is
 *    one run the scheduler takes without asking the probe.
 * 2. **A delivery with any other secret — or none — is refused**, and queues nothing.
 * 3. **While the window is closed, a delivery is refused and nothing is written.** For Confluence the
 *    window is the secret's existence: a source is created without one, an editor turns the webhook
 *    on by generating it, and can turn it off again. Before that, and after, every delivery —
 *    including one shaped like Notion's unsigned `verification_token` — answers `not_enabled` and
 *    leaves the row as it was.
 *
 * **Nothing here reaches Confluence.** Every delivery is a body this file signs, and the tick in the
 * burst case takes a claim, which never calls a driver.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const SECRET_KEY = '0'.repeat(64);
const keys = keyringOf({ SECRET_KEY });
const serviceOpts = { allowedRoots: [] as string[], keys };
const MIN_INTERVAL_MINUTES = 5;

const enqueued: Array<{ projectId: string; trigger: string | undefined }> = [];
const recorder: SchedulerIndexer = {
  isBusy: () => false,
  enqueue: (projectId, opts = {}) => {
    enqueued.push({ projectId, trigger: opts.trigger });
    return {
      projectId,
      force: false,
      trigger: opts.trigger ?? 'manual',
      phase: 'queued',
      filesTotal: 0,
      filesDone: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      chunksDone: 0,
      sources: [],
      queuedAt: new Date().toISOString(),
    };
  },
};

let database: TestDatabase;
let db: Db;
let app: FastifyInstance;
let projectId: string;
let confluenceId: string;

const sourceRow = async (id: string): Promise<DocumentSourceRow> => {
  const [row] = await db.select().from(documentSources).where(eq(documentSources.id, id));
  return row;
};

/** The secret as the dashboard shows it to an editor — the only way it leaves the product. */
const currentSecret = async (): Promise<string> => {
  const secret = toSourceView(await sourceRow(confluenceId), { keys }).webhookSecret;
  expect(secret).not.toBeNull();
  return secret as string;
};

const sign = (raw: string, key: string) => `sha256=${createHmac('sha256', key).update(Buffer.from(raw)).digest('hex')}`;

/** A delivery in the shape Confluence Data Center's webhooks send, signed with whatever key is given. */
function delivery(event: string, key: string | null): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify({
    timestamp: Date.now(),
    event,
    userKey: 'ff8080817b0a3a9c017b0a3b5a2d0000',
    page: { id: 98_000 + Math.floor(Math.random() * 1000) },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers['x-hub-signature'] = sign(payload, key);
  return { payload, headers };
}

async function post(sourceId: string, payload: string, headers: Record<string, string>, route = 'confluence') {
  const res = await app.inject({ method: 'POST', url: `/api/webhooks/${route}/${sourceId}`, payload, headers });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

const tick = () =>
  runSyncTick({
    db,
    indexer: recorder,
    log: silentLogger,
    config: { ...WEB_LIMIT_DEFAULTS, ALLOWED_DOC_ROOTS: [], DATA_DIR: '/nonexistent', SECRET_KEY, IGNORE_GLOBS: [], SYNC_PROBES_PER_TICK: 10 },
  });

/** A source that synced a moment ago, so a delivery is debounced rather than enqueued. */
const syncedJustNow = () =>
  db
    .update(documentSources)
    .set({ lastSyncedAt: new Date(), webhookDueAt: null, syncIntervalMinutes: null, nextSyncAt: null })
    .where(eq(documentSources.id, confluenceId));

/** A source whose last sync is older than the minimum, so a delivery is enqueued at once. */
const syncedLongAgo = () =>
  db
    .update(documentSources)
    .set({
      lastSyncedAt: new Date(Date.now() - (MIN_INTERVAL_MINUTES + 1) * 60_000),
      webhookDueAt: null,
      syncIntervalMinutes: null,
      nextSyncAt: null,
    })
    .where(eq(documentSources.id, confluenceId));

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'confluence_webhook');
  await applySchema(database, DIMS);
  db = database.db;

  const [project] = await db.insert(projects).values({ name: 'confluence-webhook' }).returning({ id: projects.id });
  projectId = project.id;
  // Through the service, not a bare insert: "created without a secret" is a claim about `createSource`.
  const created = await createSource(
    db,
    projectId,
    { type: 'confluence', name: 'wiki', config: { baseUrl: 'https://example.atlassian.net/wiki', email: 'ops@example.com', spaceKeys: ['ENG'] } },
    serviceOpts,
  );
  confluenceId = created.id;

  app = Fastify({ logger: false });
  const ctx = {
    db,
    config: { WEBHOOK_MIN_INTERVAL_MINUTES: MIN_INTERVAL_MINUTES, SECRET_KEY },
    indexer: recorder,
    log: silentLogger,
  } as unknown as AppContext;
  await app.register(webhookRoutes, { ctx });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await dropTestDatabase(baseUrl, database);
});

beforeEach(() => {
  enqueued.length = 0;
});

describe('while the webhook is off — the closed window', () => {
  it('is how a Confluence source is born', async () => {
    const row = await sourceRow(confluenceId);
    expect(row.webhookSecret).toBeNull();
    const view = toSourceView(row, { keys });
    expect(view.hasWebhookSecret).toBe(false);
    expect(view.webhookSecret).toBeNull();
  });

  it('refuses a signed delivery with not_enabled, queues nothing and writes nothing', async () => {
    await syncedJustNow();
    // Signed with a key somebody chose: there is no secret here for it to match or not match.
    const { payload, headers } = delivery('page_updated', 'a-key-the-sender-picked');
    const res = await post(confluenceId, payload, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('not_enabled');
    expect(enqueued).toEqual([]);
    const row = await sourceRow(confluenceId);
    // **Nothing written** is the half that matters: no claim for the tick, and no secret either.
    expect(row.webhookDueAt).toBeNull();
    expect(row.webhookSecret).toBeNull();
  });

  it('does not treat a verification_token body as a way in', async () => {
    // The Notion route's capture path does not exist here: an unsigned body naming a token is just an
    // unsigned delivery, and a URL that was never a secret cannot configure the source.
    const res = await post(confluenceId, JSON.stringify({ verification_token: 'secret_not-a-real-token' }), { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('not_enabled');
    expect((await sourceRow(confluenceId)).webhookSecret).toBeNull();
    expect(enqueued).toEqual([]);
  });
});

describe('turning the webhook on', () => {
  it('generates a secret, stores it encrypted and shows it to an editor only', async () => {
    const row = await regenerateWebhookSecret(db, projectId, confluenceId, serviceOpts);
    expect(row.webhookSecret).not.toBeNull();
    const plain = decryptWebhookSecret(row.webhookSecret as string, keys);
    // Sealed at rest ([ADR-0075](../../../.ssot/ADR.md#adr-0075)), like every other secret this product stores.
    expect(row.webhookSecret).not.toBe(plain);
    expect(plain.length).toBeGreaterThanOrEqual(32);
    expect(toSourceView(row, { keys }).webhookSecret).toBe(plain);
    const asViewer = toSourceView(row, { keys, revealWebhookSecret: false });
    expect(asViewer.webhookSecret).toBeNull();
    expect(asViewer.hasWebhookSecret).toBe(true);
  });
});

describe('a signed delivery', () => {
  it('queues a run in the interactive lane when it carries the right secret', async () => {
    await syncedLongAgo();
    const { payload, headers } = delivery('page_updated', await currentSecret());
    const res = await post(confluenceId, payload, headers);
    expect(res.statusCode).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
    // Queued now, so nothing was claimed behind it.
    expect((await sourceRow(confluenceId)).webhookDueAt).toBeNull();
  });

  it('is refused when it is signed with another secret', async () => {
    await syncedLongAgo();
    const { payload, headers } = delivery('page_updated', 'not-the-secret-this-source-holds');
    const res = await post(confluenceId, payload, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(enqueued).toEqual([]);
    expect((await sourceRow(confluenceId)).webhookDueAt).toBeNull();
  });

  it('is refused when it is not signed at all', async () => {
    await syncedLongAgo();
    const { payload, headers } = delivery('page_removed', null);
    const res = await post(confluenceId, payload, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(enqueued).toEqual([]);
  });

  it('is refused when one byte of the body moved after it was signed', async () => {
    await syncedLongAgo();
    const { payload, headers } = delivery('page_updated', await currentSecret());
    const res = await post(confluenceId, payload.replace('page_updated', 'page_created'), headers);
    expect(res.statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it('queues nothing for a comment, and says so with a 200', async () => {
    await syncedLongAgo();
    const { payload, headers } = delivery('comment_created', await currentSecret());
    const res = await post(confluenceId, payload, headers);
    // Not an error: Confluence counts a non-2xx as a failed delivery and switches a webhook off after a run of them.
    expect(res.statusCode).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(String(res.body.reason)).toContain('comment_created');
    expect(enqueued).toEqual([]);
  });

  it('is not accepted on the git route, and a git or Notion id is not accepted here', async () => {
    const { payload, headers } = delivery('page_updated', await currentSecret());
    expect((await post(confluenceId, payload, headers, 'git')).statusCode).toBe(404);
    expect((await post(confluenceId, payload, headers, 'notion')).statusCode).toBe(404);
    const [notion] = await db
      .insert(documentSources)
      .values({ projectId, type: 'notion', name: 'workspace', config: { rootIds: [], extensions: ['md'] } })
      .returning({ id: documentSources.id });
    expect((await post(notion.id, payload, headers)).statusCode).toBe(404);
    await db.delete(documentSources).where(eq(documentSources.id, notion.id));
    expect(enqueued).toEqual([]);
  });

  it('stops verifying with the old secret once a new one is generated', async () => {
    await syncedLongAgo();
    const old = await currentSecret();
    await regenerateWebhookSecret(db, projectId, confluenceId, serviceOpts);
    const { payload, headers } = delivery('page_updated', old);
    expect((await post(confluenceId, payload, headers)).statusCode).toBe(401);
    const fresh = delivery('page_updated', await currentSecret());
    expect((await post(confluenceId, fresh.payload, fresh.headers)).statusCode).toBe(200);
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
  });
});

describe('a burst of deliveries', () => {
  it('collapses into one claim, which one tick takes without asking the probe', async () => {
    await syncedJustNow();
    const secret = await currentSecret();
    const answers = [];
    for (let i = 0; i < 20; i++) {
      const { payload, headers } = delivery(i % 2 === 0 ? 'page_updated' : 'page_moved', secret);
      answers.push(await post(confluenceId, payload, headers));
    }
    expect(answers.every((a) => a.statusCode === 200 && a.body.queued === false)).toBe(true);
    expect(new Set(answers.map((a) => a.body.dueAt)).size).toBe(1);
    expect(enqueued).toEqual([]);

    const due = (await sourceRow(confluenceId)).webhookDueAt;
    expect(due).not.toBeNull();
    expect(due!.getTime()).toBeLessThanOrEqual(Date.now() + MIN_INTERVAL_MINUTES * 60_000 + 1000);
    // The claim is visible on the source as the dashboard reads it, as it is for Notion.
    expect(toSourceView(await sourceRow(confluenceId), { keys }).webhookDueAt).not.toBeNull();

    await db
      .update(documentSources)
      .set({ webhookDueAt: new Date(Date.now() - 1000) })
      .where(eq(documentSources.id, confluenceId));
    // Scheduling is off on this source, so the only way it is considered at all is the claim — and a
    // claim is taken without a probe, which is the "delivery outranks the probe" half of ADR-0049.
    expect(await tick()).toMatchObject({ considered: 1, claimed: 1, probed: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
    expect((await sourceRow(confluenceId)).webhookDueAt).toBeNull();
  });
});

describe('turning the webhook off', () => {
  it('drops the secret and any claim, and the route is closed again', async () => {
    await syncedJustNow();
    const secret = await currentSecret();
    const pending = delivery('page_updated', secret);
    expect((await post(confluenceId, pending.payload, pending.headers)).body.queued).toBe(false);
    expect((await sourceRow(confluenceId)).webhookDueAt).not.toBeNull();

    const row = await disableWebhook(db, projectId, confluenceId);
    expect(row.webhookSecret).toBeNull();
    expect(row.webhookDueAt).toBeNull();

    const { payload, headers } = delivery('page_updated', secret);
    const res = await post(confluenceId, payload, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('not_enabled');
    expect((await sourceRow(confluenceId)).webhookDueAt).toBeNull();
    expect(enqueued).toEqual([]);
  });

  it('is a Confluence switch only, and the generated secret is git and Confluence only', async () => {
    const [git] = await db
      .insert(documentSources)
      .values({
        projectId,
        type: 'git',
        name: 'repo',
        config: { url: 'https://example.com/r.git', branch: 'main', extensions: ['md'] },
        webhookSecret: 'x',
      })
      .returning({ id: documentSources.id });
    const [notion] = await db
      .insert(documentSources)
      .values({ projectId, type: 'notion', name: 'notes', config: { rootIds: [], extensions: ['md'] } })
      .returning({ id: documentSources.id });
    await expect(disableWebhook(db, projectId, git.id)).rejects.toThrow('Only a Confluence source can turn its webhook off');
    await expect(disableWebhook(db, projectId, notion.id)).rejects.toThrow('Only a Confluence source can turn its webhook off');
    await expect(regenerateWebhookSecret(db, projectId, notion.id, serviceOpts)).rejects.toThrow('Only git and Confluence sources');
    // The git source's secret is where it was.
    expect((await sourceRow(git.id)).webhookSecret).toBe('x');
    await db.delete(documentSources).where(eq(documentSources.id, git.id));
    await db.delete(documentSources).where(eq(documentSources.id, notion.id));
  });
});
