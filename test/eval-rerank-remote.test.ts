import { describe, expect, it } from 'vitest';

import { createRemoteReranker, formatGate, judgeRerankGate, parseRerankResponse, parseRerankUrl, percentile } from '../scripts/eval-rerank-remote.js';
import type { Report, RowResult } from '../src/services/eval-scoring.js';

/**
 * The remote-rerank arm of the eval harness and its gate. The client has to be unable to hand the search a
 * ranking it did not get from the server: a response that scores some passage twice, or not at all, or
 * answers out of order and is read in order, is exactly the silent failure this arm would be blamed for.
 */

describe('parseRerankUrl', () => {
  it('accepts the server base or its /rerank endpoint', () => {
    expect(parseRerankUrl('http://127.0.0.1:8089').href).toBe('http://127.0.0.1:8089/');
    expect(parseRerankUrl('http://127.0.0.1:8089/').href).toBe('http://127.0.0.1:8089/');
    expect(parseRerankUrl('http://host/rerank').href).toBe('http://host/');
    expect(parseRerankUrl('https://host/prefix/rerank/').href).toBe('https://host/prefix');
  });

  it('refuses anything that is not http or https', () => {
    expect(() => parseRerankUrl('ftp://host')).toThrow(/http or https/);
    expect(() => parseRerankUrl('host:8089')).toThrow(/http or https|not a URL/);
  });
});

describe('parseRerankResponse', () => {
  it('puts each score back at the position it was sent from, whatever order the server answered in', () => {
    const body = [
      { index: 2, score: 9.5 },
      { index: 0, score: 1.25 },
      { index: 1, score: -3 },
    ];
    expect(parseRerankResponse(body, 3)).toEqual([1.25, -3, 9.5]);
  });

  it('refuses a short, long, repeated or out-of-range answer', () => {
    expect(() => parseRerankResponse([{ index: 0, score: 1 }], 2)).toThrow(/1 passages of 2/);
    expect(() =>
      parseRerankResponse(
        [
          { index: 0, score: 1 },
          { index: 0, score: 2 },
        ],
        2,
      ),
    ).toThrow(/twice/);
    expect(() =>
      parseRerankResponse(
        [
          { index: 0, score: 1 },
          { index: 5, score: 2 },
        ],
        2,
      ),
    ).toThrow(/outside 0\.\.1/);
    expect(() =>
      parseRerankResponse(
        [
          { index: 0, score: 1 },
          { index: 1, score: 'x' },
        ],
        2,
      ),
    ).toThrow(/non-numeric/);
    expect(() => parseRerankResponse({ error: 'no' }, 1)).toThrow(/list/);
  });
});

describe('percentile', () => {
  it('is nearest-rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
    expect(() => percentile([], 0.95)).toThrow(/empty/);
  });
});

/** A TEI-shaped server in a function: scores a passage by its length, answers sorted by score as TEI does. */
function stubServer(calls: { texts: string[]; query: string }[] = []): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/info')) return Response.json({ model_id: 'BAAI/bge-reranker-v2-m3' });
    expect(url.endsWith('/rerank')).toBe(true);
    const body = JSON.parse(String(init?.body)) as { query: string; texts: string[]; raw_scores: boolean; truncate: boolean };
    expect(body.raw_scores).toBe(true);
    calls.push({ texts: body.texts, query: body.query });
    const scored = body.texts.map((text, index) => ({ index, score: text.length }));
    return Response.json(scored.sort((a, b) => b.score - a.score));
  }) as typeof fetch;
}

