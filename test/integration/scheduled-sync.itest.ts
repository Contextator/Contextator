import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { bootstrapDatabase } from '../../src/db/bootstrap.js';
import { documentSources, indexRuns, projects, type DocumentSourceRow } from '../../src/db/schema.js';
import { keyringOf } from '../../src/services/crypto.js';
import type { EmbeddingProvider } from '../../src/services/embeddings/provider.js';
import { Indexer, type JobState } from '../../src/services/indexer.js';
import { KeyedMutex } from '../../src/services/locks.js';
import { getProjectById } from '../../src/services/projects.js';
import { runSyncTick, type SchedulerIndexer, type SyncTickResult } from '../../src/services/scheduler.js';
import { LocalDriver } from '../../src/services/sources/local.js';
import { PROBE_TOKEN_KEY, createSource } from '../../src/services/sources.js';
import { ensureSchema } from './fixtures/ensure-schema-v5.js';
import { applySchema, createTestDatabase, dropTestDatabase, silentLogger, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';
import { WEB_LIMIT_DEFAULTS } from '../../src/config.js';

/**
 * [ADR-0048](../../../.ssot/ADR.md#adr-0048), which makes four claims that are not observable from
 * outside a running queue and a real `document_sources` table:
 *
 * 1. **A run that outlives its own interval cannot turn the tick into a probe loop.** This is the bug
 *    the design was written against, and the only proof of it is that `next_sync_at` moved *while the
 *    run was still going* and the ticks after it found nothing due.
 * 2. **A manual run overtakes scheduled ones already queued.** Asserted twice: on the queue positions,
 *    which is exact and involves no timing at all, and then on the order the runs actually started in,
 *    recovered from the text the embedding stub was handed.
 * 3. **An unchanged probe token enqueues nothing; a changed one and a throwing one both enqueue.**
 * 4. **The migration leaves every source that already existed switched off** — the whole of NFR-10's
 *    survival through this release.
 *
 * Nothing here sleeps waiting for an interesting moment. The gate is the one from
 * `index-generations.itest.ts`, and `runSyncTick` is called directly rather than through the timer,
 * so a tick happens exactly when the test says so.
 *
 * **No probe in this file reaches a network.** Every source is `local`, whose probe is a `stat` walk.
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const MODEL_ID = 'local:stub-bag-of-words:fp32';

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

/** `index-generations.itest.ts`' gate: park the run on the n-th batch until the test lets it go. */
class EmbedGate {
  private calls = 0;
  private armedAt: number | null = null;
  private announce: (() => void) | null = null;
  private open: ((value: 'go') => void) | null = null;
  private held: Promise<'go'> | null = null;

  armAt(call: number): Promise<void> {
    this.calls = 0;
    this.armedAt = call;
    this.held = new Promise<'go'>((resolve) => {
      this.open = resolve;
    });
    return new Promise<void>((resolve) => {
      this.announce = resolve;
    });
  }

  disarm(): void {
    this.armedAt = null;
    this.open?.('go');
  }

  async pass(): Promise<void> {
    this.calls++;
    if (this.armedAt === null || this.calls !== this.armedAt) return;
    this.announce?.();
    await this.held;
  }
}

const gate = new EmbedGate();

/**
 * Every project's documents carry the project's own marker word, so the text handed to the stub says
 * which project is being indexed. That is what turns "did the manual run go first" from a comparison
 * of two millisecond timestamps into a list.
 */
const embedded: string[] = [];

const embeddings: EmbeddingProvider = {
  id: MODEL_ID,
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
    const marker = texts[0]?.match(/marker-([a-z0-9]+)/)?.[1];
    if (marker && embedded[embedded.length - 1] !== marker) embedded.push(marker);
    await gate.pass();
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

const FILES = ['alpha.md', 'bravo.md'];

async function writeCorpus(root: string, marker: string): Promise<void> {
  for (const file of FILES) {
    await writeFile(path.join(root, file), `# ${file}\n\nThe marker-${marker} handbook explains how to rotate a secret.\n`, 'utf8');
  }
}

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

interface Fixture {
  database: TestDatabase;
  indexer: Indexer;
  /** One temp directory per project, keyed by its marker. */
  roots: Map<string, string>;
  projectIds: Map<string, string>;
  sourceIds: Map<string, string>;
  schedulerConfig: typeof indexerConfig & { SYNC_PROBES_PER_TICK: number };
}

async function buildFixture(name: string, markers: string[]): Promise<Fixture> {
  const database = await createTestDatabase(baseUrl, name);
  await applySchema(database, DIMS);

  const parent = await mkdtemp(path.join(tmpdir(), `${name}-`));
  const roots = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const sourceIds = new Map<string, string>();

  for (const marker of markers) {
    const root = await mkdtemp(path.join(parent, `${marker}-`));
    await writeCorpus(root, marker);
    roots.set(marker, root);
    const [project] = await database.db
      .insert(projects)
      .values({ name: `${name.replace(/_/g, '-')}-${marker}` })
      .returning({ id: projects.id });
    projectIds.set(marker, project.id);
    const [source] = await database.db
      .insert(documentSources)
      .values({ projectId: project.id, type: 'local', name: 'handbook', config: { path: root, extensions: ['md'] } })
      .returning({ id: documentSources.id });
    sourceIds.set(marker, source.id);
  }

  const config = { ...indexerConfig, ALLOWED_DOC_ROOTS: [parent], DATA_DIR: path.join(parent, '.data') };
  const indexer = new Indexer({ db: database.db, embeddings, config, log: silentLogger, locks: new KeyedMutex() });
  return { database, indexer, roots, projectIds, sourceIds, schedulerConfig: { ...config, SYNC_PROBES_PER_TICK: 10 } };
}

const sourceRow = async (db: Db, id: string): Promise<DocumentSourceRow> => {
  const [row] = await db.select().from(documentSources).where(eq(documentSources.id, id));
  return row;
};

/** Switches a source on and makes it due right now, which is what every case below starts from. */
async function makeDue(db: Db, sourceId: string, intervalMinutes: number): Promise<void> {
  await db
    .update(documentSources)
    .set({ syncIntervalMinutes: intervalMinutes, nextSyncAt: new Date(Date.now() - 60_000) })
    .where(eq(documentSources.id, sourceId));
}

describe('a scheduled run that outlives its own interval', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture('scheduler_hot_loop', ['hotloop']);
  });

  afterAll(async () => {
    gate.disarm();
    await rm(fx.roots.get('hotloop')!, { recursive: true, force: true }).catch(() => undefined);
    await dropTestDatabase(baseUrl, fx.database);
  });

  it('advances next_sync_at while it is still running, so the tick cannot become a probe loop', async () => {
    const db = fx.database.db;
    const projectId = fx.projectIds.get('hotloop')!;
    const sourceId = fx.sourceIds.get('hotloop')!;

    // The shortest interval the API allows, and a run parked inside it. This is the shape of a Notion
    // pull that takes three minutes against a five-minute schedule.
    await makeDue(db, sourceId, 5);
    const reached = gate.armAt(1);
    const job = fx.indexer.enqueue(projectId);
    await reached;
    expect(fx.indexer.isBusy(projectId)).toBe(true);

    const before = (await sourceRow(db, sourceId)).nextSyncAt;
    expect(before!.getTime()).toBeLessThan(Date.now()); // it really was overdue

    const ticks: SyncTickResult[] = [];
    for (let i = 0; i < 5; i++) ticks.push(await runSyncTick({ db, indexer: fx.indexer, log: silentLogger, config: fx.schedulerConfig }));

    // The first tick took it, advanced it, and asked the indexer nothing else — the project is busy,
    // and the run in flight syncs every source of it anyway.
    expect(ticks[0]).toMatchObject({ due: 1, considered: 1, busy: 1, probed: 0, enqueued: 0 });

    // **And the four after it found nothing due at all.** Before the advance moved out of the
    // "did we enqueue anything" branch, every one of these would have re-read the row, re-probed the
    // remote and re-enqueued into the job that is parked two lines above — once a minute, for as long
    // as the run took. This is that bug, asserted absent.
    for (const tick of ticks.slice(1)) expect(tick).toMatchObject({ due: 0, considered: 0, probed: 0, enqueued: 0 });

    const after = (await sourceRow(db, sourceId)).nextSyncAt;
    expect(after!.getTime()).toBeGreaterThan(Date.now());
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());

    // The four quiet ticks are quiet because the row moved, and not because the query is broken:
    // put it back in the past and the very next tick picks it up again.
    await db
      .update(documentSources)
      .set({ nextSyncAt: new Date(Date.now() - 1000) })
      .where(eq(documentSources.id, sourceId));
    const again = await runSyncTick({ db, indexer: fx.indexer, log: silentLogger, config: fx.schedulerConfig });
    expect(again).toMatchObject({ due: 1, considered: 1, busy: 1 });

    gate.disarm();
    await settle(db, job);
    expect(job.phase).toBe('done');
    fx.indexer.forget(projectId);
  }, 60_000);
});

