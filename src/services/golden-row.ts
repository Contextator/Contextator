import { z } from 'zod';

/**
 * The shape of one golden question, in the one place both halves of the eval can import it from
 * (Faz 09 of 0.4.0, FR-347).
 *
 * `scripts/eval-scoring.ts` reads `golden.jsonl` with it and `services/golden-questions.ts` stores and
 * serves the same rows, so a question set exported from a project is a file `npm run eval -- --golden`
 * reads and the other way round. It lives in a module of its own, with zod as its only import, because
 * `eval-scoring.ts` is deliberately a module nothing database-shaped can reach: a scoring bug has to
 * stay testable without a container ([ADR-0034](../../.ssot/ADR.md#adr-0034)). `src/` cannot import from
 * `scripts/` (`rootDir` is `src`), so the schema sits here and the scripts import it.
 */

/** A golden row's `id`, and a negative row's: lowercase letters, digits and hyphens, starting with a letter or digit. */
export const GOLDEN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const GOLDEN_ID_MESSAGE = 'must be lowercase letters, digits and hyphens';

export const GoldenRowSchema = z.strictObject({
  /** Stable and unique; it appears in the miss list and in diffs, so it is never renumbered. */
  id: z.string().regex(GOLDEN_ID_RE, GOLDEN_ID_MESSAGE),
  /** The language of the *question*. A Turkish question about an English page is `tr`. */
  lang: z.enum(['en', 'tr']),
  query: z.string().min(1),
  /** Relative to `eval/corpus/`, exactly as the file is spelled on disk. */
  expectFile: z.string().min(1),
  /**
   * Matched as a breadcrumb suffix and scored apart from the file-level metrics — never folded into
   * them. ADR-0034 said it gates nothing; since [ADR-0044](../../.ssot/ADR.md#adr-0044) it has a floor
   * of its own, which is still not the same thing as being folded in.
   */
  expectHeading: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  /** Why this question is here, when that is not obvious. Ignored by the scorer. */
  note: z.string().optional(),
});

export type GoldenRow = z.infer<typeof GoldenRowSchema>;
