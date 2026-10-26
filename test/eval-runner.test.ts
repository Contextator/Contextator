import { describe, expect, it, vi } from 'vitest';

import type { EmbeddingProvider } from '../src/services/embeddings/provider.js';
import { EvalRunner } from '../src/services/eval-runs.js';

/**
 * What a run does when the world moves under it, with the database stubbed: the golden set read as
 * non-empty when a manager's request was accepted and empty when the run reached it. The real database
 * cannot be made to do that on time, and the property is only about what the runner writes.
 */

const state = { questionReads: 0 };

vi.mock('../src/services/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/projects.js')>()),
  getProjectById: async () => ({ id: 'p1', liveGeneration: 3, embeddingModel: 'm', chunkCount: 5 }),
}));

vi.mock('../src/services/golden-questions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/golden-questions.js')>()),
  // The first read is the request's own check, the second is the run's.
  listGoldenQuestions: async () => (state.questionReads++ === 0 ? [{ key: 'q' }] : []),
}));

const embeddings = { id: 'm' } as EmbeddingProvider;

function runnerWith(inserted: Array<Record<string, unknown>>): EvalRunner {
  const tx = { insert: () => ({ values: async (v: Record<string, unknown>) => void inserted.push(v) }), execute: async () => undefined };
  const db = { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) };
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  return new EvalRunner({
    db: db as never,
    embeddings,
    scan: { efSearch: 100, iterativeScan: 'relaxed_order', maxScanTuples: 20_000 },
    selection: { maxPerDocument: 2, neighborContext: 1 },
    log: log as never,
  });
}

describe('a manual run whose golden set was emptied after it was accepted', () => {
  it('writes an error row under the id it answered with, so the id is never left dangling', async () => {
    state.questionReads = 0;
    const inserted: Array<Record<string, unknown>> = [];
    const runner = runnerWith(inserted);
    const outcome = await runner.requestManual('p1');
    expect(outcome.status).toBe('started');
    await runner.settled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      id: (outcome as { runId: string }).runId,
      trigger: 'manual',
      status: 'error',
      questionCount: 0,
      scoredCount: 0,
      generation: 3,
    });
    expect(String(inserted[0].error)).toMatch(/emptied/);
  });

  it('writes nothing for an automatic trigger, which has no id to keep', async () => {
    state.questionReads = 1;
    const inserted: Array<Record<string, unknown>> = [];
    const runner = runnerWith(inserted);
    runner.request('p1', 'index_rebuild');
    await runner.settled();
    expect(inserted).toHaveLength(0);
  });
});
