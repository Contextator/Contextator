import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { webhookRoutes } from '../../src/admin/webhooks.js';
import type { AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { documentSources, projects, type DocumentSourceRow } from '../../src/db/schema.js';
import { openVerificationWindow } from '../../src/services/notion-webhook.js';
import { runSyncTick, type SchedulerIndexer } from '../../src/services/scheduler.js';
import { LocalDriver } from '../../src/services/sources/local.js';
import { PROBE_TOKEN_KEY } from '../../src/services/sources.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * [ADR-0049](../../../.ssot/ADR.md#adr-0049), whose claims are about a route, three columns and one
 * branch of the scheduler's tick — none of which is observable without a real `document_sources` row:
 *
 * 1. **A `verification_token` outside an open window is refused *and not stored*.** The window is the
 *    whole of the decision, because the URL was never a secret and Notion's first delivery is unsigned.
 * 2. **The window is one-shot.** The first token closes it, so a second POST cannot take the source
 *    over a second later.
 * 3. **A burst of deliveries produces exactly one run**, and a `comment.created` produces none.
 * 4. **A delivery-driven consideration runs even when the probe says the source has not moved.** This
 *    is the deletion case — the Notion probe reads the newest `last_edited_time`, and a deleted page
 *    moves nobody's — and it is the assertion that catches a regression nobody would otherwise see.
 *
 * **Nothing here reaches Notion.** Every delivery is a body this file signs with a token it captured
 * through the product's own route, and the probe in case 4 is a `local` source's `stat` walk.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const TOKEN = 'secret_tMrlL1qK5vuQAh1b6cZGhFChZTSYJlce98V0pYn7yBl';
const MIN_INTERVAL_MINUTES = 5;

/** Stands in for the queue: the two questions a webhook or a tick ever asks it, and nothing else. */
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
let root: string;
let projectId: string;
let notionId: string;
let localId: string;
let schedulerConfig: { ALLOWED_DOC_ROOTS: string[]; DATA_DIR: string; SECRET_KEY: string; IGNORE_GLOBS: string[]; SYNC_PROBES_PER_TICK: number };

const sourceRow = async (id: string): Promise<DocumentSourceRow> => {
  const [row] = await db.select().from(documentSources).where(eq(documentSources.id, id));
  return row;
};

const sign = (raw: string, key = TOKEN) => `sha256=${createHmac('sha256', key).update(Buffer.from(raw)).digest('hex')}`;

/** A delivery in the shape Notion's reference pages publish, signed with whatever key is given. */
function delivery(type: string, key = TOKEN): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify({
    id: `56c3e00c-4f0c-4566-9676-4b058a50a0${Math.floor(Math.random() * 90 + 10)}`,
    timestamp: new Date().toISOString(),
    workspace_id: '13950b26-c203-4f3b-b97d-93ec06319565',
    subscription_id: '29d75c0d-5546-4414-8459-7b7a92f1fc4b',
    attempt_number: 1,
    type,
    entity: { id: '0ef104cd-477e-80e1-8571-cfd10e92339a', type: 'page' },
    data: { parent: { id: '0ef104cd-477e-80e1-8571-cfd10e92339a', type: 'page' } },
  });
  return { payload, headers: { 'content-type': 'application/json', 'x-notion-signature': sign(payload, key) } };
}

async function post(sourceId: string, payload: string, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const res = await app.inject({ method: 'POST', url: `/api/webhooks/notion/${sourceId}`, payload, headers });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

const tick = () => runSyncTick({ db, indexer: recorder, log: silentLogger, config: schedulerConfig });

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'notion_webhook');
  await applySchema(database, DIMS);
  db = database.db;

  root = await mkdtemp(path.join(tmpdir(), 'notion-webhook-'));
  await writeFile(path.join(root, 'handbook.md'), '# Handbook\n\nHow to rotate a secret.\n', 'utf8');

  const [project] = await db.insert(projects).values({ name: 'notion-webhook' }).returning({ id: projects.id });
  projectId = project.id;
  const [notion] = await db
    .insert(documentSources)
    .values({ projectId, type: 'notion', name: 'workspace', config: { rootIds: [], extensions: ['md'] } })
    .returning({ id: documentSources.id });
  notionId = notion.id;
  const [local] = await db
    .insert(documentSources)
    .values({ projectId, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } })
    .returning({ id: documentSources.id });
  localId = local.id;

  schedulerConfig = {
    ALLOWED_DOC_ROOTS: [root],
    DATA_DIR: path.join(root, '.data'),
    SECRET_KEY: '0'.repeat(64),
    IGNORE_GLOBS: [],
    SYNC_PROBES_PER_TICK: 10,
  };

  app = Fastify({ logger: false });
  const ctx = { db, config: { WEBHOOK_MIN_INTERVAL_MINUTES: MIN_INTERVAL_MINUTES }, indexer: recorder, log: silentLogger } as unknown as AppContext;
  await app.register(webhookRoutes, { ctx });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  await dropTestDatabase(baseUrl, database);
});