describe('the two lanes of the indexing queue', () => {
  let fx: Fixture;
  const MARKERS = ['hold', 'sone', 'stwo', 'sthree', 'press'];

  beforeAll(async () => {
    fx = await buildFixture('scheduler_lanes', MARKERS);
  });

  afterAll(async () => {
    gate.disarm();
    for (const root of fx.roots.values()) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await dropTestDatabase(baseUrl, fx.database);
  });

  it('runs the button press before the scheduled runs already waiting in front of it', async () => {
    const db = fx.database.db;
    embedded.length = 0;

    // One run parked, so everything queued behind it is queued for as long as the test needs.
    const reached = gate.armAt(1);
    const held = fx.indexer.enqueue(fx.projectIds.get('hold')!);
    await reached;

    const scheduled = ['sone', 'stwo', 'sthree'].map((m) => fx.indexer.enqueue(fx.projectIds.get(m)!, { trigger: 'scheduled' }));
    const pressed = fx.indexer.enqueue(fx.projectIds.get('press')!, { trigger: 'manual' });

    // **The claim, with no timing in it.** Three scheduled jobs went in first and the manual one
    // last, and the manual one is nonetheless next up: position is over both lanes, in the order the
    // drain will really take them.
    expect(fx.indexer.queueInfo(fx.projectIds.get('press')!)).toEqual({ position: 0, runningProjectId: fx.projectIds.get('hold')! });
    expect(['sone', 'stwo', 'sthree'].map((m) => fx.indexer.queueInfo(fx.projectIds.get(m)!)?.position)).toEqual([1, 2, 3]);
    expect(scheduled.map((job) => job.trigger)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(pressed.trigger).toBe('manual');

    // A scheduled job that a person then asks for is promoted rather than swallowed by the collapse:
    // `enqueue` returns the job that already exists, and that job changes lane.
    const promoted = fx.indexer.enqueue(fx.projectIds.get('sthree')!, { trigger: 'manual' });
    expect(promoted).toBe(scheduled[2]);
    expect(promoted.trigger).toBe('manual');
    expect(fx.indexer.queueInfo(fx.projectIds.get('sthree')!)?.position).toBe(1);
    expect(['sone', 'stwo'].map((m) => fx.indexer.queueInfo(fx.projectIds.get(m)!)?.position)).toEqual([2, 3]);
    // And nothing is ever demoted: asking for an interactive job on the timer's behalf changes nothing.
    fx.indexer.enqueue(fx.projectIds.get('press')!, { trigger: 'scheduled' });
    expect(pressed.trigger).toBe('manual');
    expect(fx.indexer.queueInfo(fx.projectIds.get('press')!)?.position).toBe(0);

    gate.disarm();
    for (const job of [held, pressed, ...scheduled]) await settle(db, job);

    // The same claim again, from the other end: the order the runs actually happened in, recovered
    // from the text the embedding stub was handed rather than from two timestamps a millisecond apart.
    expect(embedded).toEqual(['hold', 'press', 'sthree', 'sone', 'stwo']);

    // And it is on the rows afterwards, which is what makes "did somebody wait behind the timer" a
    // query rather than a log search.
    const runs = await db.select().from(indexRuns);
    const triggerOf = (marker: string) => runs.find((r) => r.projectId === fx.projectIds.get(marker))?.trigger;
    expect(triggerOf('press')).toBe('manual');
    expect(triggerOf('sone')).toBe('scheduled');
    expect(triggerOf('sthree')).toBe('manual'); // promoted before it ran, and recorded as it ran
    for (const marker of MARKERS) fx.indexer.forget(fx.projectIds.get(marker)!);
  }, 120_000);
});

describe('what one probe decides', () => {
  let fx: Fixture;
  /** Stands in for the queue: the scheduler only ever asks these two things, and this answers both. */
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

  beforeAll(async () => {
    fx = await buildFixture('scheduler_probe', ['probe']);
  });

  afterAll(async () => {
    await rm(fx.roots.get('probe')!, { recursive: true, force: true }).catch(() => undefined);
    await rm(`${fx.roots.get('probe')!}-moved`, { recursive: true, force: true }).catch(() => undefined);
    await dropTestDatabase(baseUrl, fx.database);
  });

  const tick = () => runSyncTick({ db: fx.database.db, indexer: recorder, log: silentLogger, config: fx.schedulerConfig });

  /** The token the driver would mint right now — the same method the sync stores its answer from. */
  const currentToken = async (): Promise<string> => {
    const row = await sourceRow(fx.database.db, fx.sourceIds.get('probe')!);
    const driver = new LocalDriver(row, { db: fx.database.db, log: silentLogger, config: fx.schedulerConfig });
    const token = await driver.probe();
    expect(token).not.toBeNull();
    return token!;
  };

  const storeToken = async (token: string | null): Promise<void> => {
    const row = await sourceRow(fx.database.db, fx.sourceIds.get('probe')!);
    const config = { ...row.config };
    if (token === null) delete config[PROBE_TOKEN_KEY];
    else config[PROBE_TOKEN_KEY] = token;
    await fx.database.db.update(documentSources).set({ config }).where(eq(documentSources.id, row.id));
  };

  it('enqueues nothing when the token has not moved', async () => {
    const db = fx.database.db;
    await storeToken(await currentToken());
    await makeDue(db, fx.sourceIds.get('probe')!, 15);
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 1, enqueued: 0, failed: 0 });
    expect(enqueued).toEqual([]);
    // And it still advanced, exactly as it does when it decides to run.
    expect((await sourceRow(db, fx.sourceIds.get('probe')!)).nextSyncAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('enqueues when the token moved, in the scheduled lane', async () => {
    const db = fx.database.db;
    const root = fx.roots.get('probe')!;
    // The newest mtime moves, which is half of what the local probe is. Nothing is read or hashed to
    // find that out — that is the whole point of the token.
    const future = new Date(Date.now() + 120_000);
    await utimes(path.join(root, FILES[0]), future, future);
    await makeDue(db, fx.sourceIds.get('probe')!, 15);
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ considered: 1, probed: 1, unchanged: 0, enqueued: 1, failed: 0 });
    expect(enqueued).toEqual([{ projectId: fx.projectIds.get('probe'), trigger: 'scheduled' }]);
  });

  it('enqueues when there is no stored token at all, which is every source on its first schedule', async () => {
    const db = fx.database.db;
    await storeToken(null);
    await makeDue(db, fx.sourceIds.get('probe')!, 15);
    enqueued.length = 0;

    expect(await tick()).toMatchObject({ probed: 1, unchanged: 0, enqueued: 1, failed: 0 });
  });

  it('enqueues when the probe throws, because a probe is an optimisation and never a veto', async () => {
    const db = fx.database.db;
    const root = fx.roots.get('probe')!;
    // A stored token that matches nothing would be the *only* thing that could make this pass
    // vacuously, so the directory is taken away with the token still in place: the probe throws on
    // `resolveProjectRoot`, and the source is indexed anyway so that the run reports the real error.
    await storeToken('files=2;mtime=1');
    await rename(root, `${root}-moved`);
    await makeDue(db, fx.sourceIds.get('probe')!, 15);
    enqueued.length = 0;

    try {
      expect(await tick()).toMatchObject({ considered: 1, probed: 1, failed: 1, unchanged: 0, enqueued: 1 });
      expect(enqueued).toEqual([{ projectId: fx.projectIds.get('probe'), trigger: 'scheduled' }]);
    } finally {
      // Restored whatever the assertions did, so a failure here is one failure and not three.
      await rename(`${root}-moved`, root);
    }
  });

  it('caps the probes of one tick and leaves the rest due, oldest first', async () => {
    const db = fx.database.db;
    const sourceId = fx.sourceIds.get('probe')!;
    const projectId = fx.projectIds.get('probe')!;
    // A second and a third source on the same project, all three overdue, against a cap of one.
    const extra: string[] = [];
    for (const name of ['second', 'third']) {
      const row = await createSource(
        db,
        projectId,
        { type: 'local', name, config: { path: fx.roots.get('probe'), extensions: ['md'] } },
        {
          allowedRoots: fx.schedulerConfig.ALLOWED_DOC_ROOTS,
          keys: keyringOf(fx.schedulerConfig),
        },
      );
      extra.push(row.id);
    }
    // Minutes overdue. The **last** source added is the one that has been waiting longest, so a tick
    // that took them in insertion order rather than in due order would take the wrong one first.
    const ages = [2, 1, 3];
    for (const [i, id] of [sourceId, ...extra].entries()) {
      await db
        .update(documentSources)
        .set({ syncIntervalMinutes: 15, nextSyncAt: new Date(Date.now() - ages[i] * 60_000) })
        .where(eq(documentSources.id, id));
    }
    enqueued.length = 0;

    const capped = { ...fx.schedulerConfig, SYNC_PROBES_PER_TICK: 1 };
    const first = await runSyncTick({ db, indexer: recorder, log: silentLogger, config: capped });
    expect(first).toMatchObject({ due: 2, considered: 1, probed: 1 }); // `due` is capped+1: "there are more"
    // The one it took is the one that had been waiting longest, and it is the only one that moved.
    const stillPast = await db
      .select({ id: documentSources.id })
      .from(documentSources)
      .where(sql`${documentSources.nextSyncAt} <= now() and ${documentSources.projectId} = ${projectId}`);
    expect(stillPast.map((r) => r.id).sort()).toEqual([sourceId, extra[0]].sort());

    const second = await runSyncTick({ db, indexer: recorder, log: silentLogger, config: capped });
    expect(second).toMatchObject({ due: 2, considered: 1, probed: 1 });
    const third = await runSyncTick({ db, indexer: recorder, log: silentLogger, config: capped });
    expect(third).toMatchObject({ due: 1, considered: 1, probed: 1 });
    expect(await runSyncTick({ db, indexer: recorder, log: silentLogger, config: capped })).toMatchObject({ due: 0, considered: 0 });

    // Three sources of one project, and the collapse `Indexer.enqueue` already does means the queue
    // never saw three jobs — but these were three separate ticks, so it saw three calls.
    expect(new Set(enqueued.map((e) => e.projectId))).toEqual(new Set([projectId]));
    for (const id of extra) await db.delete(documentSources).where(eq(documentSources.id, id));
  });
});