describe('RemoteReranker', () => {
  it('scores in the order the passages were given, and splits a large pool into batches', async () => {
    const calls: { texts: string[]; query: string }[] = [];
    const reranker = createRemoteReranker({ url: 'http://tei.test', batchSize: 2, fetchImpl: stubServer(calls) });
    const scores = await reranker.score('q', ['aaaa', 'a', 'aaa', 'aa', 'aaaaa']);
    expect(scores).toEqual([4, 1, 3, 2, 5]);
    expect(calls.map((c) => c.texts.length)).toEqual([2, 2, 1]);
    expect(await reranker.score('q', [])).toEqual([]);
  });

  it('names the model the server reported after warm-up, and keeps warm-up out of the latency figures', async () => {
    const reranker = createRemoteReranker({ url: 'http://tei.test', fetchImpl: stubServer() });
    expect(reranker.id).toBe('remote-rerank:tei.test');
    await reranker.warmup();
    expect(reranker.id).toBe('remote-rerank:bge-reranker-v2-m3');
    expect(reranker.latencySummary()).toBeNull();
    await reranker.score('q', ['a', 'bb']);
    await reranker.score('q', ['a', 'bb']);
    expect(reranker.latencySummary()?.searches).toBe(2);
    expect(reranker.describe()).toMatch(/^remote-rerank:bge-reranker-v2-m3 at http:\/\/tei\.test, batch=32, 2 searches p50 \d+ ms p95 \d+ ms$/);
  });

  it('fails loudly on an error status instead of falling back to the unreranked order', async () => {
    const down = (async () => new Response('overloaded', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch;
    const reranker = createRemoteReranker({ url: 'http://tei.test', fetchImpl: down });
    await expect(reranker.score('q', ['a'])).rejects.toThrow(/503 Service Unavailable: overloaded/);
  });

  it('refuses a batch size that is not a positive integer', () => {
    expect(() => createRemoteReranker({ url: 'http://tei.test', batchSize: 0 })).toThrow(/positive integer/);
  });
});

let nextId = 0;
function result(tags: string[], rank: number | null): RowResult {
  const id = `q-${String(nextId++).padStart(3, '0')}`;
  return {
    row: { id, lang: 'en', query: id, expectFile: 'a.md', tags },
    belowFloor: false,
    rank,
    headingRank: null,
    score: null,
    hits: [],
  } as RowResult;
}

const context = (rerank: string) => ({ rerank, documents: 26, chunks: 577 }) as Report['context'];

/** `xl` cross-lingual questions of which `xlOff` / `xlOn` are in the top five, likewise `others`. */
function arms(xl: [number, number], others: [number, number], total: [number, number] = [30, 54]) {
  const offRows: RowResult[] = [];
  const onRows: RowResult[] = [];
  const add = (tags: string[], count: number, off: number, on: number) => {
    for (let i = 0; i < count; i++) {
      const a = result(tags, i < off ? 0 : null);
      offRows.push(a);
      onRows.push({ ...a, rank: i < on ? 0 : null });
    }
  };
  add(['cross-lingual'], total[0], xl[0], xl[1]);
  add(['install'], total[1], others[0], others[1]);
  return { off: { context: context('off'), results: offRows }, on: { context: context('remote-rerank:x'), results: onRows } };
}

describe('judgeRerankGate', () => {
  it('passes at 13 of 30 with no loss over the other 54', () => {
    const { off, on } = arms([4, 13], [54, 54]);
    const gate = judgeRerankGate(off, on);
    expect(gate.passed).toBe(true);
    expect(gate.crossLingual).toMatchObject({ questions: 30, offHits: 4, onHits: 13 });
    expect(gate.others).toMatchObject({ questions: 54, offHits: 54, onHits: 54 });
  });

  it('is "more than 40.0 %", so exactly 12 of 30 fails', () => {
    const { off, on } = arms([4, 12], [54, 54]);
    const gate = judgeRerankGate(off, on);
    expect(gate.crossLingualPassed).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it('fails on a single question lost from the top five of the other 54, however good the cross-lingual slice is', () => {
    const { off, on } = arms([4, 20], [54, 53]);
    const gate = judgeRerankGate(off, on);
    expect(gate.crossLingualPassed).toBe(true);
    expect(gate.othersLost).toBe(1);
    expect(gate.passed).toBe(false);
    expect(gate.others.lost).toHaveLength(1);
  });

  it('reads the loss gross: one question lost and one gained among the other 54 is a trade, and a trade fails', () => {
    const { off, on } = arms([4, 20], [53, 53]);
    // Make the swap explicit: the first "other" question the rerank answered before is lost, the one it missed is gained.
    const others = (report: typeof off) => report.results.filter((r) => !r.row.tags.includes('cross-lingual'));
    const lostId = others(off).find((r) => r.rank === 0)?.row.id;
    const gainedId = others(off).find((r) => r.rank === null)?.row.id;
    const swapped = on.results.map((r) => (r.row.id === lostId ? { ...r, rank: null } : r.row.id === gainedId ? { ...r, rank: 0 } : r));
    const gate = judgeRerankGate(off, { ...on, results: swapped });
    expect(gate.others.offHits).toBe(gate.others.onHits);
    expect(gate.others.lost).toEqual([lostId]);
    expect(gate.others.gained).toEqual([gainedId]);
    expect(gate.othersLost).toBe(1);
    expect(gate.crossLingualPassed).toBe(true);
    expect(gate.passed).toBe(false);
  });

  it('counts hits past the relevance floor beside the gate without letting them decide it', () => {
    const { off, on } = arms([4, 15], [54, 54]);
    // Five of the cross-lingual answers the rerank found would be refused at the floor.
    let refused = 0;
    const gated = on.results.map((r) => (r.row.tags.includes('cross-lingual') && r.rank !== null && refused++ < 5 ? { ...r, belowFloor: true } : r));
    const gate = judgeRerankGate(off, { ...on, results: gated });
    expect(gate.crossLingual.onHits).toBe(15);
    expect(gate.crossLingual.onHitsPastFloor).toBe(10);
    expect(gate.crossLingual.offHitsPastFloor).toBe(4);
    expect(gate.passed).toBe(true);
    expect(formatGate(gate, null)).toContain('cross-lingual on 10/30 (33.3 %), off 4/30');
  });

  it('refuses to compare an "off" that is not off, an "on" that is not remote, or two different indexes', () => {
    const { off, on } = arms([4, 13], [54, 54]);
    expect(() => judgeRerankGate({ ...off, context: context('remote-rerank:x') }, on)).toThrow(/not run with the rerank off/);
    expect(() => judgeRerankGate(off, { ...on, context: context('off') })).toThrow(/--rerank-url/);
    expect(() => judgeRerankGate(off, { ...on, context: { ...on.context, chunks: 1 } })).toThrow(/different indexes/);
    expect(() => judgeRerankGate(off, { ...on, results: on.results.slice(1) })).toThrow(/different question sets/);
  });

  it('prints the verdict first, then both slices and the latency as information', () => {
    const { off, on } = arms([4, 13], [54, 54]);
    const text = formatGate(judgeRerankGate(off, on), { searches: 108, meanMs: 900, p50Ms: 850, p95Ms: 1400, maxMs: 1600 });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^GATE: PASSED {2}cross-lingual recall@5 43\.3 %/);
    expect(text).toContain('the other 54 recall@5: off 100.0 % (54) -> on 100.0 % (54)');
    expect(text).toContain('p95 1400 ms');
  });
});
