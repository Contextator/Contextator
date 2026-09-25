import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { documents, mcpTokens, projects, searchQueries, searchQueryHits } from '../../src/db/schema.js';
import { buildExport } from '../../src/services/query-export.js';
import {
  type SummaryActor,
  type SummaryScope,
  listQueryConfigurations,
  mostReturnedChunks,
  neverReturnedDocuments,
  oldestLoggedQuery,
  previewScoreFloor,
  purgeProjectQueryLog,
  rankQuestionsByGap,
  repeatedQuestions,
  setQueryLogEnabled,
  volumeOverTime,
} from '../../src/services/query-summary.js';
import { applySchema, createTestDatabase, dropTestDatabase, TEST_EMBEDDING_DIMENSIONS, type TestDatabase } from './support/postgres.js';

/**
 * The read side of the query log ([ADR-0050](../../../.ssot/ADR.md#adr-0050)), against real rows in a
 * real PostgreSQL.
 *
 * The seed below is not arbitrary. It is **the case the panel exists for**, built so that a figure
 * computed the obvious wrong way comes out visibly wrong:
 *
 * - one question asked 41 times whose best match never rose above 0.841, sitting in the same window as
 *   a question asked once that scored 0.312 — a ranking that read the score alone inverts exactly that
 *   pair, and a ranking that read the count alone cannot separate the 41 from the well-answered 7;
 * - a near-duplicate of that question, three askings of it, which must stay its **own** row, because a
 *   panel that silently merged two questions the operator considers different would be worse than one
 *   that lists them twice;
 * - ten more searches of the same question answered at 0.99 by a **different embedding model and a
 *   different generation**, which every figure must ignore — if scoping broke, the count becomes 51
 *   and the best match 0.99, both loudly wrong;
 * - four dashboard searches of it, which the default actor must ignore for the same reason
 *   [OPERATIONS.md](../../../.ssot/OPERATIONS.md) §6.1 tells an operator to write `actor = 'mcp'`;
 * - five searches of the same model and generation decided against **other floors** — three at 0.77
 *   and two logged before the floor was recorded — which every figure scoped to 0.82 must ignore, and
 *   which the floor preview, whose question does not depend on the floor, must count;
 * - a document indexed thirty days ago that nothing ever returned, **and** one indexed half an hour
 *   ago that nothing ever returned, so that the figure has to tell "nobody can find this" from "this
 *   did not exist yet".
 */

const baseUrl = inject('postgresBaseUrl');
const DIMS = TEST_EMBEDDING_DIMENSIONS;

const MODEL_A = 'local:stub-a:fp32';
const MODEL_B = 'local:stub-b:fp32';
const LIVE = 0;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let database: TestDatabase;
let db: Db;
let projectId: string;
let tokenIds: string[];
/** Fixed once, so every seeded timestamp and every window below is relative to the same instant. */
const NOW = Date.now();
const ago = (ms: number): Date => new Date(NOW - ms);

interface Seed {
  query: string;
  createdAt: Date;
  actor: 'mcp' | 'dashboard';
  model: string;
  generation: number;
  tokenIndex: number | null;
  /** The floor the search was decided against; `null` for a row logged before it was recorded. Default 0.82. */
  floor?: number | null;
  /** `[path, chunkIndex, heading, score]` in the order the caller received them. */
  hits: [string, number, string, number][];
}

const ROTATE = 'How do I rotate the webhook secret?';
/** The same question with different spacing and case: `query_norm` folds it, so it is the same row. */
const ROTATE_SHOUTED = '  How do I ROTATE the   webhook   secret?  ';
const NEAR_DUPLICATE = 'How do I rotate webhook secrets?';
const SAML = 'How do I configure SAML?';
const DEPLOY = 'How do I deploy to Kubernetes?';
const SWALLOW = 'What is the airspeed of an unladen swallow?';
const REFUND = 'How do I request a refund?';
const CHANGELOG = 'Where is the changelog?';
const FLOOR = 0.82;