describe('the migration that adds the columns', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(baseUrl, 'scheduler_upgrade');
  });

  afterAll(async () => {
    await dropTestDatabase(baseUrl, database);
  });

  it('leaves every source that already existed switched off', async () => {
    // A genuine pre-migration database: the frozen `0.1.0` DDL, which has no scheduling columns at all.
    await ensureSchema(database.db, { dimensions: DIMS, resetVectors: false, log: silentLogger });
    await database.db.execute(sql`
      INSERT INTO projects (name) VALUES ('upgraded');
      INSERT INTO document_sources (project_id, type, name, config)
      SELECT id, 'git', 'docs', '{"url":"https://example.invalid/repo.git","branch":"main"}'::jsonb FROM projects WHERE name = 'upgraded'`);

    // The upgrade itself.
    await bootstrapDatabase(database.db, { pool: database.pool, dimensions: DIMS, resetVectors: false, log: silentLogger });

    const [row] = await database.db.select().from(documentSources);
    // **NFR-10, as a row.** A git source carried forward from before this release makes no outbound
    // call until a person says so: NULL is "never scheduled", and nothing in the migration writes a
    // number over it — not the default, not a backfill.
    expect(row.syncIntervalMinutes).toBeNull();
    expect(row.nextSyncAt).toBeNull();

    // So the scheduler's own query finds nothing on an instance that has only upgraded sources.
    const due = await database.db.execute(sql`
      SELECT count(*)::int AS n FROM document_sources WHERE sync_interval_minutes IS NOT NULL`);
    expect((due.rows[0] as { n: number }).n).toBe(0);

    // A source created *after* the upgrade is scheduled only if the caller says so — `createSource`
    // itself defaults to off, and the instance default is applied one layer up, in the route.
    const [project] = await database.db.select({ id: projects.id }).from(projects);
    const unscheduled = await createSource(
      database.db,
      project.id,
      { type: 'upload', name: 'files' },
      { allowedRoots: [], keys: { current: '0'.repeat(64) } },
    );
    expect(unscheduled.syncIntervalMinutes).toBeNull();
    expect(unscheduled.nextSyncAt).toBeNull();

    const scheduled = await createSource(
      database.db,
      project.id,
      { type: 'upload', name: 'more', syncIntervalMinutes: 60 },
      { allowedRoots: [], keys: { current: '0'.repeat(64) } },
    );
    expect(scheduled.syncIntervalMinutes).toBe(60);
    // Jittered into the first interval at creation, never "right now".
    expect(scheduled.nextSyncAt!.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(scheduled.nextSyncAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
  }, 60_000);
});
