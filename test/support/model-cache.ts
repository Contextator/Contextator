import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The two tests that need a real model — the tokenizer on Turkish in `chunker.test.ts`, and the two
 * sides of one sentence in `embedding-prefixes.test.ts` — are gated on the model cache, because
 * downloading 448 MB into `npm test` is not something a contributor should discover by running it.
 *
 * The gate used to be a bare `describe.skipIf(!existsSync(...))`, and that is the defect this file
 * exists to close. CI's `check` job had no `.cache/models` step, so the directory was empty on every
 * run, all three tests skipped, and the suite reported green — for months. "The cache was not there"
 * and "the assertions passed" were the same colour, which makes a test that cannot fail, which is
 * not a test.
 *
 * So the skip is now a developer convenience and nothing more: under `CI` it does not apply. An
 * absent cache there means the block runs and `assertPresent` fails it, naming the file and the step
 * that produces it. The workflow populates the cache before `npm test`; if somebody deletes that
 * step, this is what turns the run red instead of quietly green.
 */

/** Exactly what `MODEL_CACHE_DIR` defaults to, resolved the way `createEmbeddingProvider` resolves it. */
export const MODEL_CACHE_DIR = path.resolve('.cache/models');

/** `npm run warm-model` writes these, and asserts them before it exits 0. */
export const CACHE_POPULATED_BY = 'npm run warm-model';

export interface ModelCacheGate {
  /** The file `npm run warm-model` has to have produced. */
  readonly file: string;
  /** Whether it is on disk right now. */
  readonly present: boolean;
  /**
   * The `describe.skipIf` argument. True only for a developer who has never warmed the cache;
   * never true under `CI`, where an absent cache has to be a failure rather than a silence.
   */
  readonly skip: boolean;
  /** Throws with the file and the remedy. Call it from `beforeAll`, so every test in the block says why. */
  assertPresent(): void;
}

/** `relative` is spelled from inside `.cache/models`, e.g. `('Xenova/multilingual-e5-small', 'tokenizer.json')`. */
export function modelCacheGate(...relative: string[]): ModelCacheGate {
  const file = path.join(MODEL_CACHE_DIR, ...relative);
  const present = existsSync(file);
  // Set by GitHub Actions, by vitest itself, and by every other runner worth naming. A developer who
  // exports it has asked for CI's behaviour and gets it.
  const underCI = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';
  return {
    file,
    present,
    skip: !present && !underCI,
    assertPresent(): void {
      if (present) return;
      throw new Error(
        `${file} is missing, so this block cannot run.\n` +
          `Locally: run \`${CACHE_POPULATED_BY}\` once (a few hundred megabytes, then never again).\n` +
          'In CI: the `check` job caches `.cache/models` and populates it on a miss. This test is not ' +
          'allowed to skip here — a skipped model test is indistinguishable from a passing one, which ' +
          'is how these went unrun for months. Fix the cache step rather than this assertion.',
      );
    },
  };
}