const webhooksHit = (score: number): [string, number, string, number][] => [['handbook/webhooks.md', 0, 'Webhooks > Rotating the secret', score]];
const oidcHit = (score: number): [string, number, string, number][] => [['handbook/oidc.md', 1, 'Single sign-on > OIDC', score]];
/**
 * A different chunk of the same page, returned once and scored badly — so that "returned most often"
 * and "scored best on average" order the three chunks *differently*, and a figure that quietly sorted
 * on the score cannot pass by accident.
 */
const oidcTailHit = (score: number): [string, number, string, number][] => [['handbook/oidc.md', 3, 'Single sign-on > Troubleshooting', score]];
const tokensHit = (score: number): [string, number, string, number][] => [['handbook/tokens.md', 0, 'Tokens', score]];

function seedRows(): Seed[] {
  const rows: Seed[] = [];
  // 41 askings of one question, spread over six UTC days and three tokens, best match never above
  // 0.841. One of them is typed with different case and spacing, which must fold into the same group.
  for (let i = 0; i < 41; i++) {
    rows.push({
      query: i === 7 ? ROTATE_SHOUTED : ROTATE,
      createdAt: ago((i % 6) * DAY + 6 * HOUR),
      actor: 'mcp',
      model: MODEL_A,
      generation: LIVE,
      tokenIndex: i % 3,
      // Five of the forty-one also returned a second document, lower down. It is what makes the
      // order of `paths` — and therefore of the documents the export offers a person to choose from —
      // a claim about how often each was returned rather than about which scored best.
      hits: i < 5 ? [...webhooksHit(0.841 - i * 0.002), ...tokensHit(0.8)] : webhooksHit(0.841 - (i % 5) * 0.002),
    });
  }
  // Answered better, and asked less. It must not outrank the 41.
  for (let i = 0; i < 7; i++) {
    rows.push({
      query: SAML,
      createdAt: ago(2 * DAY + i * HOUR),
      actor: 'mcp',
      model: MODEL_A,
      generation: LIVE,
      tokenIndex: 0,
      hits: oidcHit(0.863),
    });
  }
  // Three askings of a question a clusterer would merge into the 41. It stays its own row.
  for (let i = 0; i < 3; i++) {
    rows.push({
      query: NEAR_DUPLICATE,
      createdAt: ago(1 * DAY + i * HOUR),
      actor: 'mcp',
      model: MODEL_A,
      generation: LIVE,
      tokenIndex: 1,
      hits: webhooksHit(0.838),
    });
  }
  // Two askings that returned nothing at all, and the only two searches newer than the document
  // seeded half an hour ago — which is what makes the never-returned count say `0 of 2` for it.
  rows.push({ query: DEPLOY, createdAt: ago(10 * MINUTE), actor: 'mcp', model: MODEL_A, generation: LIVE, tokenIndex: 2, hits: [] });
  rows.push({ query: DEPLOY, createdAt: ago(5 * MINUTE), actor: 'mcp', model: MODEL_A, generation: LIVE, tokenIndex: 2, hits: [] });
  // Asked once, answered terribly. The row a score-only ranking would put at the top.
  rows.push({ query: SWALLOW, createdAt: ago(3 * DAY), actor: 'mcp', model: MODEL_A, generation: LIVE, tokenIndex: 0, hits: oidcTailHit(0.312) });

  // Ten searches of the same question at 0.99, answered by another model and by another generation.
  for (let i = 0; i < 5; i++) {
    rows.push({ query: ROTATE, createdAt: ago(1 * DAY), actor: 'mcp', model: MODEL_B, generation: LIVE, tokenIndex: 0, hits: webhooksHit(0.99) });
    rows.push({ query: ROTATE, createdAt: ago(1 * DAY), actor: 'mcp', model: MODEL_A, generation: LIVE + 1, tokenIndex: 0, hits: webhooksHit(0.99) });
  }
  // And four of the operator's own, which `actor = 'mcp'` must not read back to them.
  for (let i = 0; i < 4; i++) {
    rows.push({
      query: ROTATE,
      createdAt: ago(1 * DAY),
      actor: 'dashboard',
      model: MODEL_A,
      generation: LIVE,
      tokenIndex: null,
      hits: webhooksHit(0.95),
    });
  }

  // Three searches decided against a lower floor, and answered at it — and returning the one page the
  // 0.82 configuration never returned, so that a figure that dropped the floor from its predicate
  // would stop calling that page unreturned.
  for (let i = 0; i < 3; i++) {
    rows.push({
      query: REFUND,
      createdAt: ago(2 * DAY),
      actor: 'mcp',
      model: MODEL_A,
      generation: LIVE,
      tokenIndex: 0,
      floor: 0.77,
      hits: [['handbook/attic.md', 0, 'The attic', 0.79]],
    });
  }
  // Two from before the floor was recorded: their own configuration, guessed into neither side.
  for (let i = 0; i < 2; i++) {
    rows.push({
      query: CHANGELOG,
      createdAt: ago(4 * DAY),
      actor: 'mcp',
      model: MODEL_A,
      generation: LIVE,
      tokenIndex: 1,
      floor: null,
      hits: oidcHit(0.8),
    });
  }
  return rows;
}

