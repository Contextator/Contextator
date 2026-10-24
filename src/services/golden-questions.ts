import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { documents, type GoldenQuestionRow, goldenQuestions, projects } from '../db/schema.js';
import { GOLDEN_ID_MESSAGE, GOLDEN_ID_RE, type GoldenRow } from './golden-row.js';
import { ConflictError, NotFoundError, ValidationError } from './projects.js';

export { type GoldenRow, GoldenRowSchema } from './golden-row.js';

/**
 * A project's own golden questions (Faz 09 of 0.4.0, FR-347): the questions an operator expects the
 * documentation to answer, kept in the database so the eval can be run against the corpus the project
 * really has instead of the repository's `eval/corpus/`.
 *
 * **This module stores and serves questions; it never scores them.** The arithmetic is
 * `scripts/eval-scoring.ts`, unchanged, and `npm run eval -- --project <name>` is the path that asks
 * these rows through `searchProject` and hands the answers to it. `src/` cannot import `scripts/`, so
 * the server has no route that runs an eval — it would need a second copy of the scoring, and a second
 * copy of a measurement is how two numbers for one thing come to exist.
 *
 * **Golden questions only.** A question whose right answer is nothing is a different row with a
 * different parser and never joins a golden denominator ([ADR-0045](../../.ssot/ADR.md#adr-0045)); the
 * table has no `kind` column to blur that with, and nothing here stores one.
 */

/**
 * Questions one project may hold. A set is a hand-written instrument — the repository's own is eighty-four
 * rows — so a thousand is far past any real one, and the cap exists so that a loop in a script cannot
 * turn this into a bulk store. A constant rather than an environment variable: nothing about it is an
 * operator's decision.
 */
export const MAX_GOLDEN_QUESTIONS = 1000;

const MAX_KEY = 100;
const MAX_TEXT = 4000;
const MAX_PATH = 1024;
const MAX_TAGS = 32;
const MAX_TAG = 64;

const keySchema = z.string().max(MAX_KEY).regex(GOLDEN_ID_RE, GOLDEN_ID_MESSAGE);

/**
 * What a client writes: `golden.jsonl`'s row with the same fields and the same rules, plus the length
 * limits a file read from disk does not need. `key` is the row's `id` — named so here because `id` is
 * the row's uuid in every other response of this API.
 */
const questionFields = {
  lang: z.enum(['en', 'tr']),
  query: z.string().trim().min(1).max(MAX_TEXT),
  expectFile: z.string().min(1).max(MAX_PATH),
  expectHeading: z.string().min(1).max(MAX_PATH).nullish(),
  tags: z.array(z.string().min(1).max(MAX_TAG)).max(MAX_TAGS).default([]),
  note: z.string().max(MAX_TEXT).nullish(),
};

export const GoldenQuestionInputSchema = z.strictObject({ key: keySchema, ...questionFields });
export type GoldenQuestionInput = z.infer<typeof GoldenQuestionInputSchema>;

