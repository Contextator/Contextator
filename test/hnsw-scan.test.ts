import { describe, expect, it } from 'vitest';

import { DENSE_CANDIDATES, EnvSchema } from '../src/config.js';
import { DEFAULT_HNSW_SCAN, scanFrom } from '../src/services/vector-store.js';

/**
 * The half of [ADR-0040](../.ssot/ADR.md#adr-0040) that can be asserted without a database: what the
 * three variables parse to, what the schema refuses, and that the two places a default is written down
 * say the same number. The half that needs a real index — that the GUCs take effect, and that iterative
 * scan is what finds a small project — is `test/integration/hnsw-scan.itest.ts`.
 */

const ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ALLOWED_DOC_ROOTS: '/docs',
};

const parse = (overrides: Record<string, string> = {}) => EnvSchema.safeParse({ ...ENV, ...overrides });

const issuesFor = (result: ReturnType<typeof parse>, field: string): string[] =>
  result.success ? [] : result.error.issues.filter((i) => i.path[0] === field).map((i) => i.message);

describe('the scan settings an unconfigured installation runs at', () => {
  it("raises ef_search above pgvector's own 40 and turns iterative scan on", () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    // 40 is pgvector's default and the number the product shipped with by omission. The defect is
    // that 40 candidates are drawn from *every* project's chunks before the project predicate sees
    // one of them.
    expect(result.data.HNSW_EF_SEARCH).toBe(100);
    expect(result.data.HNSW_ITERATIVE_SCAN).toBe('relaxed_order');
    expect(result.data.HNSW_MAX_SCAN_TUPLES).toBe(20_000);
  });

  it('gives `searchChunks` the same defaults when nobody hands it a configuration', () => {
    // Two files write these numbers down — `config.ts`, which describes an environment, and
    // `vector-store.ts`, which must work without one. This is the assertion that keeps them equal.
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(scanFrom(result.data)).toEqual(DEFAULT_HNSW_SCAN);
  });

  it("carries an operator's settings through to the structure the query runs under", () => {
    const result = parse({ HNSW_EF_SEARCH: '400', HNSW_ITERATIVE_SCAN: 'strict_order', HNSW_MAX_SCAN_TUPLES: '250000' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(scanFrom(result.data)).toEqual({ efSearch: 400, iterativeScan: 'strict_order', maxScanTuples: 250_000 });
  });
});

describe('what the schema refuses', () => {
  it('refuses an ef_search below the dense candidates one search asks for', () => {
    // Below this the scan is short before a single row has been filtered: an HNSW scan cannot return
    // more rows than the candidates it collected. ADR-0041 moved this number from 20 to 50, which is
    // what the rule being written against the constant rather than against a literal was for.
    const result = parse({ HNSW_EF_SEARCH: String(DENSE_CANDIDATES - 1) });
    expect(result.success).toBe(false);
    expect(issuesFor(result, 'HNSW_EF_SEARCH')).toEqual([expect.stringContaining(`at least ${DENSE_CANDIDATES}`)]);
  });

  it('accepts exactly the candidate count, which is the floor and not the recommendation', () => {
    expect(parse({ HNSW_EF_SEARCH: String(DENSE_CANDIDATES) }).success).toBe(true);
  });

  it('refuses the ef_search that was legal before the lexical half doubled the candidate pool', () => {
    // 20 passed until ADR-0041 and does not now. Written down because an operator who pinned
    // `HNSW_EF_SEARCH=20` is an operator whose server stops starting, and a refusal at startup with a
    // number in it is the only place that is cheap to discover.
    expect(parse({ HNSW_EF_SEARCH: '20' }).success).toBe(false);
  });

  it('refuses a scan mode pgvector does not have, rather than passing the string through to it', () => {
    // `set_config` would accept the string and the query would fail at run time, inside a search, on
    // an installation that started cleanly. This is the one chance to say it at startup.
    const result = parse({ HNSW_ITERATIVE_SCAN: 'relaxed' });
    expect(result.success).toBe(false);
    expect(issuesFor(result, 'HNSW_ITERATIVE_SCAN')).toHaveLength(1);
  });

  it("keeps ef_search inside pgvector's own 1000 ceiling and max_scan_tuples positive", () => {
    expect(parse({ HNSW_EF_SEARCH: '1001' }).success).toBe(false);
    expect(parse({ HNSW_EF_SEARCH: '1000' }).success).toBe(true);
    expect(parse({ HNSW_MAX_SCAN_TUPLES: '0' }).success).toBe(false);
  });
});