/** The 54 `mcp` searches of the live configuration: every figure below is a figure over these. */
const IN_SCOPE = 54;
/** The same model and generation at another floor, or none recorded. */
const OTHER_FLOORS = 5;

const scope = (over: Partial<SummaryScope> = {}): SummaryScope => ({
  projectId,
  from: ago(7 * DAY),
  to: new Date(NOW + MINUTE),
  actor: 'mcp',
  embeddingModel: MODEL_A,
  liveGeneration: LIVE,
  scoreFloor: FLOOR,
  ...over,
});

beforeAll(async () => {
  database = await createTestDatabase(baseUrl, 'query_summary');
  await applySchema(database, DIMS);
  db = database.db;

  const [project] = await db
    .insert(projects)
    .values({ name: 'handbook', embeddingModel: MODEL_A, liveGeneration: LIVE })
    .returning({ id: projects.id });
  projectId = project.id;

  const tokens = await db
    .insert(mcpTokens)
    .values([0, 1, 2].map((i) => ({ projectId, name: `agent-${i}`, tokenHash: `hash-${i}`, prefix: `ctxm_${i}…` })))
    .returning({ id: mcpTokens.id });
  tokenIds = tokens.map((t) => t.id);

  await db.insert(documents).values([
    { projectId, relativePath: 'handbook/webhooks.md', title: 'Webhooks', contentHash: 'h1', indexGeneration: LIVE, indexedAt: ago(30 * DAY) },
    { projectId, relativePath: 'handbook/oidc.md', title: 'Single sign-on', contentHash: 'h2', indexGeneration: LIVE, indexedAt: ago(30 * DAY) },
    // Nothing ever returned it, and it has been there the whole time. This is the real finding.
    { projectId, relativePath: 'handbook/tokens.md', title: 'Tokens', contentHash: 'h3', indexGeneration: LIVE, indexedAt: ago(30 * DAY) },
    { projectId, relativePath: 'handbook/attic.md', title: 'The attic', contentHash: 'h6', indexGeneration: LIVE, indexedAt: ago(30 * DAY) },
    // Nothing ever returned it either — because it did not exist until half an hour ago.
    {
      projectId,
      relativePath: 'handbook/brand-new.md',
      title: 'Written today',
      contentHash: 'h4',
      indexGeneration: LIVE,
      indexedAt: ago(30 * MINUTE),
    },
    // A document of the *other* generation ([ADR-0039](../../../.ssot/ADR.md#adr-0039)): a rebuild
    // writes one beside the live index. Nothing about generation 0 may ever mention it, and nothing
    // about generation 1 may mention the four above.
    { projectId, relativePath: 'handbook/next-gen.md', title: 'The rebuild', contentHash: 'h5', indexGeneration: LIVE + 1, indexedAt: ago(30 * DAY) },
  ]);

  for (const row of seedRows()) {
    const [inserted] = await db
      .insert(searchQueries)
      .values({
        projectId,
        createdAt: row.createdAt,
        actor: row.actor,
        mcpTokenId: row.tokenIndex === null ? null : tokenIds[row.tokenIndex],
        query: row.query,
        queryNorm: row.query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
        resultLimit: 5,
        hitCount: row.hits.length,
        topScore: row.hits.length > 0 ? row.hits[0][3] : null,
        belowFloor: false,
        scoreFloor: row.floor === undefined ? FLOOR : row.floor,
        durationMs: 12,
        embeddingModel: row.model,
        liveGeneration: row.generation,
      })
      .returning({ id: searchQueries.id });
    if (row.hits.length > 0) {
      await db.insert(searchQueryHits).values(
        row.hits.map(([relativePath, chunkIndex, headingPath, score], i) => ({
          queryId: inserted.id,
          rank: i + 1,
          relativePath,
          headingPath,
          chunkIndex,
          score,
        })),
      );
    }
  }
}, 180_000);