/** A change to one question. `key` is not here: it is the name a miss list and a diff cite, so it is never renumbered. */
export const GoldenQuestionPatchSchema = z
  .strictObject({
    lang: questionFields.lang,
    query: questionFields.query,
    expectFile: questionFields.expectFile,
    expectHeading: questionFields.expectHeading,
    tags: z.array(z.string().min(1).max(MAX_TAG)).max(MAX_TAGS),
    note: questionFields.note,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Send at least one field to change');
export type GoldenQuestionPatch = z.infer<typeof GoldenQuestionPatchSchema>;

/** The whole set in one body, for a replace. */
export const GoldenQuestionSetSchema = z.strictObject({ questions: z.array(GoldenQuestionInputSchema).max(MAX_GOLDEN_QUESTIONS) });

export interface GoldenQuestionView {
  id: string;
  key: string;
  lang: 'en' | 'tr';
  query: string;
  expectFile: string;
  expectHeading: string | null;
  tags: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toGoldenQuestionView(row: GoldenQuestionRow): GoldenQuestionView {
  return {
    id: row.id,
    key: row.key,
    lang: row.lang as 'en' | 'tr',
    query: row.query,
    expectFile: row.expectFile,
    expectHeading: row.expectHeading,
    tags: row.tags,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A stored question as the scorer's row. `expectHeading` and `note` that are NULL become absent, which is
 * how `GoldenRowSchema` spells "not given" — `exactOptionalPropertyTypes` would refuse a `null` there, and
 * `scoreRow` reads `expectHeading === undefined`, so the difference is behaviour and not style.
 */
export function toGoldenRow(row: Pick<GoldenQuestionRow, 'key' | 'lang' | 'query' | 'expectFile' | 'expectHeading' | 'tags' | 'note'>): GoldenRow {
  return {
    id: row.key,
    lang: row.lang as 'en' | 'tr',
    query: row.query,
    expectFile: row.expectFile,
    ...(row.expectHeading === null ? {} : { expectHeading: row.expectHeading }),
    tags: row.tags,
    ...(row.note === null ? {} : { note: row.note }),
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

function insertValues(projectId: string, input: GoldenQuestionInput): typeof goldenQuestions.$inferInsert {
  return {
    projectId,
    key: input.key,
    lang: input.lang,
    query: input.query,
    expectFile: input.expectFile,
    expectHeading: input.expectHeading ?? null,
    tags: input.tags,
    note: input.note ?? null,
  };
}

/** A project's questions, ordered by `key` so two reads of one set are the same list. */
export async function listGoldenQuestions(db: Db, projectId: string): Promise<GoldenQuestionRow[]> {
  return db.select().from(goldenQuestions).where(eq(goldenQuestions.projectId, projectId)).orderBy(asc(goldenQuestions.key));
}

export async function getGoldenQuestion(db: Db, projectId: string, questionId: string): Promise<GoldenQuestionRow> {
  const [row] = await db
    .select()
    .from(goldenQuestions)
    .where(and(eq(goldenQuestions.projectId, projectId), eq(goldenQuestions.id, questionId)))
    .limit(1);
  if (!row) throw new NotFoundError('No such golden question');
  return row;
}

/**
 * Adds one question. The cap and the key's uniqueness are both checked inside one transaction that takes
 * the project row's lock, so two concurrent creates cannot both squeeze under a cap of one.
 */
export async function createGoldenQuestion(db: Db, projectId: string, input: GoldenQuestionInput): Promise<GoldenQuestionRow> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(goldenQuestions).where(eq(goldenQuestions.projectId, projectId));
    if (total >= MAX_GOLDEN_QUESTIONS) throw new ValidationError(`A project holds at most ${MAX_GOLDEN_QUESTIONS} golden questions`);
    try {
      const [row] = await tx.insert(goldenQuestions).values(insertValues(projectId, input)).returning();
      if (!row) throw new Error('golden question insert returned no row');
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`A golden question with key "${input.key}" already exists in this project`);
      throw err;
    }
  });
}

export async function updateGoldenQuestion(db: Db, projectId: string, questionId: string, patch: GoldenQuestionPatch): Promise<GoldenQuestionRow> {
  const set: Partial<typeof goldenQuestions.$inferInsert> = { updatedAt: new Date() };
  if (patch.lang !== undefined) set.lang = patch.lang;
  if (patch.query !== undefined) set.query = patch.query;
  if (patch.expectFile !== undefined) set.expectFile = patch.expectFile;
  if (patch.expectHeading !== undefined) set.expectHeading = patch.expectHeading;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.note !== undefined) set.note = patch.note;
  const [row] = await db
    .update(goldenQuestions)
    .set(set)
    .where(and(eq(goldenQuestions.projectId, projectId), eq(goldenQuestions.id, questionId)))
    .returning();
  if (!row) throw new NotFoundError('No such golden question');
  return row;
}

export async function deleteGoldenQuestion(db: Db, projectId: string, questionId: string): Promise<void> {
  const removed = await db
    .delete(goldenQuestions)
    .where(and(eq(goldenQuestions.projectId, projectId), eq(goldenQuestions.id, questionId)))
    .returning({ id: goldenQuestions.id });
  if (removed.length === 0) throw new NotFoundError('No such golden question');
}

/**
 * Replaces the project's whole set with `questions`, atomically: a file of questions is loaded as one
 * unit, and a load that fails half way must not leave half a set, because a question set that silently
 * shrinks is a recall that silently improves. Duplicate keys in the body are refused by name.
 */
export async function replaceGoldenQuestions(db: Db, projectId: string, questions: readonly GoldenQuestionInput[]): Promise<GoldenQuestionRow[]> {
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.key)) throw new ValidationError(`Duplicate key "${q.key}" in the question set`);
    seen.add(q.key);
  }
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    await tx.delete(goldenQuestions).where(eq(goldenQuestions.projectId, projectId));
    if (questions.length === 0) return [];
    return tx
      .insert(goldenQuestions)
      .values(questions.map((q) => insertValues(projectId, q)))
      .returning();
  });
}

/** Takes the project row's lock for the transaction, and says so when there is no such project. */
async function lockProject(tx: Pick<Db, 'select'>, projectId: string): Promise<void> {
  const [row] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update').limit(1);
  if (!row) throw new NotFoundError('Project not found');
}

/** The set as `golden.jsonl`: one JSON object per line, `id` being the question's `key`. */
export function formatGoldenJsonl(rows: readonly GoldenQuestionRow[]): string {
  return rows.map((row) => JSON.stringify(toGoldenRow(row))).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * The questions whose `expectFile` is not a document of the project's live generation — the check
 * `parseGoldenSet` makes against the corpus directory, made against the index the question will be asked of.
 * A question pointing at a page nobody indexed would score zero for ever; the run refuses instead.
 */
export async function findUnknownExpectFiles(db: Db, projectId: string, liveGeneration: number, rows: readonly GoldenRow[]): Promise<GoldenRow[]> {
  const wanted = [...new Set(rows.map((r) => r.expectFile))];
  if (wanted.length === 0) return [];
  const known = new Set<string>();
  // In batches: a thousand distinct paths in one `IN` list is legal and pointless.
  for (let i = 0; i < wanted.length; i += 200) {
    const found = await db
      .select({ path: documents.relativePath })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.indexGeneration, liveGeneration),
          inArray(documents.relativePath, wanted.slice(i, i + 200)),
        ),
      );
    for (const f of found) known.add(f.path);
  }
  return rows.filter((r) => !known.has(r.expectFile));
}

/** How many questions a project holds. */
export async function countGoldenQuestions(db: Db, projectId: string): Promise<number> {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(goldenQuestions).where(eq(goldenQuestions.projectId, projectId));
  return row?.total ?? 0;
}
