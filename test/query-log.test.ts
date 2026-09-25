import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { Logger } from '../src/context.js';
import type { SearchQueryInsert } from '../src/db/schema.js';
import { buildQueryLogRows, normalizeQuery, QueryLog, type QueryLogEntry } from '../src/services/query-log.js';

/**
 * The two claims [ADR-0047](../.ssot/ADR.md#adr-0047) makes about the write path that nothing else can
 * check: **a full buffer drops rather than backing up, and it counts what it dropped.**
 *
 * They are asserted here rather than against a real PostgreSQL on purpose. Saturation is a race — it
 * happens when rows arrive faster than they are written — and a real database that is fast enough to
 * keep up is a test that passes by never reaching the case. The database below is a database that
 * never finishes until the test says so, which makes the saturated state the *only* state, and the
 * counts exact rather than "at least".
 *
 * `test/integration/query-log.itest.ts` holds the other half: that the rows which do land say the
 * right things, against a real server.
 */

const silent: Logger = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => silent,
} as unknown as Logger;

const entry = (query: string): QueryLogEntry => ({
  projectId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  query,
  limit: 5,
  hits: [{ relativePath: 'handbook/install.md', headingPath: 'Install > Docker', chunkIndex: 2, score: 0.87 }],
  belowFloor: false,
  scoreFloor: 0.82,
  durationMs: 12,
  embeddingModel: 'local:multilingual-e5-small:fp32',
  liveGeneration: 3,
});

/**
 * A database whose writes are held open until the test releases them, so "the buffer is full" is a
 * state the test controls rather than one it hopes for.
 *
 * `values()` has to be both awaitable and `.returning()`-able, because the writer does one of each —
 * the query rows come back with their ids, the hit rows do not — and both spellings must reach the same
 * single execution, or a row would be recorded twice.
 */
function heldDatabase(mode: 'hold' | 'reject' = 'hold') {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: SearchQueryInsert[] = [];
  let batches = 0;
  let nextId = 0;

  const insert = (_table: unknown) => ({
    values: (rows: SearchQueryInsert[]) => {
      // A real promise with `returning` hung on it, rather than a hand-rolled thenable: the writer
      // awaits one statement directly and calls `.returning()` on the other, and both have to reach
      // the same single execution.
      const settled = (async () => {
        await gate;
        if (mode === 'reject') throw new Error('the database is not having it');
        // Only the query rows arrive with a `projectId`; the hit rows are the second statement.
        if (rows.length > 0 && 'projectId' in rows[0]) {
          batches++;
          written.push(...rows);
        }
        return rows.map(() => ({ id: `q${nextId++}` }));
      })();
      return Object.assign(settled, { returning: () => settled });
    },
  });

  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert }),
    // What `pruneProjectQueryLog` asks: the cut-off row, of which this database has none.
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            offset: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db;

  return { db, release, written, batches: () => batches };
}

describe('normalizeQuery', () => {
  it('folds the spellings of one question together without pretending to stem it', () => {
    expect(normalizeQuery('  How   do I Set  UP Docker? ')).toBe('how do i set up docker?');
    expect(normalizeQuery('HNSW_EF_SEARCH')).toBe('hnsw_ef_search');
    // NFKC, so a full-width or compatibility spelling groups with the ordinary one.
    expect(normalizeQuery('ＤＯＣＫＥＲ')).toBe('docker');
    expect(normalizeQuery('line\nbreak\tand   tabs')).toBe('line break and tabs');
  });

  it('keeps the punctuation, because the raw text is what a report has to quote', () => {
    expect(normalizeQuery('what does HLY-4019 mean?')).toBe('what does hly-4019 mean?');
  });
});