afterAll(async () => {
  await dropTestDatabase(baseUrl, database);
});

describe('the questions, ranked rather than classified', () => {
  it('puts the question asked 41 times at a passing score above the one-off with a terrible one', async () => {
    const rows = await repeatedQuestions(db, scope(), 20);
    const order = rows.map((r) => r.queryNorm);
    expect(order[0]).toBe('how do i rotate the webhook secret?');
    expect(order.indexOf('how do i rotate the webhook secret?')).toBeLessThan(order.indexOf('what is the airspeed of an unladen swallow?'));
    // And above the question that *was* answered well, which a count-only ordering would tie with it
    // and a score-only ordering would put first.
    expect(order.indexOf('how do i rotate the webhook secret?')).toBeLessThan(order.indexOf('how do i configure saml?'));
  });

  it('produces exactly the ordering the specification produces for the same groups', async () => {
    const rows = await repeatedQuestions(db, scope(), 20);
    const fromSpec = rankQuestionsByGap(rows.map((r) => ({ queryNorm: r.queryNorm, asked: r.asked, bestScore: r.bestScore })));
    expect(rows.map((r) => r.queryNorm)).toEqual(fromSpec.map((r) => r.queryNorm));
    // Stated as a literal too, so that a change to both halves at once still has to be argued.
    expect(rows.map((r) => r.queryNorm)).toEqual([
      'how do i rotate the webhook secret?',
      'how do i deploy to kubernetes?',
      'how do i rotate webhook secrets?',
      'how do i configure saml?',
      'what is the airspeed of an unladen swallow?',
    ]);
  });

  it('folds two spellings of one question together and leaves a near-duplicate alone', async () => {
    const rows = await repeatedQuestions(db, scope(), 20);
    const rotate = rows.find((r) => r.queryNorm === 'how do i rotate the webhook secret?');
    // 41 and not 40: the shouted, over-spaced spelling is the same question.
    expect(rotate?.asked).toBe(41);
    // 3 and not folded into the 41: nothing here clusters, because no threshold could be defended.
    expect(rows.find((r) => r.queryNorm === 'how do i rotate webhook secrets?')?.asked).toBe(3);
  });

  it('reports how widely the asking is spread, so a client in a loop is visible as one', async () => {
    const rotate = (await repeatedQuestions(db, scope(), 20)).find((r) => r.queryNorm === 'how do i rotate the webhook secret?');
    expect(rotate?.askers).toBe(3);
    expect(rotate?.days).toBe(6);
    expect(rotate?.unattributed).toBe(0);
  });

  it('keeps the best match the corpus ever managed, and the documents it kept handing back', async () => {
    const rotate = (await repeatedQuestions(db, scope(), 20)).find((r) => r.queryNorm === 'how do i rotate the webhook secret?');
    expect(rotate?.bestScore).toBeCloseTo(0.841, 6);
    expect(rotate?.paths[0]).toMatchObject({ relativePath: 'handbook/webhooks.md', returned: 41 });
    // Ordered by how often each document came back, not by which scored best — the second one scored
    // 0.800 against the first's 0.841 and would lead a score-ordered list.
    expect(rotate?.paths.map((p) => p.relativePath)).toEqual(['handbook/webhooks.md', 'handbook/tokens.md']);
  });

  it('ranks a question that returned nothing at all as the worst-answered rather than as a middling one', async () => {
    const deploy = (await repeatedQuestions(db, scope(), 20)).find((r) => r.queryNorm === 'how do i deploy to kubernetes?');
    expect(deploy?.bestScore).toBeNull();
    expect(deploy?.scoreRank).toBe(1);
  });

  it('keeps the one-off question in the list instead of cutting it off', async () => {
    const rows = await repeatedQuestions(db, scope(), 20);
    // OPERATIONS §6.1's `HAVING count(*) >= 3` would have deleted two of these five groups.
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.asked === 1)).toBe(true);
  });
});