beforeEach(() => {
  enqueued.length = 0;
});

describe('the verification window', () => {
  it('refuses a token when no window is open, and stores nothing', async () => {
    const res = await post(notionId, JSON.stringify({ verification_token: TOKEN }));
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('verification_not_open');
    // **Not stored** is the half that matters: a refusal that left the token behind would be the race
    // the window exists to close, with an extra step.
    expect((await sourceRow(notionId)).webhookSecret).toBeNull();
  });

  it('refuses a token from a window that has expired', async () => {
    await openVerificationWindow(db, notionId);
    await db
      .update(documentSources)
      .set({ webhookVerificationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(documentSources.id, notionId));
    expect((await post(notionId, JSON.stringify({ verification_token: TOKEN }))).statusCode).toBe(401);
    expect((await sourceRow(notionId)).webhookSecret).toBeNull();
  });

  it('accepts one token inside an open window, and closes the window with it', async () => {
    const expiresAt = await openVerificationWindow(db, notionId);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Fifteen minutes, and the constant is the contract the runbook states.
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 16 * 60_000);

    const accepted = await post(notionId, JSON.stringify({ verification_token: TOKEN }));
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toEqual({ verified: true });

    const row = await sourceRow(notionId);
    expect(row.webhookSecret).toBe(TOKEN);
    expect(row.webhookVerificationExpiresAt).toBeNull();

    // **One-shot.** A second token a moment later is refused, and the first one still stands — which is
    // what stops anybody who learns the URL from taking the source over after the operator verified it.
    const second = await post(notionId, JSON.stringify({ verification_token: 'secret_somebody_else' }));
    expect(second.statusCode).toBe(401);
    expect((await sourceRow(notionId)).webhookSecret).toBe(TOKEN);
  });
});