describe('buildQueryLogRows', () => {
  it('carries the encoder and the generation, which are the columns that make the log comparable', () => {
    const { query, hits } = buildQueryLogRows(entry('Where is the Docker guide?'), 'mcp', 'token-1');
    expect(query.embeddingModel).toBe('local:multilingual-e5-small:fp32');
    expect(query.liveGeneration).toBe(3);
    expect(query.actor).toBe('mcp');
    expect(query.mcpTokenId).toBe('token-1');
    expect(query.queryNorm).toBe('where is the docker guide?');
    expect(query.hitCount).toBe(1);
    expect(query.topScore).toBe(0.87);
    // The floor it was decided against travels with the verdict, so a window spanning a change can be split.
    expect(query.scoreFloor).toBe(0.82);
    expect(hits).toEqual([{ rank: 1, relativePath: 'handbook/install.md', headingPath: 'Install > Docker', chunkIndex: 2, score: 0.87 }]);
  });

  it('leaves the top score NULL when nothing came back, because 0 is a score a hit could have had', () => {
    const { query, hits } = buildQueryLogRows({ ...entry('nothing at all'), hits: [] }, 'dashboard', null);
    expect(query.topScore).toBeNull();
    expect(query.hitCount).toBe(0);
    expect(query.actor).toBe('dashboard');
    expect(query.mcpTokenId).toBeNull();
    expect(hits).toEqual([]);
  });

  it('ranks the hits in the order the caller saw them', () => {
    const three = {
      ...entry('ranked'),
      hits: [0.9, 0.8, 0.7].map((score, i) => ({ relativePath: `p${i}.md`, headingPath: '', chunkIndex: i, score })),
    };
    expect(buildQueryLogRows(three, 'mcp', null).hits.map((h) => [h.rank, h.score])).toEqual([
      [1, 0.9],
      [2, 0.8],
      [3, 0.7],
    ]);
    expect(buildQueryLogRows(three, 'mcp', null).query.topScore).toBe(0.9);
  });

  it('bounds the stored text at the tool’s own limit rather than trusting the caller', () => {
    const long = buildQueryLogRows({ ...entry('x'.repeat(5_000)), hits: [] }, 'mcp', null);
    expect(long.query.query).toHaveLength(2_000);
    expect(long.query.queryNorm).toHaveLength(2_000);
  });
});

describe('a saturated buffer', () => {
  it('drops rather than blocking, and counts every drop', async () => {
    const database = heldDatabase();
    const log = new QueryLog(database.db, silent, { capacity: 3 });
    const sink = log.for('mcp', null);

    // Ten records in one synchronous loop, against a database that has not finished a single write.
    // If `record()` waited for anything at all, this loop could not complete.
    for (let i = 0; i < 10; i++) sink.record(entry(`question ${i}`));

    expect(database.batches()).toBe(0); // nothing has been written: the database is still held
    expect(log.stats()).toMatchObject({ accepted: 3, dropped: 7, failed: 0, written: 0 });
    // The buffer is the capacity and not a row more — this is the claim, stated as a number.
    expect(log.stats().pending).toBeLessThanOrEqual(3);

    database.release();
    await log.flush();

    expect(log.stats()).toMatchObject({ accepted: 3, dropped: 7, failed: 0, written: 3 });
    expect(database.written.map((row) => row.query)).toEqual(['question 0', 'question 1', 'question 2']);
  });

  it('keeps accepting again once the buffer has drained', async () => {
    const database = heldDatabase();
    const log = new QueryLog(database.db, silent, { capacity: 2 });
    const sink = log.for('dashboard');

    for (let i = 0; i < 5; i++) sink.record(entry(`first ${i}`));
    expect(log.stats().dropped).toBe(3);

    database.release();
    await log.flush();

    sink.record(entry('after the drain'));
    await log.flush();
    expect(log.stats()).toMatchObject({ dropped: 3, written: 3 });
    expect(database.written.at(-1)?.query).toBe('after the drain');
  });
});

describe('a database that refuses the write', () => {
  it('loses the rows and says so, and never reaches the caller', async () => {
    const database = heldDatabase('reject');
    const log = new QueryLog(database.db, silent, { capacity: 10 });

    // The whole point: `record()` returns nothing to await, so a failing write cannot be a failing
    // search. The rejection is counted as `failed` rather than retried — a database that refuses this
    // write will refuse the retry, and a retry loop is how a log outage becomes an outage.
    expect(() => log.for('mcp', null).record(entry('will not land'))).not.toThrow();

    database.release();
    await log.flush();
    expect(log.stats()).toMatchObject({ accepted: 1, written: 0, dropped: 0, failed: 1 });
  });
});

describe('a closed log', () => {
  it('writes what it holds and accepts nothing after', async () => {
    const database = heldDatabase();
    const log = new QueryLog(database.db, silent);
    log.for('mcp', null).record(entry('before the close'));

    database.release();
    await log.close();
    expect(log.stats().written).toBe(1);

    log.for('mcp', null).record(entry('after the close'));
    await log.flush();
    expect(log.stats()).toMatchObject({ accepted: 1, written: 1, dropped: 0 });
  });
});