describe('one retrieval configuration at a time', () => {
  it('ignores the searches another model and another generation answered', async () => {
    const rotate = (await repeatedQuestions(db, scope(), 20)).find((r) => r.queryNorm === 'how do i rotate the webhook secret?');
    // 51 and 0.99 are what this row would say if either column were dropped from the predicate.
    expect(rotate?.asked).toBe(41);
    expect(rotate?.bestScore).toBeLessThan(0.9);
  });

  it('lists every configuration in the window, biggest first, so the panel can name the one it shows', async () => {
    const configurations = await listQueryConfigurations(db, projectId, ago(7 * DAY), new Date(NOW + MINUTE), 'mcp');
    expect(configurations[0]).toMatchObject({ embeddingModel: MODEL_A, liveGeneration: LIVE, scoreFloor: FLOOR, queries: IN_SCOPE });
    expect(configurations.map((c) => `${c.embeddingModel}@${c.liveGeneration}@${c.scoreFloor}`).sort()).toEqual([
      `${MODEL_A}@0@0.77`,
      `${MODEL_A}@0@0.82`,
      `${MODEL_A}@0@null`,
      `${MODEL_A}@1@0.82`,
      `${MODEL_B}@0@0.82`,
    ]);
    expect(configurations.reduce((n, c) => n + c.queries, 0)).toBe(IN_SCOPE + 10 + OTHER_FLOORS);
  });

  it('keeps a window that spans a change of floor as two configurations, and the unrecorded rows as a third', async () => {
    // At 0.82 the three refund searches are not there: `below_floor` there meant something else.
    expect((await repeatedQuestions(db, scope(), 20)).map((r) => r.queryNorm)).not.toContain('how do i request a refund?');
    const lower = await repeatedQuestions(db, scope({ scoreFloor: 0.77 }), 20);
    expect(lower.map((r) => [r.queryNorm, r.asked])).toEqual([['how do i request a refund?', 3]]);
    const unrecorded = await repeatedQuestions(db, scope({ scoreFloor: null }), 20);
    expect(unrecorded.map((r) => [r.queryNorm, r.asked])).toEqual([['where is the changelog?', 2]]);
    // And every figure carries the floor, not only the question list.
    expect((await volumeOverTime(db, scope({ scoreFloor: 0.77 }))).reduce((n, b) => n + b.searches, 0)).toBe(3);
    expect((await mostReturnedChunks(db, scope({ scoreFloor: 0.77 }), 20)).map((c) => c.relativePath)).toEqual(['handbook/attic.md']);
  });

  it('reads the operator’s own dashboard searches back only when asked to', async () => {
    const asAgents = await repeatedQuestions(db, scope(), 20);
    const asBoth = await repeatedQuestions(db, scope({ actor: 'all' as SummaryActor }), 20);
    expect(asAgents.find((r) => r.queryNorm === 'how do i rotate the webhook secret?')?.asked).toBe(41);
    expect(asBoth.find((r) => r.queryNorm === 'how do i rotate the webhook secret?')?.asked).toBe(45);
    // The four dashboard rows carry no token, which is how the panel can say so.
    expect(asBoth.find((r) => r.queryNorm === 'how do i rotate the webhook secret?')?.unattributed).toBe(4);
  });
});