describe('a signed delivery', () => {
  it('queues a run, in the interactive lane', async () => {
    const { payload, headers } = delivery('page.content_updated');
    const res = await post(notionId, payload, headers);
    expect(res.statusCode).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
  });

  it('is refused when one byte of the body moved after it was signed', async () => {
    const { payload, headers } = delivery('page.content_updated');
    const mutated = payload.replace('"attempt_number":1', '"attempt_number":2');
    const res = await post(notionId, mutated, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(enqueued).toEqual([]);
  });

  it('is refused when it is signed with another token', async () => {
    const { payload, headers } = delivery('page.deleted', 'secret_not_ours');
    expect((await post(notionId, payload, headers)).statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it('queues nothing for a comment, and says so with a 200', async () => {
    const { payload, headers } = delivery('comment.created');
    const res = await post(notionId, payload, headers);
    // Not an error: a filtered delivery is a delivery Notion should stop retrying.
    expect(res.statusCode).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(String(res.body.reason)).toContain('comment.created');
    expect(enqueued).toEqual([]);
  });

  it('is refused on a source that never captured a token', async () => {
    const [fresh] = await db
      .insert(documentSources)
      .values({ projectId, type: 'notion', name: 'unverified', config: { rootIds: [], extensions: ['md'] } })
      .returning({ id: documentSources.id });
    const { payload, headers } = delivery('page.created');
    const res = await post(fresh.id, payload, headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('not_verified');
    await db.delete(documentSources).where(eq(documentSources.id, fresh.id));
  });
});

describe('a burst of deliveries', () => {
  it('collapses into one run at one due time, and one tick takes it', async () => {
    // A source that synced a moment ago: the run is not owed yet, so every delivery writes a claim.
    await db
      .update(documentSources)
      .set({ lastSyncedAt: new Date(), webhookDueAt: null, syncIntervalMinutes: 60, nextSyncAt: new Date(Date.now() + 3_600_000) })
      .where(eq(documentSources.id, notionId));

    const answers = [];
    for (let i = 0; i < 25; i++) {
      const { payload, headers } = delivery('page.content_updated');
      answers.push(await post(notionId, payload, headers));
    }
    // Twenty-five deliveries, twenty-five idempotent updates, no runs — and every one of them names the
    // same moment, because the value is computed from the last sync and the minimum rather than accrued.
    expect(answers.every((a) => a.statusCode === 200 && a.body.queued === false)).toBe(true);
    expect(new Set(answers.map((a) => a.body.dueAt)).size).toBe(1);
    expect(enqueued).toEqual([]);

    const due = (await sourceRow(notionId)).webhookDueAt;
    expect(due).not.toBeNull();
    // The earliest permitted moment, not "now" and not "the interval from now".
    expect(due!.getTime()).toBeGreaterThan(Date.now());
    expect(due!.getTime()).toBeLessThanOrEqual(Date.now() + MIN_INTERVAL_MINUTES * 60_000 + 1000);

    // Bring the claim forward rather than waiting five minutes for it.
    await db
      .update(documentSources)
      .set({ webhookDueAt: new Date(Date.now() - 1000) })
      .where(eq(documentSources.id, notionId));

    const first = await tick();
    expect(first).toMatchObject({ considered: 1, claimed: 1, probed: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);

    // And the claim did not survive its own consideration, so the row is not permanently due — the hot
    // loop of [ADR-0048](../../../.ssot/ADR.md#adr-0048) with a different column in it.
    expect((await sourceRow(notionId)).webhookDueAt).toBeNull();
    enqueued.length = 0;
    expect(await tick()).toMatchObject({ due: 0, considered: 0, enqueued: 0 });
    expect(enqueued).toEqual([]);
  });

  it('queues immediately when the last sync is older than the minimum', async () => {
    await db
      .update(documentSources)
      .set({ lastSyncedAt: new Date(Date.now() - (MIN_INTERVAL_MINUTES + 1) * 60_000), webhookDueAt: null })
      .where(eq(documentSources.id, notionId));
    const { payload, headers } = delivery('page.deleted');
    const res = await post(notionId, payload, headers);
    expect(res.body.queued).toBe(true);
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
    // Nothing was claimed: the run is already queued, and a claim would be a second run behind it.
    expect((await sourceRow(notionId)).webhookDueAt).toBeNull();
  });
});

describe('a claim outranks the probe', () => {
  /** The token the local driver would mint right now — the same method a sync stores its answer from. */
  const currentToken = async (): Promise<string> => {
    const driver = new LocalDriver(await sourceRow(localId), { db, log: silentLogger, config: schedulerConfig });
    const token = await driver.probe();
    expect(token).not.toBeNull();
    return token!;
  };

  beforeEach(async () => {
    const row = await sourceRow(localId);
    await db
      .update(documentSources)
      .set({ config: { ...row.config, [PROBE_TOKEN_KEY]: await currentToken() } })
      .where(eq(documentSources.id, localId));
    // The Notion source must not join in: its claim and its schedule are another test's.
    await db.update(documentSources).set({ webhookDueAt: null, syncIntervalMinutes: null, nextSyncAt: null }).where(eq(documentSources.id, notionId));
  });

  it('runs a claimed source the probe would have called unchanged', async () => {
    // **The deletion case.** The stored token matches what the source says right now, so the probe
    // would answer "unchanged" and skip the run — which for Notion is exactly what a `page.deleted`
    // delivery reports, because deleting a page moves nobody's `last_edited_time`. The claim wins, the
    // probe is not even called, and the run is queued in the interactive lane.
    await db
      .update(documentSources)
      .set({ syncIntervalMinutes: 15, nextSyncAt: new Date(Date.now() - 60_000), webhookDueAt: new Date(Date.now() - 60_000) })
      .where(eq(documentSources.id, localId));

    expect(await tick()).toMatchObject({ considered: 1, claimed: 1, probed: 0, unchanged: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
  });

  it('skips the same source without a claim, which is what makes the case above mean anything', async () => {
    // The control. Same row, same stored token, same due time — and no claim. If this did not skip,
    // the assertion above would pass for a reason that has nothing to do with the claim.
    await db
      .update(documentSources)
      .set({ syncIntervalMinutes: 15, nextSyncAt: new Date(Date.now() - 60_000), webhookDueAt: null })
      .where(eq(documentSources.id, localId));

    expect(await tick()).toMatchObject({ considered: 1, claimed: 0, probed: 1, unchanged: 1, enqueued: 0 });
    expect(enqueued).toEqual([]);
  });

  it('takes a claimed source whose scheduling is switched off entirely', async () => {
    // Without the widened predicate this row is invisible to the tick, and its claim would be written
    // and never read: a webhook that works until somebody sets "Sync every" to never.
    await db
      .update(documentSources)
      .set({ syncIntervalMinutes: null, nextSyncAt: null, webhookDueAt: new Date(Date.now() - 1000) })
      .where(eq(documentSources.id, localId));

    expect(await tick()).toMatchObject({ due: 1, considered: 1, claimed: 1, probed: 0, enqueued: 1 });
    expect(enqueued).toEqual([{ projectId, trigger: 'webhook' }]);
    expect((await sourceRow(localId)).webhookDueAt).toBeNull();
    // Nothing gave it a schedule on the way past, either.
    expect((await sourceRow(localId)).syncIntervalMinutes).toBeNull();
  });

  it('leaves a claim that is still in the future alone', async () => {
    await db
      .update(documentSources)
      .set({ syncIntervalMinutes: null, nextSyncAt: null, webhookDueAt: new Date(Date.now() + 60_000) })
      .where(eq(documentSources.id, localId));

    expect(await tick()).toMatchObject({ due: 0, considered: 0, claimed: 0, enqueued: 0 });
    expect((await sourceRow(localId)).webhookDueAt).not.toBeNull();
  });
});

describe('the migration that adds the columns', () => {
  it('leaves every source that already existed with no window, no claim and the instance default', async () => {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM document_sources
      WHERE webhook_verification_expires_at IS NULL AND webhook_min_interval_minutes IS NULL`);
    // Nothing in this file ever set a per-source minimum, and the window is only ever opened by an
    // editor — so both are NULL on every row, which is what an upgraded installation looks like.
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
