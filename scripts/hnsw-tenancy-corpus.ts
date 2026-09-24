import { TEST_EMBEDDING_DIMENSIONS } from '../test/integration/support/postgres.js';

/**
 * The multi-tenant corpus `scripts/hnsw-tenancy.ts` measures, as a description rather than a sample.
 *
 * It is ADR-0040's scale-test corpus (`test/integration/hnsw-scan.itest.ts`) with one extra knob: a
 * **scale**. At `1` it is that file's six projects and 21 050 chunks, vector for vector; at `10` it is
 * the "ten times the corpus" ADR-0040 named as the first trigger for its fallback — the same six
 * projects at 210 500 chunks. The generator is the same one, restated here rather than imported,
 * because importing a `*.itest.ts` would run its suite.
 *
 * **Adversarial by construction, and that is stated, not hidden.** A chunk is `s·q + √(1−s²)·u` with
 * `u ⟂ q`, so its cosine similarity to the query direction `q` is exactly `s`. The large projects
 * spread over `[0.30, 0.99]` and the small ones sit in `[0.85, 0.90]`: every question aimed along `q`
 * is one the large projects have many better answers to than the small project's best. That is the
 * shape of the defect — a generic question on an instance whose other tenants write about the same
 * subject — and the number that decides it is printed alongside every result as `rows ahead`: how many
 * of the *instance's* chunks are nearer the question than the project's own best row.
 */

export const DIMS = TEST_EMBEDDING_DIMENSIONS;

/** Deterministic PRNG (mulberry32). Every vector here comes from it, so a run is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, so the random directions are isotropic rather than cube-shaped. */
export function gaussianVector(next: () => number): number[] {
  const v = new Array<number>(DIMS);
  for (let i = 0; i < DIMS; i += 2) {
    const u1 = Math.max(next(), Number.EPSILON);
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    v[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < DIMS) v[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return v;
}

export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return v.map((x) => x / norm);
}

export function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** The component of `v` orthogonal to the unit vector `axis`, normalised. */
export function orthogonalTo(axis: number[], v: number[]): number[] {
  const along = dot(axis, v);
  return normalize(v.map((x, i) => x - along * axis[i]));
}

/** The query direction every similarity band is measured against — the scale test's own, seed 1. */
export const QUERY = normalize(gaussianVector(rng(1)));

/** How far a project's chunks sit from its own centroid; the scale test's value. */
export const CLUSTER_JITTER = 0.2;

export interface TenantSpec {
  name: string;
  chunks: number;
  band: [number, number];
}

/** ADR-0040's six projects, each multiplied by `scale`. */
export function tenancyCorpus(scale: number): TenantSpec[] {
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`scale must be a positive integer, got ${scale}`);
  return [
    { name: 'tiny', chunks: 50 * scale, band: [0.85, 0.9] },
    { name: 'small', chunks: 1_000 * scale, band: [0.85, 0.9] },
    { name: 'beta', chunks: 5_000 * scale, band: [0.3, 0.99] },
    { name: 'gamma', chunks: 5_000 * scale, band: [0.3, 0.99] },
    { name: 'delta', chunks: 5_000 * scale, band: [0.3, 0.99] },
    { name: 'epsilon', chunks: 5_000 * scale, band: [0.3, 0.99] },
  ];
}

/** The project every measurement is about: large enough to be reached through the vector index, crowded out of it. */
export const TARGET = 'small';

/**
 * The questions: `QUERY` itself and `count − 1` directions tilted towards it (cosine 0.9), which is the
 * scale test's `CROWDED_PROBES` construction extended past five. Each is a different walk through the
 * graph; every one of them still sees the corpus as it was built.
 */
export function crowdedProbes(count: number): number[][] {
  const tilt = 0.9;
  return [
    QUERY,
    ...Array.from({ length: count - 1 }, (_, i) => {
      const across = orthogonalTo(QUERY, gaussianVector(rng(900 + i)));
      return normalize(QUERY.map((q, j) => tilt * q + Math.sqrt(1 - tilt ** 2) * across[j]));
    }),
  ];
}

/**
 * The vectors of the `index`-th project of the corpus, in chunk order, `batch` at a time. The seeds are
 * the scale test's (`100 + index` for the chunks, `200 + index` for the centroid), so at scale 1 these
 * are that file's vectors and at scale 10 the first tenth of every project still is.
 */
export function* chunkVectors(spec: TenantSpec, index: number, batch: number): Generator<number[][]> {
  const next = rng(100 + index);
  const centroid = orthogonalTo(QUERY, gaussianVector(rng(200 + index)));
  const [low, high] = spec.band;
  for (let start = 0; start < spec.chunks; start += batch) {
    const out: number[][] = [];
    for (let i = start; i < Math.min(start + batch, spec.chunks); i++) {
      const similarity = low + (high - low) * next();
      const noise = gaussianVector(next);
      const direction = orthogonalTo(
        QUERY,
        centroid.map((x, j) => x + CLUSTER_JITTER * noise[j]),
      );
      const across = Math.sqrt(1 - similarity * similarity);
      out.push(QUERY.map((q, j) => similarity * q + across * direction[j]));
    }
    yield out;
  }
}

/** pgvector's text input format, at six decimals. */
export function vectorLiteral(values: number[]): string {
  return `[${values.map((x) => x.toFixed(6)).join(',')}]`;
}