describe('the documents nothing ever returned', () => {
  it('counts only the searches that ran after each document was indexed', async () => {
    const never = await neverReturnedDocuments(db, scope(), 20);
    expect(never.documentsInGeneration).toBe(5);
    expect(never.rows.map((r) => r.relativePath)).toEqual(['handbook/attic.md', 'handbook/brand-new.md']);
    // The finding: nothing returned it across every search in the window.
    expect(never.rows[0].searchesSince).toBe(IN_SCOPE);
    // And the trap: this one has not been returned because it did not exist. Two searches have run
    // since it was indexed, and the panel says `0 of 2` rather than calling it a failure.
    expect(never.rows[1].searchesSince).toBe(2);
  });

  it('leaves out the documents that were returned', async () => {
    const never = await neverReturnedDocuments(db, scope(), 20);
    expect(never.rows.map((r) => r.relativePath)).not.toContain('handbook/webhooks.md');
    expect(never.rows.map((r) => r.relativePath)).not.toContain('handbook/oidc.md');
  });

  /**
   * A generation a rebuild superseded has had its documents reclaimed ([ADR-0039](../../../.ssot/ADR.md#adr-0039)),
   * so "never returned" cannot be asked of it. An empty list would read as "everything was returned",
   * which is the opposite of the truth, so the count is reported beside the list.
   */
  it('says the generation is gone rather than reporting that every document was returned', async () => {
    const never = await neverReturnedDocuments(db, scope({ liveGeneration: LIVE + 2 }), 20);
    expect(never.documentsInGeneration).toBe(0);
    expect(never.rows).toEqual([]);
  });

  /**
   * The other half of the same rule: while a rebuild is in flight two generations hold documents at
   * once, and each one's figure has to be about its own documents. A generation filter that had been
   * pinned to the live one would answer both questions with the live generation's pages.
   */
  it('asks the question of the documents of the generation being looked at', async () => {
    const live = await neverReturnedDocuments(db, scope(), 20);
    expect(live.rows.map((r) => r.relativePath)).not.toContain('handbook/next-gen.md');

    const rebuilt = await neverReturnedDocuments(db, scope({ liveGeneration: LIVE + 1 }), 20);
    expect(rebuilt.documentsInGeneration).toBe(1);
    // The five searches the rebuilt generation answered all returned `handbook/webhooks.md`, which is
    // not one of its documents — so its one page was never returned, out of those five.
    expect(rebuilt.rows).toEqual([expect.objectContaining({ relativePath: 'handbook/next-gen.md', searchesSince: 5 })]);
  });
});

describe('the excerpts agents are handed, and the volume behind them', () => {
  it('counts the most-returned chunk over the scoped rows only', async () => {
    const chunks = await mostReturnedChunks(db, scope(), 20);
    expect(chunks[0]).toMatchObject({ relativePath: 'handbook/webhooks.md', chunkIndex: 0, returned: 44, bestRank: 1 });
    // Most-returned, not best-scoring: the OIDC chunk below has the higher mean score and a fortieth
    // of the returns, so a figure that sorted on the score would put it first.
    expect(chunks.map((c) => `${c.relativePath}#${c.chunkIndex}`)).toEqual([
      'handbook/webhooks.md#0',
      'handbook/oidc.md#1',
      'handbook/tokens.md#0',
      'handbook/oidc.md#3',
    ]);
    expect(chunks[1].avgScore).toBeGreaterThan(chunks[0].avgScore);
    expect(chunks[1].returned).toBe(7);
  });

  it('draws every day of the window, including the ones nothing was asked on', async () => {
    const volume = await volumeOverTime(db, scope());
    expect(volume).toHaveLength(8);
    expect(volume.reduce((n, b) => n + b.searches, 0)).toBe(IN_SCOPE);
    // A silent day is a row of zero and not an absent row: a week with two silent days is a different
    // week from a five-day one, and a chart drawn from present rows only cannot tell them apart.
    expect(volume.some((b) => b.searches === 0)).toBe(true);
    for (const bucket of volume) expect(bucket.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The two askings that returned nothing are counted as such, on the day they happened.
    expect(volume.reduce((n, b) => n + b.empty, 0)).toBe(2);
  });

  it('knows how far back the log actually reaches', async () => {
    const oldest = await oldestLoggedQuery(db, projectId);
    expect(new Date(oldest ?? 0).getTime()).toBeLessThanOrEqual(NOW - 5 * DAY);
  });
});

describe('the export an operator runs against their own corpus', () => {
  it('writes the panel’s own ordering, with what the search returned beside each question', async () => {
    const rows = buildExport(await repeatedQuestions(db, scope(), 20));
    expect(rows[0].query).toBe(ROTATE);
    expect(rows[0].note).toContain('Asked 41x by 3 tokens on 6 days');
    expect(rows[0].note).toContain('handbook/webhooks.md > Webhooks > Rotating the secret');
    expect(rows[0].note).toContain('"expectFile"');
    // Every question is exported, in the order the panel argued for.
    expect(rows).toHaveLength(5);
  });
});

/**
 * What a floor would cost, read off the log before it is set. Across the floors the window holds — the
 * best score does not depend on the floor — and within one model and generation.
 *
 * The 57 searches of `MODEL_A` generation 0 that returned anything: 41 of the rotate question between
 * 0.833 and 0.841 (nine of them at 0.841), 7 at 0.863, 3 at 0.838, one at 0.312, three at 0.79 and two
 * at 0.80.
 */
describe('the price of a floor, before it is set', () => {
  const window = () => ({
    projectId,
    from: ago(7 * DAY),
    to: new Date(NOW + MINUTE),
    actor: 'mcp' as SummaryActor,
    embeddingModel: MODEL_A,
    liveGeneration: LIVE,
  });

  it('counts the searches a lower floor would answer, and names them', async () => {
    const preview = await previewScoreFloor(db, window(), 0.82, 0.78);
    expect(preview).toMatchObject({ searches: 57, refusedAtCurrent: 6, refusedAtProposed: 1, gained: 5, lost: 0 });
    expect(preview.gainedSamples.map((s) => [s.query, s.asked])).toEqual([
      [REFUND, 3],
      [CHANGELOG, 2],
    ]);
    expect(preview.lostSamples).toEqual([]);
  });

  it('counts the searches a higher floor would refuse, and names them', async () => {
    const preview = await previewScoreFloor(db, window(), 0.82, 0.84);
    expect(preview).toMatchObject({ searches: 57, refusedAtCurrent: 6, refusedAtProposed: 41, gained: 0, lost: 35 });
    expect(preview.lostSamples.map((s) => [s.query, s.asked])).toEqual([
      [ROTATE, 32],
      [NEAR_DUPLICATE, 3],
    ]);
    expect(preview.lostSamples[0].topScore).toBeCloseTo(0.839, 6);
  });

  it('treats a floor of 0 as refusing nothing, whatever the scores', async () => {
    expect(await previewScoreFloor(db, window(), 0, 0.78)).toMatchObject({ refusedAtCurrent: 0, refusedAtProposed: 1, gained: 0, lost: 1 });
    expect(await previewScoreFloor(db, window(), 0.82, 0)).toMatchObject({ refusedAtProposed: 0, gained: 6, lost: 0 });
  });

  it('does not pool another model or another generation', async () => {
    expect((await previewScoreFloor(db, { ...window(), embeddingModel: MODEL_B }, 0.82, 0.78)).searches).toBe(5);
    expect((await previewScoreFloor(db, { ...window(), liveGeneration: LIVE + 1 }, 0.82, 0.78)).searches).toBe(5);
  });
});

/** Last, because it empties the table the tests above read. */
describe('the manager’s two controls', () => {
  it('switches the recording off without deleting anything, and then deletes everything', async () => {
    expect(await setQueryLogEnabled(db, projectId, false)).toBe(false);
    const [project] = await db.select({ enabled: projects.queryLogEnabled }).from(projects).where(eq(projects.id, projectId));
    expect(project.enabled).toBe(false);
    // The switch deletes nothing — the sentence OPERATIONS §5.17 gives an operator holding `psql`.
    expect((await repeatedQuestions(db, scope(), 20)).length).toBe(5);

    const deleted = await purgeProjectQueryLog(db, projectId);
    expect(deleted).toBe(IN_SCOPE + 10 + 4 + OTHER_FLOORS);
    expect(await repeatedQuestions(db, scope(), 20)).toEqual([]);
    // The hits went with them, through the cascade rather than through a second statement.
    expect(await db.select().from(searchQueryHits)).toEqual([]);
  });
});
